import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ApproverState, BoardFeature, BoardStatusSchema, BoardStatusType, TaskApprovalState, TaskApproverSchema, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { approvalBadge, approvalsWouldReset, decidedApprovers, approvalControls, blockedStatusIds, clampRequired, mayMoveTo, quorumChoices, quorumOf, toggleApprover, MAX_APPROVERS } from './approvals';

// ADR-0049 «Контракт для клиента»: the gate mirrors the server's checkApprovalGate.
const st = (id: string, position: number, type = BoardStatusType.UNSTARTED) => create(BoardStatusSchema, { id, position, type });
const backlog = st('backlog', 0, BoardStatusType.BACKLOG);
const todo = st('todo', 1);
const doing = st('doing', 2, BoardStatusType.STARTED);
const done = st('done', 3, BoardStatusType.COMPLETED);
const cancelled = st('cancelled', 4, BoardStatusType.CANCELLED);
// A completed status placed before «В работе» (positions are the board's order, not the type).
const earlyDone = st('early-done', 1, BoardStatusType.COMPLETED);
const statuses = [backlog, todo, doing, done, cancelled];

const ap = (userId: string, state: ApproverState, comment = '') => create(TaskApproverSchema, { userId, state, comment });
const task = (approvalState: TaskApprovalState, p: MessageInitShape<typeof TaskSchema> = {}): Task => create(TaskSchema, { id: 't', statusId: 'todo', approvalState, ...p });

describe('mayMoveTo (the server gate, for the UI)', () => {
  it('lets anything through without approvers or once approved', () => {
    for (const s of [TaskApprovalState.NONE, TaskApprovalState.APPROVED, TaskApprovalState.UNSPECIFIED]) {
      expect(mayMoveTo(task(s), todo, done)).toBe(true);
      expect(mayMoveTo(task(s), todo, doing)).toBe(true);
    }
  });

  it.each([TaskApprovalState.PENDING, TaskApprovalState.REJECTED])('state %i: no forward, no COMPLETED; back, same column and CANCELLED are fine', (s) => {
    const t = task(s);
    expect(mayMoveTo(t, todo, doing)).toBe(false);
    expect(mayMoveTo(t, todo, done)).toBe(false);
    expect(mayMoveTo(t, doing, earlyDone)).toBe(false); // COMPLETED even though it is «back»
    expect(mayMoveTo(t, doing, todo)).toBe(true);
    expect(mayMoveTo(t, todo, backlog)).toBe(true);
    expect(mayMoveTo(t, todo, todo)).toBe(true);
    expect(mayMoveTo(t, doing, cancelled)).toBe(true);
    expect(mayMoveTo(t, undefined, doing)).toBe(true);
  });

  it('blockedStatusIds: the dimmed columns / disabled menu rows', () => {
    expect([...blockedStatusIds(task(TaskApprovalState.PENDING, { statusId: 'todo' }), statuses)].sort()).toEqual(['doing', 'done']);
    expect(blockedStatusIds(task(TaskApprovalState.APPROVED), statuses).size).toBe(0);
  });
});

describe('quorum and the badge', () => {
  const two = [ap('a', ApproverState.APPROVED), ap('b', ApproverState.PENDING), ap('c', ApproverState.PENDING)];

  it('quorum: 0 = all, else N capped by the approvers', () => {
    expect(quorumOf({ approvers: two, approvalRequired: 0 })).toBe(3);
    expect(quorumOf({ approvers: two, approvalRequired: 2 })).toBe(2);
    expect(quorumOf({ approvers: two, approvalRequired: 7 })).toBe(3);
    expect(quorumOf({ approvers: [], approvalRequired: 0 })).toBe(0);
  });

  it('badge: ✓ 1/2 pending, ✓ approved, ✗ rejected, nothing without approvers (state read as given)', () => {
    expect(approvalBadge({ approvers: two, approvalRequired: 2, approvalState: TaskApprovalState.PENDING })).toEqual({ kind: 'pending', approved: 1, quorum: 2 });
    expect(approvalBadge({ approvers: two, approvalRequired: 1, approvalState: TaskApprovalState.APPROVED })).toEqual({ kind: 'approved' });
    expect(approvalBadge({ approvers: [ap('a', ApproverState.REJECTED, 'нет')], approvalRequired: 0, approvalState: TaskApprovalState.REJECTED })).toEqual({ kind: 'rejected' });
    expect(approvalBadge({ approvers: [], approvalRequired: 0, approvalState: TaskApprovalState.NONE })).toBeNull();
  });

  it('quorum choices and clamping keep «N из M» valid', () => {
    expect(quorumChoices(1)).toEqual([0]);
    expect(quorumChoices(3)).toEqual([0, 1, 2]);
    expect(clampRequired(2, 3)).toBe(2);
    expect(clampRequired(2, 2)).toBe(0);
    expect(clampRequired(3, 1)).toBe(0);
  });

  it('toggleApprover: add, remove, at most 10', () => {
    expect(toggleApprover(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleApprover(['a', 'b'], 'a')).toEqual(['b']);
    const full = Array.from({ length: MAX_APPROVERS }, (_, i) => `u${i}`);
    expect(toggleApprover(full, 'x')).toEqual(full);
  });
});

describe('approvalControls (permission gating of the section)', () => {
  const t = (approvers = [ap('me', ApproverState.PENDING)], archived = false): Task => create(TaskSchema, { approvers, ...(archived ? { archivedAt: timestampFromMs(1) } : {}) });

  it('an editor edits; an approver votes; others only see a section that has approvers', () => {
    expect(approvalControls(t([]), true, true, 'me')).toMatchObject({ visible: true, edit: true, vote: false });
    expect(approvalControls(t([]), false, true, 'me')).toMatchObject({ visible: false, edit: false, vote: false });
    expect(approvalControls(t(), false, true, 'me')).toMatchObject({ visible: true, edit: false, vote: true, mine: ApproverState.PENDING });
    expect(approvalControls(t([ap('x', ApproverState.APPROVED)]), false, true, 'me')).toMatchObject({ visible: true, edit: false, vote: false, mine: ApproverState.UNSPECIFIED });
  });

  it('no vote without the board, nothing editable on an archived task', () => {
    expect(approvalControls(t(), true, false, 'me').vote).toBe(false);
    expect(approvalControls(t(undefined, true), true, true, 'me')).toMatchObject({ edit: false, vote: false });
  });
});

describe('approvalsWouldReset', () => {
  const voted = task(TaskApprovalState.PENDING, { approvers: [ap('a', ApproverState.APPROVED), ap('b', ApproverState.PENDING)] });
  it('is true when a vote is decided and the feature is on', () => {
    expect(approvalsWouldReset(voted, undefined)).toBe(true);
    expect(approvalsWouldReset(voted, [BoardFeature.ESTIMATE])).toBe(true);
    expect(approvalsWouldReset(task(TaskApprovalState.REJECTED, { approvers: [ap('a', ApproverState.REJECTED)] }), [])).toBe(true);
    expect(decidedApprovers(voted).map((a) => a.userId)).toEqual(['a']);
  });
  it('is false with no decided vote or with the feature off', () => {
    expect(approvalsWouldReset(task(TaskApprovalState.PENDING, { approvers: [ap('a', ApproverState.PENDING)] }), undefined)).toBe(false);
    expect(approvalsWouldReset(task(TaskApprovalState.NONE), undefined)).toBe(false);
    expect(approvalsWouldReset(voted, [BoardFeature.APPROVALS])).toBe(false);
  });
});
