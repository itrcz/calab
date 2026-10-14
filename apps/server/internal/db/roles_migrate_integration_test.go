//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestMigration21Roles: a database at 00020 with members of every role and role / user room
// overrides migrates to 00021 (built-in roles, member_roles, role targets → ids), the
// triggers give new workspaces / members their built-in roles, and 00021 goes down (targets
// back to names, custom role overrides dropped) and up again.
func TestMigration21Roles(t *testing.T) {
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	scalar := func(dst any, sql string, args ...any) {
		t.Helper()
		if err := d.Pool.QueryRow(ctx, sql, args...).Scan(dst); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	if err := d.MigrateTo(ctx, 20); err != nil {
		t.Fatal(err)
	}
	ws := uuid.New()
	users := map[string]uuid.UUID{"owner": uuid.New(), "admin": uuid.New(), "member": uuid.New(), "guest": uuid.New()}
	for role, id := range users {
		exec(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, id, role+"-"+id.String()[:8]+"@example.com", role)
	}
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-roles', 'W', $2)`, ws, users["owner"])
	for role, id := range users {
		exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, ws, id, role)
	}
	room := uuid.New()
	exec(`INSERT INTO rooms (id, workspace_id, type, name, is_private) VALUES ($1, $2, 'text', 'secret', true)`, room, ws)
	exec(`INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny) VALUES
		($1, 'role', 'member', 0, 1), ($1, 'role', 'guest', 3, 0), ($1, 'user', $2::text, 1, 0)`, room, users["member"])

	// A second workspace (same member ids in both) with its own role targets: each maps to
	// the built-in role of its own workspace.
	wsB := uuid.New()
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-roles-b', 'B', $2)`, wsB, users["admin"])
	exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'guest'), ($1, $4, 'member')`,
		wsB, users["admin"], users["owner"], users["guest"])
	roomB := uuid.New()
	exec(`INSERT INTO rooms (id, workspace_id, type, name) VALUES ($1, $2, 'voice', 'b')`, roomB, wsB)
	exec(`INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny) VALUES
		($1, 'role', 'guest', 1, 0), ($1, 'role', 'member', 0, 64), ($1, 'user', $2::text, 0, 32)`, roomB, users["guest"])

	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var bTargets []string
	scalar(&bTargets, `SELECT array_agg(rp.target_id || '=' || coalesce(wr.builtin, '?') || '@' || coalesce((wr.workspace_id = $2)::text, 'user')
		ORDER BY rp.target_type, rp.allow) FROM room_permissions rp LEFT JOIN workspace_roles wr ON wr.id::text = rp.target_id
		WHERE rp.room_id = $1`, roomB, wsB)
	if len(bTargets) != 3 || !strings.HasSuffix(bTargets[0], "=member@true") || !strings.HasSuffix(bTargets[1], "=guest@true") ||
		bTargets[2] != users["guest"].String()+"=?@user" {
		t.Fatalf("second workspace targets: %v", bTargets)
	}
	var bHeld []string
	scalar(&bHeld, `SELECT array_agg(mr.user_id::text || ':' || wr.builtin ORDER BY mr.user_id, wr.position) FROM member_roles mr
		JOIN workspace_roles wr ON wr.id = mr.role_id WHERE mr.workspace_id = $1 AND wr.workspace_id = $1`, wsB)
	if len(bHeld) != 4 { // admin-user: owner + member, owner-user: guest, guest-user: member
		t.Fatalf("second workspace member roles: %v", bHeld)
	}
	// Built-in roles with the legacy permission sets; members hold theirs.
	roleID := map[string]uuid.UUID{}
	rows, err := d.Pool.Query(ctx, `SELECT builtin, id, position, permissions FROM workspace_roles WHERE workspace_id = $1`, ws)
	if err != nil {
		t.Fatal(err)
	}
	// member: 16503 from 00021, plus VIEW_BOARD | CREATE_TASKS from 00046 (ADR-0042) and
	// CREATE_TEMP_ROOMS from 00048 (ADR-0044), DISK_VIEW | DISK_WRITE from 00088 (ADR-0094) and
	// WIKI_VIEW | WIKI_WRITE from 00090 (ADR-0096).
	want := map[string][2]int64{"owner": {1001, 1024}, "admin": {1000, 1024}, "member": {1, 8798327 | 3<<35 | 3<<38}, "guest": {0, 48}}
	for rows.Next() {
		var bi string
		var id uuid.UUID
		var pos, bits int64
		if err := rows.Scan(&bi, &id, &pos, &bits); err != nil {
			t.Fatal(err)
		}
		if want[bi] != [2]int64{pos, bits} {
			t.Errorf("built-in %s: position %d permissions %d", bi, pos, bits)
		}
		roleID[bi] = id
	}
	if len(roleID) != 4 {
		t.Fatalf("built-in roles: %v", roleID)
	}
	held := func(user uuid.UUID) []string {
		t.Helper()
		var out []string
		scalar(&out, `SELECT coalesce(array_agg(coalesce(wr.builtin, '') ORDER BY wr.position DESC), '{}') FROM member_roles mr
			JOIN workspace_roles wr ON wr.id = mr.role_id WHERE mr.workspace_id = $1 AND mr.user_id = $2`, ws, user)
		return out
	}
	for role, exp := range map[string][]string{"owner": {"owner", "member"}, "admin": {"admin", "member"}, "member": {"member"}, "guest": {"guest"}} {
		if got := held(users[role]); !slices.Equal(got, exp) {
			t.Errorf("%s holds %v, want %v", role, got, exp)
		}
	}
	var targets []string
	scalar(&targets, `SELECT array_agg(target_id ORDER BY target_type, allow) FROM room_permissions WHERE room_id = $1`, room)
	if !slices.Equal(targets, []string{roleID["member"].String(), roleID["guest"].String(), users["member"].String()}) {
		t.Fatalf("targets after up: %v", targets)
	}
	// Triggers: a new workspace gets its built-ins, a new member / role change follows.
	ws2 := uuid.New()
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-roles-2', 'W2', $2)`, ws2, users["owner"])
	var n int
	scalar(&n, `SELECT count(*) FROM workspace_roles WHERE workspace_id = $1 AND builtin IS NOT NULL`, ws2)
	if n != 4 {
		t.Fatalf("new workspace: %d built-in roles", n)
	}
	custom := uuid.New()
	exec(`INSERT INTO workspace_roles (id, workspace_id, name, position, permissions) VALUES ($1, $2, 'mods', 2, 128)`, custom, ws)
	exec(`INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES ($1, $2, $3)`, ws, users["member"], custom)
	exec(`INSERT INTO room_permissions (room_id, target_type, target_id, allow) VALUES ($1, 'role', $2::text, 1)`, room, custom)
	exec(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`, ws, users["member"])
	if got := held(users["member"]); !slices.Equal(got, []string{"admin", "", "member"}) {
		t.Fatalf("after promotion to admin: %v (custom role kept)", got)
	}
	exec(`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, ws, users["admin"])
	if got := held(users["admin"]); !slices.Equal(got, []string{"guest"}) {
		t.Fatalf("after demotion to guest: %v", got)
	}
	// A guest and a member joining the new workspace get their built-in role by trigger.
	exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'guest'), ($1, $3, 'member')`, ws2, users["guest"], users["member"])
	scalar(&n, `SELECT count(*) FROM member_roles mr JOIN workspace_roles wr ON wr.id = mr.role_id
		WHERE mr.workspace_id = $1 AND wr.workspace_id = $1 AND wr.builtin IN ('guest', 'member')`, ws2)
	if n != 2 {
		t.Fatalf("new guest / member in a new workspace: %d built-in roles", n)
	}
	exec(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, ws, users["guest"])
	scalar(&n, `SELECT count(*) FROM member_roles WHERE workspace_id = $1 AND user_id = $2`, ws, users["guest"])
	if n != 0 {
		t.Fatal("member_roles of a removed member left behind")
	}

	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 20); err != nil {
		t.Fatalf("down to 20: %v", err)
	}
	scalar(&targets, `SELECT array_agg(target_id ORDER BY target_type, target_id) FROM room_permissions WHERE room_id = $1`, room)
	if !slices.Equal(targets, []string{"guest", "member", users["member"].String()}) {
		t.Fatalf("targets after down (custom role override dropped): %v", targets)
	}
	var reg *string
	scalar(&reg, `SELECT to_regclass('workspace_roles')::text`)
	if reg != nil {
		t.Fatal("workspace_roles survived down")
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	scalar(&n, `SELECT count(*) FROM member_roles WHERE workspace_id = $1`, ws)
	if n != 5 { // owner 2, member→admin 2, admin→guest 1
		t.Fatalf("member_roles after up again: %d", n)
	}
}
