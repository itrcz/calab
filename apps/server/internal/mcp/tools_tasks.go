package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// The task tools of ADR-0156 (list_tasks, update_task, assign): like the others, each is a few
// REST calls with the caller's token; names (statuses, labels, people) are resolved here so the
// model never has to look ids up first.

// ---- list_tasks ----

func listTasks(ctx context.Context, c *api, a args) (any, error) {
	limit := clamp(a.Limit, 20, 50)
	if strings.TrimSpace(a.Board) == "" && strings.TrimSpace(a.Workspace) == "" {
		if !a.Mine {
			return nil, errors.New("give board, workspace or mine=true")
		}
		// The API pages by 200 with a keyset cursor «<updated_at>_<id>» of the last task shown, so
		// a page cut to limit continues right after its last task even if the list changed.
		qs := url.Values{"scope": {"assigned"}, "open": {"1"}}
		if a.Cursor != "" {
			qs.Set("cursor", a.Cursor)
		}
		var r v1.MyTasksResponse
		if err := c.call(ctx, http.MethodGet, "/api/me/tasks", qs, nil, &r); err != nil {
			return nil, err
		}
		tasks, next := r.GetTasks(), r.GetNextCursor()
		if len(tasks) > limit {
			tasks = tasks[:limit]
			last := tasks[len(tasks)-1]
			next = last.GetUpdatedAt().AsTime().UTC().Format(time.RFC3339Nano) + "_" + last.GetId()
		}
		return taskList(ctx, c, tasks, next)
	}
	var board *v1.Board
	ws := strings.TrimSpace(a.Workspace)
	if strings.TrimSpace(a.Board) != "" {
		b, err := resolveBoard(ctx, c, a.Board, ws)
		if err != nil {
			return nil, err
		}
		board, ws = b, b.GetWorkspaceId()
	}
	var conds []*v1.TaskCondition
	if a.Mine && strings.TrimSpace(a.Assignee) == "" {
		a.Assignee = "me"
	}
	if s := strings.TrimSpace(a.Status); s != "" {
		if board == nil {
			return nil, errors.New("status needs board")
		}
		var ids []string
		for _, name := range strings.Split(s, ",") {
			id, err := statusID(board, name)
			if err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		conds = append(conds, &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_STATUS, Op: v1.TaskOp_TASK_OP_ANY_OF, Values: ids})
	}
	if s := strings.TrimSpace(a.Assignee); s != "" {
		id := "me" // the filter's own «me»: the caller, or the person the bot acts for
		if !strings.EqualFold(s, "me") {
			var err error
			if id, err = resolveUser(ctx, c, ws, s); err != nil {
				return nil, err
			}
		}
		conds = append(conds, &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_ASSIGNEE, Op: v1.TaskOp_TASK_OP_ANY_OF, Values: []string{id}})
	}
	if len(a.Labels) > 0 {
		if board == nil {
			return nil, errors.New("labels need board")
		}
		ids, err := labelIDs(board, a.Labels)
		if err != nil {
			return nil, err
		}
		conds = append(conds, &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_LABEL, Op: v1.TaskOp_TASK_OP_ANY_OF, Values: ids})
	}
	state := a.State
	switch state {
	case "":
		state = "open"
	case "open", "done", "all":
	default:
		return nil, errors.New("state must be open, done or all")
	}
	qs := url.Values{"state": {state}, "limit": {strconv.Itoa(limit)}} // no sort: the server's -updated, or relevance with q
	if q := strings.TrimSpace(a.Q); q != "" {
		qs.Set("q", q)
	}
	if a.Sort != "" {
		qs.Set("sort", a.Sort)
	}
	if board != nil {
		qs.Set("board_id", board.GetId())
	}
	if len(conds) > 0 {
		f, err := marshal.Marshal(&v1.TaskFilter{Conditions: conds})
		if err != nil {
			return nil, err
		}
		qs.Set("filter", string(f))
	}
	if a.Cursor != "" {
		qs.Set("cursor", a.Cursor)
	}
	var r v1.SearchTasksResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/tasks/search", qs, nil, &r); err != nil {
		return nil, err
	}
	tasks := r.GetTasks()
	// The task whose key q spells, whatever its state (done, archived): first — on the first page,
	// without other filters (the server looks it up regardless of them), on the board asked for.
	if k := r.GetKeyTask(); k != nil && a.Cursor == "" && len(conds) == 0 && (board == nil || k.GetBoardId() == board.GetId()) {
		tasks = append([]*v1.Task{k}, slices.DeleteFunc(slices.Clone(tasks), func(t *v1.Task) bool { return t.GetId() == k.GetId() })...)
	}
	return taskList(ctx, c, tasks, r.GetNextCursor())
}

