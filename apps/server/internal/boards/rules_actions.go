package boards

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
)

// Rule actions (ADR-0060 §2): the same internal functions as the REST routes, acting on behalf
// of the board — no user rights are checked, the invariants are (the approval gate, the board's
// features and the plan, limits). The actor is the rule: journal entries without an actor and
// with rule_id (change.rule), notices without an actor.

// actx is one run of a rule's actions on a task, inside the rule's savepoint.
type actx struct {
	e  *engine
	q  *sqlc.Queries
	tx pgx.Tx
	r  *rule
	br *boardRules
	t  taskRow // reloaded after every action
	ev ruleEvent
	c  *change      // the rule's journal entries and notices
	fx *autoEffects // what to publish once the run is kept
}

func (a *actx) ctx() context.Context { return a.e.ctx }

func (a *actx) disabled() int64 { return a.br.b.DisabledFeatures }

func (a *actx) do(act *v1.RuleAction) error {
	switch k := act.GetKind().(type) {
	case *v1.RuleAction_SetStatus_:
		return a.setStatus(k.SetStatus)
	case *v1.RuleAction_SetAssignees_:
		return a.setAssignees(k.SetAssignees)
	case *v1.RuleAction_SetLabels_:
		return a.setLabels(k.SetLabels)
	case *v1.RuleAction_SetPriority_:
		return a.setPriority(k.SetPriority)
	case *v1.RuleAction_SetDue_:
		return a.setDue(k.SetDue)
	case *v1.RuleAction_SetApprovers_:
		return a.setApprovers(k.SetApprovers)
	case *v1.RuleAction_AddChecklist_:
		return a.addChecklist(k.AddChecklist)
	case *v1.RuleAction_Comment_:
		return a.comment(k.Comment)
	case *v1.RuleAction_NotifyRoom_:
		return a.notifyRoom(k.NotifyRoom)
	case *v1.RuleAction_NotifyDm_:
		return a.notifyDM(k.NotifyDm)
	case *v1.RuleAction_CreateSubtasks_:
		return a.createSubtasks(k.CreateSubtasks)
	case *v1.RuleAction_Archive_:
		return a.archive()
	}
	return skip("unknown action")
}

// moveStatus moves task t into status to like PATCH /tasks/{id} {status_id}: the approval gate
// (unless APPROVALS is off), the end of the target column, started / completed stamps, the
// journal entry and the STATUS notices of the subscribers. actor uuid.Nil = a rule.
func (s *Service) moveStatus(ctx context.Context, q *sqlc.Queries, t taskRow, it boardItems, to sqlc.BoardStatus, disabled int64,
	actor uuid.UUID, c *change) error {
	if to.ID == t.StatusID {
		return nil
	}
	from := it.statuses[t.StatusID]
	if !Disabled(disabled, v1.BoardFeature_BOARD_FEATURE_APPROVALS) {
		tl, err := taskTally(ctx, q, t)
		if err != nil {
			return err
		}
		if err := checkApprovalGate(tl, from, to); err != nil {
			return err
		}
	}
	old := t
	pos, err := place(ctx, q, to.ID, t.ID, nil, nil)
	if err != nil {
		return err
	}
	t.StatusID, t.Position = to.ID, pos
	finishFields(&t, to.Type, actor, s.Now())
	if t.CompletedBy != nil && *t.CompletedBy == uuid.Nil {
		t.CompletedBy = nil // completed by a rule
	}
	if err := updateRow(ctx, q, t); err != nil {
		return err
	}
	if err := s.recordFields(ctx, q, old, t, from, to, actor, c); err != nil {
		return err
	}
	if t.ParentID != nil {
		c.tasks = append(c.tasks, *t.ParentID) // subtask_done of the parent
	}
	return s.notifySubscribers(ctx, q, t, actor, notifications.TaskStatus, uuid.Nil, c)
}

