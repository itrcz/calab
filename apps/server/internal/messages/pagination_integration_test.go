//go:build integration

package messages

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// seedRoom creates a user, a workspace, a room with n messages (every 7th soft-deleted) and 50
// other rooms with `other` messages each, written after the big room's (statistics like a real
// workspace: room_id selective), and returns the big room and its live message ids, oldest first.
func seedRoom(ctx context.Context, t *testing.T, pool *pgxpool.Pool, n, other int) (room uuid.UUID, live []uuid.UUID) {
	t.Helper()
	user, ws := uuid.New(), uuid.New()
	room = uuid.New()
	steps := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Pager')`, []any{user, user.String() + "@pages.test"}},
		{`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Pages', $3)`, []any{ws, "pg-" + ws.String()[:12], user}},
		{`INSERT INTO rooms (id, workspace_id, type, name) VALUES ($1, $2, 'text', 'big')`, []any{room, ws}},
		{`INSERT INTO rooms (workspace_id, type, name) SELECT $1, 'text', 'other' || g FROM generate_series(1, 50) g`, []any{ws}},
		{`INSERT INTO messages (room_id, author_id, content, deleted_at)
		  SELECT $1, $2, 'message ' || g, CASE WHEN g % 7 = 0 THEN now() END FROM generate_series(1, $3::int) g`, []any{room, user, n}},
		{`INSERT INTO messages (room_id, author_id, content)
		  SELECT r.id, $2, 'other ' || g FROM generate_series(1, $3::int) g, rooms r WHERE r.workspace_id = $1 AND r.id <> $4`, []any{ws, user, other, room}},
		{`ANALYZE messages`, nil},
	}
	for _, s := range steps {
		if _, err := pool.Exec(ctx, s.sql, s.args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, s.sql)
		}
	}
	return room, roomIDs(ctx, t, pool, room)
}

// roomIDs returns the live message ids of a room, oldest first.
func roomIDs(ctx context.Context, t *testing.T, pool *pgxpool.Pool, room uuid.UUID) []uuid.UUID {
	t.Helper()
	var ids []uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM messages WHERE room_id = $1 AND deleted_at IS NULL`, room).Scan(&ids); err != nil {
		t.Fatal(err)
	}
	return ids
}

// deletedID is a soft-deleted message of the room in the middle of its history (a cursor the
// client can hold when the row was deleted after it loaded).
func deletedID(ctx context.Context, t *testing.T, pool *pgxpool.Pool, room uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM messages WHERE room_id = $1 AND deleted_at IS NOT NULL ORDER BY id OFFSET 100 LIMIT 1`, room).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// smallRoom is one of the 50 small rooms next to `room`.
func smallRoom(ctx context.Context, t *testing.T, pool *pgxpool.Pool, room uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM rooms WHERE name = 'other1' AND workspace_id = (SELECT workspace_id FROM rooms WHERE id = $1)`, room).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// planNode is the part of EXPLAIN (FORMAT JSON) these tests read.
type planNode struct {
	NodeType    string     `json:"Node Type"`
	IndexName   string     `json:"Index Name"`
	IndexCond   string     `json:"Index Cond"`
	RowsRemoved float64    `json:"Rows Removed by Filter"`
	Plans       []planNode `json:"Plans"`
}

func (p planNode) scans() []planNode {
	var out []planNode
	if strings.Contains(p.NodeType, "Scan") {
		out = append(out, p)
	}
	for _, c := range p.Plans {
		out = append(out, c.scans()...)
	}
	return out
}

// explainPrepared runs EXPLAIN ANALYZE of a prepared statement; returns the plan and the time.
func explainPrepared(ctx context.Context, t *testing.T, conn *pgxpool.Conn, stmt, args string) (planNode, float64) {
	t.Helper()
	var raw []byte
	if err := conn.QueryRow(ctx, fmt.Sprintf(`EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE %q(%s)`, stmt, args)).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var out []struct {
		Plan          planNode `json:"Plan"`
		ExecutionTime float64  `json:"Execution Time"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out) == 0 {
		t.Fatalf("explain: %v %s", err, raw)
	}
	return out[0].Plan, out[0].ExecutionTime
}

