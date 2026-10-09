//go:build integration

package app_test

import (
	"context"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Task boards (ADR-0042).

func createBoard(t *testing.T, u musty, wsID string, req *v1.CreateBoardRequest, want int) *v1.Board {
	t.Helper()
	var r v1.BoardResponse
	u.must(want, "POST", "/api/workspaces/"+wsID+"/boards", req, &r)
	return r.GetBoard()
}

func listBoards(t *testing.T, u musty, wsID string) map[string]*v1.Board {
	t.Helper()
	var r v1.ListBoardsResponse
	u.must(200, "GET", "/api/workspaces/"+wsID+"/boards", nil, &r)
	out := map[string]*v1.Board{}
	for _, b := range r.GetBoards() {
		out[b.GetId()] = b
	}
	return out
}

func createTask(t *testing.T, u musty, boardID string, req *v1.CreateTaskRequest, want int) *v1.Task {
	t.Helper()
	var r v1.TaskResponse
	u.must(want, "POST", "/api/boards/"+boardID+"/tasks", req, &r)
	return r.GetTask()
}

func patchTask(t *testing.T, u musty, taskID string, req *v1.UpdateTaskRequest, want int) *v1.Task {
	t.Helper()
	var r v1.TaskResponse
	u.must(want, "PATCH", "/api/tasks/"+taskID, req, &r)
	return r.GetTask()
}

func getTask(t *testing.T, u musty, taskID string) *v1.TaskResponse {
	t.Helper()
	var r v1.TaskResponse
	u.must(200, "GET", "/api/tasks/"+taskID, nil, &r)
	return &r
}

func listTasks(t *testing.T, u musty, boardID string, f *v1.TaskFilter) []*v1.Task {
	t.Helper()
	path := "/api/boards/" + boardID + "/tasks"
	if f != nil {
		b, err := protojson.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		path += "?filter=" + url.QueryEscape(string(b))
	}
	var r v1.ListTasksResponse
	u.must(200, "GET", path, nil, &r)
	return r.GetTasks()
}

func taskKeys(ts []*v1.Task) map[string]bool {
	out := map[string]bool{}
	for _, t := range ts {
		out[t.GetKey()] = true
	}
	return out
}

func statusOf(b *v1.Board, typ v1.BoardStatusType) string {
	for _, s := range b.GetStatuses() {
		if s.GetType() == typ {
			return s.GetId()
		}
	}
	return ""
}

func activityKinds(t *testing.T, u musty, taskID string) []string {
	t.Helper()
	var p v1.TaskActivityPage
	u.must(200, "GET", "/api/tasks/"+taskID+"/activity?limit=100", nil, &p)
	var out []string
	for _, it := range p.GetItems() {
		if a := it.GetActivity(); a != nil {
			out = append(out, a.GetKind())
		}
	}
	return out
}

func setBoardPerms(u musty, boardID string, want int, ovs ...*v1.RoomPermissionOverride) {
	u.must(want, "PUT", "/api/boards/"+boardID+"/permissions", &v1.SetBoardPermissionsRequest{Overrides: ovs}, nil)
}

// TestBoardPermissions: every board bit, private boards, role and user overrides (a person, a
// role, a bot), guests and bots, the creator's override.
func TestBoardPermissions(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))

	// Only CREATE_BOARDS (ADR-0048) creates boards; the key is derived and unique.
	createBoard(t, bob, wid, &v1.CreateBoardRequest{Name: "Нельзя"}, 403)
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Fintech Next Gen", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	if b.GetKey() != "FNG" || len(b.GetStatuses()) != 6 || b.GetPermissions()&uint64(perm.ManageBoard) == 0 {
		t.Fatalf("created board: %v", b)
	}
	b2 := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Fintech Next Gen"}, 201)
	if b2.GetKey() != "FNG2" || len(b2.GetStatuses()) != 3 {
		t.Fatalf("second board key %q statuses %d", b2.GetKey(), len(b2.GetStatuses()))
	}
	createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Taken", Key: "FNG"}, 409)
	createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Bad", Key: "1X"}, 422)

	// A member sees a public board with VIEW_BOARD | CREATE_TASKS and may not manage it.
	if got := listBoards(t, bob, wid)[b.GetId()].GetPermissions(); got != uint64(perm.RoleDefaults[perm.RoleMember]) {
		t.Fatalf("member bits on a public board: %d", got)
	}
	name := "x"
	bob.must(403, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{Name: &name}, nil)
	bob.must(403, "POST", "/api/boards/"+b.GetId()+"/statuses", &v1.CreateBoardStatusRequest{Name: "Нет"}, nil)
	bob.must(403, "GET", "/api/boards/"+b.GetId()+"/permissions", nil, nil)
	task := createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "Задача Боба"}, 201)
	if task.GetKey() != "FNG-1" {
		t.Fatalf("first key %q", task.GetKey())
	}

	// Private board: hidden from members (404, not listed) until an override lets them in.
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Секрет", Key: "SEC", IsPrivate: true}, 201)
	if _, ok := listBoards(t, bob, wid)[priv.GetId()]; ok {
		t.Fatal("private board listed for a member")
	}
	bob.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	bob.must(404, "GET", "/api/boards/"+priv.GetId()+"/tasks", nil, nil)
	secret := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "тайна"}, 201)
	bob.must(404, "GET", "/api/tasks/"+secret.GetId(), nil, nil)
	bob.must(404, "GET", "/api/rooms/"+secret.GetRoomId()+"/messages", nil, nil)
	bob.must(404, "GET", "/api/t/SEC-1", nil, nil)

	// A user override: bob sees it; EDIT_TASKS lets him edit others' tasks.
	setBoardPerms(o, priv.GetId(), 200, userOv(bob.id, perm.ViewBoard|perm.EditTasks, 0))
	bob.must(200, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	title := "тайна раскрыта"
	patchTask(t, bob, secret.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	// Without EDIT_TASKS a member edits only own and assigned tasks.
	carolOnPub := createTask(t, carol, b.GetId(), &v1.CreateTaskRequest{Title: "carol"}, 201)
	patchTask(t, bob, carolOnPub.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	bob.must(403, "POST", "/api/tasks/"+carolOnPub.GetId()+"/archive", nil, nil)
	patchTask(t, carol, carolOnPub.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	carol.must(200, "PUT", "/api/tasks/"+carolOnPub.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	patchTask(t, bob, carolOnPub.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200) // assigned now

	// A role override on a private board: carol with the role sees it.
	team := newRole(t, o, wid, "team", 0)
	if st, _ := setMemberRoles(o, wid, carol.id, team.GetId()); st != 200 {
		t.Fatalf("set roles: %d", st)
	}
	carol.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	setBoardPerms(o, priv.GetId(), 200, userOv(bob.id, perm.ViewBoard|perm.EditTasks, 0), roleOv(team.GetId(), perm.ViewBoard, 0))
	carol.must(200, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	// The allow opens the board; her other board bits come from her roles (CREATE_TASKS of member).
	carol.must(201, "POST", "/api/boards/"+priv.GetId()+"/tasks", &v1.CreateTaskRequest{Title: "от Кэрол"}, nil)
	// Room bits cannot be set per board; a member cannot grant what they lack.
	setBoardPerms(o, priv.GetId(), 422, userOv(bob.id, perm.ViewBoard|perm.ManageRoom, 0))
	setBoardPerms(o, b.GetId(), 200, userOv(bob.id, perm.ManageBoard, 0))
	setBoardPerms(bob, b.GetId(), 403, userOv(carol.id, perm.ManageBoard|perm.EditTasks, 0))

	// Deny VIEW_BOARD for the member role hides a public board.
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	setBoardPerms(o, b2.GetId(), 200, roleOv(member.GetId(), 0, perm.ViewBoard))
	bob.must(404, "GET", "/api/boards/"+b2.GetId(), nil, nil)

	// Guests: 403 on the list, 404 on a board, even with a user override.
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.65.1.1"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.65.1.2"}, id: gj.GetMe().GetUser().GetId()}
	guest.must(403, "GET", "/api/workspaces/"+wid+"/boards", nil, nil)
	guest.must(404, "GET", "/api/boards/"+b.GetId(), nil, nil)
	guest.must(404, "GET", "/api/tasks/"+task.GetId(), nil, nil)
	guest.must(404, "GET", "/api/rooms/"+task.GetRoomId()+"/messages", nil, nil)
	if ready := dialGW(t).identify(guest.token); len(ready.GetWorkspaces()[0].GetBoards()) != 0 {
		t.Fatal("guest READY has boards")
	}

	// Bots are users: a member bot sees public boards, creates tasks, may be assigned; access
	// changes and the final delete are for people; a user override lets it into a private board.
	bt := createBot(t, o, wid, "boardbot")
	if _, ok := listBoards(t, bt, wid)[b.GetId()]; !ok {
		t.Fatal("bot does not see the public board")
	}
	bt.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	bTask := createTask(t, bt, b.GetId(), &v1.CreateTaskRequest{Title: "от бота", Assignees: []*v1.TaskAssigneeInput{{UserId: bt.id, IsLead: true}}}, 201)
	if bTask.GetCreatedBy() != bt.id || bTask.GetAssignees()[0].GetUserId() != bt.id {
		t.Fatalf("bot task %v", bTask)
	}
	bt.must(403, "PUT", "/api/boards/"+b.GetId()+"/permissions", &v1.SetBoardPermissionsRequest{}, nil)
	setBoardPerms(o, priv.GetId(), 200, userOv(bob.id, perm.ViewBoard|perm.EditTasks, 0), roleOv(team.GetId(), perm.ViewBoard, 0),
		userOv(bt.id, perm.ViewBoard|perm.CreateTasks|perm.ManageBoard, 0))
	bt.must(200, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	bt.must(403, "DELETE", "/api/boards/"+priv.GetId()+"?purge=1", nil, nil)
	if r, _ := errReason(bt.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot purge reason %q", r)
	}
	var found v1.SearchTasksResponse
	bt.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?q=SEC-1", nil, &found)
	if len(found.GetTasks()) != 1 || found.GetTasks()[0].GetId() != secret.GetId() {
		t.Fatalf("bot search: %v", found.GetTasks())
	}

	// Archive (MANAGE_BOARD): hidden from lists; restore; purge (people) removes the tasks' rooms.
	o.must(204, "DELETE", "/api/boards/"+b2.GetId(), nil, nil)
	if _, ok := listBoards(t, o, wid)[b2.GetId()]; ok {
		t.Fatal("archived board listed")
	}
	o.must(201, "POST", "/api/boards/"+b2.GetId()+"/restore", nil, nil)
	gone := createTask(t, o, b2.GetId(), &v1.CreateTaskRequest{Title: "будет удалена"}, 201)
	o.must(204, "DELETE", "/api/boards/"+b2.GetId()+"?purge=1", nil, nil)
	o.must(404, "GET", "/api/boards/"+b2.GetId(), nil, nil)
	o.must(404, "GET", "/api/rooms/"+gone.GetRoomId()+"/messages", nil, nil)
}

// TestTaskLifecycle: numbering, positions, statuses with timestamps, assignees with one lead,
// labels, relations, subtasks, archive / restore, the journal and the feed, the key lookup,
// «Создать задачу из сообщения», and moving between boards.
func TestTaskLifecycle(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Ops", Key: "OPS", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	todo, started, done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED), statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED), statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)

	// Assignees: two leads are refused; none marked → the first leads.
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x", Assignees: []*v1.TaskAssigneeInput{{UserId: o.id, IsLead: true}, {UserId: bob.id, IsLead: true}}}, 422)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: ""}, 422)
	t1 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Первая", Priority: v1.TaskPriority_TASK_PRIORITY_HIGH,
		Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, Note: "бэкенд"}, {UserId: o.id}}, DueOn: "2026-10-01"}, 201)
	if t1.GetKey() != "OPS-1" || t1.GetStatusId() != todo || !t1.GetAssignees()[0].GetIsLead() || t1.GetAssignees()[0].GetUserId() != bob.id ||
		t1.GetAssignees()[0].GetNote() != "бэкенд" || !t1.GetSubscribed() || !t1.GetViewerState() {
		t.Fatalf("t1 %v", t1)
	}
	t2 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Вторая"}, 201)
	t3 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Третья", AfterTaskId: t1.GetId()}, 201)
	if t2.GetNumber() != 2 || t3.GetNumber() != 3 || !(t1.GetPosition() < t3.GetPosition() && t3.GetPosition() < t2.GetPosition()) {
		t.Fatalf("positions %v %v %v", t1.GetPosition(), t3.GetPosition(), t2.GetPosition())
	}
	var bad v1.TaskAssigneeInput
	bad.UserId = "00000000-0000-0000-0000-000000000001"
	o.must(422, "PUT", "/api/tasks/"+t2.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{&bad}}, nil)

	// Kanban move: status + before; started_at, then completed_at / completed_by.
	moved := patchTask(t, o, t2.GetId(), &v1.UpdateTaskRequest{StatusId: &started}, 200)
	if moved.GetStartedAt() == nil || moved.GetCompletedAt() != nil {
		t.Fatalf("started: %v", moved)
	}
	moved = patchTask(t, bob, t1.GetId(), &v1.UpdateTaskRequest{StatusId: &started, BeforeTaskId: t2.GetId()}, 200)
	if moved.GetPosition() >= patchTask(t, o, t2.GetId(), &v1.UpdateTaskRequest{}, 200).GetPosition() {
		t.Fatal("before_task_id not respected")
	}
	moved = patchTask(t, bob, t1.GetId(), &v1.UpdateTaskRequest{StatusId: &done}, 200)
	if moved.GetCompletedAt() == nil || moved.GetCompletedBy() != bob.id {
		t.Fatalf("completed: %v", moved)
	}
	ageActivity(t, t1.GetId()) // else the moves merge into nothing (back to todo, ADR-0081)
	moved = patchTask(t, bob, t1.GetId(), &v1.UpdateTaskRequest{StatusId: &todo}, 200)
	if moved.GetCompletedAt() != nil || moved.GetStartedAt() == nil {
		t.Fatalf("reopened: %v", moved)
	}
	// Many moves between the same neighbours renormalise the column, the order stays right.
	for i := range 60 {
		target := t3.GetId()
		if i%2 == 1 {
			target = t1.GetId()
		}
		_ = target
		patchTask(t, o, t2.GetId(), &v1.UpdateTaskRequest{StatusId: &todo, AfterTaskId: t1.GetId()}, 200)
		patchTask(t, o, t3.GetId(), &v1.UpdateTaskRequest{StatusId: &todo, AfterTaskId: t1.GetId()}, 200)
	}
	ts := listTasks(t, o, b.GetId(), &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_STATUS, Op: v1.TaskOp_TASK_OP_IS, Values: []string{todo}}}})
	pos := map[string]float64{}
	for _, x := range ts {
		pos[x.GetKey()] = x.GetPosition()
	}
	if !(pos["OPS-1"] < pos["OPS-3"] && pos["OPS-3"] < pos["OPS-2"]) {
		t.Fatalf("order after many moves: %v", pos)
	}

	// Labels (created on the fly by a member), relations, subtasks, dates.
	var lb v1.BoardResponse
	bob.must(201, "POST", "/api/boards/"+b.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "bug", Color: 0xff0000}, &lb)
	o.must(409, "POST", "/api/boards/"+b.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "BUG"}, nil)
	bug := lb.GetBoard().GetLabels()[0].GetId()
	patchTask(t, bob, t1.GetId(), &v1.UpdateTaskRequest{SetLabels: true, LabelIds: []string{bug}}, 200)
	o.must(200, "PUT", "/api/tasks/"+t1.GetId()+"/relations", &v1.SetTaskRelationRequest{RelatedId: t2.GetId(), Kind: v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS}, nil)
	o.must(422, "PUT", "/api/tasks/"+t1.GetId()+"/relations", &v1.SetTaskRelationRequest{RelatedId: t1.GetId(), Kind: v1.TaskRelationKind_TASK_RELATION_KIND_RELATES}, nil)
	sub := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Подзадача", ParentId: t1.GetId(), StatusId: done}, 201)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "внучка", ParentId: sub.GetId()}, 422)
	start, due := "2026-10-05", "2026-10-01"
	patchTask(t, o, t2.GetId(), &v1.UpdateTaskRequest{StartOn: &start, DueOn: &due}, 422)
	full := getTask(t, o, t1.GetId())
	if full.GetTask().GetSubtaskCount() != 1 || full.GetTask().GetSubtaskDone() != 1 || len(full.GetSubtasks()) != 1 ||
		len(full.GetRelated()) != 1 || len(full.GetTask().GetRelations()) != 1 || full.GetRoom().GetType() != v1.RoomType_ROOM_TYPE_TASK ||
		len(full.GetTask().GetLabelIds()) != 1 {
		t.Fatalf("full task: %v", full)
	}
	if rel := getTask(t, o, t2.GetId()).GetTask().GetRelations(); len(rel) != 1 || rel[0].GetTaskId() != t1.GetId() {
		t.Fatalf("relation from the other side: %v", rel)
	}

	// The journal: one entry per change, actor included; the feed merges comments.
	kinds := strings.Join(activityKinds(t, o, t1.GetId()), ",")
	for _, k := range []string{"created", "status", "labels", "relation"} {
		if !strings.Contains(kinds, k) {
			t.Fatalf("journal of t1 lacks %q: %s", k, kinds)
		}
	}
	c := send(t, bob, t1.GetRoomId(), "комментарий", uniq("c"))
	var feed v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+t1.GetId()+"/activity?limit=2", nil, &feed)
	if len(feed.GetItems()) != 2 || feed.GetItems()[0].GetMessage().GetId() != c.GetId() || !feed.GetHasMore() {
		t.Fatalf("feed: %v", feed.GetItems())
	}
	var older v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+t1.GetId()+"/activity?limit=100&before="+feed.GetItems()[1].GetActivity().GetId(), nil, &older)
	if len(older.GetItems()) == 0 || older.GetItems()[0].GetActivity() == nil {
		t.Fatalf("older page: %v", older.GetItems())
	}
	var csv []byte
	{
		resp, raw := get(t, o, "/api/boards/"+b.GetId()+"/activity?format=csv", nil)
		if resp.StatusCode != 200 || !strings.HasPrefix(string(raw), "id,created_at,task_key") || !strings.Contains(string(raw), "OPS-1") {
			t.Fatalf("csv %d %s", resp.StatusCode, raw)
		}
		csv = raw
	}
	_ = csv
	bob.must(403, "GET", "/api/boards/"+b.GetId()+"/activity", nil, nil)

	// Key lookup.
	var lk v1.TaskResponse
	bob.must(200, "GET", "/api/t/ops-1", nil, &lk)
	if lk.GetTask().GetId() != t1.GetId() || lk.GetBoard().GetId() != b.GetId() || lk.GetRoom().GetId() != t1.GetRoomId() {
		t.Fatalf("lookup %v", &lk)
	}

	// From a message: quote + link; a message the author cannot see is 404.
	pub := textRoom(t, o, wid, "general", false)
	m := send(t, o, pub, "сломался вход\nвторая строка", uniq("m"))
	fm := createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "Вход", FromMessageId: m.GetId()}, 201)
	if !strings.HasPrefix(fm.GetDescription(), "> сломался вход\n> вторая строка\n\n[Сообщение](https://app.example.com/m/"+pub+"/"+m.GetId()+")") {
		t.Fatalf("description from a message: %q", fm.GetDescription())
	}
	hidden := textRoom(t, o, wid, "secret", true)
	hm := send(t, o, hidden, "тайное", uniq("m"))
	createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "x", FromMessageId: hm.GetId()}, 404)

	// Archive / restore: out of the list, back; the room is read-only while archived.
	o.must(200, "POST", "/api/tasks/"+t3.GetId()+"/archive", nil, nil)
	if taskKeys(listTasks(t, o, b.GetId(), nil))["OPS-3"] {
		t.Fatal("archived task listed")
	}
	var arch v1.ListTasksResponse
	o.must(200, "GET", "/api/boards/"+b.GetId()+"/tasks?archived=1", nil, &arch)
	if len(arch.GetTasks()) != 1 || arch.GetTasks()[0].GetArchivedAt() == nil {
		t.Fatalf("archive list %v", arch.GetTasks())
	}
	o.must(403, "POST", "/api/rooms/"+t3.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "x", Nonce: uniq("a")}, nil)
	o.must(200, "POST", "/api/tasks/"+t3.GetId()+"/restore", nil, nil)
	kinds = strings.Join(activityKinds(t, o, t3.GetId()), ",")
	if !strings.Contains(kinds, "archived") || !strings.Contains(kinds, "restored") {
		t.Fatalf("archive journal %s", kinds)
	}

	// Status delete moves its tasks; the default status cannot go.
	o.must(422, "DELETE", "/api/boards/"+b.GetId()+"/statuses/"+started, nil, nil)
	o.must(409, "DELETE", "/api/boards/"+b.GetId()+"/statuses/"+todo+"?move_to="+done, nil, nil)
	inStarted := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "в работе", StatusId: started}, 201)
	o.must(200, "DELETE", "/api/boards/"+b.GetId()+"/statuses/"+started+"?move_to="+done, nil, nil)
	if got := getTask(t, o, inStarted.GetId()).GetTask(); got.GetStatusId() != done || got.GetCompletedAt() == nil {
		t.Fatalf("moved by the status delete: %v", got)
	}

	// Move to another board: MANAGE_BOARD on both; a new number; journal "moved_board".
	other := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Other", Key: "OTH"}, 201)
	otherID := other.GetId()
	patchTask(t, bob, t2.GetId(), &v1.UpdateTaskRequest{BoardId: &otherID}, 403)
	mv := patchTask(t, o, t2.GetId(), &v1.UpdateTaskRequest{BoardId: &otherID}, 200)
	if mv.GetBoardId() != otherID || mv.GetKey() != "OTH-1" || statusOf(other, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED) != mv.GetStatusId() {
		t.Fatalf("moved task %v", mv)
	}
	if !strings.Contains(strings.Join(activityKinds(t, o, t2.GetId()), ","), "moved_board") {
		t.Fatal("no moved_board entry")
	}
	o.must(404, "GET", "/api/t/OPS-2", nil, nil)
	o.must(200, "GET", "/api/t/OTH-1", nil, nil)
	// The key of a board with tasks is locked.
	k := "NEW"
	o.must(409, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{Key: &k}, nil)
}

