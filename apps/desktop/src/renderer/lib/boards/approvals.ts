import { ApproverState, BoardFeature, BoardStatusType, TaskApprovalState, type BoardStatus, type Task } from '@calaba/protocol';

/**
 * Task approvals on the client (ADR-0049 §6, «Контракт для клиента»): the quorum caption, the
 * card badge, the move gate the kanban uses to dim columns, the approver list edits and who may
 * see / change / vote. Pure. The server is the arbiter: `approvalState` is read as it comes (never
 * recomputed), and `mayMoveTo` only mirrors the server's gate for the UI.
 */

/** At most this many approvers on a task (server: 422 `userIds`). */
export const MAX_APPROVERS = 10;
/** A rejection comment's length (server: 422 `comment`). */
export const MAX_REJECT_COMMENT = 500;

type Approvals = Pick<Task, 'approvers' | 'approvalRequired' | 'approvalState'>;

/** Approvals needed: `approvalRequired` 0 = all, else N capped by the number of approvers. */
export function quorumOf(t: Pick<Task, 'approvers' | 'approvalRequired'>): number {
  const n = t.approvers.length;
  return t.approvalRequired === 0 ? n : Math.min(t.approvalRequired, n);
}

export function approvedCount(t: Pick<Task, 'approvers'>): number {
  return t.approvers.filter((a) => a.state === ApproverState.APPROVED).length;
}

/** Who vetoed (in the list order): «Отклонено: <имя>». */
export function rejecters(t: Pick<Task, 'approvers'>): string[] {
  return t.approvers.filter((a) => a.state === ApproverState.REJECTED).map((a) => a.userId);
}

/** The task still waits for approval: forward moves are refused. */
export function approvalBlocks(t: Pick<Task, 'approvalState'>): boolean {
  return t.approvalState === TaskApprovalState.PENDING || t.approvalState === TaskApprovalState.REJECTED;
}

/**
 * The server's gate (ADR-0049 §2), for the UI only: a task not approved (PENDING / REJECTED) may
 * not go «further» — to a status with a larger position or of type COMPLETED; back, inside the
 * same column and to CANCELLED are always allowed.
 */
export function mayMoveTo(t: Pick<Task, 'approvalState'>, from: Pick<BoardStatus, 'id' | 'position'> | undefined, to: Pick<BoardStatus, 'id' | 'position' | 'type'> | undefined): boolean {
  if (!approvalBlocks(t) || !to) return true;
  if (from && from.id === to.id) return true;
  if (to.type === BoardStatusType.CANCELLED) return true;
  if (to.type === BoardStatusType.COMPLETED) return false;
  return !from || to.position <= from.position;
}

/** Status ids a task may not move to now (the kanban's dimmed columns, the disabled menu rows). */
export function blockedStatusIds(t: Pick<Task, 'approvalState' | 'statusId'>, statuses: readonly BoardStatus[]): Set<string> {
  const out = new Set<string>();
  if (!approvalBlocks(t)) return out;
  const from = statuses.find((s) => s.id === t.statusId);
  for (const s of statuses) if (!mayMoveTo(t, from, s)) out.add(s.id);
  return out;
}

/** The card / row badge: nothing without approvers. */
export type ApprovalBadge = { kind: 'pending'; approved: number; quorum: number } | { kind: 'approved' } | { kind: 'rejected' } | null;

export function approvalBadge(t: Approvals): ApprovalBadge {
  if (t.approvers.length === 0 || t.approvalState === TaskApprovalState.NONE) return null;
  if (t.approvalState === TaskApprovalState.APPROVED) return { kind: 'approved' };
  if (t.approvalState === TaskApprovalState.REJECTED) return { kind: 'rejected' };
  return { kind: 'pending', approved: approvedCount(t), quorum: quorumOf(t) };
}

/** Edits of the approver list: toggle (≤ 10), the quorum kept valid (≤ the number of approvers). */
export function toggleApprover(ids: readonly string[], userId: string): string[] {
  if (ids.includes(userId)) return ids.filter((x) => x !== userId);
  return ids.length >= MAX_APPROVERS ? [...ids] : [...ids, userId];
}

/** A quorum still valid for `n` approvers: N > n (or n < 2) falls back to «Все» (0). */
export function clampRequired(required: number, n: number): number {
  return required > 0 && required < n ? required : 0;
}

/** The quorum choices for `n` approvers: «Все», then 1..n−1 («N из n»). */
export function quorumChoices(n: number): number[] {
  const out = [0];
  for (let i = 1; i < n; i++) out.push(i);
  return out;
}

/** What the viewer may do with the approvals of a task (the client hides UI; the server checks). */
export interface ApprovalControls {
  /** The section is shown: approvers exist, or the viewer may add them. */
  visible: boolean;
  /** Add / remove approvers, change the quorum (whoever may edit the task). */
  edit: boolean;
  /** The viewer is an approver and may vote (sees the board, the task is live). */
  vote: boolean;
  /** The viewer's own vote (UNSPECIFIED = not an approver). */
  mine: ApproverState;
}

export function approvalControls(t: Pick<Task, 'approvers' | 'archivedAt'>, canEditTask: boolean, seesBoard: boolean, me: string): ApprovalControls {
  const own = t.approvers.find((a) => a.userId === me);
  const edit = canEditTask && !t.archivedAt;
  return {
    visible: t.approvers.length > 0 || edit,
    edit,
    vote: !!own && seesBoard && !t.archivedAt,
    mine: own?.state ?? ApproverState.UNSPECIFIED,
  };
}

/** Approvers who already decided (approved or rejected): the votes an edit of the task would drop. */
export function decidedApprovers(t: Pick<Task, 'approvers'>): Task['approvers'] {
  return t.approvers.filter((a) => a.state === ApproverState.APPROVED || a.state === ApproverState.REJECTED);
}

/**
 * Editing the title, description or attachments resets every vote (ADR-0049 §3) — but only when
 * the board has APPROVALS on (`disabled` = `Board.disabledFeatures`) and at least one approver has
 * decided; the UI asks before such an edit. Mirrors the server's `resetApprovals`.
 */
export function approvalsWouldReset(t: Pick<Task, 'approvers'>, disabled: readonly BoardFeature[] | undefined): boolean {
  return !disabled?.includes(BoardFeature.APPROVALS) && decidedApprovers(t).length > 0;
}
