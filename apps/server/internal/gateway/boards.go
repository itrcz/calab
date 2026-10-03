package gateway

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Task boards in the workspace state (ADR-0042 §4): the live boards with their overrides and
// the comment room of every task, so board and task events and the messages of task rooms are
// filtered per recipient without DB queries, like rooms. Task-scoped access (ADR-0059): the
// humans invited (assignees, approvers) on the live tasks and, per user, on how many live tasks
// of each board they are invited — a member without VIEW_BOARD sees a non-restricted board
// while that count is > 0, and of it only those tasks.

type taskRoom struct {
	board    uuid.UUID
	task     uuid.UUID
	archived bool
}

// invite is how a user is on a task (ADR-0059): an assignee, an approver or both.
type invite uint8

const (
	invAssignee invite = 1 << iota
	invApprover
)

// boardState is the boards part of wsState (mu of the workspace held).
type boardState struct {
	boards    map[uuid.UUID]*v1.Board
	btargets  map[uuid.UUID][]perm.OverrideTarget
	taskRooms map[uuid.UUID]taskRoom  // room → task
	roomOf    map[uuid.UUID]uuid.UUID // task → room
	// ADR-0059: who is invited on each live task of a live board (task → user → how), the
	// board of each such task and, per user, the number of invited tasks per board.
	invited   map[uuid.UUID]map[uuid.UUID]invite
	taskBoard map[uuid.UUID]uuid.UUID
	scoped    map[uuid.UUID]map[uuid.UUID]int
	bots      map[uuid.UUID]bool // bot members: never task-scoped
}

func (b *boardState) init() {
	if b.boards == nil {
		b.boards = map[uuid.UUID]*v1.Board{}
		b.btargets = map[uuid.UUID][]perm.OverrideTarget{}
		b.taskRooms = map[uuid.UUID]taskRoom{}
		b.roomOf = map[uuid.UUID]uuid.UUID{}
	}
	if b.invited == nil {
		b.invited = map[uuid.UUID]map[uuid.UUID]invite{}
		b.taskBoard = map[uuid.UUID]uuid.UUID{}
		b.scoped = map[uuid.UUID]map[uuid.UUID]int{}
	}
	if b.bots == nil {
		b.bots = map[uuid.UUID]bool{}
	}
}

func (b *boardState) setBoard(id uuid.UUID, pb *v1.Board) {
	b.init()
	b.boards[id] = pb
	b.btargets[id] = pbconv.ProtoOverrideTargets(pb.GetPermissionOverrides())
}

// delBoard forgets a deleted board. Invitations stay while it is only archived (purged false):
// a restored board is task-scoped again for its invitees without a reload.
func (b *boardState) delBoard(id uuid.UUID, purged bool) {
	delete(b.boards, id)
	delete(b.btargets, id)
	for rid, tr := range b.taskRooms {
		if tr.board == id {
			delete(b.taskRooms, rid)
			delete(b.roomOf, tr.task)
		}
	}
	for tid, bid := range b.taskBoard {
		if purged && bid == id {
			b.setInvites(tid, uuid.Nil, nil)
		}
	}
}

func (b *boardState) setTask(t *v1.Task) {
	b.init()
	rid, tid := parseID(t.GetRoomId()), parseID(t.GetId())
	if rid == uuid.Nil {
		return
	}
	b.taskRooms[rid] = taskRoom{board: parseID(t.GetBoardId()), task: tid, archived: t.GetArchivedAt() != nil}
	b.roomOf[tid] = rid
}

// setBot records whether a member is a bot (bots are never task-scoped).
func (b *boardState) setBot(u uuid.UUID, bot bool) {
	b.init()
	if bot {
		b.bots[u] = true
	} else {
		delete(b.bots, u)
	}
}

// invitesOf is who is invited on a task as an event carries it: nobody on an archived task;
// bots never count.
func (b *boardState) invitesOf(t *v1.Task) map[uuid.UUID]invite {
	if t.GetArchivedAt() != nil {
		return nil
	}
	var out map[uuid.UUID]invite
	add := func(raw string, how invite) {
		u := parseID(raw)
		if u == uuid.Nil || b.bots[u] {
			return
		}
		if out == nil {
			out = map[uuid.UUID]invite{}
		}
		out[u] |= how
	}
	for _, a := range t.GetAssignees() {
		add(a.GetUserId(), invAssignee)
	}
	for _, a := range t.GetApprovers() {
		add(a.GetUserId(), invApprover)
	}
	return out
}

