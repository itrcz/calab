import {
  PresenceStatus,
  RoomType,
  WorkspaceRole,
  type Presence,
  type Role,
  type RoleBits,
  type Room,
  type VoiceState,
  type WorkspaceMember,
} from '@calaba/protocol';
import { getLocale } from '../../i18n';
import { can, mayManageMembers, mayModerateVoice, mayMoveVoice, roomPerms, workspacePerms } from '../../lib/permissions';
import { canAssignRole, legacyRoles, roleActor, rolesOfMember, topRole } from '../../lib/roles';

/*
 * Pure people logic (members column grouping, member context-menu availability). The client
 * only hides UI: the server re-checks every action (CLAUDE.md).
 */

export const isOnline = (s: PresenceStatus | undefined): boolean =>
  s === PresenceStatus.ONLINE || s === PresenceStatus.IDLE || s === PresenceStatus.DND;

/** Display order of roles: owner, admins, members, guests. */
export function roleRank(r: WorkspaceRole): number {
  switch (r) {
    case WorkspaceRole.OWNER:
      return 0;
    case WorkspaceRole.ADMIN:
      return 1;
    case WorkspaceRole.GUEST:
      return 3;
    default:
      return 2;
  }
}

export const nameOf = (m: WorkspaceMember): string => m.nickname || m.user?.displayName || '';

export interface MemberGroups {
  online: WorkspaceMember[];
  offline: WorkspaceMember[];
  /** Bots (ADR-0031 §7): a section of their own, by name — never «в сети» / «не в сети». */
  bots: WorkspaceMember[];
}

/**
 * «В сети» / «Не в сети» (docs/09 #12), each sorted by role (owner → admins → members →
 * guests), then name. Someone in voice counts as online even if their presence lags. Bots go
 * to «Боты» (like Discord's apps).
 */
export function groupMembers(
  members: readonly WorkspaceMember[],
  presences: Readonly<Record<string, Presence | undefined>>,
  voice: Readonly<Record<string, VoiceState | undefined>> = {},
): MemberGroups {
  const all = members.filter((m) => m.user);
  const byName = (a: WorkspaceMember, b: WorkspaceMember): number => nameOf(a).localeCompare(nameOf(b), getLocale());
  const bots = all.filter((m) => m.user?.isBot).sort(byName);
  const list = all.filter((m) => !m.user?.isBot);
  list.sort((a, b) => roleRank(a.role) - roleRank(b.role) || byName(a, b));
  const on = (m: WorkspaceMember): boolean => {
    const id = m.user?.id ?? '';
    return isOnline(presences[id]?.status) || !!voice[id]?.roomId;
  };
  return { online: list.filter(on), offline: list.filter((m) => !on(m)), bots };
}

// ---------------------------------------------------------------- context menu

export interface MenuContext {
  meId: string;
  /** My built-in role (WorkspaceSnapshot.role). */
  myRole: WorkspaceRole | undefined;
  /** My role_ids (ADR-0026); empty = the built-ins implied by `myRole`. */
  myRoleIds?: readonly string[];
  /** All roles of the workspace, highest first (default: the four built-ins). */
  roles?: readonly Role[];
  target: WorkspaceMember;
  /** Target's aggregated voice state in this workspace (room_id set = in voice). */
  targetVoice: VoiceState | undefined;
  /** LiveKit room I am connected to (volume is per remote participant of my room). */
  myVoiceRoomId: string | null;
  /** Rooms of the workspace visible to me. */
  rooms: readonly Room[];
  allowSelfNickname: boolean;
}

export interface MenuActions {
  /** Per-user volume: they are in my voice room. */
  volume: boolean;
  /** «Заглушить» for me only: anyone but me (stored; applies whenever we share a call, docs/09 #20). */
  localMute: boolean;
  serverMute: boolean;
  /** Already server/self-muted: the item is shown disabled. */
  alreadyMuted: boolean;
  /** «Включить микрофон»: the member is muted by a moderator (VoiceState.server_muted). */
  serverUnmute: boolean;
  disconnect: boolean;
  /** «Не показывать видео»: the target's camera is on in my voice room. */
  hideVideo: boolean;
  /** Moderator «Выключить камеру» (MUTE_MEMBERS in the room; VoiceState.camera). */
  stopCamera: boolean;
  /** Voice rooms the target can be moved to (empty = no «Переместить в…»). */
  moveTargets: Room[];
  rename: boolean;
  /** «Изменить день рождения» in the profile (docs/09 #77): canEditMemberBirthday. Not a menu item. */
  birthday: boolean;
  /**
   * «Роли ›» (ADR-0026): a checkbox per role I may give or take (docs/04 «Назначение»), plus the
   * target's roles I may not touch (shown checked, disabled); null = no submenu.
   */
  roles: RoleToggle[] | null;
  /** «Вручить ачивку…» (ADR-0061): canGrantAchievement. */
  grantAchievement: boolean;
  promote: boolean;
  removeGuest: boolean;
  kick: boolean;
  /** «Забанить…» (docs/09 #32): who may be kicked may be banned, guests included. */
  ban: boolean;
}

