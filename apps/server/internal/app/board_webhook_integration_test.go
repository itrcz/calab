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
	webhookpkg "github.com/calaba/calaba/server/internal/webhook"
)

// Board webhooks (ADR-0058 §4, §5).

type boardHookRecv struct {
	t      *testing.T
	mu     sync.Mutex
	secret string
	got    []*v1.BoardWebhookEvent
	hdrs   []http.Header
	bad    int
	fail   bool
	srv    *httptest.Server
}

func newBoardHookRecv(t *testing.T) *boardHookRecv {
	h := &boardHookRecv{t: t}
	h.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		defer h.mu.Unlock()
		var ev v1.BoardWebhookEvent
		if err := webhookpkg.Verify([]byte(h.secret), r.Header, body, time.Now()); err != nil || protojson.Unmarshal(body, &ev) != nil ||
			r.Header.Get("X-Calab-Event") != ev.GetType() || r.Header.Get("X-Calab-Delivery") != ev.GetId() {
			h.bad++
		}
		if h.fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		h.got = append(h.got, &ev)
		h.hdrs = append(h.hdrs, r.Header.Clone())
	}))
	botHookCAs.AddCert(h.srv.Certificate())
	t.Cleanup(h.srv.Close)
	return h
}

// wait returns the delivered events once pred holds (5 s).
func (h *boardHookRecv) wait(what string, pred func([]*v1.BoardWebhookEvent) bool) []*v1.BoardWebhookEvent {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		cp := slices.Clone(h.got)
		bad := h.bad
		h.mu.Unlock()
		if bad > 0 {
			h.t.Fatalf("%d deliveries with a bad signature or body", bad)
		}
		if pred(cp) {
			return cp
		}
		time.Sleep(50 * time.Millisecond)
	}
	h.t.Fatalf("timeout waiting for %s", what)
	return nil
}

func (h *boardHookRecv) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.got)
}

