// Package wiki implements the Wiki of a workspace (ADR-0096): a tree of pages with per-page
// access (perm.ComputeWikiPage over internal/wikiacl chains), the trash with its hourly sweeper,
// public links, the journal (wiki_activity), version history and the collaborative content.
//
// The content of a page is a Yjs document the server never parses: it travels only through the
// sync socket GET /api/wiki/pages/{id}/sync (sync.go, binary frames of ADR-0096 §4, relayed
// between server instances through the Redis channel wiki:<pageId>) and is stored as the last
// snapshot plus the updates after it. Pictures and attachments of a page are ordinary files rows
// (files.UploadWith) referenced from wiki_page_files, in the workspace quota.
//
// Every handler resolves the caller's bits on the page it touches; without WIKI_VIEW the answer
// is 404, as if the page did not exist. WIKI_WRITE on a page edits its content and creates
// subpages; its structure (rename, icon, cover, move, trash, restore, delete forever, access,
// the public link) takes its owner or WIKI_MANAGE (perm.WikiStructureAllowed). After every
// committed structural change WIKI_PAGE_UPSERT / WIKI_PAGE_REMOVE go to the workspace channel
// with the page's access chain, which the gateway uses to deliver them only to members who see
// the page.
package wiki

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
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// MaxDepth is how deep the tree may go (ADR-0096 §1): a top-level page has depth 1.
const MaxDepth = 32

// MaxTitle is the longest title in characters (wiki_pages CHECK).
const MaxTitle = 200

// Limiter is a per-key rate limit (redisx.RateLimiter): Take answers 429 when the budget is out.
type Limiter interface {
	Take(ctx context.Context, key string) error
}

// Service serves the Wiki API and the sync socket.
type Service struct {
	db    *db.DB
	ev    events.Publisher
	files *files.Service
	plans *plans.Service
	// PublicURL is PUBLIC_APP_URL: the page of a public link is PublicURL + "/w/" + code.
	PublicURL string
	// LinkReadLimit: anonymous page metadata and state per client IP; LinkFileLimit: anonymous
	// pictures per client IP. nil = none.
	LinkReadLimit, LinkFileLimit Limiter
	// Now is the clock (tests move it).
	Now func() time.Time

	sync *syncHub
}

// New creates the service; p may be nil (no plan limits). Call EnableSync before Routes to
// serve the sync socket.
func New(d *db.DB, ev events.Publisher, f *files.Service, p *plans.Service) *Service {
	if ev == nil {
		ev = events.Nop{}
	}
	return &Service{db: d, ev: ev, files: f, plans: p, Now: time.Now}
}

// EnableSync turns the sync socket on: rc relays the frames between instances (channel
// wiki:<pageId>), a authenticates the socket's first frame like the gateway's IDENTIFY, origin
// decides the WebSocket upgrade (gateway.OriginAllowed with the web client's origins).
func (s *Service) EnableSync(rc rueidis.Client, a Authenticator, origin func(origin string, hasCookie bool) bool, cfg SyncConfig) {
	s.sync = newSyncHub(s, rc, a, origin, cfg)
}

// Routes registers the routes; wrap applies auth + the permission resolver. The public link
// routes and the sync socket (in-band auth) are registered without it.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/workspaces/{id}/wiki/pages", s.list)
	h("POST /api/workspaces/{id}/wiki/pages", s.create)
	h("POST /api/workspaces/{id}/wiki/trash/empty", s.emptyTrash)
	h("GET /api/workspaces/{id}/wiki/activity", s.workspaceActivity)
	h("GET /api/workspaces/{id}/wiki/settings", s.settings)
	h("PUT /api/workspaces/{id}/wiki/settings", s.setSettings)
	h("GET /api/wiki/pages/{id}", s.get)
	h("PATCH /api/wiki/pages/{id}", s.update)
	h("DELETE /api/wiki/pages/{id}", s.deleteForever)
	h("POST /api/wiki/pages/{id}/trash", s.trash)
	h("POST /api/wiki/pages/{id}/restore", s.restore)
	h("GET /api/wiki/pages/{id}/path", s.path)
	h("GET /api/wiki/pages/{id}/activity", s.pageActivity)
	h("GET /api/wiki/pages/{id}/permissions", s.getPermissions)
	h("PUT /api/wiki/pages/{id}/permissions", s.setPermissions)
	h("POST /api/wiki/pages/{id}/link", s.createLink)
	h("DELETE /api/wiki/pages/{id}/link", s.deleteLink)
	h("GET /api/wiki/pages/{id}/versions", s.versions)
	h("GET /api/wiki/pages/{id}/versions/{vid}", s.version)
	h("POST /api/wiki/pages/{id}/files", s.upload)
	if s.sync != nil {
		mux.Handle("GET /api/wiki/pages/{id}/sync", http.HandlerFunc(s.sync.serve))
	}
	mux.Handle("GET /api/public/wiki/{code}", httpx.HandlerFunc(s.publicPage))
	mux.Handle("GET /api/public/wiki/{code}/state", httpx.HandlerFunc(s.publicState))
	mux.Handle("GET /api/public/wiki/{code}/files/{fileId}", httpx.HandlerFunc(s.publicFile))
}

