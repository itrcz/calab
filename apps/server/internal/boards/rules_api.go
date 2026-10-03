package boards

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/rooms"
)

// The rules API (ADR-0060 §3): read by the board's viewers (bots too), changed, tested and its
// log read with MANAGE_BOARD (bots: 403 by the route table). New rules need the plan's
// automations (Team and above).

const automationsFeature = "board automations"

// ruleRoutes registers the routes of rules.
func (s *Service) ruleRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/boards/{id}/rules", s.listRules)
	h("POST /api/boards/{id}/rules", s.createRule)
	h("PATCH /api/rules/{id}", s.updateRule)
	h("DELETE /api/rules/{id}", s.deleteRule)
	h("POST /api/rules/{id}/test", s.testRule)
	h("GET /api/rules/{id}/runs", s.listRuns)
}

// ruleInput is a validated rule as stored.
type ruleInput struct {
	name    string
	kind    string
	trigger []byte
	cond    []byte
	actions []byte
}

func actionField(i int, f string) string { return "actions[" + strconv.Itoa(i) + "]." + f }

func validTemplate(field, s string) error {
	if strings.TrimSpace(s) == "" || utf8.RuneCountInString(s) > MaxRuleTemplate {
		return httpx.Validation(field, "a text of 1..2000 characters is required")
	}
	return nil
}

