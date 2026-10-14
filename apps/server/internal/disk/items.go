package disk

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
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// PageMax bounds a listing page (ADR-0094 §7).
const PageMax = 200

// cursor is the position after the last row of a page (fields by sort).
type cursor struct {
	Rank    int32     `json:"r,omitempty"`
	Name    string    `json:"n,omitempty"`
	Size    int64     `json:"s,omitempty"`
	Updated time.Time `json:"u,omitzero"`
	Trashed time.Time `json:"t,omitzero"`
	ID      uuid.UUID `json:"i"`
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

func rankOf(it sqlc.DiskItem) int32 {
	if it.Kind == "folder" {
		return 0
	}
	return 1
}

func pageLimit(r *http.Request) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return PageMax, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > PageMax {
		return 0, httpx.Validation("limit", "must be 1..200")
	}
	return n, nil
}

// list: GET /api/workspaces/{id}/disk/items?parent=&trashed=&cursor=&sort=&limit= — the items of
// a folder (or the trash roots) the caller sees. A page may hold fewer visible items than the
// limit; next_cursor is set while the folder has more rows.
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
	limit, err := pageLimit(r)
	if err != nil {
		return err
	}
	lim := int32(limit) //nolint:gosec // ≤ PageMax
	ctx, q := r.Context(), s.db.Q
	out := &v1.ListDiskItemsResponse{}
	if t := qs.Get("trashed"); t == "1" || t == "true" {
		p := sqlc.ListDiskTrashParams{WorkspaceID: ws, Lim: lim}
		if cur != nil {
			p.CursorID, p.CursorTrashed = &cur.ID, cur.Trashed
		}
		rows, err := q.ListDiskTrash(ctx, p)
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(rows))
		for i, row := range rows {
			ids[i] = row.DiskItem.ID
		}
		ch, err := diskacl.Load(ctx, q, ids)
		if err != nil {
			return err
		}
		var seen []sqlc.DiskItem
		for _, row := range rows {
			if ch.Bits(c.m, &row.DiskItem.ID).Has(perm.DiskView) {
				seen = append(seen, row.DiskItem)
			}
		}
		if out.Items, err = decorated(ctx, q, c, seen, func(it sqlc.DiskItem) perm.Bits { return ch.Bits(c.m, &it.ID) }); err != nil {
			return err
		}
		if len(rows) == limit {
			last := rows[len(rows)-1].DiskItem
			out.NextCursor = cursor{Trashed: *last.TrashedAt, ID: last.ID}.encode()
		}
		w.Header().Set("Cache-Control", "no-store")
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	parent, err := optUUID(qs.Get("parent"), "parent")
	if err != nil {
		return err
	}
	if _, _, err := folderBits(r, q, ws, c, parent); err != nil {
		return err
	}
	type row struct {
		item  sqlc.DiskItem
		size  int64
		lname string // lower(name) as Postgres has it (the name sorts' cursor)
	}
	var rows []row
	sort := qs.Get("sort")
	switch sort {
	case "", "name":
		p := sqlc.ListDiskFolderByNameParams{WorkspaceID: ws, ParentID: parent, Lim: lim}
		if cur != nil {
			p.CursorID, p.CursorRank, p.CursorName = &cur.ID, cur.Rank, cur.Name
		}
		rs, err := q.ListDiskFolderByName(ctx, p)
		if err != nil {
			return err
		}
		for _, x := range rs {
			rows = append(rows, row{x.DiskItem, x.Size, x.Lname})
		}
	case "updated":
		p := sqlc.ListDiskFolderByUpdatedParams{WorkspaceID: ws, ParentID: parent, Lim: lim}
		if cur != nil {
			p.CursorID, p.CursorUpdated = &cur.ID, cur.Updated
		}
		rs, err := q.ListDiskFolderByUpdated(ctx, p)
		if err != nil {
			return err
		}
		for _, x := range rs {
			rows = append(rows, row{item: x.DiskItem, size: x.Size})
		}
	case "size":
		p := sqlc.ListDiskFolderBySizeParams{WorkspaceID: ws, ParentID: parent, Lim: lim}
		if cur != nil {
			p.CursorID, p.CursorRank, p.CursorSize, p.CursorName = &cur.ID, cur.Rank, cur.Size, cur.Name
		}
		rs, err := q.ListDiskFolderBySize(ctx, p)
		if err != nil {
			return err
		}
		for _, x := range rs {
			rows = append(rows, row{x.DiskItem, x.Size, x.Lname})
		}
	default:
		return httpx.Validation("sort", "must be name, updated or size")
	}
	// The folder's chain once, then each child on top of it.
	var base []uuid.UUID
	if parent != nil {
		base = []uuid.UUID{*parent}
	}
	ch, err := diskacl.Load(ctx, q, base)
	if err != nil {
		return err
	}
	items := make([]sqlc.DiskItem, len(rows))
	for i, x := range rows {
		items[i] = x.item
	}
	if err := ch.AddChildren(ctx, q, parent, items); err != nil {
		return err
	}
	var seen []sqlc.DiskItem
	for _, it := range items {
		if ch.Bits(c.m, &it.ID).Has(perm.DiskView) {
			seen = append(seen, it)
		}
	}
	if out.Items, err = decorated(ctx, q, c, seen, func(it sqlc.DiskItem) perm.Bits { return ch.Bits(c.m, &it.ID) }); err != nil {
		return err
	}
	if len(rows) == limit {
		last := rows[len(rows)-1]
		out.NextCursor = cursor{Rank: rankOf(last.item), Name: last.lname, Size: last.size,
			Updated: last.item.UpdatedAt, ID: last.item.ID}.encode()
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// created answers a new item and announces it.
func (s *Service) created(w http.ResponseWriter, r *http.Request, c caller, it sqlc.DiskItem, f *sqlc.File, chain []perm.DiskNode) {
	s.publish(r.Context(), it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, chain, nil)})
	httpx.Write(w, http.StatusCreated, &v1.DiskItemResponse{Item: itemProto(it, f, false, nil, perm.ComputeDiskItemIn(c.m, chain))})
}

