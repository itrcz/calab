package perm

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

type fakeStore struct {
	members     map[key]sqlc.GetMemberAccessRow
	access      map[key]sqlc.GetRoomAccessRow
	boards      map[key]sqlc.GetBoardAccessRow
	taskRooms   map[uuid.UUID]sqlc.GetTaskRoomRefRow
	invites     map[key][2]bool // (task, user) → assignee, approver
	memberCalls int
	accessCalls int
	err         error
}

func (f *fakeStore) GetMemberAccess(_ context.Context, a sqlc.GetMemberAccessParams) (sqlc.GetMemberAccessRow, error) {
	f.memberCalls++
	if f.err != nil {
		return sqlc.GetMemberAccessRow{}, f.err
	}
	row, ok := f.members[key{a.WorkspaceID, a.UserID}]
	if !ok {
		return sqlc.GetMemberAccessRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeStore) GetRoomAccess(_ context.Context, a sqlc.GetRoomAccessParams) (sqlc.GetRoomAccessRow, error) {
	f.accessCalls++
	row, ok := f.access[key{a.RoomID, a.UserID}]
	if !ok {
		return sqlc.GetRoomAccessRow{}, pgx.ErrNoRows
	}
	return row, nil
}

// GetRoomAccesses answers like the query: one row per user in order (a user without a stored
// row gets the empty row of a non-member), or none when no user has a row (no room).
func (f *fakeStore) GetRoomAccesses(_ context.Context, a sqlc.GetRoomAccessesParams) ([]sqlc.GetRoomAccessesRow, error) {
	f.accessCalls++
	if f.err != nil {
		return nil, f.err
	}
	rows, found := make([]sqlc.GetRoomAccessesRow, len(a.UserIds)), false
	for i, u := range a.UserIds {
		if row, ok := f.access[key{a.RoomID, u}]; ok {
			rows[i], found = sqlc.GetRoomAccessesRow(row), true
		}
	}
	if !found {
		return nil, nil
	}
	return rows, nil
}

func (f *fakeStore) GetBoardAccess(_ context.Context, a sqlc.GetBoardAccessParams) (sqlc.GetBoardAccessRow, error) {
	row, ok := f.boards[key{a.BoardID, a.UserID}]
	if !ok {
		return sqlc.GetBoardAccessRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeStore) GetTaskRoomRef(_ context.Context, a sqlc.GetTaskRoomRefParams) (sqlc.GetTaskRoomRefRow, error) {
	row, ok := f.taskRooms[a.RoomID]
	if !ok {
		return sqlc.GetTaskRoomRefRow{}, pgx.ErrNoRows
	}
	inv := f.invites[key{row.TaskID, a.UserID}]
	row.Assignee, row.Approver = inv[0], inv[1]
	return row, nil
}

// ADR-0042: a task room's bits come from its board; a private board hides it; archived tasks
// are read-only.
func TestResolverTaskRoom(t *testing.T) {
	ws, board, room, u, other, memberR := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	task := uuid.New()
	access := func(private bool, allowUser bool) sqlc.GetBoardAccessRow {
		row := sqlc.GetBoardAccessRow{WorkspaceID: ws, IsPrivate: private, Role: ptr("member"),
			RoleIds: []uuid.UUID{memberR}, RolePositions: []int32{PosMember},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember])}, RoleAllows: []int64{0}, RoleDenies: []int64{0}}
		if allowUser {
			row.UserAllow, row.UserDeny = ptr(int64(ViewBoard|EditTasks)), ptr(int64(0))
		}
		return row
	}
	s := &fakeStore{
		access:    map[key]sqlc.GetRoomAccessRow{{room, u}: {WorkspaceID: &ws, Type: "task", Role: ptr("member")}, {room, other}: {WorkspaceID: &ws, Type: "task", Role: ptr("member")}},
		boards:    map[key]sqlc.GetBoardAccessRow{{board, u}: access(true, true), {board, other}: access(true, false)},
		taskRooms: map[uuid.UUID]sqlc.GetTaskRoomRefRow{room: {TaskID: task, BoardID: board}},
	}
	r := NewResolver(s)
	ctx := context.Background()
	acc, err := r.Room(ctx, room, u)
	if err != nil || !acc.Task || acc.TaskID != task || acc.BoardID != board || acc.Bits != ViewRoom|SendMessages|AttachFiles|ManageMessages {
		t.Fatalf("allowed user: %+v %v", acc, err)
	}
	if acc, err := r.Room(ctx, room, other); err != nil || acc.Bits != 0 {
		t.Fatalf("private board, no allow: %+v %v", acc, err)
	}
	b, err := r.Board(ctx, board, other)
	if err != nil || b.Bits != 0 || !b.Private {
		t.Fatalf("board of other: %+v %v", b, err)
	}
	if _, err := r.Board(ctx, uuid.New(), u); !errors.Is(err, ErrNoBoard) {
		t.Fatalf("unknown board: %v", err)
	}
	s.taskRooms[room] = sqlc.GetTaskRoomRefRow{TaskID: task, BoardID: board, TaskArchived: true}
	r = NewResolver(s)
	if acc, _ := r.Room(ctx, room, u); acc.Bits != ViewRoom|ManageMessages {
		t.Fatalf("archived task room must be read-only: %d", acc.Bits)
	}
	// ADR-0058 §3: COMMENTS off on the board — the task room is read-only, moderation stays.
	s.taskRooms[room] = sqlc.GetTaskRoomRefRow{TaskID: task, BoardID: board}
	row := s.boards[key{board, u}]
	row.DisabledFeatures = 1 << 12
	s.boards[key{board, u}] = row
	r = NewResolver(s)
	if acc, _ := r.Room(ctx, room, u); acc.Bits != ViewRoom|ManageMessages {
		t.Fatalf("comments off: task room must be read-only: %d", acc.Bits)
	}
	// ADR-0059: a member without VIEW_BOARD invited on the task sees its room like a viewer
	// (no moderation); once the task is archived, the invitation no longer counts.
	s.boards[key{board, other}] = func() sqlc.GetBoardAccessRow {
		r := access(true, false)
		r.Invited = true
		return r
	}()
	s.invites = map[key][2]bool{{task, other}: {false, true}}
	r = NewResolver(s)
	if b, _ := r.Board(ctx, board, other); b.Bits != 0 || !b.TaskScoped {
		t.Fatalf("invited on a private board: %+v", b)
	}
	if acc, _ := r.Room(ctx, room, other); acc.Bits != ViewRoom|SendMessages|AttachFiles {
		t.Fatalf("approver of the task: %d", acc.Bits)
	}
	s.taskRooms[room] = sqlc.GetTaskRoomRefRow{TaskID: task, BoardID: board, TaskArchived: true}
	r = NewResolver(s)
	if acc, _ := r.Room(ctx, room, other); acc.Bits != 0 {
		t.Fatalf("archived task: the invitation must not count: %d", acc.Bits)
	}
	restricted := access(true, false)
	restricted.Invited, restricted.Restricted = true, true
	s.boards[key{board, other}] = restricted
	r = NewResolver(s)
	if b, _ := r.Board(ctx, board, other); b.TaskScoped {
		t.Fatalf("restricted board is never task-scoped: %+v", b)
	}
	if TaskRoom(ViewBoard, false, false) != ViewRoom|SendMessages|AttachFiles || TaskRoom(CreateTasks, false, false) != 0 ||
		TaskRoom(ViewBoard, false, true) != ViewRoom || !CommentsOff(1<<12) || CommentsOff(1<<9) {
		t.Fatal("TaskRoom")
	}
}

