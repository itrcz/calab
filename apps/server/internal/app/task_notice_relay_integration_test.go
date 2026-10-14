//go:build integration

package app_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Task notice relay to a bot the user chose (ADR-0090).

func setTaskNotifyBots(t *testing.T, u *client, want int, bots ...string) *v1.Me {
	t.Helper()
	var r v1.UpdateMeResponse
	u.must(want, "PATCH", "/api/me", &v1.UpdateMeRequest{TaskNotifyBots: &v1.TaskNotifyBots{BotUserIds: bots}}, &r)
	return r.GetMe()
}

// relayOf matches a TASK_NOTICE of user about task with kind.
func relayOf(user, task string, kind v1.TaskNoticeKind) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool {
		n := e.GetTaskNotice()
		return n.GetUserId() == user && n.GetTask().GetId() == task && n.GetNotice().GetKind() == kind
	}
}

func anyRelay(e *v1.DispatchEvent) bool { return e.GetTaskNotice() != nil }

// hookSink collects the webhook deliveries of several bots (by URL path) with their raw bodies.
type hookSink struct {
	srv  *httptest.Server
	mu   sync.Mutex
	got  map[string][]*v1.DispatchEvent
	raws map[string][]string
}

func newHookSink(t *testing.T) *hookSink {
	h := &hookSink{got: map[string][]*v1.DispatchEvent{}, raws: map[string][]string{}}
	h.srv = httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var u v1.BotWebhookUpdate
		if err := protojson.Unmarshal(body, &u); err == nil {
			h.mu.Lock()
			h.got[r.URL.Path] = append(h.got[r.URL.Path], u.GetEvent())
			h.raws[r.URL.Path] = append(h.raws[r.URL.Path], string(body))
			h.mu.Unlock()
		}
	}))
	t.Cleanup(h.srv.Close)
	botHookCAs.AddCert(h.srv.Certificate())
	return h
}

func (h *hookSink) hook(t *testing.T, b *bot, path string) {
	t.Helper()
	b.must(200, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: h.srv.URL + path, Secret: "0123456789abcdef-secret"}, nil)
}

// wait returns the raw body of the first delivery to path matching pred (within 8 s).
func (h *hookSink) wait(t *testing.T, path, what string, pred func(*v1.DispatchEvent) bool) string {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for i, e := range h.got[path] {
			if pred(e) {
				raw := h.raws[path][i]
				h.mu.Unlock()
				return raw
			}
		}
		h.mu.Unlock()
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("webhook %s: no %s", path, what)
	return ""
}

func (h *hookSink) none(t *testing.T, path, what string, pred func(*v1.DispatchEvent) bool) {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if slices.ContainsFunc(h.got[path], pred) {
		t.Fatalf("webhook %s: unexpected %s", path, what)
	}
}