// addable checks, under LockDiskTree, that the caller may create in folder parent: DISK_WRITE
// on it and room for one more level. It returns the folder's chains.
func addable(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID) (*diskacl.Chains, error) {
	bits, ch, err := folderBits(r, q, ws, c, parent)
	if err != nil {
		return nil, err
	}
	if !bits.Has(perm.DiskWrite) {
		return nil, httpx.Forbidden("DISK_WRITE required")
	}
	if depthOf(ch, parent)+1 > MaxDepth {
		return nil, httpx.Conflict("folders may be nested at most 32 deep")
	}
	return ch, nil
}

// createFolder: POST /api/workspaces/{id}/disk/folders (DISK_WRITE on the parent). A taken name
// gets «(2)».
func (s *Service) createFolder(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.CreateDiskFolderRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	name, err := cleanName(req.GetName())
	if err != nil {
		return err
	}
	parent, err := optUUID(req.GetParentId(), "parent_id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var it sqlc.DiskItem
	var chain []perm.DiskNode
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockDiskTree(ctx, ws); err != nil {
			return err
		}
		ch, err := addable(r, q, ws, c, parent)
		if err != nil {
			return err
		}
		if name, err = freeName(ctx, q, ws, parent, name, "folder", nil); err != nil {
			return err
		}
		if it, err = q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: parent, Kind: "folder", Name: name, OwnerID: &c.uid}); err != nil {
			return err
		}
		if err := ch.AddChildren(ctx, q, parent, []sqlc.DiskItem{it}); err != nil {
			return err
		}
		chain = ch.Nodes(it.ID)
		pl, err := place(ctx, q, parent)
		if err != nil {
			return err
		}
		pl["name"] = it.Name
		return s.journal(ctx, q, it, &c.uid, "create", nil, pl)
	})
	if err != nil {
		return err
	}
	s.created(w, r, c, it, nil, chain)
	return nil
}

