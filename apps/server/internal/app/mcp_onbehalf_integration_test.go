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
	if !strings.Contains(text, `"key":"MVI-1"`) || !strings.Contains(text, `"workspace":"`+wid+`"`) {
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

// TestMCPOnBehalfOfMemberStaysInTheConsent (ADR-0111 through MCP, ADR-0156): a member who
// consented in workspace A is acted for there only; the bot in B with the same member gets
// ON_BEHALF_NO_CONSENT, and the aggregate routes (task by key, my tasks, search, workspaces)
// stay closed on behalf of a member.
func TestMCPOnBehalfOfMemberStaysInTheConsent(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wa := ws.GetId()
	carol := register(t, invite(t, o, wa))
	bt := createBot(t, o, wa, "mcpdeleg")
	boardA := createBoard(t, o, wa, &v1.CreateBoardRequest{Name: "A", Key: "MCA"}, 201)
	wb := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	carol.must(200, "POST", "/api/invites/"+invite(t, o, wb)+"/join", nil, nil)
	o.must(201, "POST", "/api/workspaces/"+wb+"/bots/add", &v1.AddBotRequest{BotUserId: bt.id}, nil)
	boardB := createBoard(t, o, wb, &v1.CreateBoardRequest{Name: "B", Key: "MCB"}, 201)
	taskB := createTask(t, o, boardB.GetId(), &v1.CreateTaskRequest{Title: "в чужом пространстве"}, 201)

	// carol consents in A only.
	o.must(200, "POST", "/api/workspaces/"+wa+"/bots/"+bt.id+"/delegation-invites", &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, nil)
	if s := press(carol, inviteMessage(t, carol, bt.id), "delegation_accept", "c"); s != 200 {
		t.Fatalf("accept: %d %s", s, carol.lastBody)
	}

	text := mustTool(t, bt, carol.id, "create_task", map[string]any{"board": boardA.GetId(), "title": "за carol"})
	var created struct{ ID string }
	_ = json.Unmarshal([]byte(text), &created)
	var tr v1.TaskResponse
	o.must(200, "GET", "/api/tasks/"+created.ID, nil, &tr)
	if tr.GetTask().GetCreatedBy() != carol.id {
		t.Fatalf("created_by %s, want carol", tr.GetTask().GetCreatedBy())
	}
	for _, c := range []struct {
		name string
		args map[string]any
		want string
	}{
		{"read", map[string]any{"task": taskB.GetId()}, "ON_BEHALF_NO_CONSENT"},
		{"comment_task", map[string]any{"task": taskB.GetId(), "text": "x"}, "ON_BEHALF_NO_CONSENT"},
		{"update_task", map[string]any{"task": taskB.GetId(), "title": "x"}, "ON_BEHALF_NO_CONSENT"},
		{"assign", map[string]any{"task": taskB.GetId(), "users": []string{"me"}}, "ON_BEHALF_NO_CONSENT"},
		{"create_task", map[string]any{"board": boardB.GetId(), "title": "x"}, "ON_BEHALF_NO_CONSENT"},
		{"list_tasks", map[string]any{"board": boardB.GetId()}, "ON_BEHALF_NO_CONSENT"},
		{"read", map[string]any{"task": taskB.GetKey()}, "ON_BEHALF_ROUTE"},
		{"list_tasks", map[string]any{"mine": true}, "ON_BEHALF_ROUTE"},
		{"find", map[string]any{"q": "чужом"}, "ON_BEHALF_ROUTE"},
	} {
		if st, text, isErr := mcpToolAs(t, bt, carol.id, c.name, c.args); st != 200 || !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s %v: %d %v %s; want %s", c.name, c.args, st, isErr, text, c.want)
		}
	}
	roomB := textRoom(t, o, wb, "mcp-b", false)
	var dm v1.CreateDmResponse
	o.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: carol.id}, &dm)
	dmRoom := dm.GetDm().GetRoom().GetId()
	for _, c := range []struct {
		name string
		args map[string]any
		want string
	}{
		{"set_task_status", map[string]any{"task": taskB.GetId(), "status": "Done"}, "ON_BEHALF_NO_CONSENT"},
		{"send_message", map[string]any{"room": roomB, "text": "x"}, "ON_BEHALF_NO_CONSENT"},
		{"read", map[string]any{"room": roomB}, "ON_BEHALF_NO_CONSENT"},
		{"send_message", map[string]any{"room": dmRoom, "text": "x"}, "ON_BEHALF_ROUTE"}, // her DM: no workspace of the consent
		{"create_task", map[string]any{"board": "MCA", "title": "x"}, "ON_BEHALF_ROUTE"}, // a board key needs the workspace list
	} {
		if st, text, isErr := mcpToolAs(t, bt, carol.id, c.name, c.args); st != 200 || !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s %v: %d %v %s; want %s", c.name, c.args, st, isErr, text, c.want)
		}
	}
	// By id the task of A is hers to comment on (workspace narrows keys only).
	mustTool(t, bt, carol.id, "comment_task", map[string]any{"task": created.ID, "text": "по id"})
	// The write gate itself (not only the read before it): a direct PATCH on behalf in B.
	oc := asMember(bt, carol.id)
	title := "x"
	wantReason(t, oc, oc.do("PATCH", "/api/tasks/"+taskB.GetId(), &v1.UpdateTaskRequest{Title: &title}, nil), 403, "ON_BEHALF_NO_CONSENT")

	var got v1.TaskResponse
	o.must(200, "GET", "/api/tasks/"+taskB.GetId(), nil, &got)
	if got.GetTask().GetTitle() != "в чужом пространстве" || len(got.GetTask().GetAssignees()) != 0 || got.GetTask().GetCommentCount() != 0 ||
		got.GetTask().GetStatusId() != taskB.GetStatusId() {
		t.Fatalf("task in B changed: %v", got.GetTask())
	}
	var ms v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+roomB+"/messages", nil, &ms)
	if len(ms.GetMessages()) != 0 {
		t.Fatalf("room in B got %d messages", len(ms.GetMessages()))
	}

	// She revokes her consent: the next MCP call on her behalf is refused at once.
	o.must(200, "GET", "/api/tasks/"+created.ID, nil, &tr)
	comments := tr.GetTask().GetCommentCount()
	carol.must(200, "DELETE", "/api/workspaces/"+wa+"/bots/"+bt.id+"/delegations/"+carol.id, nil, nil)
	if st, text, _ := mcpToolAs(t, bt, carol.id, "comment_task", map[string]any{"task": created.ID, "text": "после отзыва"}); (st != http.StatusUnauthorized && st != http.StatusForbidden) ||
		(st == http.StatusForbidden && !strings.Contains(text, "ON_BEHALF_NO_CONSENT")) {
		t.Fatalf("after revoke: %d %s; want 401 revoked or 403 ON_BEHALF_NO_CONSENT", st, text)
	}
	o.must(200, "GET", "/api/tasks/"+created.ID, nil, &tr)
	if tr.GetTask().GetCommentCount() != comments {
		t.Fatalf("a comment after the revocation: %d → %d", comments, tr.GetTask().GetCommentCount())
	}
}

