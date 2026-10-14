//go:build integration

package disk

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

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

// env is one workspace with its people and the service behind a mux.
type env struct {
	t     *testing.T
	d     *db.DB
	store blob.Store
	fs    *files.Service
	svc   *Service
	ev    *recorder
	mux   *http.ServeMux
	ws    uuid.UUID
	// owner (workspace owner), admin, alice / bob (members), guest, outsider (no member)
	owner, admin, alice, bob, guest, outsider uuid.UUID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, d: d, store: store, ev: &recorder{}, mux: http.NewServeMux()}
	e.fs = files.NewService(d, store, e.ev, 10<<20, 0)
	e.svc = New(d, e.ev, e.fs, nil)
	e.svc.PublicURL = "https://app.test"
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
	user := func(name string, guest bool) uuid.UUID {
		id := uuid.New()
		email := any(name + "-" + id.String()[:8] + "@disk.test")
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
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Disk', $3)`, e.ws, "dk-"+e.ws.String()[:12], e.owner); err != nil {
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

func (e *env) folder(user uuid.UUID, parent, name string) *v1.DiskItem {
	e.t.Helper()
	var out v1.DiskItemResponse
	e.must(201, user, "POST", "/api/workspaces/"+e.ws.String()+"/disk/folders", &v1.CreateDiskFolderRequest{ParentId: parent, Name: name}, &out)
	return out.GetItem()
}

func (e *env) uploadAs(user uuid.UUID, parent, name string, size int) *httptest.ResponseRecorder {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		e.t.Fatal(err)
	}
	_, _ = fw.Write(bytes.Repeat([]byte("x"), size))
	_ = mw.Close()
	path := "/api/workspaces/" + e.ws.String() + "/disk/upload"
	if parent != "" {
		path += "?parent=" + parent
	}
	return e.call(user, "POST", path, buf.Bytes(), map[string]string{"Content-Type": mw.FormDataContentType()})
}

func (e *env) upload(user uuid.UUID, parent, name string, size int) *v1.DiskItem {
	e.t.Helper()
	w := e.uploadAs(user, parent, name, size)
	if w.Code != 201 {
		e.t.Fatalf("upload %s: %d %s", name, w.Code, w.Body.String())
	}
	var out v1.DiskItemResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil {
		e.t.Fatal(err)
	}
	return out.GetItem()
}

