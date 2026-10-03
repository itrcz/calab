//go:build integration

package app_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Milestones inside a task (ADR-0063).

func newTaskMilestone(t *testing.T, u musty, taskID, name, due string, want int) *v1.TaskMilestoneResponse {
	t.Helper()
	var r v1.TaskMilestoneResponse
	u.must(want, "POST", "/api/tasks/"+taskID+"/milestones", &v1.CreateTaskMilestoneRequest{Name: name, DueOn: due}, &r)
	return &r
}

func patchTaskMilestone(t *testing.T, u musty, id string, req *v1.UpdateTaskMilestoneRequest, want int) *v1.TaskMilestoneResponse {
	t.Helper()
	var r v1.TaskMilestoneResponse
	u.must(want, "PATCH", "/api/task-milestones/"+id, req, &r)
	return &r
}

func milestoneOf(t *testing.T, task *v1.Task, id string) *v1.TaskMilestone {
	t.Helper()
	for _, m := range task.GetMilestones() {
		if m.GetId() == id {
			return m
		}
	}
	t.Fatalf("milestone %s not in %v", id, task.GetMilestones())
	return nil
}

func TestTaskMilestones(t *testing.T) {
	t.Run("crud", testTaskMilestonesCRUD)
	t.Run("progress", testTaskMilestonesProgress)
	t.Run("feature", testTaskMilestonesFeature)
	t.Run("rights", testTaskMilestonesRights)
	t.Run("events", testTaskMilestonesEvents)
}