// taskList is a compact list of tasks with their status names (boards read once each).
func taskList(ctx context.Context, c *api, tasks []*v1.Task, next string) (any, error) {
	boards := map[string]*v1.Board{}
	list := make([]map[string]any, 0, len(tasks))
	for _, t := range tasks {
		b, ok := boards[t.GetBoardId()]
		if !ok {
			// A board that cannot be read (a limit, a refusal) only loses its names: ids stay.
			b, _ = loadBoard(ctx, c, t.GetBoardId())
			if b == nil {
				b = &v1.Board{Id: t.GetBoardId()}
			}
			boards[t.GetBoardId()] = b
		}
		var assignees []string
		for _, x := range t.GetAssignees() {
			assignees = append(assignees, x.GetUserId())
		}
		list = append(list, compact(map[string]any{"id": t.GetId(), "key": t.GetKey(), "title": t.GetTitle(),
			"status": statusName(b, t.GetStatusId()), "priority": enum(t.GetPriority().String(), "TASK_PRIORITY_"),
			"assignees": assignees, "labels": labelNames(b, t.GetLabelIds()), "due": t.GetDueOn(), "updated": ts(t.GetUpdatedAt())}))
	}
	if len(list) == 0 {
		return compact(map[string]any{"found": 0, "next": next}), nil
	}
	return compact(map[string]any{"tasks": list, "next": next}), nil
}

// resolveBoard finds a board by id, or by key in workspace ws (empty: the caller's workspaces).
// A key is unique only within a workspace: the same key in two of them is an error naming them,
// never a guess (a write must not land in another workspace).
func resolveBoard(ctx context.Context, c *api, ref, ws string) (*v1.Board, error) {
	ref = strings.TrimSpace(ref)
	if _, err := uuid.Parse(ref); err == nil {
		return loadBoard(ctx, c, ref)
	}
	wss, err := workspaceIDs(ctx, c, ws)
	if err != nil {
		return nil, err
	}
	var found []*v1.Board
	for _, w := range wss {
		var r v1.ListBoardsResponse
		if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(w)+"/boards", nil, nil, &r); err != nil {
			// a workspace without boards for the caller (403), or one the bot is not in on behalf (404)
			var ae *apiError
			if errors.As(err, &ae) && (ae.status == http.StatusForbidden || ae.status == http.StatusNotFound) {
				continue
			}
			return nil, err
		}
		for _, b := range r.GetBoards() {
			if strings.EqualFold(b.GetKey(), ref) {
				found = append(found, b)
			}
		}
	}
	switch len(found) {
	case 0:
		return nil, errors.New("no board " + strconv.Quote(ref))
	case 1:
		return loadBoard(ctx, c, found[0].GetId()) // the list has no statuses and labels
	}
	names := make([]string, 0, len(found))
	for _, b := range found {
		names = append(names, b.GetName()+" (board "+b.GetId()+", workspace "+b.GetWorkspaceId()+")")
	}
	return nil, errors.New("board key " + strconv.Quote(ref) + " is in several workspaces, give board id or workspace: " + strings.Join(names, ", "))
}

// resolveUser turns me, a user id, a nickname or a display name into a user id of workspace ws.
func resolveUser(ctx context.Context, c *api, ws, ref string) (string, error) {
	ref = strings.TrimPrefix(strings.TrimSpace(ref), "@")
	if strings.EqualFold(ref, "me") {
		var r v1.GetMemberResponse
		if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/members/@me", nil, nil, &r); err != nil {
			return "", err
		}
		return r.GetMember().GetUser().GetId(), nil
	}
	if _, err := uuid.Parse(ref); err == nil {
		return ref, nil
	}
	var r v1.ListMembersResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/members", nil, nil, &r); err != nil {
		return "", err
	}
	low := strings.ToLower(ref)
	var exact, partial []*v1.WorkspaceMember
	for _, m := range r.GetMembers() {
		name, nick := strings.ToLower(m.GetUser().GetDisplayName()), strings.ToLower(m.GetNickname())
		switch {
		case name == low || nick == low:
			exact = append(exact, m)
		case strings.Contains(name, low) || strings.Contains(nick, low):
			partial = append(partial, m)
		}
	}
	found := exact
	if len(found) == 0 {
		found = partial
	}
	switch len(found) {
	case 1:
		return found[0].GetUser().GetId(), nil
	case 0:
		return "", errors.New("no member " + strconv.Quote(ref))
	}
	names := make([]string, 0, min(len(found), 10))
	for _, m := range found[:min(len(found), 10)] {
		names = append(names, m.GetUser().GetDisplayName()+" ("+m.GetUser().GetId()+")")
	}
	return "", errors.New("several members match " + strconv.Quote(ref) + ": " + strings.Join(names, ", "))
}

