package boards

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
)

// Task approvals (ADR-0049): approvers with a quorum; a task not approved cannot move forward.

// Approval limits and the 409 reason.
const (
	MaxApprovers       = 10
	MaxApprovalComment = 500
	// ReasonTaskApprovalRequired: 409 CONFLICT of a forward move of a task that is not
	// approved; ApiError.used = approvals, limit = the quorum.
	ReasonTaskApprovalRequired = "TASK_APPROVAL_REQUIRED"
	// MaxApprovalReminders: daily reminders of a pending vote (ADR-0049 §5).
	MaxApprovalReminders = 3
)

// Stored approver states (task_approvers.state).
const (
	votePending  = "pending"
	voteApproved = "approved"
	voteRejected = "rejected"
)

var approverStates = map[string]v1.ApproverState{
	votePending:  v1.ApproverState_APPROVER_STATE_PENDING,
	voteApproved: v1.ApproverState_APPROVER_STATE_APPROVED,
	voteRejected: v1.ApproverState_APPROVER_STATE_REJECTED,
}

// Quorum is the number of approvals needed of n approvers: approval_required, 0 (or more than
// n) = all.
func Quorum(required, n int) int {
	if required <= 0 || required > n {
		return n
	}
	return required
}

// Tally sums up the votes of one task.
type Tally struct {
	Approvers, Approved, Rejected, Quorum int
}

// TallyOf counts stored vote states with the task's approval_required.
func TallyOf(states []string, required int) Tally {
	t := Tally{Approvers: len(states), Quorum: Quorum(required, len(states))}
	for _, s := range states {
		switch s {
		case voteApproved:
			t.Approved++
		case voteRejected:
			t.Rejected++
		}
	}
	return t
}

// State derives the task's approval state: NONE without approvers, REJECTED on any rejection
// (a veto), APPROVED with approvals ≥ the quorum, PENDING otherwise.
func (t Tally) State() v1.TaskApprovalState {
	switch {
	case t.Approvers == 0:
		return v1.TaskApprovalState_TASK_APPROVAL_STATE_NONE
	case t.Rejected > 0:
		return v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED
	case t.Approved >= t.Quorum:
		return v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED
	}
	return v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING
}

// Blocks reports whether the state holds a task back.
func (t Tally) Blocks() bool {
	s := t.State()
	return s == v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING || s == v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED
}

// reset is the tally after every vote went back to pending.
func (t Tally) reset() Tally {
	t.Approved, t.Rejected = 0, 0
	return t
}

// Forward reports whether a move from → to goes "forward" (ADR-0049 §2): into a status with a
// greater position or into any COMPLETED status. The same status (order within the column) and
// CANCELLED are never forward. Between boards (a move to another board) positions do not
// compare: only entering COMPLETED from another type is forward.
func Forward(from, to sqlc.BoardStatus) bool {
	if from.ID == to.ID || to.Type == "cancelled" {
		return false
	}
	if from.BoardID != to.BoardID {
		return to.Type == "completed" && from.Type != "completed"
	}
	return to.Type == "completed" || to.Position > from.Position
}

// checkApprovalGate is the one approval check of every status change (PATCH incl. kanban
// moves and list bulk actions, bots, moving to another board, deleting a status with
// move_to): 409 TASK_APPROVAL_REQUIRED when a task that is pending or rejected goes forward.
func checkApprovalGate(t Tally, from, to sqlc.BoardStatus) error {
	if !t.Blocks() || !Forward(from, to) {
		return nil
	}
	return approvalRequired(t)
}

// checkCreateGate: a new task with approvers cannot start in a COMPLETED status — its votes are
// all pending, the same 409 as the gate (lead decision on ADR-0049 §2).
func checkCreateGate(approvers int, required int16, st sqlc.BoardStatus) error {
	if approvers == 0 || st.Type != "completed" {
		return nil
	}
	return approvalRequired(TallyOf(make([]string, approvers), int(required)))
}

