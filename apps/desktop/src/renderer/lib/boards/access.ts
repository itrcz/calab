import { computeMemberBoardPermissions, taskPermissions, Permission, WorkspaceRole, type Board, type Role, type Task, type WorkspaceMember } from '@calaba/protocol';
import { t } from '../../i18n';
import { rolesOfMember } from '../roles';

/**
 * Task-scoped access (ADR-0059 §5, ADR-0076). A board the viewer sees only through cards (assignee,
 * approver or watcher) arrives with `permissions = 0n` and `taskScoped = true`: zero bits do NOT mean hidden.
 */
export function boardVisible(b: Pick<Board, 'permissions' | 'taskScoped' | 'archivedAt'> | undefined): boolean {
  if (!b || b.archivedAt) return false;
  return b.permissions !== 0n || b.taskScoped;
}

/**
 * The viewer's bits on one task: the single helper behind the task panel, the card menus, the
 * hotkeys and the bulk actions (a viewer of the board keeps the board's bits; a scoped viewer gets
 * assignee / approver / watcher bits of the card, taskPermissions in @calaba/protocol).
 */
export function taskBits(board: Pick<Board, 'permissions' | 'taskScoped'> | undefined, task: Pick<Task, 'assignees' | 'approvers' | 'watcherIds' | 'archivedAt'>, me: string): bigint {
  return board ? taskPermissions(board, task, me) : 0n;
}

/** The viewer sees the board only through their cards: no creating, no board settings, no view editing, no bulk. */
export const boardScoped = (b: Pick<Board, 'taskScoped'> | undefined): boolean => !!b?.taskScoped;

const VIEW_BOARD = BigInt(Permission.VIEW_BOARD);
const MANAGE_BOARD = BigInt(Permission.MANAGE_BOARD);

/**
 * How the assignee / approver / watcher pickers treat a member (ADR-0059 §5, ADR-0076 §7):
 * `hidden` (guest, or a bot that does not see the board), `ok` (sees the board), `card` (does not
 * see it: gets only this task, caption «увидит только эту задачу» — restricted boards too).
 */
export type PickerAccess = 'hidden' | 'ok' | 'card';

export function pickerAccess(
  board: Pick<Board, 'permissionOverrides' | 'isPrivate' | 'restricted' | 'permissions'> | undefined,
  roles: readonly Role[],
  m: Pick<WorkspaceMember, 'role' | 'roleIds' | 'user'>,
): PickerAccess {
  if (m.role === WorkspaceRole.GUEST) return 'hidden';
  // The server sends permissionOverrides only to viewers with MANAGE_BOARD: without them nobody's
  // access is known, so no guessing (no captions, nothing disabled; the server validates, 422 → toast).
  if (!board || (board.permissions & MANAGE_BOARD) === 0n) return 'ok';
  const sees = (computeMemberBoardPermissions(rolesOfMember(roles, m), m.user?.id ?? '', board.permissionOverrides, board.isPrivate, false, board.restricted) & VIEW_BOARD) !== 0n;
  if (sees) return 'ok';
  return m.user?.isBot ? 'hidden' : 'card';
}

/** The picker row's caption for a member's access (ADR-0059 §5, ADR-0076 §7). */
export function accessChoice(a: PickerAccess | undefined): { caption?: string; title?: string } {
  return a === 'card' ? { caption: t('boards.cardOnly'), title: t('boards.cardOnlyHint') } : {};
}
