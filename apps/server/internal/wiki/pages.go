package wiki

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// PageMax bounds a listing page (wiki.proto ListWikiPagesResponse).
const PageMax = 200

// cursor is the position after the last row of a listing page.
type cursor struct {
	Position int32     `json:"p,omitempty"`
	Trashed  time.Time `json:"t,omitzero"`
	ID       uuid.UUID `json:"i"`
}

func (c cursor) encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string) (*cursor, error) {
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	var c cursor
	if err != nil || json.Unmarshal(b, &c) != nil || c.ID == uuid.Nil {
		return nil, httpx.Validation("cursor", "invalid cursor")
	}
	return &c, nil
}

func pageLimit(r *http.Request, def, most int) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > most {
		return 0, httpx.Validation("limit", "must be 1.."+strconv.Itoa(most))
	}
	return n, nil
}

// list: GET /api/workspaces/{id}/wiki/pages?parent=&trashed=&cursor=&limit= — the live children
// of a page (or the top level) the caller sees, by position; with trashed=1 the trash roots the
// caller sees, the newest deletion first. A page of the listing may hold fewer visible pages
// than the limit; next_cursor is set while there are more rows.
func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	qs := r.URL.Query()
	cur, err := decodeCursor(qs.Get("cursor"))
	if err != nil {
		return err
	}
	limit, err := pageLimit(r, PageMax, PageMax)
	if err != nil {
		return err
	}
	lim := int32(limit) //nolint:gosec // ≤ PageMax
	ctx, q := r.Context(), s.db.Q
	out := &v1.ListWikiPagesResponse{}
	w.Header().Set("Cache-Control", "no-store")
	if t := qs.Get("trashed"); t == "1" || t == "true" {
		p := sqlc.ListWikiTrashParams{WorkspaceID: ws, Lim: lim}
		if cur != nil {
			p.CursorID, p.CursorTrashed = &cur.ID, cur.Trashed
		}
		rows, err := q.ListWikiTrash(ctx, p)
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(rows))
		for i, row := range rows {
			ids[i] = row.ID
		}
		ch, err := wikiacl.Load(ctx, q, ids)
		if err != nil {
			return err
		}
		var seen []sqlc.WikiPageHead
		for _, row := range rows {
			if ch.Bits(c.m, &row.ID).Has(perm.WikiView) {
				seen = append(seen, row)
			}
		}
		if out.Pages, err = decorated(ctx, q, c, seen, func(p sqlc.WikiPageHead) perm.Bits { return ch.Bits(c.m, &p.ID) }, nil); err != nil {
			return err
		}
		if len(rows) == limit {
			last := rows[len(rows)-1]
			out.NextCursor = cursor{Trashed: *last.TrashedAt, ID: last.ID}.encode()
		}
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	parent, err := optUUID(qs.Get("parent"), "parent")
	if err != nil {
		return err
	}
	if _, _, err := parentBits(r, q, ws, c, parent); err != nil {
		return err
	}
	p := sqlc.ListWikiChildrenParams{WorkspaceID: ws, ParentID: parent, Lim: lim}
	if cur != nil {
		p.CursorID, p.CursorPosition = &cur.ID, cur.Position
	}
	rows, err := q.ListWikiChildren(ctx, p)
	if err != nil {
		return err
	}
	var base []uuid.UUID
	if parent != nil {
		base = []uuid.UUID{*parent}
	}
	ch, err := wikiacl.Load(ctx, q, base)
	if err != nil {
		return err
	}
	pages := make([]sqlc.WikiPageHead, len(rows))
	children := make(map[uuid.UUID]bool, len(rows))
	for i, x := range rows {
		pages[i] = x.WikiPageHead
		children[x.WikiPageHead.ID] = x.HasChildren
	}
	if err := ch.AddChildren(ctx, q, parent, pages); err != nil {
		return err
	}
	var seen []sqlc.WikiPageHead
	for _, pg := range pages {
		if ch.Bits(c.m, &pg.ID).Has(perm.WikiView) {
			seen = append(seen, pg)
		}
	}
	if out.Pages, err = decorated(ctx, q, c, seen, func(pg sqlc.WikiPageHead) perm.Bits { return ch.Bits(c.m, &pg.ID) }, children); err != nil {
		return err
	}
	if len(rows) == limit {
		last := rows[len(rows)-1].WikiPageHead
		out.NextCursor = cursor{Position: last.Position, ID: last.ID}.encode()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// create: POST /api/workspaces/{id}/wiki/pages (WIKI_WRITE on the parent, on the Wiki for the
// top level). The page goes last among its siblings; the caller owns it.
func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.CreateWikiPageRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	title, err := cleanTitle(req.GetTitle())
	if err != nil {
		return err
	}
	icon, err := cleanIcon(req.GetIcon())
	if err != nil {
		return err
	}
	parent, err := optUUID(req.GetParentId(), "parent_id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var pg sqlc.WikiPageHead
	var chain []perm.TreeNode
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockWikiTree(ctx, ws); err != nil {
			return err
		}
		ch, err := addable(r, q, ws, c, parent)
		if err != nil {
			return err
		}
		row, err := q.CreateWikiPage(ctx, sqlc.CreateWikiPageParams{WorkspaceID: ws, ParentID: parent, Title: title, Icon: icon, OwnerID: &c.uid})
		if err != nil {
			return err
		}
		pg = head(row)
		if err := ch.AddChildren(ctx, q, parent, []sqlc.WikiPageHead{pg}); err != nil {
			return err
		}
		chain = ch.Nodes(pg.ID)
		pl, err := place(ctx, q, parent)
		if err != nil {
			return err
		}
		pl["title"] = pg.Title
		return s.journal(ctx, q, pg, &c.uid, "create", nil, pl)
	})
	if err != nil {
		return err
	}
	s.publish(ctx, ws, []*v1.DispatchEvent{s.upsertEvent(ctx, pg, chain, nil)})
	httpx.Write(w, http.StatusCreated, &v1.WikiPageResponse{Page: pageProto(pg, nil, false, false, nil, perm.ComputeWikiPageIn(c.m, chain))})
	return nil
}