// TestTaskComments: comments are messages of the hidden task room (reactions, files, pins,
// search); the room is not in READY or the room list; the board's viewers get its events.
func TestTaskComments(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Comments", Key: "COM"}, 201)
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Private", Key: "PRV", IsPrivate: true}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Обсудить"}, 201)
	ptask := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "Тайное"}, 201)

	gb := dialGW(t)
	ready := gb.identify(bob.token)
	var snap *v1.WorkspaceSnapshot
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid {
			snap = s
		}
	}
	if len(snap.GetBoards()) != 1 || snap.GetBoards()[0].GetId() != b.GetId() || snap.GetBoards()[0].GetPermissions() == 0 {
		t.Fatalf("READY boards %v", snap.GetBoards())
	}
	for _, r := range snap.GetRooms() {
		if r.GetId() == task.GetRoomId() {
			t.Fatal("task room in READY rooms")
		}
	}
	if _, ok := visibleRooms(t, o, wid)[task.GetRoomId()]; ok {
		t.Fatal("task room in the room list")
	}

	// A comment, a reaction, a pin (EDIT_TASKS → MANAGE_MESSAGES for the owner), search, a file.
	m := send(t, carol, task.GetRoomId(), "первый коммент @"+bob.id, uniq("c"))
	gb.wait("MESSAGE_CREATE of the task room", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == m.GetId() })
	bob.must(204, "PUT", "/api/messages/"+m.GetId()+"/reactions/"+url.PathEscape("👍"), nil, nil)
	gb.wait("reaction", func(e *v1.DispatchEvent) bool { return e.GetMessageReactionAdd().GetMessageId() == m.GetId() })
	bob.must(403, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	o.must(204, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	var found v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+task.GetRoomId()+"/messages?q="+url.QueryEscape("коммент"), nil, &found)
	if len(found.GetMessages()) != 1 {
		t.Fatalf("search in a task room: %v", found.GetMessages())
	}
	st, f, _ := upload(t, bob, "/api/boards/"+b.GetId()+"/files", "shot.png", pngBytes(8, 8))
	if st != 201 {
		t.Fatalf("board upload %d", st)
	}
	var withFile v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{f.GetId()}, Nonce: uniq("f")}, &withFile)
	if fileStatus(t, carol, f.GetId()) != 200 {
		t.Fatal("a board viewer cannot read the comment's file")
	}
	// The mention subscribed bob and the task counts comments; the board got TASK_UPDATE.
	gb.wait("TASK_UPDATE with the comment count", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetTask().GetId() == task.GetId() && e.GetTaskUpdate().GetTask().GetCommentCount() == 2
	})
	if tr := getTask(t, bob, task.GetId()); !tr.GetTask().GetSubscribed() || tr.GetTask().GetCommentCount() != 2 {
		t.Fatalf("bob's view %v", tr.GetTask())
	}
	// Description attachments; a file attached to a task cannot go into a message.
	_, f2, _ := upload(t, o, "/api/boards/"+b.GetId()+"/files", "spec.png", pngBytes(8, 8))
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{SetAttachments: true, AttachmentIds: []string{f2.GetId()}}, 200)
	if got := getTask(t, o, task.GetId()).GetTask(); got.GetAttachmentCount() != 1 || len(got.GetAttachments()) != 1 {
		t.Fatalf("attachments %v", got)
	}
	if fileStatus(t, bob, f2.GetId()) != 200 {
		t.Fatal("a board viewer cannot read a description file")
	}
	o.must(422, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{f2.GetId()}, Nonce: uniq("f")}, nil)

	// Comments of a private board do not reach bob.
	pm := send(t, o, ptask.GetRoomId(), "секрет", uniq("p"))
	gb.quiet("private task room message", 500*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetId() == pm.GetId()
	})
	bob.must(404, "PUT", "/api/messages/"+pm.GetId()+"/reactions/"+url.PathEscape("👍"), nil, nil)
	// Granting him the board turns the board up live and its comments reach him.
	setBoardPerms(o, priv.GetId(), 200, userOv(bob.id, perm.ViewBoard, 0))
	gb.wait("BOARD_CREATE of the private board", func(e *v1.DispatchEvent) bool {
		return e.GetBoardCreate().GetBoard().GetId() == priv.GetId() && e.GetBoardCreate().GetBoard().GetPermissions()&uint64(perm.ViewBoard) != 0
	})
	pm2 := send(t, o, ptask.GetRoomId(), "теперь видно", uniq("p"))
	gb.wait("private comment after the grant", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == pm2.GetId() })
	setBoardPerms(o, priv.GetId(), 200)
	gb.wait("BOARD_DELETE on losing the board", func(e *v1.DispatchEvent) bool { return e.GetBoardDelete().GetBoardId() == priv.GetId() })

	// Forward into a task and out of it.
	pub := textRoom(t, o, wid, "general", false)
	fwd := forwardMsg(t, o, task.GetRoomId(), m.GetId(), pub, 201)
	if fwd.GetForward().GetRoomId() != task.GetRoomId() {
		t.Fatalf("forward out of a task: %v", fwd.GetForward())
	}
	forwardMsg(t, o, pub, fwd.GetId(), task.GetRoomId(), 201)
	// No voice in a task room.
	o.must(403, "POST", "/api/rooms/"+task.GetRoomId()+"/join", nil, nil)
}