// upload: POST /api/workspaces/{id}/disk/upload?parent= — multipart "file" into a folder
// (DISK_WRITE on it), through files.UploadWith: the files row, the quota and the item in one
// transaction. A taken name gets «(2)» before the extension.
func (s *Service) upload(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	parent, err := optUUID(r.URL.Query().Get("parent"), "parent")
	if err != nil {
		return err
	}
	ctx := r.Context()
	// Answer early (before reading the body); checked again in the transaction.
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	if _, err := addable(r, s.db.Q, ws, c, parent); err != nil {
		return err
	}
	var it sqlc.DiskItem
	var chain []perm.DiskNode
	f, err := s.files.UploadWith(w, r, ws, func(q *sqlc.Queries, f sqlc.File) error {
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockDiskTree(ctx, ws); err != nil { // after the quota's workspaces row lock
			return err
		}
		ch, err := addable(r, q, ws, c, parent)
		if err != nil {
			return err
		}
		name, err := cleanName(f.Name)
		if err != nil {
			name = "file"
		}
		if name, err = freeName(ctx, q, ws, parent, name, "file", nil); err != nil {
			return err
		}
		if it, err = q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: parent, Kind: "file", Name: name, FileID: &f.ID, OwnerID: &c.uid}); err != nil {
			return err
		}
		if err := ch.AddChildren(ctx, q, parent, []sqlc.DiskItem{it}); err != nil {
			return err
		}
		chain = ch.Nodes(it.ID)
		pl, err := place(ctx, q, parent)
		if err != nil {
			return err
		}
		pl["name"], pl["size"], pl["mime"] = it.Name, float64(f.Size), f.Mime
		return s.journal(ctx, q, it, &c.uid, "upload", nil, pl)
	})
	if err != nil {
		return err
	}
	s.created(w, r, c, it, &f, chain)
	return nil
}

// get: GET /api/disk/items/{id}.
func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	item, err := one(r.Context(), s.db.Q, a)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, &v1.DiskItemResponse{Item: item})
	return nil
}

// path: GET /api/disk/items/{id}/path — the breadcrumbs: the ancestors the caller sees, from
// the root's child down to the item. Above an ancestor they do not see, nothing is shown.
func (s *Service) path(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	chain := a.chain.Path(a.item.ID)
	start := 0
	for i, it := range chain {
		if !a.chain.Bits(a.c.m, &it.ID).Has(perm.DiskView) {
			start = i + 1
		}
	}
	shown := chain[start:]
	items, err := decorated(r.Context(), s.db.Q, a.c, shown, func(it sqlc.DiskItem) perm.Bits { return a.chain.Bits(a.c.m, &it.ID) })
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, &v1.DiskPathResponse{Items: items})
	return nil
}

var errTrashed = httpx.Conflict("the item is in the trash")

