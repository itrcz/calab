package perm

import "github.com/google/uuid"

// BoardScope carries the board-level inputs of the rule besides the overrides (ADR-0042,
// ADR-0058 addendum 2026-10-14).
type BoardScope struct {
	// Private: a private board (boards.is_private or boards.restricted; the addendum: one kind
	// of private board, «Только выбранные»). Nobody bypasses it — ADMINISTRATOR, the workspace
	// owner and workspace-level VIEW_BOARD / MANAGE_BOARD count for nothing —: VIEW_BOARD comes
	// only from an allow override on the board (a role's or the user's own) or from being its
	// Creator. The one exception is the owner with OwnerSeesPrivate.
	Private bool
	// Guest: the member's highest built-in role is guest — guests never see boards.
	Guest bool
	// Owner: the user is the workspace owner (holder of the built-in owner role).
	Owner bool
	// OwnerSeesPrivate: the workspace's «Владелец видит приватное»; with Owner a private board
	// gives everything.
	OwnerSeesPrivate bool
	// Creator: the user created the board (boards.created_by); on a private board they always
	// keep VIEW_BOARD (the rest comes from the personal override they got at creation).
	Creator bool
}

// BoardFlags are a board's own inputs of the rule besides its overrides.
type BoardFlags struct {
	Private   bool      // boards.is_private OR boards.restricted
	CreatedBy uuid.UUID // boards.created_by; uuid.Nil when unknown
}

// BoardFlagsOf builds BoardFlags from a board's columns: is_private, restricted (the pre-3.5
// «закрытая» flag, now the same as is_private: migration 00097 aligned them) and created_by.
func BoardFlagsOf(private, restricted bool, createdBy *uuid.UUID) BoardFlags {
	f := BoardFlags{Private: private || restricted}
	if createdBy != nil {
		f.CreatedBy = *createdBy
	}
	return f
}

// BoardScopeOf returns the scope of member m on a board with flags f.
func BoardScopeOf(m Member, f BoardFlags) BoardScope {
	return BoardScope{
		Private: f.Private, Guest: m.Role == RoleGuest, Owner: m.Role == RoleOwner, OwnerSeesPrivate: m.OwnerSeesPrivate,
		Creator: f.CreatedBy != uuid.Nil && m.UserID == f.CreatedBy.String(),
	}
}

// ComputeBoard is the board form of the one permission rule (ADR-0042, ADR-0048, ADR-0058
// addendum 2026-10-14): the order of ComputeOrdered (ADMINISTRATOR → everything, each role's
// override lowest position first, then the user's), but the overrides touch only BoardOnly bits
// and without VIEW_BOARD there is nothing — but create-only (CBF-61, ADR-0115): CREATE_TASKS
// alone when an allow override on the board grants it (the workspace roles' CREATE_TASKS does
// not count) and no later override denies it. Guests get nothing. A private board has no bypass —
// the owner with OwnerSeesPrivate alone gets everything —: ADMINISTRATOR and the roles'
// VIEW_BOARD are dropped, only an allow override lets anyone in, and the creator always keeps
// VIEW_BOARD. Mirror of computePermissions({board}) in packages/protocol.
func ComputeBoard(raw Bits, sc BoardScope, roleOvs []Override, userOv *Override) Bits {
	switch {
	case sc.Guest:
		return 0
	case sc.Private && sc.Owner && sc.OwnerSeesPrivate:
		return All
	case sc.Private:
		raw &^= Administrator | ViewBoard
	case raw&Administrator != 0:
		return All
	}
	p := raw
	granted := Bits(0) // CREATE_TASKS from the board's own overrides (create-only, CBF-61)
	for _, o := range roleOvs {
		p &^= o.Deny & BoardOnly
		p |= o.Allow & BoardOnly
		granted &^= o.Deny & CreateTasks
		granted |= o.Allow & CreateTasks
	}
	if userOv != nil {
		p &^= userOv.Deny & BoardOnly
		p |= userOv.Allow & BoardOnly
		granted &^= userOv.Deny & CreateTasks
		granted |= userOv.Allow & CreateTasks
	}
	if sc.Private && sc.Creator {
		p |= ViewBoard
	}
	if p&ViewBoard == 0 {
		return granted
	}
	return p
}

// CreateOnly reports whether board bits b (ComputeBoard) are the create-only form (CBF-61,
// ADR-0115): CREATE_TASKS without VIEW_BOARD. Such a member — a human, not a guest, on a live
// board: BoardAccess.TaskScoped — sees the board through its cards (ADR-0059) and, besides,
// creates tasks and sees the ones they authored (TaskBits); nothing else of the board.
func CreateOnly(b Bits) bool { return b == CreateTasks }