// TestTaskFilters: the TaskFilter over the list endpoint, all conditions or any.
func TestTaskFilters(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Filters", Key: "FLT"}, 201)
	var lb v1.BoardResponse
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "ui"}, &lb)
	ui := lb.GetBoard().GetLabels()[0].GetId()
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Логин падает", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}, DueOn: "2020-01-01", LabelIds: []string{ui}}, 201)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт", Priority: v1.TaskPriority_TASK_PRIORITY_URGENT, Estimate: 5}, 201)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Готово давно", StatusId: done}, 201)
	c := func(f v1.TaskField, op v1.TaskOp, vals ...string) *v1.TaskCondition {
		return &v1.TaskCondition{Field: f, Op: op, Values: vals}
	}
	cases := []struct {
		name string
		f    *v1.TaskFilter
		want string
	}{
		{"assignee me (bob)", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskOp_TASK_OP_IS, "me")}}, "FLT-1"},
		{"unassigned", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskOp_TASK_OP_EMPTY)}}, "FLT-2,FLT-3"},
		{"overdue", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_BEFORE, "today")}}, "FLT-1"},
		{"label", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_LABEL, v1.TaskOp_TASK_OP_ANY_OF, ui)}}, "FLT-1"},
		{"text", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_TEXT, v1.TaskOp_TASK_OP_CONTAINS, "отчёт")}}, "FLT-2"},
		{"key", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_TEXT, v1.TaskOp_TASK_OP_CONTAINS, "FLT-3")}}, "FLT-3"},
		{"finished", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_STATUS_TYPE, v1.TaskOp_TASK_OP_IS, "completed")}}, "FLT-3"},
		{"priority gt", &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_PRIORITY, Op: v1.TaskOp_TASK_OP_GT, Number: 3}}}, "FLT-2"},
		{"estimate set and creator me", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_ESTIMATE, v1.TaskOp_TASK_OP_NOT_EMPTY), c(v1.TaskField_TASK_FIELD_CREATOR, v1.TaskOp_TASK_OP_IS_NOT, "me")}}, "FLT-2"},
		{"any", &v1.TaskFilter{Any: true, Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_LABEL, v1.TaskOp_TASK_OP_NOT_EMPTY), c(v1.TaskField_TASK_FIELD_STATUS_TYPE, v1.TaskOp_TASK_OP_IS, "completed")}}, "FLT-1,FLT-3"},
		{"no comments", &v1.TaskFilter{Conditions: []*v1.TaskCondition{c(v1.TaskField_TASK_FIELD_HAS_COMMENTS, v1.TaskOp_TASK_OP_IS, "false"), c(v1.TaskField_TASK_FIELD_PARENT, v1.TaskOp_TASK_OP_EMPTY)}}, "FLT-1,FLT-2,FLT-3"},
	}
	for _, tc := range cases {
		got := taskKeys(listTasks(t, bob, b.GetId(), tc.f))
		want := map[string]bool{}
		for _, k := range strings.Split(tc.want, ",") {
			want[k] = true
		}
		if len(got) != len(want) {
			t.Errorf("%s: got %v, want %s", tc.name, got, tc.want)
			continue
		}
		for k := range want {
			if !got[k] {
				t.Errorf("%s: got %v, want %s", tc.name, got, tc.want)
			}
		}
	}
	bob.must(422, "GET", "/api/boards/"+b.GetId()+"/tasks?filter="+url.QueryEscape(`{"conditions":[{"field":"TASK_FIELD_STATUS","op":"TASK_OP_IS","values":["nope"]}]}`), nil, nil)
	// «Мои задачи» and ⌘K.
	var mine v1.MyTasksResponse
	bob.must(200, "GET", "/api/me/tasks?workspace_id="+ws.GetId()+"&scope=lead&open=1", nil, &mine)
	if len(mine.GetTasks()) != 1 || mine.GetTasks()[0].GetKey() != "FLT-1" {
		t.Fatalf("my tasks %v", mine.GetTasks())
	}
	var s v1.SearchTasksResponse
	bob.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/tasks/search?q="+url.QueryEscape("логин"), nil, &s)
	if len(s.GetTasks()) != 1 || s.GetTasks()[0].GetKey() != "FLT-1" {
		t.Fatalf("search %v", s.GetTasks())
	}
}