// TestTaskNoticeRelay: the setting (validation, bots / guests 403, GET), the relay of the
// user's notices to the chosen bot by gateway and webhook (task without the viewer's state, a
// link, no contacts), a kind switched off is not relayed, a mandatory approval always is, the
// due sweep is relayed, a task of a workspace the bot is not in is not, other bots and people
// never get TASK_NOTICE, the bot switched off gets nothing, a deleted bot leaves the list.
func TestTaskNoticeRelay(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	gus := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	anon, _ := anonGuest(t, roomLink(t, o, textRoom(t, o, wid, "гости", false), &v1.CreateRoomInviteRequest{}).GetCode(), "Гость")

	sink := newHookSink(t)
	opsa := createBot(t, o, wid, "Opsa")
	bystander := createBot(t, o, wid, "Bystander")
	sink.hook(t, opsa, "/opsa")
	sink.hook(t, bystander, "/bystander")
	// A bot of a workspace bob is not in.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := createBot(t, o, ws2.GetId(), "Stranger")

	// Settings: only bots bob shares a workspace with, ≤ 10; bots and guest accounts 403; a
	// workspace where the user is a guest does not count.
	for _, bad := range [][]string{{"opsa"}, {stranger.id}, {carol.id}, {opsa.id, stranger.id}} {
		setTaskNotifyBots(t, bob.client, 422, bad...)
		if !strings.Contains(string(bob.lastBody), "TASK_NOTIFY_BOT_UNAVAILABLE") {
			t.Fatalf("422 for %v without the reason: %s", bad, bob.lastBody)
		}
	}
	setTaskNotifyBots(t, opsa.client, 403, opsa.id)
	setTaskNotifyBots(t, anon.client, 403, opsa.id)
	setTaskNotifyBots(t, gus.client, 422, opsa.id)
	if got := setTaskNotifyBots(t, bob.client, 200, opsa.id, opsa.id).GetSettings().GetTaskNotifyBots(); !slices.Equal(got, []string{opsa.id}) {
		t.Fatalf("task_notify_bots %v", got)
	}
	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if got := gm.GetMe().GetSettings().GetTaskNotifyBots(); !slices.Equal(got, []string{opsa.id}) {
		t.Fatalf("GET /api/me task_notify_bots %v", got)
	}

	gOpsa, gBy, gCarol, gBob := dialGW(t), dialGW(t), dialGW(t), dialGW(t)
	gOpsa.identify(opsa.token)
	gBy.identify(bystander.token)
	gCarol.identify(carol.token)
	gBob.identify(bob.token)

	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Релеи", Key: "RLY"}, 201)
	setNotifyDelay(t, o, b.GetId(), 0, 200)
	var started string
	for _, st := range b.GetStatuses() {
		if st.GetType() == v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED {
			started = st.GetId()
		}
	}
	bobsTask := func(title string) *v1.Task {
		return createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: title, Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, IsLead: true}}}, 201)
	}
	status := v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS

	// A status change of bob's task: bob's notice, relayed to Opsa by gateway and webhook.
	task := bobsTask("Отчёт")
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{StatusId: &started}, 200)
	gBob.wait("bob's STATUS", noticeOf(task.GetId(), status))
	n := gOpsa.wait("TASK_NOTICE STATUS", relayOf(bob.id, task.GetId(), status)).GetTaskNotice()
	if n.GetWorkspaceId() != wid || n.GetTask().GetKey() != task.GetKey() || n.GetBoardKey() != "RLY" || n.GetBoardName() != "Релеи" ||
		!strings.HasSuffix(n.GetTaskUrl(), "/t/"+task.GetKey()) || n.GetNotice().GetActorId() != o.id || n.GetTask().GetStatusId() != started {
		t.Fatalf("relay %v", n)
	}
	if tk := n.GetTask(); tk.GetSubscribed() || tk.GetUnread() || tk.GetViewerState() || tk.GetMuted() {
		t.Fatalf("relay carries the viewer's state: %v", tk)
	}
	raw := sink.wait(t, "/opsa", "taskNotice", relayOf(bob.id, task.GetId(), status))
	if !strings.Contains(raw, `"taskNotice"`) || strings.Contains(raw, bob.email) || strings.Contains(raw, o.email) {
		t.Fatalf("webhook body %s", raw)
	}

	// STATUS switched off: not relayed; a mandatory approval request is, regardless.
	setTaskNotifyOff(t, bob, 200, status)
	task2 := bobsTask("Смета")
	patchTask(t, o, task2.GetId(), &v1.UpdateTaskRequest{StatusId: &started}, 200)
	gOpsa.quiet("a switched-off kind", 400*time.Millisecond, relayOf(bob.id, task2.GetId(), status))
	approval := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Бюджет", ApproverIds: []string{bob.id}}, 201)
	gOpsa.wait("TASK_NOTICE APPROVAL_REQUESTED", relayOf(bob.id, approval.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED))
	sink.wait(t, "/opsa", "approval taskNotice", relayOf(bob.id, approval.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED))
	setTaskNotifyOff(t, bob, 200)

	// The due sweep (DUE_SOON) goes the same way. Far from the real date (no background sweep).
	day := time.Date(2033, 5, 10, 0, 0, 0, 0, time.UTC)
	due := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Срок", DueOn: day.AddDate(0, 0, 1).Format(time.DateOnly),
		Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	if _, err := testApp.Boards.DeliverDueNoticesAt(context.Background(), day.Add(12*time.Hour), time.UTC); err != nil {
		t.Fatal(err)
	}
	if n := gOpsa.wait("TASK_NOTICE DUE_SOON", relayOf(bob.id, due.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON)).GetTaskNotice(); n.GetNotice().GetDaysLeft() != 1 {
		t.Fatalf("DUE_SOON relay %v", n.GetNotice())
	}

	// A task of a workspace Opsa is not a member of: bob is notified, Opsa gets nothing.
	ws3 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws3.GetId())+"/join", nil, nil)
	b3 := createBoard(t, o, ws3.GetId(), &v1.CreateBoardRequest{Name: "Чужая", Key: "OUT"}, 201)
	var started3 string
	for _, st := range b3.GetStatuses() {
		if st.GetType() == v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED {
			started3 = st.GetId()
		}
	}
	outside := createTask(t, o, b3.GetId(), &v1.CreateTaskRequest{Title: "Вне", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	patchTask(t, o, outside.GetId(), &v1.UpdateTaskRequest{StatusId: &started3}, 200)
	gBob.wait("bob's STATUS in ws3", noticeOf(outside.GetId(), status))
	gOpsa.quiet("a task of another workspace", 400*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetTaskNotice().GetTask().GetId() == outside.GetId()
	})

	// Other bots and people never get TASK_NOTICE.
	gBy.quiet("TASK_NOTICE to another bot", 200*time.Millisecond, anyRelay)
	gCarol.quiet("TASK_NOTICE to a person", 200*time.Millisecond, anyRelay)
	gBob.quiet("TASK_NOTICE to the user", 200*time.Millisecond, anyRelay)
	sink.none(t, "/bystander", "taskNotice", anyRelay)
	sink.none(t, "/opsa", "taskNotice of another workspace or a switched-off kind", func(e *v1.DispatchEvent) bool {
		return e.GetTaskNotice().GetTask().GetId() == outside.GetId() || relayOf(bob.id, task2.GetId(), status)(e)
	})

	// Opsa switched off: nothing.
	if got := setTaskNotifyBots(t, bob.client, 200).GetSettings().GetTaskNotifyBots(); len(got) != 0 {
		t.Fatalf("cleared task_notify_bots %v", got)
	}
	task3 := bobsTask("Выключено")
	patchTask(t, o, task3.GetId(), &v1.UpdateTaskRequest{StatusId: &started}, 200)
	gBob.wait("bob's STATUS", noticeOf(task3.GetId(), status))
	gOpsa.quiet("a bot switched off", 400*time.Millisecond, anyRelay)

	// A deleted bot leaves the list.
	setTaskNotifyBots(t, bob.client, 200, opsa.id)
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/bots/"+opsa.id, nil, nil)
	bob.must(200, "GET", "/api/me", nil, &gm)
	if got := gm.GetMe().GetSettings().GetTaskNotifyBots(); len(got) != 0 {
		t.Fatalf("a deleted bot stays in task_notify_bots: %v", got)
	}
}

