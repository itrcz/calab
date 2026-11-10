//go:build integration

package search

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/searchq"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// TestFoldedMatchesUseIndexes (CBF-169): the folded matches («ё» = «е») are served by the indexes
// of migration 00152 — the query repeats each index expression exactly. Sequential scans are
// off, so a plan without the index means the expressions differ.
func TestFoldedMatchesUseIndexes(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	// The tables whose trigram indexes are partial (live rows) have other partial indexes on
	// the same predicate: with rows, the planner weighs them like in production.
	user, ws := uuid.New(), uuid.New()
	for _, st := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'f')`, []any{user, "fold-" + user.String()[:8] + "@example.com"}},
		{`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'W', $3)`, []any{ws, "fold-" + ws.String()[:8], user}},
		{`INSERT INTO disk_items (workspace_id, kind, name, owner_id) SELECT $1, 'folder', 'Папка ' || i, $2 FROM generate_series(1, 50000) i`, []any{ws, user}},
		{`INSERT INTO wiki_pages (workspace_id, title, owner_id, position) SELECT $1, 'Страница ' || i, $2, i FROM generate_series(1, 50000) i`, []any{ws, user}},
		{`INSERT INTO canvas_items (workspace_id, kind, name, owner_id, position) SELECT $1, 'canvas', 'Холст ' || i, $2, i FROM generate_series(1, 50000) i`, []any{ws, user}},
		{`ANALYZE disk_items, wiki_pages, canvas_items`, nil},
	} {
		if _, err := d.Pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("%s: %v", st.sql, err)
		}
	}
	pq, err := searchq.Parse("Фёдоров отчёт")
	if err != nil {
		t.Fatal(err)
	}
	var ta boards.Args
	cond, _, _ := boards.SearchMatch(pq, "Фёдоров отчёт", &ta)
	cases := []struct {
		name, sql string
		args      []any
		want      []string
	}{
		{"tasks", "SELECT t.id FROM tasks t JOIN boards b ON b.id = t.board_id WHERE " + cond, ta.Values(),
			[]string{"tasks_search_fold_idx", "tasks_title_fold_trgm_idx"}},
	}
	for _, c := range []struct{ table, col, where, idx string }{
		{"events e", "e.title", "", "events_title_fold_trgm_idx"},
		{"files f", "f.name", "", "files_name_fold_trgm_idx"},
		{"disk_items di", "di.name", " AND di.trashed_at IS NULL", "disk_items_name_fold_trgm_idx"},
		{"wiki_pages w", "w.title", " AND w.trashed_at IS NULL", "wiki_pages_title_fold_trgm_idx"},
		{"canvas_items w", "w.name", " AND w.trashed_at IS NULL", "canvas_items_name_fold_trgm_idx"},
	} {
		var a boards.Args
		cases = append(cases, struct {
			name, sql string
			args      []any
			want      []string
		}{c.table, "SELECT 1 FROM " + c.table + " WHERE " + searchq.TitleMatch(c.col, pq.Folded(), a.Add) + c.where, a.Values(), []string{c.idx}})
	}
	for _, c := range cases {
		err := pgx.BeginFunc(ctx, d.Pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, "EXPLAIN (COSTS OFF) "+c.sql, c.args...)
			if err != nil {
				return err
			}
			lines, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return err
			}
			plan := strings.Join(lines, "\n")
			for _, idx := range c.want {
				if !strings.Contains(plan, idx) {
					t.Errorf("%s: no %s in the plan:\n%s", c.name, idx, plan)
				}
			}
			if testing.Verbose() {
				t.Logf("%s:\n%s", c.name, plan)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
	}
}