// TestBoardViews: shared views by MANAGE_BOARD, personal ones by their author only.
func TestBoardViews(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	carol := register(t, invite(t, o, ws.GetId()))
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Views", Key: "VW"}, 201)
	base := "/api/boards/" + b.GetId() + "/views"
	mine := &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_ASSIGNEE, Op: v1.TaskOp_TASK_OP_IS, Values: []string{"me"}}}}
	var shared, personal v1.BoardViewResponse
	bob.must(403, "POST", base, &v1.CreateBoardViewRequest{Name: "Общий", Shared: true}, nil)
	o.must(201, "POST", base, &v1.CreateBoardViewRequest{Name: "Общий", Kind: v1.BoardViewKind_BOARD_VIEW_KIND_LIST, Filter: mine, Shared: true}, &shared)
	bob.must(201, "POST", base, &v1.CreateBoardViewRequest{Name: "Моё", Kind: v1.BoardViewKind_BOARD_VIEW_KIND_TIMELINE}, &personal)
	bob.must(422, "POST", base, &v1.CreateBoardViewRequest{Name: "плохой", Filter: &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_TEXT, Op: v1.TaskOp_TASK_OP_IS}}}}, nil)
	count := func(u musty) int {
		var l v1.ListBoardViewsResponse
		u.must(200, "GET", base, nil, &l)
		return len(l.GetViews())
	}
	if count(bob) != 2 || count(carol) != 1 || count(o) != 1 {
		t.Fatalf("views: bob %d carol %d owner %d", count(bob), count(carol), count(o))
	}
	n := "Переименован"
	carol.must(404, "PATCH", base+"/"+personal.GetView().GetId(), &v1.UpdateBoardViewRequest{Name: &n}, nil)
	bob.must(403, "PATCH", base+"/"+shared.GetView().GetId(), &v1.UpdateBoardViewRequest{Name: &n}, nil)
	bob.must(200, "PATCH", base+"/"+personal.GetView().GetId(), &v1.UpdateBoardViewRequest{Name: &n}, nil)
	// The shared view is the board's default; the board carries it.
	def := shared.GetView().GetId()
	var br v1.BoardResponse
	o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{DefaultViewId: &def}, &br)
	if br.GetBoard().GetDefaultViewId() != def || listBoards(t, carol, ws.GetId())[b.GetId()].GetDefaultViewId() != def {
		t.Fatal("default view")
	}
	pv := personal.GetView().GetId()
	o.must(422, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{DefaultViewId: &pv}, nil)
	bob.must(204, "DELETE", base+"/"+personal.GetView().GetId(), nil, nil)
}

