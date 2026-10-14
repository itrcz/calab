//go:build integration

package guests

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/workspaces"
)

type removals struct {
	events.Nop
	mu  sync.Mutex
	got map[uuid.UUID]*v1.WorkspaceMemberRemove // by user
}

func (r *removals) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) {
	if rm := ev.GetWorkspaceMemberRemove(); rm != nil {
		r.mu.Lock()
		r.got[uuid.MustParse(rm.GetUserId())] = rm
		r.mu.Unlock()
	}
}

type sweepFixture struct {
	t  *testing.T
	d  *db.DB
	ev *removals
	ws uuid.UUID
}

func (f *sweepFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.d.Pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
}

func (f *sweepFixture) user(name string, guestAccount bool) uuid.UUID {
	f.t.Helper()
	id := uuid.New()
	if guestAccount {
		f.exec(`INSERT INTO users (id, display_name, is_guest, guest_expires_at) VALUES ($1, $2, true, now() + interval '1 hour')`, id, name)
	} else {
		f.exec(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, id, id.String()+"@sweep.test", name)
	}
	f.t.Cleanup(func() { _, _ = f.d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
	return id
}

// guest adds a guest membership last active `ago` (nil = never touched: joined `ago`).
func (f *sweepFixture) guest(u uuid.UUID, ago time.Duration, touched bool) {
	f.t.Helper()
	f.exec(`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, 'guest', now() - $3::interval)`, f.ws, u, ago.String())
	if touched {
		f.exec(`UPDATE workspace_members SET last_active_at = now() - $3::interval WHERE workspace_id = $1 AND user_id = $2`, f.ws, u, ago.String())
	}
}

func (f *sweepFixture) isMember(u uuid.UUID) bool {
	f.t.Helper()
	_, err := f.d.Q.GetMember(context.Background(), sqlc.GetMemberParams{WorkspaceID: f.ws, UserID: u})
	if err != nil && !db.IsNotFound(err) {
		f.t.Fatal(err)
	}
	return err == nil
}

func (f *sweepFixture) former(u uuid.UUID) (sqlc.WorkspaceFormerMember, bool) {
	f.t.Helper()
	row, err := f.d.Q.GetFormerMember(context.Background(), sqlc.GetFormerMemberParams{WorkspaceID: f.ws, UserID: u})
	if err != nil && !db.IsNotFound(err) {
		f.t.Fatal(err)
	}
	return row, err == nil
}

func newSweepFixture(t *testing.T) *sweepFixture {
	t.Helper()
	f := &sweepFixture{t: t, d: dbtest.Connect(t), ev: &removals{got: map[uuid.UUID]*v1.WorkspaceMemberRemove{}}, ws: uuid.New()}
	owner := f.user("Owner", false)
	f.exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Sweep', $3)`, f.ws, "sw-"+f.ws.String()[:12], owner)
	t.Cleanup(func() { _, _ = f.d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, f.ws) })
	f.exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, f.ws, owner)
	return f
}

