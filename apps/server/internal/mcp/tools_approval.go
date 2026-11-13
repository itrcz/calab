package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// CBF-188: a task's approval (the caller's own vote), checklist items and links between tasks;
// read of a task shows approvers and whose decision is pending (approval) and its links.

// ---- approve ----

var decisions = map[string]v1.TaskApprovalDecision{
	"approve": v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_APPROVE, "reject": v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_REJECT,
	"withdraw": v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_WITHDRAW,
}

// errBotVote: the vote is a person's decision (ADR-0049, ADR-0051 §5): a bot by itself never votes.
const errBotVote = "a bot cannot vote on an approval by itself: the vote is a person's. Connect through OAuth as yourself, or send Calab-On-Behalf with a bot allowed to act for you; the vote then counts as that person's"

func approve(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("task", a.Task), need("decision", a.Decision)); err != nil {
		return nil, err
	}
	d, ok := decisions[strings.ToLower(strings.TrimSpace(a.Decision))]
	if !ok {
		return nil, errors.New("decision must be approve, reject or withdraw")
	}
	reason := strings.TrimSpace(a.Reason)
	if d == v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_REJECT && reason == "" {
		return nil, errors.New("reason is required to reject")
	}
	tr, err := taskByRef(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	var out v1.TaskResponse
	if err := c.call(ctx, http.MethodPost, "/api/tasks/"+seg(tr.GetTask().GetId())+"/approval", nil,
		&v1.TaskApprovalRequest{Decision: d, Comment: reason}, &out); err != nil {
		var ae *apiError
		if errors.As(err, &ae) && ae.status == http.StatusForbidden && ae.e.GetReason() == "BOT_NOT_ALLOWED" {
			return nil, errors.New(ae.Error() + ": " + errBotVote)
		}
		return nil, err
	}
	t := out.GetTask()
	return where(map[string]any{"key": t.GetKey(), "approval": approvalInfo(t)}, t, tr.GetBoard()), nil
}

// approvalInfo is a task's approval: its state, the quorum, every approver's vote and whose
// decision is still pending; nil without approvers.
func approvalInfo(t *v1.Task) map[string]any {
	if len(t.GetApprovers()) == 0 {
		return nil
	}
	var votes []map[string]any
	var pending []string
	for _, ap := range t.GetApprovers() {
		st := enum(ap.GetState().String(), "APPROVER_STATE_")
		if ap.GetState() == v1.ApproverState_APPROVER_STATE_PENDING {
			pending = append(pending, ap.GetUserId())
		}
		votes = append(votes, compact(map[string]any{"user": ap.GetUserId(), "vote": st, "reason": ap.GetComment(), "on_behalf": ap.GetOnBehalf()}))
	}
	required := int(t.GetApprovalRequired())
	if required == 0 || required > len(votes) {
		required = len(votes)
	}
	return compact(map[string]any{"state": enum(t.GetApprovalState().String(), "TASK_APPROVAL_STATE_"), "required": required,
		"approvers": votes, "pending": pending})
}

// ---- links ----

var linkKinds = map[string]v1.TaskRelationKind{
	"blocks": v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS, "blocked_by": v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS,
	"relates": v1.TaskRelationKind_TASK_RELATION_KIND_RELATES, "duplicates": v1.TaskRelationKind_TASK_RELATION_KIND_DUPLICATES,
}

// taskLinks is a task's relations as the caller reads them: "DEV-3 blocks", "blocked by DEV-4".
func taskLinks(tr *v1.TaskResponse) []map[string]any {
	keys := map[string]string{}
	for _, r := range tr.GetRelated() {
		keys[r.GetId()] = r.GetKey()
	}
	self := tr.GetTask().GetId()
	var out []map[string]any
	for _, r := range tr.GetTask().GetRelations() {
		other, kind := r.GetRelatedId(), enum(r.GetKind().String(), "TASK_RELATION_KIND_")
		if other == self {
			other = r.GetTaskId()
			if r.GetKind() == v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS {
				kind = "blocked_by"
			}
		}
		out = append(out, compact(map[string]any{"kind": kind, "task": other, "key": keys[other]}))
	}
	return out
}

func linkTasks(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("task", a.Task), need("related", a.Related)); err != nil {
		return nil, err
	}
	kindName := strings.ToLower(strings.TrimSpace(a.Kind))
	if kindName == "" {
		kindName = "relates"
	}
	kind, ok := linkKinds[kindName]
	if !ok {
		return nil, errors.New("kind must be blocks, blocked_by, relates or duplicates")
	}
	tr, err := taskByRef(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	ws := a.Workspace
	if ws == "" {
		ws = tr.GetTask().GetWorkspaceId() // a link stays within the workspace
	}
	rel, err := taskByRef(ctx, c, a.Related, ws)
	if err != nil {
		return nil, err
	}
	from, to := tr.GetTask().GetId(), rel.GetTask().GetId()
	if kindName == "blocked_by" { // stored as the other task blocking this one
		from, to = to, from
	}
	var out v1.TaskResponse
	switch a.Mode {
	case "", "add":
		err = c.call(ctx, http.MethodPut, "/api/tasks/"+seg(from)+"/relations", nil, &v1.SetTaskRelationRequest{RelatedId: to, Kind: kind}, &out)
	case "remove":
		qs := url.Values{"related_id": {to}, "kind": {enum(kind.String(), "TASK_RELATION_KIND_")}}
		err = c.call(ctx, http.MethodDelete, "/api/tasks/"+seg(from)+"/relations", qs, nil, &out)
	default:
		return nil, errors.New("mode must be add or remove")
	}
	if err != nil {
		return nil, err
	}
	// The answer is the task the call went to; the links are shown from the task asked about.
	shown := &out
	if out.GetTask().GetId() != tr.GetTask().GetId() {
		shown = &v1.TaskResponse{}
		if err := c.call(ctx, http.MethodGet, "/api/tasks/"+seg(tr.GetTask().GetId()), nil, nil, shown); err != nil {
			return nil, err
		}
	}
	links := taskLinks(shown)
	if links == nil {
		links = []map[string]any{}
	}
	return where(map[string]any{"key": shown.GetTask().GetKey(), "links": links}, shown.GetTask(), tr.GetBoard()), nil
}