// validateRule checks a rule against its board (ADR-0060 §3) and encodes it.
func (s *Service) validateRule(r *http.Request, q *sqlc.Queries, b sqlc.Board, name string, tr *v1.RuleTrigger,
	cond *v1.TaskFilter, acts []*v1.RuleAction) (ruleInput, error) {
	ctx := r.Context()
	var in ruleInput
	var err error
	if in.name, err = validText("name", name, 1, MaxRuleName); err != nil {
		return in, err
	}
	it, err := items(ctx, q, b.ID)
	if err != nil {
		return in, err
	}
	status := func(field, raw string) error {
		if raw == "" {
			return nil
		}
		id, err := uuid.Parse(raw)
		if _, ok := it.statuses[id]; err != nil || !ok {
			return httpx.Validation(field, "a status of this board is required")
		}
		return nil
	}
	label := func(field, raw string) error {
		id, err := uuid.Parse(raw)
		if _, ok := it.labels[id]; err != nil || !ok {
			return httpx.Validation(field, "a label of this board is required")
		}
		return nil
	}
	// The trigger.
	in.kind = TriggerKind(tr)
	switch k := tr.GetKind().(type) {
	case nil:
		return in, httpx.Validation("trigger", "a trigger is required")
	case *v1.RuleTrigger_StatusChanged_:
		if err := status("trigger.statusChanged.toStatusId", k.StatusChanged.GetToStatusId()); err != nil {
			return in, err
		}
		if err := status("trigger.statusChanged.fromStatusId", k.StatusChanged.GetFromStatusId()); err != nil {
			return in, err
		}
		if t := k.StatusChanged.GetToType(); t != v1.BoardStatusType_BOARD_STATUS_TYPE_UNSPECIFIED && StatusTypeToDB(t) == "" {
			return in, httpx.Validation("trigger.statusChanged.toType", "unknown status type")
		}
	case *v1.RuleTrigger_ApprovalChanged_:
		switch k.ApprovalChanged.GetState() {
		case v1.TaskApprovalState_TASK_APPROVAL_STATE_UNSPECIFIED, v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED,
			v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED:
		default:
			return in, httpx.Validation("trigger.approvalChanged.state", "state must be APPROVED or REJECTED")
		}
	case *v1.RuleTrigger_LabelChanged_:
		if k.LabelChanged.GetLabelId() != "" {
			if err := label("trigger.labelChanged.labelId", k.LabelChanged.GetLabelId()); err != nil {
				return in, err
			}
		}
	case *v1.RuleTrigger_PriorityChanged_:
		if k.PriorityChanged.ToPriority != nil {
			if _, err := validPriority(k.PriorityChanged.GetToPriority()); err != nil {
				return in, err
			}
		}
	case *v1.RuleTrigger_Git_:
		if _, ok := v1.RuleGitEvent_name[int32(k.Git.GetEvent())]; !ok {
			return in, httpx.Validation("trigger.git.event", "unknown Git event")
		}
	case *v1.RuleTrigger_DueIn_, *v1.RuleTrigger_Overdue_:
		if tr.GetDueIn().GetDays() > MaxRuleTriggerDay || tr.GetOverdue().GetDays() > MaxRuleTriggerDay {
			return in, httpx.Validation("trigger", "days must be 0..30")
		}
		if err := requireFeature(b.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "trigger", true); err != nil {
			return in, err
		}
	case *v1.RuleTrigger_Stale_:
		if d := k.Stale.GetDays(); d < 1 || d > MaxRuleStaleDays {
			return in, httpx.Validation("trigger.stale.days", "days must be 1..90")
		}
	}
	if in.trigger, err = encodeTrigger(tr); err != nil {
		return in, err
	}
	// The condition: the same check as a saved view's filter.
	if cond != nil {
		if err := s.checkFilter(r, cond); err != nil {
			return in, err
		}
		if in.cond, err = encodeCondition(cond); err != nil {
			return in, err
		}
	}
	// The actions.
	if len(acts) == 0 || len(acts) > MaxRuleActions {
		return in, httpx.Validation("actions", "1..5 actions are required")
	}
	res := perm.NewResolver(q)
	users := func(field string, raw []string, limit int) error {
		if len(raw) > limit {
			return httpx.Validation(field, "at most "+strconv.Itoa(limit)+" users")
		}
		for _, s := range raw {
			u, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation(field, "invalid user id")
			}
			ok, err := mayInvite(ctx, q, res, b.ID, u)
			if err != nil {
				return err
			}
			if !ok {
				return httpx.Validation(field, "the user does not see this board")
			}
		}
		return nil
	}
	for i, act := range acts {
		switch k := act.GetKind().(type) {
		case nil:
			return in, httpx.Validation(actionField(i, "kind"), "an action is required")
		case *v1.RuleAction_SetStatus_:
			if k.SetStatus.GetStatusId() == "" {
				return in, httpx.Validation(actionField(i, "setStatus.statusId"), "a status of this board is required")
			}
			if err := status(actionField(i, "setStatus.statusId"), k.SetStatus.GetStatusId()); err != nil {
				return in, err
			}
		case *v1.RuleAction_SetAssignees_:
			x := k.SetAssignees
			if x.GetMode() == v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_UNSPECIFIED || x.GetMode() > v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_CLEAR {
				return in, httpx.Validation(actionField(i, "setAssignees.mode"), "mode must be SET, ADD, REMOVE or CLEAR")
			}
			if err := users(actionField(i, "setAssignees.userIds"), x.GetUserIds(), MaxAssignees); err != nil {
				return in, err
			}
			if l := x.GetLeadUserId(); l != "" && !slices.Contains(x.GetUserIds(), l) {
				return in, httpx.Validation(actionField(i, "setAssignees.leadUserId"), "the lead must be one of userIds")
			}
			if x.GetSpecial() > v1.RuleSpecialUser_RULE_SPECIAL_USER_ACTOR {
				return in, httpx.Validation(actionField(i, "setAssignees.special"), "unknown special user")
			}
			if x.GetMode() != v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_CLEAR && len(x.GetUserIds()) == 0 &&
				x.GetSpecial() == v1.RuleSpecialUser_RULE_SPECIAL_USER_UNSPECIFIED {
				return in, httpx.Validation(actionField(i, "setAssignees.userIds"), "users are required")
			}
		case *v1.RuleAction_SetLabels_:
			if len(k.SetLabels.GetAddIds())+len(k.SetLabels.GetRemoveIds()) == 0 || len(k.SetLabels.GetAddIds()) > MaxLabels {
				return in, httpx.Validation(actionField(i, "setLabels"), "labels to add or remove are required")
			}
			for _, id := range append(slices.Clone(k.SetLabels.GetAddIds()), k.SetLabels.GetRemoveIds()...) {
				if err := label(actionField(i, "setLabels"), id); err != nil {
					return in, err
				}
			}
		case *v1.RuleAction_SetPriority_:
			if _, err := validPriority(k.SetPriority.GetPriority()); err != nil {
				return in, err
			}
		case *v1.RuleAction_SetDue_:
			if k.SetDue.GetDaysFromNow() > MaxRuleDueDays {
				return in, httpx.Validation(actionField(i, "setDue.daysFromNow"), "days must be 0..365")
			}
		case *v1.RuleAction_SetApprovers_:
			if _, _, err := approversIn(ctx, q, b.ID, k.SetApprovers.GetUserIds(), k.SetApprovers.GetRequired(),
				actionField(i, "setApprovers.userIds"), actionField(i, "setApprovers.required")); err != nil {
				return in, err
			}
		case *v1.RuleAction_AddChecklist_:
			if _, err := validText(actionField(i, "addChecklist.name"), k.AddChecklist.GetName(), 1, MaxChecklistTitle); err != nil {
				return in, err
			}
			if len(k.AddChecklist.GetItems()) > MaxChecklistItems {
				return in, httpx.Validation(actionField(i, "addChecklist.items"), "at most 100 items")
			}
			for _, t := range k.AddChecklist.GetItems() {
				if _, err := validText(actionField(i, "addChecklist.items"), t, 1, MaxChecklistText); err != nil {
					return in, err
				}
			}
		case *v1.RuleAction_Comment_:
			if err := validTemplate(actionField(i, "comment.template"), k.Comment.GetTemplate()); err != nil {
				return in, err
			}
		case *v1.RuleAction_NotifyRoom_:
			if err := validTemplate(actionField(i, "notifyRoom.template"), k.NotifyRoom.GetTemplate()); err != nil {
				return in, err
			}
			if err := s.postableRoom(r, q, b.WorkspaceID, k.NotifyRoom.GetRoomId(), actionField(i, "notifyRoom.roomId")); err != nil {
				return in, err
			}
		case *v1.RuleAction_NotifyDm_:
			if err := validTemplate(actionField(i, "notifyDm.template"), k.NotifyDm.GetTemplate()); err != nil {
				return in, err
			}
			if to := k.NotifyDm.GetTo(); to == v1.RuleRecipients_RULE_RECIPIENTS_UNSPECIFIED || to > v1.RuleRecipients_RULE_RECIPIENTS_APPROVERS {
				return in, httpx.Validation(actionField(i, "notifyDm.to"), "to must be ASSIGNEES, LEAD, CREATOR or APPROVERS")
			}
		case *v1.RuleAction_CreateSubtasks_:
			ts := k.CreateSubtasks.GetTitles()
			if len(ts) == 0 || len(ts) > MaxRuleSubtasks {
				return in, httpx.Validation(actionField(i, "createSubtasks.titles"), "1..10 titles are required")
			}
			for _, t := range ts {
				if _, err := validText(actionField(i, "createSubtasks.titles"), t, 1, MaxTitle); err != nil {
					return in, err
				}
			}
		}
	}
	in.actions, err = encodeActions(acts)
	return in, err
}