// update: PATCH /api/disk/items/{id} — rename, move (parent_id; "" = the root; DISK_WRITE on the
// destination, no cycles, ≤ 32 deep) and the restricted switch; the owner or DISK_MANAGE.
func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.UpdateDiskItemRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var newName *string
	if req.Name != nil {
		n, err := cleanName(req.GetName())
		if err != nil {
			return err
		}
		newName = &n
	}
	var target *uuid.UUID
	if req.ParentId != nil {
		if target, err = optUUID(req.GetParentId(), "parent_id"); err != nil {
			return err
		}
	}
	ctx := r.Context()
	var it sqlc.DiskItem
	var before, after []perm.DiskNode
	var bits perm.Bits
	var c caller
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := resolve(r, q, id)
		if err != nil {
			return err
		}
		c = a.c
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if err := q.LockDiskTree(ctx, a.item.WorkspaceID); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil { // again under the lock
			return err
		}
		if !a.mayChange() {
			return httpx.Forbidden("only the owner or DISK_MANAGE may change the item")
		}
		if a.item.TrashedAt != nil {
			return errTrashed
		}
		ws, cur := a.item.WorkspaceID, a.item
		before = a.nodes()
		p := sqlc.UpdateDiskItemParams{ID: id}
		parent := cur.ParentID
		moving := req.ParentId != nil && !sameParent(cur.ParentID, target)
		if moving {
			tch, err := addable(r, q, ws, a.c, target)
			if err != nil {
				return err
			}
			if target != nil && slices.ContainsFunc(tch.Path(*target), func(x sqlc.DiskItem) bool { return x.ID == id }) {
				return httpx.Conflict("a folder cannot be moved into itself")
			}
			below, err := q.CountDiskSubtreeDepth(ctx, id)
			if err != nil {
				return err
			}
			if depthOf(tch, target)+1+int(below) > MaxDepth {
				return httpx.Conflict("folders may be nested at most 32 deep")
			}
			p.SetParent, p.ParentID, parent = true, target, target
		}
		name := cur.Name
		if newName != nil && *newName != cur.Name {
			name, p.Name = *newName, newName
		}
		if moving || p.Name != nil {
			taken, err := q.DiskNameTaken(ctx, sqlc.DiskNameTakenParams{WorkspaceID: ws, ParentID: parent, Name: name, ExceptID: &id})
			if err != nil {
				return err
			}
			if taken {
				return httpx.Conflict("an item with this name is already in the folder").WithDetails("DISK_NAME_TAKEN", 0, 0)
			}
		}
		if req.Restricted != nil && req.GetRestricted() != cur.Restricted {
			p.Restricted = req.Restricted
		}
		if !moving && p.Name == nil && p.Restricted == nil {
			it, bits, after = cur, a.bits, before
			return nil
		}
		if it, err = q.UpdateDiskItem(ctx, p); err != nil {
			if db.UniqueViolation(err) != "" {
				return httpx.Conflict("an item with this name is already in the folder").WithDetails("DISK_NAME_TAKEN", 0, 0)
			}
			return err
		}
		if p.Name != nil {
			if err := s.journal(ctx, q, it, &c.uid, "rename", snap{"name": cur.Name}, snap{"name": it.Name}); err != nil {
				return err
			}
		}
		if moving {
			from, err := place(ctx, q, cur.ParentID)
			if err != nil {
				return err
			}
			to, err := place(ctx, q, it.ParentID)
			if err != nil {
				return err
			}
			if err := s.journal(ctx, q, it, &c.uid, "move", from, to); err != nil {
				return err
			}
		}
		if p.Restricted != nil {
			ovs := a.chain.Overrides(id)
			b, err := sharing(ctx, q, ws, cur.Restricted, ovs)
			if err != nil {
				return err
			}
			af, err := sharing(ctx, q, ws, it.Restricted, ovs)
			if err != nil {
				return err
			}
			if err := s.journal(ctx, q, it, &c.uid, "share", b, af); err != nil {
				return err
			}
		}
		ch, err := diskacl.Load(ctx, q, []uuid.UUID{id})
		if err != nil {
			return err
		}
		after = ch.Nodes(id)
		bits = perm.ComputeDiskItemIn(a.c.m, after)
		return nil
	})
	if err != nil {
		return err
	}
	if !sameChain(before, after) {
		s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, after, before)})
	} else {
		s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, after, nil)})
	}
	out, err := decorated(ctx, s.db.Q, c, []sqlc.DiskItem{it}, func(sqlc.DiskItem) perm.Bits { return bits })
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.DiskItemResponse{Item: out[0]})
	return nil
}

