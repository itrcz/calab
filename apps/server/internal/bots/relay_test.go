package bots

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TaskNoticeEvent drops the viewer's state of the task (ADR-0090 §2) without touching the
// original (it is the user's own TASK_UPDATE).
func TestTaskNoticeEvent(t *testing.T) {
	n := &v1.TaskNoticeRelay{UserId: "u", Task: &v1.Task{Id: "t", Key: "OPS-1", Subscribed: true, Muted: true, Unread: true, ViewerState: true},
		Notice: &v1.TaskNotice{Kind: v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS}}
	got := TaskNoticeEvent(n).GetTaskNotice()
	if tk := got.GetTask(); tk.GetSubscribed() || tk.GetMuted() || tk.GetUnread() || tk.GetViewerState() || tk.GetKey() != "OPS-1" {
		t.Fatalf("relay task %v", tk)
	}
	if got.GetNotice().GetKind() != v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS || got.GetUserId() != "u" {
		t.Fatalf("relay %v", got)
	}
	if tk := n.GetTask(); !tk.GetSubscribed() || !tk.GetUnread() || !tk.GetViewerState() || !tk.GetMuted() {
		t.Fatal("the original task was modified")
	}
	plain := &v1.TaskNoticeRelay{Task: &v1.Task{Id: "t"}}
	if TaskNoticeEvent(plain).GetTaskNotice() != plain {
		t.Fatal("a relay without viewer state is copied")
	}
}