// TestTaskNotifications: assignment, comment and status notices on the user channel by the
// «Задачи» level, the unread list in READY and PUT …/read.
func TestTaskNotifications(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Notify", Key: "NTF"}, 201)
	gb := dialGW(t)
	gb.identify(bob.token)

	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Назначить Боба"}, 201)
	o.must(200, "PUT", "/api/tasks/"+task.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	ev := gb.wait("ASSIGNED notice", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED
	})
	if tk := ev.GetTaskUpdate().GetTask(); !tk.GetViewerState() || !tk.GetUnread() || !tk.GetSubscribed() || ev.GetTaskUpdate().GetNotice().GetActorId() != o.id {
		t.Fatalf("personal TASK_UPDATE %v", ev.GetTaskUpdate())
	}
	g2 := dialGW(t)
	ready := g2.identify(bob.token)
	unread := false
	for _, s := range ready.GetWorkspaces() {
		for _, id := range s.GetUnreadTaskIds() {
			unread = unread || id == task.GetId()
		}
	}
	if !unread {
		t.Fatal("READY lacks the unread task")
	}
	var seen v1.TaskResponse
	bob.must(200, "PUT", "/api/tasks/"+task.GetId()+"/read", nil, &seen)
	if seen.GetTask().GetUnread() {
		t.Fatal("still unread")
	}
	gb = g2 // the new session replaced the first one
	g2.wait("TASK_UPDATE unread=false on the user channel", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetTask().GetId() == task.GetId() && e.GetTaskUpdate().GetTask().GetViewerState() && !e.GetTaskUpdate().GetTask().GetUnread()
	})

	// A comment and a status change of a subscribed task notify (level ALL).
	send(t, o, task.GetRoomId(), "есть новости", uniq("n"))
	gb.wait("COMMENT notice", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_COMMENT
	})
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{StatusId: &done}, 200)
	stEv := gb.wait("STATUS notice", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS
	})
	if !stEv.GetTaskUpdate().GetTask().GetUnread() {
		t.Fatal("a completed task keeps its own unread mark")
	}
	// The READY badge list counts open tasks only, as «Мои задачи» (GET /api/me/tasks?open=1).
	g3 := dialGW(t)
	for _, s := range g3.identify(bob.token).GetWorkspaces() {
		if slices.Contains(s.GetUnreadTaskIds(), task.GetId()) {
			t.Fatal("READY counts a completed task as unread")
		}
	}
	gb = g3 // the new session replaced the previous one

	// MENTIONS: comments stay silent, @mentions notify; NONE: nothing. «Отписаться» mutes comments.
	lvl := v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS
	var ns v1.UpdateWorkspaceNotificationSettingsResponse
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/notifications", &v1.UpdateWorkspaceNotificationSettingsRequest{TaskLevel: &lvl}, &ns)
	if ns.GetSettings().GetTaskLevel() != lvl || ns.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS {
		t.Fatalf("settings %v", ns.GetSettings())
	}
	send(t, o, task.GetRoomId(), "тихо", uniq("n"))
	gb.quiet("comment notice with MENTIONS", 500*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_COMMENT
	})
	send(t, o, task.GetRoomId(), "@"+bob.id+" глянь", uniq("n"))
	gb.wait("MENTIONED notice", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED
	})
	all := v1.NotificationLevel_NOTIFICATION_LEVEL_ALL
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/notifications", &v1.UpdateWorkspaceNotificationSettingsRequest{TaskLevel: &all}, nil)
	bob.must(200, "PUT", "/api/tasks/"+task.GetId()+"/subscription", &v1.SetTaskSubscriptionRequest{Muted: true}, nil)
	send(t, o, task.GetRoomId(), "без Боба", uniq("n"))
	gb.quiet("comment notice after unsubscribing", 500*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_COMMENT
	})
	// The actor is never notified of their own change.
	gb.quiet("self notice", 200*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetActorId() == bob.id
	})
}

