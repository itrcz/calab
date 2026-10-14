//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestFormerMembersBackfill (ADR-0097 §6, ADR-0098 §2, migration 00089) on a populated
// database: message authors and task actors / assignees without a membership become former
// members ('removed', left_at = their last trace in that workspace); members, bots, DM-only authors
// and other workspaces' people do not; guest accounts get at most 48 h left; guest memberships
// start from the user's last session activity; down and up again works.
func TestFormerMembersBackfill(t *testing.T) {
	ctx := context.Background()
	adminURL := envOr("TEST_PG_URL", envOr("TEST_DATABASE_URL", "postgres://calaba:calaba@localhost:55432/calaba"))
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("postgres unavailable: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var b [4]byte
	_, _ = rand.Read(b[:])
	name := "calaba_mig_" + hex.EncodeToString(b[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	u, _ := url.Parse(adminURL)
	u.Path = "/" + name
	d, err := Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	must := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	if err := d.MigrateTo(ctx, 88); err != nil {
		t.Fatal(err)
	}
	owner, author, actor, assignee, dmOnly, regGuest := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{owner, author, actor, assignee, dmOnly, regGuest} {
		must(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, id, "u-"+id.String()[:8]+"@example.com", "N"+id.String()[:4])
	}
	bot := uuid.New() // a removed bot that posted: not a former member
	must(`INSERT INTO users (id, display_name, is_bot) VALUES ($1, 'Bot', true)`, bot)
	guestAcc := uuid.New()
	must(`INSERT INTO users (id, display_name, is_guest, guest_expires_at) VALUES ($1, 'Guest', true, now() + interval '7 days')`, guestAcc)
	ws, other := uuid.New(), uuid.New()
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-former', 'W', $2)`, ws, owner)
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-other', 'O', $2)`, other, owner)
	must(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'owner')`, ws, owner, other)
	must(`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, 'guest', now() - interval '30 days')`, ws, regGuest)
	seen := time.Now().Add(-3 * time.Hour).Truncate(time.Microsecond)
	must(`INSERT INTO sessions (user_id, refresh_token_hash, expires_at, last_seen_at) VALUES ($1, 'x', now() + interval '1 day', $2)`, regGuest, seen)

	var chat, otherChat, dm uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'chat', 'text') RETURNING id`, ws).Scan(&chat); err != nil {
		t.Fatal(err)
	}
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'chat', 'text') RETURNING id`, other).Scan(&otherChat); err != nil {
		t.Fatal(err)
	}
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type, dm_key) VALUES (NULL, 'dm', 'dm', $1) RETURNING id`, dmOnly.String()+":"+owner.String()).Scan(&dm); err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	msg := func(room, by uuid.UUID, at time.Time) {
		t.Helper()
		must(`INSERT INTO messages (room_id, author_id, content, created_at) VALUES ($1, $2, 'hi', $3)`, room, by, at)
	}
	msg(chat, owner, t0)
	msg(chat, author, t0)
	msg(chat, author, t0.Add(time.Hour)) // the last trace
	msg(chat, guestAcc, t0)
	msg(chat, bot, t0)
	msg(otherChat, actor, t0) // another workspace: a former member there, not here
	msg(dm, dmOnly, t0)

	board, status, task := uuid.New(), uuid.New(), uuid.New()
	must(`INSERT INTO boards (id, workspace_id, name, key, position) VALUES ($1, $2, 'B', 'BB', 0)`, board, ws)
	must(`INSERT INTO board_statuses (id, board_id, name, type, is_default) VALUES ($1, $2, 'Todo', 'unstarted', true)`, status, board)
	var taskRoom uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'BB-1', 'task') RETURNING id`, ws).Scan(&taskRoom); err != nil {
		t.Fatal(err)
	}
	must(`INSERT INTO tasks (id, board_id, number, title, status_id, room_id, created_by, created_at) VALUES ($1, $2, 1, 'T', $3, $4, $5, $6)`, task, board, status, taskRoom, owner, t0)
	must(`INSERT INTO task_activity (task_id, board_id, actor_id, kind, created_at) VALUES ($1, $2, $3, 'status', $4)`, task, board, actor, t0.Add(2*time.Hour))
	must(`INSERT INTO task_assignees (task_id, user_id, assigned_at) VALUES ($1, $2, $3)`, task, assignee, t0.Add(3*time.Hour))

	if err := d.MigrateTo(ctx, 89); err != nil {
		t.Fatal(err)
	}
	type row struct {
		user   uuid.UUID
		name   string
		role   string
		leftAt time.Time
	}
	read := func(w uuid.UUID) map[uuid.UUID]row {
		t.Helper()
		rows, err := d.Pool.Query(ctx, `SELECT user_id, display_name, role, left_at FROM workspace_former_members WHERE workspace_id = $1 AND reason = 'removed'`, w)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[uuid.UUID]row{}
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.user, &r.name, &r.role, &r.leftAt); err != nil {
				t.Fatal(err)
			}
			out[r.user] = r
		}
		return out
	}
	got := read(ws)
	if _, ok := got[bot]; ok || len(got) != 4 {
		t.Fatalf("former members: %v", got)
	}
	for user, want := range map[uuid.UUID]time.Time{author: t0.Add(time.Hour), actor: t0.Add(2 * time.Hour), assignee: t0.Add(3 * time.Hour), guestAcc: t0} {
		r, ok := got[user]
		if !ok || !r.leftAt.Equal(want) {
			t.Fatalf("%s: %+v, want left_at %v", user, r, want)
		}
	}
	if got[guestAcc].role != "guest" || got[author].role != "member" || got[author].name != "N"+author.String()[:4] {
		t.Fatalf("roles / names: %+v", got)
	}
	if o := read(other); len(o) != 1 || o[actor].user != actor {
		t.Fatalf("other workspace: %v", o)
	}
	var left time.Duration
	if err := d.Pool.QueryRow(ctx, `SELECT extract(epoch FROM guest_expires_at - now())::bigint * interval '1 second' FROM users WHERE id = $1`, guestAcc).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left > 48*time.Hour || left < 47*time.Hour {
		t.Fatalf("guest account expiry: %v left", left)
	}
	var active *time.Time
	if err := d.Pool.QueryRow(ctx, `SELECT last_active_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, ws, regGuest).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active == nil || !active.Equal(seen) {
		t.Fatalf("guest membership activity: %v, want %v", active, seen)
	}
	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 88); err != nil {
		t.Fatalf("down: %v", err)
	}
	if err := d.MigrateTo(ctx, 89); err != nil {
		t.Fatalf("up again: %v", err)
	}
}
