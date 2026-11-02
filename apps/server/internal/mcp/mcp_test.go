package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
)

// fakeAPI answers REST calls of the tools and records them.
type fakeAPI struct {
	calls []*http.Request
	body  []string
	reply func(r *http.Request) (int, proto.Message)
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.calls, f.body = append(f.calls, r), append(f.body, string(b))
	st, m := f.reply(r)
	out, _ := protojson.Marshal(m)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(st)
	_, _ = w.Write(out)
}

func post(t *testing.T, h http.Handler, id *auth.Identity, body string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, Path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer calab_bot_x_secret")
	r.Header.Set(auth.OnBehalfHeader, "owner")
	if id != nil {
		r = r.WithContext(auth.WithIdentity(r.Context(), *id))
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

var botID = auth.Identity{UserID: uuid.New(), IsBot: true}

func call(t *testing.T, h http.Handler, name, args string) (text string, isErr bool) {
	t.Helper()
	st, out := post(t, h, &botID, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"`+name+`","arguments":`+args+`}}`)
	if st != 200 || out["error"] != nil {
		t.Fatalf("tools/call %s: %d %v", name, st, out)
	}
	res := out["result"].(map[string]any)
	isErr, _ = res["isError"].(bool)
	return res["content"].([]any)[0].(map[string]any)["text"].(string), isErr
}

func TestRefusesWithoutBotToken(t *testing.T) {
	h := New("test")
	h.API = &fakeAPI{reply: func(*http.Request) (int, proto.Message) { t.Fatal("API called"); return 0, nil }}
	init := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	if st, _ := post(t, h, nil, init); st != http.StatusForbidden {
		t.Fatalf("no identity: %d", st)
	}
	person := auth.Identity{UserID: uuid.New()}
	if st, _ := post(t, h, &person, init); st != http.StatusForbidden {
		t.Fatalf("a person: %d", st)
	}
	// ADR-0156: a bot on behalf of its owner (or of a consenting member) is a bot token.
	onBehalf := auth.Identity{UserID: uuid.New(), ViaBot: uuid.New()}
	if st, _ := post(t, h, &onBehalf, init); st != http.StatusOK {
		t.Fatalf("on behalf of the owner: %d", st)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(auth.WithIdentity(t.Context(), botID), http.MethodGet, Path, nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
}

func TestProtocol(t *testing.T) {
	h := New("1.2.3")
	st, out := post(t, h, &botID, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	res, _ := out["result"].(map[string]any)
	if st != 200 || res["protocolVersion"] != "2025-06-18" || res["capabilities"].(map[string]any)["tools"] == nil {
		t.Fatalf("initialize: %d %v", st, out)
	}
	if st, _ := post(t, h, &botID, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); st != http.StatusAccepted {
		t.Fatalf("notification: %d", st)
	}
	_, out = post(t, h, &botID, `{"jsonrpc":"2.0","id":"a","method":"tools/list"}`)
	list := out["result"].(map[string]any)["tools"].([]any)
	want := []string{"find", "read", "create_task", "comment_task", "set_task_status", "send_message", "list_tasks", "update_task", "assign"}
	if len(list) != len(want) || strings.Join(ToolNames(), ",") != strings.Join(want, ",") {
		t.Fatalf("tools: %v", ToolNames())
	}
	// Token economy: the whole tool list stays small.
	if b, _ := json.Marshal(list); len(b) > 6000 {
		t.Fatalf("tools/list is %d bytes", len(b))
	}
	_, out = post(t, h, &botID, `{"jsonrpc":"2.0","id":2,"method":"nope"}`)
	if e, _ := out["error"].(map[string]any); e == nil || e["code"].(float64) != codeMethodNotFound {
		t.Fatalf("unknown method: %v", out)
	}
	if st, _ := post(t, h, &botID, `[{"jsonrpc":"2.0","id":1,"method":"ping"}]`); st != http.StatusBadRequest {
		t.Fatalf("batch: %d", st)
	}
}

// A tool is a REST call with the caller's token and its on-behalf header (ADR-0156: the inner
// call is checked on behalf again), marked as the MCP channel; a REST refusal is a tool error
// the model reads, not more rights.
func TestToolsCallRESTAsTheBot(t *testing.T) {
	boardID, taskID, statusDone := uuid.NewString(), uuid.NewString(), uuid.NewString()
	board := &v1.Board{Id: boardID, Name: "Ops", Statuses: []*v1.BoardStatus{{Id: uuid.NewString(), Name: "Todo"}, {Id: statusDone, Name: "Done"}}}
	f := &fakeAPI{}
	f.reply = func(r *http.Request) (int, proto.Message) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/workspaces":
			return 200, &v1.ListWorkspacesResponse{Workspaces: []*v1.Workspace{{Id: "ws-1"}}}
		case "GET /api/t/OPS-1":
			return 200, &v1.TaskResponse{Task: &v1.Task{Id: taskID, Key: "OPS-1", BoardId: boardID, RoomId: "room-1"}, Board: board}
		case "PATCH /api/tasks/" + taskID:
			return 200, &v1.TaskResponse{Task: &v1.Task{Id: taskID, Key: "OPS-1", StatusId: statusDone}}
		case "POST /api/rooms/secret/messages":
			return 404, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_NOT_FOUND, Message: "room not found"}
		}
		t.Fatalf("unexpected %s %s", r.Method, r.URL)
		return 0, nil
	}
	h := New("test")
	h.API = f

	text, isErr := call(t, h, "set_task_status", `{"task":"ops-1","status":"done"}`)
	if isErr || !strings.Contains(text, `"status":"Done"`) {
		t.Fatalf("set_task_status: %v %s", isErr, text)
	}
	patched := ""
	for i, r := range f.calls {
		if r.Method == http.MethodPatch {
			patched = f.body[i]
		}
	}
	if !strings.Contains(patched, statusDone) {
		t.Fatalf("PATCH body %s", patched)
	}
	for _, r := range f.calls {
		if r.Header.Get("Authorization") != "Bearer calab_bot_x_secret" || r.Header.Get(auth.OnBehalfHeader) != "owner" {
			t.Fatalf("headers of %s: %v", r.URL, r.Header)
		}
		if c := auth.Channel(r.Context()); c == nil || *c != auth.ChannelMCP {
			t.Fatalf("channel of %s: %v", r.URL, c)
		}
		if _, ok := auth.FromContext(r.Context()); ok {
			t.Fatalf("the outer identity leaked into %s", r.URL)
		}
	}

	text, isErr = call(t, h, "send_message", `{"room":"secret","text":"hi"}`)
	if !isErr || !strings.Contains(text, "404 NOT_FOUND") {
		t.Fatalf("refused send: %v %s", isErr, text)
	}
	if text, isErr = call(t, h, "set_task_status", `{"task":"OPS-1","status":"Nope"}`); !isErr || !strings.Contains(text, "Todo, Done") {
		t.Fatalf("unknown status: %v %s", isErr, text)
	}
	if _, isErr = call(t, h, "create_task", `{}`); !isErr {
		t.Fatal("create_task without arguments")
	}
}

// Malformed input is refused before any tool runs: no REST call, a JSON-RPC error.
func TestRefusesMalformedInput(t *testing.T) {
	h := New("test")
	h.API = &fakeAPI{reply: func(*http.Request) (int, proto.Message) { t.Fatal("API called"); return 0, nil }}
	for _, c := range []struct {
		name, body string
		status     int
		code       float64
	}{
		{"invalid JSON", `{"jsonrpc":`, http.StatusBadRequest, codeParse},
		{"empty body", ``, http.StatusBadRequest, codeParse},
		{"not 2.0", `{"jsonrpc":"1.0","id":1,"method":"ping"}`, http.StatusBadRequest, codeInvalidRequest},
		{"no method", `{"jsonrpc":"2.0","id":1}`, http.StatusBadRequest, codeInvalidRequest},
		{"too large", `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"` + strings.Repeat("a", maxBody) + `"}}`, http.StatusRequestEntityTooLarge, codeInvalidRequest},
		{"unknown tool", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"exec","arguments":{}}}`, http.StatusOK, codeInvalidParams},
		{"bad params", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":[1]}`, http.StatusOK, codeInvalidParams},
	} {
		st, out := post(t, h, &botID, c.body)
		e, _ := out["error"].(map[string]any)
		if st != c.status || e == nil || e["code"].(float64) != c.code {
			t.Errorf("%s: %d %v", c.name, st, out)
		}
	}
	// A tools/call notification (no id) runs nothing.
	if st, _ := post(t, h, &botID, `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"send_message","arguments":{"room":"r","text":"x"}}}`); st != http.StatusAccepted {
		t.Fatalf("notification: %d", st)
	}
}

// Arguments stay inside one path segment of the intended route (no other route, no query), and
// the token never reaches a tool's answer.
func TestArgumentsStayInTheirSegment(t *testing.T) {
	f := &fakeAPI{}
	f.reply = func(*http.Request) (int, proto.Message) {
		return 404, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_NOT_FOUND, Message: "room not found"}
	}
	h := New("test")
	h.API = f
	for _, room := range []string{"a/../../tasks/x", "x?limit=1000#y", "%2e%2e/x"} {
		q, _ := json.Marshal(room)
		text, isErr := call(t, h, "send_message", `{"room":`+string(q)+`,"text":"hi"}`)
		if !isErr || strings.Contains(text, "calab_bot") {
			t.Fatalf("%q: %v %s", room, isErr, text)
		}
		r := f.calls[len(f.calls)-1]
		p, ok := strings.CutPrefix(r.URL.EscapedPath(), "/api/rooms/")
		p, ok2 := strings.CutSuffix(p, "/messages")
		if !ok || !ok2 || strings.Contains(p, "/") || r.URL.RawQuery != "" || r.URL.Fragment != "" {
			t.Fatalf("%q became %s", room, r.URL.String())
		}
	}
}
