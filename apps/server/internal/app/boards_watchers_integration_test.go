//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// watchersOf is the task's watcher ids as the owner sees them.
func watchersOf(t *testing.T, u musty, taskID string) []string {
	t.Helper()
	return getTask(t, u, taskID).GetTask().GetWatcherIds()
}

// eventually polls cond for a few seconds (the comment hook runs after the message).
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout: %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestTaskWatchers (ADR-0076): watchers as a third basis of task-scoped access — who may add
// them, what they see, removal, mentions, restricted boards, guests, bots, plain subscribers.
func TestTaskWatchers(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	eve := register(t, invite(t, o, wid))
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Наблюдение", Key: "WCH", IsPrivate: true}, 201)
	a := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "карточка А"}, 201)
	b := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "карточка Б"}, 201)
	bob.must(404, "GET", "/api/tasks/"+a.GetId(), nil, nil)

	gb := dialGW(t)
	gb.identify(bob.token)

	// A watcher without board access sees only that task (VIEW_BOARD on it): read, comment,
	// subscribe; no edit, no inviting further.
	var tr v1.TaskResponse
	o.must(200, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, &tr)
	if !slices.Contains(tr.GetTask().GetWatcherIds(), bob.id) {
		t.Fatalf("watcher_ids %v", tr.GetTask().GetWatcherIds())
	}
	o.must(200, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil) // no-op
	gb.wait("BOARD_CREATE (scoped) for the watcher", func(e *v1.DispatchEvent) bool {
		return e.GetBoardCreate().GetBoard().GetId() == priv.GetId() && e.GetBoardCreate().GetBoard().GetTaskScoped()
	})
	gb.wait("TASK_CREATE of the watched card", func(e *v1.DispatchEvent) bool {
		return e.GetTaskCreate().GetTask().GetId() == a.GetId()
	})
	if lb := listBoards(t, bob, wid)[priv.GetId()]; lb == nil || !lb.GetTaskScoped() || lb.GetPermissions() != 0 {
		t.Fatalf("watcher's board %v", lb)
	}
	if ks := taskKeys(listTasks(t, bob, priv.GetId(), nil)); len(ks) != 1 || !ks["WCH-1"] {
		t.Fatalf("watcher's tasks %v", ks)
	}
	if r := getTask(t, bob, a.GetId()); !r.GetTask().GetSubscribed() || r.GetRoom() == nil {
		t.Fatal("a watcher is subscribed and sees the room")
	}
	bob.must(404, "GET", "/api/tasks/"+b.GetId(), nil, nil)
	send(t, bob, a.GetRoomId(), "смотрю", uniq("w"))
	title := "нельзя"
	patchTask(t, bob, a.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	bob.must(403, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: carol.id}, nil)
	bob.must(403, "PUT", "/api/tasks/"+a.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: carol.id}}}, nil)
	createTask(t, bob, priv.GetId(), &v1.CreateTaskRequest{Title: "нельзя"}, 403)
	carol.must(404, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: carol.id}, nil)

	// Removal revokes access unless another basis is left: approver keeps it; then gone.
	o.must(200, "PUT", "/api/tasks/"+a.GetId()+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{bob.id}}, nil)
	bob.must(403, "DELETE", "/api/tasks/"+a.GetId()+"/watchers?user_id="+url.QueryEscape(o.id), nil, nil)
	o.must(200, "DELETE", "/api/tasks/"+a.GetId()+"/watchers?user_id="+url.QueryEscape(bob.id), nil, &tr)
	if slices.Contains(tr.GetTask().GetWatcherIds(), bob.id) {
		t.Fatal("removed watcher still listed")
	}
	bob.must(200, "GET", "/api/tasks/"+a.GetId(), nil, nil)
	o.must(200, "PUT", "/api/tasks/"+a.GetId()+"/approvers", &v1.SetTaskApproversRequest{}, nil)
	bob.must(404, "GET", "/api/tasks/"+a.GetId(), nil, nil)
	gb.wait("BOARD_DELETE after the last basis", func(e *v1.DispatchEvent) bool {
		return e.GetBoardDelete().GetBoardId() == priv.GetId()
	})
	// «Перестать наблюдать»: the watcher removes themselves and loses the card.
	o.must(200, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil)
	bob.must(200, "DELETE", "/api/tasks/"+a.GetId()+"/watchers?user_id="+url.QueryEscape(bob.id), nil, nil)
	bob.must(404, "GET", "/api/tasks/"+a.GetId(), nil, nil)
	if _, ok := listBoards(t, bob, wid)[priv.GetId()]; ok {
		t.Fatal("board listed after the watcher left")
	}
	// The plain subscription went with the access: watching again starts unmuted.
	o.must(200, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil)
	if r := getTask(t, bob, a.GetId()); !r.GetTask().GetSubscribed() || r.GetTask().GetMuted() {
		t.Fatal("watcher again: subscribed, not muted")
	}

	// Mentions: by someone who cannot edit the task — no watcher, no access; by an editor —
	// the mentioned become watchers, see the card and get MENTIONED.
	send(t, bob, a.GetRoomId(), "позову @"+eve.id, uniq("m"))
	time.Sleep(200 * time.Millisecond)
	if slices.Contains(watchersOf(t, o, a.GetId()), eve.id) {
		t.Fatal("a non-editor's mention made a watcher")
	}
	eve.must(404, "GET", "/api/tasks/"+a.GetId(), nil, nil)
	ge := dialGW(t)
	ge.identify(eve.token)
	send(t, o, a.GetRoomId(), "смотри @"+eve.id, uniq("m"))
	eventually(t, "eve becomes a watcher", func() bool { return slices.Contains(watchersOf(t, o, a.GetId()), eve.id) })
	ge.wait("MENTIONED notice", func(e *v1.DispatchEvent) bool {
		return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED && e.GetTaskUpdate().GetTask().GetId() == a.GetId()
	})
	eve.must(200, "GET", "/api/tasks/"+a.GetId(), nil, nil)
	eve.must(404, "GET", "/api/tasks/"+b.GetId(), nil, nil)
	// In the description by an editor too.
	desc := "для @" + dave.id
	patchTask(t, o, b.GetId(), &v1.UpdateTaskRequest{Description: &desc}, 200)
	if !slices.Contains(watchersOf(t, o, b.GetId()), dave.id) {
		t.Fatal("description mention by an editor: no watcher")
	}
	dave.must(200, "GET", "/api/tasks/"+b.GetId(), nil, nil)

	// A restricted board now opens by card (ADR-0076 §2) — explicitly and by assignment.
	restricted := true
	o.must(200, "PATCH", "/api/boards/"+priv.GetId(), &v1.UpdateBoardRequest{Restricted: &restricted}, nil)
	dave.must(200, "GET", "/api/tasks/"+b.GetId(), nil, nil)
	o.must(200, "PUT", "/api/tasks/"+b.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: carol.id}, nil)
	carol.must(200, "GET", "/api/tasks/"+b.GetId(), nil, nil)
	if lb := listBoards(t, carol, wid)[priv.GetId()]; lb == nil || !lb.GetTaskScoped() {
		t.Fatal("restricted board not listed for its watcher")
	}
	var pr v1.BoardPermissionsResponse
	o.must(200, "GET", "/api/boards/"+priv.GetId()+"/permissions", nil, &pr)
	if pr.GetTaskScopedCount() != 4 { // bob, eve (A), dave, carol (B)
		t.Fatalf("task_scoped_count %d", pr.GetTaskScopedCount())
	}

	// Guests are never invited, explicitly or by mention.
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.65.9.2"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := gj.GetMe().GetUser().GetId()
	o.must(422, "PUT", "/api/tasks/"+b.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: guest}, nil)
	send(t, o, b.GetRoomId(), "гость @"+guest, uniq("g"))
	time.Sleep(200 * time.Millisecond)
	if slices.Contains(watchersOf(t, o, b.GetId()), guest) {
		t.Fatal("a guest became a watcher by mention")
	}

	// Bots need VIEW_BOARD: refused on the private board; never watchers by mention.
	bt := createBot(t, o, wid, "watchbot")
	o.must(422, "PUT", "/api/tasks/"+b.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bt.id}, nil)
	send(t, o, b.GetRoomId(), "бот @"+bt.id, uniq("b"))
	time.Sleep(200 * time.Millisecond)
	if slices.Contains(watchersOf(t, o, b.GetId()), bt.id) {
		t.Fatal("a bot became a watcher by mention")
	}
	bt.must(404, "GET", "/api/tasks/"+b.GetId(), nil, nil)

	// A plain subscriber removed from the board does not keep the card.
	pub := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Открытая", Key: "OPN"}, 201)
	c := createTask(t, o, pub.GetId(), &v1.CreateTaskRequest{Title: "общая"}, 201)
	bob.must(200, "PUT", "/api/tasks/"+c.GetId()+"/subscription", &v1.SetTaskSubscriptionRequest{}, nil)
	if r := getTask(t, bob, c.GetId()); !r.GetTask().GetSubscribed() || slices.Contains(r.GetTask().GetWatcherIds(), bob.id) {
		t.Fatal("plain subscription is not a watcher")
	}
	private := true
	o.must(200, "PATCH", "/api/boards/"+pub.GetId(), &v1.UpdateBoardRequest{IsPrivate: &private}, nil)
	bob.must(404, "GET", "/api/tasks/"+c.GetId(), nil, nil)
	if _, ok := listBoards(t, bob, wid)[pub.GetId()]; ok {
		t.Fatal("a plain subscriber keeps the board")
	}

	// Archived: the card closes for its watchers; no changes of watchers.
	o.must(200, "POST", "/api/tasks/"+a.GetId()+"/archive", nil, nil)
	eve.must(404, "GET", "/api/tasks/"+a.GetId(), nil, nil)
	o.must(409, "PUT", "/api/tasks/"+a.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: carol.id}, nil)
}
