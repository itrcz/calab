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

// TestBoardsV2Migration (ADR-0058, migration 00059) on a populated database: existing boards get
// the defaults (no category, no disabled features, fibonacci), tasks is not altered at all
// (pg_attribute), the new tables accept rows and enforce their checks, and 00059 goes down
// (tables and columns gone, data of older tables intact) and up again.
func TestBoardsV2Migration(t *testing.T) {
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
	// The shape of tasks: every live column with its type, nullability and default.
	tasksShape := func() string {
		t.Helper()
		var s string
		if err := d.Pool.QueryRow(ctx, `SELECT string_agg(a.attname || ':' || a.atttypid::regtype::text || ':' || a.attnotnull::text
			|| ':' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), ',' ORDER BY a.attnum)
			FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
			WHERE a.attrelid = 'tasks'::regclass AND a.attnum > 0 AND NOT a.attisdropped`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if err := d.MigrateTo(ctx, 58); err != nil {
		t.Fatal(err)
	}
	owner, ws, board, status, task := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	must(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'o')`, owner, "o-"+owner.String()[:8]+"@example.com")
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-b2', 'W', $2)`, ws, owner)
	must(`INSERT INTO boards (id, workspace_id, name, key, position) VALUES ($1, $2, 'B', 'BB', 3)`, board, ws)
	must(`INSERT INTO board_statuses (id, board_id, name, type, is_default) VALUES ($1, $2, 'Todo', 'unstarted', true)`, status, board)
	var room uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'BB-1', 'task') RETURNING id`, ws).Scan(&room); err != nil {
		t.Fatal(err)
	}
	must(`INSERT INTO tasks (id, board_id, number, title, status_id, room_id, estimate, created_by) VALUES ($1, $2, 1, 'T', $3, $4, 5, $5)`, task, board, status, room, owner)
	before := tasksShape()

	// Up to 00059 only: later migrations change tasks on purpose (00066 task_milestone_id, ADR-0063).
	if err := d.MigrateTo(ctx, 59); err != nil {
		t.Fatal(err)
	}
	if got := tasksShape(); got != before {
		t.Fatalf("tasks changed:\n%s\n%s", before, got)
	}
	var (
		category *uuid.UUID
		disabled int64
		scale    string
		position int32
	)
	if err := d.Pool.QueryRow(ctx, `SELECT category_id, disabled_features, estimate_scale, position FROM boards WHERE id = $1`, board).
		Scan(&category, &disabled, &scale, &position); err != nil {
		t.Fatal(err)
	}
	if category != nil || disabled != 0 || scale != "fibonacci" || position != 3 {
		t.Fatalf("board defaults: %v %d %q %d", category, disabled, scale, position)
	}
	if err := exec(`UPDATE boards SET estimate_scale = 'hours' WHERE id = $1`, board); err == nil {
		t.Fatal("an unknown estimate scale was accepted")
	}

	cat := uuid.New()
	must(`INSERT INTO board_categories (id, workspace_id, name) VALUES ($1, $2, 'C')`, cat, ws)
	must(`UPDATE boards SET category_id = $2, disabled_features = 4096, estimate_scale = 'tshirt' WHERE id = $1`, board, cat)
	list, item := uuid.New(), uuid.New()
	must(`INSERT INTO task_checklists (id, task_id, title, created_by) VALUES ($1, $2, 'L', $3)`, list, task, owner)
	must(`INSERT INTO task_checklist_items (id, checklist_id, task_id, text, done, done_by, done_at) VALUES ($1, $2, $3, 'i', true, $4, now())`, item, list, task, owner)
	if err := exec(`INSERT INTO task_checklist_items (checklist_id, task_id, text, done_by) VALUES ($1, $2, 'x', $3)`, list, task, owner); err == nil {
		t.Fatal("an undone item with done_by was accepted")
	}
	if err := exec(`INSERT INTO task_checklists (task_id, title) VALUES ($1, '')`, task); err == nil {
		t.Fatal("an empty checklist title was accepted")
	}
	must(`INSERT INTO board_webhooks (board_id, url, secret_enc, created_by) VALUES ($1, 'https://example.com/hook', '\x00', $2)`, board, owner)
	if err := exec(`INSERT INTO board_webhooks (board_id, url, secret_enc) VALUES ($1, 'http://example.com/hook', '\x00')`, board); err == nil {
		t.Fatal("a second / non-https webhook was accepted")
	}
	must(`INSERT INTO board_webhook_deliveries (board_id, seq, event_type, payload) VALUES ($1, 1, 'task.updated', '{}')`, board)
	// Deleting a category releases its boards; deleting the board cascades the rest.
	must(`DELETE FROM board_categories WHERE id = $1`, cat)
	if err := d.Pool.QueryRow(ctx, `SELECT category_id FROM boards WHERE id = $1`, board).Scan(&category); err != nil || category != nil {
		t.Fatalf("category delete: %v %v", category, err)
	}

	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 58); err != nil {
		t.Fatalf("down to 58: %v", err)
	}
	for _, q := range []string{`SELECT 1 FROM board_categories`, `SELECT 1 FROM task_checklists`, `SELECT 1 FROM task_checklist_items`,
		`SELECT 1 FROM board_webhooks`, `SELECT 1 FROM board_webhook_deliveries`, `SELECT category_id FROM boards`,
		`SELECT disabled_features FROM boards`, `SELECT estimate_scale FROM boards`} {
		if err := exec(q); err == nil {
			t.Fatalf("survived down: %s", q)
		}
	}
	if got := tasksShape(); got != before {
		t.Fatalf("tasks changed after down:\n%s\n%s", before, got)
	}
	var estimate int16
	if err := d.Pool.QueryRow(ctx, `SELECT estimate FROM tasks WHERE id = $1`, task).Scan(&estimate); err != nil || estimate != 5 {
		t.Fatalf("task data after down: %d %v", estimate, err)
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
}
