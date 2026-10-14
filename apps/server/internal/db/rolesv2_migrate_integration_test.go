//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestRolesV2Migration (ADR-0048, migration 00052): every role holding MANAGE_WORKSPACE gets the
// seven new bits, the others (member, guest, a custom role without it) none; boards.restricted
// exists only on private boards; 00052 goes down (bits and column gone) and up again.
func TestRolesV2Migration(t *testing.T) {
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
	exec := func(sql string, args ...any) error {
		_, err := d.Pool.Exec(ctx, sql, args...)
		return err
	}
	must := func(sql string, args ...any) {
		t.Helper()
		if err := exec(sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	perms := func(id uuid.UUID) int64 {
		t.Helper()
		var p int64
		if err := d.Pool.QueryRow(ctx, `SELECT permissions FROM workspace_roles WHERE id = $1`, id).Scan(&p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if err := d.MigrateTo(ctx, 51); err != nil {
		t.Fatal(err)
	}
	const (
		manageWorkspace = 512
		v2              = int64(0xFE000000) // CREATE_BOARDS .. MANAGE_RECORDINGS
	)
	owner, ws := uuid.New(), uuid.New()
	must(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'o')`, owner, "o-"+owner.String()[:8]+"@example.com")
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-v2', 'W', $2)`, ws, owner)
	mgr, other := uuid.New(), uuid.New()
	must(`INSERT INTO workspace_roles (id, workspace_id, name, position, permissions) VALUES
		($1, $3, 'mgr', 2, $4), ($2, $3, 'other', 3, 256)`, mgr, other, ws, manageWorkspace|32768)
	var memberRole, guestRole uuid.UUID
	var memberBefore int64
	if err := d.Pool.QueryRow(ctx, `SELECT id, permissions FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'member'`, ws).Scan(&memberRole, &memberBefore); err != nil {
		t.Fatal(err)
	}
	if err := d.Pool.QueryRow(ctx, `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'guest'`, ws).Scan(&guestRole); err != nil {
		t.Fatal(err)
	}
	board := uuid.New()
	must(`INSERT INTO boards (id, workspace_id, name, key, is_private) VALUES ($1, $2, 'B', 'BB', true)`, board, ws)

	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if got := perms(mgr); got != manageWorkspace|32768|v2 {
		t.Fatalf("MANAGE_WORKSPACE role: %d, want the seven bits added", got)
	}
	if got := perms(other); got != 256 {
		t.Fatalf("a role without MANAGE_WORKSPACE: %d", got)
	}
	// Only 00088 (ADR-0094) adds DISK_VIEW | DISK_WRITE and 00090 (ADR-0096) WIKI_VIEW |
	// WIKI_WRITE to the member role.
	if got := perms(memberRole); got != memberBefore|3<<35|3<<38 {
		t.Fatalf("member role changed: %d → %d", memberBefore, got)
	}
	if got := perms(guestRole); got&v2 != 0 {
		t.Fatalf("guest role got the new bits: %d", got)
	}
	var restricted bool
	if err := d.Pool.QueryRow(ctx, `SELECT restricted FROM boards WHERE id = $1`, board).Scan(&restricted); err != nil || restricted {
		t.Fatalf("boards.restricted default: %v %v", restricted, err)
	}
	must(`UPDATE boards SET restricted = true WHERE id = $1`, board)
	if err := exec(`UPDATE boards SET is_private = false WHERE id = $1`, board); err == nil {
		t.Fatal("a closed board became public")
	}

	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 51); err != nil {
		t.Fatalf("down to 51: %v", err)
	}
	if got := perms(mgr); got != manageWorkspace|32768 {
		t.Fatalf("after down: %d, want the seven bits removed", got)
	}
	if err := exec(`SELECT restricted FROM boards`); err == nil {
		t.Fatal("boards.restricted survived down")
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if got := perms(mgr); got != manageWorkspace|32768|v2 {
		t.Fatalf("up again: %d", got)
	}
}