// get: GET /api/wiki/pages/{id}.
func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	page, err := one(r.Context(), s.db.Q, a)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, &v1.WikiPageResponse{Page: page})
	return nil
}

// path: GET /api/wiki/pages/{id}/path — the breadcrumbs: the ancestors the caller sees, then the
// page. Above an ancestor they do not see, nothing is shown.
func (s *Service) path(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathPage(r)
	if err != nil {
		return err
	}
	chain := a.chain.Path(a.page.ID)
	start := 0
	for i, p := range chain {
		if !a.chain.Bits(a.c.m, &p.ID).Has(perm.WikiView) {
			start = i + 1
		}
	}
	pages, err := decorated(r.Context(), s.db.Q, a.c, chain[start:], func(p sqlc.WikiPageHead) perm.Bits { return a.chain.Bits(a.c.m, &p.ID) }, nil)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, &v1.WikiPathResponse{Pages: pages})
	return nil
}

// update: PATCH /api/wiki/pages/{id} — rename, icon, cover (a file of the page), move (parent_id
// set, "" = the top level: WIKI_WRITE on the destination, no cycles, ≤ 32 deep; position = the
// index among the new siblings) and the restricted switch; the owner or WIKI_MANAGE.
func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	var req v1.UpdateWikiPageRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var newTitle *string
	if req.Title != nil {
		t, err := cleanTitle(req.GetTitle())
		if err != nil {
			return err
		}
		newTitle = &t
	}
	var newIcon *string
	if req.Icon != nil {
		if newIcon, err = cleanIcon(req.GetIcon()); err != nil {
			return err
		}
	}
	var newCover *uuid.UUID
	if req.CoverFileId != nil {
		if newCover, err = optUUID(req.GetCoverFileId(), "cover_file_id"); err != nil {
			return err
		}
	}
	var target *uuid.UUID
	if req.ParentId != nil {
		if target, err = optUUID(req.GetParentId(), "parent_id"); err != nil {
			return err
		}
	}
	if req.Position != nil && req.GetPosition() < 0 {
		return httpx.Validation("position", "must not be negative")
	}
	ctx := r.Context()
	var pg sqlc.WikiPageHead
	var before []perm.TreeNode
	var a access
	changed := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.page.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockWikiTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil { // again under the lock
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.page.TrashedAt != nil {
			return errTrashed
		}
		cur := a.page
		before = a.nodes()
		uid := &a.c.uid
		p := sqlc.UpdateWikiPageParams{ID: id, UpdatedBy: uid}
		var journal []func(sqlc.WikiPageHead) error
		if newTitle != nil && *newTitle != cur.Title {
			p.Title = newTitle
			journal = append(journal, func(pg sqlc.WikiPageHead) error {
				return s.journal(ctx, q, pg, uid, "rename", snap{"title": cur.Title}, snap{"title": pg.Title})
			})
		}
		if req.Icon != nil && strp(newIcon) != strp(cur.Icon) {
			p.SetIcon, p.Icon = true, newIcon
			journal = append(journal, func(pg sqlc.WikiPageHead) error {
				return s.journal(ctx, q, pg, uid, "icon", snap{"icon": strp(cur.Icon)}, snap{"icon": strp(pg.Icon)})
			})
		}
		if req.CoverFileId != nil && idp(newCover) != idp(cur.CoverFileID) {
			if newCover != nil {
				pf, err := q.GetWikiPageFile(ctx, *newCover)
				if err != nil && !db.IsNotFound(err) {
					return err
				}
				if err != nil || pf.PageID != id {
					return httpx.Validation("cover_file_id", "must be a file uploaded to this page")
				}
			}
			p.SetCover, p.CoverFileID = true, newCover
			journal = append(journal, func(pg sqlc.WikiPageHead) error {
				return s.journal(ctx, q, pg, uid, "cover", snap{"file_id": idp(cur.CoverFileID)}, snap{"file_id": idp(pg.CoverFileID)})
			})
		}
		if req.Restricted != nil && req.GetRestricted() != cur.Restricted {
			p.Restricted = req.Restricted
			journal = append(journal, func(pg sqlc.WikiPageHead) error {
				ovs := a.chain.Overrides(id)
				b, err := sharing(ctx, q, ws, cur.Restricted, ovs)
				if err != nil {
					return err
				}
				af, err := sharing(ctx, q, ws, pg.Restricted, ovs)
				if err != nil {
					return err
				}
				return s.journal(ctx, q, pg, uid, "share", b, af)
			})
		}
		pg = cur
		if p.Title != nil || p.SetIcon || p.SetCover || p.Restricted != nil {
			row, err := q.UpdateWikiPage(ctx, p)
			if err != nil {
				return err
			}
			pg, changed = head(row), true
		}
		moving := req.ParentId != nil && !sameParent(cur.ParentID, target)
		if moving || req.Position != nil {
			parent := cur.ParentID
			if moving {
				tch, err := addable(r, q, ws, a.c, target)
				if err != nil {
					return err
				}
				if target != nil && slices.ContainsFunc(tch.Path(*target), func(x sqlc.WikiPageHead) bool { return x.ID == id }) {
					return httpx.Conflict("a page cannot be moved into itself")
				}
				below, err := q.CountWikiSubtreeDepth(ctx, id)
				if err != nil {
					return err
				}
				if depthOf(tch, target)+1+int(below) > MaxDepth {
					return httpx.Conflict("pages may be nested at most 32 deep")
				}
				parent = target
			}
			row, err := s.place(ctx, q, pg, parent, req.Position, uid)
			if err != nil {
				return err
			}
			if moving {
				// The old siblings close the gap.
				if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{WorkspaceID: ws, ParentID: cur.ParentID}); err != nil {
					return err
				}
				journal = append(journal, func(pg sqlc.WikiPageHead) error {
					from, err := place(ctx, q, cur.ParentID)
					if err != nil {
						return err
					}
					to, err := place(ctx, q, pg.ParentID)
					if err != nil {
						return err
					}
					return s.journal(ctx, q, pg, uid, "move", from, to)
				})
			}
			pg, changed = row, true
		}
		for _, j := range journal {
			if err := j(pg); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if changed {
		s.upserted(ctx, id, before)
		s.recheck(ctx, id) // the sync sockets of the page: restricted or a move may have closed it
	}
	ch, err := wikiacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil {
		return err
	}
	a.page, a.chain = ch.Page(id), ch
	a.bits = ch.Bits(a.c.m, &id)
	if !a.bits.Has(perm.WikiView) { // made invisible to oneself (an override): answer what is known
		httpx.Write(w, http.StatusOK, &v1.WikiPageResponse{Page: pageProto(a.page, nil, false, false, nil, a.bits)})
		return nil
	}
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.WikiPageResponse{Page: out})
	return nil
}

