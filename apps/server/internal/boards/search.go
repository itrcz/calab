package boards

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/searchq"
)

// Visible is what a workspace member sees of its boards (ADR-0042, ADR-0059).
type Visible struct {
	// Full: the live boards with VIEW_BOARD, with the member's bits.
	Full map[uuid.UUID]perm.Bits
	// Scoped: the task-scoped boards — live, without VIEW_BOARD, where the member (a human, not
	// a guest) is invited (assignee, approver, watcher) on a live task; Invited: those tasks.
	// CreateOnly (ADR-0115): of Scoped, the boards where the member is create-only (CREATE_TASKS
	// without VIEW_BOARD) — listed even with no card; Invited holds their authored tasks too.
	Scoped     map[uuid.UUID]bool
	CreateOnly map[uuid.UUID]bool
	Invited    map[uuid.UUID]bool
	viewer     uuid.UUID
}

// Empty reports that the member sees no board at all.
func (v Visible) Empty() bool { return len(v.Full) == 0 && len(v.Scoped) == 0 }

// Cond is the SQL condition over tasks t (JOIN boards b) of the tasks the member sees: every
// task of a full board, the live tasks they are invited on of a task-scoped one (and, where they
// are create-only, the live tasks they authored).
func (v Visible) Cond(a *Args) string {
	cond := "t.board_id = ANY(" + a.Add(keys(v.Full)) + "::uuid[])"
	var invited, authored []uuid.UUID
	for id := range v.Scoped {
		if v.CreateOnly[id] {
			authored = append(authored, id)
		} else {
			invited = append(invited, id)
		}
	}
	for _, g := range []struct {
		ids    []uuid.UUID
		author bool
	}{{invited, false}, {authored, true}} {
		if len(g.ids) > 0 {
			cond += " OR (t.board_id = ANY(" + a.Add(g.ids) + "::uuid[]) AND t.archived_at IS NULL AND " + invitedCond(a, v.viewer, g.author) + ")"
		}
	}
	if len(v.Scoped) == 0 {
		return cond
	}
	return "(" + cond + ")"
}

// VisibleBoards returns the live boards of a workspace member m sees: with VIEW_BOARD (their
// bits) and task-scoped (ADR-0059).
func VisibleBoards(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, m perm.Member) (Visible, error) {
	out := Visible{Full: map[uuid.UUID]perm.Bits{}, Scoped: map[uuid.UUID]bool{}, CreateOnly: map[uuid.UUID]bool{}, Invited: map[uuid.UUID]bool{}}
	if m.Role == perm.RoleGuest || m.Role == "" {
		return out, nil
	}
	me, err := uuid.Parse(m.UserID)
	if err != nil {
		return out, err
	}
	out.viewer = me
	rows, err := q.ListBoards(ctx, sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: false})
	if err != nil || len(rows) == 0 {
		return out, err
	}
	ovs, err := q.ListWorkspaceBoardOverrides(ctx, wsID)
	if err != nil {
		return out, err
	}
	by := map[uuid.UUID][]sqlc.BoardPermission{}
	for _, o := range ovs {
		by[o.BoardID] = append(by[o.BoardID], o)
	}
	var authorBoards []uuid.UUID
	for _, b := range rows {
		switch bits := perm.ComputeBoardIn(m, perm.BoardFlagsOf(b.IsPrivate, b.Restricted, b.CreatedBy), OverrideTargets(by[b.ID])); {
		case bits.Has(perm.ViewBoard):
			out.Full[b.ID] = bits
		case perm.CreateOnly(bits):
			authorBoards = append(authorBoards, b.ID)
		}
	}
	if len(authorBoards) > 0 { // create-only is for humans (perm.Resolver: taskScoped)
		u, err := q.GetUser(ctx, me)
		if err != nil {
			return out, err
		}
		if u.IsBot {
			authorBoards = nil
		}
	}
	for _, id := range authorBoards {
		out.Scoped[id], out.CreateOnly[id] = true, true
	}
	inv, err := q.ListInvitedTasks(ctx, sqlc.ListInvitedTasksParams{WorkspaceID: wsID, UserID: me, AuthorBoards: authorBoards})
	if err != nil {
		return out, err
	}
	for _, t := range inv {
		if _, full := out.Full[t.BoardID]; !full {
			out.Scoped[t.BoardID], out.Invited[t.ID] = true, true
		}
	}
	return out, nil
}

// MemberOpenTasks is the most tasks of a member profile (ADR-0051).
const MemberOpenTasks = 50

// OpenTasksOf returns the open tasks (status not completed / cancelled, not archived) assigned
// to user on the boards of wsID that viewer (a member of wsID) sees, most recently updated
// first, at most MemberOpenTasks: the tasks of a member profile (ADR-0051). Guests see none.
func OpenTasksOf(ctx context.Context, dbtx sqlc.DBTX, q *sqlc.Queries, wsID uuid.UUID, viewer perm.Member, viewerID, user uuid.UUID) ([]*v1.Task, error) {
	vis, err := VisibleBoards(ctx, q, wsID, viewer)
	if err != nil || vis.Empty() {
		return []*v1.Task{}, err
	}
	var a Args
	rows, err := queryTasks(ctx, dbtx, "WHERE "+vis.Cond(&a)+" AND t.archived_at IS NULL"+
		" AND EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = "+a.Add(user)+")"+
		" AND t.status_id IN (SELECT st.id FROM board_statuses st WHERE st.type NOT IN ('completed', 'cancelled'))"+
		" ORDER BY t.updated_at DESC, t.id DESC LIMIT "+strconv.Itoa(MemberOpenTasks), a.Values()...)
	if err != nil {
		return nil, err
	}
	out, err := tasksProto(ctx, q, rows, viewerID)
	if out == nil && err == nil {
		out = []*v1.Task{}
	}
	return out, err
}