func (e *env) list(user uuid.UUID, query string) []string {
	e.t.Helper()
	var out v1.ListDiskItemsResponse
	e.must(200, user, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items?"+query, nil, &out)
	var names []string
	for _, it := range out.GetItems() {
		names = append(names, it.GetName())
	}
	return names
}

func (e *env) usage() *v1.DiskUsage {
	e.t.Helper()
	var out v1.DiskUsage
	e.must(200, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/usage", nil, &out)
	return &out
}

func item(id string) string { return "/api/disk/items/" + id }

// The access matrix of ADR-0094 §2: members, guests, restricted items, overrides, the owner of
// an item, admins; 404 for what one does not see, 403 for what one sees but may not do.
func TestDiskPermissionsMatrix(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	team := e.folder(e.alice, "", "Team")
	doc := e.upload(e.alice, team.GetId(), "plan.txt", 10)
	if doc.GetFile() == nil || doc.GetMyBits() != uint64(perm.DiskView|perm.DiskWrite) {
		t.Fatalf("upload answer: %v", doc)
	}
	// Members see everything not restricted; the guest and outsiders nothing.
	if got := e.list(e.bob, "parent="+team.GetId()); len(got) != 1 {
		t.Fatalf("bob sees %v", got)
	}
	if got := e.list(e.guest, ""); len(got) != 0 {
		t.Fatalf("the guest sees %v", got)
	}
	e.must(404, e.guest, "GET", item(team.GetId()), nil, nil)
	e.must(404, e.outsider, "GET", item(team.GetId()), nil, nil)
	e.must(404, e.outsider, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items", nil, nil)
	// Seeing is not changing: someone else's item is 403 for a member, fine for an admin.
	e.must(403, e.bob, "PATCH", item(doc.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("x.txt")}, nil)
	e.must(403, e.bob, "POST", item(doc.GetId())+"/trash", nil, nil)
	e.must(403, e.bob, "GET", item(doc.GetId())+"/permissions", nil, nil)
	e.must(200, e.admin, "PATCH", item(doc.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("plan v2.txt")}, nil)
	// Bob may add to the folder (DISK_WRITE), the guest may not.
	e.upload(e.bob, team.GetId(), "bob.txt", 5)
	if w := e.uploadAs(e.guest, team.GetId(), "g.txt", 5); w.Code != 404 {
		t.Fatalf("guest upload into an unseen folder: %d", w.Code)
	}
	// Restricted, shared with the guest by name: bob loses the folder and what is in it.
	user := v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	role := v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	var perms v1.DiskPermissionsResponse
	e.must(200, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.DiskPermissionEntry{{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.DiskView)}}}, &perms)
	if !perms.GetRestricted() || len(perms.GetEntries()) != 1 {
		t.Fatalf("permissions: %v", &perms)
	}
	e.must(404, e.bob, "GET", item(team.GetId()), nil, nil)
	e.must(404, e.bob, "GET", item(doc.GetId()), nil, nil)
	e.must(404, e.bob, "GET", "/api/files/"+doc.GetFile().GetId(), nil, nil)
	if got := e.list(e.bob, ""); len(got) != 0 {
		t.Fatalf("bob still lists %v", got)
	}
	e.must(200, e.guest, "GET", item(doc.GetId()), nil, nil)
	e.must(200, e.guest, "GET", "/api/files/"+doc.GetFile().GetId(), nil, nil)
	if got := e.list(e.guest, ""); len(got) != 1 {
		t.Fatalf("the guest lists %v", got)
	}
	if w := e.uploadAs(e.guest, team.GetId(), "g.txt", 5); w.Code != 403 {
		t.Fatalf("guest upload with VIEW only: %d %s", w.Code, w.Body.String())
	}
	e.must(200, e.admin, "GET", item(doc.GetId()), nil, nil)
	e.must(200, e.owner, "GET", item(doc.GetId()), nil, nil)
	// Bob's own file in the restricted folder stays his (the owner always sees his items).
	var bobs v1.ListDiskItemsResponse
	e.must(200, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items?parent="+team.GetId(), nil, &bobs)
	var bobFile string
	for _, it := range bobs.GetItems() {
		if it.GetName() == "bob.txt" {
			bobFile = it.GetId()
		}
	}
	e.must(200, e.bob, "GET", item(bobFile), nil, nil)
	// A role override gives the folder back to the role's members.
	design := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_roles (id, workspace_id, name, position, permissions) VALUES ($1, $2, 'Design', 5, 0)`, design, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES ($1, $2, $3)`, e.ws, e.bob, design); err != nil {
		t.Fatal(err)
	}
	e.must(200, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{
		{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.DiskView)},
		{TargetType: role, TargetId: design.String(), Allow: uint64(perm.DiskView | perm.DiskWrite)}}}, nil)
	e.must(200, e.bob, "GET", item(team.GetId()), nil, nil)
	e.upload(e.bob, team.GetId(), "design.txt", 5)
	// A personal deny beats the role.
	e.must(200, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{
		{TargetType: role, TargetId: design.String(), Allow: uint64(perm.DiskView | perm.DiskWrite)},
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.DiskWrite)}}}, nil)
	if w := e.uploadAs(e.bob, team.GetId(), "denied.txt", 5); w.Code != 403 {
		t.Fatalf("upload with a personal deny: %d", w.Code)
	}
	// Validation: the guest role, bits beyond VIEW / WRITE, non-members.
	var guestRole uuid.UUID
	if err := e.d.Pool.QueryRow(ctx, `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'guest'`, e.ws).Scan(&guestRole); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []*v1.DiskPermissionEntry{
		{TargetType: role, TargetId: guestRole.String(), Allow: uint64(perm.DiskView)},
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.DiskManage)},
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.ViewRoom)},
		{TargetType: user, TargetId: e.outsider.String(), Allow: uint64(perm.DiskView)},
	} {
		e.must(422, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{bad}}, nil)
	}
	// Workspace-level settings and history: DISK_MANAGE only.
	e.must(403, e.alice, "PUT", "/api/workspaces/"+e.ws.String()+"/disk/settings", &v1.DiskSettings{TrashDays: 7}, nil)
	e.must(403, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/activity", nil, nil)
	e.must(200, e.admin, "GET", "/api/workspaces/"+e.ws.String()+"/disk/activity", nil, nil)
	e.must(403, e.guest, "GET", "/api/workspaces/"+e.ws.String()+"/disk/usage", nil, nil)
}

