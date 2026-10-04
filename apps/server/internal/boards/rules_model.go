package boards

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Board automation rules (ADR-0060): the stored form, trigger matching over task journal
// entries and message templates. The engine is rules_engine.go, actions rules_actions.go, the
// API rules_api.go.

// Rule limits and reasons.
const (
	MaxRules          = 20 // per board
	MaxRuleName       = 60
	MaxRuleActions    = 5
	MaxRuleTemplate   = 2000
	MaxRuleSubtasks   = 10
	MaxRuleDueDays    = 365
	MaxRuleTriggerDay = 30 // due_in / overdue
	MaxRuleStaleDays  = 90
	// MaxRuleDepth: rule changes trigger rules again up to this depth (ADR-0060 §2).
	MaxRuleDepth = 3
	// ReasonRuleLimit: the 21st rule of a board (409).
	ReasonRuleLimit = "RULE_LIMIT"
	// RuleLoop: the run error of a rule repeated in a chain or a chain deeper than MaxRuleDepth.
	RuleLoop = "RULE_LOOP"
)

// kindComment is the synthetic trigger of a posted comment (comments are messages, not journal
// entries).
const kindComment = "comment"

// ruleRef names the rule that makes a change (change.rule).
type ruleRef struct {
	id   uuid.UUID
	name string
}

// rule is a stored rule decoded.
type rule struct {
	row     sqlc.BoardRule
	trigger *v1.RuleTrigger
	cond    *v1.TaskFilter // nil = always
	actions []*v1.RuleAction
}

