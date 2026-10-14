//go:build integration

package wiki

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/redisx/redistest"
	"github.com/calaba/calaba/server/internal/search"
)

func TestMain(m *testing.M) {
	redisx.SetKeyPrefix(redistest.Prefix())
	os.Exit(dbtest.Run(m))
}

// recorder keeps the published events.
type recorder struct {
	mu  sync.Mutex
	evs []*v1.DispatchEvent
}

func (r *recorder) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) { r.add(ev) }
func (r *recorder) User(context.Context, uuid.UUID, *v1.DispatchEvent)             {}
func (r *recorder) Workspaces(_ context.Context, _ []uuid.UUID, ev *v1.DispatchEvent) {
	r.add(ev)
}
func (r *recorder) WorkspaceEvents(_ context.Context, _ uuid.UUID, evs []*v1.DispatchEvent) {
	for _, ev := range evs {
		r.add(ev)
	}
}
func (r *recorder) SessionRevoked(context.Context, uuid.UUID, string) {}
func (r *recorder) add(ev *v1.DispatchEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, ev)
}
func (r *recorder) take() []*v1.DispatchEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.evs
	r.evs = nil
	return out
}

// fakeAuth: the token is the user id; "bad" is an invalid token.
type fakeAuth struct{}

func (fakeAuth) AuthenticateToken(_ context.Context, tok string) (auth.Identity, error) {
	u, err := uuid.Parse(tok)
	if err != nil {
		return auth.Identity{}, auth.ErrInvalidToken
	}
	return auth.Identity{UserID: u, SessionID: uuid.New()}, nil
}
func (fakeAuth) CheckSession(context.Context, uuid.UUID) error { return nil }
func (fakeAuth) CheckWorkspace(context.Context, auth.Identity, uuid.UUID, identitypolicy.Operation) error {
	return nil
}
func (fakeAuth) WithPolicy(ctx context.Context, _ auth.Identity, _ identitypolicy.Operation) context.Context {
	return ctx
}

// env is one workspace with its people and the service behind a mux (and an HTTP server for
// the sync socket).
type env struct {
	t     *testing.T
	d     *db.DB
	store blob.Store
	fs    *files.Service
	svc   *Service
	ev    *recorder
	mux   *http.ServeMux
	srv   *httptest.Server
	rc    rueidis.Client
	ws    uuid.UUID
	// owner (workspace owner), admin, alice / bob (members), guest, outsider (no member)
	owner, admin, alice, bob, guest, outsider uuid.UUID
}

func newEnv(t *testing.T, cfg SyncConfig) *env {
	t.Helper()
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	e := &env{t: t, d: d, store: store, ev: &recorder{}, mux: http.NewServeMux(), rc: rc}
	e.fs = files.NewService(d, store, e.ev, 10<<20, 0)
	e.svc = New(d, e.ev, e.fs, nil)
	e.svc.PublicURL = "https://app.test"
	e.svc.EnableSync(rc, fakeAuth{}, nil, cfg)
	wrap := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, err := uuid.Parse(r.Header.Get("X-Test-User"))
			if err != nil {
				http.Error(w, "no user", http.StatusUnauthorized)
				return
			}
			c := auth.WithIdentity(r.Context(), auth.Identity{UserID: u, SessionID: uuid.New()})
			h.ServeHTTP(w, r.WithContext(perm.WithResolver(c, d.Q)))
		})
	}
	e.svc.Routes(e.mux, wrap)
	search.New(d).Routes(e.mux, wrap)
	e.mux.Handle("GET /api/files/{id}", wrap(httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		f, err := d.Q.GetFile(r.Context(), uuid.MustParse(r.PathValue("id")))
		if err != nil {
			return httpx.NotFound("file")
		}
		ok, err := e.fs.CanRead(r, f)
		if err != nil {
			return err
		}
		if !ok {
			return httpx.NotFound("file")
		}
		w.WriteHeader(http.StatusOK)
		return nil
	})))
	e.srv = httptest.NewServer(e.mux)
	t.Cleanup(e.srv.Close)
	user := func(name string, guest bool) uuid.UUID {
		id := uuid.New()
		email := any(name + "-" + id.String()[:8] + "@wiki.test")
		if guest {
			email = nil
		}
		if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name, is_guest) VALUES ($1, $2, $3, $4)`, id, email, name, guest); err != nil {
			t.Fatal(err)
		}
		return id
	}
	e.owner, e.admin, e.alice, e.bob, e.guest, e.outsider = user("Owner", false), user("Admin", false), user("Alice", false),
		user("Bob", false), user("Guest", true), user("Outsider", false)
	e.ws = uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Wiki', $3)`, e.ws, "wk-"+e.ws.String()[:12], e.owner); err != nil {
		t.Fatal(err)
	}
	for u, role := range map[uuid.UUID]string{e.owner: "owner", e.admin: "admin", e.alice: "member", e.bob: "member", e.guest: "guest"} {
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

// call makes a request as user (uuid.Nil = anonymous); body is a proto (JSON) or raw bytes.
func (e *env) call(user uuid.UUID, method, path string, body any, hdr map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case proto.Message:
		raw, err := protojson.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	case []byte:
		rd = bytes.NewReader(b)
	}
	r := httptest.NewRequestWithContext(context.Background(), method, path, rd)
	if user != uuid.Nil {
		r.Header.Set("X-Test-User", user.String())
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w
}

// must asserts the status and decodes the JSON answer into out (nil = ignore).
func (e *env) must(want int, user uuid.UUID, method, path string, body any, out proto.Message) {
	e.t.Helper()
	w := e.call(user, method, path, body, nil)
	if w.Code != want {
		e.t.Fatalf("%s %s: %d %s, want %d", method, path, w.Code, w.Body.String(), want)
	}
	if out != nil {
		if err := protojson.Unmarshal(w.Body.Bytes(), out); err != nil {
			e.t.Fatalf("%s %s: decode %v: %s", method, path, err, w.Body.String())
		}
	}
}

func page(id string) string { return "/api/wiki/pages/" + id }

func (e *env) create(user uuid.UUID, parent, title string) *v1.WikiPage {
	e.t.Helper()
	var out v1.WikiPageResponse
	e.must(201, user, "POST", "/api/workspaces/"+e.ws.String()+"/wiki/pages", &v1.CreateWikiPageRequest{ParentId: parent, Title: title}, &out)
	return out.GetPage()
}

func (e *env) titles(user uuid.UUID, query string) []string {
	e.t.Helper()
	var out v1.ListWikiPagesResponse
	e.must(200, user, "GET", "/api/workspaces/"+e.ws.String()+"/wiki/pages?"+query, nil, &out)
	var t []string
	for _, p := range out.GetPages() {
		t = append(t, p.GetTitle())
	}
	return t
}

func (e *env) uploadAs(user uuid.UUID, pageID, name string, size int) *httptest.ResponseRecorder {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		e.t.Fatal(err)
	}
	_, _ = fw.Write(bytes.Repeat([]byte("x"), size))
	_ = mw.Close()
	return e.call(user, "POST", page(pageID)+"/files", buf.Bytes(), map[string]string{"Content-Type": mw.FormDataContentType()})
}