func ptr[T any](v T) *T { return &v }

func TestResolverRoomAndCache(t *testing.T) {
	ws, room, u := uuid.New(), uuid.New(), uuid.New()
	member, mod := uuid.New(), uuid.New()
	// member (deny STREAM here) and a custom role at position 2 (allow MOVE_MEMBERS here).
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{
		{room, u}: {
			WorkspaceID: &ws, Type: "voice", Role: ptr("member"),
			RoleIds: []uuid.UUID{member, mod}, RolePositions: []int32{1, 2},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember]), i64(MuteMembers)},
			RoleAllows:      []int64{0, int64(MoveMembers)}, RoleDenies: []int64{int64(Stream), 0},
		},
	}}
	r := NewResolver(s)
	ctx := context.Background()
	want := ComputeRoles([]RoleBits{
		{ID: "m", Position: 1, Permissions: RoleDefaults[RoleMember]}, {ID: "x", Position: 2, Permissions: MuteMembers},
	}, Scope{}, map[string]Override{"m": {Deny: Stream}, "x": {Allow: MoveMembers}}, nil)
	for range 3 {
		acc, err := r.Room(ctx, room, u)
		if err != nil {
			t.Fatal(err)
		}
		if acc.Bits != want || acc.WorkspaceID != ws || acc.Bits.Has(Stream) || !acc.Bits.Has(MoveMembers|MuteMembers) {
			t.Fatalf("got %+v, want bits %d", acc, want)
		}
	}
	if s.accessCalls != 1 {
		t.Fatalf("room access loaded %d times, want 1 (cached)", s.accessCalls)
	}
	// Room lookup also primes the workspace member cache.
	bits, role, err := r.Workspace(ctx, ws, u)
	if err != nil || role != RoleMember || s.memberCalls != 0 || bits != RoleDefaults[RoleMember]|MuteMembers {
		t.Fatalf("role=%q bits=%d err=%v memberCalls=%d", role, bits, err, s.memberCalls)
	}
	r.Invalidate()
	if _, err := r.Room(ctx, room, u); err != nil || s.accessCalls != 2 {
		t.Fatalf("after invalidate: err=%v calls=%d", err, s.accessCalls)
	}
}

