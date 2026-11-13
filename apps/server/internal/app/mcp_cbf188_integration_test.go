//go:build integration

package app_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// The CBF-188 tools through a person's MCP connection (OAuth: the inner routes are an
// allowlist, so every tool is run here) and through a bot — by itself and on behalf.

// mcpToolErr calls a tool expecting a tool error; it returns the error text.
func mcpToolErr(t *testing.T, access, name string, args map[string]any) string {
	t.Helper()
	st, out, _ := mcpCall(t, access, "tools/call", map[string]any{"name": name, "arguments": args})
	res, _ := out["result"].(map[string]any)
	if st != 200 || res == nil || res["isError"] != true {
		t.Fatalf("%s: want a tool error, got %d %v", name, st, out)
	}
	return res["content"].([]any)[0].(map[string]any)["text"].(string)
}

func TestMCPCalendarPeopleApproval(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	tz := "Europe/Moscow"
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Timezone: &tz}, nil)
	cid := mcpRegister(t, mcpTestRedirect)
	f := mcpAuthorize(t, cid)
	access, _ := mcpExchange(t, f, codeOf(t, f.consent(t, bob.token, f.cookie, true, 200)))

	// ---- calendar: create with an attendee and a room, list, free/busy, slots, reschedule, comment, cancel
	day := time.Now().In(time.UTC).AddDate(0, 0, 3).Format(time.DateOnly)
	text := mcpToolText(t, access, "event", map[string]any{"action": "create", "title": "Синк", "start": day + "T10:00+03:00", "duration": 45,
		"users": []string{o.id}, "room": voice.GetName()})
	var ev struct{ ID, When, Room, TZ string }
	_ = json.Unmarshal([]byte(text), &ev)
	if ev.ID == "" || ev.When != day+" 10:00–10:45" || ev.Room != voice.GetId() || ev.TZ != tz {
		t.Fatalf("create: %s", text)
	}
	if text = mcpToolText(t, access, "calendar", map[string]any{"from": day, "to": day}); !strings.Contains(text, ev.ID) || !strings.Contains(text, `"tz":"Europe/Moscow"`) {
		t.Fatalf("list: %s", text)
	}
	if text = mcpToolText(t, access, "calendar", map[string]any{"action": "freebusy", "users": []string{"me", o.id}, "from": day, "to": day}); strings.Count(text, ev.ID) != 2 {
		t.Fatalf("freebusy: %s", text)
	}
	if text = mcpToolText(t, access, "calendar", map[string]any{"action": "suggest", "users": []string{"me", o.id}, "from": day + "T10:00+03:00",
		"to": day + "T12:00+03:00", "work_hours": false, "duration": 30}); !strings.Contains(text, day+" 10:45–11:15") {
		t.Fatalf("suggest (busy until 10:45): %s", text)
	}
	if text = mcpToolText(t, access, "event", map[string]any{"action": "update", "event": ev.ID, "start": day + "T15:00+03:00"}); !strings.Contains(text, day+" 15:00–15:45") {
		t.Fatalf("reschedule keeps the length: %s", text)
	}
	mcpToolText(t, access, "event", map[string]any{"action": "comment", "event": ev.ID, "text": "перенёс на 15"})
	if text = mcpToolText(t, access, "calendar", map[string]any{"action": "event", "event": ev.ID}); !strings.Contains(text, "перенёс на 15") || !strings.Contains(text, o.id) {
		t.Fatalf("event with comments: %s", text)
	}
	// o sees bob's meeting too; a stranger's event id is not found.
	if text = mcpToolErr(t, access, "event", map[string]any{"action": "cancel", "event": "00000000-0000-0000-0000-000000000000"}); !strings.Contains(text, "404") {
		t.Fatalf("cancel unknown: %s", text)
	}
	mcpToolText(t, access, "event", map[string]any{"action": "cancel", "event": ev.ID})
	var gone v1.CalendarEventResponse
	o.must(200, "GET", "/api/events/"+ev.ID, nil, &gone)
	if gone.GetEvent().GetCancelledAt() == nil {
		t.Fatalf("not cancelled: %v", gone.GetEvent())
	}

	// ---- people
	if text = mcpToolText(t, access, "read", map[string]any{"person": "me"}); !strings.Contains(text, `"timezone":"Europe/Moscow"`) || !strings.Contains(text, bob.id) {
		t.Fatalf("person me: %s", text)
	}
	if text = mcpToolText(t, access, "read", map[string]any{"person": o.id}); !strings.Contains(text, `"role":"owner"`) {
		t.Fatalf("person owner: %s", text)
	}
	priv := textRoom(t, o, wid, uniq("mcp-priv-"), true)
	if text = mcpToolErr(t, access, "read", map[string]any{"room": priv, "members": true}); !strings.Contains(text, "404") {
		t.Fatalf("private room members for a stranger: %s", text)
	}
	if text = mcpToolText(t, access, "read", map[string]any{"room": voice.GetId(), "members": true}); !strings.Contains(text, o.id) || !strings.Contains(text, bob.id) {
		t.Fatalf("members: %s", text)
	}

	// ---- messages: a DM by person, it shows in o's inbox (through o's own connection), a reaction, a mention
	text = mcpToolText(t, access, "send_message", map[string]any{"to": o.id, "text": "привет напрямую"})
	var sent struct{ ID, Room string }
	_ = json.Unmarshal([]byte(text), &sent)
	fo := mcpAuthorize(t, cid)
	accessO, _ := mcpExchange(t, fo, codeOf(t, fo.consent(t, o.token, fo.cookie, true, 200)))
	general := textRoom(t, o, wid, uniq("mcp-general-"), false)
	mcpToolText(t, access, "send_message", map[string]any{"room": general, "text": "<@" + o.id + "> глянь"})
	if text = mcpToolText(t, accessO, "inbox", map[string]any{}); !strings.Contains(text, "привет напрямую") || !strings.Contains(text, "глянь") || !strings.Contains(text, `"unread":1`) {
		t.Fatalf("inbox: %s", text)
	}
	mcpToolText(t, accessO, "react", map[string]any{"message": sent.ID, "emoji": "👍"})
	mcpToolText(t, accessO, "react", map[string]any{"message": sent.ID, "emoji": "👍", "mode": "remove"})
	privMsg := send(t, o, priv, "секрет", "")
	if text = mcpToolErr(t, access, "react", map[string]any{"message": privMsg.GetId(), "emoji": "👍"}); !strings.Contains(text, "404") {
		t.Fatalf("react in a hidden room: %s", text)
	}

	// ---- tasks: checklist, links, approval
	board := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Ap", Key: "MAP", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	task := createTask(t, o, board.GetId(), &v1.CreateTaskRequest{Title: "Релиз", ApproverIds: []string{bob.id, o.id}}, 201)
	other := createTask(t, o, board.GetId(), &v1.CreateTaskRequest{Title: "Миграция"}, 201)
	if text = mcpToolErr(t, access, "checklist", map[string]any{"task": task.GetKey(), "action": "add", "item": "x"}); !strings.Contains(text, "403") {
		t.Fatalf("checklist without the right: %s", text) // a member edits only own and assigned tasks
	}
	o.must(200, "PUT", "/api/tasks/"+task.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	o.must(200, "PUT", "/api/tasks/"+other.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	mcpToolText(t, access, "checklist", map[string]any{"task": task.GetKey(), "action": "add", "items": []string{"Тесты", "Changelog"}})
	if text = mcpToolText(t, access, "checklist", map[string]any{"task": task.GetKey(), "item": "тесты"}); !strings.Contains(text, `"done":"1/2"`) {
		t.Fatalf("check: %s", text)
	}
	if text = mcpToolText(t, access, "link_tasks", map[string]any{"task": task.GetKey(), "related": other.GetKey(), "kind": "blocked_by"}); !strings.Contains(text, `"kind":"blocked_by"`) {
		t.Fatalf("link: %s", text)
	}
	if text = mcpToolText(t, access, "read", map[string]any{"task": task.GetKey()}); !strings.Contains(text, `"pending":["`) || !strings.Contains(text, other.GetKey()) || !strings.Contains(text, "[x] Тесты") {
		t.Fatalf("read approval: %s", text)
	}
	if text = mcpToolErr(t, access, "approve", map[string]any{"task": task.GetKey(), "decision": "reject"}); !strings.Contains(text, "reason is required") {
		t.Fatalf("reject without reason: %s", text)
	}
	if text = mcpToolText(t, access, "approve", map[string]any{"task": task.GetKey(), "decision": "reject", "reason": "нет тестов"}); !strings.Contains(text, `"state":"rejected"`) {
		t.Fatalf("reject: %s", text)
	}
	mcpToolText(t, access, "link_tasks", map[string]any{"task": task.GetKey(), "related": other.GetKey(), "kind": "blocked_by", "mode": "remove"})

	// A task of a private board: not visible, nothing changes.
	sec := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Sec", Key: "MSC", IsPrivate: true}, 201)
	secret := createTask(t, o, sec.GetId(), &v1.CreateTaskRequest{Title: "тайна"}, 201)
	if text = mcpToolErr(t, access, "checklist", map[string]any{"task": secret.GetId(), "action": "add", "item": "x"}); !strings.Contains(text, "404") {
		t.Fatalf("hidden task checklist: %s", text)
	}

	// ---- a bot by itself cannot vote; on behalf of its owner the vote is the owner's; meeting comments are closed on behalf
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+bob.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	bt := createBot(t, bob, wid, "cbf188bot")
	if st, _ := setActsAsOwner(bob, wid, bt.id, true); st != 200 {
		t.Fatalf("acts as owner: %d", st)
	}
	if _, text, isErr := mcpToolAs(t, bt, "", "approve", map[string]any{"task": task.GetId(), "decision": "approve"}); !isErr || !strings.Contains(text, "BOT_NOT_ALLOWED") || !strings.Contains(text, "Calab-On-Behalf") {
		t.Fatalf("plain bot vote: %s", text)
	}
	if text = mustTool(t, bt, "owner", "approve", map[string]any{"task": task.GetId(), "decision": "approve"}); !strings.Contains(text, `{"user":"`+bob.id+`","vote":"approved"}`) {
		t.Fatalf("vote on behalf: %s", text)
	}
	ev2 := mustTool(t, bt, "owner", "event", map[string]any{"action": "create", "workspace": wid, "title": "Через бота", "start": day + "T18:00+03:00"})
	_ = json.Unmarshal([]byte(ev2), &ev)
	if _, text, isErr := mcpToolAs(t, bt, "owner", "event", map[string]any{"action": "comment", "event": ev.ID, "text": "x"}); !isErr || !strings.Contains(text, "ON_BEHALF_ROUTE") {
		t.Fatalf("meeting comment on behalf: %s", text)
	}
	// ...but a meeting with comments is still read on behalf (without them).
	bob.must(201, "POST", "/api/events/"+ev.ID+"/comments", &v1.CalendarEventCommentRequest{Body: "сам"}, nil)
	if text = mustTool(t, bt, "owner", "calendar", map[string]any{"action": "event", "event": ev.ID}); !strings.Contains(text, "Через бота") || strings.Contains(text, "сам") {
		t.Fatalf("meeting read on behalf: %s", text)
	}
	// The bot by itself: inbox and calendar work within its own rights.
	mustTool(t, bt, "", "inbox", map[string]any{})
	mustTool(t, bt, "", "calendar", map[string]any{"workspace": wid})
}