func pendingDeliveries(t *testing.T, boardID string) int {
	t.Helper()
	var n int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM board_webhook_deliveries WHERE board_id = $1", boardID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Setup rights and plan, delivery of task / comment events with the v1 signature, sequence,
// one event per transaction, rollback, ping, pause on downgrade, resume on upgrade, delete.
func TestBoardWebhook(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Hooks", Key: "WHK"}, 201)
	path := "/api/boards/" + b.GetId() + "/webhook"
	recv := newBoardHookRecv(t)

	// Plan: Team → 409 PLAN_LIMIT; Business → allowed.
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	st, e := o.apiErrBody("PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL})
	wantPlanLimit(t, "webhook on Team", st, e, 0, 0)
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})

	// Rights: MANAGE_BOARD alone sees it but cannot change it (MANAGE_INTEGRATIONS); bots never.
	bob.must(403, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL}, nil)
	setBoardPerms(o, b.GetId(), 200, userOv(bob.id, perm.ManageBoard, 0))
	bob.must(403, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL}, nil)
	bt := createBot(t, o, wid, "hookbot")
	bt.must(403, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL}, nil)
	bt.must(403, "GET", path, nil, nil)

	// Validation: https only, secret 16..256.
	o.must(422, "PUT", path, &v1.SetBoardWebhookRequest{Url: strings.Replace(recv.srv.URL, "https", "http", 1)}, nil)
	o.must(422, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL, Secret: "short"}, nil)
	var none v1.BoardWebhookResponse
	o.must(200, "GET", path, nil, &none)
	if none.GetWebhook() != nil {
		t.Fatalf("no webhook yet: %v", none.GetWebhook())
	}

	// PUT without a secret: generated, returned once; GET never returns it.
	var wr v1.BoardWebhookResponse
	o.must(200, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL + "/calab"}, &wr)
	secret := wr.GetSecret()
	if len(secret) != 43 || !wr.GetWebhook().GetEnabled() || !wr.GetWebhook().GetHasSecret() || wr.GetWebhook().GetCreatedBy() != o.id {
		t.Fatalf("PUT: secret %q, %v", secret, wr.GetWebhook())
	}
	recv.mu.Lock()
	recv.secret = secret
	recv.mu.Unlock()
	var gr v1.BoardWebhookResponse
	bob.must(200, "GET", path, nil, &gr)
	if strings.Contains(string(bob.lastBody), secret) || gr.GetSecret() != "" || gr.GetWebhook().GetUrl() != recv.srv.URL+"/calab" {
		t.Fatalf("GET leaks the secret or lost the URL: %s", bob.lastBody)
	}

	// Ping: synchronous, then rate limited.
	var pr v1.BoardWebhookPingResponse
	o.must(200, "POST", path+"/ping", nil, &pr)
	if !pr.GetOk() || pr.GetStatus() != 200 {
		t.Fatalf("ping: %v", &pr)
	}
	o.must(429, "POST", path+"/ping", nil, nil)
	evs := recv.wait("ping", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 1 })
	if evs[0].GetType() != "ping" || evs[0].GetVersion() != 1 || evs[0].GetBoard().GetKey() != b.GetKey() || evs[0].GetTask() != nil {
		t.Fatalf("ping event: %v", evs[0])
	}
	if h := recv.hdrs[0]; h.Get("User-Agent") != "Calab-Webhook/1.0" || h.Get("X-Calab-Webhook-Version") != "1" {
		t.Fatalf("headers: %v", h)
	}

	// Task created; then one PATCH of two fields = one event with two changes; sequence grows.
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт"}, 201)
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{Title: new("Отчёт за квартал"), Priority: new(v1.TaskPriority_TASK_PRIORITY_HIGH)}, 200)
	evs = recv.wait("task events", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 3 })
	slices.SortFunc(evs, func(a, b *v1.BoardWebhookEvent) int { return int(a.GetSequence()) - int(b.GetSequence()) })
	c, u := evs[1], evs[2]
	if c.GetType() != "task.created" || c.GetSequence() != 1 || c.GetTask().GetId() != task.GetId() || c.GetActor().GetId() != o.id ||
		c.GetWorkspaceId() != wid || !strings.HasSuffix(c.GetTaskUrl(), "/t/"+task.GetKey()) {
		t.Fatalf("created: %v", c)
	}
	var fields []string
	for _, ch := range u.GetChanges() {
		fields = append(fields, ch.GetField())
	}
	slices.Sort(fields)
	if u.GetType() != "task.updated" || u.GetSequence() != 2 || !slices.Equal(fields, []string{"priority", "title"}) ||
		u.GetTask().GetTitle() != "Отчёт за квартал" {
		t.Fatalf("updated: %v (fields %v)", u, fields)
	}

	// Comments: created, edited, deleted (without its text).
	var cr v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "готово"}, &cr)
	mid := cr.GetMessage().GetId()
	o.must(200, "PATCH", "/api/messages/"+mid, &v1.UpdateMessageRequest{Content: "готово!"}, nil)
	o.must(204, "DELETE", "/api/messages/"+mid, nil, nil)
	evs = recv.wait("comment events", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 6 })
	byType := map[string]*v1.BoardWebhookEvent{}
	for _, ev := range evs {
		byType[ev.GetType()] = ev
	}
	if ev := byType["task.comment.created"]; ev.GetComment().GetId() != mid || ev.GetComment().GetText() != "готово" || ev.GetSequence() != 3 {
		t.Fatalf("comment created: %v", ev)
	}
	if ev := byType["task.comment.updated"]; ev.GetComment().GetText() != "готово!" || ev.GetComment().GetEditedAt() == nil {
		t.Fatalf("comment updated: %v", ev)
	}
	if ev := byType["task.comment.deleted"]; ev.GetComment().GetId() != mid || ev.GetComment().GetText() != "" {
		t.Fatalf("comment deleted: %v", ev)
	}

	// Rollback: a change whose transaction fails at commit leaves no delivery (the outbox row
	// is written in that transaction).
	before := pendingDeliveries(t, b.GetId())
	ddl := func(sql string) {
		t.Helper()
		if _, err := testDB.Pool.Exec(context.Background(), sql); err != nil {
			t.Fatal(err)
		}
	}
	fn := "test_fail_" + strings.ReplaceAll(b.GetId(), "-", "")
	ddl(`CREATE FUNCTION ` + fn + `() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback test'; END $$`)
	ddl(`CREATE CONSTRAINT TRIGGER ` + fn + ` AFTER INSERT ON board_webhook_deliveries DEFERRABLE INITIALLY DEFERRED
		FOR EACH ROW WHEN (NEW.board_id = '` + b.GetId() + `') EXECUTE FUNCTION ` + fn + `()`)
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{Title: new("Не сохранится")}, 500)
	ddl(`DROP TRIGGER ` + fn + ` ON board_webhook_deliveries`)
	ddl(`DROP FUNCTION ` + fn + `()`)
	if n := pendingDeliveries(t, b.GetId()); n != before {
		t.Fatalf("deliveries after a rollback: %d, want %d", n, before)
	}
	if getTask(t, o, task.GetId()).GetTask().GetTitle() != "Отчёт за квартал" {
		t.Fatal("the failed change was committed")
	}

	// Downgrade over the limits (ADR-0086): refused with the violation, then overridden by the
	// superadmin explicitly and written to the plan log.
	st, ae := superadminUser(t).apiErrBody("PUT", "/api/admin/workspaces/"+wid+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	if st != 409 || ae.GetReason() != "PLAN_LIMITS_EXCEEDED" || len(ae.GetPlanLimitsExceeded().GetViolations()) != 1 ||
		ae.GetPlanLimitsExceeded().GetViolations()[0].GetKind() != v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS {
		t.Fatalf("downgrade without override: %d %v", st, ae)
	}
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Note: "downgrade", OverrideLimits: true})
	var planLog v1.AdminPlanLogResponse
	superadminUser(t).must(200, "GET", "/api/admin/workspaces/"+wid+"/plan/log", nil, &planLog)
	if n := planLog.GetEntries()[0].GetNote(); n != "downgrade [over limits: board_webhooks 1>0]" {
		t.Fatalf("plan log note %q", n)
	}
	o.must(200, "GET", path, nil, &gr)
	if gr.GetWebhook().GetPausedReason() != v1.BoardWebhookPauseReason_BOARD_WEBHOOK_PAUSE_REASON_PLAN {
		t.Fatalf("paused: %v", gr.GetWebhook())
	}
	before = pendingDeliveries(t, b.GetId())
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{Title: new("На паузе")}, 200)
	if n := pendingDeliveries(t, b.GetId()); n != before {
		t.Fatalf("queued while paused: %d, want %d", n, before)
	}
	o.must(409, "POST", path+"/ping", nil, nil)
	// Upgrade: delivery resumes with new events (the paused change is not replayed).
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	n0 := recv.count()
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{Title: new("Снова")}, 200)
	evs = recv.wait("resumed", func(g []*v1.BoardWebhookEvent) bool { return len(g) == n0+1 })
	if last := evs[len(evs)-1]; last.GetTask().GetTitle() != "Снова" || last.GetSequence() != 6 {
		t.Fatalf("resumed: %v", last)
	}

	// DELETE: gone; the queue is marked failed.
	bob.must(403, "DELETE", path, nil, nil)
	o.must(204, "DELETE", path, nil, nil)
	o.must(200, "GET", path, nil, &gr)
	if gr.GetWebhook() != nil {
		t.Fatalf("deleted: %v", gr.GetWebhook())
	}
	o.must(404, "DELETE", path, nil, nil)
}

