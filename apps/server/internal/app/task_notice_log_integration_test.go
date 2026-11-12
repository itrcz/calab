//go:build integration

package app_test

import (
	"context"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestTaskNoticeLog (ADR-0141): a notice the server sends is kept in the recipient's history
// with the live notice's id; the list is the recipient's own, newest first, paged, with the
// task's current key and title, and hides tasks the recipient no longer sees.
func TestTaskNoticeLog(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	list := func(u *user, query string) *v1.ListTaskNoticesResponse {
		t.Helper()
		var out v1.ListTaskNoticesResponse
		u.must(200, "GET", "/api/me/task-notices"+query, nil, &out)
		return &out
	}
	if n := len(list(bob, "").GetEntries()); n != 0 { // bob is a fresh user; the owner is shared
		t.Fatalf("a fresh user has %d notices", n)
	}
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Входящие", Key: "INB"}, 201)
	gb := dialGW(t)
	gb.identify(bob.token)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	live := gb.wait("assigned", noticeOf(task.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED)).GetTaskUpdate().GetNotice()
	if live.GetId() == "" {
		t.Fatal("the live notice has no history id")
	}
	// A comment mentioning bob: a second notice, newer.
	send(t, o, task.GetRoomId(), "глянь @"+bob.id, "")
	gb.wait("mentioned", noticeOf(task.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED))

	got := list(bob, "")
	es := got.GetEntries()
	if len(es) != 2 || got.GetHasMore() {
		t.Fatalf("bob notices: %v", es)
	}
	if es[0].GetNotice().GetKind() != v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED || es[1].GetId() != live.GetId() {
		t.Fatalf("order / ids: %v", es)
	}
	e := es[1]
	if e.GetTaskId() != task.GetId() || e.GetTaskKey() != "INB-1" || e.GetTaskTitle() != "Отчёт" || e.GetWorkspaceId() != wid ||
		e.GetBoardId() != b.GetId() || e.GetNotice().GetActorId() != o.id || e.GetCreatedAt() == nil {
		t.Fatalf("entry: %v", e)
	}
	if es[0].GetNotice().GetMessageId() == "" {
		t.Fatal("a comment mention carries the comment id")
	}
	// The owner made the changes: nothing of this task for them.
	for _, e := range list(o, "?limit=100").GetEntries() {
		if e.GetTaskId() == task.GetId() {
			t.Fatalf("the actor got their own notice: %v", e)
		}
	}
	// Pages.
	page := list(bob, "?limit=1")
	if len(page.GetEntries()) != 1 || !page.GetHasMore() {
		t.Fatal("first page")
	}
	page = list(bob, "?limit=1&before="+page.GetEntries()[0].GetId())
	if len(page.GetEntries()) != 1 || page.GetHasMore() || page.GetEntries()[0].GetId() != live.GetId() {
		t.Fatal("second page")
	}
	bob.must(400, "GET", "/api/me/task-notices?after="+live.GetId(), nil, nil)
	// The title is the current one.
	o.must(200, "PATCH", "/api/tasks/"+task.GetId(), &v1.UpdateTaskRequest{Title: new("Отчёт за квартал")}, nil)
	if e := list(bob, "").GetEntries(); len(e) == 0 || e[len(e)-1].GetTaskTitle() != "Отчёт за квартал" {
		t.Fatalf("renamed: %v", e)
	}
	// Removed from the workspace: the history is hidden.
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+bob.id, nil, nil)
	if n := len(list(bob, "").GetEntries()); n != 0 {
		t.Fatalf("a former member sees %d notices", n)
	}
}