// TestTaskArchiveSweeper: finished tasks older than the board's auto_archive_days are archived.
func TestTaskArchiveSweeper(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Sweep", Key: "SWP"}, 201)
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	old := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "старая", StatusId: done}, 201)
	fresh := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "свежая", StatusId: done}, 201)
	open := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "открытая"}, 201)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE tasks SET completed_at = now() - interval '31 days' WHERE id = ANY($1::uuid[])",
		[]string{old.GetId(), open.GetId()}); err != nil {
		t.Fatal(err)
	}
	if _, err := testApp.Boards.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if getTask(t, o, old.GetId()).GetTask().GetArchivedAt() == nil {
		t.Fatal("old finished task not archived")
	}
	if getTask(t, o, fresh.GetId()).GetTask().GetArchivedAt() != nil || getTask(t, o, open.GetId()).GetTask().GetArchivedAt() != nil {
		t.Fatal("fresh or open task archived")
	}
	if kinds := activityKinds(t, o, old.GetId()); kinds[0] != "archived" {
		t.Fatalf("journal %v", kinds)
	}
	// auto_archive_days 0 = never.
	zero := uint32(0)
	o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{AutoArchiveDays: &zero}, nil)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE tasks SET completed_at = now() - interval '400 days' WHERE id = $1", fresh.GetId()); err != nil {
		t.Fatal(err)
	}
	if _, err := testApp.Boards.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if getTask(t, o, fresh.GetId()).GetTask().GetArchivedAt() != nil {
		t.Fatal("archived with auto archive off")
	}
}

