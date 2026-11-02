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

// MCP on behalf of a person and the «via MCP» mark (ADR-0156).

// mcpToolAs calls a tool as the bot with Calab-On-Behalf: who ("" = the bot itself); st is the
// HTTP status of /api/mcp (a refused delegation never reaches the tool).
func mcpToolAs(t *testing.T, b *bot, who, name string, args map[string]any) (st int, text string, isErr bool) {
	t.Helper()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:bot:req:"+b.id)).Build()).Error()
	a, _ := json.Marshal(args)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + string(a) + `}}`
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL+"/api/mcp", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.token)
	if who != "" {
		req.Header.Set("Calab-On-Behalf", who)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	res, ok := out["result"].(map[string]any)
	if resp.StatusCode != 200 || !ok {
		return resp.StatusCode, string(raw), true
	}
	isErr, _ = res["isError"].(bool)
	return 200, res["content"].([]any)[0].(map[string]any)["text"].(string), isErr
}

func mustTool(t *testing.T, b *bot, who, name string, args map[string]any) string {
	t.Helper()
	st, text, isErr := mcpToolAs(t, b, who, name, args)
	if st != 200 || isErr {
		t.Fatalf("%s as %q: %d %s", name, who, st, text)
	}
	return text
}

// TestMCPOnBehalfVia: a developer's bot works through MCP as the developer — the task, its
// comments, assignees and fields are theirs (via_bot_id) and marked via = "mcp", the bot's own
// MCP actions are marked too, REST and the app are not; no delegation without the owner's
// switch or a member's consent.
func TestMCPOnBehalfVia(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN // creating a bot needs MANAGE_BOTS
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+bob.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	bt := createBot(t, bob, wid, "devagent") // bob's own agent
	board := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Dev", Key: "MVI", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	label := "Bug"
	var lr v1.BoardResponse
	o.must(201, "POST", "/api/boards/"+board.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: label}, &lr)

	// Without the owner's switch, or for a member without consent: refused, nothing written.
	if st, text, _ := mcpToolAs(t, bt, "owner", "create_task", map[string]any{"board": board.GetId(), "title": "x"}); st != http.StatusForbidden || !strings.Contains(text, "ON_BEHALF_DISABLED") {
		t.Fatalf("switch off: %d %s", st, text)
	}
	if st, text, _ := mcpToolAs(t, bt, o.id, "create_task", map[string]any{"board": board.GetId(), "title": "x"}); st < 400 {
		t.Fatalf("member without consent: %d %s", st, text)
	}
	if st, _ := setActsAsOwner(bob, wid, bt.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}

	// On behalf of bob: the task is bob's, through his bot, via MCP.
	text := mustTool(t, bt, "owner", "create_task", map[string]any{"board": "mvi", "title": "из агента"})
	if !strings.Contains(text, `"key":"MVI-1"`) {
		t.Fatalf("create_task by board key: %s", text)
	}
	var created struct{ ID, Key string }
	_ = json.Unmarshal([]byte(text), &created)
	mustTool(t, bt, "owner", "comment_task", map[string]any{"task": created.Key, "text": "взял в работу"})
	if text = mustTool(t, bt, "owner", "assign", map[string]any{"task": created.Key, "users": []string{"me"}}); !strings.Contains(text, bob.id) {
		t.Fatalf("assign me: %s", text)
	}
	if text = mustTool(t, bt, "owner", "update_task", map[string]any{"task": created.Key, "priority": "high", "add_labels": []string{"bug"}}); !strings.Contains(text, `"labels":["Bug"]`) || !strings.Contains(text, `"priority":"high"`) {
		t.Fatalf("update_task: %s", text)
	}
	if text = mustTool(t, bt, "owner", "list_tasks", map[string]any{"board": "MVI", "assignee": "me", "labels": []string{"Bug"}}); !strings.Contains(text, created.Key) {
		t.Fatalf("list_tasks me: %s", text)
	}
	if text = mustTool(t, bt, "owner", "list_tasks", map[string]any{"mine": true}); !strings.Contains(text, created.Key) {
		t.Fatalf("list_tasks mine: %s", text)
	}
	// The bot itself through MCP, then through REST; o in the app.
	mustTool(t, bt, "", "comment_task", map[string]any{"task": created.Key, "text": "сам бот через MCP"})
	var tr v1.TaskResponse
	o.must(200, "GET", "/api/tasks/"+created.ID, nil, &tr)
	bt.must(201, "POST", "/api/rooms/"+tr.GetTask().GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "бот через REST"}, nil)
	o.must(201, "POST", "/api/rooms/"+tr.GetTask().GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "человек в приложении"}, nil)
	if tr.GetTask().GetCreatedBy() != bob.id {
		t.Fatalf("created_by %s, want bob %s", tr.GetTask().GetCreatedBy(), bob.id)
	}

	var page v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+created.ID+"/activity?limit=100", nil, &page)
	msgs := map[string]*v1.Message{}
	kinds := map[string]*v1.TaskActivity{}
	for _, it := range page.GetItems() {
		if m := it.GetMessage(); m != nil {
			msgs[m.GetContent()] = m
		}
		if a := it.GetActivity(); a != nil && a.GetKind() != "comment" {
			kinds[a.GetKind()] = a
		}
	}
	for _, c := range []struct {
		text, author, viaBot, via string
	}{
		{"взял в работу", bob.id, bt.id, "mcp"},
		{"сам бот через MCP", bt.id, "", "mcp"},
		{"бот через REST", bt.id, "", ""},
		{"человек в приложении", o.id, "", ""},
	} {
		m := msgs[c.text]
		if m == nil || m.GetAuthorId() != c.author || m.GetViaBotId() != c.viaBot || m.GetVia() != c.via {
			t.Errorf("message %q: %v; want author %s via bot %q via %q", c.text, m, c.author, c.viaBot, c.via)
		}
	}
	for _, k := range []string{"created", "assignees", "priority", "labels"} {
		a := kinds[k]
		if a == nil || a.GetActorId() != bob.id || a.GetViaBotId() != bt.id || a.GetVia() != "mcp" {
			t.Errorf("journal %q: %v; want bob via bot via mcp", k, a)
		}
	}
	// The same field changed in the app right after: not merged into the MCP entry.
	none := v1.TaskPriority_TASK_PRIORITY_NONE
	bob.must(200, "PATCH", "/api/tasks/"+created.ID, &v1.UpdateTaskRequest{Priority: &none}, nil)
	o.must(200, "GET", "/api/tasks/"+created.ID+"/activity?limit=100", nil, &page)
	n := 0
	for _, it := range page.GetItems() {
		if a := it.GetActivity(); a != nil && a.GetKind() == "priority" {
			n++
			if a.GetViaBotId() == "" && a.GetVia() != "" {
				t.Errorf("the app's entry is marked: %v", a)
			}
		}
	}
	if n != 2 {
		t.Fatalf("priority entries: %d, want the MCP one and the app's", n)
	}
	// Off again: the next call is refused at once.
	if st, _ := setActsAsOwner(bob, wid, bt.id, false); st != 200 {
		t.Fatalf("acts_as_owner off: %d", st)
	}
	if st, text, _ := mcpToolAs(t, bt, "owner", "comment_task", map[string]any{"task": created.Key, "text": "x"}); st != http.StatusForbidden {
		t.Fatalf("after off: %d %s", st, text)
	}
}
