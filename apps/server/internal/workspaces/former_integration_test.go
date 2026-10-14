//go:build integration

package workspaces

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// recorder keeps the WORKSPACE_MEMBER_REMOVE events.
type recorder struct {
	events.Nop
	mu      sync.Mutex
	removes []*v1.WorkspaceMemberRemove
}

func (r *recorder) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) {
	if rm := ev.GetWorkspaceMemberRemove(); rm != nil {
		r.mu.Lock()
		r.removes = append(r.removes, rm)
		r.mu.Unlock()
	}
}

func (r *recorder) last(t *testing.T) *v1.WorkspaceMemberRemove {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.removes) == 0 {
		t.Fatal("no WORKSPACE_MEMBER_REMOVE")
	}
	return r.removes[len(r.removes)-1]
}

type fixture struct {
	t   *testing.T
	d   *db.DB
	ev  *recorder
	mux *http.ServeMux
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	d := dbtest.Connect(t)
	f := &fixture{t: t, d: d, ev: &recorder{}, mux: http.NewServeMux()}
	h := NewHandlers(d, f.ev, nil, Limits{})
	h.Routes(f.mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := uuid.MustParse(r.Header.Get("X-Test-User"))
			ctx := auth.WithIdentity(r.Context(), auth.Identity{UserID: id, SessionID: uuid.New()})
			next.ServeHTTP(w, r.WithContext(perm.WithResolver(ctx, d.Q)))
		})
	})
	return f
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.d.Pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
}

