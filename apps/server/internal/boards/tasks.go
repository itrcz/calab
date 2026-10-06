package boards

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// change collects what a task mutation produced, published after the commit.
type change struct {
	acts    []sqlc.TaskActivity
	notices []notice
	tasks   []uuid.UUID // other tasks whose TASK_UPDATE must go out (moved subtasks, relations)
	// before: events to send first (TASK_DELETE to the old board of a moved task); moved: the
	// task arrives on its new board as TASK_CREATE.
	before []wsEvent
	moved  bool
	// rule: the entries are made by this automation rule (ADR-0060): actor_id NULL, rule_id set.
	rule *ruleRef
	// extra: rule triggers that are not journal entries (a comment was posted).
	extra []ruleEvent
	// auto: what automation rules did in the transaction, published after the commit (taskTx).
	auto *autoEffects
}

type wsEvent struct {
	ws uuid.UUID
	ev *v1.DispatchEvent
}

// record writes a journal entry (ADR-0042 §1: every change, actor = user or bot; a rule's
// change has no actor and the rule's id).
func (c *change) record(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, kind string, before, after map[string]any) error {
	if c.rule != nil {
		return c.recordAs(ctx, q, t, nil, kind, before, after)
	}
	return c.recordAs(ctx, q, t, &actor, kind, before, after)
}

// recordAs writes a journal entry with actor (nil: the server, e.g. a Git event, or the rule of c).
func (c *change) recordAs(ctx context.Context, q *sqlc.Queries, t taskRow, actor *uuid.UUID, kind string, before, after map[string]any) error {
	enc := func(m map[string]any) []byte {
		if m == nil {
			return nil
		}
		b, err := json.Marshal(m)
		if err != nil {
			return nil
		}
		return b
	}
	var rule *uuid.UUID
	if c.rule != nil {
		rule = &c.rule.id
	}
	a, err := q.InsertTaskActivity(ctx, sqlc.InsertTaskActivityParams{
		TaskID: t.ID, BoardID: t.BoardID, ActorID: actor, Kind: kind, Before: enc(before), After: enc(after), RuleID: rule,
	})
	if err != nil {
		return err
	}
	c.acts = append(c.acts, a)
	return nil
}

// publish sends TASK_UPDATE (or create) of the task, TASK_ACTIVITY of the entries and the
// personal TASK_UPDATE of every notified user.
func (s *Service) publish(ctx context.Context, taskID uuid.UUID, c *change, created bool) {
	for _, e := range c.before {
		s.ev.Workspace(ctx, e.ws, e.ev)
	}
	s.publishTaskEvent(ctx, taskID, created || c.moved)
	for _, id := range c.tasks {
		if id != taskID {
			s.publishTaskEvent(ctx, id, false)
		}
	}
	for _, a := range c.acts {
		if wsID, err := s.workspaceOf(ctx, a.BoardID); err == nil {
			s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: &v1.TaskActivityAppend{
				WorkspaceId: wsID.String(), Activity: activity(a)}}})
		}
	}
	s.sendNotices(ctx, taskID, c.notices)
}

func (s *Service) workspaceOf(ctx context.Context, boardID uuid.UUID) (uuid.UUID, error) {
	b, err := s.db.Q.GetBoard(ctx, boardID)
	return b.WorkspaceID, err
}

// publishTask is publish without journal entries (moves of a deleted status, sweeper).
func (s *Service) publishTask(ctx context.Context, taskID uuid.UUID, notices []notice) {
	s.publishTaskEvent(ctx, taskID, false)
	s.sendNotices(ctx, taskID, notices)
}

func (s *Service) publishTaskEvent(ctx context.Context, taskID uuid.UUID, created bool) {
	t, ok, err := taskByID(ctx, s.db.Pool, taskID, false)
	if err != nil || !ok {
		return
	}
	pbs, err := tasksProto(ctx, s.db.Q, []taskRow{t}, uuid.Nil)
	if err != nil {
		return
	}
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskUpdate{TaskUpdate: &v1.TaskUpdate{Task: pbs[0]}}}
	if created {
		ev = &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskCreate{TaskCreate: &v1.TaskCreate{Task: pbs[0]}}}
	}
	s.ev.Workspace(ctx, t.WorkspaceID, ev)
}

// ---- access to tasks ----

// loadTask resolves a task by path id and the caller's board access (404 when hidden).
func (s *Service) loadTask(r *http.Request, dbtx sqlc.DBTX, lock bool) (taskRow, perm.BoardAccess, error) {
	id, err := httpx.PathUUID(r, "id", "task")
	if err != nil {
		return taskRow{}, perm.BoardAccess{}, err
	}
	return s.taskAccess(r, dbtx, id, lock)
}

func (s *Service) taskAccess(r *http.Request, dbtx sqlc.DBTX, id uuid.UUID, lock bool) (taskRow, perm.BoardAccess, error) {
	t, ok, err := taskByID(r.Context(), dbtx, id, lock)
	if err != nil {
		return t, perm.BoardAccess{}, err
	}
	if !ok {
		return t, perm.BoardAccess{}, httpx.NotFound("task")
	}
	acc, err := taskOf(r, sqlc.New(dbtx), t)
	return t, acc, err
}

// taskOf resolves the caller's access to task t: the board's access with Bits = perm.TaskBits
// (ADR-0059 §2, ADR-0076 — a task-scoped member has bits only on the live tasks they are an
// assignee, an approver or a watcher of); 404 when the task is hidden. acc.TaskScoped set = the bits come from the task.
func taskOf(r *http.Request, q *sqlc.Queries, t taskRow) (perm.BoardAccess, error) {
	acc, err := board(r, t.BoardID, false)
	if err != nil {
		return acc, httpx.NotFound("task")
	}
	if acc.Bits.Has(perm.ViewBoard) {
		return acc, nil
	}
	if t.ArchivedAt != nil { // invitations count on live tasks only
		return perm.BoardAccess{}, httpx.NotFound("task")
	}
	inv, err := q.GetTaskInvite(r.Context(), sqlc.GetTaskInviteParams{TaskID: t.ID, UserID: uid(r)})
	if err != nil {
		return perm.BoardAccess{}, err
	}
	if acc.Bits = perm.TaskBits(acc, inv.Assignee, inv.Approver, inv.Watcher); acc.Bits == 0 {
		return perm.BoardAccess{}, httpx.NotFound("task")
	}
	return acc, nil
}

// invitedCond is the SQL condition over tasks t "user is an assignee, an approver or a watcher"
// (ADR-0059, ADR-0076).
func invitedCond(a *Args, user uuid.UUID) string {
	u := a.Add(user)
	return "(EXISTS (SELECT 1 FROM task_assignees ia WHERE ia.task_id = t.id AND ia.user_id = " + u + ")" +
		" OR EXISTS (SELECT 1 FROM task_approvers ip WHERE ip.task_id = t.id AND ip.user_id = " + u + ")" +
		" OR EXISTS (SELECT 1 FROM task_subscribers iw WHERE iw.task_id = t.id AND iw.user_id = " + u + " AND iw.watcher))"
}

// visibleTasks keeps the rows the viewer sees (order kept): tasks of live boards with
// VIEW_BOARD, and on task-scoped boards the live tasks they are invited on (ADR-0059).
func visibleTasks(ctx context.Context, q *sqlc.Queries, rows []taskRow, me uuid.UUID) ([]taskRow, error) {
	res := perm.FromContext(ctx)
	accs := map[uuid.UUID]perm.BoardAccess{}
	var scoped []uuid.UUID
	for _, x := range rows {
		acc, ok := accs[x.BoardID]
		if !ok {
			var err error
			acc, err = res.Board(ctx, x.BoardID, me)
			if err != nil && !errors.Is(err, perm.ErrNoBoard) {
				return nil, err
			}
			accs[x.BoardID] = acc
		}
		if !acc.Bits.Has(perm.ViewBoard) && acc.TaskScoped && x.ArchivedAt == nil {
			scoped = append(scoped, x.ID)
		}
	}
	invited := map[uuid.UUID]bool{}
	if len(scoped) > 0 {
		ids, err := q.ListTaskInvites(ctx, sqlc.ListTaskInvitesParams{Ids: scoped, UserID: me})
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			invited[id] = true
		}
	}
	out := make([]taskRow, 0, len(rows))
	for _, x := range rows {
		if acc := accs[x.BoardID]; (acc.Bits.Has(perm.ViewBoard) && !acc.Archived) || invited[x.ID] {
			out = append(out, x)
		}
	}
	return out, nil
}

