//go:build integration

package app_test

import (
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// The board setting «Согласование держит переходы» (CBF-156, ADR-0160).

func setApprovalGate(t *testing.T, u musty, boardID string, g v1.ApprovalGate, want int) *v1.Board {
	t.Helper()
	var r v1.BoardResponse
	u.must(want, "PATCH", "/api/boards/"+boardID, &v1.UpdateBoardRequest{ApprovalGate: &g}, &r)
	return r.GetBoard()
}

// votesOf: the task's votes as "user:state:comment" in the approver order.
func votesOf(task *v1.Task) string {
	out := make([]string, len(task.GetApprovers()))
	for i, a := range task.GetApprovers() {
		out[i] = a.GetUserId() + ":" + a.GetState().String() + ":" + a.GetComment()
	}
	return strings.Join(out, ",")
}

// sameVotes fails unless got carries exactly the votes of want.
func sameVotes(t *testing.T, what string, got, want *v1.Task) {
	t.Helper()
	if votesOf(got) != votesOf(want) || got.GetApprovalState() != want.GetApprovalState() {
		t.Fatalf("%s changed the votes: %s (%v), want %s (%v)", what, votesOf(got), got.GetApprovalState(), votesOf(want), want.GetApprovalState())
	}
}

// TestApprovalGateSetting: the board setting is HOLD by default (GET / PATCH, MANAGE_BOARD,
// UNSPECIFIED 422). With OFF whoever may edit the task — a member without MANAGE_BOARD, a bot on
// its own, a bot on behalf of its owner, a bot for a consenting member — moves a task forward and
// into COMPLETED while votes are pending or rejected, without override_approval: 200, the votes
// exactly as before, no approval notices, no "approval_override". The other paths (create into
// COMPLETED, status delete with move_to, a status turned COMPLETED, a rule set_status, a move to
// another board by the target's setting) follow it. With HOLD the same moves are 409 as before.
// A PUT of the same approvers keeps the votes.
func TestApprovalGateSetting(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carl := register(t, invite(t, o, wid)) // MANAGE_BOTS and EDIT_TASKS: owns a bot, edits tasks, no MANAGE_BOARD
	if st, _ := setMemberRoles(o, wid, carl.id, newRole(t, o, wid, "bots", perm.ManageBots|perm.EditTasks).GetId()); st != 200 {
		t.Fatalf("assign MANAGE_BOTS: %d", st)
	}
	kl := register(t, invite(t, o, wid))
	fr := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Invoices", Key: "INX", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	if g := b.GetApprovalGate(); g != v1.ApprovalGate_APPROVAL_GATE_HOLD {
		t.Fatalf("default gate %v", g)
	}
	setNotifyDelay(t, o, b.GetId(), 0, 200) // approval notices would come at once
	todo := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	doing, review := statusNamed(b, "В работе"), statusNamed(b, "Ревью")
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	task := createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "Счёт", StatusId: todo, ApproverIds: []string{kl.id, fr.id}}, 201)
	id := task.GetId()

	bt := createBot(t, o, wid, "skrepka")
	giveBot(t, o, wid, bt, "Boards", perm.EditTasks) // the bot on its own edits tasks of the board
	if st, _ := setActsAsOwner(o, wid, bt.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}
	ob := asOwner(bt)
	cb := createBot(t, carl, wid, "carlbot")
	o.must(200, "PUT", "/api/workspaces/"+wid+"/bots/"+cb.id+"/delegations/"+o.id, nil, nil)
	mo := asMember(cb, o.id)

	// HOLD (the default): the member and the bot are refused as before (ADR-0049 §2).
	patchTask(t, carl, id, &v1.UpdateTaskRequest{StatusId: &doing}, 409)
	gateRefused(t, carl.client, 0, 2)
	patchTask(t, bt, id, &v1.UpdateTaskRequest{StatusId: &done}, 409)
	gateRefused(t, bt.client, 0, 2)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x", StatusId: done, ApproverIds: []string{kl.id}}, 409)

	// The setting: MANAGE_BOARD only, HOLD | OFF, returned by GET.
	setApprovalGate(t, carl, b.GetId(), v1.ApprovalGate_APPROVAL_GATE_OFF, 403)
	setApprovalGate(t, o, b.GetId(), v1.ApprovalGate_APPROVAL_GATE_UNSPECIFIED, 422)
	if g := setApprovalGate(t, o, b.GetId(), v1.ApprovalGate_APPROVAL_GATE_OFF, 200).GetApprovalGate(); g != v1.ApprovalGate_APPROVAL_GATE_OFF {
		t.Fatalf("PATCH answer gate %v", g)
	}
	var gb v1.BoardResponse
	o.must(200, "GET", "/api/boards/"+b.GetId(), nil, &gb)
	if g := gb.GetBoard().GetApprovalGate(); g != v1.ApprovalGate_APPROVAL_GATE_OFF {
		t.Fatalf("GET gate %v", g)
	}

	approvalNotice := func(e *v1.DispatchEvent) bool {
		switch e.GetTaskUpdate().GetNotice().GetKind() {
		case v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED, v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVED, v1.TaskNoticeKind_TASK_NOTICE_KIND_REJECTED:
			return e.GetTaskUpdate().GetTask().GetId() == id
		}
		return false
	}
	// The approvers listen from now on: the notices of the creation / the votes are behind them.
	listen := func() (*gw, *gw) {
		gk, gf := dialGW(t), dialGW(t)
		gk.identify(kl.token)
		gf.identify(fr.token)
		return gk, gf
	}
	move := func(who musty, what, to string) {
		t.Helper()
		var r v1.TaskResponse
		who.must(200, "PATCH", "/api/tasks/"+id, &v1.UpdateTaskRequest{StatusId: &to}, &r)
		if r.GetTask().GetStatusId() != to {
			t.Fatalf("%s: status %s, want %s", what, r.GetTask().GetStatusId(), to)
		}
		sameVotes(t, what, r.GetTask(), task)
	}

	// OFF, both votes pending.
	gk, gf := listen()
	move(carl, "a member without MANAGE_BOARD", doing)
	move(bt, "a bot on its own", review)
	move(ob, "a bot on behalf of its owner", done)
	move(mo, "a bot for a consenting member", todo)
	move(bob, "a member into COMPLETED", done)
	gk.quiet("approval notices after moves", 300*time.Millisecond, approvalNotice)
	gf.quiet("approval notices after moves", 300*time.Millisecond, approvalNotice)

	// OFF, one approved and one rejected: the same, back and forth.
	voteTask(kl, id, 200, approve, "")
	task = voteTask(fr, id, 200, reject, "нет закрывающих")
	gk, gf = listen()
	move(carl, "a member, vetoed", doing)
	move(bt, "a bot, vetoed", done)
	move(ob, "a bot on behalf, vetoed", review)
	// The same approvers again (another order too): a no-op, the votes stay.
	var r v1.TaskResponse
	carl.must(200, "PUT", "/api/tasks/"+id+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{fr.id, kl.id}}, &r)
	sameVotes(t, "the same approvers", r.GetTask(), task)
	gk.quiet("approval notices after moves of a vetoed task", 300*time.Millisecond, approvalNotice)
	gf.quiet("approval notices after moves of a vetoed task", 300*time.Millisecond, approvalNotice)
	if n := len(entriesOf(t, o, id, "approval_override")); n != 0 {
		t.Fatalf("approval_override entries: %d", n)
	}
	if n := len(entriesOf(t, o, id, "status")); n == 0 {
		t.Fatal("no status entries in the journal")
	}

	// The other paths with OFF: create into COMPLETED, a rule moving a pending task, a status
	// delete moving it forward, a status turned COMPLETED by the editor.
	if c := createTask(t, carl, b.GetId(), &v1.CreateTaskRequest{Title: "сразу", StatusId: done, ApproverIds: []string{kl.id}}, 201); c.GetStatusId() != done {
		t.Fatalf("created in COMPLETED %v", c)
	}
	rl := createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "Срочное — закрыть", Trigger: onPriority(), Actions: []*v1.RuleAction{doStatus(done)}}, 201)
	ruled := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "правило", StatusId: todo, ApproverIds: []string{kl.id}}, 201)
	patchTask(t, o, ruled.GetId(), &v1.UpdateTaskRequest{Priority: new(v1.TaskPriority_TASK_PRIORITY_URGENT)}, 200)
	if g := getTask(t, o, ruled.GetId()).GetTask(); g.GetStatusId() != done {
		t.Fatalf("rule set_status with the gate off: %v", g)
	} else {
		sameVotes(t, "a rule move", g, ruled)
	}
	o.must(204, "DELETE", "/api/rules/"+rl.GetId(), nil, nil)
	waiting := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "на ревью", StatusId: review, ApproverIds: []string{kl.id}}, 201)
	o.must(200, "DELETE", "/api/boards/"+b.GetId()+"/statuses/"+review+"?move_to="+done, nil, nil)
	afterDelete := getTask(t, o, waiting.GetId()).GetTask()
	if afterDelete.GetStatusId() != done {
		t.Fatalf("after the status delete %v", afterDelete)
	}
	sameVotes(t, "a status delete", afterDelete, waiting)
	var sr v1.BoardResponse
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/statuses", &v1.CreateBoardStatusRequest{Name: "Проверка"}, &sr)
	check := statusNamed(sr.GetBoard(), "Проверка")
	createTask(t, carl, b.GetId(), &v1.CreateTaskRequest{Title: "в проверке", StatusId: check, ApproverIds: []string{kl.id}}, 201)
	completed := v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED
	carl.must(200, "PATCH", "/api/boards/"+b.GetId()+"/statuses/"+check, &v1.UpdateBoardStatusRequest{Type: &completed}, nil)

	// Moving to another board (the target's setting decides; statuses map by type): the votes go along.
	off := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Off", Key: "OFB"}, 201)
	setApprovalGate(t, o, off.GetId(), v1.ApprovalGate_APPROVAL_GATE_OFF, 200)
	offID := off.GetId()
	patchTask(t, o, id, &v1.UpdateTaskRequest{StatusId: &done}, 200)
	moved := patchTask(t, o, id, &v1.UpdateTaskRequest{BoardId: &offID}, 200)
	if moved.GetBoardId() != offID || moved.GetStatusId() != statusOf(off, completed) {
		t.Fatalf("moved %v", moved)
	}
	sameVotes(t, "a move to an OFF board", moved, task)

	// Back to HOLD: the gate holds again.
	setApprovalGate(t, o, b.GetId(), v1.ApprovalGate_APPROVAL_GATE_HOLD, 200)
	pending := createTask(t, carl, b.GetId(), &v1.CreateTaskRequest{Title: "снова", StatusId: todo, ApproverIds: []string{kl.id}}, 201)
	patchTask(t, carl, pending.GetId(), &v1.UpdateTaskRequest{StatusId: &doing}, 409)
	patchTask(t, bt, pending.GetId(), &v1.UpdateTaskRequest{StatusId: &doing}, 409)
}
