package gateway

import (
	"slices"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// kinds names the events of one delivery, in order.
func kinds(evs []*v1.DispatchEvent) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		switch x := e.GetEvent().(type) {
		case *v1.DispatchEvent_BoardCreate:
			out[i] = "BoardCreate"
			if x.BoardCreate.GetBoard().GetTaskScoped() {
				out[i] += "(scoped)"
			}
		case *v1.DispatchEvent_BoardDelete:
			out[i] = "BoardDelete"
		case *v1.DispatchEvent_TaskCreate:
			out[i] = "TaskCreate"
		case *v1.DispatchEvent_TaskUpdate:
			out[i] = "TaskUpdate"
		case *v1.DispatchEvent_TaskDelete:
			out[i] = "TaskDelete"
		default:
			out[i] = "?"
		}
	}
	return out
}

func same(a, b []string) bool { return slices.Equal(a, b) }

// ADR-0059 §3: task events become per-recipient transitions for the task's invitees.
func TestTaskScopedTransitions(t *testing.T) {
	wid, bid := uuid.New(), uuid.New()
	alice, carol, dave, guest := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember]},
		"guest":  {ID: "guest", Position: perm.PosGuest, Permissions: perm.RoleDefaults[perm.RoleGuest]},
	}}
	for _, u := range []uuid.UUID{alice, carol, dave} {
		st.setMember(u, perm.RoleMember, []string{"member"})
	}
	st.setMember(guest, perm.RoleGuest, []string{"guest"})
	// A private board: only alice sees it (a personal allow).
	board := &v1.Board{Id: bid.String(), WorkspaceId: wid.String(), IsPrivate: true, OpenTasks: 7,
		PermissionOverrides: []*v1.RoomPermissionOverride{{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER,
			TargetId: alice.String(), Allow: uint64(perm.ViewBoard | perm.CreateTasks)}}}
	st.setBoard(bid, board)
	sessions := []*Session{{user: alice}, {user: carol}, {user: dave}, {user: guest}}

	t1, t2 := uuid.New(), uuid.New()
	room1 := uuid.New()
	task := func(id uuid.UUID, assignees []uuid.UUID, approvers []uuid.UUID, archived bool) *v1.Task {
		x := &v1.Task{Id: id.String(), BoardId: bid.String(), RoomId: uuid.NewSHA1(id, nil).String()}
		if id == t1 {
			x.RoomId = room1.String()
		}
		for _, u := range assignees {
			x.Assignees = append(x.Assignees, &v1.TaskAssignee{UserId: u.String()})
		}
		for _, u := range approvers {
			x.Approvers = append(x.Approvers, &v1.TaskApprover{UserId: u.String()})
		}
		if archived {
			x.ArchivedAt = timestamppb.Now()
		}
		return x
	}
	update := func(x *v1.Task) map[uuid.UUID][]string {
		ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskUpdate{TaskUpdate: &v1.TaskUpdate{Task: x}}}
		out := map[uuid.UUID][]string{}
		for _, d := range taskDeliveries(st, wid, sessions, ev, parseID(x.GetId()), bid, st.invitesOf(x), func() { st.setTask(x) }) {
			out[d.s.user] = kinds(d.events)
		}
		return out
	}
	del := func(id uuid.UUID) map[uuid.UUID][]string {
		ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskDelete{TaskDelete: &v1.TaskDelete{BoardId: bid.String(), TaskId: id.String()}}}
		out := map[uuid.UUID][]string{}
		for _, d := range taskDeliveries(st, wid, sessions, ev, id, bid, nil, func() {}) {
			out[d.s.user] = kinds(d.events)
		}
		return out
	}

	for _, c := range []struct {
		name  string
		run   func() map[uuid.UUID][]string
		carol []string
		dave  []string
	}{
		{"assigned: the board appears, then the task", func() map[uuid.UUID][]string { return update(task(t1, []uuid.UUID{carol}, nil, false)) },
			[]string{"BoardCreate(scoped)", "TaskCreate"}, nil},
		{"still assigned: the update as is", func() map[uuid.UUID][]string { return update(task(t1, []uuid.UUID{carol}, nil, false)) },
			[]string{"TaskUpdate"}, nil},
		{"a second task as approver: no second BOARD_CREATE", func() map[uuid.UUID][]string { return update(task(t2, nil, []uuid.UUID{carol}, false)) },
			[]string{"TaskCreate"}, nil},
		{"removed from one task: only that task goes", func() map[uuid.UUID][]string { return update(task(t1, []uuid.UUID{dave}, nil, false)) },
			[]string{"TaskDelete"}, []string{"BoardCreate(scoped)", "TaskCreate"}},
		{"last card archived: the task, then the board go", func() map[uuid.UUID][]string { return del(t2) },
			[]string{"TaskDelete", "BoardDelete"}, nil},
		{"guests are never task-scoped", func() map[uuid.UUID][]string { return update(task(t2, []uuid.UUID{guest}, nil, false)) },
			nil, nil},
		{"a watcher (ADR-0076): the board appears, then the task", func() map[uuid.UUID][]string {
			x := task(t2, nil, nil, false)
			x.WatcherIds = []string{carol.String(), guest.String()}
			return update(x)
		}, []string{"BoardCreate(scoped)", "TaskCreate"}, nil},
		{"no longer a watcher: the task, then the board go", func() map[uuid.UUID][]string { return update(task(t2, nil, nil, false)) },
			[]string{"TaskDelete", "BoardDelete"}, nil},
	} {
		got := c.run()
		if !same(got[carol], c.carol) || !same(got[dave], c.dave) || got[guest] != nil {
			t.Fatalf("%s: carol %v, dave %v, guest %v", c.name, got[carol], got[dave], got[guest])
		}
		if got[alice] == nil {
			t.Fatalf("%s: the board's viewer must get the event", c.name)
		}
	}

	// dave (assignee of t1) sees the task room like a member; carol no longer.
	if b := st.taskRoomBits(room1, dave); b != perm.ViewRoom|perm.SendMessages|perm.AttachFiles {
		t.Fatalf("task room of an invited assignee: %d", b)
	}
	if st.taskRoomBits(room1, carol) != 0 {
		t.Fatal("task room of a removed assignee")
	}
	if st.taskBits(bid, t1, dave) != perm.ViewBoard|perm.CreateTasks || st.taskBits(bid, t2, dave) != 0 {
		t.Fatal("dave sees t1 only")
	}

	// The board in dave's form: no bits, no overrides, no board-wide count.
	v := st.boardView(bid, dave)
	if !v.scoped {
		t.Fatal("dave is task-scoped")
	}
	pb := forRecipient(&v1.DispatchEvent{Event: &v1.DispatchEvent_BoardUpdate{BoardUpdate: &v1.BoardUpdate{Board: board}}}, v).GetBoardUpdate().GetBoard()
	if !pb.GetTaskScoped() || pb.GetPermissions() != 0 || len(pb.GetPermissionOverrides()) != 0 || pb.GetOpenTasks() != 0 || len(board.GetPermissionOverrides()) != 1 {
		t.Fatalf("scoped form: %v", pb)
	}

	// The board closed (restricted): ADR-0076 — dave keeps it through his card (no transition,
	// the update as is), and the task room stays his.
	closed := &v1.Board{Id: bid.String(), IsPrivate: true, Restricted: true, PermissionOverrides: board.GetPermissionOverrides()}
	before := st.boardView(bid, dave)
	st.setBoard(bid, closed)
	if got := kinds(boardTransition(before, st.boardView(bid, dave), closed, wid, nil)); len(got) != 0 {
		t.Fatalf("restricted: dave gets %v", got)
	}
	if !st.boardView(bid, dave).scoped || st.taskRoomBits(room1, dave) == 0 {
		t.Fatal("restricted: dave keeps the board and the task room through the card")
	}
	// Opened again: nothing changes for dave.
	before = st.boardView(bid, dave)
	st.setBoard(bid, board)
	if !before.scoped || !st.boardView(bid, dave).scoped {
		t.Fatal("unrestricted: dave still task-scoped")
	}
	// dave becomes a guest: the board goes.
	before = st.boardView(bid, dave)
	st.setMember(dave, perm.RoleGuest, []string{"guest"})
	if got := kinds(boardTransition(before, st.boardView(bid, dave), board, wid, nil)); !same(got, []string{"BoardDelete"}) {
		t.Fatalf("guest: dave gets %v", got)
	}
	// Full access while invited, then VIEW_BOARD removed: delete + create in the scoped form.
	st.setMember(dave, perm.RoleMember, []string{"member"})
	full := boardView{bits: perm.ViewBoard}
	if got := kinds(boardTransition(full, st.boardView(bid, dave), board, wid, nil)); !same(got, []string{"BoardDelete", "BoardCreate(scoped)"}) {
		t.Fatalf("full → scoped: %v", got)
	}
	// A purged board drops its invitations; an archived one keeps them.
	st.delBoard(bid, false)
	if st.scoped[dave][bid] != 1 {
		t.Fatal("archived board keeps invitations")
	}
	st.delBoard(bid, true)
	if len(st.invited) != 0 || len(st.scoped) != 0 {
		t.Fatalf("purged board: %v %v", st.invited, st.scoped)
	}
	// Bots are never invited.
	bot := uuid.New()
	st.setBot(bot, true)
	if inv := st.invitesOf(task(t1, []uuid.UUID{bot}, nil, false)); len(inv) != 0 {
		t.Fatal("bot invited")
	}
	if inv := st.invitesOf(task(t1, []uuid.UUID{carol}, nil, true)); len(inv) != 0 {
		t.Fatal("archived task invites nobody")
	}
}

// TestTaskOfActivityEvent: a removed journal entry (ADR-0081, no activity) is routed by the
// event's own task and board, else nobody would get it.
func TestTaskOfActivityEvent(t *testing.T) {
	task, board := uuid.New(), uuid.New()
	ev := func(a *v1.TaskActivityAppend) *v1.DispatchEvent {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: a}}
	}
	for name, e := range map[string]*v1.DispatchEvent{
		"removed": ev(&v1.TaskActivityAppend{TaskId: task.String(), BoardId: board.String(), ReplacedId: uuid.NewString()}),
		"old":     ev(&v1.TaskActivityAppend{Activity: &v1.TaskActivity{TaskId: task.String(), BoardId: board.String()}}),
	} {
		if gt, gb := taskOfEvent(e); gt != task || gb != board {
			t.Errorf("%s: %v %v", name, gt, gb)
		}
	}
}
