// Package disk implements the Disk of a workspace (ADR-0094): folders and files with per-item
// access (perm.ComputeDiskItem over internal/diskacl chains), the trash with its hourly sweeper,
// public file links, the journal (disk_activity) and the storage usage. Files of the Disk are
// ordinary files rows (internal/files): uploads go through files.UploadWith, downloads through
// GET /api/files/{id} (files.CanRead has the Disk branch).
//
// Every handler resolves the caller's bits on the item it touches; without DISK_VIEW the answer
// is 404, as if the item did not exist. Changing an item (rename, move, trash, restore, delete
// forever, sharing, its public link) takes its owner or DISK_MANAGE; creating inside a folder
// takes DISK_WRITE on it. After every committed change DISK_ITEM_UPSERT / DISK_ITEM_REMOVE go to
// the workspace channel with the item's access chain, which the gateway uses to deliver them
// only to members who see the item.
package disk

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// MaxDepth is how deep the tree may go (ADR-0094 §1): a folder at the root has depth 1.
const MaxDepth = 32

// Limiter is a per-key rate limit (redisx.RateLimiter): Take answers 429 when the budget is out.
type Limiter interface {
	Take(ctx context.Context, key string) error
}

// Service serves the Disk API.
type Service struct {
	db    *db.DB
	ev    events.Publisher
	files *files.Service
	plans *plans.Service
	// PublicURL is PUBLIC_APP_URL: the page of a public link is PublicURL + "/d/" + code.
	PublicURL string
	// LinkReadLimit: anonymous link metadata and thumbnails per client IP; LinkDownloadLimit:
	// anonymous downloads (each Range request counts) per client IP. nil = none.
	LinkReadLimit, LinkDownloadLimit Limiter
	// Now is the clock (tests move it).
	Now func() time.Time
}

// New creates the service; p may be nil (no plan limits).
func New(d *db.DB, ev events.Publisher, f *files.Service, p *plans.Service) *Service {
	if ev == nil {
		ev = events.Nop{}
	}
	return &Service{db: d, ev: ev, files: f, plans: p, Now: time.Now}
}

// Routes registers the routes; wrap applies auth + the permission resolver. The public link
// routes are registered without it (anonymous).
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/workspaces/{id}/disk/items", s.list)
	h("POST /api/workspaces/{id}/disk/folders", s.createFolder)
	h("POST /api/workspaces/{id}/disk/upload", s.upload)
	h("POST /api/workspaces/{id}/disk/trash/empty", s.emptyTrash)
	h("GET /api/workspaces/{id}/disk/usage", s.usage)
	h("GET /api/workspaces/{id}/disk/activity", s.workspaceActivity)
	h("GET /api/workspaces/{id}/disk/settings", s.settings)
	h("PUT /api/workspaces/{id}/disk/settings", s.setSettings)
	h("GET /api/disk/items/{id}", s.get)
	h("PATCH /api/disk/items/{id}", s.update)
	h("DELETE /api/disk/items/{id}", s.deleteForever)
	h("POST /api/disk/items/{id}/trash", s.trash)
	h("POST /api/disk/items/{id}/restore", s.restore)
	h("GET /api/disk/items/{id}/path", s.path)
	h("GET /api/disk/items/{id}/activity", s.itemActivity)
	h("GET /api/disk/items/{id}/permissions", s.getPermissions)
	h("PUT /api/disk/items/{id}/permissions", s.setPermissions)
	h("POST /api/disk/items/{id}/link", s.createLink)
	h("DELETE /api/disk/items/{id}/link", s.deleteLink)
	mux.Handle("GET /api/public/disk/{code}", httpx.HandlerFunc(s.publicFile))
	mux.Handle("GET /api/public/disk/{code}/content", httpx.HandlerFunc(s.publicContent))
	mux.Handle("GET /api/public/disk/{code}/thumbnail", httpx.HandlerFunc(s.publicThumbnail))
}

// ---- callers and access ----

// caller is the requester as a member of the item's workspace.
type caller struct {
	uid uuid.UUID
	m   perm.Member
}

func (c caller) owns(it sqlc.DiskItem) bool { return it.OwnerID != nil && *it.OwnerID == c.uid }

var errNotMember = httpx.NotFound("workspace")

// member resolves the caller in workspace ws: 404 for non-members.
func member(r *http.Request, ws uuid.UUID) (caller, error) {
	id := auth.MustFromContext(r.Context())
	m, err := perm.FromContext(r.Context()).Member(r.Context(), ws, id.UserID)
	if errors.Is(err, perm.ErrNotMember) {
		return caller{}, errNotMember
	}
	if err != nil {
		return caller{}, err
	}
	return caller{uid: id.UserID, m: m}, nil
}

// pathWorkspace resolves {id} as a workspace the caller belongs to.
func pathWorkspace(r *http.Request) (uuid.UUID, caller, error) {
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return ws, caller{}, err
	}
	c, err := member(r, ws)
	return ws, c, err
}