// canEdit: EDIT_TASKS edits any task; CREATE_TASKS the ones the caller created or is assigned to.
func canEdit(ctx context.Context, q *sqlc.Queries, acc perm.BoardAccess, t taskRow, me uuid.UUID) (bool, error) {
	if acc.Bits.Has(perm.EditTasks) {
		return true, nil
	}
	if !acc.Bits.Has(perm.CreateTasks) {
		return false, nil
	}
	if t.CreatedBy != nil && *t.CreatedBy == me {
		return true, nil
	}
	as, err := q.ListTaskAssignees(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(as, func(a sqlc.TaskAssignee) bool { return a.UserID == me }), nil
}

func requireEdit(ctx context.Context, q *sqlc.Queries, acc perm.BoardAccess, t taskRow, me uuid.UUID) error {
	if err := writable(acc); err != nil {
		return err
	}
	ok, err := canEdit(ctx, q, acc, t, me)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.Forbidden("EDIT_TASKS required (or CREATE_TASKS on your own and assigned tasks)")
	}
	return nil
}

// ---- validation ----

func parseOptID(field, s string) (*uuid.UUID, error) {
	if s == "" {
		return nil, nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return nil, httpx.Validation(field, "invalid id")
	}
	return &id, nil
}

func validTitle(s string) (string, error) { return validText("title", s, 1, MaxTitle) }

func validDescription(s string) (string, error) {
	if utf8.RuneCountInString(s) > MaxDescription {
		return "", httpx.Validation("description", "description must be at most 20000 characters")
	}
	return s, nil
}

func validEstimate(n uint32) (*int16, error) {
	if n == 0 {
		return nil, nil
	}
	if n > MaxEstimate {
		return nil, httpx.Validation("estimate", "estimate must be 1..21")
	}
	v := int16(n) //nolint:gosec // ≤ 21
	return &v, nil
}

func validPriority(p v1.TaskPriority) (int16, error) {
	if p < v1.TaskPriority_TASK_PRIORITY_NONE || p > v1.TaskPriority_TASK_PRIORITY_URGENT {
		return 0, httpx.Validation("priority", "unknown priority")
	}
	return int16(p), nil
}

// boardItems are a board's statuses, labels and milestones by id.
type boardItems struct {
	statuses   map[uuid.UUID]sqlc.BoardStatus
	def        *sqlc.BoardStatus
	labels     map[uuid.UUID]sqlc.BoardLabel
	milestones map[uuid.UUID]bool
}

func items(ctx context.Context, q *sqlc.Queries, boardID uuid.UUID) (boardItems, error) {
	it := boardItems{statuses: map[uuid.UUID]sqlc.BoardStatus{}, labels: map[uuid.UUID]sqlc.BoardLabel{}, milestones: map[uuid.UUID]bool{}}
	ss, err := q.ListBoardStatuses(ctx, []uuid.UUID{boardID})
	if err != nil {
		return it, err
	}
	for _, s := range ss {
		it.statuses[s.ID] = s
		if s.IsDefault {
			s := s
			it.def = &s
		}
	}
	if it.def == nil && len(ss) > 0 {
		it.def = &ss[0]
	}
	ls, err := q.ListBoardLabels(ctx, []uuid.UUID{boardID})
	if err != nil {
		return it, err
	}
	for _, l := range ls {
		it.labels[l.ID] = l
	}
	ms, err := q.ListBoardMilestones(ctx, []uuid.UUID{boardID})
	if err != nil {
		return it, err
	}
	for _, m := range ms {
		it.milestones[m.ID] = true
	}
	return it, nil
}

func (it boardItems) labelIDs(raw []string) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, httpx.Validation("labelIds", "invalid label id")
		}
		if _, ok := it.labels[id]; !ok {
			return nil, httpx.Validation("labelIds", "a label of this board is required")
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

// assigneesIn validates a requested assignee list (ADR-0042 §1, ADR-0059, ADR-0076): ≤ 10
// members, not guests — people who see the board or any other member (who then sees the board
// through this task; restricted boards too); bots only with VIEW_BOARD; exactly one lead (the
// first when none is marked). The caller must be able to edit the task (requireEdit / a new
// task of their own): only an editor opens a card to someone without board access.
func assigneesIn(ctx context.Context, q *sqlc.Queries, boardID uuid.UUID, in []*v1.TaskAssigneeInput) ([]*v1.TaskAssigneeInput, error) {
	if len(in) > MaxAssignees {
		return nil, httpx.Validation("assignees", "at most 10 assignees")
	}
	leads := 0
	seen := map[uuid.UUID]bool{}
	res := perm.NewResolver(q)
	for i, a := range in {
		field := "assignees[" + strconv.Itoa(i) + "]"
		u, err := uuid.Parse(a.GetUserId())
		if err != nil {
			return nil, httpx.Validation(field+".userId", "invalid user id")
		}
		if seen[u] {
			return nil, httpx.Validation(field+".userId", "duplicate assignee")
		}
		seen[u] = true
		if utf8.RuneCountInString(a.GetNote()) > MaxNote {
			return nil, httpx.Validation(field+".note", "note must be at most 120 characters")
		}
		ok, err := mayInvite(ctx, q, res, boardID, u)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, httpx.Validation(field+".userId", "the user does not see this board")
		}
		if a.GetIsLead() {
			leads++
		}
	}
	if leads > 1 {
		return nil, httpx.Validation("assignees", "exactly one lead")
	}
	out := make([]*v1.TaskAssigneeInput, len(in))
	for i, a := range in {
		out[i] = &v1.TaskAssigneeInput{UserId: a.GetUserId(), IsLead: a.GetIsLead() || (leads == 0 && i == 0), Note: strings.TrimSpace(a.GetNote())}
	}
	return out, nil
}

// mayInvite reports whether user u may become an assignee, an approver or a watcher of a task
// of the board (ADR-0059 §3, ADR-0076 §2): a member who is not a guest and either sees the board
// or — a human — will see it through the task (restricted boards too, ADR-0076). Bots need
// VIEW_BOARD. Callers check that the inviter may edit the task.
func mayInvite(ctx context.Context, q *sqlc.Queries, res *perm.Resolver, boardID, u uuid.UUID) (bool, error) {
	acc, err := res.Board(ctx, boardID, u)
	if errors.Is(err, perm.ErrNoBoard) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if acc.Role == perm.RoleGuest || acc.Role == "" {
		return false, nil
	}
	if acc.Bits.Has(perm.ViewBoard) {
		return true, nil
	}
	if acc.Archived {
		return false, nil
	}
	usr, err := q.GetUser(ctx, u)
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !usr.IsBot && !usr.IsGuest, nil
}

// writeAssignees replaces the list, keeping assigned_by / assigned_at of those who stay.
// Returns the users newly assigned or newly made the lead.
func writeAssignees(ctx context.Context, q *sqlc.Queries, taskID uuid.UUID, in []*v1.TaskAssigneeInput, me *uuid.UUID, now time.Time) ([]uuid.UUID, []sqlc.TaskAssignee, error) {
	old, err := q.ListTaskAssignees(ctx, []uuid.UUID{taskID})
	if err != nil {
		return nil, nil, err
	}
	prev := map[uuid.UUID]sqlc.TaskAssignee{}
	for _, a := range old {
		prev[a.UserID] = a
	}
	if err := q.DeleteTaskAssignees(ctx, taskID); err != nil {
		return nil, nil, err
	}
	var fresh []uuid.UUID
	for _, a := range in {
		u := uuid.MustParse(a.GetUserId())
		by, at := me, now
		if p, ok := prev[u]; ok {
			by, at = p.AssignedBy, p.AssignedAt
			if a.GetIsLead() && !p.IsLead {
				fresh = append(fresh, u)
			}
		} else {
			fresh = append(fresh, u)
		}
		if err := q.InsertTaskAssignee(ctx, sqlc.InsertTaskAssigneeParams{TaskID: taskID, UserID: u, IsLead: a.GetIsLead(),
			Note: a.GetNote(), AssignedBy: by, AssignedAt: at}); err != nil {
			return nil, nil, err
		}
	}
	return fresh, old, nil
}

func assigneesJSON(as []sqlc.TaskAssignee) []any {
	out := make([]any, len(as))
	for i, a := range as {
		out[i] = map[string]any{"user_id": a.UserID.String(), "is_lead": a.IsLead, "note": a.Note}
	}
	return out
}

func inputsJSON(in []*v1.TaskAssigneeInput) []any {
	out := make([]any, len(in))
	for i, a := range in {
		out[i] = map[string]any{"user_id": a.GetUserId(), "is_lead": a.GetIsLead(), "note": a.GetNote()}
	}
	return out
}

func idsJSON(ids []uuid.UUID) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

// finishFields maintains started_at / completed_at / completed_by for a move into a status of
// type typ (ADR-0042 §1).
func finishFields(t *taskRow, typ string, actor uuid.UUID, now time.Time) {
	if typ == "started" && t.StartedAt == nil {
		t.StartedAt = &now
	}
	if Finished(typ) {
		if t.CompletedAt == nil {
			t.CompletedAt, t.CompletedBy = &now, &actor
		}
		return
	}
	t.CompletedAt, t.CompletedBy = nil, nil
}