// setInvites replaces the invitations of task tid, now on board bid (next nil or bid Nil = the
// task is gone or archived), keeping the scoped counters.
func (b *boardState) setInvites(tid, bid uuid.UUID, next map[uuid.UUID]invite) {
	b.init()
	if old, ok := b.invited[tid]; ok {
		ob := b.taskBoard[tid]
		for u := range old {
			if c := b.scoped[u]; c != nil {
				if c[ob]--; c[ob] <= 0 {
					delete(c, ob)
				}
				if len(c) == 0 {
					delete(b.scoped, u)
				}
			}
		}
		delete(b.invited, tid)
		delete(b.taskBoard, tid)
	}
	if len(next) == 0 || bid == uuid.Nil {
		return
	}
	b.invited[tid], b.taskBoard[tid] = next, bid
	for u := range next {
		if b.scoped[u] == nil {
			b.scoped[u] = map[uuid.UUID]int{}
		}
		b.scoped[u][bid]++
	}
}

func loadBoards(ctx context.Context, q *sqlc.Queries, wid uuid.UUID, st *wsState) error {
	bs, err := boards.All(ctx, q, wid)
	if err != nil {
		return err
	}
	for _, b := range bs {
		st.setBoard(parseID(b.GetId()), b)
	}
	trs, err := q.ListWorkspaceTaskRooms(ctx, wid)
	if err != nil {
		return err
	}
	st.init()
	for _, t := range trs {
		st.taskRooms[t.RoomID] = taskRoom{board: t.BoardID, task: t.ID, archived: t.Archived}
		st.roomOf[t.ID] = t.RoomID
	}
	invs, err := q.ListWorkspaceTaskInvitees(ctx, wid)
	if err != nil {
		return err
	}
	byTask := map[uuid.UUID]map[uuid.UUID]invite{}
	boardOf := map[uuid.UUID]uuid.UUID{}
	for _, x := range invs {
		if byTask[x.TaskID] == nil {
			byTask[x.TaskID] = map[uuid.UUID]invite{}
		}
		if x.Assignee {
			byTask[x.TaskID][x.UserID] |= invAssignee
		}
		if x.Approver {
			byTask[x.TaskID][x.UserID] |= invApprover
		}
		boardOf[x.TaskID] = x.BoardID
	}
	for tid, m := range byTask {
		st.setInvites(tid, boardOf[tid], m)
	}
	return nil
}

// boardBits: a member's bits on a live board (mu held).
func (s *wsState) boardBits(boardID, userID uuid.UUID) perm.Bits {
	m, ok := s.members[userID]
	b := s.boards[boardID]
	if !ok || b == nil {
		return 0
	}
	return perm.ComputeBoardIn(m, b.GetIsPrivate(), b.GetRestricted(), s.btargets[boardID])
}

// boardView is how a member sees a live board: their bits, or task-scoped (ADR-0059).
type boardView struct {
	bits   perm.Bits
	scoped bool
}

func (v boardView) visible() bool { return v.bits.Has(perm.ViewBoard) || v.scoped }

func (v boardView) access() perm.BoardAccess {
	return perm.BoardAccess{Bits: v.bits, TaskScoped: v.scoped}
}

// boardView: a member's view of a live board (mu held) — boardVisible of ADR-0059 §3:
// VIEW_BOARD, or invited on a live task of a board that is not restricted and not a guest
// (bots are never invited).
func (s *wsState) boardView(boardID, userID uuid.UUID) boardView {
	bits := s.boardBits(boardID, userID)
	if bits.Has(perm.ViewBoard) {
		return boardView{bits: bits}
	}
	b := s.boards[boardID]
	m, ok := s.members[userID]
	if b == nil || !ok || b.GetRestricted() || m.Role == perm.RoleGuest || s.scoped[userID][boardID] == 0 {
		return boardView{}
	}
	return boardView{scoped: true}
}

// taskBits: a member's bits on a task of a live board (perm.TaskBits; mu held).
func (s *wsState) taskBits(boardID, taskID, userID uuid.UUID) perm.Bits {
	v := s.boardView(boardID, userID)
	var inv invite
	if v.scoped && s.taskBoard[taskID] == boardID {
		inv = s.invited[taskID][userID]
	}
	return perm.TaskBits(v.access(), inv&invAssignee != 0, inv&invApprover != 0)
}