func (e *env) upload(user uuid.UUID, pageID, name string, size int) *v1.FileMeta {
	e.t.Helper()
	w := e.uploadAs(user, pageID, name, size)
	if w.Code != 201 {
		e.t.Fatalf("upload %s: %d %s", name, w.Code, w.Body.String())
	}
	var out v1.UploadFileResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil {
		e.t.Fatal(err)
	}
	return out.GetFile()
}

func (e *env) used() int64 {
	e.t.Helper()
	w, err := e.d.Q.GetWorkspace(context.Background(), e.ws)
	if err != nil {
		e.t.Fatal(err)
	}
	return w.StorageUsedBytes
}

const (
	user = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	role = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
)

// ADR-0096 §2: members see and write every page that is not restricted, guests and outsiders
// nothing; WIKI_WRITE edits content and adds subpages, the structure takes the owner or
// WIKI_MANAGE; restricted + overrides; 404 for what one does not see, 403 for what one sees but
// may not do.
func TestWikiPermissionsMatrix(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	guide := e.create(e.alice, "", "Guide")
	if guide.GetMyBits() != uint64(perm.WikiView|perm.WikiWrite) || guide.GetOwnerId() != e.alice.String() {
		t.Fatalf("create answer: %v", guide)
	}
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetWikiPageUpsert().GetPage().GetId() != guide.GetId() || len(evs[0].GetWikiPageUpsert().GetAccess()) != 1 {
		t.Fatalf("create events: %v", evs)
	}
	// Members see it; the guest and outsiders do not.
	if got := e.titles(e.bob, ""); len(got) != 1 {
		t.Fatalf("bob sees %v", got)
	}
	if got := e.titles(e.guest, ""); len(got) != 0 {
		t.Fatalf("the guest sees %v", got)
	}
	e.must(404, e.guest, "GET", page(guide.GetId()), nil, nil)
	e.must(404, e.outsider, "GET", page(guide.GetId()), nil, nil)
	e.must(404, e.outsider, "GET", "/api/workspaces/"+e.ws.String()+"/wiki/pages", nil, nil)
	e.must(403, e.guest, "POST", "/api/workspaces/"+e.ws.String()+"/wiki/pages", &v1.CreateWikiPageRequest{Title: "x"}, nil)
	// WIKI_WRITE: bob adds a subpage (he owns it) but may not change alice's page.
	sub := e.create(e.bob, guide.GetId(), "Bob's notes")
	var full v1.WikiPageResponse
	e.must(200, e.bob, "GET", page(guide.GetId()), nil, &full)
	if !full.GetPage().GetHasChildren() {
		t.Fatal("has_children not set")
	}
	e.must(403, e.bob, "PATCH", page(guide.GetId()), &v1.UpdateWikiPageRequest{Title: proto.String("Mine")}, nil)
	e.must(403, e.bob, "POST", page(guide.GetId())+"/trash", nil, nil)
	e.must(403, e.bob, "GET", page(guide.GetId())+"/permissions", nil, nil)
	e.must(403, e.bob, "POST", page(guide.GetId())+"/link", &v1.CreateWikiLinkRequest{}, nil)
	e.must(200, e.bob, "PATCH", page(sub.GetId()), &v1.UpdateWikiPageRequest{Title: proto.String("Bob's"), Icon: proto.String("📒")}, nil)
	e.must(200, e.admin, "PATCH", page(guide.GetId()), &v1.UpdateWikiPageRequest{Title: proto.String("Guide v2")}, nil)
	e.must(422, e.alice, "PATCH", page(guide.GetId()), &v1.UpdateWikiPageRequest{Icon: proto.String("not an emoji at all because it is long")}, nil)
	// Restricted, shared with the guest by name: bob loses the page and its subtree (his own
	// subpage stays his: the owner always sees his pages).
	var perms v1.WikiPermissionsResponse
	e.must(200, e.alice, "PUT", page(guide.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.WikiPermissionEntry{{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.WikiView)}}}, &perms)
	if !perms.GetRestricted() || len(perms.GetEntries()) != 1 {
		t.Fatalf("permissions: %v", &perms)
	}
	e.must(404, e.bob, "GET", page(guide.GetId()), nil, nil)
	e.must(200, e.bob, "GET", page(sub.GetId()), nil, nil)
	e.must(200, e.guest, "GET", page(guide.GetId()), nil, nil)
	e.must(403, e.guest, "POST", "/api/workspaces/"+e.ws.String()+"/wiki/pages", &v1.CreateWikiPageRequest{ParentId: guide.GetId(), Title: "g"}, nil)
	e.must(200, e.admin, "GET", page(guide.GetId()), nil, nil)
	// The event of the change: bob saw it before (access_before), the guest after.
	var upsert *v1.WikiPageUpsert
	for _, ev := range e.ev.take() {
		if u := ev.GetWikiPageUpsert(); u != nil && u.GetPage().GetId() == guide.GetId() {
			upsert = u
		}
	}
	if upsert == nil || len(upsert.GetAccessBefore()) == 0 || !upsert.GetAccess()[0].GetRestricted() {
		t.Fatalf("permissions event: %v", upsert)
	}
	// A personal VIEW | WRITE gives bob the page back with writing; a deny of WRITE takes it.
	e.must(200, e.alice, "PUT", page(guide.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.WikiView | perm.WikiWrite)}}}, nil)
	e.create(e.bob, guide.GetId(), "Allowed")
	e.must(200, e.alice, "PUT", page(guide.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.WikiView), Deny: uint64(perm.WikiWrite)}}}, nil)
	e.must(403, e.bob, "POST", "/api/workspaces/"+e.ws.String()+"/wiki/pages", &v1.CreateWikiPageRequest{ParentId: guide.GetId(), Title: "x"}, nil)
	// Validation: the guest role, foreign bits, non-members.
	var guestRole uuid.UUID
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'guest'`, e.ws).Scan(&guestRole); err != nil {
		t.Fatal(err)
	}
	e.must(422, e.alice, "PUT", page(guide.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: role, TargetId: guestRole.String(), Allow: uint64(perm.WikiView)}}}, nil)
	e.must(422, e.alice, "PUT", page(guide.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.WikiManage)}}}, nil)
	e.must(422, e.alice, "PUT", page(guide.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.outsider.String(), Allow: uint64(perm.WikiView)}}}, nil)
	// The journal: create, rename, share…
	var act v1.WikiActivityPage
	e.must(200, e.alice, "GET", page(guide.GetId())+"/activity", nil, &act)
	kinds := map[v1.WikiActivityKind]int{}
	for _, a := range act.GetActivities() {
		kinds[a.GetKind()]++
	}
	if kinds[v1.WikiActivityKind_WIKI_ACTIVITY_KIND_CREATE] != 1 || kinds[v1.WikiActivityKind_WIKI_ACTIVITY_KIND_RENAME] != 1 ||
		kinds[v1.WikiActivityKind_WIKI_ACTIVITY_KIND_SHARE] != 3 {
		t.Fatalf("journal: %v", kinds)
	}
	e.must(403, e.bob, "GET", "/api/workspaces/"+e.ws.String()+"/wiki/activity", nil, nil)
	e.must(200, e.admin, "GET", "/api/workspaces/"+e.ws.String()+"/wiki/activity", nil, nil)
	// Settings: everyone reads, WIKI_MANAGE writes.
	e.must(403, e.bob, "PUT", "/api/workspaces/"+e.ws.String()+"/wiki/settings", &v1.WikiSettings{TrashDays: 30}, nil)
	e.must(200, e.admin, "PUT", "/api/workspaces/"+e.ws.String()+"/wiki/settings", &v1.WikiSettings{TrashDays: 30}, nil)
	var set v1.WikiSettings
	e.must(200, e.bob, "GET", "/api/workspaces/"+e.ws.String()+"/wiki/settings", nil, &set)
	if set.GetTrashDays() != 30 {
		t.Fatalf("settings: %v", &set)
	}
}

// Moves: order among siblings, under another page, no cycles, the path.
func TestWikiMoveAndOrder(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	a, b, c := e.create(e.alice, "", "A"), e.create(e.alice, "", "B"), e.create(e.alice, "", "C")
	order := func(want string, query string) {
		t.Helper()
		if got := strings.Join(e.titles(e.alice, query), ","); got != want {
			t.Fatalf("order %q, want %q", got, want)
		}
	}
	order("A,B,C", "")
	e.must(200, e.alice, "PATCH", page(c.GetId()), &v1.UpdateWikiPageRequest{Position: proto.Int32(0)}, nil)
	order("C,A,B", "")
	e.must(200, e.alice, "PATCH", page(c.GetId()), &v1.UpdateWikiPageRequest{Position: proto.Int32(2)}, nil)
	order("A,B,C", "")
	e.must(200, e.alice, "PATCH", page(a.GetId()), &v1.UpdateWikiPageRequest{Position: proto.Int32(1)}, nil)
	order("B,A,C", "")
	// A under C, then C under A is a cycle.
	e.must(200, e.alice, "PATCH", page(a.GetId()), &v1.UpdateWikiPageRequest{ParentId: proto.String(c.GetId())}, nil)
	order("B,C", "")
	order("A", "parent="+c.GetId())
	e.must(409, e.alice, "PATCH", page(c.GetId()), &v1.UpdateWikiPageRequest{ParentId: proto.String(a.GetId())}, nil)
	e.must(409, e.alice, "PATCH", page(c.GetId()), &v1.UpdateWikiPageRequest{ParentId: proto.String(c.GetId())}, nil)
	// B under C at the front.
	e.must(200, e.alice, "PATCH", page(b.GetId()), &v1.UpdateWikiPageRequest{ParentId: proto.String(c.GetId()), Position: proto.Int32(0)}, nil)
	order("B,A", "parent="+c.GetId())
	var path v1.WikiPathResponse
	e.must(200, e.alice, "GET", page(a.GetId())+"/path", nil, &path)
	if len(path.GetPages()) != 2 || path.GetPages()[0].GetId() != c.GetId() {
		t.Fatalf("path: %v", &path)
	}
	// Moving someone else's page: bob may not; under a page he cannot write: 403.
	e.must(403, e.bob, "PATCH", page(a.GetId()), &v1.UpdateWikiPageRequest{ParentId: proto.String("")}, nil)
	mine := e.create(e.bob, "", "Bob")
	e.must(200, e.alice, "PUT", page(c.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.WikiWrite)}}}, nil)
	e.must(403, e.bob, "PATCH", page(mine.GetId()), &v1.UpdateWikiPageRequest{ParentId: proto.String(c.GetId())}, nil)
	// Depth: a chain of 32 is the limit.
	parent := ""
	for i := 0; i < MaxDepth; i++ {
		parent = e.create(e.alice, parent, "d").GetId()
	}
	e.must(409, e.alice, "POST", "/api/workspaces/"+e.ws.String()+"/wiki/pages", &v1.CreateWikiPageRequest{ParentId: parent, Title: "too deep"}, nil)
}

// Trash, restore and delete forever with the quota of the pages' files (ADR-0096 §1: in the
// workspace quota, released once on delete, in the Disk's order).
func TestWikiTrashRestoreDelete(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	ctx := context.Background()
	root := e.create(e.alice, "", "Root")
	child := e.create(e.alice, root.GetId(), "Child")
	base := e.used()
	pic := e.upload(e.alice, root.GetId(), "a.png", 100)
	att := e.upload(e.bob, child.GetId(), "b.txt", 50) // WIKI_WRITE uploads to any page
	if e.used() != base+150 {
		t.Fatalf("used %d, want %d", e.used(), base+150)
	}
	if w := e.uploadAs(e.guest, root.GetId(), "g.txt", 5); w.Code != 404 {
		t.Fatalf("guest upload: %d", w.Code)
	}
	e.must(200, e.alice, "PATCH", page(root.GetId()), &v1.UpdateWikiPageRequest{CoverFileId: proto.String(pic.GetId())}, nil)
	e.must(422, e.alice, "PATCH", page(root.GetId()), &v1.UpdateWikiPageRequest{CoverFileId: proto.String(att.GetId())}, nil)
	e.must(200, e.bob, "GET", "/api/files/"+att.GetId(), nil, nil)
	e.must(404, e.guest, "GET", "/api/files/"+att.GetId(), nil, nil)
	var got v1.WikiPageResponse
	e.must(200, e.bob, "GET", page(root.GetId()), nil, &got)
	if got.GetPage().GetCover().GetId() != pic.GetId() {
		t.Fatalf("cover: %v", got.GetPage())
	}
	// Trash: the subtree goes, the trash lists the root only.
	e.must(409, e.alice, "DELETE", page(root.GetId()), nil, nil)
	e.must(200, e.alice, "POST", page(root.GetId())+"/trash", nil, nil)
	if got := e.titles(e.alice, ""); len(got) != 0 {
		t.Fatalf("live after trash: %v", got)
	}
	if got := e.titles(e.alice, "trashed=1"); strings.Join(got, ",") != "Root" {
		t.Fatalf("trash: %v", got)
	}
	e.must(409, e.alice, "POST", page(child.GetId())+"/restore", nil, nil)
	e.must(200, e.alice, "POST", page(root.GetId())+"/restore", nil, nil)
	if got := e.titles(e.alice, "parent="+root.GetId()); strings.Join(got, ",") != "Child" {
		t.Fatalf("restored subtree: %v", got)
	}
	// Delete forever: the files rows go with their quota, the blobs after commit.
	e.must(200, e.alice, "POST", page(root.GetId())+"/trash", nil, nil)
	e.ev.take()
	e.must(204, e.alice, "DELETE", page(root.GetId()), nil, nil)
	if e.used() != base {
		t.Fatalf("used after delete %d, want %d", e.used(), base)
	}
	for _, f := range []*v1.FileMeta{pic, att} {
		if _, err := e.d.Q.GetFile(ctx, uuid.MustParse(f.GetId())); !db.IsNotFound(err) {
			t.Fatalf("file %s left: %v", f.GetId(), err)
		}
	}
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetWikiPageRemove().GetPageId() != root.GetId() {
		t.Fatalf("delete events: %v", evs)
	}
	e.must(404, e.alice, "GET", page(child.GetId()), nil, nil)
	// Empty trash: only what the caller may delete (bob: his own).
	mine, theirs := e.create(e.bob, "", "Mine"), e.create(e.alice, "", "Theirs")
	e.upload(e.bob, mine.GetId(), "m.txt", 30)
	e.must(200, e.bob, "POST", page(mine.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "POST", page(theirs.GetId())+"/trash", nil, nil)
	var empty v1.EmptyWikiTrashResponse
	e.must(200, e.bob, "POST", "/api/workspaces/"+e.ws.String()+"/wiki/trash/empty", nil, &empty)
	if empty.GetDeleted() != 1 || empty.GetFreedBytes() != 30 {
		t.Fatalf("empty trash: %v", &empty)
	}
	// The sweeper: retention 1 day, a root trashed two days ago goes.
	e.must(200, e.admin, "PUT", "/api/workspaces/"+e.ws.String()+"/wiki/settings", &v1.WikiSettings{TrashDays: 1}, nil)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE wiki_pages SET trashed_at = now() - interval '2 days' WHERE id = $1`, theirs.GetId()); err != nil {
		t.Fatal(err)
	}
	if n, err := e.svc.TrashSweep(ctx); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	e.must(404, e.alice, "GET", page(theirs.GetId()), nil, nil)
}

