import { computeMemberBoardPermissions, taskPermissions, Permission, WorkspaceRole, type Board, type Role, type Task, type WorkspaceMember } from '@calaba/protocol';
import { t } from '../../i18n';
import { rolesOfMember } from '../roles';

/**
 * Task-scoped access (ADR-0059 §5). A board the viewer sees only through cards (assignee or
 * approver) arrives with `permissions = 0n` and `taskScoped = true`: zero bits do NOT mean hidden.
 */
export function boardVisible(b: Pick<Board, 'permissions' | 'taskScoped' | 'archivedAt'> | undefined): boolean {
  if (!b || b.archivedAt) return false;
  return b.permissions !== 0n || b.taskScoped;
}

/**
 * The viewer's bits on one task: the single helper behind the task panel, the card menus, the
 * hotkeys and the bulk actions (a viewer of the board keeps the board's bits; a scoped viewer gets
 * assignee / approver bits of the card, taskPermissions in @calaba/protocol).
 */
export function taskBits(board: Pick<Board, 'permissions' | 'taskScoped'> | undefined, task: Pick<Task, 'assignees' | 'approvers' | 'archivedAt'>, me: string): bigint {
  return board ? taskPermissions(board, task, me) : 0n;
}

/** The viewer sees the board only through their cards: no creating, no board settings, no view editing, no bulk. */
export const boardScoped = (b: Pick<Board, 'taskScoped'> | undefined): boolean => !!b?.taskScoped;

const VIEW_BOARD = BigInt(Permission.VIEW_BOARD);

/**
 * How the assignee / approver pickers treat a member (ADR-0059 §5): `hidden` (guest, or a bot
 * that does not see the board), `ok` (sees the board), `card` (does not see it: gets only this
 * card, caption «увидит только эту карточку»), `closed` (does not see a `restricted` board:
 * disabled, «закрытая доска»).
 */
export type PickerAccess = 'hidden' | 'ok' | 'card' | 'closed';

export function pickerAccess(
  board: Pick<Board, 'permissionOverrides' | 'isPrivate' | 'restricted'> | undefined,
  roles: readonly Role[],
  m: Pick<WorkspaceMember, 'role' | 'roleIds' | 'user'>,
): PickerAccess {
  if (m.role === WorkspaceRole.GUEST) return 'hidden';
  // Without the board (not loaded) nothing is known: behave as before ADR-0059.
  const sees = !board || (computeMemberBoardPermissions(rolesOfMember(roles, m), m.user?.id ?? '', board.permissionOverrides, board.isPrivate, false, board.restricted) & VIEW_BOARD) !== 0n;
  if (sees) return 'ok';
  if (m.user?.isBot) return 'hidden';
  return board.restricted ? 'closed' : 'card';
}

/** The picker row's caption / disabled state for a member's access (ADR-0059 §5). */
export function accessChoice(a: PickerAccess | undefined, chosen: boolean): { caption?: string; title?: string; disabled?: true } {
  if (a === 'card') return { caption: t('boards.cardOnly'), title: t('boards.cardOnlyHint') };
  if (a === 'closed' && !chosen) return { disabled: true, caption: t('boards.closedBoard'), title: t('boards.closedBoard') };
  return {};
}
