//go:build integration

package app_test

import (
	"context"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// ageActivity moves a task's journal entries out of the merge window (ADR-0081): the next
// change of the same field makes its own entry.
func ageActivity(t *testing.T, taskID string) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(),
		"UPDATE task_activity SET created_at = created_at - interval '10 minutes' WHERE task_id = $1", taskID); err != nil {
		t.Fatal(err)
	}
}

func activityOf(t *testing.T, u musty, taskID, kind string) []*v1.TaskActivity {
	t.Helper()
	var p v1.TaskActivityPage
	u.must(200, "GET", "/api/tasks/"+taskID+"/activity?limit=100", nil, &p)
	var out []*v1.TaskActivity
	for _, it := range p.GetItems() {
		if a := it.GetActivity(); a != nil && a.GetKind() == kind {
			out = append(out, a)
		}
	}
	return out
}

// TestTaskActivityCoalesce (ADR-0081): repeated changes of a field by the same user within the
// window are one journal entry (first before, last after, a new id); a change back to where it
// was leaves none; another user's change in between or an older entry is not merged; the
// webhook still gets every change.
func TestTaskActivityCoalesce(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Coalesce", Key: "COA", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	todo, started, done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED), statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED), statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	recv := newBoardHookRecv(t)
	var wr v1.BoardWebhookResponse
	o.must(200, "PUT", "/api/boards/"+b.GetId()+"/webhook", &v1.SetBoardWebhookRequest{Url: recv.srv.URL}, &wr)
	recv.mu.Lock()
	recv.secret = wr.GetSecret()
	recv.mu.Unlock()
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x", StatusId: todo, Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, 201)
	id := task.GetId()
	move := func(u musty, to string) { patchTask(t, u, id, &v1.UpdateTaskRequest{StatusId: &to}, 200) }
	status := func(a *v1.TaskActivity) (string, string) {
		return a.GetBefore().GetFields()["status_id"].GetStringValue(), a.GetAfter().GetFields()["status_id"].GetStringValue()
	}

	// A→B→C: one entry A→C, superseding the first one (a new id, sorted last).
	move(o, started)
	first := activityOf(t, o, id, "status")
	move(o, done)
	rows := activityOf(t, o, id, "status")
	if len(first) != 1 || len(rows) != 1 || rows[0].GetId() == first[0].GetId() || rows[0].GetId() < first[0].GetId() || rows[0].GetActorId() != o.id {
		t.Fatalf("A→B→C: %v → %v", first, rows)
	}
	if from, to := status(rows[0]); from != todo || to != done {
		t.Fatalf("A→B→C merged %s → %s", from, to)
	}
	// …→A: the field is back, no entry at all.
	move(o, todo)
	if rows := activityOf(t, o, id, "status"); len(rows) != 0 {
		t.Fatalf("A→B→A left %v", rows)
	}

	// Another user in between: three entries.
	move(o, started)
	move(bob, done)
	move(o, todo)
	if rows := activityOf(t, o, id, "status"); len(rows) != 3 {
		t.Fatalf("other user in between: %v", rows)
	}

	// Older than the window: a new entry.
	ageActivity(t, id)
	move(o, started)
	if rows := activityOf(t, o, id, "status"); len(rows) != 4 {
		t.Fatalf("after the window: %v", rows)
	}

	// Other kinds merge the same way: a set compares as a set.
	prio, low := v1.TaskPriority_TASK_PRIORITY_HIGH, v1.TaskPriority_TASK_PRIORITY_NONE
	patchTask(t, o, id, &v1.UpdateTaskRequest{Priority: &prio}, 200)
	patchTask(t, o, id, &v1.UpdateTaskRequest{Priority: &low}, 200)
	if rows := activityOf(t, o, id, "priority"); len(rows) != 0 {
		t.Fatalf("priority there and back: %v", rows)
	}
	o.must(200, "PUT", "/api/tasks/"+id+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, IsLead: true}, {UserId: o.id}}}, nil)
	o.must(200, "PUT", "/api/tasks/"+id+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id, IsLead: true}}}, nil)
	if rows := activityOf(t, o, id, "assignees"); len(rows) != 0 {
		t.Fatalf("assignees there and back: %v", rows)
	}

	// The webhook saw every change: 2 + 1 + 3 + 1 status moves.
	recv.wait("every status change", func(evs []*v1.BoardWebhookEvent) bool {
		n := 0
		for _, ev := range evs {
			for _, ch := range ev.GetChanges() {
				if ch.GetField() == "status" {
					n++
				}
			}
		}
		return n == 7
	})
}
