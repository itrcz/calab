package disk

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// CodeLength is the length of a public link code.
const CodeLength = 43

var errNoLink = httpx.NotFound("link")

// PublicOffice opens a file reached through a public link read-only in the office viewer
// (ADR-0165; internal/office). nil = the viewer is off for links.
type PublicOffice interface {
	// Opens reports whether a file of this name and size opens in the viewer.
	Opens(name string, size int64) bool
	// PublicView signs a view-only configuration of the file for an anonymous visitor;
	// noDownload (a «Без скачивания» link, ADR-0167) also turns off download, print and copy.
	PublicView(ctx context.Context, fileID uuid.UUID, title string, size int64, light, phone, noDownload bool, lang string) (*v1.OfficeConfigResponse, error)
}

// linkRow is a live link with its item.
type linkRow struct {
	link sqlc.DiskLink
	item sqlc.DiskItem
}

// linked resolves an anonymous visit of a public link (resolveLink) that the visitor may read: a
// link with a password needs a valid unlock (ADR-0167), else errLocked.
func (s *Service) linked(w http.ResponseWriter, r *http.Request, limit Limiter) (linkRow, error) {
	row, err := s.resolveLink(w, r, limit)
	if err == nil && !s.unlocked(r, row.link) {
		err = errLocked
	}
	return row, err
}

// resolveLink resolves an anonymous visit of a public link (ADR-0094 §3, ADR-0165): the live
// link (not revoked, not expired) with its item — a file in the trash or restricted too, a
// folder not in the trash —, in a workspace that is not suspended and whose identity policy
// allows public capabilities (like public forms). limit is spent first, per client IP. It does
// not check the link's password: linked does.
func (s *Service) resolveLink(w http.ResponseWriter, r *http.Request, limit Limiter) (linkRow, error) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Referrer-Policy", "no-referrer")
	ctx := r.Context()
	if limit != nil {
		if err := limit.Take(ctx, httpx.ClientIP(ctx)); err != nil {
			return linkRow{}, err
		}
	}
	code := r.PathValue("code")
	if len(code) != CodeLength {
		return linkRow{}, errNoLink
	}
	row, err := s.db.Q.GetDiskLinkByCode(ctx, code)
	if db.IsNotFound(err) {
		return linkRow{}, errNoLink
	}
	if err != nil {
		return linkRow{}, err
	}
	if row.DiskItem.Kind == "folder" && row.DiskItem.TrashedAt != nil {
		// Its contents are in the trash with it (trashed items are never listed).
		return linkRow{}, errNoLink
	}
	ws, err := s.db.Q.GetWorkspace(ctx, row.DiskItem.WorkspaceID)
	if err != nil {
		return linkRow{}, err
	}
	if ws.SuspendedAt != nil {
		return linkRow{}, errNoLink
	}
	if err := s.plans.CheckBillingOpen(ctx, s.db.Q, ws.ID); err != nil {
		return linkRow{}, err
	}
	if err := auth.CheckPublicCapability(ctx, s.db.Q, ws.ID); err != nil {
		return linkRow{}, err
	}
	return linkRow{link: row.DiskLink, item: row.DiskItem}, nil
}

// fileOf loads the files row of a file item (404 for a folder).
func (s *Service) fileOf(ctx context.Context, it sqlc.DiskItem) (sqlc.File, error) {
	if it.Kind != "file" || it.FileID == nil {
		return sqlc.File{}, errNoLink
	}
	f, err := s.db.Q.GetFile(ctx, *it.FileID)
	if db.IsNotFound(err) {
		return f, errNoLink
	}
	return f, err
}

// linkedFile is linked for the routes of a file link (404 for a folder link).
func (s *Service) linkedFile(w http.ResponseWriter, r *http.Request, limit Limiter) (linkRow, sqlc.File, error) {
	row, err := s.linked(w, r, limit)
	if err != nil {
		return row, sqlc.File{}, err
	}
	f, err := s.fileOf(r.Context(), row.item)
	return row, f, err
}

// officeOpens reports whether the link's office viewer opens the file.
func (s *Service) officeOpens(name string, size int64) bool {
	return s.Office != nil && s.Office.Opens(name, size)
}