// taskRoomBits: a member's bits in a task's comment room (0 = not a task room of a live board);
// read-only with the board's COMMENTS feature off (ADR-0058 §3). The bits follow the task
// (ADR-0059: an invited member of a task-scoped board too).
func (s *wsState) taskRoomBits(roomID, userID uuid.UUID) perm.Bits {
	tr, ok := s.taskRooms[roomID]
	if !ok {
		return 0
	}
	return perm.TaskRoom(s.taskBits(tr.board, tr.task, userID), tr.archived, boards.CommentsOff(s.boards[tr.board]))
}

// forRecipient is a board event as one recipient gets it: with their bits, or in the
// task-scoped form (ADR-0059).
func forRecipient(ev *v1.DispatchEvent, v boardView) *v1.DispatchEvent {
	form := func(b *v1.Board) *v1.Board {
		b = proto.CloneOf(b)
		if v.scoped {
			return boards.ScopedForm(b)
		}
		b.Permissions = uint64(v.bits)
		return b
	}
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_BoardCreate:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCreate{BoardCreate: &v1.BoardCreate{Board: form(e.BoardCreate.GetBoard())}}}
	case *v1.DispatchEvent_BoardUpdate:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardUpdate{BoardUpdate: &v1.BoardUpdate{Board: form(e.BoardUpdate.GetBoard())}}}
	}
	return ev
}

func boardCreate(board *v1.Board, v boardView) *v1.DispatchEvent {
	return forRecipient(&v1.DispatchEvent{Event: &v1.DispatchEvent_BoardCreate{BoardCreate: &v1.BoardCreate{Board: board}}}, v)
}

func boardDelete(wid uuid.UUID, boardID string) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardDelete{BoardDelete: &v1.BoardDelete{WorkspaceId: wid.String(), BoardId: boardID}}}
}

// boardTransition turns a board change for one recipient into what they should see: the change
// in their form, BOARD_CREATE when they gain the board, BOARD_DELETE when they lose it.
// Switching between full and task-scoped access is BOARD_DELETE + BOARD_CREATE: the client
// drops the tasks it holds and loads what it sees now (ADR-0059).
func boardTransition(before, after boardView, board *v1.Board, wid uuid.UUID, changed *v1.DispatchEvent) []*v1.DispatchEvent {
	was, is := before.visible(), after.visible()
	switch {
	case was && is && before.scoped != after.scoped:
		return []*v1.DispatchEvent{boardDelete(wid, board.GetId()), boardCreate(board, after)}
	case was && is && changed != nil:
		return []*v1.DispatchEvent{forRecipient(changed, after)}
	case !was && is:
		return []*v1.DispatchEvent{boardCreate(board, after)}
	case was && !is:
		return []*v1.DispatchEvent{boardDelete(wid, board.GetId())}
	}
	return nil
}

// taskOfEvent names the task and board of a task journal / checklist event.
func taskOfEvent(ev *v1.DispatchEvent) (task, board uuid.UUID) {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_TaskActivity:
		a := e.TaskActivity.GetActivity()
		return parseID(a.GetTaskId()), parseID(a.GetBoardId())
	case *v1.DispatchEvent_TaskChecklistUpdate:
		return parseID(e.TaskChecklistUpdate.GetTaskId()), parseID(e.TaskChecklistUpdate.GetBoardId())
	case *v1.DispatchEvent_TaskChecklistDelete:
		return parseID(e.TaskChecklistDelete.GetTaskId()), parseID(e.TaskChecklistDelete.GetBoardId())
	case *v1.DispatchEvent_TaskGitLinksUpdate:
		return parseID(e.TaskGitLinksUpdate.GetTaskId()), parseID(e.TaskGitLinksUpdate.GetBoardId())
	}
	return uuid.Nil, uuid.Nil
}

// eventID is the id of the i-th event one recipient gets for an incoming event: the incoming
// id first, fresh ids for the extra ones.
func eventID(id uuid.UUID, i int) uuid.UUID {
	if i == 0 {
		return id
	}
	return uuid.New()
}

