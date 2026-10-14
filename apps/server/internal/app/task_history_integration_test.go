//go:build integration

package app_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// journalOf: the task's journal entries (only=journal) of kind, newest first.
func journalOf(t *testing.T, u musty, taskID, kind string) []*v1.TaskActivity {
	t.Helper()
	var p v1.TaskActivityPage
	u.must(200, "GET", "/api/tasks/"+taskID+"/activity?only=journal&limit=100", nil, &p)
	var out []*v1.TaskActivity
	for _, it := range p.GetItems() {
		if it.GetMessage() != nil {
			t.Fatalf("only=journal returned a message: %v", it)
		}
		if a := it.GetActivity(); a.GetKind() == kind {
			out = append(out, a)
		}
	}
	return out
}

// TestTaskHistory (ADR-0091 §3): comments, their edits and deletions are journal entries with
// their text and files; the rule trigger comment_created fires on the "comment" entry exactly
// once; edits of one comment merge and an edit back leaves none; the snapshots of description,
// labels, attachments, parent, milestone and relation carry the values; ?only= splits the feed;
// comment entries make no task.updated webhook; the CSV export carries them.
func TestTaskHistory(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "История", Key: "HIS"}, 201)
	recv := newBoardHookRecv(t)
	var wr v1.BoardWebhookResponse
	o.must(200, "PUT", "/api/boards/"+b.GetId()+"/webhook", &v1.SetBoardWebhookRequest{Url: recv.srv.URL}, &wr)
	recv.mu.Lock()
	recv.secret = wr.GetSecret()
	recv.mu.Unlock()
	rule := createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "Комментарий → срочно",
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_CommentCreated_{CommentCreated: &v1.RuleTrigger_CommentCreated{}}},
		Actions: []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_URGENT)}}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт"}, 201)
	id := task.GetId()
	gw := dialGW(t)
	gw.identify(o.token)

	// A comment with a file: one "comment" entry (author, text, file name); the rule fires once.
	_, f, _ := upload(t, bob, "/api/boards/"+b.GetId()+"/files", "схема.png", pngBytes(8, 8))
	var cr v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "первый вариант", AttachmentIds: []string{f.GetId()}, Nonce: uniq("h")}, &cr)
	mid := cr.GetMessage().GetId()
	cs := journalOf(t, o, id, "comment")
	if len(cs) != 1 || cs[0].GetActorId() != bob.id || cs[0].GetBefore() != nil {
		t.Fatalf("comment entries: %v", cs)
	}
	after := cs[0].GetAfter().GetFields()
	files := after["attachments"].GetListValue().GetValues()
	if after["message_id"].GetStringValue() != mid || after["text"].GetStringValue() != "первый вариант" || after["forwarded"].GetBoolValue() ||
		len(files) != 1 || files[0].GetStructValue().GetFields()["name"].GetStringValue() != "схема.png" {
		t.Fatalf("comment entry: %v", cs[0])
	}
	if runs := ruleRuns(t, o, rule.GetId()); len(runs) != 1 {
		t.Fatalf("comment_created ran %d times", len(runs))
	}
	if ps := journalOf(t, o, id, "priority"); len(ps) != 1 || ps[0].GetRuleId() != rule.GetId() {
		t.Fatalf("the rule's priority: %v", ps)
	}
	gw.wait("TASK_ACTIVITY comment", func(e *v1.DispatchEvent) bool {
		return e.GetTaskActivity().GetActivity().GetKind() == "comment"
	})

	// The mixed feed keeps the comment as its message only; only=comments has no entries.
	var mixed, comments v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+id+"/activity?limit=100", nil, &mixed)
	for _, it := range mixed.GetItems() {
		if it.GetActivity().GetKind() == "comment" {
			t.Fatalf("a comment entry in the mixed feed: %v", it)
		}
	}
	o.must(200, "GET", "/api/tasks/"+id+"/activity?only=comments&limit=100", nil, &comments)
	if n := len(comments.GetItems()); n != 1 || comments.GetItems()[0].GetMessage().GetId() != mid {
		t.Fatalf("only=comments: %v", comments.GetItems())
	}
	o.must(400, "GET", "/api/tasks/"+id+"/activity?only=all", nil, nil)

	// Edits: one entry with the first text before and the last after; back to the start — none.
	edit := func(text string) {
		bob.must(200, "PATCH", "/api/messages/"+mid, &v1.UpdateMessageRequest{Content: text}, nil)
	}
	edit("второй вариант")
	edit("третий вариант")
	es := journalOf(t, o, id, "comment_edit")
	if len(es) != 1 || es[0].GetActorId() != bob.id || es[0].GetBefore().GetFields()["text"].GetStringValue() != "первый вариант" ||
		es[0].GetAfter().GetFields()["text"].GetStringValue() != "третий вариант" || es[0].GetAfter().GetFields()["message_id"].GetStringValue() != mid ||
		len(es[0].GetAfter().GetFields()["attachments"].GetListValue().GetValues()) != 1 {
		t.Fatalf("merged edits: %v", es)
	}
	gw.wait("TASK_ACTIVITY comment_edit", func(e *v1.DispatchEvent) bool {
		return e.GetTaskActivity().GetActivity().GetKind() == "comment_edit"
	})
	edit("первый вариант")
	if es := journalOf(t, o, id, "comment_edit"); len(es) != 0 {
		t.Fatalf("an edit back left %v", es)
	}
	// Another comment's edit does not merge into this one's.
	var cr2 v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "второй", Nonce: uniq("h")}, &cr2)
	edit("исправлено")
	bob.must(200, "PATCH", "/api/messages/"+cr2.GetMessage().GetId(), &v1.UpdateMessageRequest{Content: "второй!"}, nil)
	if es := journalOf(t, o, id, "comment_edit"); len(es) != 2 {
		t.Fatalf("edits of two comments: %v", es)
	}
	if runs := ruleRuns(t, o, rule.GetId()); len(runs) != 2 {
		t.Fatalf("comment_created ran %d times for two comments", len(runs))
	}

	// A moderator deletes bob's comment: the actor is the moderator, the author and text stay.
	o.must(204, "DELETE", "/api/messages/"+mid, nil, nil)
	ds := journalOf(t, o, id, "comment_delete")
	if len(ds) != 1 || ds[0].GetActorId() != o.id || ds[0].GetAfter() != nil {
		t.Fatalf("delete entries: %v", ds)
	}
	before := ds[0].GetBefore().GetFields()
	if before["author_id"].GetStringValue() != bob.id || before["text"].GetStringValue() != "исправлено" || before["message_id"].GetStringValue() != mid ||
		len(before["attachments"].GetListValue().GetValues()) != 1 {
		t.Fatalf("deleted comment: %v", ds[0])
	}

	// Snapshots: description text, labels and attachments by name, parent / relation by key.
	desc := "Новое описание задачи"
	patchTask(t, o, id, &v1.UpdateTaskRequest{Description: &desc}, 200)
	if ds := journalOf(t, o, id, "description"); len(ds) != 1 || ds[0].GetBefore().GetFields()["text"].GetStringValue() != "" ||
		ds[0].GetAfter().GetFields()["text"].GetStringValue() != desc || ds[0].GetAfter().GetFields()["length"].GetNumberValue() != 21 {
		t.Fatalf("description: %v", ds)
	}
	bug := createLabel(t, o, b.GetId(), "Баг")
	patchTask(t, o, id, &v1.UpdateTaskRequest{SetLabels: true, LabelIds: []string{bug}}, 200)
	ls := journalOf(t, o, id, "labels")
	if len(ls) != 1 || len(ls[0].GetAfter().GetFields()["labels"].GetListValue().GetValues()) != 1 ||
		ls[0].GetAfter().GetFields()["labels"].GetListValue().GetValues()[0].GetStructValue().GetFields()["name"].GetStringValue() != "Баг" ||
		len(ls[0].GetBefore().GetFields()["labels"].GetListValue().GetValues()) != 0 {
		t.Fatalf("labels: %v", ls)
	}
	_, f2, _ := upload(t, o, "/api/boards/"+b.GetId()+"/files", "смета.png", pngBytes(8, 8))
	patchTask(t, o, id, &v1.UpdateTaskRequest{SetAttachments: true, AttachmentIds: []string{f2.GetId()}}, 200)
	as := journalOf(t, o, id, "attachments")
	if len(as) != 1 || as[0].GetAfter().GetFields()["files"].GetListValue().GetValues()[0].GetStructValue().GetFields()["name"].GetStringValue() != "смета.png" ||
		as[0].GetAfter().GetFields()["file_ids"].GetListValue().GetValues()[0].GetStringValue() != f2.GetId() {
		t.Fatalf("attachments: %v", as)
	}
	parent := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Эпик"}, 201)
	pid := parent.GetId()
	patchTask(t, o, id, &v1.UpdateTaskRequest{ParentId: &pid}, 200)
	if ps := journalOf(t, o, id, "parent"); len(ps) != 1 || ps[0].GetAfter().GetFields()["key"].GetStringValue() != parent.GetKey() ||
		ps[0].GetAfter().GetFields()["title"].GetStringValue() != "Эпик" || ps[0].GetBefore().GetFields()["key"] != nil {
		t.Fatalf("parent: %v", ps)
	}
	var br v1.BoardResponse
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/milestones", &v1.CreateBoardMilestoneRequest{Name: "Релиз 3.3"}, &br)
	ms := br.GetBoard().GetMilestones()[0].GetId()
	patchTask(t, o, id, &v1.UpdateTaskRequest{MilestoneId: &ms}, 200)
	if mss := journalOf(t, o, id, "milestone"); len(mss) != 1 || mss[0].GetAfter().GetFields()["name"].GetStringValue() != "Релиз 3.3" {
		t.Fatalf("milestone: %v", mss)
	}
	other := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Блокер"}, 201)
	o.must(200, "PUT", "/api/tasks/"+id+"/relations", &v1.SetTaskRelationRequest{RelatedId: other.GetId(), Kind: v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS}, nil)
	if rs := journalOf(t, o, id, "relation"); len(rs) != 1 || rs[0].GetAfter().GetFields()["key"].GetStringValue() != other.GetKey() ||
		rs[0].GetAfter().GetFields()["title"].GetStringValue() != "Блокер" {
		t.Fatalf("relation: %v", rs)
	}
	// The live entry goes to every viewer at once: the other task by id only (ADR-0059).
	gw.wait("TASK_ACTIVITY relation", func(e *v1.DispatchEvent) bool {
		a := e.GetTaskActivity().GetActivity()
		if a.GetKind() != "relation" {
			return false
		}
		if f := a.GetAfter().GetFields(); f["title"] != nil || f["key"] != nil || f["related_id"].GetStringValue() != other.GetId() {
			t.Fatalf("live relation entry names the task: %v", a)
		}
		return true
	})

	// Webhooks: task.comment.* as before, no task.updated for comment entries.
	evs := recv.wait("comment deleted", func(evs []*v1.BoardWebhookEvent) bool {
		for _, ev := range evs {
			if ev.GetType() == "task.comment.deleted" {
				return true
			}
		}
		return false
	})
	n := map[string]int{}
	for _, ev := range evs {
		n[ev.GetType()]++
		for _, ch := range ev.GetChanges() {
			if strings.HasPrefix(ch.GetField(), "comment") {
				t.Fatalf("a comment entry in %s: %v", ev.GetType(), ev)
			}
		}
	}
	if n["task.comment.created"] != 2 || n["task.comment.updated"] != 5 {
		t.Fatalf("comment webhooks: %v", n)
	}

	// The CSV export carries the new kinds.
	req, _ := http.NewRequestWithContext(t.Context(), "GET", srv.URL+"/api/boards/"+b.GetId()+"/activity?format=csv", nil)
	req.Header.Set("Authorization", "Bearer "+o.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	for _, k := range []string{",comment,", ",comment_edit,", ",comment_delete,", "исправлено"} {
		if resp.StatusCode != 200 || !strings.Contains(string(body), k) {
			t.Fatalf("CSV %d without %q:\n%s", resp.StatusCode, k, body)
		}
	}
}
