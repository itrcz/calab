//go:build integration

package search

import (
	"context"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestSearchPerf seeds a large workspace and records EXPLAIN ANALYZE of every section and the
// latency of the summary (ADR-0062 §6, docs/14). Opt-in, it takes minutes:
//
//	CALABA_SEARCH_PERF_URL=postgres://…/calaba_search_perf go test -tags integration -run TestSearchPerf -v ./internal/search/
//
// The database is created by the caller, migrated here and seeded once (kept for reruns).
// CALABA_SEARCH_PERF_BIG (default 1000000) messages go into one room, 200000 more into 50 rooms.
func TestSearchPerf(t *testing.T) {
	dsn := os.Getenv("CALABA_SEARCH_PERF_URL")
	if dsn == "" {
		t.Skip("set CALABA_SEARCH_PERF_URL to run the search benchmark")
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
	big := 1000000
	if v := os.Getenv("CALABA_SEARCH_PERF_BIG"); v != "" {
		_, _ = fmt.Sscan(v, &big)
	}
	ws, user := seedPerf(ctx, t, d, big)

	// A pool that records the statements of a section, to replay them under EXPLAIN.
	rec := &recorder{}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.ConnConfig.Tracer = rec
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	traced := &db.DB{Pool: pool, Q: sqlc.New(pool)}
	s := New(traced)
	s.Timeout = 60 * time.Second // measure, do not cut

	ctx = perm.WithResolver(ctx, d.Q)
	request := func(qs string) (*request, *scope) {
		r := httptest.NewRequestWithContext(ctx, "GET", "/api/search?"+qs, nil)
		req, err := parseRequest(r, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		sc, err := s.buildScope(ctx, req, user, false)
		if err != nil {
			t.Fatal(err)
		}
		return req, sc
	}
	var report strings.Builder
	explain := func(name string, typ v1.SearchType, qs string) {
		req, sc := request(qs)
		rec.reset()
		start := time.Now()
		sec, err := s.section(ctx, typ, req, sc, s.sectionFn(typ))
		dur := time.Since(start)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&report, "\n=== %s [%s] %s: %v, %d hits, total %d, timed_out %v\n", name, typ, qs, dur.Round(100*time.Microsecond),
			len(sec.GetItems()), sec.GetTotalEstimate(), sec.GetTimedOut())
		report.WriteString(rec.explain(ctx, t, d))
	}
	scope := "&scope=" + ws.String()
	// Messages: the three plans of the lead's audit (absent / rare / frequent word).
	explain("messages absent", stMessages, q("отсутствующееслово")+scope)
	explain("messages rare", stMessages, q("редкослово")+scope)
	explain("messages frequent", stMessages, q("wfreq")+scope)
	explain("messages frequent feed by relevance", stMessages, q("wfreq")+scope+"&type=messages")
	explain("messages prefix", stMessages, q("wfr")+scope)
	explain("task comments", stTaskComments, q("wfreq")+scope)
	explain("tasks", stTasks, q("задача")+scope)
	explain("tasks typo", stTasks, q("задча")+scope)
	explain("tasks key", stTasks, q("PRF-123")+scope)
	explain("events", stEvents, q("встреча")+scope)
	explain("files", stFiles, q("отчёт")+scope)
	explain("files typo", stFiles, q("отчт")+scope)
	explain("transcripts", stTranscripts, q("бюджет")+scope)

	// The plan before ADR-0062 (ORDER BY id DESC LIMIT with the tsvector filter), for comparison.
	rooms := mustRooms(ctx, t, d, ws)
	for _, w := range []string{"отсутствующееслово", "редкослово", "wfreq"} {
		start := time.Now()
		var n int
		err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT id FROM messages WHERE room_id = ANY($1) AND deleted_at IS NULL
			AND (to_tsvector('russian', content) || to_tsvector('simple', content)) @@ (websearch_to_tsquery('russian', $2) || websearch_to_tsquery('simple', $2))
			ORDER BY id DESC LIMIT 26) x`, rooms, w).Scan(&n)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&report, "\nold SearchMessages plan, %q: %v (%d rows)", w, time.Since(start).Round(100*time.Microsecond), n)
	}

	// Summary latency: all sections in parallel, as the handler runs them.
	for _, w := range []string{"wfreq", "редкослово", "встреча отчёт"} {
		req, sc := request(q(w) + scope)
		var ds []time.Duration
		for range 20 {
			start := time.Now()
			if _, err := s.run(ctx, req, sc); err != nil {
				t.Fatal(err)
			}
			ds = append(ds, time.Since(start))
		}
		slices.Sort(ds)
		fmt.Fprintf(&report, "\nsummary %q: p50 %v, p95 %v, max %v", w, ds[len(ds)/2].Round(100*time.Microsecond),
			ds[len(ds)*95/100].Round(100*time.Microsecond), ds[len(ds)-1].Round(100*time.Microsecond))
	}
	t.Log(report.String())
	if out := os.Getenv("CALABA_SEARCH_PERF_REPORT"); out != "" {
		_ = os.WriteFile(out, []byte(report.String()), 0o600) //nolint:gosec // the operator names the report file
	}
}

func q(s string) string { return "q=" + url.QueryEscape(s) }

const (
	stMessages     = v1.SearchType_SEARCH_TYPE_MESSAGES
	stTaskComments = v1.SearchType_SEARCH_TYPE_TASK_COMMENTS
	stTasks        = v1.SearchType_SEARCH_TYPE_TASKS
	stEvents       = v1.SearchType_SEARCH_TYPE_EVENTS
	stFiles        = v1.SearchType_SEARCH_TYPE_FILES
	stTranscripts  = v1.SearchType_SEARCH_TYPE_TRANSCRIPTS
)

func mustRooms(ctx context.Context, t *testing.T, d *db.DB, ws uuid.UUID) []uuid.UUID {
	t.Helper()
	rows, err := d.Pool.Query(ctx, "SELECT id FROM rooms WHERE workspace_id = $1 AND type = 'text'", ws)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

// seedPerf creates (once) the workspace "search-perf": its owner, 51 text rooms (one with big
// messages), 1000 boards' worth of tasks (20000) with comments, 5000 events, 50000 files and
// 300 transcripts. Words: a vocabulary of 2000 with a skewed distribution — "wfreq" is in
// about half of the messages, "редкослово" in 5, "отсутствующееслово" in none.
func seedPerf(ctx context.Context, t *testing.T, d *db.DB, big int) (ws, user uuid.UUID) {
	t.Helper()
	err := d.Pool.QueryRow(ctx, "SELECT id, owner_id FROM workspaces WHERE slug = 'search-perf'").Scan(&ws, &user)
	if err == nil {
		return ws, user
	}
	start := time.Now()
	steps := []string{
		`INSERT INTO users (email, display_name) VALUES ('perf@example.com', 'Perf') ON CONFLICT DO NOTHING`,
		`INSERT INTO workspaces (slug, name, owner_id) SELECT 'search-perf', 'Perf', id FROM users WHERE email = 'perf@example.com'`,
		`INSERT INTO workspace_members (workspace_id, user_id, role) SELECT w.id, w.owner_id, 'owner' FROM workspaces w WHERE slug = 'search-perf'`,
		`INSERT INTO rooms (workspace_id, type, name, position) SELECT w.id, 'text', 'room' || g, g FROM workspaces w, generate_series(0, 50) g WHERE slug = 'search-perf'`,
		`CREATE TEMP TABLE vocab AS SELECT array_agg(CASE WHEN g = 1 THEN 'wfreq' ELSE 'w' || to_hex(g * 7919) END ORDER BY g) AS w FROM generate_series(1, 2000) g`,
		`CREATE TEMP TABLE perf AS SELECT w.id AS ws, w.owner_id AS u,
			(SELECT r.id FROM rooms r WHERE r.workspace_id = w.id AND r.name = 'room0') AS big,
			(SELECT array_agg(r.id) FROM rooms r WHERE r.workspace_id = w.id AND r.name <> 'room0') AS small
		 FROM workspaces w WHERE slug = 'search-perf'`,
		fmt.Sprintf(`INSERT INTO messages (room_id, author_id, content, created_at)
		 SELECT p.big, p.u, (SELECT string_agg(v.w[1 + floor(power(random(), 3) * 2000)::int], ' ') FROM vocab v, generate_series(1, 8) k WHERE g > 0),
		        now() - make_interval(secs => (%d - g) * 30)
		 FROM perf p, generate_series(1, %d) g`, big, big),
		`INSERT INTO messages (room_id, author_id, content, created_at)
		 SELECT p.small[1 + g %% 50], p.u, (SELECT string_agg(v.w[1 + floor(power(random(), 3) * 2000)::int], ' ') FROM vocab v, generate_series(1, 8) k WHERE g > 0),
		        now() - make_interval(secs => (200000 - g) * 60)
		 FROM perf p, generate_series(1, 200000) g`,
		`INSERT INTO messages (room_id, author_id, content) SELECT p.big, p.u, 'редкослово номер ' || g FROM perf p, generate_series(1, 5) g`,
		`INSERT INTO boards (workspace_id, name, key, created_by) SELECT p.ws, 'Perf', 'PRF', p.u FROM perf p`,
		`INSERT INTO board_statuses (board_id, name, type, is_default) SELECT b.id, 'Todo', 'unstarted', true FROM boards b JOIN perf p ON b.workspace_id = p.ws`,
		`CREATE TEMP TABLE trooms AS SELECT g, uuidv7() AS id FROM generate_series(1, 20000) g`,
		`INSERT INTO rooms (id, workspace_id, type, name) SELECT t.id, p.ws, 'task', 'task' FROM trooms t, perf p`,
		`INSERT INTO tasks (board_id, number, title, description, status_id, room_id, created_by)
		 SELECT b.id, t.g, 'Задача ' || (SELECT string_agg(v.w[1 + floor(power(random(), 3) * 2000)::int], ' ') FROM vocab v, generate_series(1, 4) k WHERE t.g > 0),
		        'описание ' || t.g, s.id, t.id, p.u
		 FROM trooms t, perf p JOIN boards b ON b.workspace_id = p.ws JOIN board_statuses s ON s.board_id = b.id`,
		`INSERT INTO messages (room_id, author_id, content) SELECT t.id, p.u, 'комментарий wfreq ' || t.g FROM trooms t, perf p`,
		`INSERT INTO events (workspace_id, room_id, title, description, starts_at, ends_at, tz, organizer_id)
		 SELECT p.ws, NULL, CASE WHEN g % 10 = 0 THEN 'Встреча ' || g ELSE 'Созвон ' || g END, 'повестка ' || g,
		        now() + make_interval(hours => g), now() + make_interval(hours => g + 1), 'UTC', p.u FROM perf p, generate_series(1, 5000) g`,
		`INSERT INTO files (workspace_id, uploader_id, key, name, mime, size, sha256)
		 SELECT p.ws, p.u, 'k/' || g, CASE WHEN g % 50 = 0 THEN 'Отчёт ' || g || '.pdf' ELSE 'file_' || g || '.png' END, 'application/pdf', 1000, '' FROM perf p, generate_series(1, 50000) g`,
		`CREATE TEMP TABLE fmsg AS SELECT f.id AS file, (SELECT m.id FROM messages m WHERE m.room_id = p.small[1 + split_part(f.key, '/', 2)::int %% 50]
		        ORDER BY m.id DESC OFFSET split_part(f.key, '/', 2)::int / 50 LIMIT 1) AS msg
		 FROM files f, perf p WHERE f.workspace_id = p.ws`,
		`INSERT INTO message_attachments (message_id, file_id, position) SELECT msg, file, 0 FROM fmsg WHERE msg IS NOT NULL ON CONFLICT DO NOTHING`,
		`INSERT INTO room_recordings (workspace_id, room_id, started_by, status, result_state, transcript_json)
		 SELECT p.ws, p.small[1 + g % 50], p.u, 'done', 'ready',
		        (SELECT jsonb_agg(jsonb_build_object('speaker', k % 3, 'start', k * 5, 'end', k * 5 + 4, 'text',
		                CASE WHEN k = 150 AND g % 3 = 0 THEN 'обсуждаем бюджет' ELSE 'реплика ' || k || ' о проекте и планах команды' END))
		         FROM generate_series(1, 300) k WHERE g > 0)
		 FROM perf p, generate_series(1, 300) g`,
		`ANALYZE`,
	}
	for i, sql := range steps {
		sql = strings.ReplaceAll(sql, "%%", "%")
		if _, err := d.Pool.Exec(ctx, sql); err != nil {
			t.Fatalf("seed step %d: %v\n%s", i, err, sql)
		}
	}
	// Transcript texts as the backfill writes them.
	for {
		n, err := d.Q.BackfillTranscriptText(ctx, 200)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	if _, err := d.Pool.Exec(ctx, "ANALYZE room_recordings"); err != nil {
		t.Fatal(err)
	}
	t.Logf("seeded in %v", time.Since(start).Round(time.Second))
	if err := d.Pool.QueryRow(ctx, "SELECT id, owner_id FROM workspaces WHERE slug = 'search-perf'").Scan(&ws, &user); err != nil {
		t.Fatal(err)
	}
	return ws, user
}

// recorder keeps the statements run on its pool.
type recorder struct {
	mu    sync.Mutex
	stmts []stmt
}

type stmt struct {
	sql  string
	args []any
}

func (r *recorder) reset() {
	r.mu.Lock()
	r.stmts = nil
	r.mu.Unlock()
}

func (r *recorder) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	r.mu.Lock()
	r.stmts = append(r.stmts, stmt{sql: data.SQL, args: data.Args})
	r.mu.Unlock()
	return ctx
}

func (r *recorder) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// explain replays the recorded statements in one read-only transaction: settings as they were,
// SELECTs under EXPLAIN (ANALYZE, BUFFERS).
func (r *recorder) explain(ctx context.Context, t *testing.T, d *db.DB) string {
	t.Helper()
	r.mu.Lock()
	stmts := slices.Clone(r.stmts)
	r.mu.Unlock()
	var b strings.Builder
	err := d.ReadTx(ctx, func(tx pgx.Tx) error {
		for _, s := range stmts {
			sql := strings.TrimSpace(s.sql)
			switch {
			case strings.HasPrefix(sql, "begin"), strings.HasPrefix(sql, "commit"), strings.HasPrefix(sql, "rollback"):
				continue
			case strings.HasPrefix(sql, "SET LOCAL"), strings.HasPrefix(sql, "SELECT set_config"):
				if _, err := tx.Exec(ctx, sql, s.args...); err != nil {
					return err
				}
				continue
			}
			rows, err := tx.Query(ctx, "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) "+sql, s.args...)
			if err != nil {
				return err
			}
			lines, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return err
			}
			b.WriteString("--- " + abbreviate(sql) + "\n" + strings.Join(lines, "\n") + "\n")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func abbreviate(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}