// ---- checklist ----

// checklistItem finds an item of the task by id, number (1-based, in read's order: across the
// checklists, or within checklist cl) or text (exact, else a unique part; case-insensitive).
func checklistItem(t *v1.Task, cl *v1.TaskChecklist, ref string) (*v1.TaskChecklistItem, error) {
	ref = strings.TrimSpace(ref)
	var all []*v1.TaskChecklistItem
	for _, x := range t.GetChecklists() {
		if cl == nil || x.GetId() == cl.GetId() {
			all = append(all, x.GetItems()...)
		}
	}
	if n, err := strconv.Atoi(ref); err == nil {
		if n < 1 || n > len(all) {
			return nil, errors.New("no item " + ref + "; items: " + strconv.Itoa(len(all)))
		}
		return all[n-1], nil
	}
	low := strings.ToLower(ref)
	var exact, partial []*v1.TaskChecklistItem
	for _, it := range all {
		text := strings.ToLower(it.GetText())
		switch {
		case it.GetId() == ref || text == low:
			exact = append(exact, it)
		case strings.Contains(text, low):
			partial = append(partial, it)
		}
	}
	found := exact
	if len(found) == 0 {
		found = partial
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return nil, errors.New("no checklist item " + strconv.Quote(ref))
	}
	names := make([]string, 0, len(found))
	for _, it := range found {
		names = append(names, strconv.Quote(it.GetText()))
	}
	return nil, errors.New("several items match " + strconv.Quote(ref) + ": " + strings.Join(names, ", "))
}

// findChecklist is a checklist of the task by id or title (case-insensitive); nil = none.
func findChecklist(t *v1.Task, ref string) *v1.TaskChecklist {
	ref = strings.TrimSpace(ref)
	for _, x := range t.GetChecklists() {
		if x.GetId() == ref || strings.EqualFold(x.GetTitle(), ref) {
			return x
		}
	}
	return nil
}

// defaultChecklist is the title of a checklist the tool creates for add when the task has none.
const defaultChecklist = "Чек-лист"

func checklistTool(ctx context.Context, c *api, a args) (any, error) {
	if err := need("task", a.Task); err != nil {
		return nil, err
	}
	tr, err := taskByRef(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	t := tr.GetTask()
	var cl *v1.TaskChecklist
	if strings.TrimSpace(a.Checklist) != "" {
		cl = findChecklist(t, a.Checklist)
	}
	var res v1.TaskChecklistResponse
	switch a.Action {
	case "add":
		items := a.Items
		if strings.TrimSpace(a.Item) != "" {
			items = append([]string{a.Item}, items...)
		}
		if len(items) == 0 {
			return nil, errors.New("item or items is required")
		}
		if cl == nil && strings.TrimSpace(a.Checklist) == "" && len(t.GetChecklists()) > 0 {
			cl = t.GetChecklists()[0]
		}
		if cl == nil { // a new checklist, titled as asked
			title := strings.TrimSpace(a.Checklist)
			if title == "" {
				title = defaultChecklist
			}
			var nc v1.TaskChecklistResponse
			if err := c.call(ctx, http.MethodPost, "/api/tasks/"+seg(t.GetId())+"/checklists", nil, &v1.CreateTaskChecklistRequest{Title: title}, &nc); err != nil {
				return nil, err
			}
			cl = nc.GetChecklist()
		}
		for _, text := range items {
			if err := c.call(ctx, http.MethodPost, "/api/checklists/"+seg(cl.GetId())+"/items", nil, &v1.CreateTaskChecklistItemRequest{Text: text}, &res); err != nil {
				return nil, err
			}
		}
	case "", "check", "uncheck", "toggle":
		if err := need("item", a.Item); err != nil {
			return nil, err
		}
		if strings.TrimSpace(a.Checklist) != "" && cl == nil {
			return nil, errors.New("no checklist " + strconv.Quote(a.Checklist))
		}
		it, err := checklistItem(t, cl, a.Item)
		if err != nil {
			return nil, err
		}
		done := a.Action != "uncheck"
		if a.Action == "toggle" {
			done = !it.GetDone()
		}
		if err := c.call(ctx, http.MethodPatch, "/api/checklist-items/"+seg(it.GetId()), nil, &v1.UpdateTaskChecklistItemRequest{Done: &done}, &res); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("action must be check, uncheck, toggle or add")
	}
	ch := res.GetChecklist()
	items := make([]string, 0, len(ch.GetItems()))
	for _, it := range ch.GetItems() {
		mark := "[ ] "
		if it.GetDone() {
			mark = "[x] "
		}
		items = append(items, mark+it.GetText())
	}
	return where(map[string]any{"key": t.GetKey(), "checklist": ch.GetTitle(), "items": items,
		"done": strconv.Itoa(int(res.GetChecklistDone())) + "/" + strconv.Itoa(int(res.GetChecklistTotal()))}, t, tr.GetBoard()), nil
}
