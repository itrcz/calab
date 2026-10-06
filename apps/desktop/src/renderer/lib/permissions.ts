import {
  PERMISSION_BITS,
  PermissionTargetType,
  RoomType,
  computeMemberRoomPermissions,
  computePermissions,
  tempRoomScope,
  WorkspaceRole,
  has,
  workspacePermissions,
  type PermissionBits,
  type PermissionName,
  type RoleBits,
  type Room,
  type RoomPermissionOverride,
} from '@calaba/protocol';

/**
 * UI permission helpers on top of `computePermissions` (packages/protocol). Since ADR-0026 a
 * member holds several roles: callers pass them (`rolesOf` / `useMemberRoles` in
 * stores/workspaces). The client only hides UI; every action is checked by the server (CLAUDE.md).
 */

export function roomPerms(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): PermissionBits {
  // A DM (ADR-0020) or my notes shelf (ADR-0039): the fixed set; the client only knows its own.
  if (room?.type === RoomType.DM || room?.type === RoomType.NOTES) return computePermissions({ dm: { participant: true } });
  if (!room || !roles || roles.length === 0) return 0n;
  // ADR-0029: in a restricted room admins count as members; the owner (built-in owner role) has all.
  // ADR-0078: a private temporary room has no bypass at all (not even the owner).
  return computeMemberRoomPermissions(roles, userId, room.permissionOverrides, room.restricted, undefined, tempRoomScope(room));
}

/** Workspace-level permissions (no room overrides): the OR of the member's roles. */
export function workspacePerms(roles: readonly RoleBits[] | undefined): PermissionBits {
  return roles ? workspacePermissions(roles) : 0n;
}

export function can(perms: PermissionBits, name: PermissionName): boolean {
  return has(perms, PERMISSION_BITS[name]);
}

/**
 * Rooms and categories: create, rename, reorder (drag & drop, «Переместить вверх / вниз») —
 * workspace-level MANAGE_ROOM of my roles (owner / admins: ADMINISTRATOR = everything).
 */
export function mayArrangeRooms(roles: readonly RoleBits[] | undefined): boolean {
  return can(workspacePerms(roles), 'MANAGE_ROOM');
}

/**
 * Workspace management — what ADR-0048 left under MANAGE_WORKSPACE: settings («Общие», «Звук»),
 * appearance, camera backgrounds, plan, guest policy, danger zone. Workspace-level MANAGE_WORKSPACE
 * of my roles — the server's check; a custom role with it too, not only the built-in owner / admins.
 */
export function mayManageWorkspace(roles: readonly RoleBits[] | undefined): boolean {
  return can(workspacePerms(roles), 'MANAGE_WORKSPACE');
}

/**
 * The ADR-0048 function bits (split off MANAGE_WORKSPACE; no implication from it — migration 00052
 * gave them to its roles): workspace level, guests never (the server's requireBit).
 */
function wsBit(roles: readonly RoleBits[] | undefined, bit: PermissionName): boolean {
  return !isGuestOnly(roles) && can(workspacePerms(roles), bit);
}

/** «Создать доску» (ADR-0048): CREATE_BOARDS. */
export const mayCreateBoards = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'CREATE_BOARDS');

/** Kick, ban / unban, «Забаненные», the badge library, guest → member (ADR-0048): MANAGE_MEMBERS. */
export const mayManageMembers = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'MANAGE_MEMBERS');

/** «Боты» — create, edit, delete, tokens, add to a workspace, avatar (ADR-0048): MANAGE_BOTS. */
export const mayManageBots = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'MANAGE_BOTS');

/** GPTunneL pairing, SIP settings, future integrations (ADR-0048): MANAGE_INTEGRATIONS. */
export const mayManageIntegrations = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'MANAGE_INTEGRATIONS');

/** The call journal and a board's activity export (ADR-0048): VIEW_JOURNALS (only what I see). */
export const mayViewJournals = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'VIEW_JOURNALS');

/** Others' meetings (ADR-0048): MANAGE_EVENTS — without a room, or in a room I see. */
export const mayManageEvents = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'MANAGE_EVENTS');