func (f *fixture) user(name string) uuid.UUID {
	f.t.Helper()
	id := uuid.New()
	f.exec(`INSERT INTO users (id, email, display_name, username) VALUES ($1, $2, $3, $4)`,
		id, id.String()+"@former.test", name, "u"+strings.ReplaceAll(id.String()[:12], "-", ""))
	f.t.Cleanup(func() { _, _ = f.d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
	return id
}

func (f *fixture) workspace(owner uuid.UUID) uuid.UUID {
	f.t.Helper()
	ws := uuid.New()
	f.exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Former', $3)`, ws, "fm-"+ws.String()[:12], owner)
	f.t.Cleanup(func() { _, _ = f.d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, ws) })
	f.member(ws, owner, perm.RoleOwner)
	return ws
}

func (f *fixture) member(ws, u uuid.UUID, role perm.Role) {
	f.t.Helper()
	if _, err := f.d.Q.AddMember(context.Background(), sqlc.AddMemberParams{WorkspaceID: ws, UserID: u, Role: string(role)}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) do(method, path string, as uuid.UUID, body any) *httptest.ResponseRecorder {
	f.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequestWithContext(context.Background(), method, path, &buf)
	req.Header.Set("X-Test-User", as.String())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, req)
	return w
}

func (f *fixture) former(ws, u uuid.UUID) (sqlc.WorkspaceFormerMember, bool) {
	f.t.Helper()
	row, err := f.d.Q.GetFormerMember(context.Background(), sqlc.GetFormerMemberParams{WorkspaceID: ws, UserID: u})
	if db.IsNotFound(err) {
		return row, false
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return row, true
}

// Leave, kick and ban keep a former-member row with the profile snapshot and announce it in
// WORKSPACE_MEMBER_REMOVE.former; joining again clears it.
func TestFormerMemberRecordedOnEveryRemoval(t *testing.T) {
	f := newFixture(t)
	owner := f.user("Owner")
	ws := f.workspace(owner)
	leaver, kicked, banned := f.user("Leaver"), f.user("Kicked"), f.user("Banned")
	for _, u := range []uuid.UUID{leaver, kicked, banned} {
		f.member(ws, u, perm.RoleMember)
	}
	f.exec(`UPDATE workspace_members SET nickname = 'Kicky' WHERE workspace_id = $1 AND user_id = $2`, ws, kicked)

	if w := f.do("DELETE", "/api/workspaces/"+ws.String()+"/members/@me", leaver, nil); w.Code != http.StatusNoContent {
		t.Fatalf("leave: %d %s", w.Code, w.Body)
	}
	row, ok := f.former(ws, leaver)
	if !ok || row.Reason != ReasonLeft || row.RemovedBy != nil || row.DisplayName != "Leaver" || row.Role != "member" || row.JoinedAt == nil {
		t.Fatalf("leave row: %+v %v", row, ok)
	}
	if ev := f.ev.last(t); ev.GetUserId() != leaver.String() || ev.GetFormer().GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_LEFT || ev.GetFormer().GetLeftAt() == nil {
		t.Fatalf("leave event: %v", ev)
	}

	if w := f.do("DELETE", "/api/workspaces/"+ws.String()+"/members/"+kicked.String(), owner, nil); w.Code != http.StatusNoContent {
		t.Fatalf("kick: %d %s", w.Code, w.Body)
	}
	row, ok = f.former(ws, kicked)
	if !ok || row.Reason != ReasonRemoved || row.RemovedBy == nil || *row.RemovedBy != owner || row.Nickname != "Kicky" {
		t.Fatalf("kick row: %+v %v", row, ok)
	}
	if ev := f.ev.last(t); ev.GetFormer().GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_REMOVED {
		t.Fatalf("kick event: %v", ev)
	}

	if w := f.do("POST", "/api/workspaces/"+ws.String()+"/bans", owner, map[string]string{"userId": banned.String()}); w.Code != http.StatusCreated {
		t.Fatalf("ban: %d %s", w.Code, w.Body)
	}
	if row, ok = f.former(ws, banned); !ok || row.Reason != ReasonBanned || row.RemovedBy == nil || *row.RemovedBy != owner {
		t.Fatalf("ban row: %+v %v", row, ok)
	}
	if ev := f.ev.last(t); ev.GetUserId() != banned.String() || ev.GetFormer().GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_BANNED {
		t.Fatalf("ban event: %v", ev)
	}

	// Back by any join path (they all go through AddMember): an ordinary member again.
	f.member(ws, kicked, perm.RoleMember)
	if _, ok := f.former(ws, kicked); ok {
		t.Fatal("re-join kept the former-member row")
	}
	// Leaving again replaces the row (one per user).
	if w := f.do("DELETE", "/api/workspaces/"+ws.String()+"/members/@me", kicked, nil); w.Code != http.StatusNoContent {
		t.Fatalf("leave again: %d", w.Code)
	}
	if row, ok = f.former(ws, kicked); !ok || row.Reason != ReasonLeft || row.RemovedBy != nil {
		t.Fatalf("second leave row: %+v", row)
	}

	// A removed bot is not a former member: no row, no `former` in the event.
	bot := f.user("Bot")
	f.exec(`UPDATE users SET is_bot = true WHERE id = $1`, bot)
	f.member(ws, bot, perm.RoleMember)
	if w := f.do("DELETE", "/api/workspaces/"+ws.String()+"/members/"+bot.String(), owner, nil); w.Code != http.StatusNoContent {
		t.Fatalf("kick bot: %d %s", w.Code, w.Body)
	}
	if _, ok := f.former(ws, bot); ok {
		t.Fatal("a removed bot got a former-member row")
	}
	if ev := f.ev.last(t); ev.GetUserId() != bot.String() || ev.GetFormer() != nil {
		t.Fatalf("bot event: %v", ev)
	}
	if _, err := f.d.Q.GetMember(context.Background(), sqlc.GetMemberParams{WorkspaceID: ws, UserID: bot}); err == nil {
		t.Fatal("the bot is still a member")
	}
}

// GET …/users?ids= returns members and former members of this workspace only; strangers and
// members of other workspaces are left out; a non-member gets 404; > 100 ids is refused.
func TestWorkspaceUsersResolvesFormerOnly(t *testing.T) {
	f := newFixture(t)
	owner := f.user("Owner")
	ws := f.workspace(owner)
	mate, gone, stranger := f.user("Mate"), f.user("Gone"), f.user("Stranger")
	f.member(ws, mate, perm.RoleMember)
	f.member(ws, gone, perm.RoleMember)
	f.workspace(stranger) // the stranger is a member elsewhere only
	if w := f.do("DELETE", "/api/workspaces/"+ws.String()+"/members/"+gone.String(), owner, nil); w.Code != http.StatusNoContent {
		t.Fatalf("kick: %d", w.Code)
	}
	ids := strings.Join([]string{mate.String(), gone.String(), stranger.String(), uuid.NewString(), gone.String()}, ",")
	w := f.do("GET", "/api/workspaces/"+ws.String()+"/users?ids="+ids, mate, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("users: %d %s", w.Code, w.Body)
	}
	var resp v1.ListWorkspaceUsersResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	got := map[string]*v1.UserRef{}
	for _, u := range resp.GetUsers() {
		got[u.GetUserId()] = u
	}
	if len(got) != 2 || got[stranger.String()] != nil {
		t.Fatalf("users: %v", resp.GetUsers())
	}
	if m := got[mate.String()]; m == nil || m.GetFormer() || m.GetDisplayName() != "Mate" || m.GetUsername() == "" {
		t.Fatalf("mate: %v", m)
	}
	if g := got[gone.String()]; g == nil || !g.GetFormer() || g.GetDisplayName() != "Gone" || g.GetLeftAt() == nil ||
		g.GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_REMOVED {
		t.Fatalf("gone: %v", g)
	}
	// A guest resolves only the members visible to it: never a former member.
	guest := f.user("Guest")
	f.member(ws, guest, perm.RoleGuest)
	w = f.do("GET", "/api/workspaces/"+ws.String()+"/users?ids="+strings.Join([]string{guest.String(), gone.String(), stranger.String()}, ","), guest, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("guest users: %d %s", w.Code, w.Body)
	}
	var gresp v1.ListWorkspaceUsersResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &gresp); err != nil {
		t.Fatal(err)
	}
	if len(gresp.GetUsers()) != 1 || gresp.GetUsers()[0].GetUserId() != guest.String() || gresp.GetUsers()[0].GetFormer() {
		t.Fatalf("guest users: %v", gresp.GetUsers())
	}
	if w := f.do("GET", "/api/workspaces/"+ws.String()+"/users?ids="+mate.String(), stranger, nil); w.Code != http.StatusNotFound {
		t.Fatalf("stranger: %d", w.Code)
	}
	many := make([]string, 101)
	for i := range many {
		many[i] = uuid.NewString()
	}
	if w := f.do("GET", "/api/workspaces/"+ws.String()+"/users?ids="+strings.Join(many, ","), mate, nil); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("101 ids: %d", w.Code)
	}
	if w := f.do("GET", "/api/workspaces/"+ws.String()+"/users?ids=nope", mate, nil); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad id: %d", w.Code)
	}
}