func TestDiskMoveAndNames(t *testing.T) {
	e := newEnv(t)
	a := e.folder(e.alice, "", "A")
	b := e.folder(e.alice, a.GetId(), "B")
	c := e.folder(e.alice, b.GetId(), "C")
	move := func(id, to string, want int) {
		t.Helper()
		e.must(want, e.alice, "PATCH", item(id), &v1.UpdateDiskItemRequest{ParentId: proto.String(to)}, nil)
	}
	move(a.GetId(), c.GetId(), 409) // into its own descendant
	move(a.GetId(), a.GetId(), 409) // into itself
	move(c.GetId(), "", 200)
	var path v1.DiskPathResponse
	e.must(200, e.alice, "GET", item(b.GetId())+"/path", nil, &path)
	if len(path.GetItems()) != 2 || path.GetItems()[0].GetName() != "A" {
		t.Fatalf("path: %v", &path)
	}
	// Names: an upload with a taken name gets «(2)», a rename onto a taken name is 409.
	e.upload(e.alice, "", "notes.txt", 3)
	if got := e.upload(e.alice, "", "notes.txt", 3).GetName(); got != "notes (2).txt" {
		t.Fatalf("second upload named %q", got)
	}
	if got := e.folder(e.alice, "", "a").GetName(); got != "a (2)" {
		t.Fatalf("folder named %q", got)
	}
	e.must(409, e.alice, "PATCH", item(c.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("NOTES.TXT")}, nil)
	e.must(422, e.alice, "PATCH", item(c.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("a/b")}, nil)
	// Depth: 32 levels at most.
	parent := ""
	for i := range MaxDepth {
		parent = e.folder(e.alice, parent, "d"+strings.Repeat("x", i%3)).GetId()
	}
	e.must(409, e.alice, "POST", "/api/workspaces/"+e.ws.String()+"/disk/folders", &v1.CreateDiskFolderRequest{ParentId: parent, Name: "deep"}, nil)
	move(a.GetId(), parent, 409)
	// Listing: folders first, then by name; paging by cursor.
	got := e.list(e.alice, "")
	if len(got) != 6 || !strings.HasPrefix(got[4], "notes") || !strings.HasPrefix(got[5], "notes") {
		t.Fatalf("root listing (folders first) %v", got)
	}
	var page v1.ListDiskItemsResponse
	e.must(200, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items?limit=2", nil, &page)
	seen := len(page.GetItems())
	for page.GetNextCursor() != "" {
		cur := page.GetNextCursor()
		page.Reset()
		e.must(200, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items?limit=2&cursor="+cur, nil, &page)
		seen += len(page.GetItems())
	}
	if seen != len(got) {
		t.Fatalf("paged %d items, listed %d", seen, len(got))
	}
	for _, sort := range []string{"updated", "size"} {
		if n := len(e.list(e.alice, "sort="+sort)); n != len(got) {
			t.Fatalf("sort=%s lists %d", sort, n)
		}
	}
}

func TestDiskTrashQuotaAndUsage(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f := e.folder(e.alice, "", "F")
	one := e.upload(e.alice, f.GetId(), "one.bin", 100)
	e.upload(e.alice, f.GetId(), "two.bin", 200)
	// A chat attachment («other»): a plain upload of the workspace.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "chat.bin")
	_, _ = fw.Write(make([]byte, 400))
	_ = mw.Close()
	r := httptest.NewRequestWithContext(ctx, "POST", "/x", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: e.alice}))
	if err := e.fs.UploadInto(httptest.NewRecorder(), r, e.ws); err != nil {
		t.Fatal(err)
	}
	u := e.usage()
	if u.GetUsedBytes() != 700 || u.GetDiskBytes() != 300 || u.GetTrashBytes() != 0 || u.GetOtherBytes() != 400 {
		t.Fatalf("usage %v", u)
	}
	e.must(409, e.alice, "DELETE", item(f.GetId()), nil, nil) // not in the trash
	e.must(200, e.alice, "POST", item(f.GetId())+"/trash", nil, nil)
	if u := e.usage(); u.GetTrashBytes() != 300 || u.GetUsedBytes() != 700 {
		t.Fatalf("usage after trash %v", u)
	}
	if got := e.list(e.alice, "trashed=1"); len(got) != 1 || got[0] != "F" {
		t.Fatalf("trash lists %v", got)
	}
	if got := e.list(e.bob, "trashed=1"); len(got) != 1 {
		t.Fatalf("bob sees the trash %v", got)
	}
	e.must(409, e.alice, "POST", item(one.GetId())+"/restore", nil, nil) // not a trash root
	e.must(200, e.alice, "POST", item(f.GetId())+"/restore", nil, nil)
	if u := e.usage(); u.GetTrashBytes() != 0 {
		t.Fatalf("usage after restore %v", u)
	}
	e.must(200, e.alice, "POST", item(f.GetId())+"/trash", nil, nil)
	// Bob may not delete Alice's trash; empty trash deletes only what one may.
	var empty v1.EmptyDiskTrashResponse
	e.must(200, e.bob, "POST", "/api/workspaces/"+e.ws.String()+"/disk/trash/empty", nil, &empty)
	if empty.GetDeleted() != 0 {
		t.Fatalf("bob emptied %v", &empty)
	}
	e.must(200, e.alice, "POST", "/api/workspaces/"+e.ws.String()+"/disk/trash/empty", nil, &empty)
	if empty.GetDeleted() != 1 || empty.GetFreedBytes() != 300 {
		t.Fatalf("alice emptied %v", &empty)
	}
	if u := e.usage(); u.GetUsedBytes() != 400 || u.GetDiskBytes() != 0 || u.GetTrashBytes() != 0 || u.GetOtherBytes() != 400 {
		t.Fatalf("usage after empty %v", u)
	}
	if _, err := e.d.Q.GetFile(ctx, uuid.MustParse(one.GetFile().GetId())); !db.IsNotFound(err) {
		t.Fatalf("files row of a deleted item: %v", err)
	}
	var keys int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM files WHERE workspace_id = $1`, e.ws).Scan(&keys); err != nil || keys != 1 { // the chat file
		t.Fatalf("files left: %d %v", keys, err)
	}
	if _, _, err := e.store.Get(ctx, blob.FileKey(e.ws, uuid.MustParse(one.GetFile().GetId()))); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("blob of a deleted file: %v", err)
	}
	keep := e.upload(e.alice, "", "keep.bin", 64)
	// The orphan cleanup never releases the deleted bytes again (their rows are gone): run long
	// after, it only removes the chat file, which was never attached.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE files SET created_at = now() - interval '2 days' WHERE workspace_id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.fs.CleanupOrphans(ctx); err != nil {
		t.Fatal(err)
	}
	if u := e.usage(); u.GetUsedBytes() != 64 || u.GetDiskBytes() != 64 {
		t.Fatalf("after the orphan cleanup of the chat file: %v", u)
	}
	e.must(200, e.alice, "GET", item(keep.GetId()), nil, nil)
	// The journal kept the deletion in the workspace history.
	var act v1.DiskActivityPage
	e.must(200, e.admin, "GET", "/api/workspaces/"+e.ws.String()+"/disk/activity", nil, &act)
	if len(act.GetActivities()) < 2 || act.GetActivities()[1].GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_DELETE ||
		act.GetActivities()[1].GetItemId() != "" || act.GetActivities()[1].GetItemName() != "F" {
		t.Fatalf("workspace activity %v", &act)
	}
}

func TestDiskPublicLink(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	doc := e.upload(e.alice, "", "report.txt", 50)
	folder := e.folder(e.alice, "", "Dir")
	e.must(409, e.alice, "POST", item(folder.GetId())+"/link", &v1.CreateDiskLinkRequest{}, nil)
	e.must(403, e.bob, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{}, nil)
	e.must(422, e.alice, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{ExpiresAt: timestamppb.New(time.Now().Add(-time.Hour))}, nil)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	code := link.GetLink().GetCode()
	if len(code) != CodeLength || link.GetUrl() != "https://app.test/d/"+code {
		t.Fatalf("link %v", &link)
	}
	var again v1.DiskLinkResponse
	e.must(200, e.alice, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &again)
	if again.GetLink().GetCode() != code {
		t.Fatal("a live link was replaced")
	}
	// The owner sees the link on the item, bob does not.
	var mine, his v1.DiskItemResponse
	e.must(200, e.alice, "GET", item(doc.GetId()), nil, &mine)
	e.must(200, e.bob, "GET", item(doc.GetId()), nil, &his)
	if mine.GetItem().GetLink().GetCode() != code || his.GetItem().GetLink() != nil {
		t.Fatalf("link shown: owner %v, bob %v", mine.GetItem().GetLink(), his.GetItem().GetLink())
	}
	// Anonymous.
	w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code, nil, nil)
	var pub v1.PublicDiskFile
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &pub) != nil || pub.GetName() != "report.txt" || pub.GetSize() != 50 {
		t.Fatalf("public meta %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("X-Robots-Tag"), "noindex") {
		t.Fatal("no X-Robots-Tag")
	}
	w = e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/content", nil, nil)
	if w.Code != 200 || w.Body.Len() != 50 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("public content %d %d %q", w.Code, w.Body.Len(), w.Header().Get("Cache-Control"))
	}
	w = e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/content", nil, map[string]string{"Range": "bytes=10-19"})
	if w.Code != http.StatusPartialContent || w.Body.Len() != 10 {
		t.Fatalf("range %d %d", w.Code, w.Body.Len())
	}
	l, err := e.d.Q.GetDiskLinkByItem(ctx, uuid.MustParse(doc.GetId()))
	if err != nil || l.Downloads != 1 {
		t.Fatalf("downloads %d %v", l.Downloads, err)
	}
	// In the trash: still served.
	e.must(200, e.alice, "POST", item(doc.GetId())+"/trash", nil, nil)
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code, nil, nil); w.Code != 200 {
		t.Fatalf("trashed file link: %d", w.Code)
	}
	e.must(200, e.alice, "POST", item(doc.GetId())+"/restore", nil, nil)
	// Revoked, then expired.
	e.must(403, e.bob, "DELETE", item(doc.GetId())+"/link", nil, nil)
	e.must(204, e.alice, "DELETE", item(doc.GetId())+"/link", nil, nil)
	e.must(404, e.alice, "DELETE", item(doc.GetId())+"/link", nil, nil)
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code, nil, nil); w.Code != 404 {
		t.Fatalf("revoked link: %d", w.Code)
	}
	e.must(201, e.admin, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{ExpiresAt: timestamppb.New(time.Now().Add(time.Hour))}, &link)
	code = link.GetLink().GetCode()
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/content", nil, nil); w.Code != 200 {
		t.Fatalf("new link: %d", w.Code)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE disk_links SET expires_at = now() - interval '1 second' WHERE code = $1`, code); err != nil {
		t.Fatal(err)
	}
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code+"/content", nil, nil); w.Code != 404 {
		t.Fatalf("expired link: %d", w.Code)
	}
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/short", nil, nil); w.Code != 404 {
		t.Fatalf("bad code: %d", w.Code)
	}
	// Deleted forever: gone.
	e.must(201, e.alice, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	code = link.GetLink().GetCode()
	e.must(200, e.alice, "POST", item(doc.GetId())+"/trash", nil, nil)
	e.must(204, e.alice, "DELETE", item(doc.GetId()), nil, nil)
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code, nil, nil); w.Code != 404 {
		t.Fatalf("link of a deleted file: %d", w.Code)
	}
	// Rate limit per client IP (Redis, like the forms' limiters).
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	e.svc.LinkReadLimit = redisx.NewRateLimiter(rc, "rl:test-disk-link:"+uuid.NewString()+":", 2, 0.001)
	other := e.upload(e.alice, "", "rl.txt", 5)
	e.must(201, e.alice, "POST", item(other.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	for i, want := range []int{200, 200, 429} {
		if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+link.GetLink().GetCode(), nil, nil); w.Code != want {
			t.Fatalf("request %d: %d, want %d", i, w.Code, want)
		}
	}
}