/** Recordings of any visible room (ADR-0048): MANAGE_RECORDINGS. */
export const mayManageRecordings = (roles: readonly RoleBits[] | undefined): boolean => wsBit(roles, 'MANAGE_RECORDINGS');

/** Giving / taking a member's roles (ADR-0048): MANAGE_MEMBERS or MANAGE_ROLES (hierarchy: lib/roles). */
export function mayAssignRoles(roles: readonly RoleBits[] | undefined): boolean {
  return wsBit(roles, 'MANAGE_MEMBERS') || wsBit(roles, 'MANAGE_ROLES');
}

/**
 * The tabs of «Настройки пространства» by right (ADR-0048; the server's checks). «Участники» and
 * «Тариф» are for everyone, «Приглашения» — mayInviteMembers, «Опасная зона» — the owner.
 */
export interface SettingsAccess {
  /** «Общие», «Звук», «Фоны камеры»: MANAGE_WORKSPACE. */
  workspace: boolean;
  roles: boolean;
  stickers: boolean;
  /** «Забаненные», «Бейджи», kick / ban in «Участники»: MANAGE_MEMBERS. */
  members: boolean;
  bots: boolean;
  /** GPTunneL pairing, «Телефония»: MANAGE_INTEGRATIONS. */
  integrations: boolean;
  invites: boolean;
}

export function settingsAccess(roles: readonly RoleBits[] | undefined): SettingsAccess {
  const ws = workspacePerms(roles);
  return {
    workspace: mayManageWorkspace(roles),
    roles: can(ws, 'MANAGE_ROLES'),
    stickers: can(ws, 'MANAGE_STICKERS'),
    members: mayManageMembers(roles),
    bots: mayManageBots(roles),
    integrations: mayManageIntegrations(roles),
    invites: mayInviteMembers(roles),
  };
}

/**
 * «Настройки пространства» in the workspace / rail menus: any tab beyond «Участники» (which has
 * its own item) — not only MANAGE_WORKSPACE since ADR-0048 split the admin rights.
 */
export function mayOpenWorkspaceSettings(roles: readonly RoleBits[] | undefined): boolean {
  const a = settingsAccess(roles);
  return a.workspace || a.roles || a.stickers || a.members || a.bots || a.integrations;
}

/**
 * «Разрешить запись встреч» of a voice room (ADR-0048): MANAGE_ROOM in the room (PATCH needs it)
 * and workspace MANAGE_RECORDINGS; guests never.
 */
export function mayAllowRecording(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return mayManageRoom(roles, userId, room) && mayManageRecordings(roles);
}

/**
 * Access level of a private room / board (ADR-0048 §2, «По списку, без администраторов»): whoever
 * manages the object (`manage`: MANAGE_ROOM / MANAGE_BOARD there) switches it; the owner may always
 * lift it. Turning it on needs the object to be private (the server: 422 restricted).
 */
export function mayChangeRestricted(manage: boolean, owner: boolean, restricted: boolean): boolean {
  return manage || (owner && restricted);
}

/** The three access levels of a room / board (ADR-0048 «Третий уровень доступа»). */
export type AccessLevel = 'all' | 'list' | 'restricted';

export function accessLevelOf(o: { isPrivate: boolean; restricted: boolean }): AccessLevel {
  return o.restricted ? 'restricted' : o.isPrivate ? 'list' : 'all';
}

/**
 * PATCH bodies that move an object from one level to another, in order: `restricted` needs a
 * private object (422 restricted) and a restricted one cannot go public (422 isPrivate), so
 * «all → restricted» makes it private first and «restricted → all» lifts `restricted` first.
 */
export function accessSteps(from: AccessLevel, to: AccessLevel): Array<{ isPrivate?: boolean; restricted?: boolean }> {
  if (from === to) return [];
  const steps: Array<{ isPrivate?: boolean; restricted?: boolean }> = [];
  if (from === 'restricted') steps.push({ restricted: false });
  if (from === 'all') steps.push({ isPrivate: true });
  if (to === 'all') steps.push({ isPrivate: false });
  if (to === 'restricted') steps.push({ restricted: true });
  return steps;
}

