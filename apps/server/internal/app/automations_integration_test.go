//go:build integration

package app_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Board automations (ADR-0060 §2, §3, §7).

func onStatus(to string) *v1.RuleTrigger {
	return &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{ToStatusId: to}}}
}

func onCreated() *v1.RuleTrigger {
	return &v1.RuleTrigger{Kind: &v1.RuleTrigger_TaskCreated_{TaskCreated: &v1.RuleTrigger_TaskCreated{}}}
}

func onPriority() *v1.RuleTrigger {
	return &v1.RuleTrigger{Kind: &v1.RuleTrigger_PriorityChanged_{PriorityChanged: &v1.RuleTrigger_PriorityChanged{}}}
}

func onLabel(id string) *v1.RuleTrigger {
	return &v1.RuleTrigger{Kind: &v1.RuleTrigger_LabelChanged_{LabelChanged: &v1.RuleTrigger_LabelChanged{LabelId: id, Added: true}}}
}

func doStatus(id string) *v1.RuleAction {
	return &v1.RuleAction{Kind: &v1.RuleAction_SetStatus_{SetStatus: &v1.RuleAction_SetStatus{StatusId: id}}}
}

func doPriority(p v1.TaskPriority) *v1.RuleAction {
	return &v1.RuleAction{Kind: &v1.RuleAction_SetPriority_{SetPriority: &v1.RuleAction_SetPriority{Priority: p}}}
}

func doLabel(id string) *v1.RuleAction {
	return &v1.RuleAction{Kind: &v1.RuleAction_SetLabels_{SetLabels: &v1.RuleAction_SetLabels{AddIds: []string{id}}}}
}

func doComment(tpl string) *v1.RuleAction {
	return &v1.RuleAction{Kind: &v1.RuleAction_Comment_{Comment: &v1.RuleAction_Comment{Template: tpl}}}
}

func createRule(t *testing.T, u musty, boardID string, req *v1.CreateBoardRuleRequest, want int) *v1.BoardRule {
	t.Helper()
	var r v1.BoardRuleResponse
	u.must(want, "POST", "/api/boards/"+boardID+"/rules", req, &r)
	return r.GetRule()
}

func ruleRuns(t *testing.T, u musty, ruleID string) []*v1.RuleRun {
	t.Helper()
	var r v1.ListRuleRunsResponse
	u.must(200, "GET", "/api/rules/"+ruleID+"/runs", nil, &r)
	return r.GetRuns()
}

func createLabel(t *testing.T, u musty, boardID, name string) string {
	t.Helper()
	var r v1.BoardResponse
	u.must(201, "POST", "/api/boards/"+boardID+"/labels", &v1.CreateBoardLabelRequest{Name: name, Color: 0xff0000}, &r)
	for _, l := range r.GetBoard().GetLabels() {
		if l.GetName() == name {
			return l.GetId()
		}
	}
	t.Fatalf("label %s not created", name)
	return ""
}

// ruleActivities returns the journal entries of a task made by rules.
func ruleActivities(t *testing.T, u musty, taskID string) []*v1.TaskActivity {
	t.Helper()
	var p v1.TaskActivityPage
	u.must(200, "GET", "/api/tasks/"+taskID+"/activity?limit=100", nil, &p)
	var out []*v1.TaskActivity
	for _, it := range p.GetItems() {
		if a := it.GetActivity(); a != nil && a.GetRuleId() != "" {
			out = append(out, a)
		}
	}
	return out
}

// automationCards returns the texts of the automation cards in a task's comments.
func automationCards(t *testing.T, u musty, taskID string) []string {
	t.Helper()
	var p v1.TaskActivityPage
	u.must(200, "GET", "/api/tasks/"+taskID+"/activity?limit=100", nil, &p)
	var out []string
	for _, it := range p.GetItems() {
		if c := it.GetMessage().GetSystem().GetAutomation(); c != nil {
			out = append(out, c.GetText())
		}
	}
	return out
}

