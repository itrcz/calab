// Package canvas implements the Canvas section of a workspace (ADR-0126): a tree of folders and
// canvases with per-item access (perm.ComputeCanvasItem over internal/canvasacl chains), the
// trash with its hourly sweeper, the journal (canvas_activity), version history and the
// collaborative content.
//
// The content of a canvas is a Yjs document the server never parses: it travels only through the
// sync socket GET /api/canvas/items/{id}/sync (sync.go, the binary frames of internal/ysync shared
// with the Wiki, relayed between server instances through the Redis channel canvas:<id>) and is
// stored as the last snapshot plus the updates after it.
//
// Every handler resolves the caller's bits on the item it touches; without CANVAS_VIEW the answer
// is 404, as if the item did not exist. CANVAS_WRITE on a canvas edits its content and, on a
// folder, creates items in it; the structure of an item (rename, move, trash, restore, delete
// forever, access) takes its owner or CANVAS_MANAGE (perm.CanvasStructureAllowed). After every
// committed structural change CANVAS_ITEM_UPSERT / CANVAS_ITEM_REMOVE go to the workspace channel
// with the item's access chain, which the gateway uses to deliver them only to members who see
// the item.
package canvas

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/ysync"
)

// MaxDepth is how deep the tree may go (ADR-0126 §1): a top-level item has depth 1.
const MaxDepth = 32

// MaxName is the longest name in characters (canvas_items CHECK).
const MaxName = 200

// Kinds of an item (canvas_items.kind).
const (
	kindFolder = "folder"
	kindCanvas = "canvas"
)

// Service serves the Canvas API and the sync socket.
type Service struct {
	db *db.DB
	ev events.Publisher
	// Now is the clock (tests move it).
	Now func() time.Time

	// CommentLimit: a per-user budget of comment writes (ADR-0127 wave 4); nil = unlimited.
	CommentLimit *redisx.RateLimiter

	// The public read-only link (ADR-0127 wave 5, link.go). PublicURL is PUBLIC_APP_URL: the page
	// of a link is PublicURL + "/c/" + code. LinkReadLimit (the public name) and LinkSyncLimit
	// (connects of the anonymous socket) are budgets per client IP (nil = unlimited);
	// ViewersPerLink / ViewersPerIP cap the live anonymous sockets of a canvas and of a client IP
	// (0 = DefaultViewersPerLink / DefaultViewersPerIP). Billing refuses visits while the
	// workspace is suspended for its billing (nil = never).
	PublicURL                    string
	LinkReadLimit, LinkSyncLimit *redisx.RateLimiter
	ViewersPerLink, ViewersPerIP int
	Billing                      BillingGate

	// Files stores the pictures pasted or dropped on a canvas (files.go); nil = no upload route.
	Files *files.Service

	// Plans caps the live canvases of a workspace (KindCanvases: create and restore; ADR-0126
	// addendum 2026-10-23); nil = no plan limit.
	Plans *plans.Service

	sync *ysync.Hub
}