// Public links (ADR-0096 §6): the page, include_children with restricted branches excluded, the
// state stream, pictures of the branch only, revoked / trashed → 404.
func TestWikiPublicLinks(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	root := e.create(e.alice, "", "Handbook")
	child := e.create(e.alice, root.GetId(), "Open")
	secret := e.create(e.alice, root.GetId(), "Secret")
	below := e.create(e.alice, secret.GetId(), "Below secret")
	e.must(200, e.alice, "PATCH", page(secret.GetId()), &v1.UpdateWikiPageRequest{Restricted: proto.Bool(true)}, nil)
	pic := e.upload(e.alice, child.GetId(), "p.png", 10)
	hidden := e.upload(e.alice, below.GetId(), "h.png", 10)
	var link v1.WikiLinkResponse
	e.must(201, e.alice, "POST", page(root.GetId())+"/link", &v1.CreateWikiLinkRequest{}, &link)
	code := link.GetLink().GetCode()
	if !strings.HasSuffix(link.GetUrl(), "/w/"+code) {
		t.Fatalf("url %q", link.GetUrl())
	}
	pub := "/api/public/wiki/" + code
	w := e.call(uuid.Nil, "GET", pub, nil, nil)
	if w.Code != 200 || w.Header().Get("X-Robots-Tag") == "" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("public page: %d %v", w.Code, w.Header())
	}
	var pp v1.PublicWikiPage
	_ = protojson.Unmarshal(w.Body.Bytes(), &pp)
	if pp.GetTitle() != "Handbook" || len(pp.GetChildren()) != 0 {
		t.Fatalf("public page: %v", &pp)
	}
	if w := e.call(uuid.Nil, "GET", pub+"?page="+child.GetId(), nil, nil); w.Code != 404 {
		t.Fatalf("child without include_children: %d", w.Code)
	}
	if w := e.call(uuid.Nil, "GET", pub+"/files/"+pic.GetId(), nil, nil); w.Code != 404 {
		t.Fatalf("child's picture without include_children: %d", w.Code)
	}
	// include_children: the open branch only; the code stays.
	e.must(200, e.alice, "POST", page(root.GetId())+"/link", &v1.CreateWikiLinkRequest{IncludeChildren: true}, &link)
	if link.GetLink().GetCode() != code {
		t.Fatal("the code changed")
	}
	w = e.call(uuid.Nil, "GET", pub, nil, nil)
	_ = protojson.Unmarshal(w.Body.Bytes(), &pp)
	if len(pp.GetChildren()) != 1 || pp.GetChildren()[0].GetId() != child.GetId() {
		t.Fatalf("outline: %v", pp.GetChildren())
	}
	if w := e.call(uuid.Nil, "GET", pub+"?page="+child.GetId(), nil, nil); w.Code != 200 {
		t.Fatalf("child: %d", w.Code)
	}
	for _, p := range []string{secret.GetId(), below.GetId()} {
		if w := e.call(uuid.Nil, "GET", pub+"?page="+p, nil, nil); w.Code != 404 {
			t.Fatalf("restricted branch page: %d", w.Code)
		}
		if w := e.call(uuid.Nil, "GET", pub+"/state?page="+p, nil, nil); w.Code != 404 {
			t.Fatalf("restricted branch state: %d", w.Code)
		}
	}
	if w := e.call(uuid.Nil, "GET", pub+"/files/"+pic.GetId(), nil, nil); w.Code != 200 {
		t.Fatalf("branch picture: %d %s", w.Code, w.Body.String())
	}
	if w := e.call(uuid.Nil, "GET", pub+"/files/"+hidden.GetId(), nil, nil); w.Code != 404 {
		t.Fatalf("restricted branch picture: %d", w.Code)
	}
	// The state: an empty page is one SNAPSHOT record with the empty document.
	w = e.call(uuid.Nil, "GET", pub+"/state", nil, nil)
	recs := records(t, w.Body.Bytes())
	if w.Code != 200 || len(recs) != 1 || recs[0][0] != frameSnapshot || !bytes.Equal(recs[0][9:], emptyState) {
		t.Fatalf("empty state: %d %x", w.Code, w.Body.Bytes())
	}
	// Revoked → 404; on again, then trashed → 404.
	e.must(204, e.alice, "DELETE", page(root.GetId())+"/link", nil, nil)
	if w := e.call(uuid.Nil, "GET", pub, nil, nil); w.Code != 404 {
		t.Fatalf("revoked: %d", w.Code)
	}
	e.must(201, e.alice, "POST", page(root.GetId())+"/link", &v1.CreateWikiLinkRequest{}, &link)
	pub = "/api/public/wiki/" + link.GetLink().GetCode()
	e.must(200, e.alice, "POST", page(root.GetId())+"/trash", nil, nil)
	if w := e.call(uuid.Nil, "GET", pub, nil, nil); w.Code != 404 {
		t.Fatalf("trashed: %d", w.Code)
	}
}