func TestDiskEventsAndJournal(t *testing.T) {
	e := newEnv(t)
	f := e.folder(e.alice, "", "Shared")
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetDiskItemUpsert() == nil || len(evs[0].GetDiskItemUpsert().GetAccess()) != 1 {
		t.Fatalf("create events %v", evs)
	}
	// A rename and its correction within 5 minutes are one entry; renaming back removes it.
	for _, name := range []string{"Shared 2", "Shared 3"} {
		e.must(200, e.alice, "PATCH", item(f.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String(name)}, nil)
	}
	var act v1.DiskActivityPage
	e.must(200, e.bob, "GET", item(f.GetId())+"/activity", nil, &act)
	if len(act.GetActivities()) != 2 || act.GetActivities()[0].GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_RENAME ||
		act.GetActivities()[0].GetBefore().GetFields()["name"].GetStringValue() != "Shared" ||
		act.GetActivities()[0].GetAfter().GetFields()["name"].GetStringValue() != "Shared 3" {
		t.Fatalf("coalesced rename %v", &act)
	}
	e.must(200, e.alice, "PATCH", item(f.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("Shared")}, nil)
	act.Reset()
	e.must(200, e.bob, "GET", item(f.GetId())+"/activity", nil, &act)
	if len(act.GetActivities()) != 1 {
		t.Fatalf("rename back %v", &act)
	}
	e.ev.take()
	// Restricting the folder: the event carries the chain before and after.
	e.must(200, e.alice, "PUT", item(f.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.DiskPermissionEntry{{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.bob.String(), Allow: uint64(perm.DiskView)}}}, nil)
	evs = e.ev.take()
	if len(evs) != 1 {
		t.Fatalf("share events %v", evs)
	}
	u := evs[0].GetDiskItemUpsert()
	if u == nil || !u.GetAccess()[0].GetRestricted() || len(u.GetAccess()[0].GetOverrides()) != 1 || len(u.GetAccessBefore()) != 1 || u.GetAccessBefore()[0].GetRestricted() {
		t.Fatalf("share event %v", u)
	}
	act.Reset()
	e.must(200, e.alice, "GET", item(f.GetId())+"/activity", nil, &act)
	share := act.GetActivities()[0]
	if share.GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_SHARE {
		t.Fatalf("share entry %v", share)
	}
	entries := share.GetAfter().GetFields()["entries"].GetListValue().GetValues()
	if len(entries) != 1 || entries[0].GetStructValue().GetFields()["name"].GetStringValue() != "Bob" {
		t.Fatalf("share snapshot %v", share.GetAfter())
	}
	// Moving into the folder names it in the journal.
	doc := e.upload(e.alice, "", "a.txt", 1)
	e.ev.take()
	e.must(200, e.alice, "PATCH", item(doc.GetId()), &v1.UpdateDiskItemRequest{ParentId: proto.String(f.GetId())}, nil)
	if evs := e.ev.take(); len(evs) != 1 || len(evs[0].GetDiskItemUpsert().GetAccessBefore()) == 0 {
		t.Fatalf("move event %v", evs)
	}
	act.Reset()
	e.must(200, e.alice, "GET", item(doc.GetId())+"/activity", nil, &act)
	mv := act.GetActivities()[0]
	if mv.GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_MOVE || mv.GetAfter().GetFields()["parent_name"].GetStringValue() != "Shared" {
		t.Fatalf("move entry %v", mv)
	}
	// Delete forever: DISK_ITEM_REMOVE with the chain the item had.
	e.must(200, e.alice, "POST", item(doc.GetId())+"/trash", nil, nil)
	e.ev.take()
	e.must(204, e.alice, "DELETE", item(doc.GetId()), nil, nil)
	evs = e.ev.take()
	if len(evs) != 1 || evs[0].GetDiskItemRemove().GetItemId() != doc.GetId() || len(evs[0].GetDiskItemRemove().GetAccess()) != 2 {
		t.Fatalf("remove event %v", evs)
	}
}