func (a *actx) setStatus(x *v1.RuleAction_SetStatus) error {
	id, err := uuid.Parse(x.GetStatusId())
	if err != nil {
		return skip("the status no longer exists")
	}
	it, err := items(a.ctx(), a.q, a.t.BoardID)
	if err != nil {
		return err
	}
	to, ok := it.statuses[id]
	if !ok {
		return skip("the status no longer exists")
	}
	return a.e.s.moveStatus(a.ctx(), a.q, a.t, it, to, a.disabled(), uuid.Nil, a.c)
}

// special resolves a RuleSpecialUser (nil: none).
func (a *actx) special(s v1.RuleSpecialUser) *uuid.UUID {
	switch s {
	case v1.RuleSpecialUser_RULE_SPECIAL_USER_CREATOR:
		return a.t.CreatedBy
	case v1.RuleSpecialUser_RULE_SPECIAL_USER_ACTOR:
		return a.ev.actor
	}
	return nil
}

func (a *actx) setAssignees(x *v1.RuleAction_SetAssignees) error {
	ctx := a.ctx()
	cur, err := a.q.ListTaskAssignees(ctx, []uuid.UUID{a.t.ID})
	if err != nil {
		return err
	}
	var want []uuid.UUID
	for _, s := range x.GetUserIds() {
		if u, err := uuid.Parse(s); err == nil && !slices.Contains(want, u) {
			want = append(want, u)
		}
	}
	if u := a.special(x.GetSpecial()); u != nil && !slices.Contains(want, *u) {
		want = append(want, *u)
	}
	var list []uuid.UUID
	notes := map[uuid.UUID]string{}
	curLead := uuid.Nil
	for _, c := range cur {
		notes[c.UserID] = c.Note
		if c.IsLead {
			curLead = c.UserID
		}
	}
	switch x.GetMode() {
	case v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_CLEAR:
	case v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_SET:
		list = want
	case v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_REMOVE:
		for _, c := range cur {
			if !slices.Contains(want, c.UserID) {
				list = append(list, c.UserID)
			}
		}
	default: // ADD
		for _, c := range cur {
			list = append(list, c.UserID)
		}
		for _, u := range want {
			if !slices.Contains(list, u) {
				list = append(list, u)
			}
		}
	}
	// New people must be invitable (ADR-0059); those already assigned stay.
	res := perm.NewResolver(a.q)
	var missing int
	kept := list[:0]
	for _, u := range list {
		if _, ok := notes[u]; !ok {
			ok, err := mayInvite(ctx, a.q, res, a.t.BoardID, u)
			if err != nil {
				return err
			}
			if !ok {
				missing++
				continue
			}
		}
		kept = append(kept, u)
	}
	list = kept
	if len(list) > MaxAssignees {
		list = list[:MaxAssignees]
	}
	if len(want) > 0 && missing == len(want) && x.GetMode() != v1.RuleAssigneesMode_RULE_ASSIGNEES_MODE_REMOVE {
		return skip("the users no longer see the board")
	}
	lead := uuid.Nil
	if l, err := uuid.Parse(x.GetLeadUserId()); err == nil && slices.Contains(list, l) {
		lead = l
	} else if slices.Contains(list, curLead) {
		lead = curLead
	} else if len(list) > 0 {
		lead = list[0]
	}
	same := len(list) == len(cur) && lead == curLead
	for _, u := range list {
		if _, ok := notes[u]; !ok {
			same = false
		}
	}
	if same {
		return nil
	}
	in := make([]*v1.TaskAssigneeInput, len(list))
	for i, u := range list {
		in[i] = &v1.TaskAssigneeInput{UserId: u.String(), IsLead: u == lead, Note: notes[u]}
	}
	fresh, old, err := writeAssignees(ctx, a.q, a.t.ID, in, nil, a.e.s.Now())
	if err != nil {
		return err
	}
	if err := a.q.TouchTask(ctx, a.t.ID); err != nil {
		return err
	}
	if err := a.c.record(ctx, a.q, a.t, uuid.Nil, "assignees", map[string]any{"assignees": assigneesJSON(old)}, map[string]any{"assignees": inputsJSON(in)}); err != nil {
		return err
	}
	return a.e.s.notifyDirect(ctx, a.q, a.t, uuid.Nil, fresh, nil, uuid.Nil, a.c)
}