// place puts page pg under parent (nil = the top level) at index position among the other live
// siblings (nil = last), under LockWikiTree: the page goes last and the siblings are renumbered
// 0.., then it moves to the index, pushing the following ones down.
func (s *Service) place(ctx context.Context, q *sqlc.Queries, pg sqlc.WikiPageHead, parent *uuid.UUID, position *int32, by *uuid.UUID) (sqlc.WikiPageHead, error) {
	const last = 1 << 30
	row, err := q.MoveWikiPage(ctx, sqlc.MoveWikiPageParams{ID: pg.ID, ParentID: parent, Position: last, UpdatedBy: by})
	if err != nil {
		return pg, err
	}
	if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{WorkspaceID: pg.WorkspaceID, ParentID: parent}); err != nil {
		return pg, err
	}
	if position != nil {
		if row, err = q.MoveWikiPage(ctx, sqlc.MoveWikiPageParams{ID: pg.ID, ParentID: parent, Position: *position, UpdatedBy: by}); err != nil {
			return pg, err
		}
		if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{FirstID: &pg.ID, WorkspaceID: pg.WorkspaceID, ParentID: parent}); err != nil {
			return pg, err
		}
	}
	cur, err := q.GetWikiPage(ctx, row.ID)
	return cur, err
}

func sameParent(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// trash: POST /api/wiki/pages/{id}/trash — the page and its live subtree to the trash (the owner
// or WIKI_MANAGE). The sync sockets of the trashed pages are closed.
func (s *Service) trash(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var a access
	var ids []uuid.UUID
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.page.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.page.TrashedAt != nil {
			return errTrashed
		}
		// Under the tree lock: a create or a move into the subtree checked its parent is live.
		if err := q.LockWikiTree(ctx, a.page.WorkspaceID); err != nil {
			return err
		}
		if ids, err = q.TrashWikiSubtree(ctx, sqlc.TrashWikiSubtreeParams{ID: id, TrashedAt: s.Now(), TrashedBy: &a.c.uid}); err != nil {
			return err
		}
		if !slices.Contains(ids, id) {
			return errTrashed // trashed concurrently
		}
		if a.page, err = q.GetWikiPage(ctx, id); err != nil {
			return err
		}
		if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{WorkspaceID: a.page.WorkspaceID, ParentID: a.page.ParentID}); err != nil {
			return err
		}
		pl, err := place(ctx, q, a.page.ParentID)
		if err != nil {
			return err
		}
		pl["pages"] = float64(len(ids))
		return s.journal(ctx, q, a.page, &a.c.uid, "trash", pl, nil)
	})
	if err != nil {
		return err
	}
	s.kick(ctx, ids)
	s.publish(ctx, a.page.WorkspaceID, []*v1.DispatchEvent{s.upsertEvent(ctx, a.page, a.nodes(), nil)})
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.WikiPageResponse{Page: out})
	return nil
}