func TestDiskTrashSweep(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	old := e.upload(e.alice, "", "old.bin", 64)
	fresh := e.upload(e.alice, "", "fresh.bin", 32)
	e.must(200, e.alice, "POST", item(old.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "POST", item(fresh.GetId())+"/trash", nil, nil)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE disk_items SET trashed_at = now() - interval '3 days' WHERE id = $1`, uuid.MustParse(old.GetId())); err != nil {
		t.Fatal(err)
	}
	// Retention «never» (default): nothing goes.
	if n, err := e.svc.TrashSweep(ctx); err != nil || n != 0 {
		t.Fatalf("sweep without retention: %d %v", n, err)
	}
	var st v1.DiskSettings
	e.must(200, e.admin, "PUT", "/api/workspaces/"+e.ws.String()+"/disk/settings", &v1.DiskSettings{TrashDays: 2}, &st)
	e.must(200, e.bob, "GET", "/api/workspaces/"+e.ws.String()+"/disk/settings", nil, &st)
	if st.GetTrashDays() != 2 {
		t.Fatalf("settings %v", &st)
	}
	e.must(422, e.admin, "PUT", "/api/workspaces/"+e.ws.String()+"/disk/settings", &v1.DiskSettings{TrashDays: 5000}, nil)
	e.ev.take()
	if n, err := e.svc.TrashSweep(ctx); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	e.must(404, e.alice, "GET", item(old.GetId()), nil, nil)
	e.must(200, e.alice, "GET", item(fresh.GetId()), nil, nil)
	if u := e.usage(); u.GetUsedBytes() != 32 || u.GetTrashBytes() != 32 {
		t.Fatalf("usage after the sweep %v", u)
	}
	if evs := e.ev.take(); len(evs) != 1 || evs[0].GetDiskItemRemove() == nil {
		t.Fatalf("sweep events %v", evs)
	}
	var act v1.DiskActivityPage
	e.must(200, e.admin, "GET", "/api/workspaces/"+e.ws.String()+"/disk/activity", nil, &act)
	if a := act.GetActivities()[0]; a.GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_DELETE || a.GetActorId() != "" || a.GetItemName() != "old.bin" {
		t.Fatalf("sweeper entry %v", a)
	}
	// Turning the retention off.
	e.must(200, e.admin, "PUT", "/api/workspaces/"+e.ws.String()+"/disk/settings", &v1.DiskSettings{}, nil)
	e.must(200, e.bob, "GET", "/api/workspaces/"+e.ws.String()+"/disk/settings", nil, &st)
	if st.GetTrashDays() != 0 {
		t.Fatalf("retention off: %v", &st)
	}
}