// publicFile: GET /api/public/disk/{code} — PublicDiskFile, anonymous. A folder link answers
// its name and kind only (the contents: publicItems). A locked link (ADR-0167) answers locked
// and nothing else.
func (s *Service) publicFile(w http.ResponseWriter, r *http.Request) error {
	row, err := s.resolveLink(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	if !s.unlocked(r, row.link) {
		httpx.Write(w, http.StatusOK, &v1.PublicDiskFile{Locked: true})
		return nil
	}
	out := &v1.PublicDiskFile{Name: row.item.Name, Id: row.item.ID.String(), ViewOnly: row.link.ViewOnly}
	if row.link.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*row.link.ExpiresAt)
	}
	if row.item.Kind == "folder" {
		out.Kind = v1.DiskItemKind_DISK_ITEM_KIND_FOLDER
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	f, err := s.fileOf(r.Context(), row.item)
	if err != nil {
		return err
	}
	out.Kind = v1.DiskItemKind_DISK_ITEM_KIND_FILE
	out.Size, out.Mime, out.HasThumbnail = uint64(max(f.Size, 0)), f.Mime, f.ThumbnailKey != nil
	if f.Width != nil && f.Height != nil && pbconv.IsImage(f.Mime) {
		out.Width, out.Height = uint32(max(*f.Width, 0)), uint32(max(*f.Height, 0))
	}
	out.Office = s.officeOpens(row.item.Name, f.Size)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// serveCounted serves the bytes of a linked file (Range); a request from the start of the file
// counts as a download of the link (no lock: one UPDATE of a counter). A view-only link
// (ADR-0167) serves only files of the page's in-browser viewers, inline.
func (s *Service) serveCounted(w http.ResponseWriter, r *http.Request, link sqlc.DiskLink, it sqlc.DiskItem, f sqlc.File) error {
	if link.ViewOnly && !viewable(it.Name, f.Mime) {
		return errViewOnly
	}
	if rg := r.Header.Get("Range"); r.Method == http.MethodGet && (rg == "" || strings.HasPrefix(rg, "bytes=0-")) {
		if err := db.GuardExec(r.Context(), s.db, func(q *sqlc.Queries) error {
			return q.CountDiskLinkDownload(r.Context(), link.ID)
		}); err != nil {
			return err
		}
	}
	f.Name = it.Name // the name on the Disk (a renamed file downloads as such)
	if link.ViewOnly {
		return s.files.ServeLinkedInline(w, r, f)
	}
	return s.files.ServeLinked(w, r, f, false)
}

// publicContent: GET /api/public/disk/{code}/content — the bytes of a file link, anonymous.
func (s *Service) publicContent(w http.ResponseWriter, r *http.Request) error {
	row, f, err := s.linkedFile(w, r, s.LinkDownloadLimit)
	if err != nil {
		return err
	}
	return s.serveCounted(w, r, row.link, row.item, f)
}

// publicThumbnail: GET /api/public/disk/{code}/thumbnail?w=512|1024 — the preview, anonymous.
func (s *Service) publicThumbnail(w http.ResponseWriter, r *http.Request) error {
	_, f, err := s.linkedFile(w, r, s.LinkReadLimit)
	if err != nil {
		return err
	}
	return s.files.ServeLinked(w, r, f, true)
}

// publicOffice: GET /api/public/disk/{code}/office?item=&theme=dark|light&phone=1&lang= — the
// signed view-only configuration of the office viewer (ADR-0165): the file of a file link, or
// file item of a folder link (inside the link's visible subtree). 404 while the viewer is off.
func (s *Service) publicOffice(w http.ResponseWriter, r *http.Request) error {
	row, err := s.linked(w, r, s.LinkDownloadLimit)
	if err != nil {
		return err
	}
	if s.Office == nil {
		return httpx.NotFound("office")
	}
	ctx, qs := r.Context(), r.URL.Query()
	it := row.item
	if it.Kind == "folder" {
		id, err := uuid.Parse(qs.Get("item"))
		if err != nil {
			return errNoItem
		}
		chain, err := s.under(ctx, row.item, id)
		if err != nil {
			return err
		}
		it = chain[len(chain)-1]
	}
	f, err := s.fileOf(ctx, it)
	if err != nil {
		return errNoItem
	}
	out, err := s.Office.PublicView(ctx, f.ID, it.Name, f.Size, qs.Get("theme") == "light", qs.Get("phone") == "1", row.link.ViewOnly, qs.Get("lang"))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}
