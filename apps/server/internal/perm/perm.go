// Package perm computes effective permissions (docs/04-data-model.md, ADR-0008, ADR-0026).
// Mirror of packages/protocol/src/permissions.ts; both are checked against
// proto/testdata/permissions.json. Keep them in sync.
package perm

import (
	"slices"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Bits is a permission bit mask (see docs/04-data-model.md).
type Bits uint64

// Permission bits; values match the Permission enum in proto/calaba/v1/permissions.proto.
const (
	ViewRoom        Bits = 1 << 0
	SendMessages    Bits = 1 << 1
	AttachFiles     Bits = 1 << 2
	ManageMessages  Bits = 1 << 3
	Connect         Bits = 1 << 4
	Speak           Bits = 1 << 5
	Stream          Bits = 1 << 6
	MuteMembers     Bits = 1 << 7
	ManageRoom      Bits = 1 << 8
	ManageWorkspace Bits = 1 << 9
	Administrator   Bits = 1 << 10
	MoveMembers     Bits = 1 << 11 // move others between voice rooms, join over user_limit
	ManageNicknames Bits = 1 << 12 // workspace-level: change others' nicknames
	MentionEveryone Bits = 1 << 13 // @everyone / @here notify everyone who sees the room
	Video           Bits = 1 << 14 // publish a webcam in voice rooms
	ManageRoles     Bits = 1 << 15 // workspace-level: manage and assign roles below one's own (ADR-0026)
	ManageStickers  Bits = 1 << 16 // workspace-level: manage the workspace's sticker packs (ADR-0030)
	// Board bits (ADR-0042): apply to task boards only (BoardOnly).
	ViewBoard   Bits = 1 << 17 // see a board, its tasks and comments; comment; subscribe
	CreateTasks Bits = 1 << 18 // create tasks; edit own and assigned ones
	EditTasks   Bits = 1 << 19 // edit, move, archive any task; moderate comments
	ManageBoard Bits = 1 << 20 // statuses, labels, milestones, settings, access, archive
	// Invitations (ADR-0043): not implied by MANAGE_WORKSPACE / MANAGE_ROOM; settable per room.
	InviteMembers Bits = 1 << 21 // workspace invites; in a room: members-only room links
	InviteGuests  Bits = 1 << 22 // room links admitting guests, their approval, admission decisions
	// CreateTempRooms (ADR-0044): workspace-level, create temporary rooms (member default).
	CreateTempRooms Bits = 1 << 23
	// PlaceCalls (ADR-0046): outbound phone calls from a voice room; workspace and room level,
	// nobody by default, never guests (the handlers refuse them).
	PlaceCalls Bits = 1 << 24
	// Roles v2 (ADR-0048): workspace-level bits split off MANAGE_WORKSPACE (WorkspaceOnly).
	CreateBoards       Bits = 1 << 25 // create task boards
	ManageMembers      Bits = 1 << 26 // remove, ban, badges, promote guests, assign roles below one's own
	ManageBots         Bits = 1 << 27 // the workspace's bots
	ManageIntegrations Bits = 1 << 28 // telephony settings, GPTunneL, future integrations
	ViewJournals       Bits = 1 << 29 // call journal, board activity export
	ManageEvents       Bits = 1 << 30 // others' meetings, workspace-wide meetings
	ManageRecordings   Bits = 1 << 31 // delete any visible room's recordings, recording consent

	All Bits = ManageRecordings<<1 - 1
)

// RolesV2 are the seven bits of ADR-0048; migration 00052 gave them to every role that held
// MANAGE_WORKSPACE.
const RolesV2 = CreateBoards | ManageMembers | ManageBots | ManageIntegrations | ViewJournals | ManageEvents | ManageRecordings

// BoardOnly are the bits of task boards (ADR-0042): board overrides touch only them, room
// overrides never do.
const BoardOnly = ViewBoard | CreateTasks | EditTasks | ManageBoard

// Role is a built-in workspace role as stored in workspace_members.role and
// workspace_roles.builtin.
type Role string

// Built-in workspace roles.
const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
	RoleGuest  Role = "guest"
)

// Positions of the built-in roles (ADR-0026). Custom roles live in between (2..); owner and
// admin always stay on top, member and guest at the bottom. Keep in sync with migration 00021.
const (
	PosGuest  int32 = 0
	PosMember int32 = 1
	PosCustom int32 = 2 // lowest custom role
	PosAdmin  int32 = 1000
	PosOwner  int32 = 1001
)

