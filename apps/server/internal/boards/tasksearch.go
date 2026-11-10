package boards

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/searchq"
)

// Task search limits (ADR-0139).
const (
	// MaxSearchOffset bounds the offset cursor: a search is read a few pages deep, not exported.
	MaxSearchOffset = 2000
	// commentRoomCap bounds the task rooms whose comments match: a frequent word matches
	// comments everywhere, and the title / description arms still find the rest.
	commentRoomCap = 5000
	// commentTimeout bounds the comment pass; past it the search answers without comments.
	commentTimeout = 1500 * time.Millisecond
	// TaskSearchSlots is how many task searches run at once in one API process: well under the
	// default pool of 20 (security review #95), since a filter-only search over a workspace and
	// its archive, sorted by a computed column, reads every visible task.
	TaskSearchSlots = 4
	// TaskSearchTimeout is the statement budget of the key, task and snippet queries; past it
	// the search answers 503 (snippets: none) rather than holding a connection.
	TaskSearchTimeout = 3 * time.Second
	// searchSlotWait is how long a search waits for a free slot before answering 503.
	searchSlotWait = time.Second
)

// doneStatuses is the condition over tasks t of a status of a done type (completed, cancelled).
const doneStatuses = "t.status_id IN (SELECT st.id FROM board_statuses st WHERE st.type IN ('completed', 'cancelled'))"

// statusRank orders a task's status by its type, as the columns of a board go.
const statusRank = "(SELECT CASE st.type WHEN 'backlog' THEN 0 WHEN 'unstarted' THEN 1 WHEN 'started' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END * 1000 + st.position FROM board_statuses st WHERE st.id = t.status_id)"

// assigneeName orders a task by its first assignee's name (none last).
const assigneeName = "(SELECT min(lower(u.display_name)) FROM task_assignees x JOIN users u ON u.id = x.user_id WHERE x.task_id = t.id)"

// taskSearch is a parsed GET …/tasks/search request.
type taskSearch struct {
	q        string
	pq       searchq.Query
	words    bool // q has words to match (else: filters only, or punctuation that matches nothing)
	state    string
	archived string
	board    uuid.UUID
	filter   *v1.TaskFilter
	sort     string
	desc     bool
	offset   int
	limit    int
}

var sortKeys = map[string]bool{"relevance": true, "updated": true, "created": true, "key": true, "title": true,
	"board": true, "status": true, "assignee": true, "priority": true, "due": true}

func parseTaskSearch(r *http.Request) (taskSearch, error) {
	qs := r.URL.Query()
	ts := taskSearch{q: strings.TrimSpace(qs.Get("q")), limit: DefaultSearchSize, state: qs.Get("state"), archived: qs.Get("archived"), filter: &v1.TaskFilter{}}
	if utf8.RuneCountInString(ts.q) > maxTextQuery {
		return ts, httpx.Validation("q", "q must be 0..200 characters")
	}
	if ts.q != "" {
		pq, err := searchq.Parse(ts.q)
		ts.pq, ts.words = pq, err == nil
	}
	if l := qs.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > MaxSearchSize {
			return ts, httpx.BadRequest("limit must be 1..50")
		}
		ts.limit = n
	}
	switch ts.state {
	case "", "all", "open", "done":
	default:
		return ts, httpx.BadRequest("state must be open, done or all")
	}
	switch ts.archived {
	case "", "1", "only":
	default:
		return ts, httpx.BadRequest("archived must be 1 or only")
	}
	if raw := qs.Get("board_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return ts, httpx.BadRequest("board_id must be a board id")
		}
		ts.board = id
	}
	if raw := qs.Get("filter"); raw != "" {
		if err := protojson.Unmarshal([]byte(raw), ts.filter); err != nil {
			return ts, httpx.Validation("filter", "filter must be a TaskFilter in JSON")
		}
	}
	ts.sort = strings.TrimSpace(qs.Get("sort"))
	if strings.HasPrefix(ts.sort, "-") {
		ts.sort, ts.desc = ts.sort[1:], true
	}
	if ts.sort == "" {
		ts.sort, ts.desc = "relevance", false
		if ts.q == "" {
			ts.sort, ts.desc = "updated", true
		}
	}
	if !sortKeys[ts.sort] {
		return ts, httpx.BadRequest("sort must be relevance, updated, created, key, title, board, status, assignee, priority or due")
	}
	if ts.sort == "relevance" && !ts.words {
		ts.sort, ts.desc = "updated", true
	}
	if c := qs.Get("cursor"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 0 || n > MaxSearchOffset {
			return ts, httpx.BadRequest("invalid cursor")
		}
		ts.offset = n
	}
	return ts, nil
}