// statusChanged maintains the timestamps and writes the journal entry of a task moved from one
// status to another (DELETE status with move_to).
func (s *Service) statusChanged(ctx context.Context, q *sqlc.Queries, dbtx sqlc.DBTX, taskID uuid.UUID, from, to sqlc.BoardStatus, actor uuid.UUID, c *change) error {
	t, ok, err := taskByID(ctx, dbtx, taskID, false)
	if err != nil || !ok {
		return err
	}
	finishFields(&t, to.Type, actor, s.Now())
	if err := updateRow(ctx, q, t); err != nil {
		return err
	}
	return c.record(ctx, q, t, actor, "status",
		map[string]any{"status_id": from.ID.String(), "status_type": from.Type},
		map[string]any{"status_id": to.ID.String(), "status_type": to.Type})
}

func updateRow(ctx context.Context, q *sqlc.Queries, t taskRow) error {
	return q.UpdateTaskFields(ctx, sqlc.UpdateTaskFieldsParams{
		ID: t.ID, Title: t.Title, Description: t.Description, StatusID: t.StatusID, Priority: t.Priority,
		Estimate: t.Estimate, StartOn: t.StartOn, DueOn: t.DueOn, ParentID: t.ParentID, MilestoneID: t.MilestoneID,
		TaskMilestoneID: t.TaskMilestoneID, Position: t.Position, StartedAt: t.StartedAt, CompletedAt: t.CompletedAt, CompletedBy: t.CompletedBy,
	})
}

// place returns the position of taskID in statusID between after / before (nil: last),
// renormalising the column when the gap is exhausted.
func place(ctx context.Context, q *sqlc.Queries, statusID, taskID uuid.UUID, after, before *uuid.UUID) (float64, error) {
	col, err := q.StatusPositions(ctx, statusID)
	if err != nil {
		return 0, err
	}
	col = slices.DeleteFunc(col, func(x sqlc.StatusPositionsRow) bool { return x.ID == taskID })
	if after == nil && before == nil {
		if len(col) == 0 {
			return PositionStep, nil
		}
		return col[len(col)-1].Position + PositionStep, nil
	}
	find := func(id uuid.UUID) int {
		return slices.IndexFunc(col, func(x sqlc.StatusPositionsRow) bool { return x.ID == id })
	}
	idx := -1 // insert before col[idx+1]
	switch {
	case after != nil:
		i := find(*after)
		if i < 0 {
			return 0, httpx.Validation("afterTaskId", "a live task of the target status is required")
		}
		idx = i
	default:
		i := find(*before)
		if i < 0 {
			return 0, httpx.Validation("beforeTaskId", "a live task of the target status is required")
		}
		idx = i - 1
	}
	neighbours := func() (*float64, *float64) {
		var prev, next *float64
		if idx >= 0 {
			prev = &col[idx].Position
		}
		if idx+1 < len(col) {
			next = &col[idx+1].Position
		}
		return prev, next
	}
	prev, next := neighbours()
	p, renorm := Between(prev, next)
	if !renorm {
		return p, nil
	}
	for i, pos := range Renormalised(len(col)) {
		col[i].Position = pos
		if err := q.SetTaskPosition(ctx, sqlc.SetTaskPositionParams{ID: col[i].ID, Position: pos}); err != nil {
			return 0, err
		}
	}
	prev, next = neighbours()
	p, _ = Between(prev, next)
	return p, nil
}

// ---- handlers ----

func (s *Service) listTasks(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := pathBoard(r, false)
	if err != nil {
		return err
	}
	qs := r.URL.Query()
	scoped := !acc.Bits.Has(perm.ViewBoard) // ADR-0059: only the live tasks they are invited on
	if scoped && qs.Get("archived") == "1" {
		httpx.Write(w, http.StatusOK, &v1.ListTasksResponse{})
		return nil
	}
	f := &v1.TaskFilter{}
	if raw := qs.Get("filter"); raw != "" {
		if err := protojson.Unmarshal([]byte(raw), f); err != nil {
			return httpx.Validation("filter", "filter must be a TaskFilter in JSON")
		}
	}
	limit := PageSize
	if l := qs.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > PageSize {
			return httpx.BadRequest("limit must be 1..500")
		}
		limit = n
	}
	var a Args
	where := []string{"t.board_id = " + a.Add(id)}
	switch {
	case qs.Get("archived") == "1":
		where = append(where, "t.archived_at IS NOT NULL")
	case scoped || !HasArchived(f):
		where = append(where, "t.archived_at IS NULL")
	}
	if scoped {
		where = append(where, invitedCond(&a, uid(r)))
	}
	if s := qs.Get("updated_after"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return httpx.BadRequest("updated_after must be RFC 3339")
		}
		// A milestone completed by the server (ADR-0063 §2) touches its own row, not the task's
		// (no parent row lock in a subtask's transaction): it counts as a change of the task.
		at := a.Add(t)
		where = append(where, "(t.updated_at > "+at+" OR EXISTS (SELECT 1 FROM task_milestones um WHERE um.task_id = t.id AND um.updated_at > "+at+"))")
	}
	cond, err := Translate(f, s.env(r), &a)
	if err != nil {
		return err
	}
	where = append(where, cond)
	// The cursor is the number of the last task of the previous page; pages are by number
	// (stable while tasks move); clients order by status and position themselves.
	if c := qs.Get("cursor"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 0 {
			return httpx.BadRequest("invalid cursor")
		}
		where = append(where, "t.number > "+a.Add(n))
	}
	rows, err := queryTasks(r.Context(), s.db.Pool, "WHERE "+strings.Join(where, " AND ")+" ORDER BY t.number LIMIT "+strconv.Itoa(limit+1), a.Values()...)
	if err != nil {
		return err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = strconv.Itoa(int(rows[len(rows)-1].Number))
	}
	out, err := tasksProto(r.Context(), s.db.Q, rows, uid(r))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListTasksResponse{Tasks: out, NextCursor: next})
	return nil
}

// env is the filter environment of the caller: "me" and today in their profile zone.
func (s *Service) env(r *http.Request) FilterEnv {
	now := s.Now()
	if u, err := s.db.Q.GetUser(r.Context(), uid(r)); err == nil && u.Timezone != nil {
		if loc, err := time.LoadLocation(*u.Timezone); err == nil {
			now = now.In(loc)
		}
	}
	return FilterEnv{Viewer: uid(r), Today: time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)}
}

// quoteMessage builds the description of «Создать задачу из сообщения»: the message quoted and
// a link to it.
func (s *Service) quoteMessage(r *http.Request, raw, desc string) (string, *uuid.UUID, error) {
	mid, err := uuid.Parse(raw)
	if err != nil {
		return "", nil, httpx.Validation("fromMessageId", "invalid message id")
	}
	m, err := s.db.Q.GetMessage(r.Context(), mid)
	if db.IsNotFound(err) || (err == nil && m.DeletedAt != nil) {
		return "", nil, httpx.NotFound("message")
	}
	if err != nil {
		return "", nil, err
	}
	// The author must see the message (ADR-0042, security review): the room's VIEW_ROOM.
	if _, err := rooms.Access(r, m.RoomID); err != nil {
		return "", nil, httpx.NotFound("message")
	}
	var b strings.Builder
	for _, line := range strings.Split(strings.TrimSpace(m.Content), "\n") {
		b.WriteString("> " + line + "\n")
	}
	b.WriteString("\n[Сообщение](" + strings.TrimRight(s.PublicURL, "/") + "/m/" + m.RoomID.String() + "/" + m.ID.String() + ")")
	if d := strings.TrimSpace(desc); d != "" {
		b.WriteString("\n\n" + d)
	}
	out := b.String()
	if utf8.RuneCountInString(out) > MaxDescription {
		out = string([]rune(out)[:MaxDescription])
	}
	return out, &mid, nil
}

