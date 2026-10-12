//go:build integration

package app_test

import (
	"context"
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Task notification triggers (ADR-0089).

// noticeOf matches the personal TASK_UPDATE of a task with a notice of kind.
func noticeOf(taskID string, kind v1.TaskNoticeKind) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetTask().GetId() == taskID && e.GetTaskUpdate().GetNotice().GetKind() == kind
	}
}

func setTaskNotifyOff(t *testing.T, u musty, want int, kinds ...v1.TaskNoticeKind) *v1.Me {
	t.Helper()
	off := &v1.TaskNotifyOff{}
	for _, k := range kinds {
		off.Kinds = append(off.Kinds, int32(k))
	}
	var r v1.UpdateMeResponse
	u.must(want, "PATCH", "/api/me", &v1.UpdateMeRequest{TaskNotifyOff: off}, &r)
	return r.GetMe()
}

// TestTaskNotifyTriggers: the settings (mandatory kinds dropped, validation, a settings replace
// keeps them, bots 403) and every new event-driven kind — who gets it, its details, coalesced
// edits notify once, a switched-off kind is skipped, a mention is not WATCHER_ADDED.
func TestTaskNotifyTriggers(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	eve := register(t, invite(t, o, wid))

	// Settings: the mandatory kinds are dropped; unknown / UNSPECIFIED → 422; a `settings`
	// replace leaves the list; bots may not.
	me := setTaskNotifyOff(t, bob, 200, v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED, v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVED,
		v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON, v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED)
	want := []int32{int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON), int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED)}
	if got := me.GetSettings().GetTaskNotifyOff(); !slices.Equal(got, want) {
		t.Fatalf("task_notify_off %v, want %v", got, want)
	}
	setTaskNotifyOff(t, bob, 422, v1.TaskNoticeKind_TASK_NOTICE_KIND_UNSPECIFIED)
	setTaskNotifyOff(t, bob, 422, v1.TaskNoticeKind(999))
	var mr v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_VAD}}, &mr)
	if got := mr.GetMe().GetSettings().GetTaskNotifyOff(); !slices.Equal(got, want) {
		t.Fatalf("a settings replace changed task_notify_off: %v", got)
	}
	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if got := gm.GetMe().GetSettings().GetTaskNotifyOff(); !slices.Equal(got, want) {
		t.Fatalf("GET /api/me task_notify_off %v", got)
	}
	bt := createBot(t, o, wid, "notifybot")
	setTaskNotifyOff(t, bt, 403, v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED)
	if got := setTaskNotifyOff(t, bob, 200).GetSettings().GetTaskNotifyOff(); len(got) != 0 {
		t.Fatalf("cleared task_notify_off %v", got)
	}

	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Триггеры", Key: "TRG"}, 201)
	b2 := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Другая доска", Key: "TRB"}, 201)
	var br v1.BoardResponse
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/milestones", &v1.CreateBoardMilestoneRequest{Name: "Релиз"}, &br)
	milestone := br.GetBoard().GetMilestones()[0].GetId()
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт",
		Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, IsLead: true}, {UserId: carol.id}}}, 201)
	id := task.GetId()

	gb, gc, gd, ge := dialGW(t), dialGW(t), dialGW(t), dialGW(t)
	gb.identify(bob.token)
	gc.identify(carol.token)
	gd.identify(dave.token)
	ge.identify(eve.token)
	got := func(g *gw, kind v1.TaskNoticeKind) *v1.TaskNotice {
		t.Helper()
		n := g.wait(v1.TaskNoticeKind_name[int32(kind)], noticeOf(id, kind)).GetTaskUpdate().GetNotice()
		if n.GetActorId() != o.id {
			t.Fatalf("%v: actor %q, want the owner", kind, n.GetActorId())
		}
		return n
	}
	none := func(g *gw, kind v1.TaskNoticeKind) {
		t.Helper()
		g.quiet(v1.TaskNoticeKind_name[int32(kind)], 300*time.Millisecond, noticeOf(id, kind))
	}

	// DUE_CHANGED with the new date; carol has it off.
	setTaskNotifyOff(t, carol, 200, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_CHANGED)
	due := "2031-01-15"
	patchTask(t, o, id, &v1.UpdateTaskRequest{DueOn: &due}, 200)
	if n := got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_CHANGED); n.GetDueOn() != due {
		t.Fatalf("DUE_CHANGED due_on %q", n.GetDueOn())
	}
	none(gc, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_CHANGED)
	setTaskNotifyOff(t, carol, 200)
	noDue := ""
	patchTask(t, o, id, &v1.UpdateTaskRequest{DueOn: &noDue}, 200)
	if n := got(gc, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_CHANGED); n.GetDueOn() != "" {
		t.Fatalf("removed due: due_on %q", n.GetDueOn())
	}

	// PRIORITY and EDITED: once per coalesced journal entry (ADR-0081).
	high, low := v1.TaskPriority_TASK_PRIORITY_HIGH, v1.TaskPriority_TASK_PRIORITY_LOW
	patchTask(t, o, id, &v1.UpdateTaskRequest{Priority: &high}, 200)
	got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_PRIORITY)
	patchTask(t, o, id, &v1.UpdateTaskRequest{Priority: &low}, 200)
	none(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_PRIORITY)
	title := "Отчёт за квартал"
	patchTask(t, o, id, &v1.UpdateTaskRequest{Title: &title}, 200)
	if n := got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED); n.GetText() != "title" {
		t.Fatalf("EDITED text %q", n.GetText())
	}
	title = "Отчёт за год"
	patchTask(t, o, id, &v1.UpdateTaskRequest{Title: &title}, 200)
	none(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED)

	// MILESTONE with its name; ATTACHMENT with the file name.
	patchTask(t, o, id, &v1.UpdateTaskRequest{MilestoneId: &milestone}, 200)
	if n := got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_MILESTONE); n.GetText() != "Релиз" {
		t.Fatalf("MILESTONE text %q", n.GetText())
	}
	_, f, _ := upload(t, o, "/api/boards/"+b.GetId()+"/files", "смета.png", pngBytes(8, 8))
	patchTask(t, o, id, &v1.UpdateTaskRequest{SetAttachments: true, AttachmentIds: []string{f.GetId()}}, 200)
	if n := got(gc, v1.TaskNoticeKind_TASK_NOTICE_KIND_ATTACHMENT); n.GetText() != "смета.png" {
		t.Fatalf("ATTACHMENT text %q", n.GetText())
	}
	patchTask(t, o, id, &v1.UpdateTaskRequest{SetAttachments: true}, 200) // removing a file: nothing
	none(gc, v1.TaskNoticeKind_TASK_NOTICE_KIND_ATTACHMENT)

	// WATCHER_ADDED to an explicit watcher; a mention makes a watcher with MENTIONED only.
	o.must(200, "PUT", "/api/tasks/"+id+"/watchers", &v1.SetTaskWatcherRequest{UserId: dave.id}, nil)
	got(gd, v1.TaskNoticeKind_TASK_NOTICE_KIND_WATCHER_ADDED)
	desc := "посмотри @" + eve.id
	patchTask(t, o, id, &v1.UpdateTaskRequest{Description: &desc}, 200)
	got(ge, v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED)
	none(ge, v1.TaskNoticeKind_TASK_NOTICE_KIND_WATCHER_ADDED)
	if n := got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED); n.GetText() != "description" {
		t.Fatalf("EDITED (description) text %q", n.GetText())
	}

	// UNASSIGNED: removed (carol), then the lead made a plain assignee (bob).
	o.must(200, "PUT", "/api/tasks/"+id+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, IsLead: true}}}, nil)
	got(gc, v1.TaskNoticeKind_TASK_NOTICE_KIND_UNASSIGNED)
	none(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_UNASSIGNED)
	o.must(200, "PUT", "/api/tasks/"+id+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: carol.id, IsLead: true}, {UserId: bob.id}}}, nil)
	got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_UNASSIGNED)
	got(gc, v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED)

	// MOVED with the new board's name; ARCHIVED.
	b2id := b2.GetId()
	patchTask(t, o, id, &v1.UpdateTaskRequest{BoardId: &b2id}, 200)
	if n := got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_MOVED); n.GetText() != "Другая доска" {
		t.Fatalf("MOVED text %q", n.GetText())
	}
	o.must(200, "POST", "/api/tasks/"+id+"/archive", nil, nil)
	got(gb, v1.TaskNoticeKind_TASK_NOTICE_KIND_ARCHIVED)
}