func approvalRequired(t Tally) error {
	msg := "the task needs approval: " + strconv.Itoa(t.Approved) + " of " + strconv.Itoa(t.Quorum)
	if t.Rejected > 0 {
		msg = "the task was rejected by an approver"
	}
	return httpx.Conflict(msg).WithDetails(ReasonTaskApprovalRequired, uint64(max(t.Approved, 0)), uint64(max(t.Quorum, 0))) //nolint:gosec // ≥ 0
}

// tallies loads the votes of tasks (one query) by task id.
func tallies(ctx context.Context, q *sqlc.Queries, ts []taskRow) (map[uuid.UUID]Tally, error) {
	out := make(map[uuid.UUID]Tally, len(ts))
	if len(ts) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, len(ts))
	for i, t := range ts {
		ids[i] = t.ID
	}
	aps, err := q.ListTaskApprovers(ctx, ids)
	if err != nil {
		return nil, err
	}
	states := map[uuid.UUID][]string{}
	for _, a := range aps {
		states[a.TaskID] = append(states[a.TaskID], a.State)
	}
	for _, t := range ts {
		out[t.ID] = TallyOf(states[t.ID], int(t.ApprovalRequired))
	}
	return out, nil
}

func taskTally(ctx context.Context, q *sqlc.Queries, t taskRow) (Tally, error) {
	m, err := tallies(ctx, q, []taskRow{t})
	return m[t.ID], err
}

func approverProto(a sqlc.TaskApprover) *v1.TaskApprover {
	return &v1.TaskApprover{UserId: a.UserID.String(), State: approverStates[a.State], Comment: a.Comment,
		DecidedAt: tsp(a.DecidedAt), AddedBy: idp(a.AddedBy), AddedAt: timestamppb.New(a.AddedAt)}
}

// approversIn validates a requested approver list (ADR-0049 §1, ADR-0059, ADR-0076): ≤ 10
// distinct members, not guests nor bots, who see the board or will see it through the task
// (restricted boards too); required 0 = all, else ≤ their number.
func approversIn(ctx context.Context, q *sqlc.Queries, boardID uuid.UUID, raw []string, required uint32, field, reqField string) ([]uuid.UUID, int16, error) {
	if len(raw) > MaxApprovers {
		return nil, 0, httpx.Validation(field, "at most 10 approvers")
	}
	if int(required) > len(raw) {
		return nil, 0, httpx.Validation(reqField, "required approvals exceed the number of approvers")
	}
	res := perm.NewResolver(q)
	out := make([]uuid.UUID, 0, len(raw))
	for i, s := range raw {
		f := field + "[" + strconv.Itoa(i) + "]"
		u, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil {
			return nil, 0, httpx.Validation(f, "invalid user id")
		}
		if slices.Contains(out, u) {
			return nil, 0, httpx.Validation(f, "duplicate approver")
		}
		usr, err := q.GetUser(ctx, u)
		if db.IsNotFound(err) {
			return nil, 0, httpx.Validation(f, "the user does not see this board")
		}
		if err != nil {
			return nil, 0, err
		}
		if usr.IsBot || usr.IsGuest {
			return nil, 0, httpx.Validation(f, "bots and guests cannot approve")
		}
		ok, err := mayInvite(ctx, q, res, boardID, u)
		if err != nil {
			return nil, 0, err
		}
		if !ok {
			return nil, 0, httpx.Validation(f, "the user does not see this board")
		}
		out = append(out, u)
	}
	return out, int16(required), nil //nolint:gosec // ≤ 10
}