func (a *actx) setLabels(x *v1.RuleAction_SetLabels) error {
	ctx := a.ctx()
	it, err := items(ctx, a.q, a.t.BoardID)
	if err != nil {
		return err
	}
	cur, err := a.q.ListTaskLabelIDs(ctx, []uuid.UUID{a.t.ID})
	if err != nil {
		return err
	}
	var was []uuid.UUID
	for _, l := range cur {
		was = append(was, l.LabelID)
	}
	next := slices.Clone(was)
	gone := 0
	for _, s := range x.GetAddIds() {
		id, err := uuid.Parse(s)
		if _, ok := it.labels[id]; err != nil || !ok {
			gone++
			continue
		}
		if !slices.Contains(next, id) {
			next = append(next, id)
		}
	}
	for _, s := range x.GetRemoveIds() {
		if id, err := uuid.Parse(s); err == nil {
			next = slices.DeleteFunc(next, func(l uuid.UUID) bool { return l == id })
		}
	}
	if gone > 0 && gone == len(x.GetAddIds()) && len(x.GetRemoveIds()) == 0 {
		return skip("the labels no longer exist")
	}
	if err := requireFeature(a.disabled(), v1.BoardFeature_BOARD_FEATURE_LABELS, "labelIds", adds(was, next)); err != nil {
		return err
	}
	if sameSet(was, next) {
		return nil
	}
	if err := a.q.DeleteTaskLabels(ctx, a.t.ID); err != nil {
		return err
	}
	if len(next) > 0 {
		if err := a.q.InsertTaskLabels(ctx, sqlc.InsertTaskLabelsParams{TaskID: a.t.ID, LabelIds: next}); err != nil {
			return err
		}
	}
	if err := a.q.TouchTask(ctx, a.t.ID); err != nil {
		return err
	}
	return a.c.record(ctx, a.q, a.t, uuid.Nil, "labels", map[string]any{"label_ids": idsJSON(was)}, map[string]any{"label_ids": idsJSON(next)})
}

// writeFields stores changed fields of the task and journals them (priority, dates).
func (a *actx) writeFields(t taskRow) error {
	it, err := items(a.ctx(), a.q, a.t.BoardID)
	if err != nil {
		return err
	}
	st := it.statuses[t.StatusID]
	if err := updateRow(a.ctx(), a.q, t); err != nil {
		return err
	}
	return a.e.s.recordFields(a.ctx(), a.q, a.t, t, st, st, uuid.Nil, a.c)
}

func (a *actx) setPriority(x *v1.RuleAction_SetPriority) error {
	p, err := validPriority(x.GetPriority())
	if err != nil {
		return err
	}
	if p == a.t.Priority {
		return nil
	}
	if err := requireFeature(a.disabled(), v1.BoardFeature_BOARD_FEATURE_PRIORITY, "priority", p != 0); err != nil {
		return err
	}
	t := a.t
	t.Priority = p
	return a.writeFields(t)
}

func (a *actx) setDue(x *v1.RuleAction_SetDue) error {
	t := a.t
	t.DueOn = pgtype.Date{}
	if !x.GetClear() {
		t.DueOn = pgtype.Date{Time: utcDay(a.e.s.Now()).AddDate(0, 0, int(min(x.GetDaysFromNow(), MaxRuleDueDays))), Valid: true}
	}
	if dateAny(t.DueOn) == dateAny(a.t.DueOn) {
		return nil
	}
	if err := requireFeature(a.disabled(), v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn", t.DueOn.Valid); err != nil {
		return err
	}
	if t.StartOn.Valid && t.DueOn.Valid && t.DueOn.Time.Before(t.StartOn.Time) {
		return httpx.Validation("dueOn", "the due date is before the start")
	}
	return a.writeFields(t)
}