// BillingGate is what the public link needs of plans.Service: whether a workspace is open.
type BillingGate interface {
	CheckBillingOpen(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error
}

// New creates the service. Call EnableSync before Routes to serve the sync socket.
func New(d *db.DB, ev events.Publisher) *Service {
	if ev == nil {
		ev = events.Nop{}
	}
	return &Service{db: d, ev: ev, Now: time.Now}
}

// EnableSync turns the sync socket on: rc relays the frames between instances (channel
// canvas:<id>), a authenticates the socket's first frame like the gateway's IDENTIFY, origin
// decides the WebSocket upgrade (gateway.OriginAllowed with the web client's origins). A zero
// cfg.AwarenessPerSecond is AwarenessPerSecond.
func (s *Service) EnableSync(rc rueidis.Client, a ysync.Authenticator, origin func(origin string, hasCookie bool) bool, cfg ysync.Config) {
	if cfg.AwarenessPerSecond == 0 {
		cfg.AwarenessPerSecond = AwarenessPerSecond
	}
	s.sync = ysync.NewHub(canvasBackend{s: s, auth: a}, ysync.Options{DB: s.db, Redis: rc, Auth: a, Origin: origin, Config: cfg})
}

// AwarenessPerSecond is the Canvas's awareness budget per socket: the client sends its cursor and
// selection at most every 50 ms (lib/canvasSync.ts CANVAS_AWARENESS_MIN_GAP_MS); the Wiki keeps
// ysync's 10.
const AwarenessPerSecond = 20

// Routes registers the routes; wrap applies auth + the permission resolver. The sync socket
// (in-band auth) is registered without it.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/workspaces/{id}/canvas/items", s.list)
	h("POST /api/workspaces/{id}/canvas/items", s.create)
	h("POST /api/workspaces/{id}/canvas/trash/empty", s.emptyTrash)
	h("GET /api/workspaces/{id}/canvas/activity", s.workspaceActivity)
	h("GET /api/workspaces/{id}/canvas/settings", s.settings)
	h("PUT /api/workspaces/{id}/canvas/settings", s.setSettings)
	h("GET /api/canvas/items/{id}", s.get)
	h("PATCH /api/canvas/items/{id}", s.update)
	h("DELETE /api/canvas/items/{id}", s.deleteForever)
	h("POST /api/canvas/items/{id}/trash", s.trash)
	h("POST /api/canvas/items/{id}/restore", s.restore)
	h("GET /api/canvas/items/{id}/path", s.path)
	h("GET /api/canvas/items/{id}/activity", s.itemActivity)
	h("GET /api/canvas/items/{id}/permissions", s.getPermissions)
	h("PUT /api/canvas/items/{id}/permissions", s.setPermissions)
	h("POST /api/canvas/items/{id}/take-over", s.takeOver)
	h("GET /api/canvas/items/{id}/versions", s.versions)
	h("GET /api/canvas/items/{id}/versions/{vid}", s.version)
	h("GET /api/canvas/items/{id}/comments", s.listComments)
	h("POST /api/canvas/items/{id}/comments", s.createComment)
	h("GET /api/canvas/items/{id}/comments/mention-access", s.mentionAccess)
	h("PATCH /api/canvas/comments/{id}", s.updateComment)
	h("DELETE /api/canvas/comments/{id}", s.deleteComment)
	h("GET /api/canvas/items/{id}/link", s.getLink)
	h("POST /api/canvas/items/{id}/link", s.createLink)
	h("DELETE /api/canvas/items/{id}/link", s.deleteLink)
	h("POST /api/canvas/items/{id}/files", s.upload)
	// Anonymous: the code is the credential (link.go).
	mux.Handle("GET /api/public/canvas/{code}", httpx.HandlerFunc(s.publicCanvas))
	if s.sync != nil {
		mux.Handle("GET /api/canvas/items/{id}/sync", http.HandlerFunc(s.sync.Serve))
		mux.Handle("GET /api/public/canvas/{code}/sync", httpx.HandlerFunc(s.publicSync))
	}
}

// ---- callers and access ----

// caller is the requester as a member of the item's workspace.
type caller struct {
	uid uuid.UUID
	m   perm.Member
}

func (c caller) owns(p sqlc.CanvasItemHead) bool { return p.OwnerID != nil && *p.OwnerID == c.uid }

// wsBits are the caller's workspace-level canvas bits (perm.CanvasOf).
func (c caller) wsBits() perm.Bits {
	return perm.CanvasOf(c.m.Raw(), c.m.Role == perm.RoleGuest)
}

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
	item  sqlc.CanvasItemHead
	c     caller
	bits  perm.Bits
	chain *canvasacl.Chains
}

func (a access) manage() bool { return a.bits.Has(perm.CanvasManage) }

// structure: rename, move, trash, restore, delete, access (ADR-0126 §2).
func (a access) structure() bool { return perm.CanvasStructureAllowed(a.bits, a.c.owns(a.item)) }