// ADR-0098: registered users' guest memberships idle past the threshold are removed with a
// former-member row (guest_expired) and WORKSPACE_MEMBER_REMOVE.former; an active one, one
// whose user is connected (and gets touched), a member and a guest account are left alone.
func TestGuestMembershipSweep(t *testing.T) {
	f := newSweepFixture(t)
	ctx := context.Background()
	idle, neverTouched, active, present, member, account := f.user("Idle", false), f.user("Never", false),
		f.user("Active", false), f.user("Present", false), f.user("Member", false), f.user("Account", true)
	f.guest(idle, 72*time.Hour, true)
	f.guest(neverTouched, 72*time.Hour, false) // NULL last_active_at: joined_at counts
	f.guest(active, time.Hour, true)
	f.guest(present, 72*time.Hour, true)
	f.guest(account, 72*time.Hour, true) // guest accounts expire as a whole, not here
	f.exec(`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, 'member', now() - interval '30 days')`, f.ws, member)

	s := NewService(f.d, nil, f.ev, nil, nil, nil)
	s.Present = func(_ context.Context, u uuid.UUID) (bool, error) { return u == present, nil }
	n, err := s.CleanupMemberships(ctx, time.Now().Add(-48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("removed %d, want 2", n)
	}
	for _, u := range []uuid.UUID{idle, neverTouched} {
		if f.isMember(u) {
			t.Fatalf("%s still a member", u)
		}
		row, ok := f.former(u)
		if !ok || row.Reason != workspaces.ReasonGuestExpired || row.Role != "guest" || row.RemovedBy != nil {
			t.Fatalf("former row of %s: %+v %v", u, row, ok)
		}
		if ev := f.ev.got[u]; ev == nil || ev.GetFormer().GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_GUEST_EXPIRED {
			t.Fatalf("event of %s: %v", u, ev)
		}
	}
	for _, u := range []uuid.UUID{active, present, member, account} {
		if !f.isMember(u) {
			t.Fatalf("%s was removed", u)
		}
	}
	// Being connected counts as activity: the present guest is touched, out of the next pass.
	var last time.Time
	if err := f.d.Pool.QueryRow(ctx, `SELECT last_active_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, f.ws, present).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if time.Since(last) > time.Minute {
		t.Fatalf("present guest not touched: %v", last)
	}
	// Activity touches are throttled to 5 minutes and leave members alone.
	if err := f.d.Q.TouchGuestMemberships(ctx, active); err != nil {
		t.Fatal(err)
	}
	// Presence that cannot be told removes nobody.
	f.guest(f.user("Unknown", false), 72*time.Hour, true)
	s.Present = func(context.Context, uuid.UUID) (bool, error) { return false, context.DeadlineExceeded }
	if _, err := s.CleanupMemberships(ctx, time.Now().Add(-48*time.Hour)); err == nil {
		t.Fatal("presence error ignored")
	}
	// Back by a new link: AddMember clears the former row.
	if _, err := f.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: f.ws, UserID: idle, Role: "guest"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.former(idle); ok {
		t.Fatal("re-join kept the former row")
	}
}

// An expired guest account leaves a former-member row per workspace with the name it had
// before anonymisation, and WORKSPACE_MEMBER_REMOVE.former.
func TestGuestAccountExpiryKeepsFormerRow(t *testing.T) {
	f := newSweepFixture(t)
	ctx := context.Background()
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	a := auth.NewService(&config.Config{JWTSecret: "former-members-test-secret-0123456789", AccessTokenTTL: time.Hour}, f.d, rc, f.ev)
	if a.GuestInactivity() != auth.DefaultGuestInactivity {
		t.Fatalf("default inactivity: %v", a.GuestInactivity())
	}
	g := f.user("Visitor", true)
	f.exec(`UPDATE users SET guest_expires_at = now() - interval '1 minute' WHERE id = $1`, g)
	f.guest(g, time.Hour, true)
	s := NewService(f.d, a, f.ev, nil, nil, nil)
	if _, err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if f.isMember(g) {
		t.Fatal("expired guest account still a member")
	}
	row, ok := f.former(g)
	if !ok || row.Reason != workspaces.ReasonGuestExpired || row.DisplayName != "Visitor" {
		t.Fatalf("former row: %+v %v", row, ok)
	}
	if ev := f.ev.got[g]; ev == nil || ev.GetFormer().GetReason() != v1.FormerMemberReason_FORMER_MEMBER_REASON_GUEST_EXPIRED {
		t.Fatalf("event: %v", ev)
	}
	refs, err := f.d.Q.ListWorkspaceUserRefs(ctx, sqlc.ListWorkspaceUserRefsParams{WorkspaceID: f.ws, Ids: []uuid.UUID{g}})
	if err != nil || len(refs) != 1 || refs[0].DisplayName == "Visitor" || refs[0].FormerName == nil || *refs[0].FormerName != "Visitor" {
		t.Fatalf("refs: %+v %v", refs, err)
	}
}
