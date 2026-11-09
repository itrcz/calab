import { ApprovalGate, ApproverState, BoardFeature, BoardStatusType, TaskApprovalState, type BoardStatus, type Task } from '@calaba/protocol';

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

/**
 * The board's approval holds status changes (`Board.approvalGate`, ADR-0160): HOLD — the default,
 * and UNSPECIFIED from an older server — or OFF, when the approval never holds a move.
 */
export function gateHolds(gate: ApprovalGate | undefined): boolean {
  return gate !== ApprovalGate.OFF;
}

/**
 * Status ids a task may not move to now (the kanban's dimmed columns, the disabled menu rows);
 * none on a board whose gate is off (`gate` = `Board.approvalGate`, ADR-0160).
 */
export function blockedStatusIds(t: Pick<Task, 'approvalState' | 'statusId'>, statuses: readonly BoardStatus[], gate?: ApprovalGate): Set<string> {
  const out = new Set<string>();
  if (!approvalBlocks(t) || !gateHolds(gate)) return out;
  const from = statuses.find((s) => s.id === t.statusId);
  for (const s of statuses) if (!mayMoveTo(t, from, s)) out.add(s.id);
  return out;
}

/**
 * What picking status `to` does (ADR-0108): `move` — the gate lets it go; `override` — the gate
 * holds it, yet the viewer manages the board (MANAGE_BOARD): ask «Согласование не завершено —
 * перевести вручную?» and send `overrideApproval`; `blocked` — the toast, nothing is sent.
 */
export type StatusPick = 'same' | 'move' | 'override' | 'blocked';

export function statusPick(t: Pick<Task, 'approvalState' | 'statusId'>, statuses: readonly BoardStatus[], to: string, manage: boolean, gate?: ApprovalGate): StatusPick {
  if (to === t.statusId) return 'same';
  if (!blockedStatusIds(t, statuses, gate).has(to)) return 'move';
  return manage ? 'override' : 'blocked';
}

/**
 * Why the gate holds a task, as the hint of a disabled status: «1/3» while waiting, «rejected»
 * after a veto, null when nothing holds it. Primitive-keyed input of `approvalTagKey`.
 */
export type GateReason = { kind: 'pending'; n: number; m: number } | { kind: 'rejected' } | null;

export function gateReason(t: Approvals): GateReason {
  if (!approvalBlocks(t)) return null;
  if (t.approvalState === TaskApprovalState.REJECTED) return { kind: 'rejected' };
  const m = quorumOf(t);
  return { kind: 'pending', n: Math.min(approvedCount(t), m), m };
}

/** The card / row badge: nothing without approvers. */
export type ApprovalBadge = { kind: 'pending'; approved: number; quorum: number } | { kind: 'approved' } | { kind: 'rejected' } | null;

export function approvalBadge(t: Approvals): ApprovalBadge {
  if (t.approvers.length === 0 || t.approvalState === TaskApprovalState.NONE) return null;
  if (t.approvalState === TaskApprovalState.APPROVED) return { kind: 'approved' };
  if (t.approvalState === TaskApprovalState.REJECTED) return { kind: 'rejected' };
  return { kind: 'pending', approved: approvedCount(t), quorum: quorumOf(t) };
}

/**
 * The card / row tag (docs/08 «Доски»): «✓ 3/3» filled green once approved, «2/3» outlined orange
 * while waiting, «✕ 1/3» outlined red after a veto — approvals given of the quorum (capped by it
 * once approved). Encoded as a primitive ("kind:n:m", "" = no tag) so a card's selector re-renders
 * the tag only when it changes.
 */
export type ApprovalTagKind = 'approved' | 'pending' | 'rejected';

export function approvalTagKey(t: Approvals | undefined): string {
  const b = t ? approvalBadge(t) : null;
  if (!t || !b) return '';
  const m = quorumOf(t);
  const n = Math.min(approvedCount(t), m);
  return `${b.kind}:${n}:${m}`;
}

export function parseApprovalTag(key: string): { kind: ApprovalTagKind; n: number; m: number } | null {
  const [kind, n, m] = key.split(':');
  if (kind !== 'approved' && kind !== 'pending' && kind !== 'rejected') return null;
  return { kind, n: Number(n), m: Number(m) };
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
  /** ADR-0108: the viewer manages the board and may approve for others (the approver row menu). */
  forOthers: boolean;
}

export function approvalControls(t: Pick<Task, 'approvers' | 'archivedAt'>, canEditTask: boolean, seesBoard: boolean, me: string, manage = false): ApprovalControls {
  const own = t.approvers.find((a) => a.userId === me);
  const edit = canEditTask && !t.archivedAt;
  return {
    visible: t.approvers.length > 0 || edit,
    edit,
    vote: !!own && seesBoard && !t.archivedAt,
    mine: own?.state ?? ApproverState.UNSPECIFIED,
    forOthers: manage && seesBoard && !t.archivedAt,
  };
}

/**
 * What a manager may do in another approver's row (ADR-0108; the server checks again): `approve`
 * over a pending vote («Согласовать за …»), `withdraw` an approval recorded on behalf («Отозвать
 * согласование за …»); never anything over the approver's own decision or the viewer's own row.
 */
export type OnBehalfAction = 'approve' | 'withdraw' | null;

export function onBehalfAction(a: Pick<Task['approvers'][number], 'userId' | 'state' | 'onBehalf'>, me: string, forOthers: boolean): OnBehalfAction {
  if (!forOthers || a.userId === me) return null;
  if (a.state === ApproverState.PENDING) return 'approve';
  if (a.state === ApproverState.APPROVED && a.onBehalf) return 'withdraw';
  return null;
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