// ---- callers and access ----

// caller is the requester as a member of the page's workspace.
type caller struct {
	uid uuid.UUID
	m   perm.Member
}

func (c caller) owns(p sqlc.WikiPageHead) bool { return p.OwnerID != nil && *p.OwnerID == c.uid }

// wsBits are the caller's workspace-level wiki bits (perm.WikiOf).
func (c caller) wsBits() perm.Bits {
	return perm.WikiOf(c.m.Raw(), c.m.Role == perm.RoleGuest)
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

// access is the caller's view of one page.
type access struct {
	page  sqlc.WikiPageHead
	c     caller
	bits  perm.Bits
	chain *wikiacl.Chains
}

func (a access) manage() bool { return a.bits.Has(perm.WikiManage) }

// structure: rename, icon, cover, move, trash, restore, delete, access, link (ADR-0096 §2).
func (a access) structure() bool { return perm.WikiStructureAllowed(a.bits, a.c.owns(a.page)) }

func (a access) nodes() []perm.TreeNode { return a.chain.Nodes(a.page.ID) }

var (
	errNoPage       = httpx.NotFound("page")
	errTrashed      = httpx.Conflict("the page is in the trash")
	errNotStructure = httpx.Forbidden("only the owner of the page or WIKI_MANAGE may change it")
)

// resolve loads page id with its chain through q and the caller's bits on it: 404 when it does
// not exist or the caller does not see it.
func resolve(r *http.Request, q *sqlc.Queries, id uuid.UUID) (access, error) {
	ch, err := wikiacl.Load(r.Context(), q, []uuid.UUID{id})
	if err != nil {
		return access{}, err
	}
	if !ch.Has(id) {
		return access{}, errNoPage
	}
	p := ch.Page(id)
	c, err := member(r, p.WorkspaceID)
	if errors.Is(err, errNotMember) {
		return access{}, errNoPage
	}
	if err != nil {
		return access{}, err
	}
	bits := ch.Bits(c.m, &id)
	if !bits.Has(perm.WikiView) {
		return access{}, errNoPage
	}
	return access{page: p, c: c, bits: bits, chain: ch}, nil
}

// pathPage resolves {id} as a page the caller sees.
func (s *Service) pathPage(r *http.Request) (access, error) {
	id, err := httpx.PathUUID(r, "id", "page")
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

// parentBits: the caller's bits on page parent (nil = the top level) through q, with its
// chains; 404 when it is not a page of ws the caller sees, 409 for a page in the trash.
func parentBits(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID) (perm.Bits, *wikiacl.Chains, error) {
	if parent == nil {
		ch, _ := wikiacl.Load(r.Context(), q, nil)
		return ch.Bits(c.m, nil), ch, nil
	}
	ch, err := wikiacl.Load(r.Context(), q, []uuid.UUID{*parent})
	if err != nil {
		return 0, nil, err
	}
	if !ch.Has(*parent) {
		return 0, nil, httpx.NotFound("parent page")
	}
	p := ch.Page(*parent)
	bits := ch.Bits(c.m, parent)
	if p.WorkspaceID != ws || !bits.Has(perm.WikiView) {
		return 0, nil, httpx.NotFound("parent page")
	}
	if p.TrashedAt != nil {
		return 0, nil, httpx.Conflict("the parent page is in the trash")
	}
	return bits, ch, nil
}

// addable checks that the caller may add a page under parent: WIKI_WRITE on it (on the Wiki for
// the top level) and room for one more level. It returns the parent's chains.
func addable(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID) (*wikiacl.Chains, error) {
	bits, ch, err := parentBits(r, q, ws, c, parent)
	if err != nil {
		return nil, err
	}
	if !bits.Has(perm.WikiWrite) {
		return nil, httpx.Forbidden("WIKI_WRITE required")
	}
	if depthOf(ch, parent)+1 > MaxDepth {
		return nil, httpx.Conflict("pages may be nested at most 32 deep")
	}
	return ch, nil
}

// depthOf is the depth of page parent (nil = the top level: 0) from its chain.
func depthOf(ch *wikiacl.Chains, parent *uuid.UUID) int {
	if parent == nil {
		return 0
	}
	return len(ch.Path(*parent))
}

// ---- values ----

// cleanTitle validates a title: trimmed, ≤ 200 characters, no control characters ("" is
// allowed: «Без названия»).
func cleanTitle(t string) (string, error) {
	t = strings.TrimSpace(t)
	if utf8.RuneCountInString(t) > MaxTitle {
		return "", httpx.Validation("title", "must be at most 200 characters")
	}
	if strings.ContainsFunc(t, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return "", httpx.Validation("title", "must not contain control characters")
	}
	return t, nil
}

// cleanIcon validates an icon: one emoji, 1..32 characters without spaces or control
// characters; "" = none (nil).
func cleanIcon(icon string) (*string, error) {
	icon = strings.TrimSpace(icon)
	if icon == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(icon) > 32 || strings.ContainsFunc(icon, func(r rune) bool { return r <= 0x20 || r == 0x7f }) {
		return nil, httpx.Validation("icon", "must be one emoji")
	}
	return &icon, nil
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