func keys(m map[uuid.UUID]perm.Bits) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// myTasks: GET /api/me/tasks?workspace_id=&scope=assigned|lead|created|subscribed&open=1&cursor=
// — the caller's tasks on the boards they see, newest update first.
func (s *Service) myTasks(w http.ResponseWriter, r *http.Request) error {
	qs := r.URL.Query()
	me := uid(r)
	var wss []uuid.UUID
	if raw := qs.Get("workspace_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return httpx.BadRequest("workspace_id must be a workspace id")
		}
		wss = []uuid.UUID{id}
	} else {
		ids, err := s.db.Q.ListUserWorkspaceIDs(r.Context(), me)
		if err != nil {
			return err
		}
		wss = ids
	}
	var a Args
	var vis []string
	for _, ws := range wss {
		m, err := perm.FromContext(r.Context()).Member(r.Context(), ws, me)
		if err != nil {
			continue
		}
		v, err := VisibleBoards(r.Context(), s.db.Q, ws, m)
		if err != nil {
			return err
		}
		if !v.Empty() {
			vis = append(vis, v.Cond(&a))
		}
	}
	out := &v1.MyTasksResponse{}
	if len(vis) == 0 {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	where := []string{"(" + strings.Join(vis, " OR ") + ")", "t.archived_at IS NULL"}
	meArg := a.Add(me)
	switch qs.Get("scope") {
	case "", "assigned":
		where = append(where, "EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = "+meArg+")")
	case "lead":
		where = append(where, "EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = "+meArg+" AND x.is_lead)")
	case "created":
		where = append(where, "t.created_by = "+meArg)
	case "subscribed":
		where = append(where, "EXISTS (SELECT 1 FROM task_subscribers x WHERE x.task_id = t.id AND x.user_id = "+meArg+" AND NOT x.muted)")
	default:
		return httpx.BadRequest("scope must be assigned, lead, created or subscribed")
	}
	if qs.Get("open") == "1" {
		where = append(where, "t.status_id IN (SELECT st.id FROM board_statuses st WHERE st.type NOT IN ('completed', 'cancelled'))")
	}
	// Cursor: "<updated_at RFC 3339 nano>_<id>" of the last task of the previous page.
	if c := qs.Get("cursor"); c != "" {
		ts, id, ok := strings.Cut(c, "_")
		t, err1 := time.Parse(time.RFC3339Nano, ts)
		tid, err2 := uuid.Parse(id)
		if !ok || err1 != nil || err2 != nil {
			return httpx.BadRequest("invalid cursor")
		}
		where = append(where, "(t.updated_at, t.id) < ("+a.Add(t)+", "+a.Add(tid)+")")
	}
	rows, err := queryTasks(r.Context(), s.db.Pool, "WHERE "+strings.Join(where, " AND ")+
		" ORDER BY t.updated_at DESC, t.id DESC LIMIT "+strconv.Itoa(MyTasksPage+1), a.Values()...)
	if err != nil {
		return err
	}
	if len(rows) > MyTasksPage {
		rows = rows[:MyTasksPage]
		last := rows[len(rows)-1]
		out.NextCursor = last.UpdatedAt.UTC().Format(time.RFC3339Nano) + "_" + last.ID.String()
	}
	if out.Tasks, err = tasksProto(r.Context(), s.db.Q, rows, me); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// SearchMatch is the task part of unified search (ADR-0062), shared by GET /api/search and
// tasks/search: the condition over tasks t (JOIN boards b) — words of title and description
// (searchq tsquery, simple config: tasks_search_fold_idx), the title with typos or as a substring
// (pg_trgm: tasks_title_fold_trgm_idx), the key ABC-12 in any spelling (ParseLooseKey: abc12, abc 12, abc_12, the Russian layout; a bare
// number 12 is the number on every board), or a board key prefix (ABC) — and
// keyMatch, the exact-key condition ("false" when q is no key) that callers list first, and
// rank, which adds its own parameters when called (after cond's, so that a count over cond
// alone has no unused parameter): the best of ts_rank_cd and the title's word similarity, 0..1.
//
// «е» and «ё» are one letter (CBF-169): the query is folded here and the indexes are over folded
// text, so both spellings find the same tasks in the same order.
func SearchMatch(pq searchq.Query, raw string, a *Args) (cond, keyMatch string, rank func() string) {
	pq = pq.Folded()
	ts := a.Add(pq.TS) + "::text"
	parts := []string{
		SearchVector + " @@ to_tsquery('simple', " + ts + ")",
		searchq.TitleMatch("t.title", pq, a.Add),
	}
	keyMatch = "false"
	raw = strings.TrimSpace(raw)
	if kq, ok := ParseLooseKey(raw); ok {
		keyMatch = kq.KeyMatchSQL(a)
		parts = append(parts, keyMatch)
	} else if keyRE.MatchString(strings.ToUpper(raw)) {
		parts = append(parts, "b.key LIKE "+a.Add(strings.ToUpper(raw)+"%"))
	}
	rank = func() string {
		return "greatest(ts_rank_cd(" + SearchVector + ", to_tsquery('simple', " + ts + ")), word_similarity(" + a.Add(pq.Text) + "::text, " + searchq.FoldSQL("t.title") + "))"
	}
	return "(" + strings.Join(parts, " OR ") + ")", keyMatch, rank
}