// restore: POST /api/wiki/pages/{id}/restore — a trash root and what was deleted with it back
// under its parent, last among the siblings; to the top level when that parent is in the trash
// or gone (WIKI_WRITE there then, unless WIKI_MANAGE). The owner or WIKI_MANAGE.
func (s *Service) restore(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var before []perm.TreeNode
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.page.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockWikiTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if !a.page.TrashedRoot {
			if a.page.TrashedAt == nil {
				return httpx.Conflict("the page is not in the trash")
			}
			return httpx.Conflict("restore the page it was deleted with")
		}
		before = a.nodes()
		parent := a.page.ParentID
		if parent != nil {
			p, err := q.GetWikiPage(ctx, *parent)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if err != nil || p.TrashedAt != nil {
				parent = nil
				if !a.manage() {
					if _, err := addable(r, q, ws, a.c, nil); err != nil {
						return httpx.Conflict("restore the page it was in first")
					}
				}
			}
		}
		ids, err := q.RestoreWikiSubtree(ctx, sqlc.RestoreWikiSubtreeParams{ID: id, ParentID: parent})
		if err != nil {
			return err
		}
		if !slices.Contains(ids, id) {
			return httpx.Conflict("the page is not in the trash")
		}
		if a.page, err = q.GetWikiPage(ctx, id); err != nil {
			return err
		}
		pl, err := place(ctx, q, a.page.ParentID)
		if err != nil {
			return err
		}
		pl["pages"] = float64(len(ids))
		return s.journal(ctx, q, a.page, &a.c.uid, "restore", nil, pl)
	})
	if err != nil {
		return err
	}
	s.upserted(ctx, id, before)
	ch, err := wikiacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil {
		return err
	}
	a.page, a.chain, a.bits = ch.Page(id), ch, ch.Bits(a.c.m, &id)
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.WikiPageResponse{Page: out})
	return nil
}