// TestTaskNoticeRelayAccess (second review of ADR-0090): the relay follows the user's own
// visibility and the bot's standing at send time. A private board the bot cannot view is
// relayed while the user sees it; once the user loses access, nothing is. A bot blocked by the
// user and a bot that left the task's workspace (still in another one with the user) get
// nothing, while the id stays in the list.
func TestTaskNoticeRelayAccess(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	opsa := createBot(t, o, wid, "Opsa")
	setTaskNotifyBots(t, bob.client, 200, opsa.id)
	gOpsa, gBob := dialGW(t), dialGW(t)
	gOpsa.identify(opsa.token)
	gBob.identify(bob.token)
	status := v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS
	startedOf := func(b *v1.Board) string {
		for _, st := range b.GetStatuses() {
			if st.GetType() == v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED {
				return st.GetId()
			}
		}
		t.Fatal("no STARTED status")
		return ""
	}

	// A private board: bob may view it, the bot may not (no VIEW_BOARD): relayed (ADR-0090 §4).
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "HR", Key: "HRR", IsPrivate: true}, 201)
	setBoardPerms(o, priv.GetId(), 200, userOv(bob.id, perm.ViewBoard, 0))
	opsa.must(404, "GET", "/api/boards/"+priv.GetId(), nil, nil)
	started := startedOf(priv)
	// bob subscribes (not an assignee: an assignee keeps the task by task-scoped access).
	secret := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "Оффер"}, 201)
	bob.must(200, "PUT", "/api/tasks/"+secret.GetId()+"/subscription", &v1.SetTaskSubscriptionRequest{}, nil)
	patchTask(t, o, secret.GetId(), &v1.UpdateTaskRequest{StatusId: &started}, 200)
	gBob.wait("bob's STATUS on the private board", noticeOf(secret.GetId(), status))
	gOpsa.wait("TASK_NOTICE of the private board", relayOf(bob.id, secret.GetId(), status))

	// bob loses access to the board (still subscribed): no notice for him, nothing relayed.
	setBoardPerms(o, priv.GetId(), 200)
	todo := priv.GetStatuses()[0].GetId()
	patchTask(t, o, secret.GetId(), &v1.UpdateTaskRequest{StatusId: &todo}, 200)
	gBob.quiet("a notice of a board bob no longer sees", 400*time.Millisecond, noticeOf(secret.GetId(), status))
	gOpsa.quiet("a relay after bob lost access", 400*time.Millisecond, anyRelay)

	// A public board for the rest.
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Ops", Key: "OPR"}, 201)
	started = startedOf(b)
	bobsTask := func(boardID, title string) *v1.Task {
		return createTask(t, o, boardID, &v1.CreateTaskRequest{Title: title, Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, IsLead: true}}}, 201)
	}

	// bob blocks the bot: nothing; unblocked: relayed again.
	bob.must(204, "POST", "/api/me/blocked-bots/"+opsa.id, nil, nil)
	blocked := bobsTask(b.GetId(), "Блок")
	patchTask(t, o, blocked.GetId(), &v1.UpdateTaskRequest{StatusId: &started}, 200)
	gBob.wait("bob's STATUS", noticeOf(blocked.GetId(), status))
	gOpsa.quiet("a relay to a blocked bot", 400*time.Millisecond, anyRelay)
	bob.must(204, "DELETE", "/api/me/blocked-bots/"+opsa.id, nil, nil)

	// The bot is added to a second workspace of bob's and removed from it again: relayed while
	// a member, then not — while it stays chosen (it still shares the first workspace).
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws2.GetId())+"/join", nil, nil)
	o.must(201, "POST", "/api/workspaces/"+ws2.GetId()+"/bots/add", &v1.AddBotRequest{BotUserId: opsa.id}, nil)
	b2 := createBoard(t, o, ws2.GetId(), &v1.CreateBoardRequest{Name: "Second", Key: "SND"}, 201)
	started2 := startedOf(b2)
	in := bobsTask(b2.GetId(), "Внутри")
	patchTask(t, o, in.GetId(), &v1.UpdateTaskRequest{StatusId: &started2}, 200)
	gOpsa.wait("TASK_NOTICE in the second workspace", relayOf(bob.id, in.GetId(), status))
	o.must(204, "DELETE", "/api/workspaces/"+ws2.GetId()+"/bots/"+opsa.id, nil, nil)
	left := bobsTask(b2.GetId(), "Ушёл")
	patchTask(t, o, left.GetId(), &v1.UpdateTaskRequest{StatusId: &started2}, 200)
	gBob.wait("bob's STATUS in the second workspace", noticeOf(left.GetId(), status))
	gOpsa.quiet("a relay to a bot that left the workspace", 400*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetTaskNotice().GetTask().GetId() == left.GetId()
	})
	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if got := gm.GetMe().GetSettings().GetTaskNotifyBots(); !slices.Equal(got, []string{opsa.id}) {
		t.Fatalf("task_notify_bots after the bot left a workspace: %v", got)
	}
}
