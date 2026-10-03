//go:build integration

package app_test

import (
	"net/url"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestTaskScopedAccess: an assignee / approver from outside a board sees the board through
// their own tasks only (ADR-0059): lists, tasks, comments, votes, search, unfurl, READY, the
// gateway transitions; restricted boards, guests and bots stay out.
func TestTaskScopedAccess(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Скоуп", Key: "SCP", IsPrivate: true}, 201)
	mine := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "карточка Боба"}, 201)
	other := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "чужая карточка"}, 201)
	bob.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)

	gb := dialGW(t)
	gb.identify(bob.token)

	// Assigned from outside: the board appears (task_scoped, no bits), then the task; ASSIGNED.
	o.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	boardAt, taskAt, assigned, n := -1, -1, false, 0
	deadline := time.Now().Add(5 * time.Second)
	for (boardAt < 0 || taskAt < 0 || !assigned) && time.Now().Before(deadline) {
		f, err := gb.read(time.Until(deadline))
		if err != nil {
			t.Fatalf("gateway: %v", err)
		}
		e := f.GetDispatch()
		if e == nil {
			continue
		}
		n++
		if b := e.GetBoardCreate().GetBoard(); b.GetId() == priv.GetId() {
			if !b.GetTaskScoped() || b.GetPermissions() != 0 || len(b.GetPermissionOverrides()) != 0 {
				t.Fatalf("scoped BOARD_CREATE %v", b)
			}
			boardAt = n
		}
		if e.GetTaskCreate().GetTask().GetId() == mine.GetId() {
			taskAt = n
		}
		if e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED {
			assigned = true
		}
	}
	if boardAt < 0 || taskAt < boardAt || !assigned {
		t.Fatalf("gateway: BOARD_CREATE at %d, TASK_CREATE at %d, ASSIGNED %v", boardAt, taskAt, assigned)
	}

	// REST: the board in its scoped form, only bob's task, nothing else of the board.
	lb := listBoards(t, bob, wid)[priv.GetId()]
	if lb == nil || !lb.GetTaskScoped() || lb.GetPermissions() != 0 || len(lb.GetPermissionOverrides()) != 0 || len(lb.GetStatuses()) == 0 {
		t.Fatalf("listed board %v", lb)
	}
	var gbr v1.BoardResponse
	bob.must(200, "GET", "/api/boards/"+priv.GetId(), nil, &gbr)
	if !gbr.GetBoard().GetTaskScoped() {
		t.Fatal("GET board: not task-scoped")
	}
	if ks := taskKeys(listTasks(t, bob, priv.GetId(), nil)); len(ks) != 1 || !ks["SCP-1"] {
		t.Fatalf("scoped tasks %v", ks)
	}
	var arch v1.ListTasksResponse
	bob.must(200, "GET", "/api/boards/"+priv.GetId()+"/tasks?archived=1", nil, &arch)
	if len(arch.GetTasks()) != 0 {
		t.Fatal("archived tasks of a scoped board")
	}
	bob.must(404, "GET", "/api/tasks/"+other.GetId(), nil, nil)
	bob.must(404, "GET", "/api/rooms/"+other.GetRoomId()+"/messages", nil, nil)
	bob.must(404, "GET", "/api/t/SCP-2", nil, nil)
	bob.must(200, "GET", "/api/t/SCP-1", nil, nil)
	createTask(t, bob, priv.GetId(), &v1.CreateTaskRequest{Title: "нельзя"}, 403)
	bob.must(403, "POST", "/api/boards/"+priv.GetId()+"/views", &v1.CreateBoardViewRequest{Name: "мой"}, nil)
	bob.must(403, "GET", "/api/boards/"+priv.GetId()+"/activity", nil, nil)
	bob.must(403, "GET", "/api/boards/"+priv.GetId()+"/permissions", nil, nil)
	bob.must(403, "POST", "/api/boards/"+priv.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "нет"}, nil)
	bob.must(200, "GET", "/api/boards/"+priv.GetId()+"/views", nil, nil)
	// Works on the card like an assignee: edit, comment; no subtask (a new task of the board).
	title := "Боб правит"
	patchTask(t, bob, mine.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	send(t, bob, mine.GetRoomId(), "комментарий", uniq("s"))
	parent := other.GetId()
	patchTask(t, bob, mine.GetId(), &v1.UpdateTaskRequest{ParentId: &parent}, 422)
	if r := getTask(t, bob, mine.GetId()); r.GetRoom() == nil {
		t.Fatal("task response without its room")
	}

	// «Мои задачи», search, unfurl, READY.
	var my v1.MyTasksResponse
	bob.must(200, "GET", "/api/me/tasks?workspace_id="+wid, nil, &my)
	if ks := taskKeys(my.GetTasks()); !ks["SCP-1"] || ks["SCP-2"] {
		t.Fatalf("my tasks %v", ks)
	}
	var found v1.SearchTasksResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?q=SCP", nil, &found)
	if ks := taskKeys(found.GetTasks()); len(ks) != 1 || !ks["SCP-1"] {
		t.Fatalf("search %v", ks)
	}
	var uf v1.UnfurlResponse
	bob.must(200, "GET", "/api/unfurl?url="+url.QueryEscape("https://app.example.com/t/SCP-1"), nil, &uf)
	if uf.GetTask().GetId() != mine.GetId() || !uf.GetBoard().GetTaskScoped() {
		t.Fatalf("unfurl %v", &uf)
	}
	bob.must(404, "GET", "/api/unfurl?url="+url.QueryEscape("https://app.example.com/t/SCP-2"), nil, nil)
	bob.must(200, "GET", "/api/unfurl?url="+url.QueryEscape("https://app.example.com/b/"+priv.GetId()), nil, nil)
	scopedInReady := false
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
		for _, b := range s.GetBoards() {
			scopedInReady = scopedInReady || (b.GetId() == priv.GetId() && b.GetTaskScoped() && b.GetPermissions() == 0)
		}
	}
	if !scopedInReady {
		t.Fatal("READY lacks the scoped board")
	}
	gb = dialGW(t) // the READY session above replaced the first one
	gb.identify(bob.token)

	// An approver from outside: views, votes, cannot edit.
	o.must(200, "PUT", "/api/tasks/"+other.GetId()+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{carol.id}}, nil)
	carol.must(200, "GET", "/api/tasks/"+other.GetId(), nil, nil)
	carol.must(404, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	patchTask(t, carol, other.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	send(t, carol, other.GetRoomId(), "смотрю", uniq("s"))
	carol.must(200, "POST", "/api/tasks/"+other.GetId()+"/approval", &v1.TaskApprovalRequest{Decision: v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_APPROVE}, nil)

	// Removed: the task and then the board go away.
	o.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{}, nil)
	gb.wait("TASK_DELETE of the removed card", func(e *v1.DispatchEvent) bool {
		return e.GetTaskDelete().GetTaskId() == mine.GetId() && !e.GetTaskDelete().GetPurged()
	})
	gb.wait("BOARD_DELETE of the last card's board", func(e *v1.DispatchEvent) bool {
		return e.GetBoardDelete().GetBoardId() == priv.GetId()
	})
	bob.must(404, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	bob.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	if _, ok := listBoards(t, bob, wid)[priv.GetId()]; ok {
		t.Fatal("board listed after the last card")
	}

	// Guests and bots without VIEW_BOARD are refused (422), as before.
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.65.9.1"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	o.must(422, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: gj.GetMe().GetUser().GetId()}}}, nil)
	o.must(422, "PUT", "/api/tasks/"+mine.GetId()+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{gj.GetMe().GetUser().GetId()}}, nil)
	bt := createBot(t, o, wid, "scopebot")
	o.must(422, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bt.id}}}, nil)

	// A restricted board: closed means closed — the scoped approver loses it, no new invitations.
	restricted := true
	o.must(200, "PATCH", "/api/boards/"+priv.GetId(), &v1.UpdateBoardRequest{Restricted: &restricted}, nil)
	carol.must(404, "GET", "/api/tasks/"+other.GetId(), nil, nil)
	if _, ok := listBoards(t, carol, wid)[priv.GetId()]; ok {
		t.Fatal("restricted board listed for its scoped approver")
	}
	o.must(422, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
}