// ComputeBoardIn computes a member's board permissions from the board's flags and override list.
func ComputeBoardIn(m Member, f BoardFlags, overrides []OverrideTarget) Bits {
	var userOv *Override
	var buf [8]Override
	roleOvs := buf[:0]
	for _, r := range m.Roles { // lowest position first
		for i := range overrides {
			if o := &overrides[i]; o.TargetType == "role" && o.TargetID == r.ID {
				roleOvs = append(roleOvs, o.Override)
				break
			}
		}
	}
	for i := range overrides {
		if o := &overrides[i]; o.TargetType == "user" && o.TargetID == m.UserID {
			userOv = &o.Override
			break
		}
	}
	return ComputeBoard(m.Raw(), BoardScopeOf(m, f), roleOvs, userOv)
}

// ComputeBoardRoles is ComputeBoard from the member's roles (any order) and the board's role
// overrides by role id (the shared test vectors).
func ComputeBoardRoles(roles []RoleBits, sc BoardScope, roleOvs map[string]Override, userOv *Override) Bits {
	m := NewMember("", "", roles)
	ovs := make([]Override, 0, len(m.Roles))
	for _, r := range m.Roles {
		if o, ok := roleOvs[r.ID]; ok {
			ovs = append(ovs, o)
		}
	}
	return ComputeBoard(m.Raw(), sc, ovs, userOv)
}

// TaskBits is the caller's bits on one task (ADR-0059 §2, ADR-0076 §3, ADR-0115): a viewer of
// the board keeps the board's bits; on a task-scoped board an assignee — and, for a create-only
// member (CreateOnly), the task's author — gets VIEW_BOARD | CREATE_TASKS (works on the task
// like a member on their own or assigned task: canEdit; a new task takes the board's bits), an
// approver or a watcher VIEW_BOARD (view, comment, subscribe; an approver also votes); anyone
// else 0 (404). Authorship counts only for a create-only member: an invitee who once wrote a
// task does not see it through that. The roles must be on a live task. Mirror of
// taskPermissions in packages/protocol; the shared case table is proto/testdata/task_bits.json.
func TaskBits(acc BoardAccess, assignee, approver, watcher, author bool) Bits {
	switch {
	case acc.Bits.Has(ViewBoard):
		return acc.Bits
	case acc.TaskScoped && (assignee || (author && CreateOnly(acc.Bits))):
		return ViewBoard | CreateTasks
	case acc.TaskScoped && (approver || watcher):
		return ViewBoard
	}
	return 0
}

// TaskAuthor reports whether user counts as the author of a task for every author rule — the
// create-only visibility of ADR-0115 (TaskBits' author), editing and archiving / restoring one's
// own task with CREATE_TASKS (ADR-0151): the user who created it (createdBy), or the current
// owner of the bot that created it (botOwner: bots.owner_user_id of created_by, resolved in the
// same query as the task; nil when created_by is not a bot or the bot was deleted). Rights only:
// feeds and notices («Мои задачи → Созданные», the outcome of an approval) keep created_by.
// Mirror of isTaskAuthor in packages/protocol (the client passes the ids of its own bots).
func TaskAuthor(createdBy, botOwner *uuid.UUID, user uuid.UUID) bool {
	if user == uuid.Nil {
		return false
	}
	return (createdBy != nil && *createdBy == user) || (botOwner != nil && *botOwner == user)
}

// MessageAuthor is TaskAuthor for a message (ADR-0162): editing one's own message is open to its
// author and to the current owner of the bot that wrote it (botOwner: GetMessageBotOwner — in
// the bot's home workspace only; nil otherwise). The author stays the bot. Mirror of
// isMessageAuthor in packages/protocol.
func MessageAuthor(authorID uuid.UUID, botOwner *uuid.UUID, user uuid.UUID) bool {
	return TaskAuthor(&authorID, botOwner, user)
}

// TaskRoom maps board bits to the bits in a task's comment room (ADR-0042 §1): VIEW_BOARD →
// VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES, EDIT_TASKS adds MANAGE_MESSAGES. The room of an
// archived task is read-only, and so is every task room of a board with the feature COMMENTS
// switched off (ADR-0058 §3: old comments stay visible and moderated). Room overrides do not
// apply. Mirror of taskRoomPermissions in packages/protocol.
func TaskRoom(board Bits, archived, commentsOff bool) Bits {
	if !board.Has(ViewBoard) {
		return 0
	}
	p := ViewRoom
	if !archived && !commentsOff {
		p |= SendMessages | AttachFiles
	}
	if board.Has(EditTasks) {
		p |= ManageMessages
	}
	return p
}

// featureComments is the bit of BOARD_FEATURE_COMMENTS (12) in boards.disabled_features (bit =
// the enum value, ADR-0058 §3).
const featureComments = 1 << 12

// CommentsOff reports whether a board's disabled feature mask switches comments off.
func CommentsOff(disabledFeatures int64) bool { return disabledFeatures&featureComments != 0 }