// records splits a public state body: u32 length + frame, repeated.
func records(t *testing.T, b []byte) [][]byte {
	t.Helper()
	var out [][]byte
	for len(b) > 0 {
		if len(b) < 4 {
			t.Fatalf("truncated record %x", b)
		}
		n := int(binary.BigEndian.Uint32(b))
		if len(b) < 4+n {
			t.Fatalf("truncated record of %d", n)
		}
		out = append(out, b[4:4+n])
		b = b[4+n:]
	}
	return out
}

// ---- the sync socket ----

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

// dial opens the sync socket of a page as user (token = the user id).
func (e *env) dial(u uuid.UUID, pageID string) *client {
	e.t.Helper()
	return e.dialToken(u.String(), pageID)
}

// dialToken opens the sync socket and sends tok as the first (text) frame.
func (e *env) dialToken(tok, pageID string) *client {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + page(pageID) + "/sync"
	ws, resp, err := websocket.Dial(ctx, url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		e.t.Fatal(err)
	}
	ws.SetReadLimit(8 << 20)
	e.t.Cleanup(func() { _ = ws.CloseNow() })
	if err := ws.Write(ctx, websocket.MessageText, []byte(tok)); err != nil {
		e.t.Fatal(err)
	}
	return &client{t: e.t, ws: ws}
}

