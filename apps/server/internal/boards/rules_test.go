package boards

import (
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func act(kind, before, after string) ruleEvent {
	return eventOf(sqlc.TaskActivity{Kind: kind, Before: []byte(before), After: []byte(after)})
}

// Which journal entries fire which triggers (ADR-0060 §2).
func TestMatchTrigger(t *testing.T) {
	never := func() bool { t.Fatal("checklist counters asked for a non-checklist entry"); return false }
	yes, no := func() bool { return true }, func() bool { return false }
	prio := func(p v1.TaskPriority) *v1.TaskPriority { return &p }
	status := act("status", `{"status_id":"a","status_type":"unstarted"}`, `{"status_id":"b","status_type":"completed"}`)
	cases := []struct {
		name     string
		trigger  *v1.RuleTrigger
		ev       ruleEvent
		complete func() bool
		want     bool
	}{
		{"created", &v1.RuleTrigger{Kind: &v1.RuleTrigger_TaskCreated_{TaskCreated: &v1.RuleTrigger_TaskCreated{}}}, act("created", "", `{}`), never, true},
		{"created vs title", &v1.RuleTrigger{Kind: &v1.RuleTrigger_TaskCreated_{TaskCreated: &v1.RuleTrigger_TaskCreated{}}}, act("title", "", `{}`), never, false},
		{"status any", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{}}}, status, never, true},
		{"status to", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{ToStatusId: "b"}}}, status, never, true},
		{"status to other", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{ToStatusId: "c"}}}, status, never, false},
		{"status from", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{FromStatusId: "a", ToStatusId: "b"}}}, status, never, true},
		{"status from other", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{FromStatusId: "x"}}}, status, never, false},
		{"status to type", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{
			ToType: v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED}}}, status, never, true},
		{"status to other type", &v1.RuleTrigger{Kind: &v1.RuleTrigger_StatusChanged_{StatusChanged: &v1.RuleTrigger_StatusChanged{
			ToType: v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED}}}, status, never, false},
		{"approved vote", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ApprovalChanged_{ApprovalChanged: &v1.RuleTrigger_ApprovalChanged{
			State: v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED}}}, act("approval", `{}`, `{"state":"approved","approval_state":"approved"}`), never, true},
		{"a vote without a decision", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ApprovalChanged_{ApprovalChanged: &v1.RuleTrigger_ApprovalChanged{
			State: v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED}}}, act("approval", `{}`, `{"state":"approved"}`), never, false},
		{"rejected vs approved", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ApprovalChanged_{ApprovalChanged: &v1.RuleTrigger_ApprovalChanged{
			State: v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED}}}, act("approval", `{}`, `{"approval_state":"approved"}`), never, false},
		{"approvers complete", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ApprovalChanged_{ApprovalChanged: &v1.RuleTrigger_ApprovalChanged{}}},
			act("approvers", `{}`, `{"approval_state":"approved"}`), never, true},
		{"assignee added", &v1.RuleTrigger{Kind: &v1.RuleTrigger_AssigneesChanged_{AssigneesChanged: &v1.RuleTrigger_AssigneesChanged{Added: true}}},
			act("assignees", `{"assignees":[{"user_id":"u1","is_lead":true}]}`, `{"assignees":[{"user_id":"u1","is_lead":true},{"user_id":"u2"}]}`), never, true},
		{"assignee added, removed wanted", &v1.RuleTrigger{Kind: &v1.RuleTrigger_AssigneesChanged_{AssigneesChanged: &v1.RuleTrigger_AssigneesChanged{Removed: true}}},
			act("assignees", `{"assignees":[{"user_id":"u1","is_lead":true}]}`, `{"assignees":[{"user_id":"u1","is_lead":true},{"user_id":"u2"}]}`), never, false},
		{"lead changed", &v1.RuleTrigger{Kind: &v1.RuleTrigger_AssigneesChanged_{AssigneesChanged: &v1.RuleTrigger_AssigneesChanged{Lead: true}}},
			act("assignees", `{"assignees":[{"user_id":"u1","is_lead":true},{"user_id":"u2"}]}`, `{"assignees":[{"user_id":"u1"},{"user_id":"u2","is_lead":true}]}`), never, true},
		{"label added", &v1.RuleTrigger{Kind: &v1.RuleTrigger_LabelChanged_{LabelChanged: &v1.RuleTrigger_LabelChanged{LabelId: "l2", Added: true}}},
			act("labels", `{"label_ids":["l1"]}`, `{"label_ids":["l1","l2"]}`), never, true},
		{"label removed wanted", &v1.RuleTrigger{Kind: &v1.RuleTrigger_LabelChanged_{LabelChanged: &v1.RuleTrigger_LabelChanged{LabelId: "l1"}}},
			act("labels", `{"label_ids":["l1"]}`, `{"label_ids":[]}`), never, true},
		{"other label", &v1.RuleTrigger{Kind: &v1.RuleTrigger_LabelChanged_{LabelChanged: &v1.RuleTrigger_LabelChanged{LabelId: "l9", Added: true}}},
			act("labels", `{"label_ids":["l1"]}`, `{"label_ids":["l1","l2"]}`), never, false},
		{"priority any", &v1.RuleTrigger{Kind: &v1.RuleTrigger_PriorityChanged_{PriorityChanged: &v1.RuleTrigger_PriorityChanged{}}},
			act("priority", `{"priority":0}`, `{"priority":4}`), never, true},
		{"priority urgent", &v1.RuleTrigger{Kind: &v1.RuleTrigger_PriorityChanged_{PriorityChanged: &v1.RuleTrigger_PriorityChanged{ToPriority: prio(v1.TaskPriority_TASK_PRIORITY_URGENT)}}},
			act("priority", `{"priority":0}`, `{"priority":4}`), never, true},
		{"priority to none", &v1.RuleTrigger{Kind: &v1.RuleTrigger_PriorityChanged_{PriorityChanged: &v1.RuleTrigger_PriorityChanged{ToPriority: prio(v1.TaskPriority_TASK_PRIORITY_NONE)}}},
			act("priority", `{"priority":0}`, `{"priority":4}`), never, false},
		{"checklist completed", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ChecklistCompleted_{ChecklistCompleted: &v1.RuleTrigger_ChecklistCompleted{}}},
			act("checklist", "", `{"action":"item_done"}`), yes, true},
		{"checklist not complete", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ChecklistCompleted_{ChecklistCompleted: &v1.RuleTrigger_ChecklistCompleted{}}},
			act("checklist", "", `{"action":"item_done"}`), no, false},
		{"checklist undone", &v1.RuleTrigger{Kind: &v1.RuleTrigger_ChecklistCompleted_{ChecklistCompleted: &v1.RuleTrigger_ChecklistCompleted{}}},
			act("checklist", "", `{"action":"item_undone"}`), yes, false},
		{"comment", &v1.RuleTrigger{Kind: &v1.RuleTrigger_CommentCreated_{CommentCreated: &v1.RuleTrigger_CommentCreated{}}},
			ruleEvent{kind: kindComment}, never, true},
		{"git merged", &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{Event: v1.RuleGitEvent_RULE_GIT_EVENT_PR_MERGED}}},
			act("git", "", `{"event":"PR_MERGED"}`), never, true},
		{"git any", &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{}}}, act("git", "", `{"event":"COMMIT_PUSHED"}`), never, true},
		{"git edited (no event)", &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{}}}, act("git", "", `{"event":""}`), never, false},
		{"git other", &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{Event: v1.RuleGitEvent_RULE_GIT_EVENT_PR_OPENED}}},
			act("git", "", `{"event":"PR_MERGED"}`), never, false},
		{"scheduled never by a change", &v1.RuleTrigger{Kind: &v1.RuleTrigger_Overdue_{Overdue: &v1.RuleTrigger_Overdue{}}}, status, never, false},
		{"no trigger", &v1.RuleTrigger{}, status, never, false},
	}
	for _, c := range cases {
		if got := matchTrigger(c.trigger, c.ev, c.complete); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRenderTemplate(t *testing.T) {
	vars := map[string]string{"key": "FNG-12", "title": "Отчёт", "actor": "Анна", "url": "https://x/t/FNG-12", "due": ""}
	cases := map[string]string{
		"{key}: {title}":           "FNG-12: Отчёт",
		"{actor} → {url}":          "Анна → https://x/t/FNG-12",
		"{unknown} {key}":          "{unknown} FNG-12",
		"срок: {due}.":             "срок: .",
		"{{key}}":                  "{FNG-12}",
		"no vars":                  "no vars",
		"{KEY} is case-sensitive.": "{KEY} is case-sensitive.",
	}
	for tpl, want := range cases {
		if got := renderTemplate(tpl, vars); got != want {
			t.Errorf("%q: %q, want %q", tpl, got, want)
		}
	}
	long := renderTemplate("{title}", map[string]string{"title": string(make([]rune, 3000))})
	if n := len([]rune(long)); n != MaxRuleTemplate {
		t.Errorf("a rendered text of %d characters", n)
	}
}

// The stored form round-trips; trigger / action kinds are the oneof names.
func TestRuleEncoding(t *testing.T) {
	tr := &v1.RuleTrigger{Kind: &v1.RuleTrigger_DueIn_{DueIn: &v1.RuleTrigger_DueIn{Days: 3}}}
	cond := &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_PRIORITY, Op: v1.TaskOp_TASK_OP_IS, Values: []string{"4"}}}}
	acts := []*v1.RuleAction{
		{Kind: &v1.RuleAction_SetStatus_{SetStatus: &v1.RuleAction_SetStatus{StatusId: uuid.NewString()}}},
		{Kind: &v1.RuleAction_NotifyDm_{NotifyDm: &v1.RuleAction_NotifyDm{To: v1.RuleRecipients_RULE_RECIPIENTS_LEAD, Template: "{key}"}}},
		{Kind: &v1.RuleAction_Archive_{Archive: &v1.RuleAction_Archive{}}},
	}
	tb, err := encodeTrigger(tr)
	if err != nil {
		t.Fatal(err)
	}
	cb, err := encodeCondition(cond)
	if err != nil {
		t.Fatal(err)
	}
	ab, err := encodeActions(acts)
	if err != nil {
		t.Fatal(err)
	}
	r, err := decodeRule(sqlc.BoardRule{Trigger: tb, Condition: cb, Actions: ab})
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(r.trigger, tr) || !proto.Equal(r.cond, cond) || len(r.actions) != 3 || !proto.Equal(r.actions[1], acts[1]) {
		t.Fatalf("round trip: %v %v %v", r.trigger, r.cond, r.actions)
	}
	if TriggerKind(tr) != "due_in" || !scheduled(TriggerKind(tr)) || ActionKind(acts[1]) != "notify_dm" || ActionKind(&v1.RuleAction{}) != "" {
		t.Fatalf("kinds: %s %s", TriggerKind(tr), ActionKind(acts[1]))
	}
	if b, _ := encodeCondition(&v1.TaskFilter{}); b != nil {
		t.Fatalf("an empty condition is stored: %s", b)
	}
}
