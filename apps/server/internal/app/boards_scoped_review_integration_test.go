//go:build integration

package app_test

import (
	"net/url"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestTaskScopedAccessBoundaries: the security review of ADR-0059 — nothing of the board's
// other tasks reaches a task-scoped member: relations, filters, checklists, messages of other
// task rooms, member profiles, gateway events; archive / restore of the card moves the board.
func TestTaskScopedAccessBoundaries(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Граница", Key: "BND", IsPrivate: true}, 201)
	mine := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "карточка Боба"}, 201)
	other := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "чужая"}, 201)
	third := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "третья",
		Assignees: []*v1.TaskAssigneeInput{{UserId: o.id}}}, 201)
	o.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/relations", &v1.SetTaskRelationRequest{
		Kind: v1.TaskRelationKind_TASK_RELATION_KIND_RELATES, RelatedId: other.GetId()}, nil)
	o.must(200, "PUT", "/api/tasks/"+third.GetId()+"/relations", &v1.SetTaskRelationRequest{
		Kind: v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS, RelatedId: other.GetId()}, nil)
	o.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	o.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{carol.id}}, nil)
	foreign := send(t, o, other.GetRoomId(), "чужой комментарий", uniq("f"))

	// The related task is not exposed as a task; relations to / from it cannot be changed.
	if r := getTask(t, bob, mine.GetId()); len(r.GetRelated()) != 0 || r.GetParent() != nil {
		t.Fatalf("related tasks of a scoped viewer: %v", r.GetRelated())
	}
	bob.must(422, "PUT", "/api/tasks/"+mine.GetId()+"/relations", &v1.SetTaskRelationRequest{
		Kind: v1.TaskRelationKind_TASK_RELATION_KIND_RELATES, RelatedId: third.GetId()}, nil)
	bob.must(422, "DELETE", "/api/tasks/"+mine.GetId()+"/relations?kind=relates&related_id="+url.QueryEscape(other.GetId()), nil, nil)
	// Filters only narrow the invited tasks: relation / parent / any.
	for _, f := range []*v1.TaskFilter{
		{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_RELATION, Op: v1.TaskOp_TASK_OP_NOT_EMPTY}}},
		{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_PARENT, Op: v1.TaskOp_TASK_OP_EMPTY}}},
		{Any: true, Conditions: []*v1.TaskCondition{
			{Field: v1.TaskField_TASK_FIELD_ASSIGNEE, Op: v1.TaskOp_TASK_OP_ANY_OF, Values: []string{o.id}},
			{Field: v1.TaskField_TASK_FIELD_RELATION, Op: v1.TaskOp_TASK_OP_EMPTY}}},
	} {
		if ks := taskKeys(listTasks(t, bob, priv.GetId(), f)); len(ks) > 1 || (len(ks) == 1 && !ks["BND-1"]) {
			t.Fatalf("filter %v: %v", f, ks)
		}
	}
	var upd v1.ListTasksResponse
	bob.must(200, "GET", "/api/boards/"+priv.GetId()+"/tasks?updated_after="+url.QueryEscape(time.Now().Add(-time.Hour).Format(time.RFC3339))+"&cursor=0", nil, &upd)
	if ks := taskKeys(upd.GetTasks()); len(ks) != 1 || !ks["BND-1"] {
		t.Fatalf("updated_after: %v", ks)
	}
	// A task the caller does not see is not a parent either, whatever checkParent would say.
	sub := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "подзадача", ParentId: other.GetId()}, 201)
	p := sub.GetId()
	patchTask(t, bob, mine.GetId(), &v1.UpdateTaskRequest{ParentId: &p}, 422)

	// Checklists: the assignee works on their card, a subtask from an item is a new task (403);
	// the approver only looks.
	cl := newChecklist(t, bob, mine.GetId(), "шаги", 201)
	it := newItem(t, bob, cl.GetChecklist().GetId(), "шаг", 201)
	items := it.GetChecklist().GetItems()
	bob.must(403, "POST", "/api/checklist-items/"+items[len(items)-1].GetId()+"/convert", nil, nil)
	newChecklist(t, carol, mine.GetId(), "нельзя", 403)
	carol.must(403, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: carol.id}}}, nil)

	// Messages of another task's room: no read, react, pin, forward.
	bob.must(404, "GET", "/api/rooms/"+other.GetRoomId()+"/messages/"+foreign.GetId(), nil, nil)
	bob.must(404, "PUT", "/api/messages/"+foreign.GetId()+"/reactions/"+url.PathEscape("👍"), nil, nil)
	bob.must(404, "GET", "/api/rooms/"+other.GetRoomId()+"/pins", nil, nil)
	bob.must(404, "POST", "/api/rooms/"+other.GetRoomId()+"/messages/"+foreign.GetId()+"/forward", &v1.ForwardMessageRequest{ToRoomId: room.GetId()}, nil)
	// Into their own card's room — allowed; into another's — not.
	general := send(t, bob, room.GetId(), "в карточку", uniq("g"))
	bob.must(201, "POST", "/api/rooms/"+room.GetId()+"/messages/"+general.GetId()+"/forward", &v1.ForwardMessageRequest{ToRoomId: mine.GetRoomId()}, nil)
	if code := bob.do("POST", "/api/rooms/"+room.GetId()+"/messages/"+general.GetId()+"/forward", &v1.ForwardMessageRequest{ToRoomId: other.GetRoomId()}, nil); code < 400 {
		t.Fatalf("forward into another task's room: %d", code)
	}

	// A member profile shows only the tasks the viewer sees.
	var prof v1.GetMemberResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/members/"+o.id, nil, &prof)
	if ks := taskKeys(prof.GetOpenTasks()); len(ks) != 0 {
		t.Fatalf("profile tasks of a scoped viewer: %v", ks)
	}

	// Inviting from the card: the scoped assignee may add a colleague, who then sees this card.
	bob.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}, {UserId: dave.id}}}, nil)
	dave.must(200, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	dave.must(404, "GET", "/api/tasks/"+other.GetId(), nil, nil)

	// Gateway: events of other tasks and their rooms never reach bob; his card's do.
	gb := dialGW(t)
	gb.identify(bob.token)
	title := "чужая, правка"
	patchTask(t, o, other.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	send(t, o, other.GetRoomId(), "ещё чужой", uniq("f"))
	newChecklist(t, o, other.GetId(), "чужой чек-лист", 201)
	mark := send(t, o, mine.GetRoomId(), "Бобу", uniq("m"))
	gb.wait("MESSAGE_CREATE in bob's card", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == mark.GetId() })
	gb.quiet("an event of another task", time.Second, func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetTask().GetId() == other.GetId() || e.GetTaskCreate().GetTask().GetId() == other.GetId() ||
			e.GetTaskActivity().GetActivity().GetTaskId() == other.GetId() || e.GetTaskChecklistUpdate().GetTaskId() == other.GetId() ||
			e.GetMessageCreate().GetMessage().GetRoomId() == other.GetRoomId()
	})

	// The card archived: it goes, then the board; restored: the board, then the card.
	o.must(200, "POST", "/api/tasks/"+mine.GetId()+"/archive", nil, nil)
	gb.wait("TASK_DELETE of the archived card", func(e *v1.DispatchEvent) bool { return e.GetTaskDelete().GetTaskId() == mine.GetId() })
	gb.wait("BOARD_DELETE after the archived card", func(e *v1.DispatchEvent) bool { return e.GetBoardDelete().GetBoardId() == priv.GetId() })
	bob.must(404, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	bob.must(404, "GET", "/api/rooms/"+mine.GetRoomId()+"/messages", nil, nil)
	o.must(200, "POST", "/api/tasks/"+mine.GetId()+"/restore", nil, nil)
	gb.wait("BOARD_CREATE after the restore", func(e *v1.DispatchEvent) bool { return e.GetBoardCreate().GetBoard().GetTaskScoped() })
	gb.wait("TASK_CREATE of the restored card", func(e *v1.DispatchEvent) bool { return e.GetTaskCreate().GetTask().GetId() == mine.GetId() })

	// The whole board archived: gone for bob; nothing of it is reachable.
	o.must(204, "DELETE", "/api/boards/"+priv.GetId(), nil, nil)
	gb.wait("BOARD_DELETE of the archived board", func(e *v1.DispatchEvent) bool { return e.GetBoardDelete().GetBoardId() == priv.GetId() })
	bob.must(404, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	bob.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	var my v1.MyTasksResponse
	bob.must(200, "GET", "/api/me/tasks?workspace_id="+wid, nil, &my)
	if len(my.GetTasks()) != 0 {
		t.Fatalf("my tasks of an archived board: %v", taskKeys(my.GetTasks()))
	}
}