// Failures are retried with the backoff and a webhook failing for the give-up time is disabled
// (short Options of the test app); PUT enables it again.
func TestBoardWebhookDisable(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Failing", Key: "WHF"}, 201)
	path := "/api/boards/" + b.GetId() + "/webhook"
	recv := newBoardHookRecv(t)
	recv.fail = true
	secret := "0123456789abcdef-board"
	recv.secret = secret
	var wr v1.BoardWebhookResponse
	o.must(200, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL, Secret: secret}, &wr)
	if wr.GetSecret() != secret {
		t.Fatalf("secret echo: %q", wr.GetSecret())
	}
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x"}, 201)
	deadline := time.Now().Add(10 * time.Second)
	for {
		o.must(200, "GET", path, nil, &wr)
		if !wr.GetWebhook().GetEnabled() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("webhook not disabled: %v", wr.GetWebhook())
		}
		time.Sleep(200 * time.Millisecond)
	}
	if w := wr.GetWebhook(); w.GetDisabledAt() == nil || w.GetLastError() != "HTTP 500" || w.GetPending() != 0 || w.GetFailingSince() == nil {
		t.Fatalf("disabled webhook: %v", w)
	}
	var attempts int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT max(attempts) FROM board_webhook_deliveries WHERE board_id = $1", b.GetId()).Scan(&attempts); err != nil || attempts < 3 {
		t.Fatalf("attempts %d, %v", attempts, err)
	}
	// Disabled: new changes are not queued; PUT re-enables and delivery resumes.
	recv.mu.Lock()
	recv.fail = false
	recv.mu.Unlock()
	o.must(200, "PUT", path, &v1.SetBoardWebhookRequest{Url: recv.srv.URL, Secret: secret}, &wr)
	if !wr.GetWebhook().GetEnabled() {
		t.Fatalf("re-enabled: %v", wr.GetWebhook())
	}
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "y"}, 201)
	recv.wait("after re-enable", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 1 && g[0].GetTask().GetTitle() == "y" })
}