func testTaskMilestonesCRUD(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Вехи", Key: "TMS"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Большая задача"}, 201)
	tid := task.GetId()

	m1 := newTaskMilestone(t, o, tid, "Прототип", "2026-10-05", 201)
	if m1.GetMilestone().GetName() != "Прототип" || m1.GetMilestone().GetDueOn() != "2026-10-05" || m1.GetMilestone().GetPosition() != 0 {
		t.Fatalf("create: %v", m1.GetMilestone())
	}
	m2 := newTaskMilestone(t, o, tid, "Бета", "", 201).GetMilestone()
	if m2.GetPosition() != 1 || m2.GetDueOn() != "" {
		t.Fatalf("second: %v", m2)
	}
	newTaskMilestone(t, o, tid, "", "", 422)
	newTaskMilestone(t, o, tid, strings.Repeat("я", 61), "", 422)
	newTaskMilestone(t, o, tid, "дата", "05.10.2026", 422)

	// Every task carries its milestones and the progress (lists too).
	if p := m1.GetTask().GetMilestoneProgress(); p.GetTotal() != 1 || p.GetDone() != 0 {
		t.Fatalf("progress after create: %v", p)
	}
	var listed *v1.Task
	for _, x := range listTasks(t, o, b.GetId(), nil) {
		if x.GetId() == tid {
			listed = x
		}
	}
	if len(listed.GetMilestones()) != 2 || listed.GetMilestoneProgress().GetTotal() != 2 {
		t.Fatalf("list: %v", listed.GetMilestones())
	}

	// Rename, date, clear the date, reorder, toggle by hand.
	name, due, none, pos := "Прототип v2", "2026-10-12", "", -1.0
	r := patchTaskMilestone(t, o, m1.GetMilestone().GetId(), &v1.UpdateTaskMilestoneRequest{Name: &name, DueOn: &due}, 200)
	if r.GetMilestone().GetName() != name || r.GetMilestone().GetDueOn() != due {
		t.Fatalf("patch: %v", r.GetMilestone())
	}
	r = patchTaskMilestone(t, o, m2.GetId(), &v1.UpdateTaskMilestoneRequest{Position: &pos, DueOn: &none}, 200)
	if ms := r.GetTask().GetMilestones(); ms[0].GetId() != m2.GetId() || ms[0].GetDueOn() != "" {
		t.Fatalf("order: %v", ms)
	}
	yes, no := true, false
	r = patchTaskMilestone(t, o, m2.GetId(), &v1.UpdateTaskMilestoneRequest{Completed: &yes}, 200)
	if r.GetMilestone().GetCompletedAt() == nil || r.GetMilestone().GetCompletedBy() != o.id || r.GetTask().GetMilestoneProgress().GetDone() != 1 {
		t.Fatalf("complete: %v", r.GetMilestone())
	}
	r = patchTaskMilestone(t, o, m2.GetId(), &v1.UpdateTaskMilestoneRequest{Completed: &no}, 200)
	if r.GetMilestone().GetCompletedAt() != nil || r.GetMilestone().GetCompletedBy() != "" {
		t.Fatalf("reopen: %v", r.GetMilestone())
	}
	if ms := getTask(t, o, tid).GetTask().GetMilestones(); len(ms) != 2 {
		t.Fatalf("get: %v", ms)
	}

	// A subtask has no milestones; the limit is 20.
	sub := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "подзадача", ParentId: tid}, 201)
	newTaskMilestone(t, o, sub.GetId(), "нельзя", "", 422)
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO task_milestones (task_id, name, position)
		SELECT $1, 'x' || g, g + 10 FROM generate_series(1, 18) g`, tid); err != nil {
		t.Fatal(err)
	}
	newTaskMilestone(t, o, tid, "21-я", "", 409)
	if reason, _ := errReason(o.client); reason != "TASK_MILESTONE_LIMIT" {
		t.Fatalf("reason %q", reason)
	}

	// Delete: the linked subtask loses the link; then 404.
	m2id := m2.GetId()
	if st := patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &m2id}, 200); st.GetTaskMilestoneId() != m2id {
		t.Fatalf("link: %q", st.GetTaskMilestoneId())
	}
	var d v1.TaskMilestoneResponse
	o.must(200, "DELETE", "/api/task-milestones/"+m2id, nil, &d)
	if d.GetMilestone() != nil || len(d.GetTask().GetMilestones()) != 19 {
		t.Fatalf("delete: %d", len(d.GetTask().GetMilestones()))
	}
	if getTask(t, o, sub.GetId()).GetTask().GetTaskMilestoneId() != "" {
		t.Fatal("the subtask keeps a deleted milestone")
	}
	patchTaskMilestone(t, o, m2id, &v1.UpdateTaskMilestoneRequest{Name: &name}, 404)
	o.must(404, "DELETE", "/api/task-milestones/"+m2id, nil, nil)

	// Journal: created / renamed / dated / moved / completed / reopened / deleted on the task,
	// linked on the subtask.
	n := 0
	for _, k := range activityKinds(t, o, tid) {
		if k == "milestones" {
			n++
		}
	}
	if n < 8 {
		t.Fatalf("journal %v", activityKinds(t, o, tid))
	}
	if !slices.Contains(activityKinds(t, o, sub.GetId()), "milestones") {
		t.Fatal("no link entry on the subtask")
	}
	// Archived task: 409.
	o.must(200, "POST", "/api/tasks/"+tid+"/archive", nil, nil)
	newTaskMilestone(t, o, tid, "в архиве", "", 409)
}

func testTaskMilestonesProgress(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Прогресс", Key: "TMP", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	completed := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	cancelled := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_CANCELLED)
	unstarted := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	parent := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Родитель"}, 201)
	other := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Другая"}, 201)
	m := newTaskMilestone(t, o, parent.GetId(), "Альфа", "2026-11-01", 201).GetMilestone()
	foreign := newTaskMilestone(t, o, other.GetId(), "Чужая", "", 201).GetMilestone()
	s1 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "s1", ParentId: parent.GetId()}, 201)
	s2 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "s2", ParentId: parent.GetId()}, 201)
	mid, fid := m.GetId(), foreign.GetId()

	// Only a subtask, only to its parent's milestone.
	patchTask(t, o, other.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 422)
	patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &fid}, 422)
	bogus := "00000000-0000-7000-8000-000000000000"
	patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &bogus}, 422)
	patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 200)
	patchTask(t, o, s2.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 200)

	state := func() *v1.TaskMilestone {
		t.Helper()
		return milestoneOf(t, getTask(t, o, parent.GetId()).GetTask(), mid)
	}
	if x := state(); x.GetTotal() != 2 || x.GetDone() != 0 || x.GetCompletedAt() != nil {
		t.Fatalf("linked: %v", x)
	}
	// Linked subtasks: a person cannot toggle.
	yes := true
	patchTaskMilestone(t, o, mid, &v1.UpdateTaskMilestoneRequest{Completed: &yes}, 409)
	if reason, _ := errReason(o.client); reason != "TASK_MILESTONE_AUTO" {
		t.Fatalf("reason %q", reason)
	}
	// One completed: 1/2, open.
	patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{StatusId: &completed}, 200)
	if x := state(); x.GetTotal() != 2 || x.GetDone() != 1 || x.GetCompletedAt() != nil {
		t.Fatalf("1/2: %v", x)
	}
	// The other cancelled: it leaves the total, the milestone completes (actor = the author).
	patchTask(t, o, s2.GetId(), &v1.UpdateTaskRequest{StatusId: &cancelled}, 200)
	x := state()
	if x.GetTotal() != 1 || x.GetDone() != 1 || x.GetCompletedAt() == nil || x.GetCompletedBy() != o.id {
		t.Fatalf("auto completed: %v", x)
	}
	if p := getTask(t, o, parent.GetId()).GetTask().GetMilestoneProgress(); p.GetDone() != 1 {
		t.Fatalf("task progress %v", p)
	}
	// Back to work: reopened.
	patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{StatusId: &unstarted}, 200)
	if x := state(); x.GetCompletedAt() != nil || x.GetDone() != 0 {
		t.Fatalf("auto reopened: %v", x)
	}
	// Archiving the only open subtask leaves no subtask counted: the toggle is the person's again
	// and the milestone keeps its state.
	o.must(200, "POST", "/api/tasks/"+s1.GetId()+"/archive", nil, nil)
	if x := state(); x.GetTotal() != 0 || x.GetCompletedAt() != nil {
		t.Fatalf("archived: %v", x)
	}
	patchTaskMilestone(t, o, mid, &v1.UpdateTaskMilestoneRequest{Completed: &yes}, 200)
	o.must(200, "POST", "/api/tasks/"+s1.GetId()+"/restore", nil, nil)
	if x := state(); x.GetCompletedAt() != nil || x.GetTotal() != 1 {
		t.Fatalf("restored open subtask reopens: %v", x)
	}
	// A new parent resets the link; unlinking by "".
	np := other.GetId()
	if st := patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{ParentId: &np}, 200); st.GetTaskMilestoneId() != "" {
		t.Fatalf("parent change keeps %q", st.GetTaskMilestoneId())
	}
	// …unless the request links one of the new parent's milestones.
	pid := parent.GetId()
	if st := patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{ParentId: &pid, TaskMilestoneId: &mid}, 200); st.GetTaskMilestoneId() != mid {
		t.Fatalf("relink: %q", st.GetTaskMilestoneId())
	}
	empty := ""
	if st := patchTask(t, o, s1.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &empty}, 200); st.GetTaskMilestoneId() != "" {
		t.Fatal("unlink")
	}
	kinds := activityKinds(t, o, parent.GetId())
	if !slices.Contains(kinds, "milestones") {
		t.Fatalf("journal of the parent %v", kinds)
	}
}

func testTaskMilestonesFeature(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Фича", Key: "TMF"}, 201)
	parent := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Родитель"}, 201)
	sub := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "подзадача", ParentId: parent.GetId()}, 201)
	m := newTaskMilestone(t, o, parent.GetId(), "Есть", "", 201).GetMilestone()
	mid := m.GetId()
	patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 200)

	setBoardFeatures(t, b.GetId(), 1<<uint(v1.BoardFeature_BOARD_FEATURE_MILESTONES))
	reason := func(field string) {
		t.Helper()
		if r, code := errReason(o.client); r != "FEATURE_DISABLED" || code != v1.ErrorCode_ERROR_CODE_CONFLICT ||
			!strings.Contains(string(o.lastBody), `"field":"`+field+`"`) {
			t.Fatalf("reason %q code %v body %s", r, code, o.lastBody)
		}
	}
	newTaskMilestone(t, o, parent.GetId(), "нельзя", "", 409)
	reason("milestones")
	name := "новое"
	patchTaskMilestone(t, o, mid, &v1.UpdateTaskMilestoneRequest{Name: &name}, 409)
	reason("milestones")
	// Unlinking and repeating the current link pass; a new link does not.
	patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 200)
	empty := ""
	patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &empty}, 200)
	patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 409)
	reason("taskMilestoneId")
	// Data stays readable; deleting is allowed.
	if len(getTask(t, o, parent.GetId()).GetTask().GetMilestones()) != 1 {
		t.Fatal("data hidden")
	}
	o.must(200, "DELETE", "/api/task-milestones/"+mid, nil, nil)
}

func testTaskMilestonesRights(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Права", Key: "TMR"}, 201)
	ownerTask := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Задача владельца"}, 201)
	bobTask := createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "Задача Боба"}, 201)
	om := newTaskMilestone(t, o, ownerTask.GetId(), "владельца", "", 201).GetMilestone()

	// CREATE_TASKS: own tasks yes, someone else's no (reading stays).
	newTaskMilestone(t, bob, bobTask.GetId(), "своя", "", 201)
	newTaskMilestone(t, bob, ownerTask.GetId(), "чужая", "", 403)
	yes := true
	patchTaskMilestone(t, bob, om.GetId(), &v1.UpdateTaskMilestoneRequest{Completed: &yes}, 403)
	bob.must(403, "DELETE", "/api/task-milestones/"+om.GetId(), nil, nil)
	if len(getTask(t, bob, ownerTask.GetId()).GetTask().GetMilestones()) != 1 {
		t.Fatal("a viewer cannot read milestones")
	}
	// Assigned: the right extends.
	o.must(200, "PUT", "/api/tasks/"+ownerTask.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	patchTaskMilestone(t, bob, om.GetId(), &v1.UpdateTaskMilestoneRequest{Completed: &yes}, 200)
	// EDIT_TASKS edits any task.
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, perm.EditTasks, 0))
	newTaskMilestone(t, carol, bobTask.GetId(), "редактор", "", 201)

	// Task-scoped (ADR-0059): the assignee by the card edits, the approver only looks, a hidden
	// task is 404.
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Закрытая", Key: "TMQ", IsPrivate: true}, 201)
	card := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "карточка", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	o.must(200, "PUT", "/api/tasks/"+card.GetId()+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{carol.id}}, nil)
	hidden := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "тайна"}, 201)
	hm := newTaskMilestone(t, o, hidden.GetId(), "тайная", "", 201).GetMilestone()
	cm := newTaskMilestone(t, bob, card.GetId(), "по карточке", "", 201).GetMilestone()
	newTaskMilestone(t, carol, card.GetId(), "согласующий", "", 403)
	if len(getTask(t, carol, card.GetId()).GetTask().GetMilestones()) != 1 {
		t.Fatal("the approver does not see milestones")
	}
	newTaskMilestone(t, bob, hidden.GetId(), "x", "", 404)
	name := "x"
	patchTaskMilestone(t, bob, hm.GetId(), &v1.UpdateTaskMilestoneRequest{Name: &name}, 404)
	bob.must(200, "DELETE", "/api/task-milestones/"+cm.GetId(), nil, nil)

	// A bot: by the same bits as people.
	bt := createBot(t, o, wid, "Milestoner")
	giveBot(t, o, wid, bt, "tasks", perm.ViewBoard|perm.CreateTasks)
	newTaskMilestone(t, bt, bobTask.GetId(), "бот чужая", "", 403)
	own := createTask(t, bt, b.GetId(), &v1.CreateTaskRequest{Title: "Задача бота"}, 201)
	newTaskMilestone(t, bt, own.GetId(), "бот", "", 201)
	giveBot(t, o, wid, bt, "edit", perm.EditTasks)
	newTaskMilestone(t, bt, bobTask.GetId(), "бот с EDIT_TASKS", "", 201)

	// View only (CREATE_TASKS denied): every write 403.
	setBoardPerms(o, b.GetId(), 200, userOv(bob.id, 0, perm.CreateTasks))
	newTaskMilestone(t, bob, bobTask.GetId(), "x", "", 403)
}

func testTaskMilestonesEvents(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "События", Key: "TME"}, 201)
	completed := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	parent := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Родитель"}, 201)
	sub := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "подзадача", ParentId: parent.GetId()}, 201)

	gb := dialGW(t)
	gb.identify(bob.token)
	m := newTaskMilestone(t, o, parent.GetId(), "Событие", "2026-12-01", 201).GetMilestone()
	ev := gb.wait("TASK_UPDATE with the milestone", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetTask().GetId() == parent.GetId() && len(e.GetTaskUpdate().GetTask().GetMilestones()) == 1
	})
	if got := ev.GetTaskUpdate().GetTask().GetMilestones()[0]; got.GetId() != m.GetId() || got.GetDueOn() != "2026-12-01" {
		t.Fatalf("event milestone %v", got)
	}
	gb.wait("TASK_ACTIVITY milestones", func(e *v1.DispatchEvent) bool {
		return e.GetTaskActivity().GetActivity().GetKind() == "milestones"
	})
	// Linking a subtask updates the parent's progress; completing it completes the milestone.
	mid := m.GetId()
	patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{TaskMilestoneId: &mid}, 200)
	gb.wait("parent progress 0/1", func(e *v1.DispatchEvent) bool {
		ms := e.GetTaskUpdate().GetTask().GetMilestones()
		return e.GetTaskUpdate().GetTask().GetId() == parent.GetId() && len(ms) == 1 && ms[0].GetTotal() == 1
	})
	patchTask(t, o, sub.GetId(), &v1.UpdateTaskRequest{StatusId: &completed}, 200)
	gb.wait("auto completed", func(e *v1.DispatchEvent) bool {
		ms := e.GetTaskUpdate().GetTask().GetMilestones()
		return e.GetTaskUpdate().GetTask().GetId() == parent.GetId() && len(ms) == 1 && ms[0].GetCompletedAt() != nil
	})
	gb.wait("auto_completed entry", func(e *v1.DispatchEvent) bool {
		a := e.GetTaskActivity().GetActivity()
		return a.GetKind() == "milestones" && a.GetAfter().GetFields()["action"].GetStringValue() == "auto_completed"
	})
}