var (
	ruleWrite = protojson.MarshalOptions{UseProtoNames: true}
	ruleRead  = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// decodeRule parses the stored trigger, condition and actions.
func decodeRule(row sqlc.BoardRule) (rule, error) {
	r := rule{row: row, trigger: &v1.RuleTrigger{}}
	if err := ruleRead.Unmarshal(row.Trigger, r.trigger); err != nil {
		return r, err
	}
	if len(row.Condition) > 0 {
		r.cond = &v1.TaskFilter{}
		if err := ruleRead.Unmarshal(row.Condition, r.cond); err != nil {
			return r, err
		}
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(row.Actions, &raw); err != nil {
		return r, err
	}
	for _, m := range raw {
		a := &v1.RuleAction{}
		if err := ruleRead.Unmarshal(m, a); err != nil {
			return r, err
		}
		r.actions = append(r.actions, a)
	}
	return r, nil
}

// encodeTrigger / encodeCondition / encodeActions give the stored JSON.
func encodeTrigger(t *v1.RuleTrigger) ([]byte, error) { return ruleWrite.Marshal(t) }

func encodeCondition(f *v1.TaskFilter) ([]byte, error) {
	if f == nil || len(f.GetConditions()) == 0 {
		return nil, nil
	}
	return ruleWrite.Marshal(f)
}

func encodeActions(as []*v1.RuleAction) ([]byte, error) {
	raw := make([]json.RawMessage, len(as))
	for i, a := range as {
		b, err := ruleWrite.Marshal(a)
		if err != nil {
			return nil, err
		}
		raw[i] = b
	}
	return json.Marshal(raw)
}

// ruleProto converts a stored rule (an unreadable part stays unset).
func ruleProto(row sqlc.BoardRule) *v1.BoardRule {
	r, _ := decodeRule(row)
	return &v1.BoardRule{
		Id: row.ID.String(), BoardId: row.BoardID.String(), Name: row.Name, Enabled: row.Enabled, Position: row.Position,
		Trigger: r.trigger, Condition: r.cond, Actions: r.actions, CreatedBy: idp(row.CreatedBy),
		CreatedAt: timestamppb.New(row.CreatedAt), UpdatedAt: timestamppb.New(row.UpdatedAt),
		RunsCount: uint32(max(row.RunsCount, 0)), LastRunAt: tsp(row.LastRunAt), LastError: row.LastError, //nolint:gosec // a count
	}
}

func runProto(r sqlc.BoardRuleRun) *v1.RuleRun {
	return &v1.RuleRun{Id: r.ID.String(), RuleId: r.RuleID.String(), TaskId: idp(r.TaskID), TriggerKind: r.TriggerKind, Ok: r.Ok,
		Error: r.Error, ActionsApplied: uint32(max(r.ActionsApplied, 0)), CreatedAt: timestamppb.New(r.CreatedAt)} //nolint:gosec // ≤ 5
}

// oneofName is the field name of the set case of oneof "kind" ("" when none).
func oneofName(m proto.Message) string {
	r := m.ProtoReflect()
	f := r.WhichOneof(r.Descriptor().Oneofs().ByName(protoreflect.Name("kind")))
	if f == nil {
		return ""
	}
	return string(f.Name())
}

// TriggerKind is the stored trigger_kind: the RuleTrigger case ("status_changed", "due_in"…).
func TriggerKind(t *v1.RuleTrigger) string { return oneofName(t) }

// ActionKind is the RuleAction case ("set_status", "comment"…).
func ActionKind(a *v1.RuleAction) string { return oneofName(a) }

// scheduled reports a trigger of the sweeper (no journal entry fires it).
func scheduled(kind string) bool { return kind == "due_in" || kind == "overdue" || kind == "stale" }

// ---- trigger matching ----

// ruleEvent is one thing that happened to a task in a transaction: a journal entry, or a
// posted comment (kind "comment").
type ruleEvent struct {
	task, board   uuid.UUID
	kind          string
	actor         *uuid.UUID // nil: a rule, Git, the server
	before, after map[string]any
}

// eventOf reads a journal entry as a rule event.
func eventOf(a sqlc.TaskActivity) ruleEvent {
	ev := ruleEvent{task: a.TaskID, board: a.BoardID, kind: a.Kind, actor: a.ActorID}
	if len(a.Before) > 0 {
		_ = json.Unmarshal(a.Before, &ev.before)
	}
	if len(a.After) > 0 {
		_ = json.Unmarshal(a.After, &ev.after)
	}
	return ev
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func num(m map[string]any, k string) (int, bool) {
	f, ok := m[k].(float64)
	return int(f), ok
}

// people reads an assignee list of a journal entry: user ids and the lead.
func people(m map[string]any) ([]string, string) {
	list, _ := m["assignees"].([]any)
	var ids []string
	lead := ""
	for _, x := range list {
		a, _ := x.(map[string]any)
		id := str(a, "user_id")
		ids = append(ids, id)
		if b, _ := a["is_lead"].(bool); b {
			lead = id
		}
	}
	return ids, lead
}

func strList(m map[string]any, k string) []string {
	list, _ := m[k].([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// checklistCompletes: checklist actions that may finish the last open item.
var checklistCompletes = []string{"item_done", "item_removed", "converted", "deleted"}

// matchTrigger reports whether ev fires trigger t. complete reports whether every item of every
// checklist of the task is done (asked only for checklist entries).
func matchTrigger(t *v1.RuleTrigger, ev ruleEvent, complete func() bool) bool {
	switch k := t.GetKind().(type) {
	case *v1.RuleTrigger_TaskCreated_:
		return ev.kind == "created"
	case *v1.RuleTrigger_StatusChanged_:
		if ev.kind != "status" {
			return false
		}
		sc := k.StatusChanged
		if sc.GetToStatusId() != "" && sc.GetToStatusId() != str(ev.after, "status_id") {
			return false
		}
		if sc.GetFromStatusId() != "" && sc.GetFromStatusId() != str(ev.before, "status_id") {
			return false
		}
		return sc.GetToType() == v1.BoardStatusType_BOARD_STATUS_TYPE_UNSPECIFIED || StatusTypeToDB(sc.GetToType()) == str(ev.after, "status_type")
	case *v1.RuleTrigger_ApprovalChanged_:
		if ev.kind != "approval" && ev.kind != "approvers" {
			return false
		}
		got := str(ev.after, "approval_state")
		switch k.ApprovalChanged.GetState() {
		case v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED:
			return got == voteApproved
		case v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED:
			return got == voteRejected
		}
		return got != ""
	case *v1.RuleTrigger_AssigneesChanged_:
		if ev.kind != "assignees" {
			return false
		}
		was, wasLead := people(ev.before)
		now, lead := people(ev.after)
		added := slices.ContainsFunc(now, func(u string) bool { return !slices.Contains(was, u) })
		removed := slices.ContainsFunc(was, func(u string) bool { return !slices.Contains(now, u) })
		leadChanged := lead != wasLead && lead != ""
		ac := k.AssigneesChanged
		if !ac.GetAdded() && !ac.GetRemoved() && !ac.GetLead() {
			return added || removed || leadChanged
		}
		return (ac.GetAdded() && added) || (ac.GetRemoved() && removed) || (ac.GetLead() && leadChanged)
	case *v1.RuleTrigger_LabelChanged_:
		if ev.kind != "labels" {
			return false
		}
		was, now := strList(ev.before, "label_ids"), strList(ev.after, "label_ids")
		from, to := was, now
		if !k.LabelChanged.GetAdded() {
			from, to = now, was // a removal: in before, not after
		}
		for _, id := range to {
			if !slices.Contains(from, id) && (k.LabelChanged.GetLabelId() == "" || k.LabelChanged.GetLabelId() == id) {
				return true
			}
		}
		return false
	case *v1.RuleTrigger_PriorityChanged_:
		if ev.kind != "priority" {
			return false
		}
		p, _ := num(ev.after, "priority")
		return k.PriorityChanged.ToPriority == nil || int(k.PriorityChanged.GetToPriority()) == p
	case *v1.RuleTrigger_ChecklistCompleted_:
		return ev.kind == "checklist" && slices.Contains(checklistCompletes, str(ev.after, "action")) && complete()
	case *v1.RuleTrigger_CommentCreated_:
		return ev.kind == kindComment
	case *v1.RuleTrigger_Git_:
		if ev.kind != "git" || str(ev.after, "event") == "" {
			return false
		}
		want := k.Git.GetEvent()
		return want == v1.RuleGitEvent_RULE_GIT_EVENT_UNSPECIFIED || strings.TrimPrefix(want.String(), "RULE_GIT_EVENT_") == str(ev.after, "event")
	}
	return false // scheduled triggers never match a change
}

// ---- templates ----

var tplVar = regexp.MustCompile(`\{([a-z]+)\}`)

// renderTemplate replaces {name} by vars[name] (unknown names stay as written) and cuts the
// result to MaxRuleTemplate characters.
func renderTemplate(tpl string, vars map[string]string) string {
	out := tplVar.ReplaceAllStringFunc(tpl, func(m string) string {
		if v, ok := vars[m[1:len(m)-1]]; ok {
			return v
		}
		return m
	})
	if utf8.RuneCountInString(out) > MaxRuleTemplate {
		out = string([]rune(out)[:MaxRuleTemplate])
	}
	return out
}