func (s *Service) createTask(w http.ResponseWriter, r *http.Request) error {
	boardID, acc, err := pathBoard(r, false)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.CreateTasks) {
		return httpx.Forbidden("CREATE_TASKS required")
	}
	if err := writable(acc); err != nil {
		return err
	}
	if err := take(r, s.CreateLimit); err != nil {
		return err
	}
	var req v1.CreateTaskRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	title, err := validTitle(req.GetTitle())
	if err != nil {
		return err
	}
	desc, err := validDescription(req.GetDescription())
	if err != nil {
		return err
	}
	// Only the author's own text invites by mention (ADR-0076 §5): the @mentions of a quoted
	// message were written by someone else and must not open the card to those people.
	own := desc
	var fromMsg *uuid.UUID
	if req.GetFromMessageId() != "" {
		if desc, fromMsg, err = s.quoteMessage(r, req.GetFromMessageId(), desc); err != nil {
			return err
		}
	}
	prio, err := validPriority(req.GetPriority())
	if err != nil {
		return err
	}
	est, err := validEstimate(req.GetEstimate())
	if err != nil {
		return err
	}
	start, ok1 := ParseDate(req.GetStartOn())
	due, ok2 := ParseDate(req.GetDueOn())
	if !ok1 || !ok2 {
		return httpx.Validation("dueOn", "dates must be YYYY-MM-DD")
	}
	if start.Valid && due.Valid && due.Time.Before(start.Time) {
		return httpx.Validation("dueOn", "the due date is before the start")
	}
	parent, err := parseOptID("parentId", req.GetParentId())
	if err != nil {
		return err
	}
	ms, err := parseOptID("milestoneId", req.GetMilestoneId())
	if err != nil {
		return err
	}
	after, err := parseOptID("afterTaskId", req.GetAfterTaskId())
	if err != nil {
		return err
	}
	fileIDs, err := fileIDs(req.GetAttachmentIds())
	if err != nil {
		return err
	}
	me, now := uid(r), s.Now()
	var taskID uuid.UUID
	var c change
	err = s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		b, err := q.GetBoardForUpdate(r.Context(), boardID)
		if err != nil {
			return err
		}
		n, err := q.CountLiveTasks(r.Context(), boardID)
		if err != nil {
			return err
		}
		if n >= MaxTasks {
			return httpx.Conflict("at most 5000 live tasks per board; archive finished ones").WithDetails(ReasonBoardTaskLimit, uint64(max(n, 0)), MaxTasks)
		}
		if err := createFeatures(b, &req, est); err != nil {
			return err
		}
		it, err := items(r.Context(), q, boardID)
		if err != nil {
			return err
		}
		st := it.def
		if sid := req.GetStatusId(); sid != "" {
			id, err := uuid.Parse(sid)
			if err != nil {
				return httpx.Validation("statusId", "invalid status id")
			}
			x, ok := it.statuses[id]
			if !ok {
				return httpx.Validation("statusId", "a status of this board is required")
			}
			st = &x
		}
		if st == nil {
			return httpx.Conflict("the board has no status")
		}
		labels, err := it.labelIDs(req.GetLabelIds())
		if err != nil {
			return err
		}
		if ms != nil && !it.milestones[*ms] {
			return httpx.Validation("milestoneId", "a milestone of this board is required")
		}
		if parent != nil {
			if err := checkParent(r.Context(), q, tx, boardID, *parent, uuid.Nil); err != nil {
				return err
			}
		}
		assignees, err := assigneesIn(r.Context(), q, boardID, req.GetAssignees())
		if err != nil {
			return err
		}
		approvers, required, err := approversIn(r.Context(), q, boardID, req.GetApproverIds(), req.GetApprovalRequired(), "approverIds", "approvalRequired")
		if err != nil {
			return err
		}
		if err := checkCreateGate(len(approvers), required, *st); err != nil {
			return err
		}
		number, err := q.NextTaskNumber(r.Context(), boardID)
		if err != nil {
			return err
		}
		roomID, err := q.CreateTaskRoom(r.Context(), sqlc.CreateTaskRoomParams{WorkspaceID: &b.WorkspaceID, Name: TaskKey(b.Key, number)})
		if err != nil {
			return err
		}
		pos, err := place(r.Context(), q, st.ID, uuid.Nil, after, nil)
		if err != nil {
			return err
		}
		t := taskRow{BoardID: boardID, Number: number, Title: title, Description: desc, StatusID: st.ID, Priority: prio,
			CreatedBy: &me, Estimate: est, StartOn: start, DueOn: due, ParentID: parent, MilestoneID: ms, Position: pos,
			RoomID: roomID, BoardKey: b.Key, WorkspaceID: b.WorkspaceID, ApprovalRequired: required}
		finishFields(&t, st.Type, me, now)
		if taskID, err = q.InsertTask(r.Context(), sqlc.InsertTaskParams{
			BoardID: t.BoardID, Number: t.Number, Title: t.Title, Description: t.Description, StatusID: t.StatusID,
			Priority: t.Priority, CreatedBy: t.CreatedBy, Estimate: t.Estimate, StartOn: t.StartOn, DueOn: t.DueOn,
			ParentID: t.ParentID, MilestoneID: t.MilestoneID, Position: t.Position, RoomID: t.RoomID,
			StartedAt: t.StartedAt, CompletedAt: t.CompletedAt, CompletedBy: t.CompletedBy, ApprovalRequired: required,
		}); err != nil {
			return err
		}
		t.ID = taskID
		for _, u := range approvers {
			if err := q.InsertTaskApprover(r.Context(), sqlc.InsertTaskApproverParams{TaskID: taskID, UserID: u, AddedBy: &me}); err != nil {
				return err
			}
		}
		if len(labels) > 0 {
			if err := q.InsertTaskLabels(r.Context(), sqlc.InsertTaskLabelsParams{TaskID: taskID, LabelIds: labels}); err != nil {
				return err
			}
		}
		if err := attach(r.Context(), q, t, fileIDs, me); err != nil {
			return err
		}
		fresh, _, err := writeAssignees(r.Context(), q, taskID, assignees, &me, now)
		if err != nil {
			return err
		}
		after := map[string]any{"title": title, "status_id": st.ID.String(), "status_type": st.Type, "priority": int(prio),
			"assignees": inputsJSON(assignees), "label_ids": idsJSON(labels)}
		if fromMsg != nil {
			after["from_message_id"] = fromMsg.String()
		}
		if len(approvers) > 0 {
			after["approvers"], after["approval_required"] = idsJSON(approvers), int(required)
		}
		if parent != nil {
			after["parent_id"] = parent.String()
			c.tasks = append(c.tasks, *parent)
		}
		if err := c.record(r.Context(), q, t, me, "created", nil, after); err != nil {
			return err
		}
		// The author subscribes; the approvers (first: their notice is mandatory), the assignees
		// and the users @mentioned in the description are subscribed and notified. The author
		// edits their new task: those they @mention themselves become watchers (ADR-0076 §5).
		if err := q.Subscribe(r.Context(), sqlc.SubscribeParams{TaskID: taskID, UserIds: []uuid.UUID{me}}); err != nil {
			return err
		}
		if err := s.notifyApprovers(r.Context(), q, t, me, approvers, &c); err != nil {
			return err
		}
		mentioned, _ := messages.ParseMentions(desc)
		invited, _ := messages.ParseMentions(own)
		if _, err := mentionWatchers(r.Context(), q, t, me, true, invited, &c); err != nil {
			return err
		}
		return s.notifyDirect(r.Context(), q, t, me, fresh, mentioned, uuid.Nil, &c)
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, true)
	return s.respondTask(w, r, taskID, http.StatusCreated, false)
}

