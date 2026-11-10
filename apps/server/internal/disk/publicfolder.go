package disk

import (
	"archive/zip"
	"bytes"
	"cmp"
	"context"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Public folder links (ADR-0165): an anonymous visitor reads the linked folder's subtree, never
// above it. An item is part of the link only when every item on the way from the linked folder
// down to it (the linked folder excluded, the item included) is live (not in the trash), not
// «Только выбранные» (restricted) and carries no override that denies DISK_VIEW: the link never
// shows what the folder's own members are kept from. Everything else answers 404.

const (
	// ArchiveMaxBytes bounds «Скачать всё» of a folder link (the files' total size).
	ArchiveMaxBytes int64 = 2 << 30
	// ArchiveMaxItems bounds the items of the subtree an archive walks.
	ArchiveMaxItems = 5000
)

// linkedFolder is linked for the routes of a folder link (404 for a file link).
func (s *Service) linkedFolder(w http.ResponseWriter, r *http.Request, limit Limiter) (linkRow, error) {
	row, err := s.linked(w, r, limit)
	if err == nil && row.item.Kind != "folder" {
		err = errNoLink
	}
	return row, err
}

// hiddenBelow reports which of items are left out of a link with their subtrees: in the trash,
// restricted, or denied DISK_VIEW by an override.
func hiddenBelow(ctx context.Context, q *sqlc.Queries, items []sqlc.DiskItem) (map[uuid.UUID]bool, error) {
	out := map[uuid.UUID]bool{}
	ids := make([]uuid.UUID, 0, len(items))
	for _, it := range items {
		if it.TrashedAt != nil || it.Restricted {
			out[it.ID] = true
		}
		ids = append(ids, it.ID)
	}
	if len(ids) == 0 {
		return out, nil
	}
	denied, err := q.ListDiskDenyViewItems(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, id := range denied {
		out[id] = true
	}
	return out, nil
}

// under resolves item id inside the linked folder root: the chain from root (first) down to the
// item (last). 404 when id is not root or below it, or the way down is hidden (hiddenBelow).
func (s *Service) under(ctx context.Context, root sqlc.DiskItem, id uuid.UUID) ([]sqlc.DiskItem, error) {
	if id == root.ID {
		return []sqlc.DiskItem{root}, nil
	}
	rows, err := s.db.Q.DiskItemPath(ctx, id)
	if err != nil {
		return nil, err
	}
	at := -1
	for i, row := range rows {
		if row.DiskItem.ID == root.ID {
			at = i
			break
		}
	}
	if at < 0 || rows[len(rows)-1].DiskItem.ID != id {
		return nil, errNoItem
	}
	chain := []sqlc.DiskItem{root}
	for _, row := range rows[at+1:] {
		chain = append(chain, row.DiskItem)
	}
	hidden, err := hiddenBelow(ctx, s.db.Q, chain[1:])
	if err != nil {
		return nil, err
	}
	if len(hidden) > 0 {
		return nil, errNoItem
	}
	return chain, nil
}

// folderParam resolves ?parent= of a folder link (unset = the linked folder) to a folder chain.
func (s *Service) folderParam(r *http.Request, root sqlc.DiskItem) ([]sqlc.DiskItem, error) {
	id := root.ID
	if raw := r.URL.Query().Get("parent"); raw != "" {
		var err error
		if id, err = uuid.Parse(raw); err != nil {
			return nil, httpx.NotFound("folder")
		}
	}
	chain, err := s.under(r.Context(), root, id)
	if err != nil {
		return nil, httpx.NotFound("folder")
	}
	if chain[len(chain)-1].Kind != "folder" {
		return nil, httpx.NotFound("folder")
	}
	return chain, nil
}

// publicItems: GET /api/public/disk/{code}/items?parent=&cursor= — PublicDiskFolder, anonymous.
// A page may hold fewer items than PageMax (hidden ones are left out); next_cursor is set while
// the folder has more rows.
func (s *Service) publicItems(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linkedFolder(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	chain, err := s.folderParam(r, row.item)
	if err != nil {
		return err
	}
	cur, err := decodeCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		return err
	}
	ctx, q := r.Context(), s.db.Q
	folder := chain[len(chain)-1]
	p := sqlc.ListDiskFolderByNameParams{WorkspaceID: folder.WorkspaceID, ParentID: &folder.ID, Lim: PageMax}
	if cur != nil {
		p.CursorID, p.CursorRank, p.CursorName = &cur.ID, cur.Rank, cur.Name
	}
	rows, err := q.ListDiskFolderByName(ctx, p)
	if err != nil {
		return err
	}
	items := make([]sqlc.DiskItem, len(rows))
	var fileIDs []uuid.UUID
	for i, x := range rows {
		items[i] = x.DiskItem
		if x.DiskItem.FileID != nil {
			fileIDs = append(fileIDs, *x.DiskItem.FileID)
		}
	}
	hidden, err := hiddenBelow(ctx, q, items)
	if err != nil {
		return err
	}
	files := map[uuid.UUID]sqlc.File{}
	if len(fileIDs) > 0 {
		fs, err := q.ListDiskFiles(ctx, fileIDs)
		if err != nil {
			return err
		}
		for _, f := range fs {
			files[f.ID] = f
		}
	}
	out := &v1.PublicDiskFolder{Id: folder.ID.String(), Name: folder.Name, ViewOnly: row.link.ViewOnly}
	if row.link.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*row.link.ExpiresAt)
	}
	for _, it := range chain {
		out.Path = append(out.Path, &v1.PublicDiskCrumb{Id: it.ID.String(), Name: it.Name})
	}
	for _, it := range items {
		if hidden[it.ID] {
			continue
		}
		e := &v1.PublicDiskEntry{Id: it.ID.String(), Name: it.Name, Kind: v1.DiskItemKind_DISK_ITEM_KIND_FOLDER, UpdatedAt: timestamppb.New(it.UpdatedAt)}
		if it.Kind == "file" {
			f, ok := files[derefID(it.FileID)]
			if !ok {
				continue
			}
			e.Kind = v1.DiskItemKind_DISK_ITEM_KIND_FILE
			e.Size, e.Mime, e.HasThumbnail = uint64(max(f.Size, 0)), f.Mime, f.ThumbnailKey != nil
			if f.Width != nil && f.Height != nil && pbconv.IsImage(f.Mime) {
				e.Width, e.Height = uint32(max(*f.Width, 0)), uint32(max(*f.Height, 0))
			}
			e.Office = s.officeOpens(it.Name, f.Size)
		}
		out.Items = append(out.Items, e)
	}
	if len(rows) == PageMax {
		last := rows[len(rows)-1]
		out.NextCursor = cursor{Rank: rankOf(last.DiskItem), Name: last.Lname, ID: last.DiskItem.ID}.encode()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func derefID(id *uuid.UUID) uuid.UUID {
	if id == nil {
		return uuid.Nil
	}
	return *id
}

// linkedItemFile resolves {id} as a file inside the folder link of the request.
func (s *Service) linkedItemFile(w http.ResponseWriter, r *http.Request, limit Limiter) (linkRow, sqlc.DiskItem, sqlc.File, error) {
	row, err := s.linkedFolder(w, r, limit)
	if err != nil {
		return row, sqlc.DiskItem{}, sqlc.File{}, err
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		return row, sqlc.DiskItem{}, sqlc.File{}, errNoItem
	}
	chain, err := s.under(r.Context(), row.item, id)
	if err != nil {
		return row, sqlc.DiskItem{}, sqlc.File{}, err
	}
	it := chain[len(chain)-1]
	f, err := s.fileOf(r.Context(), it)
	if err != nil {
		return row, it, f, errNoItem
	}
	return row, it, f, nil
}

// publicItemContent: GET /api/public/disk/{code}/items/{id}/content — a file of a folder link.
func (s *Service) publicItemContent(w http.ResponseWriter, r *http.Request) error {
	row, it, f, err := s.linkedItemFile(w, r, s.LinkDownloadLimit)
	if err != nil {
		return err
	}
	return s.serveCounted(w, r, row.link, it, f)
}

// publicItemThumbnail: GET /api/public/disk/{code}/items/{id}/thumbnail?w=512|1024.
func (s *Service) publicItemThumbnail(w http.ResponseWriter, r *http.Request) error {
	_, _, f, err := s.linkedItemFile(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	return s.files.ServeLinked(w, r, f, true)
}

// archiveEntry is one item of «Скачать всё»: its path in the archive and, for a file, the row.
type archiveEntry struct {
	path string
	file *sqlc.File
	at   time.Time
}

func (s *Service) archiveMax() (int64, int) {
	b, n := s.ArchiveMaxBytes, s.ArchiveMaxItems
	if b <= 0 {
		b = ArchiveMaxBytes
	}
	if n <= 0 {
		n = ArchiveMaxItems
	}
	return b, n
}

var errArchiveTooLarge = httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE, "the folder is too large to download at once")

// archiveEntries walks the visible subtree of folder (parents before children): folders as
// "path/", files with their rows. 413 above the ceilings.
func (s *Service) archiveEntries(ctx context.Context, folder sqlc.DiskItem) ([]archiveEntry, int64, error) {
	maxBytes, maxItems := s.archiveMax()
	q := s.db.Q
	// One row over the ceiling is enough to refuse; the walk stops there instead of reading a
	// huge subtree whole on every anonymous call.
	lim := int32(min(maxItems, 1<<20)) + 1 //nolint:gosec // bounded by min
	rows, err := q.ListDiskSubtreeCapped(ctx, sqlc.ListDiskSubtreeCappedParams{ID: folder.ID, Lim: lim})
	if err != nil {
		return nil, 0, err
	}
	if len(rows) > maxItems {
		return nil, 0, errArchiveTooLarge
	}
	// Parents before children (the capped query promises no order); then by id, stable names.
	slices.SortFunc(rows, func(a, b sqlc.ListDiskSubtreeCappedRow) int {
		if a.Depth != b.Depth {
			return cmp.Compare(a.Depth, b.Depth)
		}
		return bytes.Compare(a.DiskItem.ID[:], b.DiskItem.ID[:])
	})
	items := make([]sqlc.DiskItem, len(rows))
	for i, x := range rows {
		items[i] = x.DiskItem
	}
	hidden, err := hiddenBelow(ctx, q, items)
	if err != nil {
		return nil, 0, err
	}
	paths := map[uuid.UUID]string{folder.ID: ""}
	var out []archiveEntry
	var fileIDs []uuid.UUID
	for _, it := range items {
		parent, ok := paths[derefID(it.ParentID)]
		if !ok || hidden[it.ID] {
			continue
		}
		p := parent + it.Name // names hold no slashes (cleanName)
		if it.Kind == "folder" {
			paths[it.ID] = p + "/"
			out = append(out, archiveEntry{path: p + "/", at: it.UpdatedAt})
			continue
		}
		if it.FileID != nil {
			fileIDs = append(fileIDs, *it.FileID)
			out = append(out, archiveEntry{path: p, file: &sqlc.File{ID: *it.FileID}, at: it.UpdatedAt})
		}
	}
	files := map[uuid.UUID]sqlc.File{}
	if len(fileIDs) > 0 {
		fs, err := q.ListDiskFiles(ctx, fileIDs)
		if err != nil {
			return nil, 0, err
		}
		for _, f := range fs {
			files[f.ID] = f
		}
	}
	var total int64
	kept := out[:0]
	for _, e := range out {
		if e.file != nil {
			f, ok := files[e.file.ID]
			if !ok {
				continue
			}
			e.file = &f
			total += f.Size
		}
		kept = append(kept, e)
	}
	if total > maxBytes {
		return nil, 0, errArchiveTooLarge
	}
	return kept, total, nil
}

// publicArchive: GET /api/public/disk/{code}/archive?parent= — «Скачать всё»: the visible
// subtree of the linked folder (or of a folder below it) as a zip, streamed without compression
// (no CPU spent on media that is compressed already); ceilings ArchiveMaxBytes /
// ArchiveMaxItems (413), its own per-IP limit, counted as one download of the link. With
// ?check=1 it only answers whether the archive fits (204 or 413) — under the read limit, not
// counted —, so the page can explain a refusal instead of downloading an error. A view-only link
// (ADR-0167) has no archive: 403.
func (s *Service) publicArchive(w http.ResponseWriter, r *http.Request) error {
	check := r.URL.Query().Get("check") == "1"
	limit := s.LinkArchiveLimit
	if check {
		limit = s.LinkReadLimit
	}
	row, err := s.linkedFolder(w, r, limit)
	if err != nil {
		return err
	}
	if row.link.ViewOnly {
		return errViewOnly
	}
	chain, err := s.folderParam(r, row.item)
	if err != nil {
		return err
	}
	ctx := r.Context()
	folder := chain[len(chain)-1]
	entries, total, err := s.archiveEntries(ctx, folder)
	if err != nil {
		return err
	}
	if check {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
		return q.CountDiskLinkDownload(ctx, row.link.ID)
	}); err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "application/zip")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": folder.Name + ".zip"}))
	// At least 10 minutes, then 1 MiB/s for the rest (a slow link on a large folder).
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10*time.Minute + time.Duration(total>>20)*time.Second))
	zw := zip.NewWriter(w)
	for _, e := range entries {
		hdr := &zip.FileHeader{Name: e.path, Method: zip.Store, Modified: e.at}
		if e.file == nil {
			if _, err := zw.CreateHeader(hdr); err != nil {
				return nil // the client went away; nothing to answer
			}
			continue
		}
		rc, _, err := s.files.Open(ctx, *e.file)
		if err != nil {
			// The headers are out: a missing object leaves the file out, the rest still comes.
			slog.WarnContext(ctx, "disk: archive skips a file", "file", e.file.ID, "err", err)
			continue
		}
		fw, err := zw.CreateHeader(hdr)
		if err == nil {
			_, err = io.Copy(fw, rc)
		}
		_ = rc.Close()
		if err != nil {
			return nil
		}
	}
	_ = zw.Close()
	return nil
}