// routeBoards delivers board and task events (st.mu held); false = not a board event.
func (h *Hub) routeBoards(st *wsState, wid, id uuid.UUID, sessions []*Session, ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_BoardCreate, *v1.DispatchEvent_BoardUpdate:
		b := ev.GetBoardCreate().GetBoard()
		if b == nil {
			b = ev.GetBoardUpdate().GetBoard()
		}
		bid := parseID(b.GetId())
		before := make(map[*Session]boardView, len(sessions))
		for _, s := range sessions {
			before[s] = st.boardView(bid, s.user)
		}
		st.setBoard(bid, b)
		for _, s := range sessions {
			after := st.boardView(bid, s.user)
			changed := ev
			if before[s].visible() && !after.visible() {
				changed = nil
			}
			for i, out := range boardTransition(before[s], after, b, wid, changed) {
				s.dispatchScoped(wid, eventID(id, i), out)
			}
		}
	case *v1.DispatchEvent_BoardDelete:
		bid := parseID(e.BoardDelete.GetBoardId())
		shared := newScopedEnc(wid, ev)
		for _, s := range sessions {
			if st.boardView(bid, s.user).visible() {
				s.dispatchEnc(id, shared)
			}
		}
		st.delBoard(bid, e.BoardDelete.GetPurged())
	case *v1.DispatchEvent_TaskCreate:
		t := e.TaskCreate.GetTask()
		routeTask(st, wid, id, sessions, ev, parseID(t.GetId()), parseID(t.GetBoardId()), st.invitesOf(t), func() { st.setTask(t) })
	case *v1.DispatchEvent_TaskUpdate:
		t := e.TaskUpdate.GetTask()
		routeTask(st, wid, id, sessions, ev, parseID(t.GetId()), parseID(t.GetBoardId()), st.invitesOf(t), func() { st.setTask(t) })
	case *v1.DispatchEvent_TaskDelete:
		tid, bid := parseID(e.TaskDelete.GetTaskId()), parseID(e.TaskDelete.GetBoardId())
		routeTask(st, wid, id, sessions, ev, tid, bid, nil, func() {
			if rid, ok := st.roomOf[tid]; ok {
				tr := st.taskRooms[rid]
				if e.TaskDelete.GetPurged() {
					delete(st.taskRooms, rid)
					delete(st.roomOf, tid)
				} else if tr.board == bid {
					tr.archived = true
					st.taskRooms[rid] = tr
				}
			}
		})
	case *v1.DispatchEvent_TaskActivity, *v1.DispatchEvent_TaskChecklistUpdate, *v1.DispatchEvent_TaskChecklistDelete,
		*v1.DispatchEvent_TaskGitLinksUpdate:
		tid, bid := taskOfEvent(ev)
		shared := newScopedEnc(wid, ev)
		for _, s := range sessions {
			if st.taskBits(bid, tid, s.user) != 0 {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_BoardRuleUpdate, *v1.DispatchEvent_BoardRuleDelete:
		// Automation rules (ADR-0060): to the board's viewers (not to task-scoped members).
		bid := parseID(ev.GetBoardRuleUpdate().GetBoardId() + ev.GetBoardRuleDelete().GetBoardId())
		shared := newScopedEnc(wid, ev)
		for _, s := range sessions {
			if st.boardBits(bid, s.user).Has(perm.ViewBoard) {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_BoardCategoryCreate, *v1.DispatchEvent_BoardCategoryUpdate, *v1.DispatchEvent_BoardCategoryDelete:
		// Board categories (ADR-0058 §1): names only, to every member who may see boards (guests
		// never do); clients hide categories without visible boards.
		shared := newScopedEnc(wid, ev)
		for _, s := range sessions {
			if st.role(s.user) != perm.RoleGuest {
				s.dispatchEnc(id, shared)
			}
		}
	default:
		return false
	}
	return true
}

// routeTask delivers TASK_CREATE / TASK_UPDATE / TASK_DELETE of task tid on board bid (mu held).
// next: who is invited on the task after the event (nil = nobody: deleted or archived); apply
// updates the rest of the state. The board's viewers get the event as is; the task's invitees
// before or after (ADR-0059 §3) get their transition: gaining the task — BOARD_CREATE of a
// newly task-scoped board first, then TASK_CREATE; keeping it — the event; losing it —
// TASK_DELETE (not purged), then BOARD_DELETE when it was their last task of the board.
func routeTask(st *wsState, wid, id uuid.UUID, sessions []*Session, ev *v1.DispatchEvent, tid, bid uuid.UUID,
	next map[uuid.UUID]invite, apply func()) {
	shared := newScopedEnc(wid, ev)
	for _, d := range taskDeliveries(st, wid, sessions, ev, tid, bid, next, apply) {
		for i, e := range d.events {
			if e == ev {
				d.s.dispatchEnc(eventID(id, i), shared)
			} else {
				d.s.dispatchScoped(wid, eventID(id, i), e)
			}
		}
	}
}

// delivery is what one session gets for a task event, in order.
type delivery struct {
	s      *Session
	events []*v1.DispatchEvent
}

// taskDeliveries computes routeTask's deliveries (split out for the unit tests).
func taskDeliveries(st *wsState, wid uuid.UUID, sessions []*Session, ev *v1.DispatchEvent, tid, bid uuid.UUID,
	next map[uuid.UUID]invite, apply func()) []delivery {
	old := st.invited[tid]
	from := bid // the board the task was on (a move re-creates it on another board)
	if ob, ok := st.taskBoard[tid]; ok {
		from = ob
	}
	touched := func(u uuid.UUID) bool {
		_, a := old[u]
		_, b := next[u]
		return a || b
	}
	type seen struct {
		task       bool
		from, onto boardView
	}
	before := map[*Session]seen{}
	for _, s := range sessions {
		if touched(s.user) {
			before[s] = seen{task: st.taskBits(from, tid, s.user) != 0, from: st.boardView(from, s.user), onto: st.boardView(bid, s.user)}
		}
	}
	apply()
	st.setInvites(tid, bid, next)
	out := make([]delivery, 0, len(sessions))
	for _, s := range sessions {
		was, ok := before[s]
		if !ok {
			if st.boardBits(bid, s.user).Has(perm.ViewBoard) {
				out = append(out, delivery{s: s, events: []*v1.DispatchEvent{ev}})
			}
			continue
		}
		is := seen{task: st.taskBits(bid, tid, s.user) != 0, from: st.boardView(from, s.user), onto: st.boardView(bid, s.user)}
		var evs []*v1.DispatchEvent
		if b := st.boards[bid]; b != nil && !was.onto.visible() && is.onto.visible() {
			evs = append(evs, boardCreate(b, is.onto))
		}
		switch {
		case was.task && is.task:
			evs = append(evs, ev)
		case is.task:
			evs = append(evs, asTaskCreate(ev))
		case was.task:
			evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskDelete{TaskDelete: &v1.TaskDelete{
				WorkspaceId: wid.String(), BoardId: from.String(), TaskId: tid.String()}}})
		}
		if was.from.visible() && !is.from.visible() {
			evs = append(evs, boardDelete(wid, from.String()))
		}
		if from != bid && was.onto.visible() && !is.onto.visible() {
			evs = append(evs, boardDelete(wid, bid.String()))
		}
		if len(evs) > 0 {
			out = append(out, delivery{s: s, events: evs})
		}
	}
	return out
}

// asTaskCreate is a task event as TASK_CREATE (an invitee gains the task).
func asTaskCreate(ev *v1.DispatchEvent) *v1.DispatchEvent {
	if u := ev.GetTaskUpdate(); u != nil {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskCreate{TaskCreate: &v1.TaskCreate{Task: u.GetTask()}}}
	}
	return ev
}

// reviewBoards runs apply and then sends the sessions of users matching who BOARD_CREATE /
// BOARD_DELETE for boards they gained / lost with it (role and member changes; st.mu held).
func (h *Hub) reviewBoards(st *wsState, wid uuid.UUID, sessions []*Session, who func(uuid.UUID) bool, apply func()) {
	before := map[*Session]map[uuid.UUID]boardView{}
	for _, s := range sessions {
		if !who(s.user) || len(st.boards) == 0 {
			continue
		}
		v := make(map[uuid.UUID]boardView, len(st.boards))
		for bid := range st.boards {
			v[bid] = st.boardView(bid, s.user)
		}
		before[s] = v
	}
	apply()
	for s, was := range before {
		for bid, b := range st.boards {
			for _, out := range boardTransition(was[bid], st.boardView(bid, s.user), b, wid, nil) {
				s.dispatchScoped(wid, uuid.New(), out)
			}
		}
	}
}