// createFeatures checks a new task against the board's features (ADR-0058 §3): every field
// that is set must belong to a feature that is on; the estimate must be on the board's scale.
func createFeatures(b sqlc.Board, req *v1.CreateTaskRequest, est *int16) error {
	d := b.DisabledFeatures
	for _, c := range []struct {
		f     v1.BoardFeature
		field string
		sets  bool
	}{
		{v1.BoardFeature_BOARD_FEATURE_ESTIMATE, "estimate", est != nil},
		{v1.BoardFeature_BOARD_FEATURE_START_DATE, "startOn", strings.TrimSpace(req.GetStartOn()) != ""},
		{v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn", strings.TrimSpace(req.GetDueOn()) != ""},
		{v1.BoardFeature_BOARD_FEATURE_PRIORITY, "priority", req.GetPriority() != v1.TaskPriority_TASK_PRIORITY_NONE},
		{v1.BoardFeature_BOARD_FEATURE_LABELS, "labelIds", len(req.GetLabelIds()) > 0},
		{v1.BoardFeature_BOARD_FEATURE_MILESTONES, "milestoneId", req.GetMilestoneId() != ""},
		{v1.BoardFeature_BOARD_FEATURE_SUBTASKS, "parentId", req.GetParentId() != ""},
		{v1.BoardFeature_BOARD_FEATURE_ATTACHMENTS, "attachmentIds", len(req.GetAttachmentIds()) > 0},
		{v1.BoardFeature_BOARD_FEATURE_APPROVALS, "approverIds", len(req.GetApproverIds()) > 0},
	} {
		if err := requireFeature(d, c.f, c.field, c.sets); err != nil {
			return err
		}
	}
	return checkScale(b.EstimateScale, est)
}

// checkScale: an estimate (nil = none) must be a value of the board's scale (422 estimate).
func checkScale(scale string, est *int16) error {
	if est != nil && !InScale(scale, *est) {
		return httpx.Validation("estimate", "the estimate is not on the board's "+scale+" scale")
	}
	return nil
}

// updateFeatures checks the changed fields of a task against its board's features (ADR-0058
// §3): a field may be cleared or set to its current value, never set to a new value of a
// feature that is off. Labels and attachments are checked where they are written (additions).
func updateFeatures(ctx context.Context, q *sqlc.Queries, acc perm.BoardAccess, old, t taskRow) error {
	est := func(e *int16) any {
		if e == nil {
			return nil
		}
		return int(*e)
	}
	d := acc.DisabledFeatures
	estimateSet := t.Estimate != nil && est(old.Estimate) != est(t.Estimate)
	for _, c := range []struct {
		f     v1.BoardFeature
		field string
		sets  bool
	}{
		{v1.BoardFeature_BOARD_FEATURE_ESTIMATE, "estimate", estimateSet},
		{v1.BoardFeature_BOARD_FEATURE_START_DATE, "startOn", t.StartOn.Valid && dateAny(old.StartOn) != dateAny(t.StartOn)},
		{v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn", t.DueOn.Valid && dateAny(old.DueOn) != dateAny(t.DueOn)},
		{v1.BoardFeature_BOARD_FEATURE_PRIORITY, "priority", t.Priority != 0 && t.Priority != old.Priority},
		{v1.BoardFeature_BOARD_FEATURE_MILESTONES, "milestoneId", t.MilestoneID != nil && !eqID(old.MilestoneID, t.MilestoneID)},
		{v1.BoardFeature_BOARD_FEATURE_SUBTASKS, "parentId", t.ParentID != nil && !eqID(old.ParentID, t.ParentID)},
		{v1.BoardFeature_BOARD_FEATURE_MILESTONES, "taskMilestoneId", t.TaskMilestoneID != nil && !eqID(old.TaskMilestoneID, t.TaskMilestoneID)},
	} {
		if err := requireFeature(d, c.f, c.field, c.sets); err != nil {
			return err
		}
	}
	if !estimateSet {
		return nil // an unchanged value off the scale stays until it is edited
	}
	b, err := q.GetBoard(ctx, t.BoardID)
	if err != nil {
		return err
	}
	return checkScale(b.EstimateScale, t.Estimate)
}

// adds reports whether next has an id that was not in was.
func adds(was, next []uuid.UUID) bool {
	for _, id := range next {
		if !slices.Contains(was, id) {
			return true
		}
	}
	return false
}

// checkParent: a live task of the same board without a parent itself (one level), not the task
// itself nor one of its subtasks, with < 200 subtasks.
func checkParent(ctx context.Context, q *sqlc.Queries, dbtx sqlc.DBTX, boardID, parentID, self uuid.UUID) error {
	if parentID == self {
		return httpx.Validation("parentId", "a task cannot be its own parent")
	}
	p, ok, err := taskByID(ctx, dbtx, parentID, false)
	if err != nil {
		return err
	}
	if !ok || p.BoardID != boardID || p.ArchivedAt != nil {
		return httpx.Validation("parentId", "a live task of this board is required")
	}
	if p.ParentID != nil {
		return httpx.Validation("parentId", "subtasks have one level")
	}
	if self != uuid.Nil {
		var kids int
		if err := dbtx.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE parent_id = $1`, self).Scan(&kids); err != nil {
			return err
		}
		if kids > 0 {
			return httpx.Validation("parentId", "a task with subtasks cannot become a subtask")
		}
	}
	n, err := q.CountLiveSubtasks(ctx, &parentID)
	if err != nil {
		return err
	}
	if n >= MaxSubtasks {
		return httpx.Conflict("at most 200 subtasks")
	}
	return nil
}

func fileIDs(raw []string) ([]uuid.UUID, error) {
	if len(raw) > MaxAttachments {
		return nil, httpx.Validation("attachmentIds", "at most 20 attachments")
	}
	out := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		id, err := uuid.Parse(s)
		if err != nil || slices.Contains(out, id) {
			return nil, httpx.Validation("attachmentIds", "invalid or duplicate file id")
		}
		out = append(out, id)
	}
	return out, nil
}

// attach replaces the description's attachments: the caller's own uploads to the workspace not
// attached elsewhere (files the task already has stay allowed).
func attach(ctx context.Context, q *sqlc.Queries, t taskRow, ids []uuid.UUID, me uuid.UUID) error {
	if len(ids) > 0 {
		cur, err := q.TaskAttachmentIDs(ctx, t.ID)
		if err != nil {
			return err
		}
		var check []uuid.UUID
		for _, id := range ids {
			if !slices.Contains(cur, id) {
				check = append(check, id)
			}
		}
		if len(check) > 0 {
			ok, err := q.FilesAttachable(ctx, sqlc.FilesAttachableParams{Ids: check, UserID: me, WorkspaceID: t.WorkspaceID, TaskID: t.ID})
			if err != nil {
				return err
			}
			if len(ok) != len(check) {
				return httpx.Validation("attachmentIds", "files must be unattached uploads of yours in this workspace")
			}
		}
	}
	if err := q.DeleteTaskAttachments(ctx, t.ID); err != nil {
		return err
	}
	for i, id := range ids {
		if err := q.InsertTaskAttachment(ctx, sqlc.InsertTaskAttachmentParams{TaskID: t.ID, FileID: id, Position: int16(i)}); err != nil { //nolint:gosec // ≤ 20
			return err
		}
	}
	return nil
}

// respondTask answers with the task as the caller sees it; full adds subtasks, related tasks,
// the parent, attachments and the room (GET).
func (s *Service) respondTask(w http.ResponseWriter, r *http.Request, id uuid.UUID, status int, full bool) error {
	out, err := s.taskResponse(r, id, full)
	if err != nil {
		return err
	}
	httpx.Write(w, status, out)
	return nil
}

func (s *Service) taskResponse(r *http.Request, id uuid.UUID, full bool) (*v1.TaskResponse, error) {
	ctx := r.Context()
	t, ok, err := taskByID(ctx, s.db.Pool, id, false)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpx.NotFound("task")
	}
	me := uid(r)
	pbs, err := tasksProto(ctx, s.db.Q, []taskRow{t}, me)
	if err != nil {
		return nil, err
	}
	out := &v1.TaskResponse{Task: pbs[0]}
	if !full {
		return out, nil
	}
	fs, err := s.db.Q.ListTaskAttachments(ctx, t.ID)
	if err != nil {
		return nil, err
	}
	out.Task.Attachments = files(fs)
	if out.Task.Checklists, err = taskChecklists(ctx, s.db.Q, t.ID); err != nil {
		return nil, err
	}
	ls, err := s.db.Q.ListTaskGitLinks(ctx, t.ID)
	if err != nil {
		return nil, err
	}
	out.Task.GitLinks = gitLinks(ls)
	subs, err := queryTasks(ctx, s.db.Pool, "WHERE t.parent_id = $1 AND t.archived_at IS NULL ORDER BY t.position, t.number", t.ID)
	if err != nil {
		return nil, err
	}
	if subs, err = visibleTasks(ctx, s.db.Q, subs, me); err != nil { // ADR-0059
		return nil, err
	}
	if out.Subtasks, err = tasksProto(ctx, s.db.Q, subs, me); err != nil {
		return nil, err
	}
	var relIDs []uuid.UUID
	for _, rel := range out.Task.GetRelations() {
		other := rel.GetRelatedId()
		if other == t.ID.String() {
			other = rel.GetTaskId()
		}
		if oid, err := uuid.Parse(other); err == nil && !slices.Contains(relIDs, oid) {
			relIDs = append(relIDs, oid)
		}
	}
	if t.ParentID != nil {
		relIDs = append(relIDs, *t.ParentID)
	}
	if len(relIDs) > 0 {
		rows, err := queryTasks(ctx, s.db.Pool, "WHERE t.id = ANY($1)", relIDs)
		if err != nil {
			return nil, err
		}
		// Only tasks the caller sees (a relation may cross boards; ADR-0059: task-scoped boards).
		visible, err := visibleTasks(ctx, s.db.Q, rows, me)
		if err != nil {
			return nil, err
		}
		pbs, err := tasksProto(ctx, s.db.Q, visible, me)
		if err != nil {
			return nil, err
		}
		for _, p := range pbs {
			if t.ParentID != nil && p.GetId() == t.ParentID.String() {
				out.Parent = p
				continue
			}
			out.Related = append(out.Related, p)
		}
	}
	room, err := s.db.Q.GetRoom(ctx, t.RoomID)
	if err == nil {
		out.Room, err = rooms.Load(ctx, s.db.Q, room)
	}
	return out, err
}

func (s *Service) getTask(w http.ResponseWriter, r *http.Request) error {
	t, _, err := s.loadTask(r, s.db.Pool, false)
	if err != nil {
		return err
	}
	return s.respondTask(w, r, t.ID, http.StatusOK, true)
}

// lookup: GET /api/t/{key}[?workspace_id=] — a task by its key among the caller's workspaces.
func (s *Service) lookup(w http.ResponseWriter, r *http.Request) error {
	key, n, ok := ParseKey(r.PathValue("key"))
	if !ok {
		return httpx.NotFound("task")
	}
	var wss []uuid.UUID
	if raw := r.URL.Query().Get("workspace_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return httpx.BadRequest("workspace_id must be a workspace id")
		}
		wss = []uuid.UUID{id}
	} else {
		ids, err := s.db.Q.ListUserWorkspaceIDs(r.Context(), uid(r))
		if err != nil {
			return err
		}
		wss = ids
	}
	for _, ws := range wss {
		t, err := s.db.Q.GetTaskByNumber(r.Context(), sqlc.GetTaskByNumberParams{WorkspaceID: ws, Key: key, Number: n})
		if db.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		row, ok, err := taskByID(r.Context(), s.db.Pool, t.ID, false)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if _, err := taskOf(r, s.db.Q, row); err != nil {
			continue
		}
		acc, err := board(r, t.BoardID, false)
		if err != nil {
			continue
		}
		out, err := s.taskResponse(r, t.ID, true)
		if err != nil {
			return err
		}
		if out.Board, err = s.boardFor(r.Context(), s.db.Q, t.BoardID, uid(r), acc); err != nil {
			return err
		}
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	return httpx.NotFound("task")
}

func (s *Service) updateTask(w http.ResponseWriter, r *http.Request) error {
	var req v1.UpdateTaskRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	me, now := uid(r), s.Now()
	var c change
	var taskID uuid.UUID
	err := s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, acc, err := s.loadTask(r, tx, true)
		if err != nil {
			return err
		}
		taskID = t.ID
		if err := requireEdit(r.Context(), q, acc, t, me); err != nil {
			return err
		}
		if t.ArchivedAt != nil {
			return httpx.Conflict("the task is archived; restore it first")
		}
		old := t
		it, err := items(r.Context(), q, t.BoardID)
		if err != nil {
			return err
		}
		if req.BoardId != nil && req.GetBoardId() != t.BoardID.String() {
			return s.moveBoard(r, q, tx, &t, acc, req.GetBoardId(), &c)
		}
		if req.Title != nil {
			if t.Title, err = validTitle(req.GetTitle()); err != nil {
				return err
			}
		}
		if req.Description != nil {
			if t.Description, err = validDescription(req.GetDescription()); err != nil {
				return err
			}
		}
		if req.Priority != nil {
			if t.Priority, err = validPriority(req.GetPriority()); err != nil {
				return err
			}
		}
		if req.Estimate != nil {
			if t.Estimate, err = validEstimate(req.GetEstimate()); err != nil {
				return err
			}
		}
		if req.StartOn != nil {
			d, ok := ParseDate(req.GetStartOn())
			if !ok {
				return httpx.Validation("startOn", "date must be YYYY-MM-DD")
			}
			t.StartOn = d
		}
		if req.DueOn != nil {
			d, ok := ParseDate(req.GetDueOn())
			if !ok {
				return httpx.Validation("dueOn", "date must be YYYY-MM-DD")
			}
			t.DueOn = d
		}
		if t.StartOn.Valid && t.DueOn.Valid && t.DueOn.Time.Before(t.StartOn.Time) {
			return httpx.Validation("dueOn", "the due date is before the start")
		}
		if req.MilestoneId != nil {
			if t.MilestoneID, err = parseOptID("milestoneId", req.GetMilestoneId()); err != nil {
				return err
			}
			if t.MilestoneID != nil && !it.milestones[*t.MilestoneID] {
				return httpx.Validation("milestoneId", "a milestone of this board is required")
			}
		}
		if req.ParentId != nil {
			if t.ParentID, err = parseOptID("parentId", req.GetParentId()); err != nil {
				return err
			}
			if t.ParentID != nil && !eqID(t.ParentID, old.ParentID) {
				// ADR-0059: only under a task the caller sees — checked first, so that checkParent's
				// answers (one level, subtask limit) say nothing about a task they do not see.
				if acc.TaskScoped {
					p, _, err := taskByID(r.Context(), tx, *t.ParentID, false)
					if err != nil {
						return err
					}
					if _, err := taskOf(r, q, p); err != nil {
						return httpx.Validation("parentId", "a live task of this board is required")
					}
				}
				if err := checkParent(r.Context(), q, tx, t.BoardID, *t.ParentID, t.ID); err != nil {
					return err
				}
			}
		}
		// A subtask's milestone (ADR-0063): one of its parent's; reset when the parent changes.
		if req.TaskMilestoneId != nil {
			if t.TaskMilestoneID, err = parseOptID("taskMilestoneId", req.GetTaskMilestoneId()); err != nil {
				return err
			}
		} else if !eqID(old.ParentID, t.ParentID) {
			t.TaskMilestoneID = nil
		}
		if !eqID(old.TaskMilestoneID, t.TaskMilestoneID) || !eqID(old.ParentID, t.ParentID) {
			if err := subtaskMilestone(r.Context(), q, t); err != nil {
				return err
			}
		}
		if err := updateFeatures(r.Context(), q, acc, old, t); err != nil {
			return err
		}
		var attIDs, attWas []uuid.UUID
		attChanged := false
		if req.GetSetAttachments() {
			if attIDs, err = fileIDs(req.GetAttachmentIds()); err != nil {
				return err
			}
			if attWas, err = q.TaskAttachmentIDs(r.Context(), t.ID); err != nil {
				return err
			}
			attChanged = !slices.Equal(attWas, attIDs)
			if err := requireFeature(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_ATTACHMENTS, "attachmentIds", adds(attWas, attIDs)); err != nil {
				return err
			}
		}
		approvalsOff := Disabled(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_APPROVALS)
		// A new title, description or description attachments reset the votes (ADR-0049 §3).
		resets := t.Title != old.Title || t.Description != old.Description || attChanged
		from := it.statuses[t.StatusID]
		to := from
		if req.StatusId != nil {
			sid, err := uuid.Parse(req.GetStatusId())
			if err != nil {
				return httpx.Validation("statusId", "invalid status id")
			}
			x, ok := it.statuses[sid]
			if !ok {
				return httpx.Validation("statusId", "a status of this board is required")
			}
			to, t.StatusID = x, sid
		}
		// APPROVALS off (ADR-0058 §3): the gate does not apply; the votes are kept.
		if t.StatusID != old.StatusID && !approvalsOff {
			tl, err := taskTally(r.Context(), q, old)
			if err != nil {
				return err
			}
			if resets {
				tl = tl.reset() // the same request resets the votes: they do not count
			}
			if err := checkApprovalGate(tl, from, to); err != nil {
				return err
			}
		}
		after, err := parseOptID("afterTaskId", req.GetAfterTaskId())
		if err != nil {
			return err
		}
		before, err := parseOptID("beforeTaskId", req.GetBeforeTaskId())
		if err != nil {
			return err
		}
		if after != nil || before != nil || t.StatusID != old.StatusID {
			if t.Position, err = place(r.Context(), q, t.StatusID, t.ID, after, before); err != nil {
				return err
			}
		}
		if t.StatusID != old.StatusID {
			finishFields(&t, to.Type, me, now)
		}
		if err := updateRow(r.Context(), q, t); err != nil {
			return err
		}
		if err := s.recordFields(r.Context(), q, old, t, from, to, me, &c); err != nil {
			return err
		}
		if req.GetSetLabels() {
			labels, err := it.labelIDs(req.GetLabelIds())
			if err != nil {
				return err
			}
			cur, err := q.ListTaskLabelIDs(r.Context(), []uuid.UUID{t.ID})
			if err != nil {
				return err
			}
			var was []uuid.UUID
			for _, l := range cur {
				was = append(was, l.LabelID)
			}
			if err := requireFeature(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_LABELS, "labelIds", adds(was, labels)); err != nil {
				return err
			}
			if !sameSet(was, labels) {
				if err := q.DeleteTaskLabels(r.Context(), t.ID); err != nil {
					return err
				}
				if len(labels) > 0 {
					if err := q.InsertTaskLabels(r.Context(), sqlc.InsertTaskLabelsParams{TaskID: t.ID, LabelIds: labels}); err != nil {
						return err
					}
				}
				if err := c.record(r.Context(), q, t, me, "labels", map[string]any{"label_ids": idsJSON(was)}, map[string]any{"label_ids": idsJSON(labels)}); err != nil {
					return err
				}
			}
		}
		if attChanged {
			if err := attach(r.Context(), q, t, attIDs, me); err != nil {
				return err
			}
			if err := c.record(r.Context(), q, t, me, "attachments", map[string]any{"file_ids": idsJSON(attWas)}, map[string]any{"file_ids": idsJSON(attIDs)}); err != nil {
				return err
			}
		}
		if resets && !approvalsOff {
			if err := s.resetApprovals(r.Context(), q, t, me, &c); err != nil {
				return err
			}
		}
		for _, p := range []*uuid.UUID{old.ParentID, t.ParentID} {
			if p != nil && !eqID(old.ParentID, t.ParentID) {
				c.tasks = append(c.tasks, *p)
			}
		}
		if (t.StatusID != old.StatusID || !eqID(old.TaskMilestoneID, t.TaskMilestoneID)) && t.ParentID != nil {
			c.tasks = append(c.tasks, *t.ParentID) // subtask_done / milestone progress of the parent
		}
		// Notifications: a status change to subscribers; new @mentions of the description.
		if t.StatusID != old.StatusID {
			if err := s.notifySubscribers(r.Context(), q, t, me, notifications.TaskStatus, uuid.Nil, &c); err != nil {
				return err
			}
		}
		if t.Description != old.Description {
			now, _ := messages.ParseMentions(t.Description)
			was, _ := messages.ParseMentions(old.Description)
			var added []uuid.UUID
			for _, u := range now {
				if !slices.Contains(was, u) {
					added = append(added, u)
				}
			}
			// The caller edits the task (requireEdit above): the new mentions become watchers
			// (ADR-0076 §5).
			if _, err := mentionWatchers(r.Context(), q, t, me, true, added, &c); err != nil {
				return err
			}
			if err := s.notifyDirect(r.Context(), q, t, me, nil, added, uuid.Nil, &c); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

func eqID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func sameSet(a, b []uuid.UUID) bool {
	if len(a) != len(b) {
		return false
	}
	for _, x := range a {
		if !slices.Contains(b, x) {
			return false
		}
	}
	return true
}

func dateAny(d pgtype.Date) any {
	if !d.Valid {
		return nil
	}
	return DateString(d)
}

func idAny(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return id.String()
}

// recordFields writes a journal entry for each changed field group.
func (s *Service) recordFields(ctx context.Context, q *sqlc.Queries, old, t taskRow, from, to sqlc.BoardStatus, me uuid.UUID, c *change) error {
	type entry struct {
		kind          string
		before, after map[string]any
		changed       bool
	}
	est := func(e *int16) any {
		if e == nil {
			return nil
		}
		return int(*e)
	}
	entries := []entry{
		{"title", map[string]any{"title": old.Title}, map[string]any{"title": t.Title}, old.Title != t.Title},
		{"description", map[string]any{"length": utf8.RuneCountInString(old.Description)}, map[string]any{"length": utf8.RuneCountInString(t.Description)}, old.Description != t.Description},
		{"priority", map[string]any{"priority": int(old.Priority)}, map[string]any{"priority": int(t.Priority)}, old.Priority != t.Priority},
		{"estimate", map[string]any{"estimate": est(old.Estimate)}, map[string]any{"estimate": est(t.Estimate)}, est(old.Estimate) != est(t.Estimate)},
		{"dates", map[string]any{"start_on": dateAny(old.StartOn), "due_on": dateAny(old.DueOn)}, map[string]any{"start_on": dateAny(t.StartOn), "due_on": dateAny(t.DueOn)},
			dateAny(old.StartOn) != dateAny(t.StartOn) || dateAny(old.DueOn) != dateAny(t.DueOn)},
		{"parent", map[string]any{"parent_id": idAny(old.ParentID)}, map[string]any{"parent_id": idAny(t.ParentID)}, !eqID(old.ParentID, t.ParentID)},
		{"milestone", map[string]any{"milestone_id": idAny(old.MilestoneID)}, map[string]any{"milestone_id": idAny(t.MilestoneID)}, !eqID(old.MilestoneID, t.MilestoneID)},
		{"status", map[string]any{"status_id": old.StatusID.String(), "status_type": from.Type, "position": old.Position},
			map[string]any{"status_id": t.StatusID.String(), "status_type": to.Type, "position": t.Position}, old.StatusID != t.StatusID},
	}
	if !eqID(old.TaskMilestoneID, t.TaskMilestoneID) { // a subtask's milestone (ADR-0063)
		action := "linked"
		if t.TaskMilestoneID == nil {
			action = "unlinked"
		}
		entries = append(entries, entry{kindMilestones, map[string]any{"task_milestone_id": idAny(old.TaskMilestoneID)},
			map[string]any{"action": action, "task_milestone_id": idAny(t.TaskMilestoneID), "parent_id": idAny(t.ParentID)}, true})
	}
	for _, e := range entries {
		if e.changed {
			if err := c.record(ctx, q, t, me, e.kind, e.before, e.after); err != nil {
				return err
			}
		}
	}
	return nil
}

// moveBoard moves a task to another board (MANAGE_BOARD on both, ADR-0042 §5): a new number,
// the status of the same type (else the default), labels by name, no milestone / parent;
// its subtasks lose their parent.
func (s *Service) moveBoard(r *http.Request, q *sqlc.Queries, tx pgx.Tx, t *taskRow, src perm.BoardAccess, raw string, c *change) error {
	me := uid(r)
	dstID, err := uuid.Parse(raw)
	if err != nil {
		return httpx.Validation("boardId", "invalid board id")
	}
	dst, err := board(r, dstID, false)
	if err != nil {
		return err
	}
	if !src.Bits.Has(perm.ManageBoard) || !dst.Bits.Has(perm.ManageBoard) {
		return httpx.Forbidden("MANAGE_BOARD required on both boards")
	}
	if dst.WorkspaceID != src.WorkspaceID {
		return httpx.Validation("boardId", "a board of the same workspace is required")
	}
	b, err := q.GetBoardForUpdate(r.Context(), dstID)
	if err != nil {
		return err
	}
	if n, err := q.CountLiveTasks(r.Context(), dstID); err != nil {
		return err
	} else if n >= MaxTasks {
		return httpx.Conflict("at most 5000 live tasks per board").WithDetails(ReasonBoardTaskLimit, uint64(max(n, 0)), MaxTasks)
	}
	srcItems, err := items(r.Context(), q, t.BoardID)
	if err != nil {
		return err
	}
	dstItems, err := items(r.Context(), q, dstID)
	if err != nil {
		return err
	}
	from := srcItems.statuses[t.StatusID]
	to := dstItems.def
	var same *sqlc.BoardStatus
	for _, st := range dstItems.statuses {
		if st.Type == from.Type && (same == nil || st.Position < same.Position) {
			st := st
			same = &st
		}
	}
	if same != nil && (to == nil || to.Type != from.Type) {
		to = same
	}
	if to == nil {
		return httpx.Conflict("the target board has no status")
	}
	// Approvers and votes move along; a task not approved may not land in COMPLETED (ADR-0049 §2)
	// unless the target board has APPROVALS off (ADR-0058 §3). Other features may differ: the
	// fields stay and are just hidden there.
	if !Disabled(dst.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_APPROVALS) {
		tl, err := taskTally(r.Context(), q, *t)
		if err != nil {
			return err
		}
		if err := checkApprovalGate(tl, from, *to); err != nil {
			return err
		}
	}
	cur, err := q.ListTaskLabelIDs(r.Context(), []uuid.UUID{t.ID})
	if err != nil {
		return err
	}
	var labels []uuid.UUID
	for _, l := range cur {
		name := strings.ToLower(srcItems.labels[l.LabelID].Name)
		for id, dl := range dstItems.labels {
			if strings.ToLower(dl.Name) == name {
				labels = append(labels, id)
			}
		}
	}
	number, err := q.NextTaskNumber(r.Context(), dstID)
	if err != nil {
		return err
	}
	pos, err := place(r.Context(), q, to.ID, t.ID, nil, nil)
	if err != nil {
		return err
	}
	// The subtasks are detached before the task's own row changes: the move rewrites board_id and
	// number (a unique key, so the row update takes FOR UPDATE), and a subtask's transaction holds
	// the subtask while it journals on this task (KEY SHARE). Waiting for the subtasks under the
	// row lock taken so far (FOR NO KEY UPDATE, taskByID) lets that transaction finish first.
	kids, err := queryTasks(r.Context(), tx, "WHERE t.parent_id = $1", t.ID)
	if err != nil {
		return err
	}
	if err := q.DetachSubtasks(r.Context(), &t.ID); err != nil {
		return err
	}
	oldKey, oldBoard := TaskKey(t.BoardKey, t.Number), t.BoardID
	if err := q.MoveTaskToBoard(r.Context(), sqlc.MoveTaskToBoardParams{BoardID: dstID, Number: number, StatusID: to.ID, Position: pos, ID: t.ID}); err != nil {
		return err
	}
	if err := q.DeleteTaskLabels(r.Context(), t.ID); err != nil {
		return err
	}
	if len(labels) > 0 {
		if err := q.InsertTaskLabels(r.Context(), sqlc.InsertTaskLabelsParams{TaskID: t.ID, LabelIds: labels}); err != nil {
			return err
		}
	}
	for _, k := range kids {
		c.tasks = append(c.tasks, k.ID)
	}
	if t.ParentID != nil {
		c.tasks = append(c.tasks, *t.ParentID)
	}
	moved, _, err := taskByID(r.Context(), tx, t.ID, false)
	if err != nil {
		return err
	}
	finishFields(&moved, to.Type, me, s.Now())
	if err := updateRow(r.Context(), q, moved); err != nil {
		return err
	}
	if err := c.record(r.Context(), q, moved, me, "moved_board",
		map[string]any{"board_id": oldBoard.String(), "key": oldKey, "status_id": from.ID.String()},
		map[string]any{"board_id": dstID.String(), "key": TaskKey(b.Key, number), "status_id": to.ID.String()}); err != nil {
		return err
	}
	// The old board's viewers lose the task; the new board's get it as TASK_CREATE.
	c.before = append(c.before, wsEvent{src.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskDelete{TaskDelete: &v1.TaskDelete{
		WorkspaceId: src.WorkspaceID.String(), BoardId: oldBoard.String(), TaskId: t.ID.String()}}}})
	c.moved = true
	return nil
}

// setArchived: POST /api/tasks/{id}/archive | restore. EDIT_TASKS, or the author (CREATE_TASKS).
func (s *Service) setArchived(w http.ResponseWriter, r *http.Request, archived bool) error {
	me := uid(r)
	var c change
	var t taskRow
	err := s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		var acc perm.BoardAccess
		var err error
		if t, acc, err = s.loadTask(r, tx, true); err != nil {
			return err
		}
		if err := writable(acc); err != nil {
			return err
		}
		own := t.CreatedBy != nil && *t.CreatedBy == me && acc.Bits.Has(perm.CreateTasks)
		if !acc.Bits.Has(perm.EditTasks) && !own {
			return httpx.Forbidden("EDIT_TASKS required to archive others' tasks")
		}
		if (t.ArchivedAt != nil) == archived {
			return nil
		}
		if !archived {
			n, err := q.CountLiveTasks(r.Context(), t.BoardID)
			if err != nil {
				return err
			}
			if n >= MaxTasks {
				return httpx.Conflict("at most 5000 live tasks per board").WithDetails(ReasonBoardTaskLimit, uint64(max(n, 0)), MaxTasks)
			}
		}
		if err := q.SetTaskArchived(r.Context(), sqlc.SetTaskArchivedParams{ID: t.ID, Archived: archived}); err != nil {
			return err
		}
		kind := "archived"
		if !archived {
			kind = "restored"
		}
		if t.ParentID != nil {
			c.tasks = append(c.tasks, *t.ParentID)
		}
		return c.record(r.Context(), q, t, me, kind, nil, nil)
	})
	if err != nil {
		return err
	}
	if archived {
		s.ev.Workspace(r.Context(), t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskDelete{TaskDelete: &v1.TaskDelete{
			WorkspaceId: t.WorkspaceID.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String()}}})
		for _, a := range c.acts {
			s.ev.Workspace(r.Context(), t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: &v1.TaskActivityAppend{
				WorkspaceId: t.WorkspaceID.String(), Activity: activity(a)}}})
		}
		for _, id := range c.tasks {
			s.publishTaskEvent(r.Context(), id, false)
		}
	} else {
		s.publish(r.Context(), t.ID, &c, true)
	}
	return s.respondTask(w, r, t.ID, http.StatusOK, false)
}

func (s *Service) setAssignees(w http.ResponseWriter, r *http.Request) error {
	var req v1.SetAssigneesRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	me := uid(r)
	var c change
	var taskID uuid.UUID
	err := s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, acc, err := s.loadTask(r, tx, true)
		if err != nil {
			return err
		}
		taskID = t.ID
		if err := requireEdit(r.Context(), q, acc, t, me); err != nil {
			return err
		}
		if t.ArchivedAt != nil {
			return httpx.Conflict("the task is archived; restore it first")
		}
		in, err := assigneesIn(r.Context(), q, t.BoardID, req.GetAssignees())
		if err != nil {
			return err
		}
		fresh, old, err := writeAssignees(r.Context(), q, t.ID, in, &me, s.Now())
		if err != nil {
			return err
		}
		if err := q.TouchTask(r.Context(), t.ID); err != nil {
			return err
		}
		if err := c.record(r.Context(), q, t, me, "assignees", map[string]any{"assignees": assigneesJSON(old)}, map[string]any{"assignees": inputsJSON(in)}); err != nil {
			return err
		}
		return s.notifyDirect(r.Context(), q, t, me, fresh, nil, uuid.Nil, &c)
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

func relationKind(k v1.TaskRelationKind) (string, error) {
	s, ok := relationKinds[k]
	if !ok {
		return "", httpx.Validation("kind", "kind must be BLOCKS, RELATES or DUPLICATES")
	}
	return s, nil
}

func (s *Service) addRelation(w http.ResponseWriter, r *http.Request) error {
	var req v1.SetTaskRelationRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	kind, err := relationKind(req.GetKind())
	if err != nil {
		return err
	}
	other, err := uuid.Parse(req.GetRelatedId())
	if err != nil {
		return httpx.Validation("relatedId", "invalid task id")
	}
	return s.relation(w, r, other, kind, true)
}

func (s *Service) removeRelation(w http.ResponseWriter, r *http.Request) error {
	qs := r.URL.Query()
	other, err := uuid.Parse(qs.Get("related_id"))
	if err != nil {
		return httpx.Validation("relatedId", "invalid task id")
	}
	k := strings.ToLower(qs.Get("kind"))
	if k != "blocks" && k != "relates" && k != "duplicates" {
		n, _ := strconv.Atoi(k)
		if k, err = relationKind(v1.TaskRelationKind(n)); err != nil { //nolint:gosec // validated
			return err
		}
	}
	return s.relation(w, r, other, k, false)
}

func (s *Service) relation(w http.ResponseWriter, r *http.Request, other uuid.UUID, kind string, add bool) error {
	me := uid(r)
	var c change
	var taskID uuid.UUID
	err := s.taskTx(r.Context(), &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, acc, err := s.loadTask(r, tx, true)
		if err != nil {
			return err
		}
		taskID = t.ID
		if err := requireEdit(r.Context(), q, acc, t, me); err != nil {
			return err
		}
		if other == t.ID {
			return httpx.Validation("relatedId", "a task cannot relate to itself")
		}
		o, _, err := s.taskAccess(r, tx, other, false)
		if err != nil {
			return httpx.Validation("relatedId", "a task you can see is required")
		}
		if o.WorkspaceID != t.WorkspaceID {
			return httpx.Validation("relatedId", "a task of the same workspace is required")
		}
		var n int64
		if add {
			if n, err = q.InsertTaskRelation(r.Context(), sqlc.InsertTaskRelationParams{TaskID: t.ID, RelatedID: other, Kind: kind, CreatedBy: &me}); err != nil {
				return err
			}
		} else if n, err = q.DeleteTaskRelation(r.Context(), sqlc.DeleteTaskRelationParams{Kind: kind, A: t.ID, B: other}); err != nil {
			return err
		}
		if n == 0 {
			return nil // a repeat (or nothing to remove)
		}
		// RELATIONS off (ADR-0058 §3): a new relation is refused, removing stays allowed.
		if err := requireFeature(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_RELATIONS, "relatedId", add); err != nil {
			return err
		}
		c.tasks = append(c.tasks, other)
		rel := map[string]any{"related_id": other.String(), "kind": kind}
		if add {
			return c.record(r.Context(), q, t, me, "relation", nil, rel)
		}
		return c.record(r.Context(), q, t, me, "relation", rel, nil)
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

func (s *Service) setSubscription(w http.ResponseWriter, r *http.Request) error {
	t, acc, err := s.loadTask(r, s.db.Pool, false)
	if err != nil {
		return err
	}
	if err := writable(acc); err != nil {
		return err
	}
	var req v1.SetTaskSubscriptionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if _, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.TaskSubscriber, error) {
		return guarded.SetSubscription(r.Context(), sqlc.SetSubscriptionParams{TaskID: t.ID, UserID: uid(r), Muted: req.GetMuted()})
	}); err != nil {
		return err
	}
	out, err := s.taskResponse(r, t.ID, false)
	if err != nil {
		return err
	}
	// The caller's other devices.
	s.ev.User(r.Context(), uid(r), &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskUpdate{TaskUpdate: &v1.TaskUpdate{Task: out.GetTask()}}})
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// markRead: PUT /api/tasks/{id}/read — the caller saw the task: its unread mark goes (all
// devices get TASK_UPDATE with unread false).
func (s *Service) markRead(w http.ResponseWriter, r *http.Request) error {
	t, _, err := s.loadTask(r, s.db.Pool, false)
	if err != nil {
		return err
	}
	was, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (bool, error) {
		return guarded.MarkTaskSeen(r.Context(), sqlc.MarkTaskSeenParams{TaskID: t.ID, UserID: uid(r)})
	})
	if err != nil {
		return err
	}
	out, err := s.taskResponse(r, t.ID, false)
	if err != nil {
		return err
	}
	if was {
		s.ev.User(r.Context(), uid(r), &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskUpdate{TaskUpdate: &v1.TaskUpdate{Task: out.GetTask()}}})
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}