func (a *actx) setApprovers(x *v1.RuleAction_SetApprovers) error {
	ctx := a.ctx()
	res := perm.NewResolver(a.q)
	var ids []string
	for _, s := range x.GetUserIds() {
		u, err := uuid.Parse(s)
		if err != nil || slices.Contains(ids, u.String()) {
			continue
		}
		usr, err := a.q.GetUser(ctx, u)
		if db.IsNotFound(err) || (err == nil && (usr.IsBot || usr.IsGuest)) {
			continue
		}
		if err != nil {
			return err
		}
		ok, err := mayInvite(ctx, a.q, res, a.t.BoardID, u)
		if err != nil {
			return err
		}
		if ok {
			ids = append(ids, u.String())
		}
	}
	if len(ids) == 0 && len(x.GetUserIds()) > 0 {
		return skip("the approvers no longer see the board")
	}
	required := min(x.GetRequired(), uint32(len(ids))) //nolint:gosec // ≤ 10
	list, req, err := approversIn(ctx, a.q, a.t.BoardID, ids, required, "approverIds", "approvalRequired")
	if err != nil {
		return err
	}
	added, old, changed, err := writeApprovers(ctx, a.q, a.t, list, req, nil)
	if err != nil || !changed {
		return err
	}
	sets := len(added) > 0 || (len(list) > 0 && req != a.t.ApprovalRequired)
	if err := requireFeature(a.disabled(), v1.BoardFeature_BOARD_FEATURE_APPROVALS, "approverIds", sets); err != nil {
		return err
	}
	if err := a.q.TouchTask(ctx, a.t.ID); err != nil {
		return err
	}
	return a.e.s.approversChanged(ctx, a.q, a.t, uuid.Nil, old, list, added, req, a.c)
}

func (a *actx) addChecklist(x *v1.RuleAction_AddChecklist) error {
	ctx := a.ctx()
	if err := a.e.s.checklistGate(ctx, a.t, a.disabled(), false); err != nil {
		return err
	}
	n, err := a.q.CountTaskChecklists(ctx, a.t.ID)
	if err != nil {
		return err
	}
	if n >= MaxChecklists {
		return httpx.Conflict("at most 10 checklists per task").WithDetails(ReasonChecklistLimit, uint64(max(n, 0)), MaxChecklists)
	}
	title, err := validChecklistTitle(x.GetName())
	if err != nil {
		return err
	}
	c, err := a.q.CreateTaskChecklist(ctx, sqlc.CreateTaskChecklistParams{TaskID: a.t.ID, Title: title})
	if err != nil {
		return err
	}
	for i, text := range x.GetItems() {
		if i >= MaxChecklistItems {
			break
		}
		text, err := validChecklistText(text)
		if err != nil {
			return err
		}
		if _, err := a.q.CreateChecklistItem(ctx, sqlc.CreateChecklistItemParams{ChecklistID: c.ID, TaskID: a.t.ID, Text: text}); err != nil {
			return err
		}
	}
	if err := a.q.TouchTask(ctx, a.t.ID); err != nil {
		return err
	}
	a.fx.checklists = append(a.fx.checklists, clRef{t: a.t, id: c.ID})
	return a.c.record(ctx, a.q, a.t, uuid.Nil, "checklist", nil, map[string]any{"checklist_id": c.ID.String(), "title": title, "action": "created"})
}

// vars are the template variables of the task as it is now.
func (a *actx) vars() (map[string]string, error) {
	return a.e.s.templateVars(a.ctx(), a.q, a.t, a.ev.actor)
}