// TestMCPOnBehalfOfOwnerStaysInBotWorkspaces (second review of ADR-0156): on behalf of the
// owner, MCP reaches only the workspaces where the bot is a member and the owner's own sign-in
// is not required — the aggregate tools (list_tasks mine, find, a task key across workspaces)
// never show or touch the owner's tasks elsewhere; a person's own session gets no MCP, header
// or not; the owner's REST call through the bot is not marked «via MCP».
func TestMCPOnBehalfOfOwnerStaysInBotWorkspaces(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wa := ws.GetId()
	bt := createBot(t, o, wa, "mcpowner")
	if st, _ := setActsAsOwner(o, wa, bt.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}
	mine := func(wsID, key, title string) *v1.Task {
		b := createBoard(t, o, wsID, &v1.CreateBoardRequest{Name: key, Key: key}, 201)
		tk := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: title}, 201)
		o.must(200, "PUT", "/api/tasks/"+tk.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: o.id}}}, nil)
		return tk
	}
	ta := mine(wa, "MOA", "видно агенту")
	// X: the owner's workspace without the bot. S: with the bot, but enforced SSO.
	wx := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	tx := mine(wx, "MOX", "секрет без бота")
	wsS := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	o.must(201, "POST", "/api/workspaces/"+wsS+"/bots/add", &v1.AddBotRequest{BotUserId: bt.id}, nil)
	ts := mine(wsS, "MOS", "секрет под SSO")
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO workspace_identity_policies (workspace_id, mode) VALUES ($1, 'enforced')
		ON CONFLICT (workspace_id) DO UPDATE SET mode = 'enforced'`, wsS); err != nil {
		t.Fatal(err)
	}

	text := mustTool(t, bt, "owner", "list_tasks", map[string]any{"mine": true})
	if !strings.Contains(text, ta.GetKey()) || strings.Contains(text, tx.GetId()) || strings.Contains(text, ts.GetId()) {
		t.Fatalf("list_tasks mine on behalf: %s", text)
	}
	text = mustTool(t, bt, "owner", "find", map[string]any{"q": "секрет"})
	if strings.Contains(text, tx.GetId()) || strings.Contains(text, ts.GetId()) {
		t.Fatalf("find on behalf leaks: %s", text)
	}
	for _, c := range []struct {
		name string
		args map[string]any
	}{
		{"read", map[string]any{"task": tx.GetKey()}},
		{"read", map[string]any{"task": tx.GetId()}},
		{"read", map[string]any{"task": ts.GetKey()}},
		{"read", map[string]any{"task": ts.GetId()}},
		{"comment_task", map[string]any{"task": ts.GetId(), "text": "x"}},
		{"assign", map[string]any{"task": tx.GetKey(), "users": []string{"me"}, "mode": "remove"}},
		{"update_task", map[string]any{"task": ts.GetKey(), "title": "x"}},
		{"list_tasks", map[string]any{"workspace": wx}},
		{"list_tasks", map[string]any{"board": "MOS"}},
		{"create_task", map[string]any{"board": "MOX", "title": "x"}},
	} {
		if st, text, isErr := mcpToolAs(t, bt, "owner", c.name, c.args); st != 200 || !isErr || strings.Contains(text, "секрет") {
			t.Errorf("%s %v on behalf: %d %v %s; want a tool error", c.name, c.args, st, isErr, text)
		}
	}
	if _, err := testDB.Pool.Exec(context.Background(), `UPDATE workspace_identity_policies SET mode = 'off' WHERE workspace_id = $1`, wsS); err != nil {
		t.Fatal(err)
	}
	for _, tk := range []*v1.Task{tx, ts} {
		var got v1.TaskResponse
		o.must(200, "GET", "/api/tasks/"+tk.GetId(), nil, &got)
		if got.GetTask().GetTitle() != tk.GetTitle() || got.GetTask().GetCommentCount() != 0 || len(got.GetTask().GetAssignees()) != 1 {
			t.Fatalf("task outside the bot's reach changed: %v", got.GetTask())
		}
	}

	// A person's own session: no MCP, with the header or without.
	for _, who := range []string{"", "owner"} {
		if st, text, _ := mcpToolAs(t, &bot{client: o.client, id: o.id}, who, "list_tasks", map[string]any{"mine": true}); st != http.StatusForbidden {
			t.Fatalf("a person's session with %q: %d %s", who, st, text)
		}
	}

	// The owner through the bot over REST: via_bot_id, but not «via MCP».
	ob := asOwner(bt)
	var tr v1.TaskResponse
	o.must(200, "GET", "/api/tasks/"+ta.GetId(), nil, &tr)
	var cm v1.CreateMessageResponse
	ob.must(201, "POST", "/api/rooms/"+tr.GetTask().GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "через REST от имени"}, &cm)
	if m := cm.GetMessage(); m.GetViaBotId() != bt.id || m.GetVia() != "" {
		t.Fatalf("REST on behalf: via bot %q via %q", m.GetViaBotId(), m.GetVia())
	}
	high := v1.TaskPriority_TASK_PRIORITY_HIGH
	ob.must(200, "PATCH", "/api/tasks/"+ta.GetId(), &v1.UpdateTaskRequest{Priority: &high}, nil)
	var page v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+ta.GetId()+"/activity?limit=100", nil, &page)
	for _, it := range page.GetItems() {
		if a := it.GetActivity(); a != nil && a.GetVia() != "" {
			t.Errorf("journal %q marked via %q without MCP", a.GetKind(), a.GetVia())
		}
	}
}