// RoleDefaults are the initial permissions of the built-in roles (migration 00021 creates
// them with these values; member and guest are editable since ADR-0026).
var RoleDefaults = map[Role]Bits{
	RoleOwner:  Administrator,
	RoleAdmin:  Administrator,
	RoleMember: ViewRoom | SendMessages | AttachFiles | Connect | Speak | Stream | Video | ViewBoard | CreateTasks | CreateTempRooms,
	// Guests see only rooms with an explicit VIEW_ROOM allow override.
	RoleGuest: Connect | Speak,
}

// GuestMax bounds the permissions of the built-in guest role: no moderation or management.
const GuestMax = ViewRoom | SendMessages | AttachFiles | Connect | Speak | Stream | Video

var builtinPos = map[Role]int32{RoleOwner: PosOwner, RoleAdmin: PosAdmin, RoleMember: PosMember, RoleGuest: PosGuest}

// Position returns the fixed position of a built-in role.
func (r Role) Position() int32 { return builtinPos[r] }

// Override is a room-level allow/deny pair.
type Override struct {
	Allow, Deny Bits
}

// RoleBits is a role as far as permissions are concerned.
type RoleBits struct {
	ID          string // role id (uuid text), the target_id of its room overrides
	Position    int32
	Permissions Bits
}

// Member is a workspace member's permission-relevant state.
type Member struct {
	UserID string
	Role   Role       // highest built-in role (workspace_members.role)
	Roles  []RoleBits // lowest position first
}

// NewMember returns a Member with roles sorted by position (lowest first).
func NewMember(userID string, role Role, roles []RoleBits) Member {
	rs := slices.Clone(roles)
	// Stable, like Array.prototype.sort in the TS mirror (positions are unique per workspace).
	slices.SortStableFunc(rs, func(a, b RoleBits) int { return int(a.Position) - int(b.Position) })
	return Member{UserID: userID, Role: role, Roles: rs}
}

// RawBits is the plain OR over role permissions (ADMINISTRATOR not expanded).
func RawBits(roles []RoleBits) Bits {
	var p Bits
	for _, r := range roles {
		p |= r.Permissions
	}
	return p
}

// WorkspaceBits is the OR over role permissions; ADMINISTRATOR means everything.
func WorkspaceBits(roles []RoleBits) Bits {
	if p := RawBits(roles); p&Administrator == 0 {
		return p
	}
	return All
}

// Workspace returns the member's workspace-level permissions (no room overrides).
func (m Member) Workspace() Bits { return WorkspaceBits(m.Roles) }

// Raw returns the OR of the member's role permissions, ADMINISTRATOR not expanded.
func (m Member) Raw() Bits { return RawBits(m.Roles) }

// Top returns the position of the member's highest role (-1 without roles).
func (m Member) Top() int32 {
	if len(m.Roles) == 0 {
		return -1
	}
	return m.Roles[len(m.Roles)-1].Position
}

// Has reports whether the member holds role id.
func (m Member) Has(id string) bool {
	for _, r := range m.Roles {
		if r.ID == id {
			return true
		}
	}
	return false
}

// Scope carries the room-level inputs of the rule besides the overrides (ADR-0029, ADR-0078).
type Scope struct {
	// Restricted: rooms.restricted — ADMINISTRATOR gives no bypass in the room and VIEW_ROOM
	// comes only from an override (ADR-0029, ADR-0048).
	Restricted bool
	// Owner: the user is the workspace owner (workspaces.owner_id, the holder of the built-in
	// owner role): everything, always, restricted or not — except in a PrivateTemp room.
	Owner bool
	// PrivateTemp: a private temporary room (is_private and expires_at set, live or archived;
	// ADR-0078). Nobody bypasses it — not ADMINISTRATOR, not the owner — and VIEW_ROOM comes only
	// from the user's own override (people chosen in the dialog or in «Доступ», whoever entered
	// by the room's link) or from being its Creator.
	PrivateTemp bool
	// Creator: the user created this temporary room and is a member, not a guest (ADR-0044); in
	// a PrivateTemp room they always keep VIEW_ROOM.
	Creator bool
}

// RoomFlags are a room's own inputs of the rule besides its overrides.
type RoomFlags struct {
	Restricted  bool      // rooms.restricted (ADR-0029)
	PrivateTemp bool      // is_private AND expires_at IS NOT NULL (ADR-0078)
	CreatedBy   uuid.UUID // rooms.created_by; uuid.Nil when unknown
}

// Flags builds RoomFlags from a room's columns: restricted, is_private, whether expires_at is
// set (a temporary room) and created_by (may be nil).
func Flags(restricted, private, temp bool, createdBy *uuid.UUID) RoomFlags {
	f := RoomFlags{Restricted: restricted, PrivateTemp: private && temp}
	if createdBy != nil {
		f.CreatedBy = *createdBy
	}
	return f
}

