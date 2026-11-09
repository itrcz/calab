//go:build integration

package app_test

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestInboxDismiss (CBF-155, ADR-0163): the ✕ on «Упоминания» cards. A dismissed chat mention
// (direct or @everyone) leaves GET /api/me/mentions for good — an edit that mentions again does
// not bring it back — and pages stay full; a dismissed task notice leaves the history; only the
// caller's own rows change; INBOX_DISMISS reaches the caller's sessions only.
func TestInboxDismiss(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	mentions := func(u *user, query string) []*v1.Message {
		t.Helper()
		var out v1.ListMessagesResponse
		u.must(200, "GET", "/api/me/mentions"+query, nil, &out)
		return out.GetMessages()
	}
	notices := func(u *user) []*v1.TaskNoticeEntry {
		t.Helper()
		var out v1.ListTaskNoticesResponse
		u.must(200, "GET", "/api/me/task-notices", nil, &out)
		return out.GetEntries()
	}
	first := send(t, o, rid, "hi @"+bob.id, "")
	everyone := send(t, o, rid, "@everyone lunch", "")
	last := send(t, o, rid, "and @"+bob.id+" again", "")

	gb := dialGW(t)
	gb.identify(bob.token)
	og := dialGW(t)
	og.identify(o.token)

	bob.must(204, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{MessageIds: []string{everyone.GetId(), first.GetId()}}, nil)
	gb.wait("INBOX_DISMISS", func(e *v1.DispatchEvent) bool {
		d := e.GetInboxDismiss()
		return d != nil && len(d.GetMessageIds()) == 2 && len(d.GetNoticeIds()) == 0
	})
	got := mentions(bob, "")
	if len(got) != 1 || got[0].GetId() != last.GetId() {
		t.Fatalf("after dismiss: %v", got)
	}
	// Pages skip dismissed rows inside the scan: a one-row page is still full and the end.
	if page := mentions(bob, "?limit=1"); len(page) != 1 || page[0].GetId() != last.GetId() {
		t.Fatalf("page: %v", page)
	}
	// Re-mentioning by an edit keeps it dismissed; the owner's own list is untouched.
	o.must(200, "PATCH", "/api/messages/"+first.GetId(), &v1.UpdateMessageRequest{Content: "hey @" + bob.id}, nil)
	if got := mentions(bob, ""); len(got) != 1 {
		t.Fatalf("edit brought a dismissed mention back: %v", got)
	}
	// Idempotent; unknown ids are ignored, never an error that tells they exist.
	bob.must(204, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{MessageIds: []string{first.GetId(), uuid.NewString()}, NoticeIds: []string{uuid.NewString()}}, nil)
	// Deleting a dismissed message drops its dismissal rows (no FK cascade on soft delete).
	o.must(204, "DELETE", "/api/messages/"+first.GetId(), nil, nil)

	// Task notices: bob's own history row goes; the owner's dismissal of bob's notice does nothing.
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Входящие", Key: "DIS"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Отчёт", Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	live := gb.wait("assigned", noticeOf(task.GetId(), v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED)).GetTaskUpdate().GetNotice()
	o.must(204, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{NoticeIds: []string{live.GetId()}}, nil)
	if es := notices(bob); len(es) != 1 || es[0].GetId() != live.GetId() {
		t.Fatalf("another user's dismissal removed bob's notice: %v", es)
	}
	bob.must(204, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{NoticeIds: []string{live.GetId()}}, nil)
	gb.wait("INBOX_DISMISS notice", func(e *v1.DispatchEvent) bool {
		d := e.GetInboxDismiss()
		return d != nil && len(d.GetNoticeIds()) == 1 && d.GetNoticeIds()[0] == live.GetId()
	})
	if es := notices(bob); len(es) != 0 {
		t.Fatalf("dismissed notice still listed: %v", es)
	}
	// The owner's sessions heard only the owner's own (no-op) dismissal, never bob's.
	og.wait("owner INBOX_DISMISS", func(e *v1.DispatchEvent) bool {
		d := e.GetInboxDismiss()
		if d != nil && len(d.GetMessageIds()) > 0 {
			t.Fatalf("bob's dismissal leaked to the owner: %v", d)
		}
		return d != nil
	})

	// Validation.
	bob.must(422, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{}, nil)
	bob.must(422, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{MessageIds: []string{"nope"}}, nil)
	many := make([]string, 101)
	for i := range many {
		many[i] = uuid.NewString()
	}
	bob.must(422, "POST", "/api/me/inbox/dismiss", &v1.InboxDismiss{MessageIds: many}, nil)
}