// Only narrows the visibility to one board; false when the member does not see it.
func (v Visible) Only(board uuid.UUID) (Visible, bool) {
	out := Visible{Full: map[uuid.UUID]perm.Bits{}, Scoped: map[uuid.UUID]bool{}, CreateOnly: map[uuid.UUID]bool{}, Invited: v.Invited, viewer: v.viewer}
	if bits, ok := v.Full[board]; ok {
		out.Full[board] = bits
		return out, true
	}
	if v.Scoped[board] {
		out.Scoped[board], out.CreateOnly[board] = true, v.CreateOnly[board]
		return out, true
	}
	return out, false
}

// search: GET /api/workspaces/{id}/tasks/search (ADR-0139; ADR-0062 for the text match) — the
// tasks the caller sees on every board of the workspace or on board_id, by key and words of the
// title, description and comments, narrowed by state, archived and a TaskFilter, sorted and
// paged by an offset cursor; key_task is the task whose key q spells, whatever the filters.
func (s *Service) search(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	req, err := parseTaskSearch(r)
	if err != nil {
		return err
	}
	if err := take(r, s.SearchLimit); err != nil {
		return err
	}
	release, err := s.searchSlot(r.Context(), searchSlotWait)
	if err != nil {
		return err
	}
	defer release()
	all, err := VisibleBoards(r.Context(), s.db.Q, wsID, m)
	if err != nil {
		return err
	}
	vis := all
	if req.board != uuid.Nil {
		var ok bool
		if vis, ok = all.Only(req.board); !ok {
			return httpx.NotFound("board")
		}
	}
	out := &v1.SearchTasksResponse{}
	if all.Empty() {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	env := s.env(r)
	if out.KeyTask, err = s.keyTask(r.Context(), all, req.q, uid(r)); err != nil {
		return err
	}
	if req.q != "" && !req.words {
		httpx.Write(w, http.StatusOK, out) // only punctuation: nothing but the key
		return nil
	}
	var a Args
	where := []string{vis.Cond(&a)}
	switch req.archived {
	case "":
		where = append(where, "t.archived_at IS NULL")
	case "only":
		where = append(where, "t.archived_at IS NOT NULL")
	}
	scope := strings.Join(where, " AND ") // the tasks the comment pass looks in
	scopeArgs := append([]any(nil), a.Values()...)
	switch req.state {
	case "open":
		where = append(where, "NOT "+doneStatuses)
	case "done":
		where = append(where, doneStatuses)
	}
	cond, err := Translate(req.filter, env, &a)
	if err != nil {
		return err
	}
	where = append(where, cond)
	var rooms []uuid.UUID
	key, rank := "false", func() string { return "0" }
	if req.words {
		if rooms, err = s.commentRooms(r.Context(), scope, scopeArgs, req.pq); err != nil {
			return err
		}
		var text string
		text, key, rank = SearchMatch(req.pq, req.q, &a)
		if len(rooms) > 0 {
			text = "(" + text + " OR t.room_id = ANY(" + a.Add(rooms) + "::uuid[]))"
		}
		where = append(where, text)
	}
	order := sortOrder(req, key, rank)
	var rows []taskRow
	if err := s.boundedRead(r.Context(), func(tx pgx.Tx) error {
		var err error
		rows, err = queryTasks(r.Context(), tx, "WHERE "+strings.Join(where, " AND ")+" ORDER BY "+order+
			" LIMIT "+strconv.Itoa(req.limit+1)+" OFFSET "+strconv.Itoa(req.offset), a.Values()...)
		return err
	}); err != nil {
		return err
	}
	if len(rows) > req.limit {
		rows = rows[:req.limit]
		if next := req.offset + req.limit; next <= MaxSearchOffset {
			out.NextCursor = strconv.Itoa(next)
		}
	}
	if out.Tasks, err = tasksProto(r.Context(), s.db.Q, rows, uid(r)); err != nil {
		return err
	}
	if req.words && len(rows) > 0 {
		if out.Snippets, err = s.snippets(r.Context(), rows, rooms, req.pq); err != nil {
			return err
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// sortOrder is the ORDER BY of a search: the column (none / empty values last either way), then
// the newest update and the id for a stable page order.
func sortOrder(req taskSearch, key string, rank func() string) string {
	dir := " ASC NULLS LAST"
	if req.desc {
		dir = " DESC NULLS LAST"
	}
	tail := ", t.updated_at DESC, t.id DESC"
	switch req.sort {
	case "relevance":
		order := rank() + " DESC" + tail
		if key != "false" { // a constant cannot be an ORDER BY item
			order = key + " DESC, " + order
		}
		return order
	case "updated":
		return "t.updated_at" + dir + ", t.id DESC"
	case "created":
		return "t.created_at" + dir + ", t.id DESC"
	case "key":
		return "b.key" + dir + ", t.number" + dir + ", t.id"
	case "title":
		return "lower(t.title)" + dir + tail
	case "board":
		return "lower(b.name)" + dir + ", b.key" + tail
	case "status":
		return statusRank + dir + tail
	case "assignee":
		return assigneeName + dir + tail
	case "priority": // the most urgent first; «без приоритета» last either way
		return "nullif(t.priority, 0)" + map[bool]string{false: " DESC NULLS LAST", true: " ASC NULLS LAST"}[req.desc] + tail
	case "due":
		return "t.due_on" + dir + tail
	}
	return "t.updated_at DESC, t.id DESC"
}

// keyTask finds the visible task whose key q spells (DOC-426, doc426, док-426…), live or
// archived, on any board the caller sees; nil when q is no key (a bare number is no key here).
func (s *Service) keyTask(ctx context.Context, vis Visible, q string, viewer uuid.UUID) (*v1.Task, error) {
	kq, ok := ParseLooseKey(q)
	if !ok || len(kq.Prefixes) == 0 {
		return nil, nil
	}
	var a Args
	var rows []taskRow
	err := s.boundedRead(ctx, func(tx pgx.Tx) error {
		var err error
		rows, err = queryTasks(ctx, tx, "WHERE "+vis.Cond(&a)+" AND "+kq.KeyMatchSQL(&a)+
			" ORDER BY t.archived_at IS NOT NULL, t.updated_at DESC LIMIT 1", a.Values()...)
		return err
	})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	out, err := tasksProto(ctx, s.db.Q, rows, viewer)
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return out[0], nil
}

// commentRooms returns the rooms of the tasks in scope (a condition over tasks t JOIN boards b
// with its arguments) that have a live comment matching pq: first the task rooms, then the
// messages GIN index narrowed to them (as the unified search's comment section). A timeout drops
// the comment pass: the search answers with title and description matches.
func (s *Service) commentRooms(ctx context.Context, scope string, args []any, pq searchq.Query) ([]uuid.UUID, error) {
	var out []uuid.UUID
	err := s.db.ReadTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('statement_timeout', $1, true), set_config('enable_seqscan', 'off', true)",
			strconv.FormatInt(commentTimeout.Milliseconds(), 10)); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, "SELECT t.room_id FROM tasks t JOIN boards b ON b.id = t.board_id WHERE "+scope, args...)
		if err != nil {
			return err
		}
		rooms, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil || len(rooms) == 0 {
			return err
		}
		var a Args
		rooms0 := a.Add(rooms)
		rows, err = tx.Query(ctx, "SELECT DISTINCT c.room_id FROM (SELECT m.room_id FROM messages m WHERE m.room_id = ANY("+rooms0+
			"::uuid[]) AND m.deleted_at IS NULL AND "+searchq.MessageMatch(a.Add(pq.TS))+" OFFSET 0) c LIMIT "+strconv.Itoa(commentRoomCap), a.Values()...)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		return err
	})
	if isSearchTimeout(ctx, err) {
		return nil, nil
	}
	return out, err
}