// postableRoom: notify_room posts into a text room of the board's workspace where the author of
// the rule may write (they choose to show the board's tasks there).
func (s *Service) postableRoom(r *http.Request, q *sqlc.Queries, ws uuid.UUID, raw, field string) error {
	room, ok, err := textRoom(r.Context(), q, ws, raw)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.Validation(field, "a text room of the workspace is required")
	}
	acc, err := rooms.Access(r, room.ID)
	if err != nil {
		return httpx.Validation(field, "a text room of the workspace is required")
	}
	if !acc.Bits.Has(perm.ViewRoom | perm.SendMessages) {
		return httpx.Validation(field, "you cannot post in this room")
	}
	return nil
}

// ruleAccess resolves the rule of the path: 404 when its board is hidden from the caller (or
// they see it only through tasks); manage: MANAGE_BOARD and a writable workspace.
func (s *Service) ruleAccess(r *http.Request, manage bool) (sqlc.BoardRule, perm.BoardAccess, error) {
	id, err := httpx.PathUUID(r, "id", "rule")
	if err != nil {
		return sqlc.BoardRule{}, perm.BoardAccess{}, err
	}
	row, err := s.db.Q.GetBoardRule(r.Context(), id)
	if db.IsNotFound(err) {
		return row, perm.BoardAccess{}, httpx.NotFound("rule")
	}
	if err != nil {
		return row, perm.BoardAccess{}, err
	}
	acc, err := board(r, row.BoardID, false)
	if err != nil || !acc.Bits.Has(perm.ViewBoard) {
		return row, acc, httpx.NotFound("rule")
	}
	if manage {
		if !acc.Bits.Has(perm.ManageBoard) {
			return row, acc, httpx.Forbidden("MANAGE_BOARD required")
		}
		return row, acc, writable(acc)
	}
	return row, acc, nil
}