// FlagsOf returns the flags of a room row.
func FlagsOf(r sqlc.Room) RoomFlags {
	return Flags(r.Restricted, r.IsPrivate, r.ExpiresAt != nil, r.CreatedBy)
}

// ScopeOf returns the scope of member m in a room with flags f.
func ScopeOf(m Member, f RoomFlags) Scope {
	return Scope{
		Restricted:  f.Restricted,
		Owner:       m.Role == RoleOwner,
		PrivateTemp: f.PrivateTemp,
		Creator:     f.CreatedBy != uuid.Nil && m.UserID == f.CreatedBy.String() && m.Role != RoleGuest && m.Role != "",
	}
}

// ComputeOrdered is the one room-permission rule (ADR-0026, ADR-0029, ADR-0048, ADR-0078): raw
// = OR of the member's roles' permissions (not expanded). In a private temporary room nobody
// has a bypass: ADMINISTRATOR and the roles' VIEW_ROOM are dropped, the owner counts as anyone
// else, role overrides do not grant VIEW_ROOM — only the user's own override does — and the
// room's creator always has it. In a restricted room the owner gets everything, ADMINISTRATOR
// is dropped (admins count as plain members) and so is the roles' VIEW_ROOM: only an allow
// override on the room lets anyone in; elsewhere ADMINISTRATOR means everything, overrides
// ignored. Then each role's override in the room lowest position first (deny, then allow; the
// most senior role wins), then the user's own override; without VIEW_ROOM nothing. Overrides
// only touch RoomOnly bits: the workspace-level ones (ADMINISTRATOR, MANAGE_WORKSPACE,
// MANAGE_NICKNAMES, MANAGE_ROLES, MANAGE_STICKERS, CREATE_TEMP_ROOMS, the ADR-0048 bits) are
// neither granted nor taken away per room, whatever is stored. roleOvs are in the order of the
// roles; a zero Override is "none".
func ComputeOrdered(raw Bits, sc Scope, roleOvs []Override, userOv *Override) Bits {
	roleMask := RoomOnly
	switch {
	case sc.PrivateTemp:
		raw &^= Administrator | ViewRoom
		roleMask &^= ViewRoom
	case sc.Restricted && sc.Owner:
		return All
	case sc.Restricted:
		raw &^= Administrator | ViewRoom
	case raw&Administrator != 0:
		return All
	}
	p := raw
	for _, o := range roleOvs {
		p &^= o.Deny & roleMask
		p |= o.Allow & roleMask
	}
	if userOv != nil {
		p &^= userOv.Deny & RoomOnly
		p |= userOv.Allow & RoomOnly
	}
	if sc.PrivateTemp && sc.Creator {
		p |= ViewRoom
	}
	if p&ViewRoom == 0 {
		return 0
	}
	return p
}

// ComputeRoles computes room permissions from the member's roles (any order), the room's
// role overrides by role id and the user override (may be nil).
func ComputeRoles(roles []RoleBits, sc Scope, roleOvs map[string]Override, userOv *Override) Bits {
	m := NewMember("", "", roles)
	ovs := make([]Override, 0, len(m.Roles))
	for _, r := range m.Roles {
		if o, ok := roleOvs[r.ID]; ok {
			ovs = append(ovs, o)
		}
	}
	return ComputeOrdered(m.Raw(), sc, ovs, userOv)
}

// Compute is the pre-ADR-0026 form: one built-in role with its default permissions and its
// override (target id = the role name). Kept for the legacy test vectors.
func Compute(role Role, roleOv, userOv *Override) Bits {
	rb, ok := RoleDefaults[role]
	if !ok {
		return 0
	}
	ovs := map[string]Override{}
	if roleOv != nil {
		ovs[string(role)] = *roleOv
	}
	return ComputeRoles([]RoleBits{{ID: string(role), Position: role.Position(), Permissions: rb}}, Scope{}, ovs, userOv)
}

// DM is the fixed permission set of both participants of a direct message (ADR-0020):
// read and write, attach files, react. Roles, overrides, @everyone and moderation do not
// apply. The rest of the ADR's list maps onto rules rather than bits: reading history is
// VIEW_ROOM, reactions need SEND_MESSAGES, editing / deleting own messages is the author's
// right everywhere, and pinning in a DM is allowed to both participants by room type
// (messages.canPin) — not via MANAGE_MESSAGES, which would let a participant delete the
// other's messages.
const DM = ViewRoom | SendMessages | AttachFiles

// ComputeDM returns effective permissions in a direct message: DM for its two
// participants, nothing for anyone else.
func ComputeDM(participant bool) Bits {
	if !participant {
		return 0
	}
	return DM
}

// Has reports whether all bits of p are set.
func (b Bits) Has(p Bits) bool { return b&p == p }