// templateVars: {key} {title} {status} {actor} {assignees} {due} {url} of task t.
func (s *Service) templateVars(ctx context.Context, q *sqlc.Queries, t taskRow, actor *uuid.UUID) (map[string]string, error) {
	key := TaskKey(t.BoardKey, t.Number)
	v := map[string]string{"key": key, "title": t.Title, "due": DateString(t.DueOn), "actor": "", "status": "", "assignees": "", "url": ""}
	if s.PublicURL != "" {
		v["url"] = strings.TrimRight(s.PublicURL, "/") + "/t/" + key
	}
	if ss, err := q.ListBoardStatuses(ctx, []uuid.UUID{t.BoardID}); err == nil {
		for _, st := range ss {
			if st.ID == t.StatusID {
				v["status"] = st.Name
			}
		}
	}
	name := func(u uuid.UUID) string {
		usr, err := q.GetUser(ctx, u)
		if err != nil {
			return ""
		}
		return usr.DisplayName
	}
	if actor != nil {
		v["actor"] = name(*actor)
	}
	as, err := q.ListTaskAssignees(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(as))
	for _, x := range as {
		if n := name(x.UserID); n != "" {
			names = append(names, n)
		}
	}
	v["assignees"] = strings.Join(names, ", ")
	return v, nil
}

// author is who an automation card is posted as: the rule's creator, else the board's.
func (a *actx) author() *uuid.UUID {
	if a.r.row.CreatedBy != nil {
		return a.r.row.CreatedBy
	}
	return a.br.b.CreatedBy
}

// post writes an automation card into room (a text room of the workspace or the task's room).
func (a *actx) post(room uuid.UUID, tpl string) error {
	author := a.author()
	if author == nil {
		return skip("the rule has no author any more")
	}
	vars, err := a.vars()
	if err != nil {
		return err
	}
	payload, err := protojson.Marshal(&v1.SystemMessage{Payload: &v1.SystemMessage_Automation{Automation: &v1.AutomationCard{
		BoardId: a.t.BoardID.String(), TaskId: a.t.ID.String(), RuleId: a.r.row.ID.String(), RuleName: a.r.row.Name,
		Text: renderTemplate(tpl, vars)}}})
	if err != nil {
		return err
	}
	m, err := a.q.InsertSystemMessage(a.ctx(), sqlc.InsertSystemMessageParams{RoomID: room, AuthorID: *author, Payload: payload})
	if err != nil {
		return err
	}
	a.fx.messages = append(a.fx.messages, postedMessage{ws: a.t.WorkspaceID, m: m})
	return nil
}

func (a *actx) comment(x *v1.RuleAction_Comment) error {
	if Disabled(a.disabled(), v1.BoardFeature_BOARD_FEATURE_COMMENTS) {
		return skip("comments are switched off on the board")
	}
	if err := a.post(a.t.RoomID, x.GetTemplate()); err != nil {
		return err
	}
	a.fx.touch(a.t.ID) // comment_count
	return nil
}

// textRoom resolves a text room of the workspace for notify_room (false: gone).
func textRoom(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, raw string) (sqlc.Room, bool, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return sqlc.Room{}, false, nil
	}
	room, err := q.GetRoom(ctx, id)
	if db.IsNotFound(err) {
		return room, false, nil
	}
	if err != nil {
		return room, false, err
	}
	ok := room.Type == "text" && room.ArchivedAt == nil && room.WorkspaceID != nil && *room.WorkspaceID == ws
	return room, ok, nil
}

func (a *actx) notifyRoom(x *v1.RuleAction_NotifyRoom) error {
	room, ok, err := textRoom(a.ctx(), a.q, a.t.WorkspaceID, x.GetRoomId())
	if err != nil {
		return err
	}
	if !ok {
		return skip("the room no longer exists")
	}
	return a.post(room.ID, x.GetTemplate())
}