// searchSlot takes one of the process's task search slots, waiting at most wait; 503 when none
// frees up. release gives it back.
func (s *Service) searchSlot(ctx context.Context, wait time.Duration) (release func(), err error) {
	if s.searchSlots == nil {
		return func() {}, nil
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case s.searchSlots <- struct{}{}:
		return func() { <-s.searchSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.C:
		return nil, httpx.Unavailable(errors.New("task search: no free slot"))
	}
}

// boundedRead runs fn in a read-only transaction under the task search statement budget; a
// query past it is 503 (wrapped: isSearchTimeout still recognises it).
func (s *Service) boundedRead(ctx context.Context, fn func(tx pgx.Tx) error) error {
	budget := s.SearchTimeout
	if budget <= 0 {
		budget = TaskSearchTimeout
	}
	err := s.db.ReadTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('statement_timeout', $1, true)", strconv.FormatInt(budget.Milliseconds(), 10)); err != nil {
			return err
		}
		return fn(tx)
	})
	if isSearchTimeout(ctx, err) {
		return httpx.Unavailable(err)
	}
	return err
}

// isSearchTimeout: err is a statement timeout (or a deadline) of a search query while the
// request itself is still alive.
func isSearchTimeout(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil {
		return false
	}
	var pe *pgconn.PgError
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &pe) && pe.Code == "57014")
}