// Checklist writes are task changes: each queues task.updated with a "checklist" change in its
// own transaction; convert queues task.created for the subtask and task.updated for the parent.
func TestBoardWebhookChecklist(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Hook lists", Key: "WHC"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Релиз"}, 201)
	recv := newBoardHookRecv(t)
	recv.secret = "0123456789abcdef0123"
	o.must(200, "PUT", "/api/boards/"+b.GetId()+"/webhook", &v1.SetBoardWebhookRequest{Url: recv.srv.URL, Secret: recv.secret}, nil)

	cl := newChecklist(t, o, task.GetId(), "Шаги", 201).GetChecklist()
	it := newItem(t, o, cl.GetId(), "собрать", 201).GetChecklist().GetItems()[0]
	done := true
	o.must(200, "PATCH", "/api/checklist-items/"+it.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	conv := newItem(t, o, cl.GetId(), "выкатить", 201).GetChecklist().GetItems()[1]
	var cr v1.ConvertChecklistItemResponse
	o.must(201, "POST", "/api/checklist-items/"+conv.GetId()+"/convert", nil, &cr)

	evs := recv.wait("checklist events", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 6 })
	slices.SortFunc(evs, func(a, b *v1.BoardWebhookEvent) int { return int(a.GetSequence()) - int(b.GetSequence()) })
	var actions []string
	for _, ev := range evs[:4] {
		if ev.GetType() != "task.updated" || ev.GetTask().GetId() != task.GetId() || len(ev.GetChanges()) != 1 ||
			ev.GetChanges()[0].GetField() != "checklist" {
			t.Fatalf("checklist event: %v", ev)
		}
		actions = append(actions, ev.GetChanges()[0].GetAfter().GetFields()["action"].GetStringValue())
	}
	if !slices.Equal(actions, []string{"created", "item_added", "item_done", "item_added"}) {
		t.Fatalf("actions %v", actions)
	}
	if evs[2].GetTask().GetChecklistDone() != 1 || evs[2].GetTask().GetChecklistTotal() != 1 {
		t.Fatalf("counters in the payload: %v", evs[2].GetTask())
	}
	byType := map[string]*v1.BoardWebhookEvent{}
	for _, ev := range evs[4:] {
		byType[ev.GetType()] = ev
	}
	if ev := byType["task.created"]; ev.GetTask().GetId() != cr.GetTask().GetId() || ev.GetTask().GetParentId() != task.GetId() {
		t.Fatalf("convert, subtask: %v", ev)
	}
	if ev := byType["task.updated"]; ev.GetTask().GetId() != task.GetId() ||
		ev.GetChanges()[0].GetAfter().GetFields()["action"].GetStringValue() != "converted" {
		t.Fatalf("convert, parent: %v", ev)
	}
}

// A move between boards: the source board gets task.moved_out with only what it knew (id, old
// key, the move without its destination); the destination gets task.moved_in with the task.
func TestBoardWebhookMove(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	src := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Source", Key: "WMS"}, 201)
	dst := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Secret", Key: "WMD", IsPrivate: true}, 201)
	task := createTask(t, o, src.GetId(), &v1.CreateTaskRequest{Title: "Переезд"}, 201)
	recvSrc, recvDst := newBoardHookRecv(t), newBoardHookRecv(t)
	recvSrc.secret, recvDst.secret = "source-secret-0123456", "dest-secret-0123456789"
	o.must(200, "PUT", "/api/boards/"+src.GetId()+"/webhook", &v1.SetBoardWebhookRequest{Url: recvSrc.srv.URL, Secret: recvSrc.secret}, nil)
	o.must(200, "PUT", "/api/boards/"+dst.GetId()+"/webhook", &v1.SetBoardWebhookRequest{Url: recvDst.srv.URL, Secret: recvDst.secret}, nil)

	dstID := dst.GetId()
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{BoardId: &dstID}, 200)
	out := recvSrc.wait("moved_out", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 1 })[0]
	if out.GetType() != "task.moved_out" || out.GetBoard().GetId() != src.GetId() || out.GetTask().GetId() != task.GetId() ||
		out.GetTask().GetKey() != task.GetKey() || out.GetTask().GetBoardId() != src.GetId() || out.GetTask().GetTitle() != "" ||
		out.GetTaskUrl() != "" || len(out.GetChanges()) != 1 || out.GetChanges()[0].GetField() != "moved_board" ||
		out.GetChanges()[0].GetAfter() != nil {
		t.Fatalf("moved_out leaks the destination: %v", out)
	}
	in := recvDst.wait("moved_in", func(g []*v1.BoardWebhookEvent) bool { return len(g) == 1 })[0]
	if in.GetType() != "task.moved_in" || in.GetTask().GetBoardId() != dstID || in.GetTask().GetTitle() != "Переезд" ||
		!strings.HasPrefix(in.GetTask().GetKey(), "WMD-") {
		t.Fatalf("moved_in: %v", in)
	}
}