func TestBoardRules(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE}) // automations + board webhooks
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Rules", Key: "RUL"}, 201)
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, 0, perm.ViewBoard))
	todo := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	doing := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED)
	rules := "/api/boards/" + b.GetId() + "/rules"
	valid := &v1.CreateBoardRuleRequest{Name: "В работу → срочно", Trigger: onStatus(doing),
		Actions: []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_HIGH)}}

	t.Run("plan", func(t *testing.T) {
		withFreeLimits(t)
		ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
		b2 := createBoard(t, o, ws2.GetId(), &v1.CreateBoardRequest{Name: "Free", Key: "FRE"}, 201)
		st, e := o.apiErrBody("POST", "/api/boards/"+b2.GetId()+"/rules", valid)
		wantPlanLimit(t, "a rule on Free", st, e, 0, 0)
	})

	// Rights: MANAGE_BOARD writes; viewers and bots read; bots never write.
	bob.must(403, "POST", rules, valid, nil)
	bt := createBot(t, o, wid, "rulebot")
	bt.must(403, "POST", rules, valid, nil)
	if reason, _ := errReason(bt.client); reason != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot write reason %q", reason)
	}
	carol.must(404, "GET", rules, nil, nil)

	// Validation.
	for name, req := range map[string]*v1.CreateBoardRuleRequest{
		"no trigger":   {Name: "x", Actions: valid.Actions},
		"no actions":   {Name: "x", Trigger: valid.Trigger},
		"no name":      {Trigger: valid.Trigger, Actions: valid.Actions},
		"foreign":      {Name: "x", Trigger: onStatus("01890000-0000-7000-8000-00000000abcd"), Actions: valid.Actions},
		"bad template": {Name: "x", Trigger: valid.Trigger, Actions: []*v1.RuleAction{doComment("")}},
		"six actions": {Name: "x", Trigger: valid.Trigger, Actions: []*v1.RuleAction{doComment("1"), doComment("2"), doComment("3"),
			doComment("4"), doComment("5"), doComment("6")}},
		"bad filter": {Name: "x", Trigger: valid.Trigger, Actions: valid.Actions, Condition: &v1.TaskFilter{Conditions: []*v1.TaskCondition{
			{Field: v1.TaskField_TASK_FIELD_PRIORITY, Op: v1.TaskOp_TASK_OP_CONTAINS}}}},
	} {
		if st := o.do("POST", rules, req, nil); st != 422 {
			t.Fatalf("%s: %d, want 422", name, st)
		}
	}
	setBoardFeatures(t, b.GetId(), 1<<uint(v1.BoardFeature_BOARD_FEATURE_DUE_DATE))
	o.must(409, "POST", rules, &v1.CreateBoardRuleRequest{Name: "x", Actions: valid.Actions,
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_Overdue_{Overdue: &v1.RuleTrigger_Overdue{Days: 1}}}}, nil)
	if reason, _ := errReason(o.client); reason != "FEATURE_DISABLED" {
		t.Fatalf("due trigger reason %q", reason)
	}
	setBoardFeatures(t, b.GetId(), 0)

	// Events 92 / 93 to the board's viewers, BOARD_UPDATE with rules_count.
	gb, gc := dialGW(t), dialGW(t)
	gb.identify(bob.token)
	gc.identify(carol.token)
	room := textRoom(t, o, wid, "automation", false)
	r1 := createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "В работу", Trigger: onStatus(doing), Actions: []*v1.RuleAction{
		doPriority(v1.TaskPriority_TASK_PRIORITY_HIGH),
		doComment("{key} «{title}» взяли в работу: {status}"),
		{Kind: &v1.RuleAction_NotifyDm_{NotifyDm: &v1.RuleAction_NotifyDm{To: v1.RuleRecipients_RULE_RECIPIENTS_ASSIGNEES, Template: "{key}: пора"}}},
		{Kind: &v1.RuleAction_NotifyRoom_{NotifyRoom: &v1.RuleAction_NotifyRoom{RoomId: room, Template: "{key} в работе"}}},
	}}, 201)
	if !r1.GetEnabled() || r1.GetCreatedBy() != o.id || len(r1.GetActions()) != 4 {
		t.Fatalf("rule: %v", r1)
	}
	gb.wait("BOARD_RULE_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetBoardRuleUpdate().GetRule().GetId() == r1.GetId() })
	gb.wait("BOARD_UPDATE rules_count", func(e *v1.DispatchEvent) bool {
		return e.GetBoardUpdate().GetBoard().GetId() == b.GetId() && e.GetBoardUpdate().GetBoard().GetRulesCount() == 1
	})
	var list v1.ListBoardRulesResponse
	bt.must(200, "GET", rules, nil, &list)
	if len(list.GetRules()) != 1 {
		t.Fatalf("rules: %v", &list)
	}

	// The board webhook: the rule's changes are their own event with actor null and the rule.
	recv := newBoardHookRecv(t)
	var wr v1.BoardWebhookResponse
	o.must(200, "PUT", "/api/boards/"+b.GetId()+"/webhook", &v1.SetBoardWebhookRequest{Url: recv.srv.URL}, &wr)
	recv.mu.Lock()
	recv.secret = wr.GetSecret()
	recv.mu.Unlock()

	// A status change fires the rule: priority, comment card, notice to the assignee, room card.
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{StatusId: &doing}, 200)
	got := getTask(t, o, task.GetId()).GetTask()
	if got.GetPriority() != v1.TaskPriority_TASK_PRIORITY_HIGH || got.GetStatusId() != doing {
		t.Fatalf("after the rule: %v", got)
	}
	acts := ruleActivities(t, o, task.GetId())
	if len(acts) != 1 || acts[0].GetKind() != "priority" || acts[0].GetRuleId() != r1.GetId() || acts[0].GetActorId() != "" {
		t.Fatalf("rule journal: %v", acts)
	}
	if cards := automationCards(t, o, task.GetId()); len(cards) != 1 || cards[0] != task.GetKey()+" «Отчёт» взяли в работу: В работе" {
		t.Fatalf("comment cards: %q", cards)
	}
	// Published in this order after the commit: the cards, then the notices.
	gb.wait("room automation card", func(e *v1.DispatchEvent) bool {
		c := e.GetMessageCreate().GetMessage().GetSystem().GetAutomation()
		return c.GetText() == task.GetKey()+" в работе" && c.GetTaskId() == task.GetId() && c.GetRuleName() == "В работу"
	})
	gb.wait("TASK_UPDATE notice RULE", func(e *v1.DispatchEvent) bool {
		n := e.GetTaskUpdate().GetNotice()
		return n.GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_RULE && n.GetText() == task.GetKey()+": пора" && n.GetRuleId() == r1.GetId()
	})
	runs := ruleRuns(t, o, r1.GetId())
	if len(runs) != 1 || !runs[0].GetOk() || runs[0].GetActionsApplied() != 4 || runs[0].GetTaskId() != task.GetId() || runs[0].GetTriggerKind() != "status_changed" {
		t.Fatalf("runs: %v", runs)
	}
	evs := recv.wait("rule webhook", func(g []*v1.BoardWebhookEvent) bool {
		return slices.ContainsFunc(g, func(e *v1.BoardWebhookEvent) bool { return e.GetRule() != nil })
	})
	for _, e := range evs {
		if e.GetRule() == nil {
			continue
		}
		if e.GetActor() != nil || e.GetRule().GetId() != r1.GetId() || e.GetRule().GetName() != "В работу" || e.GetType() != "task.updated" ||
			len(e.GetChanges()) != 1 || e.GetChanges()[0].GetField() != "priority" {
			t.Fatalf("rule webhook event: %v", e)
		}
	}
	carol.must(404, "GET", "/api/rules/"+r1.GetId()+"/runs", nil, nil)
	bob.must(403, "GET", "/api/rules/"+r1.GetId()+"/runs", nil, nil)

	// Disabled: no run. Then deleted: BOARD_RULE_DELETE.
	off := false
	o.must(200, "PATCH", "/api/rules/"+r1.GetId(), &v1.UpdateBoardRuleRequest{Enabled: &off}, nil)
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{StatusId: &todo}, 200)
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{StatusId: &doing}, 200)
	if n := len(ruleRuns(t, o, r1.GetId())); n != 1 {
		t.Fatalf("a disabled rule ran: %d runs", n)
	}
	o.must(204, "DELETE", "/api/rules/"+r1.GetId(), nil, nil)
	gb.wait("BOARD_RULE_DELETE", func(e *v1.DispatchEvent) bool { return e.GetBoardRuleDelete().GetRuleId() == r1.GetId() })
	gc.quiet("rule events for a user without the board", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetBoardRuleUpdate() != nil || e.GetBoardRuleDelete() != nil
	})

	t.Run("approval gate and savepoint", func(t *testing.T) {
		bg := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Gate", Key: "GAT"}, 201)
		gdone := statusOf(bg, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
		urgent := createLabel(t, o, bg.GetId(), "срочно")
		// Priority → label + done: the gate refuses the move; the label rolls back with it.
		r2 := createRule(t, o, bg.GetId(), &v1.CreateBoardRuleRequest{Name: "Срочное — закрыть", Trigger: onPriority(),
			Actions: []*v1.RuleAction{doLabel(urgent), doStatus(gdone)}}, 201)
		r3 := createRule(t, o, bg.GetId(), &v1.CreateBoardRuleRequest{Name: "Согласовано → Готово",
			Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_ApprovalChanged_{ApprovalChanged: &v1.RuleTrigger_ApprovalChanged{
				State: v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED}}},
			Actions: []*v1.RuleAction{doStatus(gdone)}}, 201)
		tk := createTask(t, o, bg.GetId(), &v1.CreateTaskRequest{Title: "Нужно согласие", ApproverIds: []string{bob.id}}, 201)
		patchTask(t, o, tk.GetId(), &v1.UpdateTaskRequest{Priority: new(v1.TaskPriority_TASK_PRIORITY_URGENT)}, 200)
		got := getTask(t, o, tk.GetId()).GetTask()
		if got.GetPriority() != v1.TaskPriority_TASK_PRIORITY_URGENT || len(got.GetLabelIds()) != 0 || got.GetStatusId() == gdone {
			t.Fatalf("savepoint: the user's change must stay, the rule's actions roll back: %v", got)
		}
		runs := ruleRuns(t, o, r2.GetId())
		if len(runs) != 1 || runs[0].GetOk() || runs[0].GetActionsApplied() != 0 || !strings.HasPrefix(runs[0].GetError(), "set_status: TASK_APPROVAL_REQUIRED") {
			t.Fatalf("gate run: %v", runs)
		}
		var rl v1.ListBoardRulesResponse
		o.must(200, "GET", "/api/boards/"+bg.GetId()+"/rules", nil, &rl)
		if rl.GetRules()[0].GetLastError() == "" || rl.GetRules()[0].GetRunsCount() != 1 {
			t.Fatalf("last_error: %v", rl.GetRules()[0])
		}
		// The dry run tells the same.
		var tr v1.RuleTestResponse
		o.must(200, "POST", "/api/rules/"+r2.GetId()+"/test", &v1.TestBoardRuleRequest{TaskId: tk.GetId()}, &tr)
		if !tr.GetMatches() || len(tr.GetActions()) != 2 || tr.GetActions()[0].GetProblem() != "" || !strings.HasPrefix(tr.GetActions()[1].GetProblem(), "TASK_APPROVAL_REQUIRED") {
			t.Fatalf("dry run: %v", &tr)
		}
		// Approved: the approval rule moves it (the gate passes now).
		voteTask(bob, tk.GetId(), 200, approve, "")
		if s := getTask(t, o, tk.GetId()).GetTask().GetStatusId(); s != gdone {
			t.Fatalf("approval rule: status %s, want done", s)
		}
		if runs := ruleRuns(t, o, r3.GetId()); len(runs) != 1 || !runs[0].GetOk() {
			t.Fatalf("approval runs: %v", runs)
		}
	})

	t.Run("checklist completed", func(t *testing.T) {
		bc := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Checklist", Key: "CLR"}, 201)
		cdone := statusOf(bc, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
		r4 := createRule(t, o, bc.GetId(), &v1.CreateBoardRuleRequest{Name: "Чек-лист → Готово",
			Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_ChecklistCompleted_{ChecklistCompleted: &v1.RuleTrigger_ChecklistCompleted{}}},
			Actions: []*v1.RuleAction{doStatus(cdone),
				{Kind: &v1.RuleAction_CreateSubtasks_{CreateSubtasks: &v1.RuleAction_CreateSubtasks{Titles: []string{"Проверить"}}}}}}, 201)
		tk := createTask(t, o, bc.GetId(), &v1.CreateTaskRequest{Title: "С пунктами"}, 201)
		cl := newChecklist(t, o, tk.GetId(), "шаги", 201).GetChecklist()
		i1 := newItem(t, o, cl.GetId(), "один", 201).GetChecklist().GetItems()[0]
		i2 := newItem(t, o, cl.GetId(), "два", 201).GetChecklist().GetItems()[1]
		yes := true
		o.must(200, "PATCH", "/api/checklist-items/"+i1.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &yes}, nil)
		if s := getTask(t, o, tk.GetId()).GetTask().GetStatusId(); s == cdone {
			t.Fatal("moved before the last item")
		}
		g := dialGW(t)
		g.identify(bob.token)
		o.must(200, "PATCH", "/api/checklist-items/"+i2.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &yes}, nil)
		full := getTask(t, o, tk.GetId())
		if full.GetTask().GetStatusId() != cdone || len(full.GetSubtasks()) != 1 || full.GetSubtasks()[0].GetTitle() != "Проверить" ||
			full.GetSubtasks()[0].GetCreatedBy() != "" {
			t.Fatalf("checklist rule: %v", full)
		}
		// The board learns of the rule's changes: TASK_CREATE of the subtask, TASK_UPDATE of the task.
		g.wait("TASK_CREATE of the subtask", func(e *v1.DispatchEvent) bool { return e.GetTaskCreate().GetTask().GetParentId() == tk.GetId() })
		g.wait("TASK_UPDATE by the rule", func(e *v1.DispatchEvent) bool {
			return e.GetTaskUpdate().GetTask().GetId() == tk.GetId() && e.GetTaskUpdate().GetTask().GetStatusId() == cdone
		})
		if runs := ruleRuns(t, o, r4.GetId()); len(runs) != 1 || runs[0].GetActionsApplied() != 2 {
			t.Fatalf("checklist runs: %v", runs)
		}
	})

	t.Run("chain depth and loop", func(t *testing.T) {
		bc := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Chain", Key: "CHN"}, 201)
		cdoing := statusOf(bc, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED)
		lbl := createLabel(t, o, bc.GetId(), "цепочка")
		createRule(t, o, bc.GetId(), &v1.CreateBoardRuleRequest{Name: "1", Trigger: onCreated(), Actions: []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_LOW)}}, 201)
		createRule(t, o, bc.GetId(), &v1.CreateBoardRuleRequest{Name: "2", Trigger: onPriority(), Actions: []*v1.RuleAction{doLabel(lbl)}}, 201)
		createRule(t, o, bc.GetId(), &v1.CreateBoardRuleRequest{Name: "3", Trigger: onLabel(lbl), Actions: []*v1.RuleAction{doStatus(cdoing)}}, 201)
		r4 := createRule(t, o, bc.GetId(), &v1.CreateBoardRuleRequest{Name: "4", Trigger: onStatus(""), Actions: []*v1.RuleAction{doComment("глубоко")}}, 201)
		tk := createTask(t, o, bc.GetId(), &v1.CreateTaskRequest{Title: "Цепочка"}, 201)
		got := getTask(t, o, tk.GetId()).GetTask()
		if got.GetPriority() != v1.TaskPriority_TASK_PRIORITY_LOW || !slices.Contains(got.GetLabelIds(), lbl) || got.GetStatusId() != cdoing {
			t.Fatalf("depth 3: %v", got)
		}
		if cards := automationCards(t, o, tk.GetId()); len(cards) != 0 {
			t.Fatalf("depth 4 ran: %q", cards)
		}
		runs := ruleRuns(t, o, r4.GetId())
		if len(runs) != 1 || runs[0].GetOk() || !strings.HasPrefix(runs[0].GetError(), "RULE_LOOP") {
			t.Fatalf("depth 4 run: %v", runs)
		}

		// A loop: priority → label, label → priority; the first rule does not run twice.
		bl := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Loop", Key: "LOP"}, 201)
		x := createLabel(t, o, bl.GetId(), "x")
		ra := createRule(t, o, bl.GetId(), &v1.CreateBoardRuleRequest{Name: "a", Trigger: onPriority(), Actions: []*v1.RuleAction{doLabel(x)}}, 201)
		createRule(t, o, bl.GetId(), &v1.CreateBoardRuleRequest{Name: "b", Trigger: onLabel(x), Actions: []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_LOW)}}, 201)
		lt := createTask(t, o, bl.GetId(), &v1.CreateTaskRequest{Title: "Петля"}, 201)
		patchTask(t, o, lt.GetId(), &v1.UpdateTaskRequest{Priority: new(v1.TaskPriority_TASK_PRIORITY_HIGH)}, 200)
		if got := getTask(t, o, lt.GetId()).GetTask(); got.GetPriority() != v1.TaskPriority_TASK_PRIORITY_LOW || !slices.Contains(got.GetLabelIds(), x) {
			t.Fatalf("loop result: %v", got)
		}
		runs = ruleRuns(t, o, ra.GetId())
		if len(runs) != 2 || runs[0].GetError() == "" || !strings.HasPrefix(runs[0].GetError(), "RULE_LOOP") || !runs[1].GetOk() {
			t.Fatalf("loop runs: %v", runs)
		}
	})

	t.Run("schedule once a deadline", func(t *testing.T) {
		bs := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Schedule", Key: "SCH"}, 201)
		rs := createRule(t, o, bs.GetId(), &v1.CreateBoardRuleRequest{Name: "Просрочено",
			Trigger:   &v1.RuleTrigger{Kind: &v1.RuleTrigger_Overdue_{Overdue: &v1.RuleTrigger_Overdue{Days: 1}}},
			Condition: &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_TEXT, Op: v1.TaskOp_TASK_OP_CONTAINS, Values: []string{"горит"}}}},
			Actions:   []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_URGENT), doComment("{key} просрочена ({due})")}}, 201)
		due := time.Now().UTC().AddDate(0, 0, -2).Format(time.DateOnly)
		late := createTask(t, o, bs.GetId(), &v1.CreateTaskRequest{Title: "Отчёт горит", DueOn: due}, 201)
		other := createTask(t, o, bs.GetId(), &v1.CreateTaskRequest{Title: "Тоже просрочена", DueOn: due}, 201)
		fresh := createTask(t, o, bs.GetId(), &v1.CreateTaskRequest{Title: "Горит, но не просрочена", DueOn: time.Now().UTC().Format(time.DateOnly)}, 201)
		for range 2 {
			if _, err := testApp.Boards.SweepRules(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
		if got := getTask(t, o, late.GetId()).GetTask(); got.GetPriority() != v1.TaskPriority_TASK_PRIORITY_URGENT {
			t.Fatalf("overdue rule: %v", got)
		}
		if cards := automationCards(t, o, late.GetId()); len(cards) != 1 || cards[0] != late.GetKey()+" просрочена ("+due+")" {
			t.Fatalf("one card per deadline: %q", cards)
		}
		for _, x := range []*v1.Task{other, fresh} {
			if p := getTask(t, o, x.GetId()).GetTask().GetPriority(); p != v1.TaskPriority_TASK_PRIORITY_NONE {
				t.Fatalf("%s: priority %v", x.GetTitle(), p)
			}
		}
		runs := ruleRuns(t, o, rs.GetId())
		if len(runs) != 1 || !runs[0].GetOk() || runs[0].GetTriggerKind() != "overdue" || runs[0].GetTaskId() != late.GetId() {
			t.Fatalf("scheduled runs: %v", runs)
		}
	})

	t.Run("limit", func(t *testing.T) {
		bl := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Limit", Key: "LIM"}, 201)
		ok := false
		for i := range 20 {
			createRule(t, o, bl.GetId(), &v1.CreateBoardRuleRequest{Name: "r" + string(rune('a'+i)), Enabled: &ok, Trigger: onCreated(),
				Actions: []*v1.RuleAction{doComment("x")}}, 201)
		}
		o.must(409, "POST", "/api/boards/"+bl.GetId()+"/rules", &v1.CreateBoardRuleRequest{Name: "21", Trigger: onCreated(),
			Actions: []*v1.RuleAction{doComment("x")}}, nil)
		if reason, _ := errReason(o.client); reason != "RULE_LIMIT" {
			t.Fatalf("reason %q", reason)
		}
	})
}
