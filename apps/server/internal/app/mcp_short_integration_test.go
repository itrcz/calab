//go:build integration

package app_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// mcpBlocks is a tools/call at path; the content blocks and isError.
func mcpBlocks(t *testing.T, path, access, name string, args map[string]any) ([]map[string]any, bool) {
	t.Helper()
	st, out, _ := mcpCallAt(t, path, access, "tools/call", map[string]any{"name": name, "arguments": args})
	res, _ := out["result"].(map[string]any)
	if st != 200 || res == nil {
		t.Fatalf("%s: %d %v", name, st, out)
	}
	var bs []map[string]any
	for _, b := range res["content"].([]any) {
		bs = append(bs, b.(map[string]any))
	}
	isErr, _ := res["isError"].(bool)
	return bs, isErr
}

// TestMCPShortAddressAndFiles (CBF-183, CBF-182): https://<app>/mcp is the same endpoint with its
// own OAuth resource; a browser opening it lands on «Settings → MCP». The task-file tool returns
// a task's and its comments' files with the person's rights; edit_message and find people.
func TestMCPShortAddressAndFiles(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	board := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Short", Key: "MSA", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)

	// Discovery at the short address points to its own metadata.
	st, _, hdr := mcpCallAt(t, "/mcp", "", "initialize", map[string]any{})
	if st != 401 || !strings.Contains(hdr.Get("WWW-Authenticate"), `resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("challenge: %d %q", st, hdr.Get("WWW-Authenticate"))
	}
	prm := oaJSON(t, oaDo(t, "GET", "/.well-known/oauth-protected-resource/mcp", nil, nil))
	if prm["resource"] != "https://app.example.com/mcp" || prm["authorization_servers"].([]any)[0] != "https://app.example.com" {
		t.Fatalf("resource metadata %v", prm)
	}
	// A browser goes to the settings page; an MCP client's GET is the transport's (401, then 405).
	if r := oaDo(t, "GET", "/mcp", nil, http.Header{"Accept": {"text/html,application/xhtml+xml"}}); r.status != http.StatusSeeOther || r.header.Get("Location") != "/settings/mcp" {
		t.Fatalf("browser: %d %q", r.status, r.header.Get("Location"))
	}
	if r := oaDo(t, "GET", "/mcp", nil, http.Header{"Accept": {"text/event-stream"}}); r.status != 401 {
		t.Fatalf("client GET: %d", r.status)
	}

	// A code for /mcp is exchanged only for /mcp; the token works at both addresses.
	cid := mcpRegister(t, mcpTestRedirect)
	f := mcpAuthorizeFor(t, cid, "https://app.example.com/mcp")
	code := codeOf(t, f.consent(t, bob.token, f.cookie, true, 200))
	if st, out := mcpTokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {cid}, "redirect_uri": {mcpTestRedirect}, "code_verifier": {f.verifier}, "resource": {"https://app.example.com/api/mcp"}}); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("another resource: %d %v", st, out)
	}
	access, _ := mcpExchange(t, f, code)
	for _, p := range []string{"/mcp", "/api/mcp"} {
		if st, out, _ := mcpCallAt(t, p, access, "tools/list", map[string]any{}); st != 200 || len(out["result"].(map[string]any)["tools"].([]any)) != 11 {
			t.Fatalf("tools/list at %s: %d %v", p, st, out)
		}
	}
	if r := oaDo(t, "GET", "/api/mcp/oauth/authorize?"+url.Values{"response_type": {"code"}, "client_id": {cid}, "redirect_uri": {mcpTestRedirect},
		"code_challenge": {strings.Repeat("c", 43)}, "code_challenge_method": {"S256"}, "resource": {"https://app.example.com/mcp/connect"}}.Encode(), nil, nil); !strings.Contains(r.header.Get("Location"), "error=invalid_target") {
		t.Fatalf("resource /mcp/connect: %d %s", r.status, r.header.Get("Location"))
	}
	// The app session's token is still not an MCP token at the short address.
	if st, _, _ := mcpCallAt(t, "/mcp", bob.token, "tools/list", map[string]any{}); st != 403 {
		t.Fatalf("app session on /mcp: %d", st)
	}

	// A task with a log and a screenshot; a comment with another file.
	_, logFile, _ := upload(t, o, "/api/boards/"+board.GetId()+"/files", "build.log", []byte("ok\nFAIL TestX\n"))
	_, png, _ := upload(t, o, "/api/boards/"+board.GetId()+"/files", "shot.png", pngBytes(8, 8))
	var tr v1.TaskResponse
	o.must(201, "POST", "/api/boards/"+board.GetId()+"/tasks", &v1.CreateTaskRequest{Title: "with files", AttachmentIds: []string{logFile.GetId(), png.GetId()}}, &tr)
	task := tr.GetTask()
	_, note, _ := upload(t, o, "/api/workspaces/"+ws.GetId()+"/files", "notes.md", []byte("# steps\n1. run"))
	var cm v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "see notes", AttachmentIds: []string{note.GetId()}, Nonce: uniq("n-")}, &cm)

	text := mcpToolText(t, access, "read", map[string]any{"task": task.GetKey(), "comments": 5})
	if !strings.Contains(text, logFile.GetId()) || !strings.Contains(text, note.GetId()) {
		t.Fatalf("read: %s", text)
	}
	bs, isErr := mcpBlocks(t, "/mcp", access, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": logFile.GetId()})
	if isErr || len(bs) != 2 || bs[1]["text"] != "ok\nFAIL TestX\n" {
		t.Fatalf("text file: %v %v", isErr, bs)
	}
	bs, isErr = mcpBlocks(t, "/mcp", access, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": "shot.png"})
	if raw, _ := base64.StdEncoding.DecodeString(stringOf(bs, 1, "data")); isErr || bs[1]["type"] != "image" || len(raw) != len(pngBytes(8, 8)) {
		t.Fatalf("image: %v %v", isErr, bs)
	}
	bs, isErr = mcpBlocks(t, "/mcp", access, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": note.GetId(), "comment": cm.GetMessage().GetId()})
	if isErr || bs[1]["text"] != "# steps\n1. run" {
		t.Fatalf("comment file: %v %v", isErr, bs)
	}
	// A file of another task is not this task's.
	var other v1.TaskResponse
	_, otherFile, _ := upload(t, o, "/api/boards/"+board.GetId()+"/files", "other.txt", []byte("x"))
	o.must(201, "POST", "/api/boards/"+board.GetId()+"/tasks", &v1.CreateTaskRequest{Title: "other", AttachmentIds: []string{otherFile.GetId()}}, &other)
	if bs, isErr = mcpBlocks(t, "/mcp", access, "get_task_attachment", map[string]any{"task": task.GetKey(), "file": otherFile.GetId()}); !isErr || !strings.Contains(stringOf(bs, 0, "text"), "not attached") {
		t.Fatalf("other task's file: %v %v", isErr, bs)
	}

	// edit_message: bob's own comment; another's is refused by the server.
	var c struct{ ID string }
	_ = json.Unmarshal([]byte(mcpToolText(t, access, "comment_task", map[string]any{"task": task.GetKey(), "text": "wip"})), &c)
	mcpToolText(t, access, "edit_message", map[string]any{"message": c.ID, "text": "done"})
	if _, isErr = mcpBlocks(t, "/mcp", access, "edit_message", map[string]any{"message": cm.GetMessage().GetId(), "text": "hijack"}); !isErr {
		t.Fatal("edited another's comment")
	}
	// find people: names for the ids.
	if text = mcpToolText(t, access, "find", map[string]any{"kind": "people", "q": "", "workspace": ws.GetId()}); !strings.Contains(text, o.id) || !strings.Contains(text, bob.id) {
		t.Fatalf("people: %s", text)
	}
}

func stringOf(bs []map[string]any, i int, k string) string {
	if i >= len(bs) {
		return ""
	}
	s, _ := bs[i][k].(string)
	return s
}