// deleted is what deleting one subtree forever did, for after the commit.
type deleted struct {
	page  sqlc.WikiPageHead
	chain []perm.TreeNode
	files []sqlc.File
	bytes int64
}

// deleteTree deletes page p and its subtree forever in q's transaction, in the Disk's order
// (ADR-0094 §4): the files rows of the subtree (wiki_page_files and covers) with their quota
// released at once, the journal entry, then the pages (CASCADE: updates, snapshots, versions,
// overrides, links). The blobs are the caller's after the commit (files.DeleteBlobs): the orphan
// cleanup never sees these rows, so the bytes are released once. The caller holds the
// workspaces row (LockDiskQuota) and LockWikiTree.
func (s *Service) deleteTree(ctx context.Context, q *sqlc.Queries, p sqlc.WikiPageHead, chain []perm.TreeNode, actor *uuid.UUID) (deleted, error) {
	d := deleted{page: p, chain: chain}
	fs, err := q.DeleteWikiSubtreeFiles(ctx, p.ID)
	if err != nil {
		if db.IsForeignKeyViolation(err) {
			return d, httpx.Conflict("a file of the page is used elsewhere in the workspace")
		}
		return d, err
	}
	d.files = fs
	for _, f := range fs {
		d.bytes += f.Size
	}
	if d.bytes > 0 {
		if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: p.WorkspaceID, Size: d.bytes}); err != nil {
			return d, err
		}
	}
	if _, err := q.DeleteWikiPage(ctx, p.ID); err != nil {
		return d, err
	}
	before := snap{"title": p.Title, "size": float64(d.bytes), "files": float64(len(fs))}
	if err := s.journal(ctx, q, p, actor, "delete", before, nil); err != nil {
		return d, err
	}
	return d, nil
}