func (s *Service) publishRule(ctx context.Context, ws uuid.UUID, row sqlc.BoardRule) {
	s.ev.Workspace(ctx, ws, ruleEvent92(ws, row))
}

// listRules: GET /api/boards/{id}/rules — the board's viewers (not task-scoped members).
func (s *Service) listRules(w http.ResponseWriter, r *http.Request) error {
	id, _, err := fullBoard(r, false)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListBoardRules(r.Context(), id)
	if err != nil {
		return err
	}
	out := &v1.ListBoardRulesResponse{Rules: make([]*v1.BoardRule, len(rows))}
	for i, row := range rows {
		out.Rules[i] = ruleProto(row)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// createRule: POST /api/boards/{id}/rules.
func (s *Service) createRule(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	if ok, err := s.automationsAllowed(r.Context(), acc.WorkspaceID); err != nil {
		return err
	} else if !ok {
		return plans.FeatureError(automationsFeature)
	}
	var req v1.CreateBoardRuleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	b, err := s.db.Q.GetBoard(r.Context(), id)
	if err != nil {
		return err
	}
	in, err := s.validateRule(r, s.db.Q, b, req.GetName(), req.GetTrigger(), req.GetCondition(), req.GetActions())
	if err != nil {
		return err
	}
	me := uid(r)
	var row sqlc.BoardRule
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		n, err := q.CountBoardRules(r.Context(), id)
		if err != nil {
			return err
		}
		if n >= MaxRules {
			return httpx.Conflict("at most 20 rules per board").WithDetails(ReasonRuleLimit, uint64(max(n, 0)), MaxRules)
		}
		row, err = q.CreateBoardRule(r.Context(), sqlc.CreateBoardRuleParams{BoardID: id, Name: in.name, Enabled: req.Enabled == nil || req.GetEnabled(),
			TriggerKind: in.kind, Trigger: in.trigger, Condition: in.cond, Actions: in.actions, CreatedBy: &me})
		return err
	}); err != nil {
		return err
	}
	s.publishRule(r.Context(), acc.WorkspaceID, row)
	s.publishBoard(r.Context(), acc.WorkspaceID, id, false) // rules_count
	httpx.Write(w, http.StatusCreated, &v1.BoardRuleResponse{Rule: ruleProto(row)})
	return nil
}

// updateRule: PATCH /api/rules/{id}.
func (s *Service) updateRule(w http.ResponseWriter, r *http.Request) error {
	cur, acc, err := s.ruleAccess(r, true)
	if err != nil {
		return err
	}
	var req v1.UpdateBoardRuleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	old, err := decodeRule(cur)
	if err != nil {
		return err
	}
	name, enabled, tr, cond, acts := cur.Name, cur.Enabled, old.trigger, old.cond, old.actions
	if req.Name != nil {
		name = req.GetName()
	}
	if req.Enabled != nil {
		enabled = req.GetEnabled()
	}
	if req.Trigger != nil {
		tr = req.GetTrigger()
	}
	if req.Condition != nil {
		cond = req.GetCondition()
	}
	if req.GetClearCondition() {
		cond = nil
	}
	if req.GetSetActions() {
		acts = req.GetActions()
	}
	b, err := s.db.Q.GetBoard(r.Context(), cur.BoardID)
	if err != nil {
		return err
	}
	in, err := s.validateRule(r, s.db.Q, b, name, tr, cond, acts)
	if err != nil {
		return err
	}
	var row sqlc.BoardRule
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		if _, err := q.GetBoardRuleForUpdate(r.Context(), cur.ID); err != nil {
			return notFoundOr(err, "rule")
		}
		if row, err = q.UpdateBoardRule(r.Context(), sqlc.UpdateBoardRuleParams{ID: cur.ID, Name: in.name, Enabled: enabled,
			TriggerKind: in.kind, Trigger: in.trigger, Condition: in.cond, Actions: in.actions}); err != nil {
			return err
		}
		if req.Position == nil {
			return nil
		}
		all, err := q.ListBoardRules(r.Context(), cur.BoardID)
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(all))
		for i, x := range all {
			ids[i] = x.ID
		}
		ids = reorder(ids, cur.ID, int(req.GetPosition()))
		for i, x := range ids {
			if err := q.SetBoardRulePosition(r.Context(), sqlc.SetBoardRulePositionParams{ID: x, Position: int32(i)}); err != nil { //nolint:gosec // ≤ 20
				return err
			}
			if x == cur.ID {
				row.Position = int32(i) //nolint:gosec // ≤ 20
			}
		}
		return nil
	}); err != nil {
		return err
	}
	s.publishRule(r.Context(), acc.WorkspaceID, row)
	httpx.Write(w, http.StatusOK, &v1.BoardRuleResponse{Rule: ruleProto(row)})
	return nil
}