// writeApprovers makes the task's approvers ids with the quorum required: those who stay keep
// their votes, removed ones lose them, new ones start pending. Returns the new approvers,
// the previous list and whether anything changed.
func writeApprovers(ctx context.Context, q *sqlc.Queries, t taskRow, ids []uuid.UUID, required int16, me *uuid.UUID) ([]uuid.UUID, []sqlc.TaskApprover, bool, error) {
	cur, err := q.ListTaskApprovers(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return nil, nil, false, err
	}
	var removed, added []uuid.UUID
	for _, a := range cur {
		if !slices.Contains(ids, a.UserID) {
			removed = append(removed, a.UserID)
		}
	}
	for _, id := range ids {
		if !slices.ContainsFunc(cur, func(a sqlc.TaskApprover) bool { return a.UserID == id }) {
			added = append(added, id)
		}
	}
	if len(removed) > 0 {
		if err := q.DeleteTaskApprovers(ctx, sqlc.DeleteTaskApproversParams{TaskID: t.ID, UserIds: removed}); err != nil {
			return nil, nil, false, err
		}
	}
	for _, u := range added {
		if err := q.InsertTaskApprover(ctx, sqlc.InsertTaskApproverParams{TaskID: t.ID, UserID: u, AddedBy: me}); err != nil {
			return nil, nil, false, err
		}
	}
	changed := len(removed) > 0 || len(added) > 0 || required != t.ApprovalRequired
	if changed {
		if err := q.SetTaskApprovalRequired(ctx, sqlc.SetTaskApprovalRequiredParams{ID: t.ID, ApprovalRequired: required}); err != nil {
			return nil, nil, false, err
		}
	}
	return added, cur, changed, nil
}

func approverIDs(as []sqlc.TaskApprover) []uuid.UUID {
	out := make([]uuid.UUID, len(as))
	for i, a := range as {
		out[i] = a.UserID
	}
	return out
}

func voteStates(as []sqlc.TaskApprover) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.State
	}
	return out
}

// notifyApprovers subscribes approvers who see the board and sends them APPROVAL_REQUESTED
// (mandatory, ADR-0049 §5).
func (s *Service) notifyApprovers(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, users []uuid.UUID, c *change) error {
	if len(users) == 0 {
		return nil
	}
	users, err := sees(ctx, q, t, users)
	if err != nil || len(users) == 0 {
		return err
	}
	if err := q.Subscribe(ctx, sqlc.SubscribeParams{TaskID: t.ID, UserIds: users}); err != nil {
		return err
	}
	return decide(ctx, q, t, actor, notifications.TaskApprovalRequested, users, uuid.Nil, nil, c)
}

// notifyOutcome sends APPROVED / REJECTED: mandatory to the task's creator and lead assignee,
// by their task level to the other assignees and the subscribers (ADR-0049 §5).
func (s *Service) notifyOutcome(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, kind notifications.TaskKind, c *change) error {
	mandatory := map[uuid.UUID]bool{}
	var users []uuid.UUID
	add := func(u uuid.UUID) {
		if !slices.Contains(users, u) {
			users = append(users, u)
		}
	}
	if t.CreatedBy != nil {
		mandatory[*t.CreatedBy] = true
		add(*t.CreatedBy)
	}
	as, err := q.ListTaskAssignees(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return err
	}
	for _, a := range as {
		if a.IsLead {
			mandatory[a.UserID] = true
		}
		add(a.UserID)
	}
	subs, err := q.ListTaskSubscribers(ctx, t.ID)
	if err != nil {
		return err
	}
	for _, sb := range subs {
		add(sb.UserID)
	}
	if users, err = sees(ctx, q, t, users); err != nil {
		return err
	}
	// The creator and the lead get a subscription row (kept muted if they unsubscribed) so the
	// notice marks the task unread for them.
	var must []uuid.UUID
	for _, u := range users {
		if mandatory[u] {
			must = append(must, u)
		}
	}
	if len(must) > 0 {
		if err := q.Subscribe(ctx, sqlc.SubscribeParams{TaskID: t.ID, UserIds: must}); err != nil {
			return err
		}
	}
	return decide(ctx, q, t, actor, kind, users, uuid.Nil, mandatory, c)
}

// resetApprovals: the title, description or its attachments changed (ADR-0049 §3) — every
// vote goes back to pending, journal "approvals_reset", every approver is asked again.
func (s *Service) resetApprovals(ctx context.Context, q *sqlc.Queries, t taskRow, me uuid.UUID, c *change) error {
	aps, err := q.ListTaskApprovers(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return err
	}
	tl := TallyOf(voteStates(aps), int(t.ApprovalRequired))
	if tl.Approved == 0 && tl.Rejected == 0 {
		return nil // nothing was decided: nothing to reset
	}
	if err := q.ResetTaskApprovals(ctx, t.ID); err != nil {
		return err
	}
	if err := c.record(ctx, q, t, me, "approvals_reset", map[string]any{"approved": tl.Approved, "rejected": tl.Rejected}, nil); err != nil {
		return err
	}
	return s.notifyApprovers(ctx, q, t, me, approverIDs(aps), c)
}