export interface RoleToggle {
  role: Role;
  /** The target holds it. */
  on: boolean;
  /** I may change it. */
  enabled: boolean;
}

/**
 * The role checkboxes for a member (menu «Роли ›», profile chips): every role but the built-in
 * owner / member / guest (they follow the member itself), highest first; null when I may change
 * none of them.
 */
export function roleToggles(all: readonly Role[], myRoles: readonly Role[], targetRoles: readonly Role[], self: boolean, targetGuest: boolean): RoleToggle[] | null {
  const actor = roleActor(myRoles);
  const held = new Set(targetRoles.map((r) => r.id));
  const targetTop = topRole(targetRoles)?.position ?? -1;
  const out: RoleToggle[] = [];
  for (const role of all) {
    if (role.builtin === WorkspaceRole.OWNER || role.builtin === WorkspaceRole.MEMBER || role.builtin === WorkspaceRole.GUEST) continue;
    const on = held.has(role.id);
    // A guest becomes an admin only through «Сделать участником» first.
    const enabled = canAssignRole(actor, role, targetTop, self) && !(targetGuest && role.builtin === WorkspaceRole.ADMIN);
    if (enabled || on) out.push({ role, on, enabled });
  }
  return out.some((x) => x.enabled) ? out : null;
}

/**
 * May I change this member's workspace nickname (docs/09 #33, #26)? Others' — MANAGE_NICKNAMES;
 * my own — also when the workspace allows self nicknames. The server re-checks.
 */
export function canRenameMember(myRoles: readonly RoleBits[] | undefined, self: boolean, allowSelfNickname: boolean): boolean {
  const ws = workspacePerms(myRoles);
  return self ? allowSelfNickname || can(ws, 'MANAGE_NICKNAMES') : can(ws, 'MANAGE_NICKNAMES');
}

/**
 * Kick / ban / change the built-in role of a member (server workspaces.outranks + removeMember):
 * MANAGE_MEMBERS (ADR-0048; guests never), never the owner, an admin only by the owner, and — ADR-0026 hierarchy — only
 * members whose most senior role is below mine (the owner: anyone). Not oneself.
 */
export function canRemoveMember(myRoles: readonly Role[], targetRoles: readonly Role[], target: Pick<WorkspaceMember, 'role'>, self: boolean): boolean {
  const actor = roleActor(myRoles);
  if (self || !mayManageMembers(myRoles) || target.role === WorkspaceRole.OWNER) return false;
  if (target.role === WorkspaceRole.ADMIN && !actor.owner) return false;
  return actor.owner || (topRole(targetRoles)?.position ?? -1) < actor.top;
}

/**
 * «Изменить день рождения» of another member (docs/09 #77, server workspaces.setMemberBirthday):
 * MANAGE_NICKNAMES and the kick hierarchy — the owner reaches anyone, everyone else only members
 * whose most senior role is below theirs (so never the owner, an admin only by the owner). Bots
 * and guests have no birthday; my own is set in the profile settings.
 */
export function canEditMemberBirthday(
  myRoles: readonly Role[],
  targetRoles: readonly Role[],
  target: Pick<WorkspaceMember, 'role' | 'user'>,
  self: boolean,
): boolean {
  const actor = roleActor(myRoles);
  if (self || !can(actor.perms, 'MANAGE_NICKNAMES') || target.role === WorkspaceRole.GUEST || target.user?.isBot || target.user?.isGuest) return false;
  return actor.owner || (topRole(targetRoles)?.position ?? -1) < actor.top;
}

/**
 * «Бейдж» of a member (docs/09 #82, server workspaces.setMemberBadge): MANAGE_NICKNAMES; my own,
 * or a member whose most senior role is below mine (the owner: anyone). Bots have none.
 */