// deleteRule: DELETE /api/rules/{id} (its runs go with it).
func (s *Service) deleteRule(w http.ResponseWriter, r *http.Request) error {
	cur, acc, err := s.ruleAccess(r, true)
	if err != nil {
		return err
	}
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		n, err := q.DeleteBoardRule(r.Context(), cur.ID)
		if err == nil && n == 0 {
			err = httpx.NotFound("rule")
		}
		return err
	}); err != nil {
		return err
	}
	s.ev.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardRuleDelete{BoardRuleDelete: &v1.BoardRuleDelete{
		WorkspaceId: acc.WorkspaceID.String(), BoardId: cur.BoardID.String(), RuleId: cur.ID.String()}}})
	s.publishBoard(r.Context(), acc.WorkspaceID, cur.BoardID, false)
	httpx.NoContent(w)
	return nil
}

// testRule: POST /api/rules/{id}/test {task_id} — a dry run on a task of the board.
func (s *Service) testRule(w http.ResponseWriter, r *http.Request) error {
	cur, _, err := s.ruleAccess(r, true)
	if err != nil {
		return err
	}
	var req v1.TestBoardRuleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	taskID, err := uuid.Parse(req.GetTaskId())
	if err != nil {
		return httpx.Validation("taskId", "invalid task id")
	}
	rl, err := decodeRule(cur)
	if err != nil {
		return err
	}
	b, err := s.db.Q.GetBoard(r.Context(), cur.BoardID)
	if err != nil {
		return err
	}
	env := s.env(r)
	out := &v1.RuleTestResponse{}
	// A read-only transaction: the condition is dynamic SQL on the raw transaction.
	err = s.tx(r.Context(), func(q *sqlc.Queries, tx pgx.Tx) error {
		t, ok, err := taskByID(r.Context(), tx, taskID, false)
		if err != nil {
			return err
		}
		if !ok || t.BoardID != cur.BoardID || t.ArchivedAt != nil {
			return httpx.Validation("taskId", "a live task of the rule's board is required")
		}
		out.Matches = true
		if rl.cond != nil {
			var a Args
			id := a.Add(t.ID)
			cond, err := Translate(rl.cond, env, &a)
			if err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), "SELECT EXISTS (SELECT 1 FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = "+id+
				" AND ("+cond+"))", a.Values()...).Scan(&out.Matches); err != nil {
				return err
			}
		}
		out.Actions, err = s.dryRun(r.Context(), q, b, rl, t)
		return err
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// listRuns: GET /api/rules/{id}/runs?limit= — newest first.
func (s *Service) listRuns(w http.ResponseWriter, r *http.Request) error {
	cur, acc, err := s.ruleAccess(r, false) // reading: a suspended workspace too
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.ManageBoard) {
		return httpx.Forbidden("MANAGE_BOARD required")
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 100 {
			return httpx.BadRequest("limit must be 1..100")
		}
		limit = n
	}
	rows, err := s.db.Q.ListRuleRuns(r.Context(), sqlc.ListRuleRunsParams{RuleID: cur.ID, Lim: int32(limit)}) //nolint:gosec // ≤ 100
	if err != nil {
		return err
	}
	out := &v1.ListRuleRunsResponse{Runs: make([]*v1.RuleRun, len(rows))}
	for i, x := range rows {
		out.Runs[i] = runProto(x)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}
