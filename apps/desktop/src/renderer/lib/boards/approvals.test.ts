import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ApprovalGate, ApproverState, BoardFeature, BoardStatusSchema, BoardStatusType, TaskApprovalState, TaskApproverSchema, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { approvalBadge, approvalTagKey, parseApprovalTag, approvalsWouldReset, decidedApprovers, approvalControls, blockedStatusIds, clampRequired, gateReason, mayMoveTo, onBehalfAction, quorumChoices, quorumOf, statusPick, toggleApprover, MAX_APPROVERS } from './approvals';

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

  it('ADR-0160: the board gate HOLD (and UNSPECIFIED from an older server) holds, OFF never does', () => {
    const pending = task(TaskApprovalState.PENDING, { statusId: 'todo' });
    const vetoed = task(TaskApprovalState.REJECTED, { statusId: 'todo' });
    expect(blockedStatusIds(pending, statuses, ApprovalGate.HOLD).size).toBe(2);
    expect(blockedStatusIds(pending, statuses, ApprovalGate.UNSPECIFIED).size).toBe(2);
    expect(blockedStatusIds(pending, statuses, ApprovalGate.OFF).size).toBe(0);
    expect(blockedStatusIds(vetoed, statuses, ApprovalGate.OFF).size).toBe(0);
    expect(statusPick(pending, statuses, 'done', false, ApprovalGate.OFF)).toBe('move');
    expect(statusPick(vetoed, statuses, 'done', true, ApprovalGate.OFF)).toBe('move');
    expect(statusPick(pending, statuses, 'done', false, ApprovalGate.HOLD)).toBe('blocked');
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

  it('ADR-0108: only a board manager acts for others, on a live task they see', () => {
    expect(approvalControls(t(), false, true, 'me').forOthers).toBe(false);
    expect(approvalControls(t(), false, true, 'me', true).forOthers).toBe(true);
    expect(approvalControls(t(), false, false, 'me', true).forOthers).toBe(false);
    expect(approvalControls(t(undefined, true), true, true, 'me', true).forOthers).toBe(false);
  });
});

describe('ADR-0108: a board manager over the gate and the votes', () => {
  const pending = task(TaskApprovalState.PENDING, { statusId: 'todo' });

  it('statusPick: the gate holds a member, asks a manager, lets free moves go', () => {
    expect(statusPick(pending, statuses, 'doing', false)).toBe('blocked');
    expect(statusPick(pending, statuses, 'done', false)).toBe('blocked');
    expect(statusPick(pending, statuses, 'doing', true)).toBe('override');
    expect(statusPick(pending, statuses, 'done', true)).toBe('override');
    expect(statusPick(pending, statuses, 'backlog', true)).toBe('move');
    expect(statusPick(pending, statuses, 'cancelled', false)).toBe('move');
    expect(statusPick(pending, statuses, 'todo', true)).toBe('same');
    expect(statusPick(task(TaskApprovalState.REJECTED, { statusId: 'todo' }), statuses, 'doing', true)).toBe('override');
    expect(statusPick(task(TaskApprovalState.APPROVED, { statusId: 'todo' }), statuses, 'done', false)).toBe('move');
  });

  it('onBehalfAction: approve a pending vote, withdraw only one recorded for them, never a personal decision or my own row', () => {
    const rec = (userId: string, state: ApproverState, recordedBy = '', onBehalf = !!recordedBy) => create(TaskApproverSchema, { userId, state, recordedBy, onBehalf });
    expect(onBehalfAction(rec('a', ApproverState.PENDING), 'me', true)).toBe('approve');
    expect(onBehalfAction(rec('a', ApproverState.APPROVED, 'boss'), 'me', true)).toBe('withdraw');
    expect(onBehalfAction(rec('a', ApproverState.APPROVED), 'me', true)).toBeNull();
    // The recorder's account is gone: still recorded on behalf, still withdrawable.
    expect(onBehalfAction(rec('a', ApproverState.APPROVED, '', true), 'me', true)).toBe('withdraw');
    expect(onBehalfAction(rec('a', ApproverState.REJECTED), 'me', true)).toBeNull();
    expect(onBehalfAction(rec('me', ApproverState.PENDING), 'me', true)).toBeNull();
    expect(onBehalfAction(rec('a', ApproverState.PENDING), 'me', false)).toBeNull();
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

describe('approvalTagKey (the card / row tag)', () => {
  const three = (a: ApproverState, b: ApproverState, c: ApproverState) => [ap('a', a), ap('b', b), ap('c', c, c === ApproverState.REJECTED ? 'нет' : '')];
  it('approved «✓ 3/3», pending «2/3», rejected «✕ 1/3», nothing without approvers', () => {
    const A = ApproverState.APPROVED;
    const P = ApproverState.PENDING;
    const R = ApproverState.REJECTED;
    expect(approvalTagKey(task(TaskApprovalState.APPROVED, { approvers: three(A, A, A) }))).toBe('approved:3:3');
    expect(approvalTagKey(task(TaskApprovalState.PENDING, { approvers: three(A, A, P) }))).toBe('pending:2:3');
    expect(approvalTagKey(task(TaskApprovalState.REJECTED, { approvers: three(A, P, R) }))).toBe('rejected:1:3');
    expect(approvalTagKey(task(TaskApprovalState.NONE))).toBe('');
    expect(approvalTagKey(undefined)).toBe('');
  });
  it('a quorum of 2 of 3: approved shows 2/2 even when all three approved', () => {
    const A = ApproverState.APPROVED;
    expect(approvalTagKey(task(TaskApprovalState.APPROVED, { approvers: three(A, A, A), approvalRequired: 2 }))).toBe('approved:2:2');
  });
  it('parses back', () => {
    expect(parseApprovalTag('pending:2:3')).toEqual({ kind: 'pending', n: 2, m: 3 });
    expect(parseApprovalTag('')).toBeNull();
  });
});

describe('gateReason', () => {
  const A = ApproverState.APPROVED;
  const P = ApproverState.PENDING;
  const ap = (userId: string, state: ApproverState) => ({ userId, state, comment: '', decidedAt: undefined, onBehalf: false }) as never;
  it('pending shows approvals of the quorum, rejected a veto, nothing otherwise', () => {
    const t = { approvalState: TaskApprovalState.PENDING, approvalRequired: 0, approvers: [ap('a', A), ap('b', P), ap('c', P)] };
    expect(gateReason(t)).toEqual({ kind: 'pending', n: 1, m: 3 });
    expect(gateReason({ ...t, approvalState: TaskApprovalState.REJECTED })).toEqual({ kind: 'rejected' });
    expect(gateReason({ ...t, approvalState: TaskApprovalState.APPROVED })).toBeNull();
    expect(gateReason({ ...t, approvalState: TaskApprovalState.NONE })).toBeNull();
  });
});