// GET …/former-members needs MANAGE_MEMBERS, hides former guests unless guests=1, counts open
// tasks of live boards and pages by cursor.
func TestFormerMembersList(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.user("Owner")
	ws := f.workspace(owner)
	member, worker, guest := f.user("Member"), f.user("Worker Bee"), f.user("Guesty")
	f.member(ws, member, perm.RoleMember)
	f.member(ws, worker, perm.RoleMember)
	f.member(ws, guest, perm.RoleGuest)

	// Two open tasks and a finished one assigned to the worker.
	board, open, done := uuid.New(), uuid.New(), uuid.New()
	f.exec(`INSERT INTO boards (id, workspace_id, name, key) VALUES ($1, $2, 'B', 'FM')`, board, ws)
	f.exec(`INSERT INTO board_statuses (id, board_id, name, type, is_default) VALUES ($1, $2, 'Todo', 'unstarted', true)`, open, board)
	f.exec(`INSERT INTO board_statuses (id, board_id, name, type) VALUES ($1, $2, 'Done', 'completed')`, done, board)
	for i, st := range []uuid.UUID{open, open, done} {
		var room, task uuid.UUID
		if err := f.d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'task', 'task') RETURNING id`, ws).Scan(&room); err != nil {
			t.Fatal(err)
		}
		if err := f.d.Pool.QueryRow(ctx, `INSERT INTO tasks (board_id, number, title, status_id, room_id) VALUES ($1, $2, 'T', $3, $4) RETURNING id`,
			board, i+1, st, room).Scan(&task); err != nil {
			t.Fatal(err)
		}
		f.exec(`INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)`, task, worker)
	}
	for _, u := range []uuid.UUID{worker, guest} {
		if w := f.do("DELETE", "/api/workspaces/"+ws.String()+"/members/"+u.String(), owner, nil); w.Code != http.StatusNoContent {
			t.Fatalf("kick: %d %s", w.Code, w.Body)
		}
	}
	base := "/api/workspaces/" + ws.String() + "/former-members"
	if w := f.do("GET", base, member, nil); w.Code != http.StatusForbidden {
		t.Fatalf("member: %d", w.Code)
	}
	list := func(query string) *v1.ListFormerMembersResponse {
		t.Helper()
		w := f.do("GET", base+query, owner, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("list %q: %d %s", query, w.Code, w.Body)
		}
		var resp v1.ListFormerMembersResponse
		if err := protojson.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		return &resp
	}
	resp := list("")
	if len(resp.GetMembers()) != 1 || resp.GetMembers()[0].GetUser().GetUserId() != worker.String() {
		t.Fatalf("default list: %v", resp.GetMembers())
	}
	m := resp.GetMembers()[0]
	if m.GetOpenTasks() != 2 || m.GetRemovedBy() != owner.String() || m.GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER ||
		!m.GetUser().GetFormer() || m.GetJoinedAt() == nil {
		t.Fatalf("worker row: %v", m)
	}
	if resp = list("?guests=1"); len(resp.GetMembers()) != 2 || resp.GetMembers()[0].GetUser().GetUserId() != guest.String() {
		t.Fatalf("with guests: %v", resp.GetMembers())
	}
	if resp = list("?guests=1&q=bee"); len(resp.GetMembers()) != 1 || resp.GetMembers()[0].GetUser().GetUserId() != worker.String() {
		t.Fatalf("search: %v", resp.GetMembers())
	}
	if resp = list("?q=%25"); len(resp.GetMembers()) != 0 {
		t.Fatalf("wildcard is literal: %v", resp.GetMembers())
	}

	// Paging: 55 more former members → 50 + the rest.
	for range 55 {
		u := f.user("Many")
		f.member(ws, u, perm.RoleMember)
		if _, _, err := RemoveMembership(ctx, f.d.Q, nil, ws, u, ReasonRemoved, &owner); err != nil {
			t.Fatal(err)
		}
	}
	first := list("")
	if len(first.GetMembers()) != formerPageSize || first.GetNextCursor() == "" {
		t.Fatalf("page 1: %d %q", len(first.GetMembers()), first.GetNextCursor())
	}
	second := list("?cursor=" + first.GetNextCursor())
	if len(second.GetMembers()) != 6 || second.GetNextCursor() != "" {
		t.Fatalf("page 2: %d %q", len(second.GetMembers()), second.GetNextCursor())
	}
	seen := map[string]bool{}
	for _, m := range append(first.GetMembers(), second.GetMembers()...) {
		if seen[m.GetUser().GetUserId()] {
			t.Fatalf("duplicate across pages: %s", m.GetUser().GetUserId())
		}
		seen[m.GetUser().GetUserId()] = true
	}
	if w := f.do("GET", base+"?cursor=garbage", owner, nil); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor: %d", w.Code)
	}
}