// access is the caller's view of one item.
type access struct {
	item  sqlc.DiskItem
	c     caller
	bits  perm.Bits
	chain *diskacl.Chains
}

func (a access) manage() bool { return a.bits.Has(perm.DiskManage) }

// mayChange: the item's owner or DISK_MANAGE (ADR-0094 §2: DISK_WRITE changes one's own items).
func (a access) mayChange() bool {
	return a.manage() || (a.c.owns(a.item) && a.bits.Has(perm.DiskWrite))
}

func (a access) nodes() []perm.DiskNode { return a.chain.Nodes(a.item.ID) }

var errNoItem = httpx.NotFound("item")

// resolve loads item id with its chain through q and the caller's bits on it: 404 when it does
// not exist or the caller does not see it.
func resolve(r *http.Request, q *sqlc.Queries, id uuid.UUID) (access, error) {
	ch, err := diskacl.Load(r.Context(), q, []uuid.UUID{id})
	if err != nil {
		return access{}, err
	}
	if !ch.Has(id) {
		return access{}, errNoItem
	}
	it := ch.Item(id)
	c, err := member(r, it.WorkspaceID)
	if errors.Is(err, errNotMember) {
		return access{}, errNoItem
	}
	if err != nil {
		return access{}, err
	}
	bits := ch.Bits(c.m, &id)
	if !bits.Has(perm.DiskView) {
		return access{}, errNoItem
	}
	return access{item: it, c: c, bits: bits, chain: ch}, nil
}

// pathItem resolves {id} as an item the caller sees.
func (s *Service) pathItem(r *http.Request) (access, error) {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return access{}, err
	}
	return resolve(r, s.db.Q, id)
}

// writable refuses changes in a workspace suspended by a superadmin (item 32).
func writable(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	w, err := q.GetWorkspace(ctx, ws)
	if err != nil {
		return err
	}
	if w.SuspendedAt != nil {
		return moderation.ErrSuspended
	}
	return nil
}

// folderBits: the caller's bits on folder parent (nil = the root) through q; 404 when it is not
// a live folder the caller sees (409 for a folder in the trash).
func folderBits(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID) (perm.Bits, *diskacl.Chains, error) {
	if parent == nil {
		ch, _ := diskacl.Load(r.Context(), q, nil)
		return ch.Bits(c.m, nil), ch, nil
	}
	ch, err := diskacl.Load(r.Context(), q, []uuid.UUID{*parent})
	if err != nil {
		return 0, nil, err
	}
	if !ch.Has(*parent) {
		return 0, nil, httpx.NotFound("folder")
	}
	p := ch.Item(*parent)
	bits := ch.Bits(c.m, parent)
	if p.WorkspaceID != ws || p.Kind != "folder" || !bits.Has(perm.DiskView) {
		return 0, nil, httpx.NotFound("folder")
	}
	if p.TrashedAt != nil {
		return 0, nil, httpx.Conflict("the folder is in the trash")
	}
	return bits, ch, nil
}

// ---- names ----

// cleanName validates a folder / file name: trimmed, 1..255 characters, no control characters
// and no slashes.
func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 255 || name == "." || name == ".." {
		return "", httpx.Validation("name", "must be 1..255 characters")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return "", httpx.Validation("name", "must not contain slashes or control characters")
		}
	}
	return name, nil
}

// freeName returns name, or «name (2)», «name (3)» … (before the extension of a file) when a
// live item of the folder already has it; under LockDiskTree.
func freeName(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, parent *uuid.UUID, name, kind string, except *uuid.UUID) (string, error) {
	base, ext := name, ""
	if kind == "file" {
		if i := strings.LastIndexByte(name, '.'); i > 0 {
			base, ext = name[:i], name[i:]
		}
	}
	candidate := name
	for n := 2; ; n++ {
		taken, err := q.DiskNameTaken(ctx, sqlc.DiskNameTakenParams{WorkspaceID: ws, ParentID: parent, Name: candidate, ExceptID: except})
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		if n > 1000 {
			return "", httpx.Conflict("too many items with this name")
		}
		suffix := " (" + strconv.Itoa(n) + ")"
		b := base
		for utf8.RuneCountInString(b)+utf8.RuneCountInString(suffix+ext) > 255 && b != "" {
			_, size := utf8.DecodeLastRuneInString(b)
			b = b[:len(b)-size]
		}
		candidate = b + suffix + ext
	}
}

// depthOf is the depth of folder parent (nil = the root: 0) from its chain.
func depthOf(ch *diskacl.Chains, parent *uuid.UUID) int {
	if parent == nil {
		return 0
	}
	return len(ch.Path(*parent))
}

func optUUID(raw string, what string) (*uuid.UUID, error) {
	if raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, httpx.Validation(what, "must be an id")
	}
	return &id, nil
}