/**
 * Invitations (ADR-0043) — separate bits, not implied by MANAGE_WORKSPACE / MANAGE_ROOM; guests
 * never (the server refuses them regardless of overrides).
 * - workspace INVITE_MEMBERS: invite links, e-mail invitations, the «Приглашения» tab;
 * - room INVITE_MEMBERS: members-only links of that room (the member picker of «Пригласить»);
 * - workspace / room INVITE_GUESTS: guest links of a room, their approval, admitting knocks.
 */
export function mayInviteMembers(roles: readonly RoleBits[] | undefined): boolean {
  return !isGuestOnly(roles) && can(workspacePerms(roles), 'INVITE_MEMBERS');
}

export function mayInviteGuests(roles: readonly RoleBits[] | undefined): boolean {
  return !isGuestOnly(roles) && can(workspacePerms(roles), 'INVITE_GUESTS');
}

export function mayInviteMembersIn(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return roomInviteAllowed(roles, userId, room, 'INVITE_MEMBERS');
}

export function mayInviteGuestsIn(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return roomInviteAllowed(roles, userId, room, 'INVITE_GUESTS');
}

/**
 * Temporary rooms (ADR-0044): «+» → «Временная комната» — workspace CREATE_TEMP_ROOMS (members by
 * default); guests never.
 */
export function mayCreateTempRooms(roles: readonly RoleBits[] | undefined): boolean {
  return !isGuestOnly(roles) && can(workspacePerms(roles), 'CREATE_TEMP_ROOMS');
}

/**
 * Managing a room (settings, link, extend, delete): MANAGE_ROOM in it, or — a temporary room — its
 * creator (ADR-0044 «Контракт для клиента»: `expires_at && created_by == me && not a guest`). The
 * server does the same check (rooms.MayManage).
 */
export function mayManageRoom(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  if (!room) return false;
  return can(roomPerms(roles, userId, room), 'MANAGE_ROOM') || isTempCreator(roles, userId, room);
}

/** The same from already computed room bits (rows that have them). */
export function mayManageRoomWith(perms: PermissionBits, roles: readonly RoleBits[] | undefined, userId: string, room: Room): boolean {
  return can(perms, 'MANAGE_ROOM') || isTempCreator(roles, userId, room);
}

function isTempCreator(roles: readonly RoleBits[] | undefined, userId: string, room: Room): boolean {
  return !!room.expiresAt && !!userId && room.createdBy === userId && !isGuestOnly(roles);
}

/** A room invite right in already computed room bits (rows that have them): either bit. */
export function mayRoomInvite(perms: PermissionBits): boolean {
  return can(perms, 'INVITE_GUESTS') || can(perms, 'INVITE_MEMBERS');
}

/** «Пригласить» of a room: either right there (a guest link, or a members-only one). */
export function mayInviteToRoom(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return mayInviteGuestsIn(roles, userId, room) || mayInviteMembersIn(roles, userId, room);
}

function roomInviteAllowed(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined, bit: PermissionName): boolean {
  if (!room || room.type === RoomType.DM || room.type === RoomType.NOTES || room.type === RoomType.TASK) return false;
  return !isGuestOnly(roles) && can(roomPerms(roles, userId, room), bit);
}

/** The member is a guest of the workspace (highest built-in role GUEST: no member / admin role). */
function isGuestOnly(roles: readonly RoleBits[] | undefined): boolean {
  if (!roles) return true;
  const member = (r: RoleBits): boolean =>
    r.builtin === WorkspaceRole.MEMBER || r.builtin === WorkspaceRole.ADMIN || r.builtin === WorkspaceRole.OWNER;
  return roles.some((r) => r.builtin === WorkspaceRole.GUEST) && !roles.some(member);
}

const voiceRank = (r: WorkspaceRole | undefined): number => (r === WorkspaceRole.OWNER ? 3 : r === WorkspaceRole.ADMIN ? 2 : 1);

/**
 * Voice moderation hierarchy (server rtc.outranks): mute, disconnect, stop a stream / camera of
 * another member only below the owner / admins by built-in role — the owner is untouchable,
 * an admin is moderated by the owner only; members and guests by anyone with the bit. Oneself: yes.
 */
