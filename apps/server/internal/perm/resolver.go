package perm

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ErrNotMember means the user is not a member of the workspace.
var ErrNotMember = errors.New("perm: not a workspace member")

// ErrNoRoom means the room does not exist (or is archived) or the user is not a member of its
// workspace (of a DM: not one of its two participants).
var ErrNoRoom = errors.New("perm: room not accessible")

// ErrArchived is Room's error for an archived temporary room (ADR-0044). It wraps ErrNoRoom:
// callers that do not know about the archive treat it as a missing room. ReadRoom resolves it.
var ErrArchived = fmt.Errorf("perm: room archived: %w", ErrNoRoom)

// Store is the subset of sqlc queries the resolver needs.
type Store interface {
	GetMemberAccess(ctx context.Context, arg sqlc.GetMemberAccessParams) (sqlc.GetMemberAccessRow, error)
	GetRoomAccess(ctx context.Context, arg sqlc.GetRoomAccessParams) (sqlc.GetRoomAccessRow, error)
	GetRoomAccesses(ctx context.Context, arg sqlc.GetRoomAccessesParams) ([]sqlc.GetRoomAccessesRow, error)
	GetBoardAccess(ctx context.Context, arg sqlc.GetBoardAccessParams) (sqlc.GetBoardAccessRow, error)
	GetTaskRoomRef(ctx context.Context, arg sqlc.GetTaskRoomRefParams) (sqlc.GetTaskRoomRefRow, error)
}

// RoomAccess is a user's resolved access to a room.
type RoomAccess struct {
	WorkspaceID uuid.UUID // uuid.Nil for a DM
	Role        Role      // highest built-in role; "" for a DM
	Bits        Bits
	// Member: the member's roles (zero for a DM); Member.Workspace() = workspace-level bits.
	Member Member
	// DM rooms (ADR-0020): the two participants. They get the room's events on their user
	// channels instead of a workspace channel.
	// Notes shelves (ADR-0039) are DM rooms too (DM true, Members = the owner only); Notes
	// marks them where a DM means two people (calls, voice, archive).
	DM      bool
	Notes   bool
	Members []uuid.UUID
	// Suspended: the workspace is suspended by a superadmin (read-only; item 32).
	Suspended bool
	// Restricted: the room is restricted (ADR-0029): ADMINISTRATOR gives no bypass in it.
	Restricted bool
	// PrivateTemp: a private temporary room (ADR-0078): nobody bypasses it — workspace-level
	// rights (ADMINISTRATOR, the owner, MANAGE_ROOM / MUTE_MEMBERS / MOVE_MEMBERS of the roles)
	// never reach into it; only Bits do.
	PrivateTemp bool
	// Task: the hidden comment room of a task (ADR-0042); Bits come from the board
	// (TaskRoom), room overrides do not apply. TaskID / BoardID name them.
	Task    bool
	TaskID  uuid.UUID
	BoardID uuid.UUID
	// Temp: a temporary room (rooms.expires_at set, ADR-0044); CreatedBy: its creator
	// (uuid.Nil when unknown). Archived: an archived temporary room — only ReadRoom returns it.
	Temp      bool
	CreatedBy uuid.UUID
	Archived  bool
}

// Creator reports whether userID created this temporary room (ADR-0044: the creator manages
// it without MANAGE_ROOM). Never true for a permanent room, a guest or an unknown creator.
func (a RoomAccess) Creator(userID uuid.UUID) bool {
	return a.Temp && a.CreatedBy != uuid.Nil && a.CreatedBy == userID && a.Role != RoleGuest && a.Role != ""
}

// ok reports a resolved access (the zero value = no access).
func (a RoomAccess) ok() bool { return a.WorkspaceID != uuid.Nil || a.DM }

type key struct{ a, b uuid.UUID }

// Resolver loads roles + overrides from the DB and computes effective permissions.
// It caches results for its lifetime; create one per request (see WithResolver).
type Resolver struct {
	store   Store
	mu      sync.Mutex
	members map[key]Member     // (workspace, user) -> member; Role "" = not a member
	rooms   map[key]RoomAccess // (room, user) -> access; zero value = no access
	boards  map[key]BoardAccess
}

// NewResolver returns an empty resolver.
func NewResolver(s Store) *Resolver {
	return &Resolver{store: s, members: map[key]Member{}, rooms: map[key]RoomAccess{}, boards: map[key]BoardAccess{}}
}

