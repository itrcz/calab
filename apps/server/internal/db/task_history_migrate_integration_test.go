//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestTaskHistoryBackfill (ADR-0091, migration 00085) on a populated database: uuidv7_at makes
// version-7 ids ordered as their times; every live comment of a task room gets one "comment"
// entry (author, time, text, files) — not deleted messages, not automation cards, not one that
// already has its entry; the entries sort by id as by time; down and up again adds nothing.
func TestTaskHistoryBackfill(t *testing.T) {
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
	if err := d.MigrateTo(ctx, 84); err != nil {
		t.Fatal(err)
	}
	owner, bob, ws, board, status, task, file := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{owner, bob} {
		must(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')`, id, "u-"+id.String()[:8]+"@example.com")
	}
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-hist', 'W', $2)`, ws, owner)
	must(`INSERT INTO boards (id, workspace_id, name, key, position) VALUES ($1, $2, 'B', 'BB', 0)`, board, ws)
	must(`INSERT INTO board_statuses (id, board_id, name, type, is_default) VALUES ($1, $2, 'Todo', 'unstarted', true)`, status, board)
	var room, chat uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'BB-1', 'task') RETURNING id`, ws).Scan(&room); err != nil {
		t.Fatal(err)
	}
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, name, type) VALUES ($1, 'chat', 'text') RETURNING id`, ws).Scan(&chat); err != nil {
		t.Fatal(err)
	}
	must(`INSERT INTO tasks (id, board_id, number, title, status_id, room_id, created_by) VALUES ($1, $2, 1, 'T', $3, $4, $5)`, task, board, status, room, owner)
	must(`INSERT INTO files (id, workspace_id, uploader_id, key, name, mime, size, sha256) VALUES ($1, $2, $3, 'k', 'отчёт.pdf', 'application/pdf', 1234, 'x')`, file, ws, bob)

	// Comments at known times, inserted out of time order; 2 and 3 within one millisecond.
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	m1, m2, m3, gone, card, other, done := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	msg := func(id, room, author uuid.UUID, text string, at time.Time) {
		t.Helper()
		must(`INSERT INTO messages (id, room_id, author_id, content, created_at) VALUES ($1, $2, $3, $4, $5)`, id, room, author, text, at)
	}
	msg(m3, room, owner, "третий", t0.Add(2*time.Second+300*time.Microsecond))
	msg(m1, room, bob, "первый", t0)
	msg(m2, room, bob, "", t0.Add(2*time.Second+100*time.Microsecond))
	must(`INSERT INTO message_attachments (message_id, file_id, position) VALUES ($1, $2, 0)`, m2, file)
	msg(gone, room, bob, "удалён", t0.Add(time.Second))
	must(`UPDATE messages SET deleted_at = now() WHERE id = $1`, gone)
	must(`INSERT INTO messages (id, room_id, author_id, content, kind, payload, created_at) VALUES ($1, $2, $3, '', 'system', '{}', $4)`, card, room, owner, t0)
	msg(other, chat, bob, "не задача", t0)
	// Written live by a newer server before the migration: kept, not duplicated.
	msg(done, room, owner, "уже в журнале", t0.Add(3*time.Second))
	must(`INSERT INTO task_activity (task_id, board_id, actor_id, kind, after) VALUES ($1, $2, $3, 'comment', $4)`,
		task, board, owner, `{"message_id": "`+done.String()+`", "text": "уже в журнале", "attachments": []}`)

	if err := d.MigrateTo(ctx, 85); err != nil {
		t.Fatal(err)
	}

	// uuidv7_at: version 7, RFC variant, the time in the first 48 bits, ordered as the times.
	var ok bool
	if err := d.Pool.QueryRow(ctx, `WITH ts AS (
			SELECT g, timestamptz '2026-10-01 12:00:00+00' + g * interval '7 microseconds' + (g % 5) * interval '1 hour' AS at
			FROM generate_series(1, 5000) g),
		ids AS (SELECT at, public.uuidv7_at(at) AS id FROM ts)
		SELECT bool_and(substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
				AND ('x' || substr(replace(id::text, '-', ''), 1, 12))::bit(48)::bigint = floor(extract(epoch FROM at) * 1000)::bigint)
			AND (SELECT array_agg(at ORDER BY id) = array_agg(at ORDER BY at) FROM ids)
		FROM ids`).Scan(&ok); err != nil || !ok {
		t.Fatalf("uuidv7_at layout / order: %v %v", ok, err)
	}

	type entry struct {
		id, actor uuid.UUID
		at        time.Time
		after     map[string]any
	}
	read := func() []entry {
		t.Helper()
		rows, err := d.Pool.Query(ctx, `SELECT id, actor_id, created_at, after FROM task_activity WHERE task_id = $1 AND kind = 'comment' ORDER BY id`, task)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []entry
		for rows.Next() {
			var e entry
			var raw []byte
			if err := rows.Scan(&e.id, &e.actor, &e.at, &raw); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &e.after); err != nil {
				t.Fatal(err)
			}
			out = append(out, e)
		}
		return out
	}
	got := read()
	var order []string
	for _, e := range got {
		order = append(order, e.after["message_id"].(string))
	}
	if want := []string{m1.String(), m2.String(), m3.String(), done.String()}; !slices.Equal(order, want) {
		t.Fatalf("entries by id: %v, want %v", order, want)
	}
	if e := got[0]; e.actor != bob || !e.at.Equal(t0) || e.after["text"] != "первый" || e.after["forwarded"] != false ||
		len(e.after["attachments"].([]any)) != 0 {
		t.Fatalf("first comment: %+v", e)
	}
	files := got[1].after["attachments"].([]any)
	if f, _ := files[0].(map[string]any); len(files) != 1 || f["file_id"] != file.String() || f["name"] != "отчёт.pdf" || f["mime"] != "application/pdf" || f["size"] != float64(1234) {
		t.Fatalf("files of a comment: %v", files)
	}
	if got[2].actor != owner || got[2].after["text"] != "третий" {
		t.Fatalf("third comment: %+v", got[2])
	}

	// Down and up again: nothing new.
	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 84); err != nil {
		t.Fatalf("down to 84: %v", err)
	}
	if err := d.MigrateTo(ctx, 85); err != nil {
		t.Fatal(err)
	}
	if again := read(); len(again) != len(got) || again[0].id != got[0].id {
		t.Fatalf("re-run: %d entries, was %d", len(again), len(got))
	}
}