// TestTaskDueNotices: DUE_SOON the day before and on the due date (days_left 1 / 0) to the
// assignees, OVERDUE the day after to them and the creator, not before 09:00, once (dedup),
// again for a new date; nothing for a finished, archived or switched-off task.
func TestTaskDueNotices(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	ctx := context.Background()
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Сроки", Key: "DUE"}, 201)
	var done string
	for _, st := range b.GetStatuses() {
		if st.GetType() == v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED {
			done = st.GetId()
		}
	}
	// Far from the real date, so the background sweep never touches these tasks.
	day := time.Date(2030, 3, 10, 0, 0, 0, 0, time.UTC)
	date := func(d int) string { return day.AddDate(0, 0, d).Format(time.DateOnly) }
	mk := func(title string, due int, assignees ...string) string {
		in := make([]*v1.TaskAssigneeInput, len(assignees))
		for i, u := range assignees {
			in[i] = &v1.TaskAssigneeInput{UserId: u}
		}
		return createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: title, DueOn: date(due), Assignees: in}, 201).GetId()
	}
	tomorrow := mk("завтра", 1, bob.id)
	today := mk("сегодня", 0, bob.id)
	overdue := mk("вчера", -1, bob.id)
	finished := mk("готово", 1, bob.id)
	sid := done
	patchTask(t, o, finished, &v1.UpdateTaskRequest{StatusId: &sid}, 200)
	archived := mk("в архиве", 1, bob.id)
	o.must(200, "POST", "/api/tasks/"+archived+"/archive", nil, nil)
	offTask := mk("выключено", 1, carol.id)
	setTaskNotifyOff(t, carol, 200, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON)

	gb, gOwner, gc := dialGW(t), dialGW(t), dialGW(t)
	gb.identify(bob.token)
	gOwner.identify(o.token)
	gc.identify(carol.token)
	deliver := func(at time.Time) int {
		t.Helper()
		n, err := testApp.Boards.DeliverDueNoticesAt(ctx, at, time.UTC)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	type due struct {
		task     string
		kind     v1.TaskNoticeKind
		dueOn    string
		daysLeft int32
	}
	// expect reads g's due notices in any order (one pass sends tasks in no particular order).
	expect := func(g *gw, want ...due) {
		t.Helper()
		for len(want) > 0 {
			ev := g.wait("due notices", func(e *v1.DispatchEvent) bool {
				return slices.ContainsFunc(want, func(w due) bool { return noticeOf(w.task, w.kind)(e) })
			})
			n := ev.GetTaskUpdate().GetNotice()
			got := due{ev.GetTaskUpdate().GetTask().GetId(), n.GetKind(), n.GetDueOn(), n.GetDaysLeft()}
			i := slices.Index(want, got)
			if i < 0 || n.GetActorId() != "" {
				t.Fatalf("notice %+v (actor %q), want one of %+v", got, n.GetActorId(), want)
			}
			want = slices.Delete(want, i, i+1)
		}
	}
	anyDue := func(taskID string) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			k := e.GetTaskUpdate().GetNotice().GetKind()
			return e.GetTaskUpdate().GetTask().GetId() == taskID &&
				(k == v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON || k == v1.TaskNoticeKind_TASK_NOTICE_KIND_OVERDUE)
		}
	}

	if n := deliver(day.Add(8 * time.Hour)); n != 0 { // before 09:00
		t.Fatalf("%d notices before 09:00", n)
	}
	if n := deliver(day.Add(12 * time.Hour)); n != 4 {
		t.Fatalf("%d notices, want 4 (tomorrow, today, overdue ×2)", n)
	}
	expect(gb, due{tomorrow, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON, date(1), 1},
		due{today, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON, date(0), 0},
		due{overdue, v1.TaskNoticeKind_TASK_NOTICE_KIND_OVERDUE, date(-1), -1})
	expect(gOwner, due{overdue, v1.TaskNoticeKind_TASK_NOTICE_KIND_OVERDUE, date(-1), -1}) // the creator
	gb.quiet("a finished task's notice", 200*time.Millisecond, anyDue(finished))
	gb.quiet("an archived task's notice", 200*time.Millisecond, anyDue(archived))
	gc.quiet("a switched-off notice", 200*time.Millisecond, anyDue(offTask))

	// Once: the next pass the same day sends nothing.
	if n := deliver(day.Add(12*time.Hour + 5*time.Minute)); n != 0 {
		t.Fatalf("%d notices on the second pass", n)
	}
	gb.quiet("a repeated notice", 200*time.Millisecond, anyDue(tomorrow))

	// A new date clears the old notices: tomorrow → day+2, so on day+1 it is «tomorrow» again;
	// «today» of yesterday is overdue now.
	d2 := date(2)
	patchTask(t, o, tomorrow, &v1.UpdateTaskRequest{DueOn: &d2}, 200)
	var left int
	if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM task_due_notices WHERE task_id = $1", tomorrow).Scan(&left); err != nil || left != 0 {
		t.Fatalf("dedup rows after the due change: %d, %v", left, err)
	}
	deliver(day.AddDate(0, 0, 1).Add(10 * time.Hour))
	expect(gb, due{tomorrow, v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON, d2, 1},
		due{today, v1.TaskNoticeKind_TASK_NOTICE_KIND_OVERDUE, date(0), -1})
}