// RoleList zips the parallel role arrays of a query row.
func RoleList(ids []uuid.UUID, positions []int32, perms []int64) []RoleBits {
	n := min(len(ids), len(positions), len(perms))
	out := make([]RoleBits, n)
	for i := range n {
		out[i] = RoleBits{ID: ids[i].String(), Position: positions[i], Permissions: Bits(uint64(perms[i]))} //nolint:gosec // bit mask round-trip
	}
	return out
}

// Member returns the user's roles in the workspace, or ErrNotMember.
func (r *Resolver) Member(ctx context.Context, workspaceID, userID uuid.UUID) (Member, error) {
	if err := CheckAccess(ctx, workspaceID, userID); err != nil {
		return Member{}, err
	}
	k := key{workspaceID, userID}
	r.mu.Lock()
	m, ok := r.members[k]
	r.mu.Unlock()
	if !ok {
		row, err := r.store.GetMemberAccess(ctx, sqlc.GetMemberAccessParams{WorkspaceID: workspaceID, UserID: userID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			m = Member{}
		case err != nil:
			return Member{}, fmt.Errorf("perm: load member: %w", err)
		default:
			m = NewMember(userID.String(), Role(row.Role), RoleList(row.RoleIds, row.RolePositions, row.RolePermissions))
		}
		r.mu.Lock()
		r.members[k] = m
		r.mu.Unlock()
	}
	if m.Role == "" {
		return Member{}, ErrNotMember
	}
	return m, nil
}

// Role returns the user's highest built-in role in the workspace, or ErrNotMember.
func (r *Resolver) Role(ctx context.Context, workspaceID, userID uuid.UUID) (Role, error) {
	m, err := r.Member(ctx, workspaceID, userID)
	return m.Role, err
}

// Workspace returns the user's workspace-level permissions and highest built-in role.
func (r *Resolver) Workspace(ctx context.Context, workspaceID, userID uuid.UUID) (Bits, Role, error) {
	m, err := r.Member(ctx, workspaceID, userID)
	if err != nil {
		return 0, "", err
	}
	return m.Workspace(), m.Role, nil
}

// Room returns the user's effective permissions in a room, or ErrNoRoom (ErrArchived for an
// archived temporary room).
func (r *Resolver) Room(ctx context.Context, roomID, userID uuid.UUID) (RoomAccess, error) {
	acc, err := r.ReadRoom(ctx, roomID, userID)
	if err == nil && acc.Archived {
		return RoomAccess{}, ErrArchived
	}
	return acc, err
}

// ReadRoom is Room that also resolves an archived temporary room (Archived set): reading its
// history is allowed with VIEW_ROOM (ADR-0044), nothing else.
func (r *Resolver) ReadRoom(ctx context.Context, roomID, userID uuid.UUID) (RoomAccess, error) {
	k := key{roomID, userID}
	r.mu.Lock()
	acc, ok := r.rooms[k]
	r.mu.Unlock()
	if !ok {
		row, err := r.store.GetRoomAccess(ctx, sqlc.GetRoomAccessParams{RoomID: roomID, UserID: userID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			acc, err = r.cacheRoom(ctx, roomID, userID, nil)
		case err != nil:
			return RoomAccess{}, fmt.Errorf("perm: load room access: %w", err)
		default:
			acc, err = r.cacheRoom(ctx, roomID, userID, &row)
		}
		if err != nil {
			return RoomAccess{}, err
		}
	}
	if !acc.ok() {
		return RoomAccess{}, ErrNoRoom
	}
	if err := CheckAccess(ctx, acc.WorkspaceID, userID); err != nil {
		return RoomAccess{}, err
	}
	return acc, nil
}

// PrimeRoom loads the access of several users to one room in one statement into the cache;
// ReadRoom then answers them without a query, exactly as if it had loaded each itself.
// A failed load caches nothing: ReadRoom loads on its own. One user is left to ReadRoom: its
// statement's plan is cached, the list one is planned on every call.
func (r *Resolver) PrimeRoom(ctx context.Context, roomID uuid.UUID, userIDs []uuid.UUID) error {
	if len(userIDs) < 2 {
		return nil
	}
	rows, err := r.store.GetRoomAccesses(ctx, sqlc.GetRoomAccessesParams{RoomID: roomID, UserIds: userIDs})
	if err != nil {
		return fmt.Errorf("perm: load room access: %w", err)
	}
	// One row per user in their order, or none when GetRoomAccess finds no room.
	if len(rows) != 0 && len(rows) != len(userIDs) {
		return fmt.Errorf("perm: load room access: %d rows for %d users", len(rows), len(userIDs))
	}
	for i, userID := range userIDs {
		r.mu.Lock()
		_, cached := r.rooms[key{roomID, userID}]
		r.mu.Unlock()
		if cached {
			continue
		}
		var row *sqlc.GetRoomAccessRow
		if len(rows) > 0 {
			one := sqlc.GetRoomAccessRow(rows[i]) // same columns: a column change in one query breaks this
			row = &one
		}
		if _, err := r.cacheRoom(ctx, roomID, userID, row); err != nil {
			return err
		}
	}
	return nil
}

// cacheRoom maps a user's GetRoomAccess row (nil: the room was not found) to RoomAccess and
// caches it.
func (r *Resolver) cacheRoom(ctx context.Context, roomID, userID uuid.UUID, row *sqlc.GetRoomAccessRow) (RoomAccess, error) {
	var acc RoomAccess
	switch {
	case row == nil:
	case row.Type == "task":
		var err error
		if acc, err = r.taskRoom(ctx, roomID, userID); err != nil {
			return RoomAccess{}, err
		}
	case row.Type == "dm" || row.Type == "notes":
		if slices.Contains(row.DmMembers, userID) {
			acc = RoomAccess{Bits: ComputeDM(true), DM: true, Notes: row.Type == "notes", Members: row.DmMembers}
		}
	case row.WorkspaceID != nil && row.Role != nil:
		// The query returns the roles lowest position first, each with its override
		// in this room (0/0 = none, which changes nothing).
		m := Member{UserID: userID.String(), Role: Role(*row.Role), Roles: RoleList(row.RoleIds, row.RolePositions, row.RolePermissions)}
		n := min(len(row.RoleAllows), len(row.RoleDenies))
		ovs := make([]Override, n)
		for i := range n {
			ovs[i] = Override{Allow: Bits(uint64(row.RoleAllows[i])), Deny: Bits(uint64(row.RoleDenies[i]))} //nolint:gosec // bit mask round-trip
		}
		acc = RoomAccess{
			WorkspaceID: *row.WorkspaceID,
			Role:        m.Role,
			Member:      m,
			Bits:        ComputeOrdered(m.Raw(), ScopeOf(m, Flags(row.Restricted, row.IsPrivate, row.Temp, row.CreatedBy)), ovs, override(row.UserAllow, row.UserDeny)),
			Suspended:   row.Suspended,
			Restricted:  row.Restricted,
			PrivateTemp: row.IsPrivate && row.Temp,
			Temp:        row.Temp,
			Archived:    row.Archived,
		}
		if row.CreatedBy != nil {
			acc.CreatedBy = *row.CreatedBy
		}
	}
	if row != nil && row.Archived && !row.Temp { // the query finds archived temporary rooms only
		acc = RoomAccess{}
	}
	r.mu.Lock()
	r.rooms[key{roomID, userID}] = acc
	if acc.WorkspaceID != uuid.Nil {
		r.members[key{acc.WorkspaceID, userID}] = acc.Member
	}
	r.mu.Unlock()
	return acc, nil
}

// Invalidate drops cached results (call after mutating roles or overrides in the same request).
func (r *Resolver) Invalidate() {
	r.mu.Lock()
	clear(r.members)
	clear(r.rooms)
	clear(r.boards)
	r.mu.Unlock()
}

func override(allow, deny *int64) *Override {
	if allow == nil || deny == nil {
		return nil
	}
	return &Override{Allow: Bits(uint64(*allow)), Deny: Bits(uint64(*deny))} //nolint:gosec // bit mask round-trip
}

type ctxKey struct{}

// WithResolver installs a fresh per-request resolver into ctx.
func WithResolver(ctx context.Context, s Store) context.Context {
	return context.WithValue(ctx, ctxKey{}, NewResolver(s))
}

// FromContext returns the request's resolver. It panics if none was installed, which is a
// wiring bug (the perm middleware must wrap all authenticated routes).
func FromContext(ctx context.Context) *Resolver {
	r, ok := ctx.Value(ctxKey{}).(*Resolver)
	if !ok {
		panic("perm: no resolver in context")
	}
	return r
}