func TestResolverMember(t *testing.T) {
	ws, u := uuid.New(), uuid.New()
	admin, member := uuid.New(), uuid.New()
	s := &fakeStore{members: map[key]sqlc.GetMemberAccessRow{
		{ws, u}: {Role: "admin", RoleIds: []uuid.UUID{member, admin}, RolePositions: []int32{PosMember, PosAdmin},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember]), i64(Administrator)}},
	}}
	r := NewResolver(s)
	m, err := r.Member(context.Background(), ws, u)
	if err != nil || m.Workspace() != All || m.Top() != PosAdmin || m.Role != RoleAdmin || !m.Has(admin.String()) {
		t.Fatalf("member %+v err %v", m, err)
	}
}

func TestResolverDM(t *testing.T) {
	room, a, b, c := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	row := sqlc.GetRoomAccessRow{Type: "dm", DmMembers: []uuid.UUID{a, b}}
	// A workspace role of the caller never applies to a DM (defence in depth: the query
	// cannot join one, since a DM has no workspace).
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{{room, a}: row, {room, c}: row}}
	r := NewResolver(s)
	ctx := context.Background()
	acc, err := r.Room(ctx, room, a)
	if err != nil || !acc.DM || acc.Bits != DM || acc.WorkspaceID != uuid.Nil || len(acc.Members) != 2 {
		t.Fatalf("participant: %+v %v", acc, err)
	}
	if acc.Bits.Has(ManageMessages) || acc.Bits.Has(MentionEveryone) || acc.Bits.Has(Connect) {
		t.Fatalf("DM bits include moderation / voice: %d", acc.Bits)
	}
	if _, err := r.Room(ctx, room, c); !errors.Is(err, ErrNoRoom) {
		t.Fatalf("third user: want ErrNoRoom, got %v", err)
	}
	if _, err := r.Room(ctx, room, c); !errors.Is(err, ErrNoRoom) || s.accessCalls != 2 {
		t.Fatalf("negative DM result not cached: %v, %d calls", err, s.accessCalls)
	}
}

func TestResolverNoAccess(t *testing.T) {
	s := &fakeStore{members: map[key]sqlc.GetMemberAccessRow{}, access: map[key]sqlc.GetRoomAccessRow{}}
	r := NewResolver(s)
	ctx := context.Background()
	if _, err := r.Room(ctx, uuid.New(), uuid.New()); !errors.Is(err, ErrNoRoom) {
		t.Fatalf("want ErrNoRoom, got %v", err)
	}
	ws, u := uuid.New(), uuid.New()
	if _, _, err := r.Workspace(ctx, ws, u); !errors.Is(err, ErrNotMember) {
		t.Fatalf("want ErrNotMember, got %v", err)
	}
	_, _, _ = r.Workspace(ctx, ws, u)
	if s.memberCalls != 1 {
		t.Fatalf("negative result not cached: %d calls", s.memberCalls)
	}
}

func TestResolverStoreError(t *testing.T) {
	boom := errors.New("boom")
	r := NewResolver(&fakeStore{err: boom})
	if _, err := r.Role(context.Background(), uuid.New(), uuid.New()); !errors.Is(err, boom) {
		t.Fatalf("want wrapped store error, got %v", err)
	}
}