export function canSetMemberBadge(myRoles: readonly Role[], targetRoles: readonly Role[], target: Pick<WorkspaceMember, 'user'>, self: boolean): boolean {
  const actor = roleActor(myRoles);
  if (!can(actor.perms, 'MANAGE_NICKNAMES') || target.user?.isBot) return false;
  return self || actor.owner || (topRole(targetRoles)?.position ?? -1) < actor.top;
}

/**
 * «Вручить ачивку…» (ADR-0061 §3, server achievements.grant): MANAGE_MEMBERS; the recipient is a
 * member — not a guest, not a bot — and not me (422 SELF_GRANT).
 */
export function canGrantAchievement(myRoles: readonly RoleBits[] | undefined, target: Pick<WorkspaceMember, 'role' | 'user'>, self: boolean): boolean {
  if (self || !mayManageMembers(myRoles)) return false;
  return target.role !== WorkspaceRole.GUEST && !target.user?.isGuest && !target.user?.isBot;
}

export function memberActions(c: MenuContext): MenuActions {
  const userId = c.target.user?.id ?? '';
  const self = userId === c.meId;
  const all = c.roles ?? legacyRoles('');
  const myRoles = rolesOfMember(all, c.myRole === undefined ? undefined : { role: c.myRole, roleIds: c.myRoleIds ?? [] });
  const targetRoles = rolesOfMember(all, c.target);
  const ws = workspacePerms(myRoles);
  const inRoom = c.targetVoice?.roomId ? c.rooms.find((r) => r.id === c.targetVoice?.roomId) : undefined;
  const permsIn = (r: Room): bigint => roomPerms(myRoles, c.meId, r);
  // Voice moderation hierarchy (server rtc.outranks): not the owner, admins only by the owner.
  const outranks = mayModerateVoice(c.myRole, c.target.role, self);
  // Disconnect / stop-stream honour the room override; server mute needs MUTE_MEMBERS at the
  // workspace level (owner/admin) — a room grant cannot silence someone everywhere.
  const moderate = !self && !!inRoom && outranks && can(permsIn(inRoom), 'MUTE_MEMBERS');
  const muteAll = moderate && can(ws, 'MUTE_MEMBERS');
  // Moving is not a sanction: an admin moves admins and the owner too (server rtc.mayMove).
  const canMoveFrom = !self && !!inRoom && mayMoveVoice(c.myRole, c.target.role, self) && can(permsIn(inRoom), 'MOVE_MEMBERS');
  // Targets: MOVE_MEMBERS there for me, VIEW_ROOM + CONNECT there for them (server moveMember).
  const moveTargets = canMoveFrom
    ? c.rooms.filter(
        (r) =>
          r.type === RoomType.VOICE &&
          r.id !== inRoom.id &&
          can(permsIn(r), 'MOVE_MEMBERS') &&
          can(roomPerms(targetRoles, userId, r), 'CONNECT'),
      )
    : [];
  // «Сделать участником» (guest → member): MANAGE_MEMBERS (ADR-0048).
  const manage = mayManageMembers(myRoles);
  const guest = c.target.role === WorkspaceRole.GUEST;
  const removable = canRemoveMember(myRoles, targetRoles, c.target, self);
  return {
    volume: !self && !!c.myVoiceRoomId && c.targetVoice?.roomId === c.myVoiceRoomId,
    localMute: !self,
    serverMute: muteAll,
    alreadyMuted: !!c.targetVoice?.serverMuted,
    serverUnmute: muteAll && !!c.targetVoice?.serverMuted,
    disconnect: moderate,
    hideVideo: !self && !!c.myVoiceRoomId && c.targetVoice?.roomId === c.myVoiceRoomId && c.targetVoice.camera,
    stopCamera: moderate && !!c.targetVoice?.camera,
    moveTargets,
    rename: canRenameMember(myRoles, self, c.allowSelfNickname),
    birthday: canEditMemberBirthday(myRoles, targetRoles, c.target, self),
    roles: roleToggles(all, myRoles, targetRoles, self, guest),
    grantAchievement: canGrantAchievement(myRoles, c.target, self),
    promote: manage && guest && !self,
    removeGuest: removable && guest,
    kick: removable && !guest,
    ban: removable,
  };
}

export function hasAnyAction(a: MenuActions): boolean {
  return a.volume || a.serverMute || a.disconnect || a.hideVideo || a.stopCamera || a.roles !== null || a.grantAchievement || a.moveTargets.length > 0 || a.rename || a.promote || a.removeGuest || a.kick || a.ban;
}
