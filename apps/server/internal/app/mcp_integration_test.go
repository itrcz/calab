//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// MCP for bots (CBF-48).

// mcpPost sends one JSON-RPC message to /api/mcp with token ("" = none).
func mcpPost(t *testing.T, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL+"/api/mcp", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

// mcpTool calls a tool as the bot and returns its text and isError. A tool call costs the bot
// 1 + its REST calls in the bot request limit (ADR-0031): the test resets the bucket.
func mcpTool(t *testing.T, b *bot, name string, args map[string]any) (string, bool) {
	t.Helper()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:bot:req:"+b.id)).Build()).Error()
	a, _ := json.Marshal(args)
	st, out := mcpPost(t, b.token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+name+`","arguments":`+string(a)+`}}`)
	res, ok := out["result"].(map[string]any)
	if st != 200 || !ok {
		t.Fatalf("%s: %d %v", name, st, out)
	}
	isErr, _ := res["isError"].(bool)
	return res["content"].([]any)[0].(map[string]any)["text"].(string), isErr
}

// The endpoint takes bot tokens only, and every tool has exactly the bot's rights: what the
// bot's REST calls cannot see or change, its tools cannot either.
func TestMCPBotTools(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	bt := createBot(t, o, wid, "mcpbot")
	pub := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Pub", Key: "MCP", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Sec", Key: "SEC", IsPrivate: true}, 201)
	secret := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "секретная сверка"}, 201)
	pubRoom := textRoom(t, o, wid, "mcp-open", false)
	privRoom := textRoom(t, o, wid, "mcp-hidden", true)
	init := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`

	// No token: 401; a person's token: 403.
	if st, _ := mcpPost(t, "", init); st != http.StatusUnauthorized {
		t.Fatalf("no token: %d", st)
	}
	if st, _ := mcpPost(t, o.token, init); st != http.StatusForbidden {
		t.Fatalf("a person: %d", st)
	}
	// On behalf needs the owner's switch or a member's consent (ADR-0106 / ADR-0111, ADR-0156):
	// neither is given here, so the header is refused whatever it names.
	for _, who := range []string{"owner", o.id} {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL+"/api/mcp", strings.NewReader(init))
		req.Header.Set("Authorization", "Bearer "+bt.token)
		req.Header.Set("Calab-On-Behalf", who)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatalf("on behalf of %s: %d", who, resp.StatusCode)
		}
	}
	if st, out := mcpPost(t, bt.token, init); st != 200 || out["result"] == nil {
		t.Fatalf("initialize: %d %v", st, out)
	}

	// The bot's own rights work through the tools.
	started := pub.GetStatuses()[1].GetName()
	text, isErr := mcpTool(t, bt, "create_task", map[string]any{"board": pub.GetId(), "title": "из MCP", "status": started})
	if isErr || !strings.Contains(text, `"key":"MCP-1"`) {
		t.Fatalf("create_task: %s", text)
	}
	if text, isErr = mcpTool(t, bt, "comment_task", map[string]any{"task": "mcp-1", "text": "комментарий"}); isErr {
		t.Fatalf("comment_task: %s", text)
	}
	if text, isErr = mcpTool(t, bt, "set_task_status", map[string]any{"task": "MCP-1", "status": pub.GetStatuses()[0].GetName()}); isErr {
		t.Fatalf("set_task_status: %s", text)
	}
	if text, isErr = mcpTool(t, bt, "read", map[string]any{"task": "MCP-1"}); isErr ||
		!strings.Contains(text, `"status":"`+pub.GetStatuses()[0].GetName()+`"`) || !strings.Contains(text, `"comments":1`) {
		t.Fatalf("read task: %s", text)
	}
	if text, isErr = mcpTool(t, bt, "send_message", map[string]any{"room": pubRoom, "text": "привет из MCP"}); isErr {
		t.Fatalf("send_message: %s", text)
	}
	if text, isErr = mcpTool(t, bt, "read", map[string]any{"room": pubRoom}); isErr || !strings.Contains(text, "привет из MCP") {
		t.Fatalf("read room: %s", text)
	}
	if text, isErr = mcpTool(t, bt, "find", map[string]any{"q": "mcp", "kind": "rooms"}); isErr || !strings.Contains(text, pubRoom) || strings.Contains(text, privRoom) {
		t.Fatalf("find rooms: %s", text)
	}

	// Nothing beyond them: the private board, its task and the private room stay closed.
	bt.must(404, "GET", "/api/tasks/"+secret.GetId(), nil, nil)
	if text, _ = mcpTool(t, bt, "find", map[string]any{"q": "секретная"}); strings.Contains(text, secret.GetId()) {
		t.Fatalf("find shows the private task: %s", text)
	}
	if text, _ = mcpTool(t, bt, "find", map[string]any{"kind": "boards"}); !strings.Contains(text, pub.GetId()) || strings.Contains(text, priv.GetId()) {
		t.Fatalf("find boards: %s", text)
	}
	for _, c := range []struct {
		name string
		args map[string]any
	}{
		{"read", map[string]any{"task": secret.GetKey()}},
		{"read", map[string]any{"task": secret.GetId()}},
		{"comment_task", map[string]any{"task": secret.GetId(), "text": "x"}},
		{"set_task_status", map[string]any{"task": secret.GetId(), "status": "Done"}},
		{"create_task", map[string]any{"board": priv.GetId(), "title": "x"}},
		{"read", map[string]any{"room": privRoom}},
		{"send_message", map[string]any{"room": privRoom, "text": "x"}},
		{"send_message", map[string]any{"room": secret.GetRoomId(), "text": "x"}},
	} {
		if text, isErr := mcpTool(t, bt, c.name, c.args); !isErr || !strings.Contains(text, "404") {
			t.Errorf("%s %v: %v %s", c.name, c.args, isErr, text)
		}
	}
	var ms v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+privRoom+"/messages", nil, &ms)
	if len(ms.GetMessages()) != 0 {
		t.Fatalf("private room got %d messages", len(ms.GetMessages()))
	}
}
