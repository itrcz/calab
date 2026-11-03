//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// smartFake* is the smart-task side of aiFake (ai_integration_test): the board is the request's
// «ROUTE=KEY», «GARBAGE» answers prose; the shaping step answers a fixed task («SHAPEBAD»: an
// unknown priority). Every data message is recorded.
var (
	smartFakeMu     sync.Mutex
	smartFakeSeen   []string
	smartFakeImages []int // images of each call (CBF-75)
	smartRouteRE    = regexp.MustCompile(`ROUTE=([A-Z0-9]+)`)
	smartDupRE      = regexp.MustCompile(`DUP=([A-Z0-9]+-[0-9]+)`)
)

// smartSlowDelay: how long the fake model thinks over a «SLOW» request.
const smartSlowDelay = 1500 * time.Millisecond

// CBF-75 additions: «REFUSE» declines at the board step; «NOIMAGES» answers 400 to a call with
// images (a model without vision); the duplicate check answers a duplicate of «DUP=KEY-N».
func smartFakeAnswer(w http.ResponseWriter, system, user string, images int) {
	smartFakeMu.Lock()
	smartFakeSeen = append(smartFakeSeen, user)
	smartFakeImages = append(smartFakeImages, images)
	smartFakeMu.Unlock()
	var data struct {
		Request string `json:"request"`
	}
	_ = json.Unmarshal([]byte(user), &data)
	if strings.Contains(data.Request, "SLOW") { // a model slower than the server's ReadTimeout (bug #152)
		time.Sleep(smartSlowDelay)
	}
	if images > 0 && strings.Contains(data.Request, "NOIMAGES") {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"image input is not supported","type":"invalid_request_error"}}`)
		return
	}
	content := ""
	dup := ""
	if m := smartDupRE.FindStringSubmatch(data.Request); m != nil {
		dup = m[1]
	}
	switch {
	case strings.Contains(system, `"board_key"`) && strings.Contains(data.Request, "REFUSE"):
		content = `{"refuse":"Не хватает данных: **сумма**, см. https://evil.example @everyone"}`
	case strings.Contains(system, "duplicates a task") && dup != "":
		content = `{"refuse":"Это дубль задачи ` + dup + `","duplicate_of":"` + dup + `"}`
	case strings.Contains(system, "duplicates a task"):
		content = `{"duplicate_of":""}`
	case strings.Contains(system, `"board_key"`) && strings.Contains(data.Request, "GARBAGE"):
		content = "I would pick DEV."
	case strings.Contains(system, `"board_key"`):
		key := ""
		if m := smartRouteRE.FindStringSubmatch(data.Request); m != nil {
			key = m[1]
		}
		content = `{"board_key":"` + key + `","title":"AI title"}`
	case strings.Contains(data.Request, "SHAPEBAD"):
		content = `{"title":"t","description":"","labels":[],"priority":"asap"}`
	default:
		content = `{"title":"Shaped @everyone","description":"By instruction","labels":["bug","nope"],"priority":"high"}`
	}
	b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": content}}}})
	_, _ = w.Write(b)
}

func smartLastSeen() string {
	smartFakeMu.Lock()
	defer smartFakeMu.Unlock()
	if len(smartFakeSeen) == 0 {
		return ""
	}
	return smartFakeSeen[len(smartFakeSeen)-1]
}

// TestSmartTasks (CBF-68, ADR-0118): the AI state gates smart tasks (no key → unchecked →
// failed → ready; a change of the model makes it unchecked again; a test of another key does not
// switch off what works); the model sees only the boards where the person has CREATE_TASKS and
// cannot pick another one; the task is the person's, by the board's instruction when there is
// one; the instruction is read only with VIEW_BOARD and written with MANAGE_BOARD.
func TestSmartTasks(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE}) // CBF-69: AI is Business only
	base := "/api/workspaces/" + wid + "/ai"
	smart := "/api/workspaces/" + wid + "/smart-tasks"
	key := func(s string) *string { return &s }
	gpt := v1.AiProvider_AI_PROVIDER_GPTUNNEL
	state := func(u *user) v1.AiState {
		t.Helper()
		var st v1.GetAiStatusResponse
		u.must(200, "GET", base+"/status", nil, &st)
		return st.GetState()
	}
	wantReason := func(u *user, req *v1.CreateSmartTaskRequest, status int, reason string) {
		t.Helper()
		st, e := u.apiErrBody("POST", smart, req)
		if st != status || e.GetReason() != reason {
			t.Fatalf("smart %q: %d %v, want %d %s", req.GetText(), st, e, status, reason)
		}
	}

	// Boards: DEV public; DOC private, bob create-only (ADR-0115); SEC private, bob nothing;
	// VIEW public, bob may only look.
	dev := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Разработка", Key: "DEV", Description: "код"}, 201)
	doc := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Документы", Key: "DOC", IsPrivate: true}, 201)
	sec := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Секрет", Key: "SEC", IsPrivate: true}, 201)
	view := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Витрина", Key: "VIEW"}, 201)
	setBoardPerms(o, doc.GetId(), 200, creatorOv(o), userOv(bob.id, perm.CreateTasks, 0))
	setBoardPerms(o, view.GetId(), 200, creatorOv(o), userOv(bob.id, perm.ViewBoard, perm.CreateTasks))
	o.must(201, "POST", "/api/boards/"+doc.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "bug"}, nil)

	// Not connected, then saved but unchecked: the item is off and the route refuses.
	if st := state(bob); st != v1.AiState_AI_STATE_NO_KEY {
		t.Fatalf("no key: %v", st)
	}
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}, 409, "AI_NOT_READY")
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "missing", ApiKey: key(aiFakeKey)}, nil)
	if st := state(bob); st != v1.AiState_AI_STATE_UNCHECKED {
		t.Fatalf("unchecked: %v", st)
	}
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}, 409, "AI_NOT_READY")
	// A failed check of the saved settings: FAILED.
	var c v1.CheckAiResponse
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "missing"}, &c)
	if c.GetOk() || c.GetState() != v1.AiState_AI_STATE_FAILED || state(bob) != v1.AiState_AI_STATE_FAILED {
		t.Fatalf("failed: %v %v", &c, state(bob))
	}
	var g v1.GetAiSettingsResponse
	o.must(200, "GET", base, nil, &g)
	if s := g.GetSettings(); s.GetState() != v1.AiState_AI_STATE_FAILED || s.GetCheckError() != "model_not_found" || s.GetCheckedAt() == nil {
		t.Fatalf("settings state %v", s)
	}
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}, 409, "AI_NOT_READY")
	// Checked before saving: the same form saved afterwards is READY.
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra"}, &c)
	if !c.GetOk() || c.GetState() != v1.AiState_AI_STATE_UNCHECKED { // the saved form (model «missing») is not this one
		t.Fatalf("unsaved check: %v", &c)
	}
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "gpt-6-astra"}, nil)
	if st := state(bob); st != v1.AiState_AI_STATE_READY {
		t.Fatalf("ready: %v", st)
	}
	// Testing another key while READY does not switch it off.
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: key("wrong-key-000000000000")}, &c)
	if c.GetOk() || state(bob) != v1.AiState_AI_STATE_READY {
		t.Fatalf("other key test: %v %v", &c, state(bob))
	}
	if strings.Contains(string(o.lastBody), aiFakeKey) {
		t.Fatal("the key in an answer")
	}

	// Guests and strangers.
	gus := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	gus.must(403, "GET", base+"/status", nil, nil)
	gus.must(403, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}, nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := register(t, invite(t, o, other.GetId()))
	stranger.must(404, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}, nil)

	// Validation.
	if st, e := bob.apiErrBody("POST", smart, &v1.CreateSmartTaskRequest{Text: "  "}); st != 422 || e.GetField() != "text" {
		t.Fatalf("empty text: %d %v", st, e)
	}
	if st, e := bob.apiErrBody("POST", smart, &v1.CreateSmartTaskRequest{Text: "x", AttachmentIds: []string{dev.GetId()}}); st != 422 || e.GetField() != "attachmentIds" {
		t.Fatalf("foreign file: %d %v", st, e)
	}

	// The model sees bob's boards only: DEV and DOC, never SEC or VIEW, and cannot pick them.
	before := len(listTasks(t, o, sec.GetId(), nil)) + len(listTasks(t, o, view.GetId(), nil))
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=SEC утечка"}, 409, "AI_BAD_ANSWER")
	seen := smartLastSeen()
	if !strings.Contains(seen, `"key":"DEV"`) || !strings.Contains(seen, `"key":"DOC"`) || strings.Contains(seen, "Секрет") ||
		strings.Contains(seen, `"key":"SEC"`) || strings.Contains(seen, `"key":"VIEW"`) || strings.Contains(seen, aiFakeKey) {
		t.Fatalf("boards sent to the model: %s", seen)
	}
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=VIEW витрина"}, 409, "AI_BAD_ANSWER")
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "GARBAGE"}, 409, "AI_BAD_ANSWER")
	if after := len(listTasks(t, o, sec.GetId(), nil)) + len(listTasks(t, o, view.GetId(), nil)); after != before {
		t.Fatal("a task was created on a board outside the list")
	}

	// Without an instruction: the person's text as is, the person's priority, by bob.
	var res v1.CreateSmartTaskResponse
	text := "ROUTE=DEV поправить вход\nподробности"
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: text, Priority: v1.TaskPriority_TASK_PRIORITY_LOW}, &res)
	tk := res.GetTask()
	if tk.GetBoardId() != dev.GetId() || tk.GetCreatedBy() != bob.id || tk.GetTitle() != "AI title" || tk.GetDescription() != text ||
		tk.GetPriority() != v1.TaskPriority_TASK_PRIORITY_LOW || res.GetUsedInstruction() || len(tk.GetAssignees()) != 0 {
		t.Fatalf("plain smart task: %v", &res)
	}
	bob.must(200, "GET", "/api/tasks/"+tk.GetId(), nil, nil)

	// The instruction: MANAGE_BOARD writes it, VIEW_BOARD reads it, never lists or create-only.
	instr := "Пиши заголовок со словом Счёт, метка bug"
	bob.must(403, "PATCH", "/api/boards/"+doc.GetId(), &v1.UpdateBoardRequest{AiInstruction: &instr}, nil)
	if st, e := o.apiErrBody("PATCH", "/api/boards/"+doc.GetId(), &v1.UpdateBoardRequest{AiInstruction: key(strings.Repeat("я", 4001))}); st != 422 || e.GetField() != "aiInstruction" {
		t.Fatalf("long instruction: %d %v", st, e)
	}
	var br v1.BoardResponse
	o.must(200, "PATCH", "/api/boards/"+doc.GetId(), &v1.UpdateBoardRequest{AiInstruction: &instr}, &br)
	if br.GetBoard().GetAiInstruction() != instr {
		t.Fatalf("patched %q", br.GetBoard().GetAiInstruction())
	}
	o.must(200, "GET", "/api/boards/"+doc.GetId(), nil, &br)
	if br.GetBoard().GetAiInstruction() != instr {
		t.Fatalf("owner reads %q", br.GetBoard().GetAiInstruction())
	}
	bob.must(200, "GET", "/api/boards/"+doc.GetId(), nil, &br)
	if br.GetBoard().GetAiInstruction() != "" {
		t.Fatal("a create-only member reads the instruction")
	}
	if lb := listBoards(t, o, wid)[doc.GetId()]; lb == nil || lb.GetAiInstruction() != "" {
		t.Fatalf("the instruction in the list: %v", lb)
	}
	bob.must(404, "GET", "/api/boards/"+sec.GetId(), nil, nil)

	// With the instruction: shaped (board labels only, the model's priority, no mentions), the
	// person's text kept, on DOC by bob (create-only), who sees and edits the card.
	text = "ROUTE=DOC счёт от поставщика"
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: text}, &res)
	tk = res.GetTask()
	if tk.GetBoardId() != doc.GetId() || tk.GetCreatedBy() != bob.id || !res.GetUsedInstruction() || tk.GetTitle() != "Shaped everyone" ||
		tk.GetPriority() != v1.TaskPriority_TASK_PRIORITY_HIGH || len(tk.GetLabelIds()) != 1 ||
		!strings.Contains(tk.GetDescription(), "By instruction") || !strings.Contains(tk.GetDescription(), "> "+text) {
		t.Fatalf("shaped smart task: %v", &res)
	}
	if seen := smartLastSeen(); !strings.Contains(seen, instr) {
		t.Fatalf("the instruction did not reach the model: %s", seen)
	}
	title := "правка"
	patchTask(t, bob, tk.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=DOC SHAPEBAD"}, 409, "AI_BAD_ANSWER")

	// Without CREATE_TASKS anywhere: nothing to create on.
	setBoardPerms(o, dev.GetId(), 200, creatorOv(o), userOv(bob.id, 0, perm.CreateTasks))
	setBoardPerms(o, doc.GetId(), 200, creatorOv(o))
	wantReason(bob, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}, 409, "NO_BOARDS")

	// A change of the model: unchecked again.
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "gpt-6-other"}, nil)
	if st := state(bob); st != v1.AiState_AI_STATE_UNCHECKED {
		t.Fatalf("after a model change: %v", st)
	}
}

// TestSmartTaskOutlivesReadTimeout (bug #152): a model that thinks longer than the server's
// ReadTimeout (30 s in cmd/server; 1 s here) still files the task, with and without a file —
// the server side of «Не удалось сохранить» ruled out (the desktop's 20 s deadline was the cut).
func TestSmartTaskOutlivesReadTimeout(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	base := "/api/workspaces/" + wid + "/ai"
	key := aiFakeKey
	gpt := v1.AiProvider_AI_PROVIDER_GPTUNNEL
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: &key}, nil)
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra"}, nil)
	dev := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Разработка", Key: "DEV"}, 201)

	slow := httptest.NewUnstartedServer(testApp.Handler)
	slow.Config.ReadTimeout = time.Second // < smartSlowDelay, as 30 s < a slow model in production
	slow.Start()
	defer slow.Close()
	post := func(req *v1.CreateSmartTaskRequest) (int, []byte) {
		t.Helper()
		b, _ := protojson.Marshal(req)
		r, _ := http.NewRequestWithContext(context.Background(), "POST", slow.URL+"/api/workspaces/"+wid+"/smart-tasks", bytes.NewReader(b))
		r.Header.Set("Authorization", "Bearer "+o.token)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, raw
	}
	if st, raw := post(&v1.CreateSmartTaskRequest{Text: "ROUTE=DEV SLOW without files"}); st != 201 {
		t.Fatalf("slow model: %d %s", st, raw)
	}
	stf, f := uploadAs(t, o, "/api/workspaces/"+wid+"/files", "notes.txt", "text/plain", []byte("счёт"))
	if stf != 201 && stf != 200 {
		t.Fatalf("upload: %d", stf)
	}
	st, raw := post(&v1.CreateSmartTaskRequest{Text: "ROUTE=DEV SLOW with a file", AttachmentIds: []string{f.GetId()}})
	var res v1.CreateSmartTaskResponse
	if st != 201 || protojson.Unmarshal(raw, &res) != nil || res.GetTask().GetBoardId() != dev.GetId() || res.GetTask().GetAttachmentCount() != 1 {
		t.Fatalf("slow model with a file: %d %s", st, raw)
	}
}