func (a access) nodes() []perm.TreeNode { return a.chain.Nodes(a.item.ID) }

var (
	errNoItem       = httpx.NotFound("item")
	errTrashed      = httpx.Conflict("the item is in the trash")
	errNotStructure = httpx.Forbidden("only the owner of the item or CANVAS_MANAGE may change it")
	errNotFolder    = httpx.Conflict("only a folder holds items")
)

// resolve loads item id with its chain through q and the caller's bits on it: 404 when it does
// not exist or the caller does not see it.
func resolve(r *http.Request, q *sqlc.Queries, id uuid.UUID) (access, error) {
	ch, err := canvasacl.Load(r.Context(), q, []uuid.UUID{id})
	if err != nil {
		return access{}, err
	}
	if !ch.Has(id) {
		return access{}, errNoItem
	}
	p := ch.Item(id)
	c, err := member(r, p.WorkspaceID)
	if errors.Is(err, errNotMember) {
		return access{}, errNoItem
	}
	if err != nil {
		return access{}, err
	}
	bits := ch.Bits(c.m, &id)
	if !bits.Has(perm.CanvasView) {
		return access{}, errNoItem
	}
	return access{item: p, c: c, bits: bits, chain: ch}, nil
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

// parentBits: the caller's bits on folder parent (nil = the top level) through q, with its
// chains; 404 when it is not an item of ws the caller sees, 409 for a folder in the trash or an
// item that is not a folder.
func parentBits(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID) (perm.Bits, *canvasacl.Chains, error) {
	if parent == nil {
		ch, _ := canvasacl.Load(r.Context(), q, nil)
		return ch.Bits(c.m, nil), ch, nil
	}
	ch, err := canvasacl.Load(r.Context(), q, []uuid.UUID{*parent})
	if err != nil {
		return 0, nil, err
	}
	if !ch.Has(*parent) {
		return 0, nil, httpx.NotFound("parent folder")
	}
	p := ch.Item(*parent)
	bits := ch.Bits(c.m, parent)
	if p.WorkspaceID != ws || !bits.Has(perm.CanvasView) {
		return 0, nil, httpx.NotFound("parent folder")
	}
	if p.TrashedAt != nil {
		return 0, nil, httpx.Conflict("the parent folder is in the trash")
	}
	if p.Kind != kindFolder {
		return 0, nil, errNotFolder
	}
	return bits, ch, nil
}

// addable checks that the caller may add an item under folder parent: CANVAS_WRITE on it (on the
// section for the top level) and room for one more level. It returns the parent's chains.
func addable(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID) (*canvasacl.Chains, error) {
	bits, ch, err := parentBits(r, q, ws, c, parent)
	if err != nil {
		return nil, err
	}
	if !bits.Has(perm.CanvasWrite) {
		return nil, httpx.Forbidden("CANVAS_WRITE required")
	}
	if depthOf(ch, parent)+1 > MaxDepth {
		return nil, httpx.Conflict("items may be nested at most 32 deep")
	}
	return ch, nil
}

// depthOf is the depth of folder parent (nil = the top level: 0) from its chain.
func depthOf(ch *canvasacl.Chains, parent *uuid.UUID) int {
	if parent == nil {
		return 0
	}
	return len(ch.Path(*parent))
}

// ---- values ----

// cleanName validates a name: trimmed, ≤ 200 characters, no control characters ("" is allowed:
// «Без названия»).
func cleanName(t string) (string, error) {
	t = strings.TrimSpace(t)
	if utf8.RuneCountInString(t) > MaxName {
		return "", httpx.Validation("name", "must be at most 200 characters")
	}
	if strings.ContainsFunc(t, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return "", httpx.Validation("name", "must not contain control characters")
	}
	return t, nil
}

// clip shortens s to at most n characters (meta of a snapshot).
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for k := range s {
		if i == n {
			return s[:k]
		}
		i++
	}
	return s
}

// clipBytes shortens s to at most n bytes at a character boundary.
func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
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
