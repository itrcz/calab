import {
  RoomType,
  WorkspaceRole,
  computeMemberBoardPermissions,
  computeMemberRoomPermissions,
  tempRoomScope,
  type Board,
  type PermissionBits,
  type Role,
  type RoleBits,
  type Room,
} from '@calaba/protocol';
import { can, settingsAccess, workspacePerms } from './permissions';

/*
 * «Что увидит участник с этой ролью» (ADR-0048 §3, docs/08 «Роли»): what a member holding a role
 * gets, computed with the same computePermissions as everything else. A custom role is previewed
 * together with «Участник» (every member has it), without personal overrides; rooms and boards
 * count through their overrides, so a closed one shows only when it lists this role.
 */

/**
 * The role set to preview `role` with `bits` (a draft): the member role + it for a custom role;
 * the built-in member / guest role alone. Null for owner / admin (full access, nothing to show).
 */
export function previewRoles(
  all: readonly Role[],
  role: Pick<Role, 'id' | 'position' | 'builtin'>,
  bits: PermissionBits,
): RoleBits[] | null {
  if (role.builtin === WorkspaceRole.OWNER || role.builtin === WorkspaceRole.ADMIN) return null;
  const self: RoleBits = { id: role.id, position: role.position, permissions: bits, builtin: role.builtin };
  if (role.builtin !== WorkspaceRole.UNSPECIFIED) return [self];
  const member = all.find((r) => r.builtin === WorkspaceRole.MEMBER);
  return member ? [member, self] : [self];
}

const listedRoom = (r: Room, wsId: string): boolean =>
  r.workspaceId === wsId && !r.archivedAt && r.type !== RoomType.DM && r.type !== RoomType.NOTES && r.type !== RoomType.TASK;

/**
 * «n/total» rooms of the workspace (those I know) the roles would see — a primitive, so a store
 * selector returning it re-renders the preview only when a count changes.
 */
export function visibleRooms(rooms: Readonly<Record<string, Room>>, wsId: string, roles: readonly RoleBits[]): string {
  let n = 0;
  let total = 0;
  for (const r of Object.values(rooms)) {
    if (!listedRoom(r, wsId)) continue;
    total++;
    if (can(computeMemberRoomPermissions(roles, '', r.permissionOverrides, r.restricted, false, tempRoomScope(r)), 'VIEW_ROOM')) n++;
  }
  return `${n}/${total}`;
}

/** The same for the workspace's live boards; a guest sees none (ADR-0042). */
export function visibleBoards(boards: Readonly<Record<string, Board>>, wsId: string, roles: readonly RoleBits[], guest: boolean): string {
  let n = 0;
  let total = 0;
  for (const b of Object.values(boards)) {
    if (b.workspaceId !== wsId || b.archivedAt) continue;
    total++;
    if (can(computeMemberBoardPermissions(roles, '', b.permissionOverrides, b.isPrivate, guest, b.restricted, false), 'VIEW_BOARD')) n++;
  }
  return `${n}/${total}`;
}

export type PreviewItemId =
  | 'rooms'
  | 'voice'
  | 'tempRooms'
  | 'calendar'
  | 'events'
  | 'boards'
  | 'createBoards'
  | 'tabWorkspace'
  | 'tabMembers'
  | 'tabInvites'
  | 'tabRoles'
  | 'tabStickers'
  | 'tabBots'
  | 'tabIntegrations'
  | 'tabJournals'
  | 'tabRecordings';

export interface PreviewItem {
  id: PreviewItemId;
  on: boolean;
  /** A settings tab / right (the «Настройки пространства» part of the list). */
  settings: boolean;
}

/**
 * The sections and rights that appear for `roles` (workspace scope). `rooms` / `boards` — whether
 * any is visible (the counts come from visibleRooms / visibleBoards). Guests: no calendar, boards,
 * temporary rooms or settings rights (the server's rules).
 */
export function rolePreview(roles: readonly RoleBits[], guest: boolean, counts: { rooms: string; boards: string }): PreviewItem[] {
  const ws = workspacePerms(roles);
  const tabs = settingsAccess(roles);
  // Any visible; nothing loaded to count (`n/0`, e.g. boards never opened) — the workspace bit.
  const seen = (c: string, bit: 'VIEW_ROOM' | 'VIEW_BOARD'): boolean => (c.endsWith('/0') ? can(ws, bit) : !c.startsWith('0/'));
  const item = (id: PreviewItemId, on: boolean, settings = false): PreviewItem => ({ id, on, settings });
  const member = !guest;
  return [
    item('rooms', seen(counts.rooms, 'VIEW_ROOM')),
    item('voice', can(ws, 'CONNECT')),
    item('tempRooms', member && can(ws, 'CREATE_TEMP_ROOMS')),
    item('calendar', member),
    item('events', member && can(ws, 'MANAGE_EVENTS')),
    item('boards', member && seen(counts.boards, 'VIEW_BOARD')),
    item('createBoards', member && can(ws, 'CREATE_BOARDS')),
    item('tabWorkspace', tabs.workspace, true),
    item('tabMembers', tabs.members, true),
    item('tabInvites', tabs.invites, true),
    item('tabRoles', tabs.roles, true),
    item('tabStickers', tabs.stickers, true),
    item('tabBots', tabs.bots, true),
    item('tabIntegrations', tabs.integrations, true),
    item('tabJournals', member && can(ws, 'VIEW_JOURNALS'), true),
    item('tabRecordings', member && can(ws, 'MANAGE_RECORDINGS'), true),
  ];
}