// TestTaskUnfurl: own /t/ and /b/ links unfurl from the database by the viewer's rights.
func TestTaskUnfurl(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Unfurl", Key: "UNF"}, 201)
	priv := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Hidden", Key: "HID", IsPrivate: true}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Карточка"}, 201)
	createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "Скрытая"}, 201)
	var u v1.UnfurlResponse
	bob.must(200, "GET", "/api/unfurl?url="+url.QueryEscape("https://app.example.com/t/UNF-1"), nil, &u)
	if u.GetTask().GetId() != task.GetId() || u.GetTitle() != "UNF-1 · Карточка" || u.GetBoard().GetKey() != "UNF" || u.GetDescription() != "Todo" {
		t.Fatalf("task card %v", &u)
	}
	bob.must(404, "GET", "/api/unfurl?url="+url.QueryEscape("https://app.example.ru/t/HID-1"), nil, nil)
	var ub v1.UnfurlResponse
	bob.must(200, "GET", "/api/unfurl?url="+url.QueryEscape("https://alias.example.org/b/"+b.GetId()), nil, &ub)
	if ub.GetBoard().GetId() != b.GetId() || ub.GetTask() != nil {
		t.Fatalf("board card %v", &ub)
	}
	bob.must(404, "GET", "/api/unfurl?url="+url.QueryEscape("https://app.example.com/b/"+priv.GetId()), nil, nil)
}