func sameParent(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// trash: POST /api/disk/items/{id}/trash — the item and its live subtree to the trash (the owner
// or DISK_MANAGE).
func (s *Service) trash(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var it sqlc.DiskItem
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if !a.mayChange() {
			return httpx.Forbidden("only the owner or DISK_MANAGE may delete the item")
		}
		if a.item.TrashedAt != nil {
			return errTrashed
		}
		// Under the tree lock: an upload or a move into the subtree checked its folder is live.
		if err := q.LockDiskTree(ctx, a.item.WorkspaceID); err != nil {
			return err
		}
		rows, err := q.TrashDiskSubtree(ctx, sqlc.TrashDiskSubtreeParams{ID: id, TrashedAt: s.Now(), TrashedBy: &a.c.uid})
		if err != nil {
			return err
		}
		i := slices.IndexFunc(rows, func(x sqlc.DiskItem) bool { return x.ID == id })
		if i < 0 {
			return errTrashed // trashed concurrently
		}
		it = rows[i]
		pl, err := place(ctx, q, it.ParentID)
		if err != nil {
			return err
		}
		return s.journal(ctx, q, it, &a.c.uid, "trash", pl, nil)
	})
	if err != nil {
		return err
	}
	s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, a.nodes(), nil)})
	a.item = it
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.DiskItemResponse{Item: out})
	return nil
}

// restore: POST /api/disk/items/{id}/restore — a trash root and what was deleted with it back
// to its folder; to the root when that folder is in the trash or gone (DISK_WRITE on the root
// then); «(2)» on a taken name. The owner or DISK_MANAGE.
func (s *Service) restore(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var it sqlc.DiskItem
	var before, after []perm.DiskNode
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockDiskTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if !a.mayChange() {
			return httpx.Forbidden("only the owner or DISK_MANAGE may restore the item")
		}
		if !a.item.TrashedRoot {
			if a.item.TrashedAt == nil {
				return httpx.Conflict("the item is not in the trash")
			}
			return httpx.Conflict("restore the folder it was deleted with")
		}
		before = a.nodes()
		parent := a.item.ParentID
		if parent != nil {
			p, err := q.GetDiskItem(ctx, *parent)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if err != nil || p.TrashedAt != nil {
				parent = nil
				if !a.manage() {
					if _, err := addable(r, q, ws, a.c, nil); err != nil {
						return httpx.Conflict("restore the folder it was in first")
					}
				}
			}
		}
		name, err := freeName(ctx, q, ws, parent, a.item.Name, a.item.Kind, &id)
		if err != nil {
			return err
		}
		rows, err := q.RestoreDiskSubtree(ctx, sqlc.RestoreDiskSubtreeParams{ID: id, ParentID: parent, Name: name})
		if err != nil {
			return err
		}
		i := slices.IndexFunc(rows, func(x sqlc.DiskItem) bool { return x.ID == id })
		if i < 0 {
			return httpx.Conflict("the item is not in the trash")
		}
		it = rows[i]
		pl, err := place(ctx, q, it.ParentID)
		if err != nil {
			return err
		}
		pl["name"] = it.Name
		if err := s.journal(ctx, q, it, &a.c.uid, "restore", nil, pl); err != nil {
			return err
		}
		ch, err := diskacl.Load(ctx, q, []uuid.UUID{id})
		if err != nil {
			return err
		}
		after = ch.Nodes(id)
		a.item, a.chain, a.bits = it, ch, perm.ComputeDiskItemIn(a.c.m, after)
		return nil
	})
	if err != nil {
		return err
	}
	var was []perm.DiskNode
	if !sameChain(before, after) {
		was = before
	}
	s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, after, was)})
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.DiskItemResponse{Item: out})
	return nil
}

// deleted is what deleting one subtree forever did, for after the commit.
type deleted struct {
	item  sqlc.DiskItem
	chain []perm.DiskNode
	files []sqlc.File
	bytes int64
}