// preparedStatement is the server-side name (or text) of the statement pgx prepared for a query.
func preparedStatement(ctx context.Context, t *testing.T, conn *pgxpool.Conn, column, query string) string {
	t.Helper()
	var v string
	if err := conn.QueryRow(ctx, `SELECT `+column+` FROM pg_prepared_statements WHERE statement LIKE '-- name: ' || $1 || ' %'`, query).Scan(&v); err != nil {
		t.Fatalf("prepared %s: %v", query, err)
	}
	return v
}

func idsOf(ms []sqlc.Message) []uuid.UUID {
	out := make([]uuid.UUID, len(ms))
	for i, m := range ms {
		out[i] = m.ID
	}
	return out
}

// TestListMessagesGenericPlan: history pages (both directions) are correct for every cursor
// combination, and under a generic cached plan (pgx prepares statements; PostgreSQL switches to
// the generic plan after five runs) every page is one range scan of the room's slice of a
// (room_id, id) index — not the room walked through a Filter from its newest message (the old
// "$2 IS NULL OR id < $2", 1.7–2.7 s at 1.5M rows, docs/14), and not messages_pkey across all
// rooms (what "room_id = $1 AND id < $2" gets at the start of a small room's history).
func TestListMessagesGenericPlan(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	room, live := seedRoom(ctx, t, d.Pool, 20000, 400)
	small := smallRoom(ctx, t, d.Pool, room)
	smallIDs := roomIDs(ctx, t, d.Pool, small)
	var empty uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO rooms (workspace_id, type, name) SELECT workspace_id, 'text', 'empty' FROM rooms WHERE id = $1 RETURNING id`, room).Scan(&empty); err != nil {
		t.Fatal(err)
	}
	conn, err := d.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SET plan_cache_mode = force_generic_plan`); err != nil {
		t.Fatal(err)
	}
	q := sqlc.New(conn)

	at := func(ids []uuid.UUID, i int) *uuid.UUID { return &ids[i] }
	newestFirst := func(ids []uuid.UUID, from, to int) []uuid.UUID {
		out := slices.Clone(ids[from:to])
		slices.Reverse(out)
		return out
	}
	n, ns := len(live), len(smallIDs)
	before := []struct {
		name          string
		room          uuid.UUID
		before, since *uuid.UUID
		want          []uuid.UUID
	}{
		{"newest page", room, nil, nil, newestFirst(live, n-51, n)},
		{"before, deep", room, at(live, 100), nil, newestFirst(live, 49, 100)},
		{"before, near the start", room, at(live, 10), nil, newestFirst(live, 0, 10)},
		{"since only (cleared DM)", room, nil, at(live, n-20), newestFirst(live, n-19, n)},
		{"before and since", room, at(live, 500), at(live, 480), newestFirst(live, 481, 500)},
		{"before the newest", room, at(live, n-1), nil, newestFirst(live, n-52, n-1)},
		{"empty: before the first", room, at(live, 0), nil, nil},
		{"empty: since the newest", room, nil, at(live, n-1), nil},
		{"empty: since past before", room, at(live, 480), at(live, 500), nil},
		{"small room, near its start", small, at(smallIDs, 30), nil, newestFirst(smallIDs, 0, 30)},
		{"small room, newest page", small, nil, nil, newestFirst(smallIDs, ns-51, ns)},
		{"small room, since its first", small, nil, at(smallIDs, 0), newestFirst(smallIDs, ns-51, ns)},
		{"small room, cursor from the big room", small, at(live, 0), nil, nil}, // the big room's ids are older
		{"empty room, newest page", empty, nil, nil, nil},
		{"empty room, cursor", empty, at(live, 100), at(live, 10), nil},
	}
	after := []struct {
		name  string
		room  uuid.UUID
		after uuid.UUID
		want  []uuid.UUID
	}{
		{"after, deep", room, live[100], live[101:152]},
		{"after, near the end", room, live[n-10], live[n-9:]},
		{"after the last", room, live[n-1], []uuid.UUID{}},
		{"after the first", room, live[0], live[1:52]},
		{"after a soft-deleted row", room, deletedID(ctx, t, d.Pool, room), nil}, // want: filled from the old query
		{"small room, near its end", small, smallIDs[ns-30], smallIDs[ns-29:]},
		{"small room, cursor from the big room", small, live[0], smallIDs[:51]}, // the big room's ids are older
		{"empty room", empty, live[0], []uuid.UUID{}},
	}
	// The queries before the rewrite are the reference: every page must match them row for row.
	old := func(query string, args ...any) []uuid.UUID {
		rows, err := d.Pool.Query(ctx, strings.Replace(query, "SELECT *", "SELECT id", 1), args...)
		if err != nil {
			t.Fatal(err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	for round := 0; round < 2; round++ { // the second round runs on the cached generic plans
		for _, c := range before {
			ms, err := q.ListMessagesBefore(ctx, sqlc.ListMessagesBeforeParams{RoomID: c.room, Before: c.before, Since: c.since, Lim: 51})
			if err != nil {
				t.Fatal(err)
			}
			got := idsOf(ms)
			if !slices.Equal(got, c.want) {
				t.Fatalf("%s: %d rows, want %d", c.name, len(got), len(c.want))
			}
			if ref := old(listMessagesBeforeOld, c.room, c.before, c.since, 51); !slices.Equal(got, ref) {
				t.Fatalf("%s: differs from the old query (%d rows, old %d)", c.name, len(got), len(ref))
			}
		}
		for _, c := range after {
			ms, err := q.ListMessagesAfter(ctx, sqlc.ListMessagesAfterParams{RoomID: c.room, After: c.after, Lim: 51})
			if err != nil {
				t.Fatal(err)
			}
			got, ref := idsOf(ms), old(listMessagesAfterOld, c.room, c.after, 51)
			if c.want != nil && !slices.Equal(got, c.want) {
				t.Fatalf("%s: %d rows, want %d", c.name, len(got), len(c.want))
			}
			if !slices.Equal(got, ref) || len(ref) == 0 && c.want == nil {
				t.Fatalf("%s: differs from the old query (%d rows, old %d)", c.name, len(got), len(ref))
			}
		}
	}

	for _, c := range []struct{ what, query, args string }{
		{"before, deep", "ListMessagesBefore", fmt.Sprintf("'%s', '%s', NULL, 51", room, live[100])},
		{"before, newest", "ListMessagesBefore", fmt.Sprintf("'%s', NULL, NULL, 51", room)},
		{"before, small room near its start", "ListMessagesBefore", fmt.Sprintf("'%s', '%s', NULL, 51", small, smallIDs[30])},
		{"after, small room near its end", "ListMessagesAfter", fmt.Sprintf("'%s', '%s', 51", small, smallIDs[ns-30])},
	} {
		plan, ms := explainPrepared(ctx, t, conn, preparedStatement(ctx, t, conn, "name", c.query), c.args)
		scans := plan.scans()
		if len(scans) != 1 || scans[0].IndexName == "messages_pkey" || !strings.Contains(scans[0].IndexCond, "ROW(room_id, id)") || scans[0].RowsRemoved > 20 {
			t.Fatalf("%s: not a range scan of the room's index slice: %+v", c.what, scans)
		}
		t.Logf("%-34s %s on %s, %.3f ms", c.what, scans[0].NodeType, scans[0].IndexName, ms)
	}
}

// The queries before the row-comparison rewrite (the reference for page contents and
// TestListMessagesPerf's before/after numbers), and the obvious split without "IS NULL OR"
// (messages_pkey under a generic plan).
const (
	listMessagesBeforeOld = `SELECT * FROM messages
WHERE room_id = $1 AND deleted_at IS NULL
  AND ($2::uuid IS NULL OR id < $2::uuid)
  AND ($3::uuid IS NULL OR id > $3::uuid)
ORDER BY id DESC
LIMIT $4`
	listMessagesBeforeSplit = `SELECT * FROM messages
WHERE room_id = $1 AND deleted_at IS NULL AND id < $2::uuid
ORDER BY id DESC
LIMIT $3`
	listMessagesAfterOld = `SELECT * FROM messages
WHERE room_id = $1 AND deleted_at IS NULL AND id > $2::uuid
ORDER BY id ASC
LIMIT $3`
)

// TestListMessagesPerf: EXPLAIN ANALYZE of the old and the new pagination queries under
// force_generic_plan, one big room among 50 small ones (docs/14). Opt-in:
//
//	CALABA_PAGINATION_PERF_URL=postgres://…/calaba_test_chatscale go test -tags integration -run TestListMessagesPerf -v ./internal/messages/
//
// The database is migrated here and seeded once (CALABA_PAGINATION_PERF_ROWS, default 1500000).
func TestListMessagesPerf(t *testing.T) {
	dsn := os.Getenv("CALABA_PAGINATION_PERF_URL")
	if dsn == "" {
		t.Skip("set CALABA_PAGINATION_PERF_URL to run the pagination benchmark")
	}
	ctx := context.Background()
	d, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	rows := 1500000
	if v := os.Getenv("CALABA_PAGINATION_PERF_ROWS"); v != "" {
		_, _ = fmt.Sscan(v, &rows)
	}
	var room uuid.UUID
	if err := d.Pool.QueryRow(ctx, `SELECT id FROM rooms WHERE name = 'big' LIMIT 1`).Scan(&room); err != nil {
		start := time.Now()
		room, _ = seedRoom(ctx, t, d.Pool, rows, 10000)
		t.Logf("seeded %d messages in %s", rows, time.Since(start).Round(time.Second))
	}
	live := roomIDs(ctx, t, d.Pool, room)
	small := smallRoom(ctx, t, d.Pool, room)
	smallIDs := roomIDs(ctx, t, d.Pool, small)
	// Cursors: deep in the big room's history (the old shape walks the room from its newest
	// message), near its newest end, and near the ends of a small room (the plain split walks
	// messages_pkey through the other rooms there).
	deep, recent := live[1000], live[len(live)-1000]
	smallStart, smallEnd := smallIDs[30], smallIDs[len(smallIDs)-30]

	conn, err := d.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	q := sqlc.New(conn)
	if _, err := q.ListMessagesBefore(ctx, sqlc.ListMessagesBeforeParams{RoomID: room, Lim: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ListMessagesAfter(ctx, sqlc.ListMessagesAfterParams{RoomID: room, After: deep, Lim: 1}); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{
		`SET plan_cache_mode = force_generic_plan`,
		`PREPARE before_old AS ` + listMessagesBeforeOld,
		`PREPARE before_split AS ` + listMessagesBeforeSplit,
		`PREPARE before_new AS ` + preparedStatement(ctx, t, conn, "statement", "ListMessagesBefore"),
		`PREPARE after_old AS ` + listMessagesAfterOld,
		`PREPARE after_new AS ` + preparedStatement(ctx, t, conn, "statement", "ListMessagesAfter"),
	} {
		if _, err := conn.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	type run struct{ stmt, args string }
	b3 := func(r, c uuid.UUID) string { return fmt.Sprintf("'%s', '%s', NULL, 51", r, c) }
	b2 := func(r, c uuid.UUID) string { return fmt.Sprintf("'%s', '%s', 51", r, c) }
	newest := fmt.Sprintf("'%s', NULL, NULL, 51", room)
	for _, c := range []struct {
		name string
		runs []run
	}{
		{"before: big room, deep", []run{{"before_old", b3(room, deep)}, {"before_split", b2(room, deep)}, {"before_new", b3(room, deep)}}},
		{"before: big room, recent", []run{{"before_old", b3(room, recent)}, {"before_split", b2(room, recent)}, {"before_new", b3(room, recent)}}},
		{"before: big room, newest", []run{{"before_old", newest}, {"before_new", newest}}},
		{"before: small room, start", []run{{"before_old", b3(small, smallStart)}, {"before_split", b2(small, smallStart)}, {"before_new", b3(small, smallStart)}}},
		{"after: big room, deep", []run{{"after_old", b2(room, deep)}, {"after_new", b2(room, deep)}}},
		{"after: small room, end", []run{{"after_old", b2(small, smallEnd)}, {"after_new", b2(small, smallEnd)}}},
	} {
		for _, r := range c.runs {
			best := 0.0
			var plan planNode
			for i := 0; i < 3; i++ { // warm, then the best of the rest
				p, ms := explainPrepared(ctx, t, conn, r.stmt, r.args)
				if i == 0 || ms < best {
					best, plan = ms, p
				}
			}
			s := plan.scans()
			if len(s) == 0 {
				t.Fatalf("%s %s: no scan in the plan", c.name, r.stmt)
			}
			t.Logf("%-26s %-12s %9.3f ms · %s %s · removed by filter %.0f", c.name, r.stmt, best, s[0].NodeType, s[0].IndexName, s[0].RowsRemoved)
		}
	}
}