// TestBoardPlanLimit: Free allows 3 boards (live and archived), the hard cap is 50.
func TestBoardPlanLimit(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	for i := range 3 {
		createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Доска " + string(rune('A'+i))}, 201)
	}
	createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Четвёртая"}, 409)
	if reason, _ := errReason(o.client); reason != "PLAN_LIMIT" {
		t.Fatalf("reason %q", reason)
	}
}

// TestBoardSecurityReview: findings of the 1.1.0 security review (docs/21 «Security-ревью»).
func TestBoardSecurityReview(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	pub := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Открытая", Key: "OPN"}, 201)
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Закрытая", Key: "CLS", IsPrivate: true}, 201)

	// A board icon is readable by every member: a manager cannot make someone else's file (here
	// an attachment of a private board's task) the icon of a board they manage.
	_, secretFile, _ := upload(t, o, "/api/boards/"+priv.GetId()+"/files", "secret.png", pngBytes(8, 8))
	createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "тайна", AttachmentIds: []string{secretFile.GetId()}}, 201)
	if fileStatus(t, bob, secretFile.GetId()) != 404 {
		t.Fatal("a private board's file is readable by a member who does not see the board")
	}
	setBoardPerms(o, pub.GetId(), 200, userOv(bob.id, perm.ManageBoard, 0))
	stolen := secretFile.GetId()
	bob.must(422, "PATCH", "/api/boards/"+pub.GetId(), &v1.UpdateBoardRequest{IconFileId: &stolen}, nil)
	if fileStatus(t, bob, secretFile.GetId()) != 404 {
		t.Fatal("someone else's file became readable through a board icon")
	}
	_, bobs, _ := upload(t, bob, "/api/boards/"+pub.GetId()+"/files", "bob.png", pngBytes(8, 8))
	createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Чужая иконка", IconFileId: bobs.GetId()}, 422)
	// Own uploads work, and another manager may send the current icon again.
	mine := bobs.GetId()
	bob.must(200, "PATCH", "/api/boards/"+pub.GetId(), &v1.UpdateBoardRequest{IconFileId: &mine}, nil)
	o.must(200, "PATCH", "/api/boards/"+pub.GetId(), &v1.UpdateBoardRequest{IconFileId: &mine}, nil)

	// Rate limits: ⌘K task search and task creation are per-user budgets (429 when spent).
	limited := func(what string, do func() int) {
		t.Helper()
		for range 200 {
			switch st := do(); st {
			case 429:
				return
			case 200, 201:
			default:
				t.Fatalf("%s: status %d", what, st)
			}
		}
		t.Fatalf("%s is not rate limited", what)
	}
	limited("task search", func() int {
		return bob.do("GET", "/api/workspaces/"+wid+"/tasks/search?q=x", nil, nil)
	})
	limited("task create", func() int {
		return bob.do("POST", "/api/boards/"+pub.GetId()+"/tasks", &v1.CreateTaskRequest{Title: "спам"}, nil)
	})
}