// snippets: of the found tasks whose title has no matching word, a fragment of the description
// when it matches, else of the newest matching comment (only tasks whose room matched).
func (s *Service) snippets(ctx context.Context, rows []taskRow, rooms []uuid.UUID, pq searchq.Query) ([]*v1.TaskSearchSnippet, error) {
	ids := make([]uuid.UUID, len(rows))
	for i, t := range rows {
		ids[i] = t.ID
	}
	var a Args
	// Title and description: folded like SearchMatch («е» = «ё», CBF-169); the headline is over
	// the original text — its russian config folds ё itself, so «федоров» marks «Фёдоров».
	// Comments: the message match as commentRooms found them (the query as typed).
	tsq, msq := a.Add(pq.Folded().TS), a.Add(pq.TS)
	opts := a.Add(searchq.HeadlineOptions)
	inDesc := "to_tsvector('simple', " + searchq.FoldSQL("t.description") + ") @@ to_tsquery('simple', " + tsq + "::text)"
	comment := "(SELECT " + searchq.Headline("m.content", msq, opts) + " FROM messages m WHERE m.room_id = t.room_id AND m.deleted_at IS NULL AND " +
		searchq.MessageMatch(msq) + " ORDER BY m.id DESC LIMIT 1)"
	sql := "SELECT t.id, CASE WHEN " + inDesc + " THEN " + searchq.Headline("t.description", tsq, opts) + " END, " +
		"CASE WHEN NOT " + inDesc + " AND t.room_id = ANY(" + a.Add(rooms) + "::uuid[]) THEN " + comment + " END " +
		"FROM tasks t WHERE t.id = ANY(" + a.Add(ids) + "::uuid[]) AND NOT to_tsvector('simple', " + searchq.FoldSQL("t.title") +
		") @@ to_tsquery('simple', " + tsq + "::text)"
	type row struct {
		id            uuid.UUID
		desc, comment *string
	}
	var list []row
	err := s.boundedRead(ctx, func(tx pgx.Tx) error {
		res, err := tx.Query(ctx, sql, a.Values()...)
		if err != nil {
			return err
		}
		list, err = pgx.CollectRows(res, func(r pgx.CollectableRow) (row, error) {
			var x row
			err := r.Scan(&x.id, &x.desc, &x.comment)
			return x, err
		})
		return err
	})
	if isSearchTimeout(ctx, err) {
		return nil, nil // the tasks are found; their fragments are a nicety
	}
	if err != nil {
		return nil, err
	}
	out := []*v1.TaskSearchSnippet{}
	for _, x := range list {
		switch {
		case x.desc != nil && *x.desc != "":
			out = append(out, &v1.TaskSearchSnippet{TaskId: x.id.String(), Text: *x.desc})
		case x.comment != nil && *x.comment != "":
			out = append(out, &v1.TaskSearchSnippet{TaskId: x.id.String(), Text: *x.comment, Comment: true})
		}
	}
	return out, nil
}
