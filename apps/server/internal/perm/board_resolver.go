package perm

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ErrNoBoard means the board does not exist or the user is not a member of its workspace.
var ErrNoBoard = errors.New("perm: board not accessible")

// BoardAccess is a user's resolved access to a task board (ADR-0042).
type BoardAccess struct {
	WorkspaceID uuid.UUID
	Role        Role // highest built-in role
	Member      Member
	Bits        Bits // 0 = the board is hidden from the user
	Private     bool
	Restricted  bool // boards.restricted (ADR-0048)
	Archived    bool
	Suspended   bool
	// DisabledFeatures: boards.disabled_features, the BoardFeature bit mask switched off
	// (ADR-0058 §3; bit = the enum value).
	DisabledFeatures int64
	// TaskScoped (ADR-0059, ADR-0076): Bits = 0, yet the member (a human, not a guest) is an
	// assignee, an approver or a watcher of a live task of this live board (restricted or not,
	// ADR-0076 §2) — they see the board through those tasks only (TaskBits).
	TaskScoped bool
}

// Board returns the user's access to a board, or ErrNoBoard when the board does not exist or
// the user is not a member of its workspace. Bits may be 0 (a hidden board): callers answer 404
// unless TaskScoped (ADR-0059).
func (r *Resolver) Board(ctx context.Context, boardID, userID uuid.UUID) (BoardAccess, error) {
	k := key{boardID, userID}
	r.mu.Lock()
	acc, ok := r.boards[k]
	r.mu.Unlock()
	if !ok {
		row, err := r.store.GetBoardAccess(ctx, sqlc.GetBoardAccessParams{BoardID: boardID, UserID: userID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			acc = BoardAccess{}
		case err != nil:
			return BoardAccess{}, fmt.Errorf("perm: load board access: %w", err)
		case row.Role != nil:
			m := Member{UserID: userID.String(), Role: Role(*row.Role), Roles: RoleList(row.RoleIds, row.RolePositions, row.RolePermissions)}
			n := min(len(row.RoleAllows), len(row.RoleDenies))
			ovs := make([]Override, n)
			for i := range n {
				ovs[i] = Override{Allow: Bits(uint64(row.RoleAllows[i])), Deny: Bits(uint64(row.RoleDenies[i]))} //nolint:gosec // bit mask round-trip
			}
			acc = BoardAccess{
				WorkspaceID: row.WorkspaceID, Role: m.Role, Member: m,
				Bits:    ComputeBoard(m.Raw(), BoardScopeOf(m, row.IsPrivate, row.Restricted), ovs, override(row.UserAllow, row.UserDeny)),
				Private: row.IsPrivate, Restricted: row.Restricted, Archived: row.Archived, Suspended: row.Suspended,
				DisabledFeatures: row.DisabledFeatures,
			}
			acc.TaskScoped = row.Invited && acc.Bits == 0 && m.Role != RoleGuest && !row.Archived
		}
		r.mu.Lock()
		r.boards[k] = acc
		if acc.WorkspaceID != uuid.Nil {
			r.members[key{acc.WorkspaceID, userID}] = acc.Member
		}
		r.mu.Unlock()
	}
	if acc.WorkspaceID == uuid.Nil {
		return BoardAccess{}, ErrNoBoard
	}
	if err := CheckAccess(ctx, acc.WorkspaceID, userID); err != nil {
		return BoardAccess{}, err
	}
	return acc, nil
}

// taskRoom resolves a task's comment room from its board (ADR-0042 §1): no access on an
// archived board or without the task's bits (TaskBits: VIEW_BOARD, or invited on a live task of
// a task-scoped board, ADR-0059 / ADR-0076).
func (r *Resolver) taskRoom(ctx context.Context, roomID, userID uuid.UUID) (RoomAccess, error) {
	ref, err := r.store.GetTaskRoomRef(ctx, sqlc.GetTaskRoomRefParams{RoomID: roomID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return RoomAccess{}, nil
	}
	if err != nil {
		return RoomAccess{}, fmt.Errorf("perm: load task room: %w", err)
	}
	b, err := r.Board(ctx, ref.BoardID, userID)
	if errors.Is(err, ErrNoBoard) {
		return RoomAccess{}, nil
	}
	if err != nil {
		return RoomAccess{}, err
	}
	live := !ref.TaskArchived // invitations count on live tasks only
	bits := TaskRoom(TaskBits(b, live && ref.Assignee, live && ref.Approver, live && ref.Watcher), ref.TaskArchived, CommentsOff(b.DisabledFeatures))
	if b.Archived || bits == 0 {
		// A member who cannot see the board: the room exists but shows nothing (404 upstream).
		return RoomAccess{WorkspaceID: b.WorkspaceID, Role: b.Role, Member: b.Member, Task: true, TaskID: ref.TaskID, BoardID: ref.BoardID}, nil
	}
	return RoomAccess{
		WorkspaceID: b.WorkspaceID, Role: b.Role, Member: b.Member, Bits: bits, Suspended: b.Suspended,
		Task: true, TaskID: ref.TaskID, BoardID: ref.BoardID,
	}, nil
}