// finish removes the blobs of committed deletions and announces them.
func (s *Service) finish(ctx context.Context, ds []deleted) {
	if len(ds) == 0 {
		return
	}
	var keys []sqlc.ListWorkspaceFileKeysRow
	evs := make([]*v1.DispatchEvent, 0, len(ds))
	for _, d := range ds {
		for _, f := range d.files {
			keys = append(keys, sqlc.ListWorkspaceFileKeysRow{Key: f.Key, ThumbnailKey: f.ThumbnailKey})
		}
		evs = append(evs, removeEvent(d.page, d.chain))
	}
	s.publish(ctx, ds[0].page.WorkspaceID, evs)
	if s.files != nil && len(keys) > 0 {
		files.DeleteBlobs(context.WithoutCancel(ctx), s.files.Store(), keys)
	}
}

// deleteForever: DELETE /api/wiki/pages/{id} — a page in the trash (a root or a part of one),
// with its subtree; the owner or WIKI_MANAGE.
func (s *Service) deleteForever(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "page")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var d deleted
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := resolve(r, q, id)
		if err != nil {
			return err
		}
		if err := writable(ctx, q, a.page.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.page.TrashedAt == nil {
			return httpx.Conflict("move the page to the trash first")
		}
		if err := q.LockDiskQuota(ctx, a.page.WorkspaceID); err != nil { // the workspaces row
			return err
		}
		if err := q.LockWikiTree(ctx, a.page.WorkspaceID); err != nil {
			return err
		}
		// Re-read under the row lock: a concurrent restore must not be undone by this deletion.
		cur, err := q.GetWikiPageForUpdate(ctx, id)
		if db.IsNotFound(err) {
			return errNoPage
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt == nil {
			return httpx.Conflict("move the page to the trash first")
		}
		d, err = s.deleteTree(ctx, q, cur, a.nodes(), &a.c.uid)
		return err
	})
	if err != nil {
		return err
	}
	s.finish(ctx, []deleted{d})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

var errSkip = httpx.Conflict("skipped")

// emptyTrash: POST /api/workspaces/{id}/wiki/trash/empty — deletes forever every trash root the
// caller may delete (their own; all with WIKI_MANAGE), one transaction per root.
func (s *Service) emptyTrash(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	roots, err := s.db.Q.ListWikiTrashRootsAll(ctx, ws)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(roots))
	for i, p := range roots {
		ids[i] = p.ID
	}
	ch, err := wikiacl.Load(ctx, s.db.Q, ids)
	if err != nil {
		return err
	}
	out := &v1.EmptyWikiTrashResponse{}
	var done []deleted
	for _, p := range roots {
		if !perm.WikiStructureAllowed(ch.Bits(c.m, &p.ID), c.owns(p)) {
			continue
		}
		var d deleted
		err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
			a, err := resolve(r, q, p.ID)
			if err != nil || !a.page.TrashedRoot || !a.structure() {
				return errSkip
			}
			if err := q.LockDiskQuota(ctx, ws); err != nil {
				return err
			}
			if err := q.LockWikiTree(ctx, ws); err != nil {
				return err
			}
			cur, err := q.GetWikiPageForUpdate(ctx, p.ID)
			if err != nil || !cur.TrashedRoot { // gone or restored meanwhile
				return errSkip
			}
			d, err = s.deleteTree(ctx, q, cur, a.nodes(), &c.uid)
			return err
		})
		if err == errSkip { //nolint:errorlint // sentinel returned as is
			continue
		}
		if err != nil {
			s.finish(ctx, done)
			return err
		}
		done = append(done, d)
		out.Deleted++
		out.FreedBytes += uint64(max(d.bytes, 0))
	}
	s.finish(ctx, done)
	httpx.Write(w, http.StatusOK, out)
	return nil
}