func (c *client) send(f []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageBinary, f); err != nil {
		c.t.Fatal(err)
	}
}

// read returns the next frame (nil and the close status when the socket closed).
func (c *client) read() ([]byte, websocket.StatusCode) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Logf("socket closed: %v", err)
		return nil, websocket.CloseStatus(err)
	}
	return b, -1
}

func (c *client) next(want byte) []byte {
	c.t.Helper()
	f, code := c.read()
	if f == nil {
		c.t.Fatalf("closed %d waiting for frame %d", code, want)
	}
	if f[0] != want {
		c.t.Fatalf("frame %d (%x), want %d", f[0], f[:min(len(f), 16)], want)
	}
	return f
}

// closed expects the socket to close with code (frames before it are skipped).
func (c *client) closed(code websocket.StatusCode) {
	c.t.Helper()
	for i := 0; i < 1000; i++ {
		f, got := c.read()
		if f == nil {
			if got != code {
				c.t.Fatalf("closed with %d, want %d", got, code)
			}
			return
		}
	}
	c.t.Fatal("not closed")
}

// quiet asserts nothing came before a probe: from sends an awareness frame and it must be
// the next frame c gets (a read with a short deadline would close the socket).
func (c *client) quiet(from *client) {
	c.t.Helper()
	from.send([]byte{frameAwareness, 0xEE})
	if f := c.next(frameAwareness); !bytes.Equal(f, []byte{frameAwareness, 0xEE}) {
		c.t.Fatalf("unexpected awareness %x", f)
	}
}