// TestTaskNoticeLogHiddenPage (ADR-0141 review): a page whose rows are all of tasks the caller
// no longer sees lists nothing of them (no key, title or actor) but still moves the cursor past
// them, so the older notices of tasks still seen are reachable; the batch write keeps one row
// per recipient; the prune drops notices past the retention.
func TestTaskNoticeLogHiddenPage(t *testing.T) {
	ctx := context.Background()
	o, bob, ws, _ := setupTeam(t)
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws2.GetId())+"/join", nil, nil)
	carol := register(t, invite(t, o, ws.GetId()))
	gb := dialGW(t)
	gb.identify(bob.token)

	// The oldest: a task of the second workspace, seen throughout.
	b2 := createBoard(t, o, ws2.GetId(), &v1.CreateBoardRequest{Name: "Видно", Key: "VIS"}, 201)
	kept := createTask(t, o, b2.GetId(), &v1.CreateTaskRequest{Title: "Остаётся", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	gb.wait("kept", noticeOf(kept.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED))
	// Newer: two notices of a task in the first workspace, which bob then leaves. Carol gets
	// the same assignment in the same change: one row each.
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Скрыто", Key: "HID"}, 201)
	hidden := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Секрет",
		Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}, {UserId: carol.id}}}, 201)
	gb.wait("hidden", noticeOf(hidden.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED))
	send(t, o, hidden.GetRoomId(), "секрет @"+bob.id, "")
	gb.wait("hidden mention", noticeOf(hidden.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED))
	var rows int
	if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM task_notice_log WHERE task_id = $1 AND kind = $2",
		hidden.GetId(), int16(v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED)).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("assigned rows of the hidden task: %d %v, want bob's and carol's", rows, err)
	}
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/members/"+bob.id, nil, nil)

	var first v1.ListTaskNoticesResponse
	bob.must(200, "GET", "/api/me/task-notices?limit=2", nil, &first)
	if len(first.GetEntries()) != 0 || !first.GetHasMore() || first.GetNextBefore() == "" {
		t.Fatalf("a page of hidden notices: %v", &first)
	}
	var second v1.ListTaskNoticesResponse
	bob.must(200, "GET", "/api/me/task-notices?limit=2&before="+first.GetNextBefore(), nil, &second)
	es := second.GetEntries()
	if len(es) != 1 || es[0].GetTaskId() != kept.GetId() || second.GetHasMore() || second.GetNextBefore() != "" {
		t.Fatalf("the page after the hidden ones: %v", &second)
	}

	// Retention: a notice older than 90 days is pruned, a recent one stays.
	if _, err := testDB.Pool.Exec(ctx, "UPDATE task_notice_log SET created_at = now() - interval '91 days' WHERE task_id = $1", hidden.GetId()); err != nil {
		t.Fatal(err)
	}
	if err := testApp.Boards.PruneNoticeLog(ctx); err != nil {
		t.Fatal(err)
	}
	var left, keptRows int
	if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FILTER (WHERE task_id = $1), count(*) FILTER (WHERE task_id = $2) FROM task_notice_log",
		hidden.GetId(), kept.GetId()).Scan(&left, &keptRows); err != nil || left != 0 || keptRows != 1 {
		t.Fatalf("after the prune: hidden %d kept %d %v", left, keptRows, err)
	}
}

// TestRecentTasks (CBF-179): «Недавние» lists one entry per task — its latest notice — newest
// first, of the workspace asked only; a read task stays; a task the caller no longer sees (a
// private board's task he was taken off) drops out; a non-member gets 404.
func TestRecentTasks(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws2.GetId())+"/join", nil, nil)
	recent := func(ws string) []*v1.TaskNoticeEntry {
		t.Helper()
		var out v1.ListTaskNoticesResponse
		bob.must(200, "GET", "/api/workspaces/"+ws+"/recent-tasks", nil, &out)
		if out.GetHasMore() {
			t.Fatal("recent tasks never page")
		}
		return out.GetEntries()
	}
	if n := len(recent(wid)); n != 0 {
		t.Fatalf("a fresh user has %d recent tasks", n)
	}
	gb := dialGW(t)
	gb.identify(bob.token)
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Недавние", Key: "REC"}, 201)
	a := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Первая", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	gb.wait("a assigned", noticeOf(a.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED))
	c := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Вторая", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	gb.wait("c assigned", noticeOf(c.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED))
	b2 := createBoard(t, o, ws2.GetId(), &v1.CreateBoardRequest{Name: "Другое", Key: "OTH"}, 201)
	other := createTask(t, o, b2.GetId(), &v1.CreateTaskRequest{Title: "Чужая", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	gb.wait("other assigned", noticeOf(other.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED))
	// A new notice of the first task moves it to the top: one entry, the mention.
	send(t, o, a.GetRoomId(), "глянь @"+bob.id, "")
	gb.wait("a mentioned", noticeOf(a.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED))
	bob.must(200, "PUT", "/api/tasks/"+a.GetId()+"/read", nil, nil) // read: still listed

	es := recent(wid)
	if len(es) != 2 || es[0].GetTaskId() != a.GetId() || es[1].GetTaskId() != c.GetId() {
		t.Fatalf("recent: %v", es)
	}
	if es[0].GetNotice().GetKind() != v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED || es[0].GetTaskKey() != "REC-1" ||
		es[0].GetTaskTitle() != "Первая" || es[0].GetBoardId() != b.GetId() || es[0].GetWorkspaceId() != wid || es[0].GetCreatedAt() == nil {
		t.Fatalf("latest entry: %v", es[0])
	}
	if es2 := recent(ws2.GetId()); len(es2) != 1 || es2[0].GetTaskId() != other.GetId() {
		t.Fatalf("second workspace: %v", es2)
	}
	// The board turns private and bob is taken off the second task: it leaves his list (the
	// first one he is still assigned to stays).
	o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{IsPrivate: new(true)}, nil)
	o.must(200, "PUT", "/api/tasks/"+c.GetId()+"/assignees", &v1.SetAssigneesRequest{}, nil)
	if es := recent(wid); len(es) != 1 || es[0].GetTaskId() != a.GetId() {
		t.Fatalf("a task bob no longer sees is listed: %v", es)
	}
	// Not a member of the workspace: 404.
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+bob.id, nil, nil)
	bob.must(404, "GET", "/api/workspaces/"+wid+"/recent-tasks", nil, nil)
}