// recipients of notify_dm among the task's people.
func (s *Service) recipients(ctx context.Context, q *sqlc.Queries, t taskRow, to v1.RuleRecipients) ([]uuid.UUID, error) {
	var users []uuid.UUID
	switch to {
	case v1.RuleRecipients_RULE_RECIPIENTS_CREATOR:
		if t.CreatedBy != nil {
			users = append(users, *t.CreatedBy)
		}
	case v1.RuleRecipients_RULE_RECIPIENTS_APPROVERS:
		aps, err := q.ListTaskApprovers(ctx, []uuid.UUID{t.ID})
		if err != nil {
			return nil, err
		}
		users = approverIDs(aps)
	default: // ASSIGNEES, LEAD
		as, err := q.ListTaskAssignees(ctx, []uuid.UUID{t.ID})
		if err != nil {
			return nil, err
		}
		for _, x := range as {
			if to != v1.RuleRecipients_RULE_RECIPIENTS_LEAD || x.IsLead {
				users = append(users, x.UserID)
			}
		}
	}
	return sees(ctx, q, t, users)
}

func (a *actx) notifyDM(x *v1.RuleAction_NotifyDm) error {
	ctx := a.ctx()
	users, err := a.e.s.recipients(ctx, a.q, a.t, x.GetTo())
	if err != nil {
		return err
	}
	if len(users) == 0 {
		return skip("nobody to notify")
	}
	vars, err := a.vars()
	if err != nil {
		return err
	}
	text := renderTemplate(x.GetTemplate(), vars)
	from := len(a.c.notices)
	if err := decide(ctx, a.q, a.t, uuid.Nil, notifications.TaskRule, users, uuid.Nil, nil, a.c); err != nil {
		return err
	}
	for i := from; i < len(a.c.notices); i++ {
		a.c.notices[i].text, a.c.notices[i].rule = text, a.r.row.ID
	}
	return nil
}

func (a *actx) createSubtasks(x *v1.RuleAction_CreateSubtasks) error {
	ctx := a.ctx()
	titles := x.GetTitles()
	if len(titles) == 0 {
		return nil
	}
	if err := requireFeature(a.disabled(), v1.BoardFeature_BOARD_FEATURE_SUBTASKS, "parentId", true); err != nil {
		return err
	}
	if a.t.ParentID != nil {
		return httpx.Validation("parentId", "subtasks have one level")
	}
	b, err := a.q.GetBoardForUpdate(ctx, a.t.BoardID)
	if err != nil {
		return err
	}
	n, err := a.q.CountLiveTasks(ctx, a.t.BoardID)
	if err != nil {
		return err
	}
	if int(n)+len(titles) > MaxTasks {
		return httpx.Conflict("at most 5000 live tasks per board").WithDetails(ReasonBoardTaskLimit, uint64(max(n, 0)), MaxTasks)
	}
	kids, err := a.q.CountLiveSubtasks(ctx, &a.t.ID)
	if err != nil {
		return err
	}
	if int(kids)+len(titles) > MaxSubtasks {
		return httpx.Conflict("at most 200 subtasks")
	}
	it, err := items(ctx, a.q, a.t.BoardID)
	if err != nil {
		return err
	}
	st := it.def
	if st == nil {
		return httpx.Conflict("the board has no status")
	}
	now := a.e.s.Now()
	for _, raw := range titles {
		title, err := validTitle(raw)
		if err != nil {
			return err
		}
		number, err := a.q.NextTaskNumber(ctx, a.t.BoardID)
		if err != nil {
			return err
		}
		roomID, err := a.q.CreateTaskRoom(ctx, sqlc.CreateTaskRoomParams{WorkspaceID: &b.WorkspaceID, Name: TaskKey(b.Key, number)})
		if err != nil {
			return err
		}
		pos, err := place(ctx, a.q, st.ID, uuid.Nil, nil, nil)
		if err != nil {
			return err
		}
		sub := taskRow{BoardID: a.t.BoardID, Number: number, Title: title, StatusID: st.ID, ParentID: &a.t.ID, Position: pos,
			RoomID: roomID, BoardKey: b.Key, WorkspaceID: b.WorkspaceID}
		finishFields(&sub, st.Type, uuid.Nil, now)
		sub.CompletedBy = nil
		if sub.ID, err = a.q.InsertTask(ctx, sqlc.InsertTaskParams{BoardID: sub.BoardID, Number: sub.Number, Title: sub.Title,
			StatusID: sub.StatusID, ParentID: sub.ParentID, Position: sub.Position, RoomID: sub.RoomID,
			StartedAt: sub.StartedAt, CompletedAt: sub.CompletedAt}); err != nil {
			return err
		}
		if err := a.c.record(ctx, a.q, sub, uuid.Nil, "created", nil, map[string]any{"title": title, "status_id": st.ID.String(),
			"status_type": st.Type, "priority": 0, "parent_id": a.t.ID.String()}); err != nil {
			return err
		}
		a.fx.created = append(a.fx.created, sub.ID)
	}
	a.c.tasks = append(a.c.tasks, a.t.ID) // the parent's subtask counters
	return nil
}