func post(through int64, meta snapshotMeta, state []byte) []byte {
	m, _ := json.Marshal(meta)
	out := make([]byte, headerPost+len(m)+len(state))
	out[0] = frameSnapshotPost
	binary.BigEndian.PutUint64(out[1:9], uint64(through)) //nolint:gosec // test values
	binary.BigEndian.PutUint32(out[9:13], uint32(len(m))) //nolint:gosec // test values
	copy(out[13:], m)
	copy(out[13+len(m):], state)
	return out
}

// Two writers exchange updates: each gets its own back with the server's seq and the other's,
// seqs increase; a reconnecting reader gets the snapshot and every update.
func TestWikiSyncExchange(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	p := e.create(e.alice, "", "Live")
	a, b := e.dial(e.alice, p.GetId()), e.dial(e.bob, p.GetId())
	for _, c := range []*client{a, b} {
		f := c.next(frameSnapshot)
		if frameSeq(f) != 0 || !bytes.Equal(f[9:], emptyState) {
			t.Fatalf("first snapshot %x", f)
		}
	}
	a.send(updateFrame(0, []byte("a1")))
	for _, c := range []*client{a, b} {
		f := c.next(frameUpdate)
		if frameSeq(f) != 1 || string(f[9:]) != "a1" {
			t.Fatalf("update %x", f)
		}
	}
	b.send(updateFrame(0, []byte("b1")))
	a.send(updateFrame(0, []byte("a2")))
	for _, c := range []*client{a, b} {
		seen := map[string]int64{}
		for i := 0; i < 2; i++ {
			f := c.next(frameUpdate)
			seen[string(f[9:])] = frameSeq(f)
		}
		if seen["b1"] == 0 || seen["a2"] == 0 || seen["b1"] == seen["a2"] || seen["b1"] < 2 || seen["a2"] < 2 {
			t.Fatalf("seqs %v", seen)
		}
	}
	// A late reader gets the snapshot and the three updates.
	c := e.dial(e.bob, p.GetId())
	c.next(frameSnapshot)
	for want := int64(1); want <= 3; want++ {
		if f := c.next(frameUpdate); frameSeq(f) != want {
			t.Fatalf("catch-up seq %d, want %d", frameSeq(f), want)
		}
	}
	// Awareness is relayed to the others, never echoed or stored.
	a.send([]byte{frameAwareness, 7, 7})
	if f := b.next(frameAwareness); !bytes.Equal(f, []byte{frameAwareness, 7, 7}) {
		t.Fatalf("awareness %x", f)
	}
	c.next(frameAwareness)
	a.quiet(b)
	var n int
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM wiki_page_updates WHERE page_id = $1`, p.GetId()).Scan(&n); err != nil || n != 3 {
		t.Fatalf("stored updates %d %v", n, err)
	}
	// Bad token, no access, unknown page.
	e.dialToken("bad", p.GetId()).closed(closeAuth)
	nobody := e.dial(e.outsider, p.GetId())
	nobody.closed(closeForbidden)
	gone := e.dial(e.alice, uuid.NewString())
	gone.closed(closeNotFound)
	// Trashing the page closes its sockets.
	e.must(200, e.alice, "POST", page(p.GetId())+"/trash", nil, nil)
	b.closed(closeNotFound)
}

// A read-only member receives but may not send; over 20 updates a second closes 4008.
func TestWikiSyncLimits(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	p := e.create(e.alice, "", "Limits")
	e.must(200, e.alice, "PUT", page(p.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.WikiWrite)}}}, nil)
	ro := e.dial(e.bob, p.GetId())
	ro.next(frameSnapshot)
	ro.send([]byte{frameAwareness, 1}) // dropped, not an error
	ro.send(updateFrame(0, []byte("nope")))
	ro.closed(closeForbidden)
	ro2 := e.dial(e.bob, p.GetId())
	ro2.next(frameSnapshot)
	ro2.send(post(0, snapshotMeta{}, []byte{1}))
	ro2.closed(closeForbidden)
	// Flood.
	w := e.dial(e.alice, p.GetId())
	w.next(frameSnapshot)
	for i := 0; i < 40; i++ {
		if err := w.ws.Write(context.Background(), websocket.MessageBinary, updateFrame(0, []byte{byte(i)})); err != nil {
			break
		}
	}
	w.closed(closeRate)
	// Snapshots: 2 at once, then one per 2 s.
	sp := e.dial(e.alice, p.GetId())
	sp.next(frameSnapshot)
	for i := 0; i < 3; i++ {
		if err := sp.ws.Write(context.Background(), websocket.MessageBinary, post(0, snapshotMeta{}, []byte{0, 0})); err != nil {
			break
		}
	}
	sp.closed(closeRate)
	// An update over 64 KiB.
	big := e.dial(e.alice, p.GetId())
	big.next(frameSnapshot)
	big.send(updateFrame(0, make([]byte, MaxUpdate+1)))
	big.closed(closeBadFrame)
	// Ten sockets per person per page.
	var cs []*client
	for i := 0; i < 10; i++ {
		c := e.dial(e.alice, p.GetId())
		c.next(frameSnapshot)
		cs = append(cs, c)
	}
	e.dial(e.alice, p.GetId()).closed(closeRate)
	for _, c := range cs {
		_ = c.ws.Close(websocket.StatusNormalClosure, "")
	}
}

// COMPACT_REQUEST past the threshold; SNAPSHOT_POST compacts, updates the text and writes a
// version; a stale snapshot is ignored; the public state stream is snapshot + later updates.
func TestWikiSyncCompaction(t *testing.T) {
	e := newEnv(t, SyncConfig{CompactUpdates: 3, CompactCheckEvery: -1, VersionEvery: time.Millisecond, SnapshotEvery: time.Microsecond})
	// Four snapshots in a row against a burst of 2: with 1 ms per token the test needs 2 ms of wall
	// time between them, which a loaded machine sometimes does not give (4008 rate limited).
	ctx := context.Background()
	p := e.create(e.alice, "", "Notes")
	a, b := e.dial(e.alice, p.GetId()), e.dial(e.bob, p.GetId())
	a.next(frameSnapshot)
	b.next(frameSnapshot)
	for i := 1; i <= 4; i++ {
		a.send(updateFrame(0, []byte{'u', byte(i)}))
		a.next(frameUpdate)
		b.next(frameUpdate)
	}
	a.next(frameCompact) // after the 4th (> 3)
	b.quiet(a)           // only the writer that crossed it is asked
	// The snapshot through 4, a silent compaction (no frame to anyone): updates ≤ 4 gone, text
	// and title set.
	state := []byte("state-1")
	a.send(post(4, snapshotMeta{PlainText: "Hello world", Title: "Notes 2", Preview: "Hello  world"}, state))
	b.quiet(a) // a's post was handled before its probe: nothing came to b
	a.quiet(b) // … nor back to a
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_updates WHERE page_id = $1`, p.GetId()).Scan(&n); err != nil || n != 0 {
		t.Fatalf("updates left %d %v", n, err)
	}
	pg, err := e.d.Q.GetWikiPageText(ctx, uuid.MustParse(p.GetId()))
	if err != nil || pg.PlainText != "Hello world" || pg.Preview != "Hello world" || pg.Title != "Notes 2" || pg.DocSize != int32(len(state)) { //nolint:gosec // 7 bytes
		t.Fatalf("page after snapshot: %+v %v", pg, err)
	}
	var vs v1.WikiVersionsResponse
	e.must(200, e.bob, "GET", page(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 1 || vs.GetVersions()[0].GetPlainText() != "Hello world" || len(vs.GetVersions()[0].GetAuthorIds()) != 1 {
		t.Fatalf("versions: %v", &vs)
	}
	w := e.call(e.bob, "GET", page(p.GetId())+"/versions/"+vs.GetVersions()[0].GetId(), nil, nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), state) || w.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("version state: %d %q", w.Code, w.Body.String())
	}
	renamed := false
	for _, ev := range e.ev.take() {
		if ev.GetWikiPageUpsert().GetPage().GetTitle() == "Notes 2" {
			renamed = true
		}
	}
	if !renamed {
		t.Fatal("no WIKI_PAGE_UPSERT for the title")
	}
	// Stale (through < stored) and ahead (through ≥ next_seq) snapshots are ignored.
	a.send(post(2, snapshotMeta{PlainText: "old"}, []byte("old")))
	a.send(post(99, snapshotMeta{PlainText: "ahead"}, []byte("ahead")))
	b.quiet(a)
	a.quiet(b)
	// A stale broadcast post (an oversized edit) is relayed with through 0, not stored, and the
	// poster is asked for a fresh snapshot.
	a.send(post(2, snapshotMeta{PlainText: "big", Broadcast: true}, []byte("big")))
	if f := b.next(frameSnapshot); frameSeq(f) != 0 || string(f[9:]) != "big" {
		t.Fatalf("relayed stale snapshot %x", f)
	}
	a.next(frameCompact)
	if pg, _ := e.d.Q.GetWikiPageText(ctx, uuid.MustParse(p.GetId())); pg.PlainText != "Hello world" {
		t.Fatalf("a stale snapshot was stored: %q", pg.PlainText)
	}
	// The same text again: no new version; another update and the public stream.
	a.send(updateFrame(0, []byte("u5")))
	a.next(frameUpdate)
	b.next(frameUpdate)
	// A broadcast post: the others get the state as a SNAPSHOT, the poster nothing.
	a.send(post(5, snapshotMeta{PlainText: "Hello world", Broadcast: true}, []byte("state-2")))
	if f := b.next(frameSnapshot); frameSeq(f) != 5 || string(f[9:]) != "state-2" {
		t.Fatalf("broadcast snapshot %x", f)
	}
	a.quiet(b)
	e.must(200, e.bob, "GET", page(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 1 {
		t.Fatalf("a version without a change: %d", len(vs.GetVersions()))
	}
	if pg, _ := e.d.Q.GetWikiPage(ctx, uuid.MustParse(p.GetId())); pg.Title != "Notes 2" {
		t.Fatalf("an empty title renamed the page: %q", pg.Title)
	}
	a.send(updateFrame(0, []byte("u6")))
	a.next(frameUpdate)
	var link v1.WikiLinkResponse
	e.must(201, e.alice, "POST", page(p.GetId())+"/link", &v1.CreateWikiLinkRequest{}, &link)
	w = e.call(uuid.Nil, "GET", "/api/public/wiki/"+link.GetLink().GetCode()+"/state", nil, nil)
	recs := records(t, w.Body.Bytes())
	if len(recs) != 2 || recs[0][0] != frameSnapshot || frameSeq(recs[0]) != 5 || string(recs[0][9:]) != "state-2" ||
		recs[1][0] != frameUpdate || frameSeq(recs[1]) != 6 || string(recs[1][9:]) != "u6" {
		t.Fatalf("public state %q", w.Body.Bytes())
	}
}

// The search section (ADR-0096 §7): title and text, the access filter, the hit reference.
func TestSearchWikiAccess(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	ctx := context.Background()
	open := e.create(e.alice, "", "Release checklist")
	closed := e.create(e.alice, "", "Salaries")
	if _, err := e.d.Pool.Exec(ctx, `UPDATE wiki_pages SET plain_text = 'release salaries budget' WHERE id = $1`, closed.GetId()); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE wiki_pages SET plain_text = 'Ship the release on Friday' WHERE id = $1`, open.GetId()); err != nil {
		t.Fatal(err)
	}
	e.must(200, e.alice, "PATCH", page(closed.GetId()), &v1.UpdateWikiPageRequest{Restricted: proto.Bool(true)}, nil)
	find := func(u uuid.UUID, q string) []*v1.SearchHit {
		t.Helper()
		var out v1.SearchResponse
		e.must(200, u, "GET", "/api/search?scope="+e.ws.String()+"&type=wiki&q="+q, nil, &out)
		return out.GetSections()[0].GetItems()
	}
	hits := find(e.alice, "release")
	if len(hits) != 2 {
		t.Fatalf("alice: %v", hits)
	}
	hits = find(e.bob, "release")
	if len(hits) != 1 || hits[0].GetWiki().GetPageId() != open.GetId() || hits[0].GetTitle() != "Release checklist" ||
		!strings.Contains(hits[0].GetSnippet(), "\u0002") {
		t.Fatalf("bob: %v", hits)
	}
	if hits := find(e.bob, "salaries"); len(hits) != 0 {
		t.Fatalf("bob found the restricted page: %v", hits)
	}
	if hits := find(e.guest, "release"); len(hits) != 0 {
		t.Fatalf("the guest found %v", hits)
	}
	// Trashed pages are not found.
	e.must(200, e.alice, "POST", page(open.GetId())+"/trash", nil, nil)
	if hits := find(e.bob, "release"); len(hits) != 0 {
		t.Fatalf("trashed page found: %v", hits)
	}
}

// Two server instances (one database, one Valkey): sockets on different instances get each
// other's updates and awareness through wiki:<pageId>.
func TestWikiSyncAcrossInstances(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	p := e.create(e.alice, "", "Shared")
	other := New(e.d, e.ev, e.fs, nil)
	other.EnableSync(e.rc, fakeAuth{}, nil, SyncConfig{})
	mux := http.NewServeMux()
	other.Routes(mux, func(h http.Handler) http.Handler { return h })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	second := &env{t: t, srv: srv}
	b := second.dial(e.bob, p.GetId())
	b.next(frameSnapshot) // sent only after the second instance's SUBSCRIBE was confirmed
	a.send(updateFrame(0, []byte("x1")))
	a.next(frameUpdate)
	if f := b.next(frameUpdate); frameSeq(f) != 1 || string(f[9:]) != "x1" {
		t.Fatalf("relayed %x", f)
	}
	b.send(updateFrame(0, []byte("y1")))
	if f := a.next(frameUpdate); frameSeq(f) != 2 || string(f[9:]) != "y1" {
		t.Fatalf("relayed back %x", f)
	}
	b.next(frameUpdate)
	b.send([]byte{frameAwareness, 1})
	a.next(frameAwareness)
}

// A frame lost between instances (published before the subscription, or dropped) is filled from
// the database by the next update's sequence check.
func TestWikiSyncGapCatchUp(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	p := e.create(e.alice, "", "Gaps")
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	// Updates written behind the sockets' back (another instance whose publish was lost).
	for _, d := range []string{"g1", "g2"} {
		if _, err := e.d.Q.AppendWikiUpdate(context.Background(), sqlc.AppendWikiUpdateParams{PageID: uuid.MustParse(p.GetId()), Data: []byte(d)}); err != nil {
			t.Fatal(err)
		}
	}
	a.send(updateFrame(0, []byte("g3")))
	for want := int64(1); want <= 3; want++ {
		if f := a.next(frameUpdate); frameSeq(f) != want {
			t.Fatalf("seq %d, want %d", frameSeq(f), want)
		}
	}
}