func TestComputeInPrivateRoom(t *testing.T) {
	memberID, guestID := uuid.NewString(), uuid.NewString()
	roles := Roles{
		memberID: {ID: memberID, Position: PosMember, Permissions: RoleDefaults[RoleMember]},
		guestID:  {ID: guestID, Position: PosGuest, Permissions: RoleDefaults[RoleGuest]},
	}
	u := uuid.NewString()
	ovs := []OverrideTarget{
		{TargetType: "role", TargetID: memberID, Override: Override{Deny: ViewRoom}},
		{TargetType: "user", TargetID: u, Override: Override{Allow: ViewRoom}},
	}
	if ComputeIn(roles.Member(uuid.NewString(), RoleMember, []string{memberID}), false, ovs) != 0 {
		t.Fatal("private room visible to other members")
	}
	if !ComputeIn(roles.Member(u, RoleMember, []string{memberID}), false, ovs).Has(ViewRoom) {
		t.Fatal("private room hidden from allowed user")
	}
	if got := ComputeIn(roles.Member(u, RoleGuest, []string{guestID, "unknown"}), false, ovs); got != ViewRoom|Connect|Speak {
		t.Fatalf("guest with user allow: %d", got)
	}
}

func i64(b Bits) int64 { return int64(b) } //nolint:gosec // small bit masks in tests

// ADR-0029: in a restricted room an admin counts as a plain member, the owner has everything.
func TestResolverRestricted(t *testing.T) {
	ws, room := uuid.New(), uuid.New()
	adminU, ownerU := uuid.New(), uuid.New()
	adminR, ownerR, memberR := uuid.New(), uuid.New(), uuid.New()
	row := func(role string, top uuid.UUID, pos int32) sqlc.GetRoomAccessRow {
		return sqlc.GetRoomAccessRow{
			WorkspaceID: &ws, Type: "text", Role: ptr(role), Restricted: true,
			RoleIds: []uuid.UUID{memberR, top}, RolePositions: []int32{PosMember, pos},
			RolePermissions: []int64{i64(RoleDefaults[RoleMember]), i64(Administrator)},
			RoleAllows:      []int64{0, 0}, RoleDenies: []int64{int64(ViewRoom), 0},
		}
	}
	s := &fakeStore{access: map[key]sqlc.GetRoomAccessRow{
		{room, adminU}: row("admin", adminR, PosAdmin),
		{room, ownerU}: row("owner", ownerR, PosOwner),
	}}
	r := NewResolver(s)
	ctx := context.Background()
	if acc, err := r.Room(ctx, room, adminU); err != nil || acc.Bits != 0 || !acc.Restricted {
		t.Fatalf("admin: %+v %v", acc, err)
	}
	if acc, err := r.Room(ctx, room, ownerU); err != nil || acc.Bits != All {
		t.Fatalf("owner: %+v %v", acc, err)
	}
}

func TestPrimeRoomAnswersLikeReadRoom(t *testing.T) {
	ws, room := uuid.New(), uuid.New()
	member, outsider, archived := uuid.New(), uuid.New(), uuid.New()
	rows := map[key]sqlc.GetRoomAccessRow{
		{room, member}:   {WorkspaceID: &ws, Type: "voice", Role: ptr("member")},
		{room, archived}: {WorkspaceID: &ws, Type: "voice", Role: ptr("member"), Archived: true},
	}
	users := []uuid.UUID{member, outsider, archived}
	single := NewResolver(&fakeStore{access: rows})
	primedStore := &fakeStore{access: rows}
	primed := NewResolver(primedStore)
	if err := primed.PrimeRoom(context.Background(), room, users); err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		want, wantErr := single.ReadRoom(context.Background(), room, u)
		got, gotErr := primed.ReadRoom(context.Background(), room, u)
		if !reflect.DeepEqual(got, want) || !errors.Is(gotErr, wantErr) {
			t.Fatalf("user %s: primed %+v/%v, single %+v/%v", u, got, gotErr, want, wantErr)
		}
	}
	if primedStore.accessCalls != 1 {
		t.Fatalf("primed resolver queried %d times, want 1", primedStore.accessCalls)
	}
	// A failed prime caches nothing: ReadRoom then loads the user itself.
	failing := &fakeStore{access: rows, err: errors.New("db down")}
	r := NewResolver(failing)
	if err := r.PrimeRoom(context.Background(), room, users); err == nil {
		t.Fatal("prime over a failing store succeeded")
	}
	failing.err = nil
	if acc, err := r.ReadRoom(context.Background(), room, member); err != nil || acc.WorkspaceID != ws {
		t.Fatalf("after a failed prime: %+v %v", acc, err)
	}
}