// deleteTree deletes item it and its subtree forever in q's transaction (ADR-0094 §4, D1
// decision): the journal entry, the files rows of the subtree (their items go with them) with
// their quota released at once, then the item. The blobs are the caller's after the commit
// (files.DeleteBlobs): the orphan cleanup never sees these rows, so the bytes are released once.
func (s *Service) deleteTree(ctx context.Context, q *sqlc.Queries, it sqlc.DiskItem, chain []perm.DiskNode, actor *uuid.UUID) (deleted, error) {
	d := deleted{item: it, chain: chain}
	fs, err := q.DeleteDiskSubtreeFiles(ctx, it.ID)
	if err != nil {
		if db.IsForeignKeyViolation(err) {
			return d, httpx.Conflict("a file of the item is used elsewhere in the workspace")
		}
		return d, err
	}
	d.files = fs
	for _, f := range fs {
		d.bytes += f.Size
	}
	if d.bytes > 0 {
		if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: it.WorkspaceID, Size: d.bytes}); err != nil {
			return d, err
		}
	}
	if _, err := q.DeleteDiskItem(ctx, it.ID); err != nil {
		return d, err
	}
	before := snap{"name": it.Name, "kind": it.Kind, "size": float64(d.bytes), "files": float64(len(fs))}
	if err := s.journal(ctx, q, it, actor, "delete", before, nil); err != nil {
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
		evs = append(evs, removeEvent(d.item, d.chain))
	}
	s.publish(ctx, ds[0].item.WorkspaceID, evs)
	if s.files != nil && len(keys) > 0 {
		files.DeleteBlobs(context.WithoutCancel(ctx), s.files.Store(), keys)
	}
}

// deleteForever: DELETE /api/disk/items/{id} — an item in the trash (a root or a part of one),
// with its subtree; the owner or DISK_MANAGE.
func (s *Service) deleteForever(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
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
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if !a.mayChange() {
			return httpx.Forbidden("only the owner or DISK_MANAGE may delete the item")
		}
		if a.item.TrashedAt == nil {
			return httpx.Conflict("move the item to the trash first")
		}
		if err := q.LockDiskQuota(ctx, a.item.WorkspaceID); err != nil {
			return err
		}
		// The tree lock after the quota row (an upload's order): no restore or move of this
		// subtree runs while it is deleted.
		if err := q.LockDiskTree(ctx, a.item.WorkspaceID); err != nil {
			return err
		}
		// Re-read under the row lock: a concurrent restore must not be undone by this deletion.
		cur, err := q.GetDiskItemForUpdate(ctx, id)
		if db.IsNotFound(err) {
			return errNoItem
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt == nil {
			return httpx.Conflict("move the item to the trash first")
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

// emptyTrash: POST /api/workspaces/{id}/disk/trash/empty — deletes forever every trash root the
// caller may delete (their own; all with DISK_MANAGE), one transaction per root.
func (s *Service) emptyTrash(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	roots, err := s.db.Q.ListDiskTrashRootsAll(ctx, ws)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(roots))
	for i, it := range roots {
		ids[i] = it.ID
	}
	ch, err := diskacl.Load(ctx, s.db.Q, ids)
	if err != nil {
		return err
	}
	out := &v1.EmptyDiskTrashResponse{}
	var done []deleted
	for _, it := range roots {
		bits := ch.Bits(c.m, &it.ID)
		if !bits.Has(perm.DiskView) || (!bits.Has(perm.DiskManage) && !c.owns(it)) {
			continue
		}
		var d deleted
		err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
			a, err := resolve(r, q, it.ID)
			if err != nil || !a.item.TrashedRoot || !a.mayChange() {
				return errSkip
			}
			if err := q.LockDiskQuota(ctx, ws); err != nil {
				return err
			}
			// The tree lock after the quota row (an upload's order): no restore or move of this
			// subtree runs while it is deleted.
			if err := q.LockDiskTree(ctx, ws); err != nil {
				return err
			}
			cur, err := q.GetDiskItemForUpdate(ctx, it.ID)
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

var errSkip = httpx.Conflict("skipped")