// labelIDs resolves label names (or ids) of the board, case-insensitive.
func labelIDs(b *v1.Board, refs []string) ([]string, error) {
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		id := ""
		for _, l := range b.GetLabels() {
			if l.GetId() == ref || strings.EqualFold(l.GetName(), ref) {
				id = l.GetId()
				break
			}
		}
		if id == "" {
			names := make([]string, 0, len(b.GetLabels()))
			for _, l := range b.GetLabels() {
				names = append(names, l.GetName())
			}
			return nil, errors.New("no label " + strconv.Quote(ref) + "; labels: " + strings.Join(names, ", "))
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

func labelNames(b *v1.Board, ids []string) []string {
	var out []string
	for _, id := range ids {
		name := id
		for _, l := range b.GetLabels() {
			if l.GetId() == id {
				name = l.GetName()
				break
			}
		}
		out = append(out, name)
	}
	return out
}

// ---- update_task ----

var priorities = map[string]v1.TaskPriority{
	"none": v1.TaskPriority_TASK_PRIORITY_NONE, "low": v1.TaskPriority_TASK_PRIORITY_LOW,
	"medium": v1.TaskPriority_TASK_PRIORITY_MEDIUM, "high": v1.TaskPriority_TASK_PRIORITY_HIGH,
	"urgent": v1.TaskPriority_TASK_PRIORITY_URGENT,
}

func updateTask(ctx context.Context, c *api, a args) (any, error) {
	if err := need("task", a.Task); err != nil {
		return nil, err
	}
	tr, board, err := loadTask(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	t := tr.GetTask()
	req := &v1.UpdateTaskRequest{}
	changed := false
	if a.Title != "" {
		req.Title, changed = &a.Title, true
	}
	if a.Description != nil {
		req.Description, changed = a.Description, true
	}
	if a.Priority != "" {
		p, ok := priorities[strings.ToLower(a.Priority)]
		if !ok {
			return nil, errors.New("priority must be none, low, medium, high or urgent")
		}
		req.Priority, changed = &p, true
	}
	if a.Due != nil {
		d := strings.TrimSpace(*a.Due)
		req.DueOn, changed = &d, true
	}
	if a.Start != nil {
		d := strings.TrimSpace(*a.Start)
		req.StartOn, changed = &d, true
	}
	if a.Estimate != nil {
		if *a.Estimate < 0 {
			return nil, errors.New("estimate must be 0 or more")
		}
		e := uint32(*a.Estimate) //nolint:gosec // checked above
		req.Estimate, changed = &e, true
	}
	if a.Parent != nil {
		p := ""
		if ref := strings.TrimSpace(*a.Parent); ref != "" {
			ws := a.Workspace
			if ws == "" {
				ws = t.GetWorkspaceId() // a parent lives in the task's own workspace
			}
			pt, err := taskByRef(ctx, c, ref, ws)
			if err != nil {
				return nil, err
			}
			p = pt.GetTask().GetId()
		}
		req.ParentId, changed = &p, true
	}
	if a.Labels != nil || len(a.AddLabels) > 0 || len(a.RemoveLabels) > 0 {
		set := slices.Clone(t.GetLabelIds())
		if a.Labels != nil {
			if set, err = labelIDs(board, a.Labels); err != nil {
				return nil, err
			}
		}
		add, err := labelIDs(board, a.AddLabels)
		if err != nil {
			return nil, err
		}
		del, err := labelIDs(board, a.RemoveLabels)
		if err != nil {
			return nil, err
		}
		for _, id := range add {
			if !slices.Contains(set, id) {
				set = append(set, id)
			}
		}
		set = slices.DeleteFunc(set, func(id string) bool { return slices.Contains(del, id) })
		req.SetLabels, req.LabelIds, changed = true, set, true
	}
	if !changed {
		return nil, errors.New("nothing to change: give title, description, priority, due, start, estimate, parent or labels")
	}
	var out v1.TaskResponse
	if err := c.call(ctx, http.MethodPatch, "/api/tasks/"+seg(t.GetId()), nil, req, &out); err != nil {
		return nil, err
	}
	n := out.GetTask()
	return where(map[string]any{"key": n.GetKey(), "title": n.GetTitle(), "status": statusName(board, n.GetStatusId()),
		"priority": enum(n.GetPriority().String(), "TASK_PRIORITY_"), "labels": labelNames(board, n.GetLabelIds()),
		"due": n.GetDueOn(), "start": n.GetStartOn(), "parent": n.GetParentId()}, n, board), nil
}

// ---- assign ----

func assign(ctx context.Context, c *api, a args) (any, error) {
	if err := need("task", a.Task); err != nil {
		return nil, err
	}
	if len(a.Users) == 0 {
		return nil, errors.New("users is required")
	}
	mode := a.Mode
	if mode == "" {
		mode = "add"
	}
	if mode != "add" && mode != "remove" && mode != "set" {
		return nil, errors.New("mode must be add, remove or set")
	}
	tr, err := taskByRef(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	t := tr.GetTask()
	ws := t.GetWorkspaceId()
	users := make([]string, 0, len(a.Users))
	for _, u := range a.Users {
		id, err := resolveUser(ctx, c, ws, u)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(users, id) {
			users = append(users, id)
		}
	}
	// The current list keeps its notes and its lead unless changed.
	var list []*v1.TaskAssigneeInput
	if mode != "set" {
		for _, x := range t.GetAssignees() {
			list = append(list, &v1.TaskAssigneeInput{UserId: x.GetUserId(), IsLead: x.GetIsLead(), Note: x.GetNote()})
		}
	} else {
		for _, x := range t.GetAssignees() {
			if slices.Contains(users, x.GetUserId()) {
				list = append(list, &v1.TaskAssigneeInput{UserId: x.GetUserId(), IsLead: x.GetIsLead(), Note: x.GetNote()})
			}
		}
	}
	has := func(id string) bool {
		return slices.ContainsFunc(list, func(x *v1.TaskAssigneeInput) bool { return x.GetUserId() == id })
	}
	switch mode {
	case "add", "set":
		for _, id := range users {
			if !has(id) {
				list = append(list, &v1.TaskAssigneeInput{UserId: id})
			}
		}
	case "remove":
		list = slices.DeleteFunc(list, func(x *v1.TaskAssigneeInput) bool { return slices.Contains(users, x.GetUserId()) })
	}
	lead := ""
	if strings.TrimSpace(a.Lead) != "" {
		if lead, err = resolveUser(ctx, c, ws, a.Lead); err != nil {
			return nil, err
		}
		if !has(lead) {
			return nil, errors.New("the lead must be one of the assignees")
		}
	} else if i := slices.IndexFunc(list, func(x *v1.TaskAssigneeInput) bool { return x.GetIsLead() }); i >= 0 {
		lead = list[i].GetUserId()
	} else if len(list) > 0 {
		lead = list[0].GetUserId()
	}
	for _, x := range list {
		x.IsLead = x.GetUserId() == lead
	}
	// Nothing changes (already assigned, removing someone who is not): no PUT, no journal entry.
	same := len(list) == len(t.GetAssignees())
	for i := 0; same && i < len(list); i++ {
		cur := t.GetAssignees()[i]
		same = list[i].GetUserId() == cur.GetUserId() && list[i].GetIsLead() == cur.GetIsLead()
	}
	if same {
		var now []string
		for _, x := range list {
			now = append(now, x.GetUserId())
		}
		return compact(map[string]any{"key": t.GetKey(), "assignees": now, "lead": lead, "unchanged": true}), nil
	}
	var out v1.TaskResponse
	if err := c.call(ctx, http.MethodPut, "/api/tasks/"+seg(t.GetId())+"/assignees", nil, &v1.SetAssigneesRequest{Assignees: list}, &out); err != nil {
		return nil, err
	}
	var now []string
	for _, x := range out.GetTask().GetAssignees() {
		now = append(now, x.GetUserId())
	}
	return where(map[string]any{"key": out.GetTask().GetKey(), "assignees": now, "lead": lead}, out.GetTask(), tr.GetBoard()), nil
}

// ---- read: Git and releases ----

// gitLinks is the compact Git section of a task (ADR-0060 §4): pull requests and branches with
// their state; commits only counted (a task may have dozens).
func gitLinks(t *v1.Task) map[string]any {
	var prs, branches []map[string]any
	commits := 0
	for _, l := range t.GetGitLinks() {
		switch l.GetKind() {
		case v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_PR:
			sep := "#" // GitHub / Gitea pull requests
			if l.GetProvider() == v1.GitProvider_GIT_PROVIDER_GITLAB {
				sep = "!" // GitLab merge requests
			}
			prs = append(prs, compact(map[string]any{"ref": l.GetRepo() + sep + l.GetRef(), "title": l.GetTitle(), "url": l.GetUrl(),
				"state": enum(l.GetState().String(), "TASK_GIT_LINK_STATE_"), "author": l.GetAuthor()}))
		case v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_BRANCH:
			branches = append(branches, compact(map[string]any{"name": l.GetRef(), "repo": l.GetRepo(), "url": l.GetUrl()}))
		case v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_COMMIT:
			commits++
		}
	}
	return compact(map[string]any{"prs": prs, "branches": branches, "commits": uint32(commits)}) //nolint:gosec // ≤ 50 links per task
}

func releases(t *v1.Task) []map[string]any {
	var out []map[string]any
	for _, r := range t.GetReleases() {
		out = append(out, compact(map[string]any{"name": r.GetName(), "env": r.GetEnvironment(), "url": r.GetUrl(), "at": ts(r.GetCreatedAt())}))
	}
	return out
}
