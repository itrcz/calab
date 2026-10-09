//go:build integration

package app_test

import (
	"context"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Delayed approval notices (ADR-0082).

func setNotifyDelay(t *testing.T, u musty, boardID string, secs uint32, want int) *v1.Board {
	t.Helper()
	var r v1.BoardResponse
	u.must(want, "PATCH", "/api/boards/"+boardID, &v1.UpdateBoardRequest{ApprovalNotifyDelaySeconds: &secs}, &r)
	return r.GetBoard()
}

// TestTaskApprovalNotifyDelay: the per-board delay (default 1 min; validation and MANAGE_BOARD),
// the notice goes out only when due and only to approvers still pending; a removed approver
// gets nothing; a reset re-requests only the dropped decided votes (re_requested) while pending
// ones keep their schedule; reminders count from the notice; concurrent deliverers send once;
// delay 0 is immediate.
func TestTaskApprovalNotifyDelay(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	ctx := context.Background()

	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Delayed approvals", Key: "DAP"}, 201)
	if d := b.GetApprovalNotifyDelaySeconds(); d != 60 {
		t.Fatalf("default delay %d, want 60", d)
	}
	setNotifyDelay(t, o, b.GetId(), 42, 422)
	setNotifyDelay(t, bob, b.GetId(), 0, 403)
	if d := setNotifyDelay(t, o, b.GetId(), 300, 200).GetApprovalNotifyDelaySeconds(); d != 300 {
		t.Fatalf("delay %d, want 300", d)
	}
	setNotifyDelay(t, o, b.GetId(), 60, 200)

	gb, gc, gd := dialGW(t), dialGW(t), dialGW(t)
	gb.identify(bob.token)
	gc.identify(carol.token)
	gd.identify(dave.token)
	asked := func(taskID string) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			return e.GetTaskUpdate().GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED && e.GetTaskUpdate().GetTask().GetId() == taskID
		}
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := testDB.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	due := func(taskID string) {
		exec("UPDATE task_approvers SET notify_due_at = now() - interval '1 second' WHERE task_id = $1 AND notify_due_at IS NOT NULL", taskID)
	}
	deliver := func() {
		t.Helper()
		if _, err := testApp.Boards.DeliverApprovalNotices(ctx); err != nil {
			t.Fatal(err)
		}
	}
	type row struct {
		scheduled bool
		reason    string
		fresh     bool // requested_at within the last minute
	}
	state := func(taskID, userID string) row {
		t.Helper()
		var r row
		if err := testDB.Pool.QueryRow(ctx, `SELECT notify_due_at IS NOT NULL, notify_reason, requested_at > now() - interval '1 minute'
			FROM task_approvers WHERE task_id = $1 AND user_id = $2`, taskID, userID).Scan(&r.scheduled, &r.reason, &r.fresh); err != nil {
			t.Fatal(err)
		}
		return r
	}

	// Added: nothing at once, both scheduled; carol removed meanwhile gets nothing.
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Смета", ApproverIds: []string{bob.id, carol.id}}, 201)
	gb.quiet("a notice before the delay", 300*time.Millisecond, asked(task.GetId()))
	if r := state(task.GetId(), bob.id); !r.scheduled || r.reason != "requested" {
		t.Fatalf("bob after add %+v", r)
	}
	deliver() // not due yet
	gb.quiet("a notice before due", 200*time.Millisecond, asked(task.GetId()))
	setApprovers(o, task.GetId(), 200, 0, bob.id)
	exec("UPDATE task_approvers SET requested_at = now() - interval '2 days' WHERE task_id = $1", task.GetId())
	due(task.GetId())
	deliver()
	ev := gb.wait("the delayed notice", asked(task.GetId()))
	if n := ev.GetTaskUpdate().GetNotice(); n.GetReRequested() || n.GetActorId() != o.id || !ev.GetTaskUpdate().GetTask().GetUnread() {
		t.Fatalf("delayed notice %v", ev.GetTaskUpdate())
	}
	gc.quiet("a notice to a removed approver", 300*time.Millisecond, asked(task.GetId()))
	if r := state(task.GetId(), bob.id); r.scheduled || !r.fresh {
		t.Fatalf("bob after the notice %+v (the reminders count from the notice)", r)
	}
	deliver()
	gb.quiet("a second notice", 300*time.Millisecond, asked(task.GetId()))

	// Reset: bob's decided vote is dropped → re_requested; dave (pending, scheduled) keeps his
	// schedule and reason.
	voteTask(bob, task.GetId(), 200, approve, "")
	setApprovers(o, task.GetId(), 200, 0, bob.id, dave.id)
	var daveDue time.Time
	if err := testDB.Pool.QueryRow(ctx, "SELECT notify_due_at FROM task_approvers WHERE task_id = $1 AND user_id = $2", task.GetId(), dave.id).Scan(&daveDue); err != nil {
		t.Fatal(err)
	}
	title := "Смета v2"
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	gb.quiet("a re-request before the delay", 300*time.Millisecond, asked(task.GetId()))
	if r := state(task.GetId(), bob.id); !r.scheduled || r.reason != "re_requested" {
		t.Fatalf("bob after the reset %+v", r)
	}
	var daveAfter time.Time
	var daveReason string
	if err := testDB.Pool.QueryRow(ctx, "SELECT notify_due_at, notify_reason FROM task_approvers WHERE task_id = $1 AND user_id = $2", task.GetId(), dave.id).
		Scan(&daveAfter, &daveReason); err != nil {
		t.Fatal(err)
	}
	if !daveAfter.Equal(daveDue) || daveReason != "requested" {
		t.Fatalf("dave after the reset: due %v (was %v), reason %q", daveAfter, daveDue, daveReason)
	}
	due(task.GetId())
	deliver()
	if n := gb.wait("the re-request", asked(task.GetId())).GetTaskUpdate().GetNotice(); !n.GetReRequested() || n.GetActorId() != "" {
		t.Fatalf("re-request %v", n)
	}
	if n := gd.wait("dave's request", asked(task.GetId())).GetTaskUpdate().GetNotice(); n.GetReRequested() || n.GetActorId() != o.id {
		t.Fatalf("dave's notice %v", n)
	}
	gb.quiet("a second re-request", 300*time.Millisecond, asked(task.GetId()))
	gd.quiet("a second request to dave", 100*time.Millisecond, asked(task.GetId()))

	// A vote cast before the notice cancels it.
	setApprovers(o, task.GetId(), 200, 0, bob.id, dave.id, carol.id)
	voteTask(carol, task.GetId(), 200, approve, "")
	due(task.GetId())
	deliver()
	gc.quiet("a notice after the vote", 300*time.Millisecond, asked(task.GetId()))
	if r := state(task.GetId(), carol.id); r.scheduled {
		t.Fatalf("carol after the vote %+v", r)
	}

	// Two deliverers at once: one notice.
	second := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Вторая", ApproverIds: []string{carol.id}}, 201)
	due(second.GetId())
	var wg sync.WaitGroup
	sent := make([]int, 2)
	for i := range sent {
		wg.Go(func() {
			n, err := testApp.Boards.DeliverApprovalNotices(ctx)
			if err != nil {
				t.Error(err)
			}
			sent[i] = n
		})
	}
	wg.Wait()
	if sent[0]+sent[1] > 1 {
		t.Fatalf("concurrent deliveries sent %v", sent)
	}
	gc.wait("the notice", asked(second.GetId()))
	gc.quiet("a duplicate notice", 300*time.Millisecond, asked(second.GetId()))

	// APPROVALS switched off: a due notice is dropped.
	third := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Третья", ApproverIds: []string{dave.id}}, 201)
	o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{SetDisabledFeatures: true,
		DisabledFeatures: []v1.BoardFeature{v1.BoardFeature_BOARD_FEATURE_APPROVALS}}, nil)
	due(third.GetId())
	deliver()
	gd.quiet("a notice with APPROVALS off", 300*time.Millisecond, asked(third.GetId()))
	o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{SetDisabledFeatures: true}, nil)

	// Delay 0: at once, nothing scheduled.
	setNotifyDelay(t, o, b.GetId(), 0, 200)
	fourth := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Четвёртая", ApproverIds: []string{dave.id}}, 201)
	gd.wait("the immediate notice", asked(fourth.GetId()))
	if r := state(fourth.GetId(), dave.id); r.scheduled {
		t.Fatalf("dave with delay 0 %+v", r)
	}
}
