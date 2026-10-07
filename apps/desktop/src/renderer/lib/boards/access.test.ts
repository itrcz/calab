import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { PERMISSION_BITS, TaskApproverSchema, TaskAssigneeSchema, TaskSchema, UserSchema, WorkspaceMemberSchema, WorkspaceRole, BoardSchema, type Board, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { legacyRoles } from '../roles';
import { accessChoice, boardScoped, boardVisible, pickerAccess, taskBits } from './access';

// ADR-0059 §2 / §5, ADR-0076: the client mirrors taskPermissions; the picker follows computeMemberBoardPermissions.
const VIEW = PERMISSION_BITS.VIEW_BOARD;
const CREATE = PERMISSION_BITS.CREATE_TASKS;
const EDIT = PERMISSION_BITS.EDIT_TASKS;

const board = (p: Partial<Pick<Board, 'permissions' | 'taskScoped' | 'archivedAt' | 'isPrivate' | 'restricted'>> = {}): Board => create(BoardSchema, { id: 'b', ...p });
const task = (p: { assignees?: string[]; approvers?: string[]; watchers?: string[]; archived?: boolean } = {}): Task =>
  create(TaskSchema, {
    id: 't',
    assignees: (p.assignees ?? []).map((userId) => create(TaskAssigneeSchema, { userId })),
    approvers: (p.approvers ?? []).map((userId) => create(TaskApproverSchema, { userId })),
    watcherIds: p.watchers ?? [],
    ...(p.archived ? { archivedAt: timestampFromMs(1000) } : {}),
  });

describe('boardVisible', () => {
  it.each([
    ['a full viewer', board({ permissions: VIEW | CREATE }), true],
    ['a scoped viewer (permissions 0, taskScoped)', board({ permissions: 0n, taskScoped: true }), true],
    ['no bits, not scoped', board({ permissions: 0n }), false],
    ['archived', board({ permissions: VIEW, archivedAt: timestampFromMs(1000) }), false],
    ['archived and scoped', board({ taskScoped: true, archivedAt: timestampFromMs(1000) }), false],
  ])('%s', (_, b, want) => expect(boardVisible(b)).toBe(want));

  it('an unknown board is not visible', () => expect(boardVisible(undefined)).toBe(false));
  it('boardScoped follows Board.taskScoped', () => {
    expect(boardScoped(board({ taskScoped: true }))).toBe(true);
    expect(boardScoped(board())).toBe(false);
    expect(boardScoped(undefined)).toBe(false);
  });
});

describe('taskBits (the table of taskPermissions)', () => {
  const me = 'me';
  it('a board viewer keeps the board bits whatever the task', () => {
    const b = board({ permissions: VIEW | EDIT });
    expect(taskBits(b, task(), me)).toBe(VIEW | EDIT);
    expect(taskBits(b, task({ approvers: [me] }), me)).toBe(VIEW | EDIT);
  });
  it('a scoped assignee: VIEW_BOARD | CREATE_TASKS', () => {
    expect(taskBits(board({ taskScoped: true }), task({ assignees: [me] }), me)).toBe(VIEW | CREATE);
  });
  it('a scoped approver: VIEW_BOARD only', () => {
    expect(taskBits(board({ taskScoped: true }), task({ approvers: [me] }), me)).toBe(VIEW);
  });
  it('a scoped watcher: VIEW_BOARD only (ADR-0076)', () => {
    expect(taskBits(board({ taskScoped: true }), task({ watchers: ['other', me] }), me)).toBe(VIEW);
    expect(taskBits(board({ taskScoped: true }), task({ watchers: [me], archived: true }), me)).toBe(0n);
    expect(taskBits(board(), task({ watchers: [me] }), me)).toBe(0n);
  });
  it('an assignee wins over an approver role on the same card', () => {
    expect(taskBits(board({ taskScoped: true }), task({ assignees: [me], approvers: [me] }), me)).toBe(VIEW | CREATE);
  });
  it('a scoped viewer on a card he is not invited to, or an archived one: nothing', () => {
    expect(taskBits(board({ taskScoped: true }), task({ assignees: ['other'] }), me)).toBe(0n);
    expect(taskBits(board({ taskScoped: true }), task({ assignees: [me], archived: true }), me)).toBe(0n);
  });
  it('no bits and not scoped: nothing; an unknown board: nothing', () => {
    expect(taskBits(board(), task({ assignees: [me] }), me)).toBe(0n);
    expect(taskBits(undefined, task({ assignees: [me] }), me)).toBe(0n);
  });
});

describe('pickerAccess / accessChoice (the assignee and approver pickers)', () => {
  const roles = legacyRoles('w');
  const member = (role: WorkspaceRole, isBot = false) => create(WorkspaceMemberSchema, { role, user: create(UserSchema, { id: 'u', isBot }) });
  const MANAGE = PERMISSION_BITS.MANAGE_BOARD;
  // The viewer holds MANAGE_BOARD, so the board carries permissionOverrides.
  const publicBoard = board({ permissions: VIEW | MANAGE });
  const privateBoard = board({ permissions: VIEW | MANAGE, isPrivate: true });
  const closedBoard = board({ permissions: VIEW | MANAGE, isPrivate: true, restricted: true });

  it('a member who sees the board: plain row', () => {
    expect(pickerAccess(publicBoard, roles, member(WorkspaceRole.MEMBER))).toBe('ok');
    expect(accessChoice('ok')).toEqual({});
  });
  it('a member without VIEW_BOARD on a private board: «увидит только эту задачу»', () => {
    const a = pickerAccess(privateBoard, roles, member(WorkspaceRole.MEMBER));
    expect(a).toBe('card');
    expect(accessChoice(a).caption).toBeTruthy();
    expect(accessChoice(a).title).toBeTruthy();
  });
  it('a restricted board opens by card too (ADR-0076): the same caption, nothing disabled', () => {
    const a = pickerAccess(closedBoard, roles, member(WorkspaceRole.MEMBER));
    expect(a).toBe('card');
    expect(accessChoice(a)).toEqual(accessChoice('card'));
    expect(pickerAccess(closedBoard, roles, member(WorkspaceRole.MEMBER, true))).toBe('hidden');
  });
  it('the owner sees a restricted board', () => {
    expect(pickerAccess(closedBoard, roles, member(WorkspaceRole.OWNER))).toBe('ok');
  });
  it('guests are never listed; a bot only when it sees the board', () => {
    expect(pickerAccess(publicBoard, roles, member(WorkspaceRole.GUEST))).toBe('hidden');
    expect(pickerAccess(publicBoard, roles, member(WorkspaceRole.MEMBER, true))).toBe('ok');
    expect(pickerAccess(privateBoard, roles, member(WorkspaceRole.MEMBER, true))).toBe('hidden');
  });
  it('an unknown board changes nothing (the pre-ADR-0059 list)', () => {
    expect(pickerAccess(undefined, roles, member(WorkspaceRole.MEMBER))).toBe('ok');
  });
  it('without MANAGE_BOARD (no permissionOverrides sent) nothing is guessed: no caption, nothing disabled', () => {
    for (const b of [board({ permissions: VIEW, isPrivate: true }), board({ permissions: VIEW, isPrivate: true, restricted: true }), board({ permissions: 0n, taskScoped: true, isPrivate: true })]) {
      expect(pickerAccess(b, roles, member(WorkspaceRole.MEMBER))).toBe('ok');
    }
    expect(pickerAccess(board({ permissions: VIEW }), roles, member(WorkspaceRole.GUEST))).toBe('hidden');
  });
});