// ---- handlers ----

// setApprovers: PUT /api/tasks/{id}/approvers — the full list and the quorum, by whoever may
// edit the task (ADR-0049 §4).
func (s *Service) setApprovers(w http.ResponseWriter, r *http.Request) error {
	var req v1.SetTaskApproversRequest
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
		ids, required, err := approversIn(r.Context(), q, t.BoardID, req.GetUserIds(), req.GetRequired(), "userIds", "required")
		if err != nil {
			return err
		}
		added, old, changed, err := writeApprovers(r.Context(), q, t, ids, required, &me)
		if err != nil || !changed {
			return err
		}
		// APPROVALS off (ADR-0058 §3): new approvers or a new quorum are refused (the
		// transaction rolls back); removing approvers and clearing the list stay allowed.
		sets := len(added) > 0 || (len(ids) > 0 && required != t.ApprovalRequired)
		if err := requireFeature(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_APPROVALS, "userIds", sets); err != nil {
			return err
		}
		return s.approversChanged(r.Context(), q, t, me, old, ids, added, required, &c)
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

// approversChanged journals a change of the approver list (old → ids, quorum required), asks
// the added approvers and announces an approval it completes (removing a pending approver or
// lowering the quorum); such an entry carries approval_state "approved" (ADR-0060 trigger).
// The PUT route and the rule action set_approvers share it.
func (s *Service) approversChanged(ctx context.Context, q *sqlc.Queries, t taskRow, me uuid.UUID, old []sqlc.TaskApprover,
	ids, added []uuid.UUID, required int16, c *change) error {
	before := TallyOf(voteStates(old), int(t.ApprovalRequired))
	prevRequired := t.ApprovalRequired
	t.ApprovalRequired = required
	after, err := taskTally(ctx, q, t)
	if err != nil {
		return err
	}
	approved := after.State() == v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED && before.State() != after.State()
	entry := map[string]any{"user_ids": idsJSON(ids), "required": int(required)}
	if approved {
		entry["approval_state"] = voteApproved
	}
	if err := c.record(ctx, q, t, me, "approvers",
		map[string]any{"user_ids": idsJSON(approverIDs(old)), "required": int(prevRequired)}, entry); err != nil {
		return err
	}
	if err := s.notifyApprovers(ctx, q, t, me, added, c); err != nil {
		return err
	}
	if approved {
		return s.notifyOutcome(ctx, q, t, me, notifications.TaskApproved, c)
	}
	return nil
}

var decisionStates = map[v1.TaskApprovalDecision]string{
	v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_APPROVE:  voteApproved,
	v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_REJECT:   voteRejected,
	v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_WITHDRAW: votePending,
}

// vote: POST /api/tasks/{id}/approval — the caller's own vote (ADR-0049 §3).
func (s *Service) vote(w http.ResponseWriter, r *http.Request) error {
	var req v1.TaskApprovalRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	state, ok := decisionStates[req.GetDecision()]
	if !ok {
		return httpx.Validation("decision", "decision must be APPROVE, REJECT or WITHDRAW")
	}
	comment := strings.TrimSpace(req.GetComment())
	if utf8.RuneCountInString(comment) > MaxApprovalComment {
		return httpx.Validation("comment", "comment must be at most 500 characters")
	}
	if state == voteRejected && comment == "" {
		return httpx.Validation("comment", "a rejection needs a comment")
	}
	if state == votePending {
		comment = ""
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
		if err := writable(acc); err != nil {
			return err
		}
		if t.ArchivedAt != nil {
			return httpx.Conflict("the task is archived; restore it first")
		}
		aps, err := q.ListTaskApprovers(r.Context(), []uuid.UUID{t.ID})
		if err != nil {
			return err
		}
		i := slices.IndexFunc(aps, func(a sqlc.TaskApprover) bool { return a.UserID == me })
		if i < 0 {
			return httpx.Forbidden("only an approver of the task may vote")
		}
		mine := aps[i]
		if mine.State == state && mine.Comment == comment {
			return nil
		}
		// APPROVALS off (ADR-0058 §3): no new decisions; withdrawing one stays allowed.
		if err := requireFeature(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_APPROVALS, "decision", state != votePending); err != nil {
			return err
		}
		before := TallyOf(voteStates(aps), int(t.ApprovalRequired))
		if err := q.SetApproverVote(r.Context(), sqlc.SetApproverVoteParams{State: state, Comment: comment, TaskID: t.ID, UserID: me}); err != nil {
			return err
		}
		aps[i].State = state
		after := TallyOf(voteStates(aps), int(t.ApprovalRequired))
		if err := q.TouchTask(r.Context(), t.ID); err != nil {
			return err
		}
		// The decision of the task, if this vote makes one (the rule trigger approval_changed).
		outcome := ""
		switch {
		case state == voteRejected && mine.State != voteRejected:
			outcome = voteRejected
		case after.State() == v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED && before.State() != after.State():
			outcome = voteApproved
		}
		entry := map[string]any{"user_id": me.String(), "state": state, "comment": comment}
		if outcome != "" {
			entry["approval_state"] = outcome
		}
		if err := c.record(r.Context(), q, t, me, "approval",
			map[string]any{"user_id": me.String(), "state": mine.State, "comment": mine.Comment}, entry); err != nil {
			return err
		}
		if err := q.Subscribe(r.Context(), sqlc.SubscribeParams{TaskID: t.ID, UserIds: []uuid.UUID{me}}); err != nil {
			return err
		}
		switch outcome {
		case voteRejected:
			return s.notifyOutcome(r.Context(), q, t, me, notifications.TaskRejected, &c)
		case voteApproved:
			return s.notifyOutcome(r.Context(), q, t, me, notifications.TaskApproved, &c)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), taskID, &c, false)
	return s.respondTask(w, r, taskID, http.StatusOK, false)
}

// ---- reminders ----

// remindBatch bounds one reminder pass (the next pass continues).
const remindBatch = 500

// Remind sends the daily APPROVAL_REQUESTED reminder of votes pending for 24 h (≤ 3 per vote,
// ADR-0049 §5; the boards sweeper) and returns how many votes it reminded of.
func (s *Service) Remind(ctx context.Context) (int, error) {
	total := 0
	for range 20 {
		due, err := s.db.Q.DueApprovalReminders(ctx, remindBatch)
		if err != nil || len(due) == 0 {
			return total, err
		}
		var order []uuid.UUID
		byTask := map[uuid.UUID][]uuid.UUID{}
		for _, d := range due {
			if _, ok := byTask[d.TaskID]; !ok {
				order = append(order, d.TaskID)
			}
			byTask[d.TaskID] = append(byTask[d.TaskID], d.UserID)
		}
		for _, id := range order {
			var c change
			claimed := 0
			err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
				t, ok, err := taskByID(ctx, tx, id, true)
				if err != nil || !ok {
					return err
				}
				users, err := q.ClaimApprovalReminders(ctx, sqlc.ClaimApprovalRemindersParams{TaskID: id, UserIds: byTask[id]})
				if err != nil || len(users) == 0 {
					return err
				}
				claimed = len(users)
				if users, err = sees(ctx, q, t, users); err != nil || len(users) == 0 {
					return err
				}
				return decide(ctx, q, t, uuid.Nil, notifications.TaskApprovalRequested, users, uuid.Nil, nil, &c)
			})
			if err != nil {
				return total, err
			}
			s.sendNotices(ctx, id, c.notices)
			total += claimed
		}
		if len(due) < remindBatch {
			break
		}
	}
	return total, nil
}

func (s *Service) remindLogged(ctx context.Context) {
	if n, err := s.Remind(ctx); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "boards: approval reminders", "err", err)
	} else if n > 0 {
		slog.InfoContext(ctx, "boards: approval reminders sent", "count", n)
	}
}