func (a *actx) archive() error {
	ctx := a.ctx()
	if a.t.ArchivedAt != nil {
		return nil
	}
	if err := a.q.SetTaskArchived(ctx, sqlc.SetTaskArchivedParams{ID: a.t.ID, Archived: true}); err != nil {
		return err
	}
	if a.t.ParentID != nil {
		a.c.tasks = append(a.c.tasks, *a.t.ParentID)
	}
	a.fx.archived = append(a.fx.archived, a.t)
	return a.c.record(ctx, a.q, a.t, uuid.Nil, "archived", nil, nil)
}

// ---- dry run (POST /api/rules/{id}/test) ----

// dryRun says what each action of r would do on task t, changing nothing.
func (s *Service) dryRun(ctx context.Context, q *sqlc.Queries, b sqlc.Board, r rule, t taskRow) ([]*v1.RuleTestResponse_Action, error) {
	it, err := items(ctx, q, t.BoardID)
	if err != nil {
		return nil, err
	}
	vars, err := s.templateVars(ctx, q, t, nil)
	if err != nil {
		return nil, err
	}
	d := b.DisabledFeatures
	feature := func(f v1.BoardFeature) string {
		if Disabled(d, f) {
			return "the board feature " + strings.TrimPrefix(f.String(), "BOARD_FEATURE_") + " is switched off"
		}
		return ""
	}
	out := make([]*v1.RuleTestResponse_Action, 0, len(r.actions))
	for _, act := range r.actions {
		x := &v1.RuleTestResponse_Action{Kind: ActionKind(act)}
		switch k := act.GetKind().(type) {
		case *v1.RuleAction_SetStatus_:
			id, _ := uuid.Parse(k.SetStatus.GetStatusId())
			to, ok := it.statuses[id]
			if !ok {
				x.Problem = "the status no longer exists"
				break
			}
			x.Summary = "status → " + to.Name
			if to.ID == t.StatusID {
				x.Problem = "the task is already in this status"
			} else if !Disabled(d, v1.BoardFeature_BOARD_FEATURE_APPROVALS) {
				tl, err := taskTally(ctx, q, t)
				if err != nil {
					return nil, err
				}
				if err := checkApprovalGate(tl, it.statuses[t.StatusID], to); err != nil {
					x.Problem = ruleErrText(err)
				}
			}
		case *v1.RuleAction_SetAssignees_:
			x.Summary = "assignees: " + strings.ToLower(strings.TrimPrefix(k.SetAssignees.GetMode().String(), "RULE_ASSIGNEES_MODE_")) +
				" " + strconv.Itoa(len(k.SetAssignees.GetUserIds())) + " user(s)"
			res := perm.NewResolver(q)
			for _, s := range k.SetAssignees.GetUserIds() {
				u, err := uuid.Parse(s)
				ok := err == nil
				if ok {
					if ok, err = mayInvite(ctx, q, res, t.BoardID, u); err != nil {
						return nil, err
					}
				}
				if !ok {
					x.Problem = "a user no longer sees the board"
				}
			}
		case *v1.RuleAction_SetLabels_:
			x.Summary = "labels: +" + strconv.Itoa(len(k.SetLabels.GetAddIds())) + " −" + strconv.Itoa(len(k.SetLabels.GetRemoveIds()))
			for _, s := range k.SetLabels.GetAddIds() {
				id, _ := uuid.Parse(s)
				if _, ok := it.labels[id]; !ok {
					x.Problem = "a label no longer exists"
				}
			}
			if p := feature(v1.BoardFeature_BOARD_FEATURE_LABELS); p != "" && len(k.SetLabels.GetAddIds()) > 0 {
				x.Problem = p
			}
		case *v1.RuleAction_SetPriority_:
			x.Summary = "priority → " + strings.ToLower(strings.TrimPrefix(k.SetPriority.GetPriority().String(), "TASK_PRIORITY_"))
			if k.SetPriority.GetPriority() != v1.TaskPriority_TASK_PRIORITY_NONE {
				x.Problem = feature(v1.BoardFeature_BOARD_FEATURE_PRIORITY)
			}
		case *v1.RuleAction_SetDue_:
			if k.SetDue.GetClear() {
				x.Summary = "due date cleared"
				break
			}
			due := utcDay(s.Now()).AddDate(0, 0, int(min(k.SetDue.GetDaysFromNow(), MaxRuleDueDays)))
			x.Summary = "due → " + due.Format(time.DateOnly)
			if x.Problem = feature(v1.BoardFeature_BOARD_FEATURE_DUE_DATE); x.Problem == "" && t.StartOn.Valid && due.Before(t.StartOn.Time) {
				x.Problem = "the due date is before the start"
			}
		case *v1.RuleAction_SetApprovers_:
			x.Summary = "approvers: " + strconv.Itoa(len(k.SetApprovers.GetUserIds())) + " user(s)"
			if len(k.SetApprovers.GetUserIds()) > 0 {
				x.Problem = feature(v1.BoardFeature_BOARD_FEATURE_APPROVALS)
			}
		case *v1.RuleAction_AddChecklist_:
			x.Summary = "checklist «" + k.AddChecklist.GetName() + "» with " + strconv.Itoa(len(k.AddChecklist.GetItems())) + " item(s)"
			if err := s.checklistGate(ctx, t, d, false); err != nil {
				x.Problem = ruleErrText(err)
			} else if n, err := q.CountTaskChecklists(ctx, t.ID); err != nil {
				return nil, err
			} else if n >= MaxChecklists {
				x.Problem = "at most 10 checklists per task"
			}
		case *v1.RuleAction_Comment_:
			x.Summary = "comment: " + renderTemplate(k.Comment.GetTemplate(), vars)
			x.Problem = feature(v1.BoardFeature_BOARD_FEATURE_COMMENTS)
		case *v1.RuleAction_NotifyRoom_:
			x.Summary = "room message: " + renderTemplate(k.NotifyRoom.GetTemplate(), vars)
			if _, ok, err := textRoom(ctx, q, b.WorkspaceID, k.NotifyRoom.GetRoomId()); err != nil {
				return nil, err
			} else if !ok {
				x.Problem = "the room no longer exists"
			}
		case *v1.RuleAction_NotifyDm_:
			users, err := s.recipients(ctx, q, t, k.NotifyDm.GetTo())
			if err != nil {
				return nil, err
			}
			x.Summary = "notice to " + strconv.Itoa(len(users)) + " user(s): " + renderTemplate(k.NotifyDm.GetTemplate(), vars)
			if len(users) == 0 {
				x.Problem = "nobody to notify"
			}
		case *v1.RuleAction_CreateSubtasks_:
			x.Summary = strconv.Itoa(len(k.CreateSubtasks.GetTitles())) + " subtask(s)"
			if x.Problem = feature(v1.BoardFeature_BOARD_FEATURE_SUBTASKS); x.Problem == "" && t.ParentID != nil {
				x.Problem = "subtasks have one level"
			}
		case *v1.RuleAction_Archive_:
			x.Summary = "archive the task"
		}
		out = append(out, x)
	}
	return out, nil
}