export function mayModerateVoice(myRole: WorkspaceRole | undefined, targetRole: WorkspaceRole | undefined, self: boolean): boolean {
  if (self) return true;
  const t = voiceRank(targetRole);
  return t < 2 || voiceRank(myRole) > t;
}

/**
 * Move hierarchy (server rtc.mayMove, docs/09 #54): an admin / the owner moves anyone, other
 * admins and the owner included; anyone else with MOVE_MEMBERS as mayModerateVoice.
 */
export function mayMoveVoice(myRole: WorkspaceRole | undefined, targetRole: WorkspaceRole | undefined, self: boolean): boolean {
  return voiceRank(myRole) >= 2 || mayModerateVoice(myRole, targetRole, self);
}

/** Drag a voice participant out of / into `room` (docs/09 #32): MOVE_MEMBERS in that room. */
export function mayMoveMembersIn(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return can(roomPerms(roles, userId, room), 'MOVE_MEMBERS');
}

/**
 * The call's «Демонстрация» / «Камера» gates from my rights in the room (UI only: the server
 * re-checks STREAM + a free slot in /stream/request, VIDEO + camera_limit in /camera/request).
 * Used for a move (no /join answer) and whenever my roles or the room's overrides change during
 * a call — the /join answer is not refreshed by the server.
 */
export function voiceCaps(perms: PermissionBits, room: Pick<Room, 'media'> | undefined): { canStream: boolean; canVideo: boolean } {
  return { canStream: can(perms, 'STREAM'), canVideo: can(perms, 'VIDEO') && (room?.media?.cameraLimit ?? 0) > 0 };
}

/** Pin / unpin: MANAGE_MESSAGES, or either participant of a DM / the owner of a shelf (by room type, docs/04). */
export function mayPin(perms: PermissionBits, room: Pick<Room, 'type'> | undefined): boolean {
  return can(perms, 'MANAGE_MESSAGES') || room?.type === RoomType.DM || room?.type === RoomType.NOTES;
}

/** May this author's @everyone / @here in the room notify people (MENTION_EVERYONE)? */
export function mayMentionAll(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return can(roomPerms(roles, userId, room), 'MENTION_EVERYONE');
}

export const isAdminRole = (role: WorkspaceRole | undefined): boolean =>
  role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;

// ---------------------------------------------------------------- permission editor

export type Tri = 'allow' | 'deny' | 'inherit';

export interface OverrideDraft {
  targetType: PermissionTargetType;
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export function triOf(o: Pick<OverrideDraft, 'allow' | 'deny'> | undefined, bit: bigint): Tri {
  if (!o) return 'inherit';
  if (o.allow & bit) return 'allow';
  if (o.deny & bit) return 'deny';
  return 'inherit';
}

export function withTri<T extends Pick<OverrideDraft, 'allow' | 'deny'>>(o: T, bit: bigint, v: Tri): T {
  const allow = v === 'allow' ? o.allow | bit : o.allow & ~bit;
  const deny = v === 'deny' ? o.deny | bit : o.deny & ~bit;
  return { ...o, allow, deny };
}

/** Next state when clicking a tri-state cell: inherit → allow → deny → inherit. */
export function cycleTri(v: Tri): Tri {
  return v === 'inherit' ? 'allow' : v === 'allow' ? 'deny' : 'inherit';
}

export function toDrafts(list: readonly RoomPermissionOverride[]): OverrideDraft[] {
  return list.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny }));
}

/** Drops empty overrides before PUT /api/rooms/{id}/permissions. */
export function compactDrafts(list: readonly OverrideDraft[]): OverrideDraft[] {
  return list.filter((o) => o.allow !== 0n || o.deny !== 0n);
}

/** Permission bits editable per room (workspace-level ones make no sense on a room). */
export const ROOM_EDITABLE: PermissionName[] = [
  'VIEW_ROOM',
  'SEND_MESSAGES',
  'ATTACH_FILES',
  'MANAGE_MESSAGES',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'VIDEO',
  'MUTE_MEMBERS',
  'MOVE_MEMBERS',
  'MENTION_EVERYONE',
  'MANAGE_ROOM',
  'INVITE_MEMBERS',
  'INVITE_GUESTS',
  // ADR-0046: who may call phone numbers from this room.
  'PLACE_CALLS',
];
