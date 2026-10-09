/**
 * Task boards in the mock (ADR-0042, proto/calaba/v1/boards.proto): boards with statuses,
 * labels, milestones, saved views and access overrides; tasks with assignees (lead + notes),
 * relations, subscriptions and the activity journal; the universal TaskFilter; «Мои задачи» and
 * search. The routes and the gateway fan-out are wired in mock-server.ts (`boardRoutes`); the
 * task room (Room.type TASK) is a normal mock room, so comments, reactions, stickers and files go
 * through the existing message mock.
 *
 * Simplifications against the server: tsvector search is a case-insensitive substring match of
 * every word; the filter is evaluated in memory (same semantics as boards.proto); no auto-archive
 * sweeper; notifications are TASK_UPDATE notices only (no system mail); bots are not special.
 */
import { clone, create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  ApproverState,
  BoardCategorySchema,
  BoardFeature,
  BoardWebhookPauseReason,
  BoardWebhookSchema,
  EstimateScale,
  TaskChecklistItemSchema,
  TaskChecklistSchema,
  BoardSchema,
  BoardStatusSchema,
  BoardStatusType,
  BoardLabelSchema,
  BoardMilestoneSchema,
  BoardTemplate,
  BoardViewKind,
  BoardViewSchema,
  DispatchEventSchema,
  ErrorCode,
  Permission,
  PermissionTargetType,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  TaskActivitySchema,
  TaskApprovalDecision,
  TaskApprovalState,
  TaskApproverSchema,
  TaskAssigneeSchema,
  TaskField,
  TaskNoticeKind,
  TaskOp,
  TaskPriority,
  TaskRelationKind,
  TaskRelationSchema,
  TaskSchema,
  WorkspaceRole,
  type Board,
  type BoardCategory,
  type BoardView,
  type BoardWebhook,
  type TaskChecklist,
  type Message,
  type Role,
  type RoomPermissionOverride,
  type Task,
  type TaskActivity,
  type TaskAssigneeInput,
  type TaskCondition,
  type TaskFilter,
} from '@calaba/protocol';
import type { JsonObject } from '@bufbuild/protobuf';
import { IDS, ts, type MemberRec, type MockState } from './fixtures';

export const VIEW_BOARD = BigInt(Permission.VIEW_BOARD);
export const CREATE_TASKS = BigInt(Permission.CREATE_TASKS);
export const EDIT_TASKS = BigInt(Permission.EDIT_TASKS);
export const MANAGE_BOARD = BigInt(Permission.MANAGE_BOARD);
export const BOARD_BITS = VIEW_BOARD | CREATE_TASKS | EDIT_TASKS | MANAGE_BOARD;
const ADMINISTRATOR = BigInt(Permission.ADMINISTRATOR);
// ADR-0048: creating boards is its own bit.
const CREATE_BOARDS = BigInt(Permission.CREATE_BOARDS);
const MANAGE_INTEGRATIONS = BigInt(Permission.MANAGE_INTEGRATIONS);
const VIEW_ROOM = BigInt(Permission.VIEW_ROOM);
const SEND_MESSAGES = BigInt(Permission.SEND_MESSAGES);
const ATTACH_FILES = BigInt(Permission.ATTACH_FILES);
const MANAGE_MESSAGES = BigInt(Permission.MANAGE_MESSAGES);

/** Member default on boards (ADR-0042 §2). */
export const MEMBER_BOARD_BITS = VIEW_BOARD | CREATE_TASKS;

type EventInit = MessageInitShape<typeof DispatchEventSchema>;

/** A refusal of a board operation: mock-server.ts turns it into an HTTP error. */
export class BoardError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
    readonly reason = '',
    /** 409 TASK_APPROVAL_REQUIRED: approvals / the quorum (ADR-0049). */
    readonly counts: { used?: number; limit?: number } = {},
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- approvals (ADR-0049)

const MAX_APPROVERS = 10;
const APPROVAL_TOKEN: Record<number, string> = {
  [TaskApprovalState.NONE]: 'none',
  [TaskApprovalState.PENDING]: 'pending',
  [TaskApprovalState.APPROVED]: 'approved',
  [TaskApprovalState.REJECTED]: 'rejected',
};
const VOTE_TOKEN: Record<number, string> = { [ApproverState.PENDING]: 'pending', [ApproverState.APPROVED]: 'approved', [ApproverState.REJECTED]: 'rejected' };

function quorum(t: Task): number {
  const n = t.approvers.length;
  return t.approvalRequired === 0 ? n : Math.min(t.approvalRequired, n);
}

/** The derived state (the server computes it; clients read it). */
function approvalOf(t: Task): TaskApprovalState {
  if (!t.approvers.length) return TaskApprovalState.NONE;
  if (t.approvers.some((a) => a.state === ApproverState.REJECTED)) return TaskApprovalState.REJECTED;
  return t.approvers.filter((a) => a.state === ApproverState.APPROVED).length >= quorum(t) ? TaskApprovalState.APPROVED : TaskApprovalState.PENDING;
}

const approvalRequired = (t: Task): BoardError =>
  new BoardError(409, ErrorCode.CONFLICT, 'approval required', '', 'TASK_APPROVAL_REQUIRED', { used: t.approvers.filter((a) => a.state === ApproverState.APPROVED).length, limit: quorum(t) });

/** checkApprovalGate: a task not approved goes no «further» (larger position or COMPLETED); CANCELLED is fine. */
function approvalGate(t: Task, from: { id: string; position: number } | undefined, to: { id: string; position: number; type: BoardStatusType }): void {
  const s = approvalOf(t);
  if (s !== TaskApprovalState.PENDING && s !== TaskApprovalState.REJECTED) return;
  if (from?.id === to.id || to.type === BoardStatusType.CANCELLED) return;
  if (to.type === BoardStatusType.COMPLETED || (from && to.position > from.position)) throw approvalRequired(t);
}

const notFound = (what: string): BoardError => new BoardError(404, ErrorCode.NOT_FOUND, what);
const forbidden = (what: string): BoardError => new BoardError(403, ErrorCode.FORBIDDEN, what);
const invalid = (field: string, what: string): BoardError => new BoardError(422, ErrorCode.VALIDATION, what, field);
const conflict = (what: string, field = '', reason = ''): BoardError => new BoardError(409, ErrorCode.CONFLICT, what, field, reason);

/** What the boards mock needs from the server mock. */
export interface BoardsHost {
  state: MockState;
  member(wsId: string, userId: string): MemberRec | undefined;
  rolesOf(m: MemberRec): Role[];
  ownerOf(wsId: string): string;
  /** Per-recipient fan-out (null = not to this user). */
  fanout(pick: (userId: string) => EventInit | null): void;
  /** The next mutation time (deterministic clock). */
  tick(): Timestamp;
}

export interface BoardRec {
  board: Board;
  nextNumber: number;
  /** personal views: author id → views (shared ones live in board.views). */
  personal: Map<string, BoardView[]>;
}

export interface TaskRec {
  task: Task;
  /** userId → muted. */
  subscribers: Map<string, boolean>;
  unread: Set<string>;
}

const DAY = 86_400_000;
/** Length in characters (code points), as the server counts. */
const chars = (v: string): number => Array.from(v).length;
const utcKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (key: string): number => Date.parse(`${key}T00:00:00Z`);

/** "today", "week_start", "week_end", "month_end", "-7d", "+14d" or a "YYYY-MM-DD" (UTC «today»). */
export function resolveDay(v: string, todayMs: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const today = dayMs(utcKey(todayMs));
  const dow = (new Date(today).getUTCDay() + 6) % 7;
  if (v === 'today') return utcKey(today);
  if (v === 'week_start') return utcKey(today - dow * DAY);
  if (v === 'week_end') return utcKey(today + (6 - dow) * DAY);
  if (v === 'month_end') {
    const d = new Date(today);
    return utcKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }
  const m = /^([+-]\d{1,4})d$/.exec(v);
  return m ? utcKey(today + Number(m[1]) * DAY) : utcKey(today);
}

const TYPE_TOKEN: Record<number, string> = {
  [BoardStatusType.BACKLOG]: 'backlog',
  [BoardStatusType.UNSTARTED]: 'unstarted',
  [BoardStatusType.STARTED]: 'started',
  [BoardStatusType.COMPLETED]: 'completed',
  [BoardStatusType.CANCELLED]: 'cancelled',
};
const PRIORITY_TOKEN: Record<string, string> = { none: '0', low: '1', medium: '2', high: '3', urgent: '4' };

/** The server's filter semantics (boards.proto TaskField / TaskOp) evaluated in memory. */
export function matchCondition(rec: TaskRec, c: TaskCondition, ctx: { me: string; statusType: (id: string) => BoardStatusType; nowMs: number }): boolean {
  const t = rec.task;
  const vals = c.values.map((v) => (v === 'me' ? ctx.me : v));
  const set = (have: string[], all = false): boolean => {
    switch (c.op) {
      case TaskOp.IS:
        return all ? vals.every((v) => have.includes(v)) : vals.some((v) => have.includes(v));
      case TaskOp.ANY_OF:
        return vals.some((v) => have.includes(v));
      case TaskOp.IS_NOT:
      case TaskOp.NONE_OF:
        return !vals.some((v) => have.includes(v));
      case TaskOp.EMPTY:
        return have.length === 0;
      case TaskOp.NOT_EMPTY:
        return have.length > 0;
      default:
        throw invalid('filter', 'unsupported op');
    }
  };
  const date = (day: string): boolean => {
    if (c.op === TaskOp.EMPTY) return day === '';
    if (c.op === TaskOp.NOT_EMPTY) return day !== '';
    if (!day) return false;
    const fromV = c.from ? utcKey(timestampMs(c.from)) : '';
    const toV = c.to ? utcKey(timestampMs(c.to)) : '';
    const a = vals[0] !== undefined ? resolveDay(vals[0], ctx.nowMs) : c.op === TaskOp.BEFORE ? toV : fromV;
    const b = vals[1] !== undefined ? resolveDay(vals[1], ctx.nowMs) : toV;
    if (c.op === TaskOp.BEFORE) return day < a;
    if (c.op === TaskOp.AFTER) return day >= a;
    if (c.op === TaskOp.BETWEEN) return day >= a && day <= b;
    throw invalid('filter', 'unsupported op');
  };
  const bool = (v: boolean): boolean => (c.op === TaskOp.EMPTY ? !v : c.op === TaskOp.NOT_EMPTY ? v : (vals[0] ?? 'true') === 'true' ? v : !v);
  switch (c.field) {
    case TaskField.STATUS:
      return set([t.statusId]);
    case TaskField.STATUS_TYPE:
      return set([TYPE_TOKEN[ctx.statusType(t.statusId)] ?? '']);
    case TaskField.ASSIGNEE:
      return set(t.assignees.map((a) => a.userId));
    case TaskField.LEAD:
      return set(t.assignees.filter((a) => a.isLead).map((a) => a.userId));
    case TaskField.CREATOR:
      return set([t.createdBy]);
    case TaskField.SUBSCRIBER:
      return set([...rec.subscribers].filter(([, muted]) => !muted).map(([u]) => u));
    case TaskField.PRIORITY: {
      const level: number = t.priority;
      if (c.op === TaskOp.GT) return level > c.number;
      if (c.op === TaskOp.LT) return level < c.number;
      const want = vals.map((v) => PRIORITY_TOKEN[v] ?? v);
      const have = String(t.priority);
      if (c.op === TaskOp.IS_NOT || c.op === TaskOp.NONE_OF) return !want.includes(have);
      return want.includes(have);
    }
    case TaskField.ESTIMATE:
      if (c.op === TaskOp.GT) return t.estimate > c.number;
      if (c.op === TaskOp.LT) return t.estimate > 0 && t.estimate < c.number;
      return set(t.estimate ? [String(t.estimate)] : []);
    case TaskField.LABEL:
      return set(t.labelIds, true);
    case TaskField.MILESTONE:
      return set(t.milestoneId ? [t.milestoneId] : []);
    case TaskField.PARENT:
      return set(t.parentId ? [t.parentId] : []);
    case TaskField.RELATION: {
      const have = new Set<string>();
      for (const r of t.relations) {
        if (r.kind === TaskRelationKind.BLOCKS) have.add(r.taskId === t.id ? 'blocks' : 'blocked');
        if (r.kind === TaskRelationKind.RELATES) have.add('relates');
        if (r.kind === TaskRelationKind.DUPLICATES) have.add('duplicates');
      }
      return set([...have]);
    }
    case TaskField.CREATED_AT:
      return date(t.createdAt ? utcKey(timestampMs(t.createdAt)) : '');
    case TaskField.UPDATED_AT:
      return date(t.updatedAt ? utcKey(timestampMs(t.updatedAt)) : '');
    case TaskField.START_ON:
      return date(t.startOn);
    case TaskField.DUE_ON:
      return date(t.dueOn);
    case TaskField.HAS_ATTACHMENTS:
      return bool(t.attachmentCount > 0);
    case TaskField.HAS_COMMENTS:
      return bool(t.commentCount > 0);
    case TaskField.ARCHIVED:
      return bool(!!t.archivedAt);
    case TaskField.APPROVAL_STATE:
      return set([APPROVAL_TOKEN[approvalOf(t)] ?? 'none']);
    case TaskField.APPROVER_PENDING:
      return set(t.approvers.filter((a) => a.state === ApproverState.PENDING).map((a) => a.userId));
    case TaskField.TEXT: {
      const words = (vals[0] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hay = `${t.key} ${t.title} ${t.description}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }
    default:
      throw invalid('filter', 'unsupported field');
  }
}

export function matchFilter(rec: TaskRec, f: TaskFilter | undefined, ctx: Parameters<typeof matchCondition>[2]): boolean {
  if (!f || f.conditions.length === 0) return true;
  if (f.conditions.length > 30) throw invalid('filter', 'at most 30 conditions');
  return f.any ? f.conditions.some((c) => matchCondition(rec, c, ctx)) : f.conditions.every((c) => matchCondition(rec, c, ctx));
}

/** Status templates of a new board (ADR-0042 §5). */
export function templateStatuses(tpl: BoardTemplate): Array<{ name: string; type: BoardStatusType; color: number }> {
  switch (tpl) {
    case BoardTemplate.DEVELOPMENT:
      return [
        { name: 'Backlog', type: BoardStatusType.BACKLOG, color: 0x8e8e93 },
        { name: 'Todo', type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 },
        { name: 'В работе', type: BoardStatusType.STARTED, color: 0xffcc00 },
        { name: 'Ревью', type: BoardStatusType.STARTED, color: 0xff9f0a },
        { name: 'Готово', type: BoardStatusType.COMPLETED, color: 0x5e5ce6 },
        { name: 'Отменено', type: BoardStatusType.CANCELLED, color: 0x8e8e93 },
      ];
    case BoardTemplate.EMPTY:
      return [{ name: 'Todo', type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 }];
    default:
      return [
        { name: 'Todo', type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 },
        { name: 'В работе', type: BoardStatusType.STARTED, color: 0xffcc00 },
        { name: 'Готово', type: BoardStatusType.COMPLETED, color: 0x5e5ce6 },
      ];
  }
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;

function keyFromName(name: string, taken: Set<string>): string {
  const latin = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3);
  let base = latin.length >= 2 && /^[A-Z]/.test(latin) ? latin : 'BRD';
  let n = 1;
  let key = base;
  while (taken.has(key)) key = `${base.slice(0, 4)}${++n}`;
  base = key;
  return base;
}

/** The domain of boards; one instance per mock server (reset with the state). */
export class BoardsMock {
  readonly boards = new Map<string, BoardRec>();
  readonly tasks = new Map<string, TaskRec>();
  readonly activity: TaskActivity[] = [];
  /** Task room id → task id. */
  readonly roomTask = new Map<string, string>();
  /** Board categories (ADR-0058 §1), by id. */
  readonly categories = new Map<string, BoardCategory>();
  /** Task id → its checklists (ADR-0058 §2). */
  readonly checklists = new Map<string, TaskChecklist[]>();
  /** Board id → its webhook and secret (ADR-0058 §4). */
  readonly webhooks = new Map<string, { hook: BoardWebhook; secret: string }>();
  private seq = 0;

  constructor(private readonly host: BoardsHost) {}

  /**
   * Own id ranges (`80bN`), so boards never shift the fixture counters (rooms, messages) that
   * other tests rely on; the task room ids are `80b8`.
   */
  private id(kind: 'board' | 'task' | 'status' | 'label' | 'milestone' | 'view' | 'activity' | 'room' | 'category' | 'checklist' | 'item'): string {
    this.seq += 1;
    const code = { board: 0xb1, task: 0xb2, status: 0xb3, label: 0xb4, milestone: 0xb5, view: 0xb6, activity: 0xb7, room: 0xb8, category: 0xb9, checklist: 0xba, item: 0xbb }[kind];
    return `00000000-0000-7000-80${code.toString(16)}-${this.seq.toString(16).padStart(12, '0')}`;
  }

  // ---------------------------------------------------------------- permissions

  /** The viewer's board bits (0 = the board is hidden from them). */
  perms(b: Board, userId: string): bigint {
    const m = this.host.member(b.workspaceId, userId);
    if (!m || m.role === WorkspaceRole.GUEST) return 0n;
    const roles = this.host.rolesOf(m);
    let perms = 0n;
    for (const r of roles) {
      perms |= r.permissions;
      if (r.builtin === WorkspaceRole.MEMBER) perms |= MEMBER_BOARD_BITS;
    }
    // ADR-0048: a restricted board — the owner has everything, ADMINISTRATOR gives nothing, VIEW_BOARD
    // only from an allow override (b.isPrivate is set too, so the check below needs one).
    if (this.host.ownerOf(b.workspaceId) === userId) return BOARD_BITS;
    if (perms & ADMINISTRATOR && !b.restricted) return BOARD_BITS;
    let bits = perms & BOARD_BITS;
    let viaOverride = false;
    const byId = new Map(roles.map((r) => [r.id, r]));
    const roleOvs = b.permissionOverrides
      .filter((o) => o.targetType === PermissionTargetType.ROLE && byId.has(o.targetId))
      .sort((x, y) => (byId.get(x.targetId)?.position ?? 0) - (byId.get(y.targetId)?.position ?? 0));
    for (const o of roleOvs) {
      bits = (bits & ~o.deny) | (o.allow & BOARD_BITS);
      if (o.allow & VIEW_BOARD) viaOverride = true;
    }
    const mine = b.permissionOverrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId);
    if (mine) {
      bits = (bits & ~mine.deny) | (mine.allow & BOARD_BITS);
      if (mine.allow & VIEW_BOARD) viaOverride = true;
    }
    if (b.isPrivate && !viaOverride) return 0n;
    return bits & VIEW_BOARD ? bits : 0n;
  }

  private boardFor(id: string, userId: string): BoardRec {
    const rec = this.boards.get(id);
    if (!rec || !this.perms(rec.board, userId) || (rec.board.archivedAt && !(this.perms(rec.board, userId) & MANAGE_BOARD))) throw notFound('board not found');
    return rec;
  }

  private need(rec: BoardRec, userId: string, bit: bigint): bigint {
    const p = this.perms(rec.board, userId);
    if (!(p & bit)) throw forbidden('missing board permission');
    return p;
  }

  private taskFor(id: string, userId: string): { t: TaskRec; b: BoardRec; p: bigint } {
    const t = this.tasks.get(id);
    const b = t ? this.boards.get(t.task.boardId) : undefined;
    const p = b ? this.perms(b.board, userId) : 0n;
    if (!t || !b || !p) throw notFound('task not found');
    return { t, b, p };
  }

  /** CREATE_TASKS edits own / assigned tasks; EDIT_TASKS any. */
  private canEdit(t: Task, userId: string, p: bigint): boolean {
    if (p & EDIT_TASKS) return true;
    return !!(p & CREATE_TASKS) && (t.createdBy === userId || t.assignees.some((a) => a.userId === userId));
  }

  /** Room permissions of a task room (null = not a task room). */
  roomPerms(roomId: string, userId: string): bigint | null {
    const taskId = this.roomTask.get(roomId);
    if (!taskId) return null;
    const t = this.tasks.get(taskId);
    const b = t ? this.boards.get(t.task.boardId) : undefined;
    if (!t || !b) return 0n;
    const p = this.perms(b.board, userId);
    if (!(p & VIEW_BOARD)) return 0n;
    // ADR-0058 §3: COMMENTS off — the room is read-only like an archived task's; moderation stays.
    const manage = p & EDIT_TASKS ? MANAGE_MESSAGES : 0n;
    if (t.task.archivedAt || b.board.disabledFeatures.includes(BoardFeature.COMMENTS)) return VIEW_ROOM | manage;
    return VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | manage;
  }

  // ---------------------------------------------------------------- serialisation

  private openCounts(boardId: string, userId: string): { open: number; mine: number } {
    const b = this.boards.get(boardId);
    let open = 0;
    let mine = 0;
    for (const t of this.tasks.values()) {
      if (t.task.boardId !== boardId || t.task.archivedAt) continue;
      const type = b?.board.statuses.find((s) => s.id === t.task.statusId)?.type;
      if (type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED) continue;
      open++;
      if (t.task.assignees.some((a) => a.userId === userId)) mine++;
    }
    return { open, mine };
  }

  /** The board as `userId` sees it; `personal` adds their own views (REST), `event` zeroes my_open_tasks. */
  boardOut(rec: BoardRec, userId: string, o: { personal?: boolean; event?: boolean } = {}): Board {
    const out = clone(BoardSchema, rec.board);
    const p = this.perms(rec.board, userId);
    out.permissions = p;
    const c = this.openCounts(rec.board.id, userId);
    out.openTasks = c.open;
    out.myOpenTasks = o.event ? 0 : c.mine;
    out.keyLocked = rec.nextNumber > 1;
    if (!out.estimateScale) out.estimateScale = EstimateScale.FIBONACCI;
    if (!(p & MANAGE_BOARD)) out.permissionOverrides = [];
    if (o.personal) out.views = [...out.views, ...(rec.personal.get(userId) ?? [])];
    return out;
  }

  /** The task as `userId` sees it (`viewer` = with their subscription / unread). */
  taskOut(rec: TaskRec, userId: string, viewer: boolean): Task {
    const out = clone(TaskSchema, rec.task);
    out.approvalState = approvalOf(rec.task);
    out.viewerState = viewer;
    if (viewer) {
      out.subscribed = rec.subscribers.has(userId);
      out.muted = rec.subscribers.get(userId) === true;
      out.unread = rec.unread.has(userId);
    }
    out.attachments = [];
    return out;
  }

  /** READY: the boards a user sees and their unread tasks. */
  snapshot(wsId: string, userId: string): { boards: Board[]; unreadTaskIds: string[]; boardCategories: BoardCategory[] } {
    const boards = [...this.boards.values()]
      .filter((r) => r.board.workspaceId === wsId && !r.board.archivedAt && this.perms(r.board, userId))
      .sort((a, b) => a.board.position - b.board.position)
      .map((r) => this.boardOut(r, userId));
    const visible = new Set(boards.map((b) => b.id));
    const unreadTaskIds = [...this.tasks.values()].filter((t) => visible.has(t.task.boardId) && t.unread.has(userId) && !t.task.archivedAt).map((t) => t.task.id);
    return { boards, unreadTaskIds, boardCategories: this.categoriesOf(wsId) };
  }

  // ---------------------------------------------------------------- events

  private emitBoard(rec: BoardRec, kind: 'boardCreate' | 'boardUpdate', seenBefore?: Set<string>): void {
    this.host.fanout((u) => {
      const sees = this.perms(rec.board, u) !== 0n && !rec.board.archivedAt;
      if (sees) return { event: { case: seenBefore && !seenBefore.has(u) ? 'boardCreate' : kind, value: { board: this.boardOut(rec, u, { event: true }) } } };
      if (seenBefore?.has(u) || rec.board.archivedAt) return { event: { case: 'boardDelete', value: { workspaceId: rec.board.workspaceId, boardId: rec.board.id, purged: false } } };
      return null;
    });
  }

  private viewers(rec: BoardRec): (u: string) => boolean {
    return (u) => this.perms(rec.board, u) !== 0n;
  }

  private emitTask(t: TaskRec, kind: 'taskCreate' | 'taskUpdate', notice?: { kind: TaskNoticeKind; actor: string; to: Set<string>; messageId?: string }): void {
    const b = this.boards.get(t.task.boardId);
    if (!b) return;
    const sees = this.viewers(b);
    this.host.fanout((u) => {
      if (!sees(u)) return null;
      if (kind === 'taskCreate') return { event: { case: 'taskCreate', value: { task: this.taskOut(t, u, true) } } };
      const n = notice && notice.to.has(u) ? { kind: notice.kind, actorId: notice.actor, messageId: notice.messageId ?? '' } : undefined;
      return { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true), ...(n ? { notice: n } : {}) } } };
    });
  }

  private emitTaskDelete(t: TaskRec, purged: boolean, board: BoardRec): void {
    const sees = this.viewers(board);
    this.host.fanout((u) => (sees(u) ? { event: { case: 'taskDelete', value: { workspaceId: t.task.workspaceId, boardId: t.task.boardId, taskId: t.task.id, purged } } } : null));
  }

  private journal(t: TaskRec, actor: string, kind: string, before: JsonObject, after: JsonObject): TaskActivity {
    const a = create(TaskActivitySchema, {
      id: this.id('activity'),
      taskId: t.task.id,
      boardId: t.task.boardId,
      actorId: actor,
      kind,
      before,
      after,
      createdAt: this.host.tick(),
    });
    this.activity.push(a);
    const b = this.boards.get(t.task.boardId);
    if (b) {
      const sees = this.viewers(b);
      this.host.fanout((u) => (sees(u) ? { event: { case: 'taskActivity', value: { workspaceId: t.task.workspaceId, activity: a } } } : null));
    }
    return a;
  }

  // ---------------------------------------------------------------- boards

  listBoards(wsId: string, userId: string, archived: boolean): Board[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    if (m.role === WorkspaceRole.GUEST) throw forbidden('boards are not available for guests');
    return [...this.boards.values()]
      .filter((r) => r.board.workspaceId === wsId && !!r.board.archivedAt === archived && this.perms(r.board, userId) && (!archived || this.perms(r.board, userId) & MANAGE_BOARD))
      .sort((a, b) => a.board.position - b.board.position)
      .map((r) => this.boardOut(r, userId, { personal: true }));
  }

  /** CREATE_BOARDS of the workspace (ADR-0048; ADMINISTRATOR = all); guests never. */
  private mayCreateBoards(wsId: string, userId: string): boolean {
    const m = this.host.member(wsId, userId);
    if (!m || m.role === WorkspaceRole.GUEST) return false;
    if (this.host.ownerOf(wsId) === userId) return true;
    const perms = this.host.rolesOf(m).reduce((a, r) => a | r.permissions, 0n);
    return !!(perms & (ADMINISTRATOR | CREATE_BOARDS));
  }

  createBoard(
    wsId: string,
    userId: string,
    req: { name: string; key: string; emoji: string; isPrivate: boolean; description: string; template: BoardTemplate },
  ): BoardRec {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    if (!this.mayCreateBoards(wsId, userId)) throw forbidden('CREATE_BOARDS required');
    const name = req.name.trim();
    if (!name || chars(name) > 60) throw invalid('name', 'name must be 1..60 characters');
    const live = [...this.boards.values()].filter((r) => r.board.workspaceId === wsId);
    if (live.filter((r) => !r.board.archivedAt).length >= 50) throw conflict('too many boards', '', 'BOARD_LIMIT');
    const taken = new Set(live.map((r) => r.board.key));
    const key = req.key ? req.key.trim().toUpperCase() : keyFromName(name, taken);
    if (!KEY_RE.test(key)) throw invalid('key', 'key must be 2..6 of A-Z0-9 starting with a letter');
    if (taken.has(key)) throw conflict('key taken', 'key');
    const id = this.id('board');
    const statuses = templateStatuses(req.template).map((s, i) =>
      create(BoardStatusSchema, { id: this.id('status'), name: s.name, type: s.type, color: s.color, position: i, isDefault: false }),
    );
    const def = statuses.find((s) => s.type === BoardStatusType.UNSTARTED) ?? statuses[0];
    if (def) def.isDefault = true;
    const board = create(BoardSchema, {
      id,
      workspaceId: wsId,
      name,
      key,
      emoji: req.emoji,
      description: req.description.slice(0, 2000),
      isPrivate: req.isPrivate,
      position: live.filter((r) => !r.board.archivedAt).length,
      autoArchiveDays: 30,
      approvalNotifyDelaySeconds: 60,
      createdBy: userId,
      createdAt: this.host.tick(),
      statuses,
      // The creator gets every board bit (ADR-0042 §2).
      permissionOverrides: [create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: userId, allow: BOARD_BITS, deny: 0n })],
    });
    if (req.isPrivate) board.permissionOverrides.push(create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_BOARD }));
    const rec: BoardRec = { board, nextNumber: 1, personal: new Map() };
    this.boards.set(id, rec);
    this.emitBoard(rec, 'boardCreate');
    return rec;
  }

  getBoard(id: string, userId: string): Board {
    return this.boardOut(this.boardFor(id, userId), userId, { personal: true });
  }

  updateBoard(
    id: string,
    userId: string,
    req: {
      name?: string | undefined;
      key?: string | undefined;
      emoji?: string | undefined;
      description?: string | undefined;
      isPrivate?: boolean | undefined;
      autoArchiveDays?: number | undefined;
      defaultViewId?: string | undefined;
      iconFileId?: string | undefined;
      restricted?: boolean | undefined;
      setDisabledFeatures?: boolean;
      disabledFeatures?: readonly BoardFeature[];
      estimateScale?: EstimateScale | undefined;
      approvalNotifyDelaySeconds?: number | undefined;
    },
  ): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const b = rec.board;
    const seen = this.seers(rec);
    if (req.name !== undefined) {
      const n = req.name.trim();
      if (!n || chars(n) > 60) throw invalid('name', 'name must be 1..60 characters');
      b.name = n;
    }
    if (req.key !== undefined && req.key !== b.key) {
      if (rec.nextNumber > 1) throw conflict('the key is locked after the first task', 'key');
      const k = req.key.toUpperCase();
      if (!KEY_RE.test(k)) throw invalid('key', 'bad key');
      if ([...this.boards.values()].some((r) => r !== rec && r.board.workspaceId === b.workspaceId && r.board.key === k)) throw conflict('key taken', 'key');
      b.key = k;
    }
    if (req.emoji !== undefined) b.emoji = req.emoji;
    if (req.iconFileId !== undefined) b.iconFileId = req.iconFileId;
    if (req.description !== undefined) b.description = req.description.slice(0, 2000);
    if (req.autoArchiveDays !== undefined) b.autoArchiveDays = Math.min(3650, req.autoArchiveDays);
    if (req.defaultViewId !== undefined) b.defaultViewId = req.defaultViewId;
    // ADR-0082: the approval notice delay (the mock sends notices at once whatever it is).
    if (req.approvalNotifyDelaySeconds !== undefined) {
      if (![0, 60, 300, 900, 1800, 3600].includes(req.approvalNotifyDelaySeconds)) throw invalid('approvalNotifyDelaySeconds', 'bad delay');
      b.approvalNotifyDelaySeconds = req.approvalNotifyDelaySeconds;
    }
    // ADR-0058 §3: the disabled features (ascending, unique) and the estimate scale.
    if (req.setDisabledFeatures) {
      const list = [...new Set(req.disabledFeatures ?? [])].sort((x, y) => x - y);
      if (list.some((f) => f < BoardFeature.ESTIMATE || f > BoardFeature.TIMELINE)) throw invalid('disabledFeatures', 'unknown feature');
      b.disabledFeatures = list;
    }
    if (req.estimateScale !== undefined) {
      if (req.estimateScale < EstimateScale.FIBONACCI || req.estimateScale > EstimateScale.TSHIRT) throw invalid('estimateScale', 'unknown scale');
      b.estimateScale = req.estimateScale;
    }
    // ADR-0048: a restricted board stays private until `restricted` is lifted (422 isPrivate).
    if (req.isPrivate === false && b.restricted && req.restricted !== false) throw invalid('isPrivate', 'lift restricted first');
    if (req.restricted === false) b.restricted = false;
    if (req.isPrivate !== undefined && req.isPrivate !== b.isPrivate) {
      b.isPrivate = req.isPrivate;
      b.permissionOverrides = b.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.ROLE && o.targetId === 'member' && o.deny === VIEW_BOARD && o.allow === 0n));
      if (req.isPrivate) b.permissionOverrides.push(create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_BOARD }));
    }
    // ADR-0048: private boards only (422 restricted); the caller (unless the owner) keeps access
    // with a personal allow VIEW_BOARD | MANAGE_BOARD.
    if (req.restricted === true && !b.restricted) {
      if (!b.isPrivate) throw invalid('restricted', 'only private boards can be restricted');
      if (this.host.ownerOf(b.workspaceId) !== userId) {
        const mine = b.permissionOverrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId);
        if (mine) mine.allow |= VIEW_BOARD | MANAGE_BOARD;
        else b.permissionOverrides.push(create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: userId, allow: VIEW_BOARD | MANAGE_BOARD, deny: 0n }));
      }
      b.restricted = true;
    }
    this.emitBoard(rec, 'boardUpdate', seen);
    return this.boardOut(rec, userId, { personal: true });
  }

  private seers(rec: BoardRec): Set<string> {
    return new Set(this.host.state.members.filter((m) => m.workspaceId === rec.board.workspaceId && this.perms(rec.board, m.userId)).map((m) => m.userId));
  }

  removeBoard(id: string, userId: string, purge: boolean): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const seen = this.seers(rec);
    if (purge) {
      this.boards.delete(id);
      for (const [tid, t] of this.tasks) {
        if (t.task.boardId !== id) continue;
        this.tasks.delete(tid);
        this.roomTask.delete(t.task.roomId);
        this.host.state.rooms.delete(t.task.roomId);
        this.host.state.messages.delete(t.task.roomId);
      }
    } else rec.board.archivedAt = this.host.tick();
    this.host.fanout((u) => (seen.has(u) ? { event: { case: 'boardDelete', value: { workspaceId: rec.board.workspaceId, boardId: id, purged: purge } } } : null));
  }

  /** POST /boards/{id}/restore (MANAGE_BOARD): back in the list; BOARD_CREATE to its viewers. */
  restoreBoard(id: string, userId: string): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    delete rec.board.archivedAt;
    this.host.fanout((u) => (this.perms(rec.board, u) ? { event: { case: 'boardCreate', value: { board: this.boardOut(rec, u, { event: true }) } } } : null));
    return this.boardOut(rec, userId, { personal: true });
  }

  moveBoard(id: string, userId: string, index: number, categoryId?: string): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    // ADR-0058 §1: a category given moves the board there; the index counts that container.
    if (categoryId !== undefined) {
      const c = categoryId ? this.categories.get(categoryId) : undefined;
      if (categoryId && c?.workspaceId !== rec.board.workspaceId) throw invalid('categoryId', 'unknown category');
      rec.board.categoryId = categoryId;
    }
    const list = [...this.boards.values()]
      .filter((r) => r.board.workspaceId === rec.board.workspaceId && !r.board.archivedAt && r.board.categoryId === rec.board.categoryId)
      .sort((a, b) => a.board.position - b.board.position);
    const from = list.indexOf(rec);
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, rec);
    list.forEach((r, i) => {
      if (r.board.position !== i) {
        r.board.position = i;
        this.emitBoard(r, 'boardUpdate');
      }
    });
    return this.boardOut(rec, userId, { personal: true });
  }

  setPermissions(id: string, userId: string, overrides: RoomPermissionOverride[]): Board {
    const rec = this.boardFor(id, userId);
    const p = this.need(rec, userId, MANAGE_BOARD);
    if (overrides.length > 100) throw invalid('overrides', 'at most 100 targets');
    // «Not wider than your own bits» for everyone on a restricted board but the owner (ADR-0048);
    // elsewhere admins (ADMINISTRATOR) grant anything.
    const wsId = rec.board.workspaceId;
    const m = this.host.member(wsId, userId);
    const raw = m ? this.host.rolesOf(m).reduce((a, r) => a | r.permissions, 0n) : 0n;
    const admin = this.host.ownerOf(wsId) === userId || (!rec.board.restricted && !!(raw & ADMINISTRATOR));
    for (const o of overrides) {
      if ((o.allow | o.deny) & ~BOARD_BITS) throw invalid('overrides', 'only board bits');
      if (!admin && (o.allow | o.deny) & ~p) throw forbidden('cannot grant bits you lack');
    }
    const seen = this.seers(rec);
    rec.board.permissionOverrides = overrides.map((o) => clone(RoomPermissionOverrideSchema, o));
    this.emitBoard(rec, 'boardUpdate', seen);
    return this.boardOut(rec, userId, { personal: true });
  }

  // ---------------------------------------------------------------- statuses / labels / milestones

  private reorder(list: Array<{ id: string; position: number }>, id: string, index: number): void {
    const sorted = [...list].sort((a, b) => a.position - b.position);
    const item = sorted.find((x) => x.id === id);
    if (!item) return;
    sorted.splice(sorted.indexOf(item), 1);
    sorted.splice(Math.max(0, Math.min(index, sorted.length)), 0, item);
    sorted.forEach((x, i) => (x.position = i));
    list.sort((a, b) => a.position - b.position);
  }

  createStatus(id: string, userId: string, req: { name: string; type: BoardStatusType; color: number; position?: number | undefined; isDefault: boolean }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const b = rec.board;
    const name = req.name.trim();
    if (!name || chars(name) > 32) throw invalid('name', 'name must be 1..32 characters');
    if (b.statuses.length >= 20) throw conflict('at most 20 statuses', '', 'STATUS_LIMIT');
    const s = create(BoardStatusSchema, { id: this.id('status'), name, type: req.type || BoardStatusType.UNSTARTED, color: req.color, position: b.statuses.length });
    b.statuses.push(s);
    if (req.position !== undefined) this.reorder(b.statuses, s.id, req.position);
    if (req.isDefault) for (const x of b.statuses) x.isDefault = x.id === s.id;
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  updateStatus(id: string, userId: string, sid: string, req: { name?: string | undefined; type?: BoardStatusType | undefined; color?: number | undefined; position?: number | undefined; isDefault?: boolean | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const s = rec.board.statuses.find((x) => x.id === sid);
    if (!s) throw notFound('status not found');
    if (req.name !== undefined) {
      const n = req.name.trim();
      if (!n || chars(n) > 32) throw invalid('name', 'name must be 1..32 characters');
      s.name = n;
    }
    if (req.type !== undefined) s.type = req.type;
    if (req.color !== undefined) s.color = req.color;
    if (req.position !== undefined) this.reorder(rec.board.statuses, sid, req.position);
    if (req.isDefault) for (const x of rec.board.statuses) x.isDefault = x.id === sid;
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  deleteStatus(id: string, userId: string, sid: string, moveTo: string): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const s = rec.board.statuses.find((x) => x.id === sid);
    if (!s) throw notFound('status not found');
    if (s.isDefault) throw conflict('the default status cannot be deleted');
    const target = rec.board.statuses.find((x) => x.id === moveTo && x.id !== sid);
    if (!target) throw invalid('move_to', 'move_to must be another status of the board');
    for (const t of this.tasks.values()) {
      if (t.task.boardId !== id || t.task.statusId !== sid) continue;
      t.task.statusId = moveTo;
      t.task.position = this.lastPosition(id, moveTo) + 1024;
      t.task.updatedAt = this.host.tick();
      if (!t.task.archivedAt) this.emitTask(t, 'taskUpdate');
    }
    rec.board.statuses = rec.board.statuses.filter((x) => x.id !== sid);
    rec.board.statuses.forEach((x, i) => (x.position = i));
    this.emitBoard(rec, 'boardUpdate');
  }

  createLabel(id: string, userId: string, req: { name: string; color: number; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    // CREATE_TASKS may create a label on the fly (the picker's «Создать лейбл»).
    this.need(rec, userId, CREATE_TASKS | MANAGE_BOARD);
    const name = req.name.trim();
    if (!name || chars(name) > 32) throw invalid('name', 'name must be 1..32 characters');
    if (rec.board.labels.length >= 50) throw conflict('at most 50 labels');
    if (rec.board.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw conflict('label exists', 'name');
    const l = create(BoardLabelSchema, { id: this.id('label'), name, color: req.color, position: rec.board.labels.length });
    rec.board.labels.push(l);
    if (req.position !== undefined) this.reorder(rec.board.labels, l.id, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  updateLabel(id: string, userId: string, lid: string, req: { name?: string | undefined; color?: number | undefined; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const l = rec.board.labels.find((x) => x.id === lid);
    if (!l) throw notFound('label not found');
    if (req.name !== undefined) l.name = req.name.trim().slice(0, 32) || l.name;
    if (req.color !== undefined) l.color = req.color;
    if (req.position !== undefined) this.reorder(rec.board.labels, lid, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  deleteLabel(id: string, userId: string, lid: string): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    if (!rec.board.labels.some((x) => x.id === lid)) throw notFound('label not found');
    rec.board.labels = rec.board.labels.filter((x) => x.id !== lid);
    for (const t of this.tasks.values()) {
      if (t.task.boardId === id && t.task.labelIds.includes(lid)) {
        t.task.labelIds = t.task.labelIds.filter((x) => x !== lid);
        if (!t.task.archivedAt) this.emitTask(t, 'taskUpdate');
      }
    }
    this.emitBoard(rec, 'boardUpdate');
  }

  createMilestone(id: string, userId: string, req: { name: string; dueOn: string; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const name = req.name.trim();
    if (!name || chars(name) > 60) throw invalid('name', 'name must be 1..60 characters');
    const ms = create(BoardMilestoneSchema, { id: this.id('milestone'), name, dueOn: req.dueOn, position: rec.board.milestones.length });
    rec.board.milestones.push(ms);
    if (req.position !== undefined) this.reorder(rec.board.milestones, ms.id, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  updateMilestone(id: string, userId: string, mid: string, req: { name?: string | undefined; dueOn?: string | undefined; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const ms = rec.board.milestones.find((x) => x.id === mid);
    if (!ms) throw notFound('milestone not found');
    if (req.name !== undefined) ms.name = req.name.trim().slice(0, 60) || ms.name;
    if (req.dueOn !== undefined) ms.dueOn = req.dueOn;
    if (req.position !== undefined) this.reorder(rec.board.milestones, mid, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  deleteMilestone(id: string, userId: string, mid: string): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    if (!rec.board.milestones.some((x) => x.id === mid)) throw notFound('milestone not found');
    rec.board.milestones = rec.board.milestones.filter((x) => x.id !== mid);
    for (const t of this.tasks.values()) {
      if (t.task.boardId === id && t.task.milestoneId === mid) {
        t.task.milestoneId = '';
        if (!t.task.archivedAt) this.emitTask(t, 'taskUpdate');
      }
    }
    this.emitBoard(rec, 'boardUpdate');
  }

  // ---------------------------------------------------------------- views

  createView(id: string, userId: string, req: { name: string; kind: BoardViewKind; filter?: TaskFilter | undefined; groupBy: string; sort: string; shared: boolean }): BoardView {
    const rec = this.boardFor(id, userId);
    if (req.shared) this.need(rec, userId, MANAGE_BOARD);
    const name = req.name.trim();
    if (!name || chars(name) > 40) throw invalid('name', 'name must be 1..40 characters');
    const mine = rec.personal.get(userId) ?? [];
    if (rec.board.views.length + mine.length >= 30) throw conflict('at most 30 views');
    const v = create(BoardViewSchema, {
      id: this.id('view'),
      boardId: id,
      name,
      kind: req.kind || BoardViewKind.KANBAN,
      ...(req.filter ? { filter: req.filter } : {}),
      groupBy: req.groupBy,
      sort: req.sort,
      shared: req.shared,
      createdBy: userId,
      position: rec.board.views.length + mine.length,
    });
    if (req.shared) {
      rec.board.views.push(v);
      this.emitBoard(rec, 'boardUpdate');
    } else rec.personal.set(userId, [...mine, v]);
    return v;
  }

  private findView(rec: BoardRec, userId: string, vid: string): { v: BoardView; shared: boolean } {
    const shared = rec.board.views.find((x) => x.id === vid);
    if (shared) return { v: shared, shared: true };
    const own = rec.personal.get(userId)?.find((x) => x.id === vid);
    if (own) return { v: own, shared: false };
    throw notFound('view not found');
  }

  updateView(id: string, userId: string, vid: string, req: { name?: string | undefined; kind?: BoardViewKind | undefined; filter?: TaskFilter | undefined; groupBy?: string | undefined; sort?: string | undefined }): BoardView {
    const rec = this.boardFor(id, userId);
    const { v, shared } = this.findView(rec, userId, vid);
    if (shared) this.need(rec, userId, MANAGE_BOARD);
    if (req.name !== undefined) v.name = req.name.trim().slice(0, 40) || v.name;
    if (req.kind !== undefined) v.kind = req.kind;
    if (req.filter) v.filter = req.filter;
    if (req.groupBy !== undefined) v.groupBy = req.groupBy;
    if (req.sort !== undefined) v.sort = req.sort;
    if (shared) this.emitBoard(rec, 'boardUpdate');
    return v;
  }

  deleteView(id: string, userId: string, vid: string): void {
    const rec = this.boardFor(id, userId);
    const { shared } = this.findView(rec, userId, vid);
    if (shared) {
      this.need(rec, userId, MANAGE_BOARD);
      rec.board.views = rec.board.views.filter((x) => x.id !== vid);
      if (rec.board.defaultViewId === vid) rec.board.defaultViewId = '';
      this.emitBoard(rec, 'boardUpdate');
    } else rec.personal.set(userId, (rec.personal.get(userId) ?? []).filter((x) => x.id !== vid));
  }

  // ---------------------------------------------------------------- tasks

  private lastPosition(boardId: string, statusId: string): number {
    let max = 0;
    for (const t of this.tasks.values()) if (t.task.boardId === boardId && t.task.statusId === statusId && !t.task.archivedAt) max = Math.max(max, t.task.position);
    return max;
  }

  private statusType(rec: BoardRec): (id: string) => BoardStatusType {
    return (id) => rec.board.statuses.find((s) => s.id === id)?.type ?? BoardStatusType.UNSPECIFIED;
  }

  listTasks(boardId: string, userId: string, o: { filter?: TaskFilter | undefined; archived: boolean; cursor: string; limit: number; nowMs: number }): { tasks: Task[]; nextCursor: string } {
    const rec = this.boardFor(boardId, userId);
    const order = new Map(rec.board.statuses.map((s) => [s.id, s.position]));
    const archivedFilter = o.filter?.conditions.some((c) => c.field === TaskField.ARCHIVED);
    const ctx = { me: userId, statusType: this.statusType(rec), nowMs: o.nowMs };
    const all = [...this.tasks.values()]
      .filter((t) => t.task.boardId === boardId && (archivedFilter || !!t.task.archivedAt === o.archived) && matchFilter(t, o.filter, ctx))
      .sort((a, b) => (order.get(a.task.statusId) ?? 0) - (order.get(b.task.statusId) ?? 0) || a.task.position - b.task.position || a.task.id.localeCompare(b.task.id));
    const start = o.cursor ? Number(o.cursor) || 0 : 0;
    const limit = Math.max(1, Math.min(500, o.limit || 500));
    const page = all.slice(start, start + limit);
    return { tasks: page.map((t) => this.taskOut(t, userId, true)), nextCursor: start + limit < all.length ? String(start + limit) : '' };
  }

  private checkAssignees(rec: BoardRec, list: readonly Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>[]): void {
    if (list.length > 10) throw invalid('assignees', 'at most 10 assignees');
    if (list.length && list.filter((a) => a.isLead).length !== 1) throw invalid('assignees', 'exactly one lead');
    const seen = new Set<string>();
    for (const a of list) {
      if (seen.has(a.userId)) throw invalid('assignees', 'duplicate assignee');
      seen.add(a.userId);
      if (!this.perms(rec.board, a.userId)) throw invalid('assignees', 'the assignee cannot see the board');
      if (chars(a.note) > 120) throw invalid('assignees', 'note ≤ 120 characters');
    }
  }

  createTask(
    boardId: string,
    userId: string,
    req: {
      title: string;
      description: string;
      statusId: string;
      priority: TaskPriority;
      assignees: readonly Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>[];
      labelIds: readonly string[];
      startOn: string;
      dueOn: string;
      estimate: number;
      parentId: string;
      milestoneId: string;
      afterTaskId: string;
      approverIds?: readonly string[];
      approvalRequired?: number;
    },
  ): TaskRec {
    const rec = this.boardFor(boardId, userId);
    this.need(rec, userId, CREATE_TASKS);
    const approverIds = [...(req.approverIds ?? [])];
    this.requireTaskFeatures(rec.board, undefined, { ...req, approverIds });
    this.checkApprovers(rec, approverIds, req.approvalRequired ?? 0, 'approverIds', 'approvalRequired');
    const title = req.title.trim();
    if (!title || chars(title) > 200) throw invalid('title', 'title must be 1..200 characters');
    if ([...this.tasks.values()].filter((t) => t.task.boardId === boardId && !t.task.archivedAt).length >= 5000) throw conflict('too many tasks', '', 'BOARD_TASK_LIMIT');
    const status = req.statusId ? rec.board.statuses.find((s) => s.id === req.statusId) : rec.board.statuses.find((s) => s.isDefault);
    if (!status) throw invalid('status_id', 'unknown status');
    this.checkAssignees(rec, req.assignees);
    if (approverIds.length && status.type === BoardStatusType.COMPLETED) throw new BoardError(409, ErrorCode.CONFLICT, 'approval required', '', 'TASK_APPROVAL_REQUIRED', { used: 0, limit: req.approvalRequired || approverIds.length });
    for (const l of req.labelIds) if (!rec.board.labels.some((x) => x.id === l)) throw invalid('label_ids', 'unknown label');
    if (req.parentId && this.tasks.get(req.parentId)?.task.boardId !== boardId) throw invalid('parent_id', 'unknown parent');
    let position = this.lastPosition(boardId, status.id) + 1024;
    if (req.afterTaskId) {
      const after = this.tasks.get(req.afterTaskId)?.task;
      if (after && after.statusId === status.id) {
        const next = [...this.tasks.values()]
          .map((t) => t.task)
          .filter((t) => t.boardId === boardId && t.statusId === status.id && !t.archivedAt && t.position > after.position)
          .sort((a, b) => a.position - b.position)[0];
        position = next ? (after.position + next.position) / 2 : after.position + 1024;
      }
    }
    const id = this.id('task');
    const now = this.host.tick();
    const roomId = this.id('room');
    this.host.state.rooms.set(roomId, create(RoomSchema, { id: roomId, workspaceId: rec.board.workspaceId, name: `${rec.board.key}-${rec.nextNumber}`, type: RoomType.TASK }));
    const task = create(TaskSchema, {
      id,
      boardId,
      workspaceId: rec.board.workspaceId,
      number: rec.nextNumber,
      key: `${rec.board.key}-${rec.nextNumber}`,
      title,
      description: req.description.slice(0, 20000),
      statusId: status.id,
      priority: req.priority,
      assignees: req.assignees.map((a) => create(TaskAssigneeSchema, { userId: a.userId, isLead: a.isLead, note: a.note, assignedBy: userId, assignedAt: now })).sort((a, b) => Number(b.isLead) - Number(a.isLead)),
      createdBy: userId,
      estimate: req.estimate,
      startOn: req.startOn,
      dueOn: req.dueOn,
      parentId: req.parentId,
      milestoneId: req.milestoneId,
      position,
      roomId,
      labelIds: [...req.labelIds],
      approvers: approverIds.map((u) => create(TaskApproverSchema, { userId: u, state: ApproverState.PENDING, addedBy: userId, addedAt: now })),
      approvalRequired: req.approvalRequired ?? 0,
      createdAt: now,
      updatedAt: now,
      ...(status.type === BoardStatusType.STARTED ? { startedAt: now } : {}),
    });
    rec.nextNumber += 1;
    const t: TaskRec = { task, subscribers: new Map([[userId, false]]), unread: new Set() };
    for (const a of task.assignees) {
      t.subscribers.set(a.userId, false);
      if (a.userId !== userId) t.unread.add(a.userId);
    }
    for (const u of approverIds) {
      if (!t.subscribers.has(u)) t.subscribers.set(u, false);
      if (u !== userId) t.unread.add(u);
    }
    this.tasks.set(id, t);
    this.roomTask.set(roomId, id);
    if (req.parentId) this.bumpParent(req.parentId);
    this.journal(t, userId, 'created', {}, { title });
    this.emitTask(t, 'taskCreate');
    const assigned = new Set(task.assignees.map((a) => a.userId).filter((u) => u !== userId));
    if (assigned.size) this.emitTask(t, 'taskUpdate', { kind: TaskNoticeKind.ASSIGNED, actor: userId, to: assigned });
    const asked = new Set(approverIds.filter((u) => u !== userId));
    if (asked.size) this.emitTask(t, 'taskUpdate', { kind: TaskNoticeKind.APPROVAL_REQUESTED, actor: userId, to: asked });
    return t;
  }

  private bumpParent(parentId: string): void {
    const p = this.tasks.get(parentId);
    if (!p) return;
    const b = this.boards.get(p.task.boardId);
    const done = (sid: string): boolean => {
      const type = b?.board.statuses.find((s) => s.id === sid)?.type;
      return type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED;
    };
    const subs = [...this.tasks.values()].filter((x) => x.task.parentId === parentId && !x.task.archivedAt);
    p.task.subtaskCount = subs.length;
    p.task.subtaskDone = subs.filter((x) => done(x.task.statusId)).length;
    this.emitTask(p, 'taskUpdate');
  }

  /** GET /tasks/{id}: the task, subtasks, related, parent, room. */
  getTask(id: string, userId: string): { task: Task; subtasks: Task[]; related: Task[]; parent?: Task; room?: ReturnType<typeof create<typeof RoomSchema>>; board: Board } {
    const { t, b } = this.taskFor(id, userId);
    const subtasks = [...this.tasks.values()].filter((x) => x.task.parentId === id && !x.task.archivedAt).sort((x, y) => x.task.position - y.task.position);
    const relatedIds = new Set(t.task.relations.map((r) => (r.taskId === id ? r.relatedId : r.taskId)));
    const related = [...relatedIds].map((rid) => this.tasks.get(rid)).filter((x): x is TaskRec => !!x && this.perms(this.boards.get(x.task.boardId)?.board ?? create(BoardSchema), userId) !== 0n);
    const parent = t.task.parentId ? this.tasks.get(t.task.parentId) : undefined;
    const room = this.host.state.rooms.get(t.task.roomId);
    const out = this.taskOut(t, userId, true);
    out.attachments = [...t.task.attachments];
    // ADR-0058 §2: the checklists only here.
    out.checklists = this.checklistList(id).map((c) => clone(TaskChecklistSchema, c));
    return {
      task: out,
      subtasks: subtasks.map((x) => this.taskOut(x, userId, false)),
      related: related.map((x) => this.taskOut(x, userId, false)),
      ...(parent ? { parent: this.taskOut(parent, userId, false) } : {}),
      ...(room ? { room: clone(RoomSchema, room) } : {}),
      board: this.boardOut(b, userId),
    };
  }

  byKey(key: string, userId: string): string {
    const k = key.toUpperCase();
    for (const t of this.tasks.values()) {
      if (t.task.key !== k) continue;
      const b = this.boards.get(t.task.boardId);
      if (b && this.perms(b.board, userId)) return t.task.id;
    }
    throw notFound('task not found');
  }

  updateTask(
    id: string,
    userId: string,
    req: {
      title?: string | undefined;
      description?: string | undefined;
      statusId?: string | undefined;
      priority?: TaskPriority | undefined;
      estimate?: number | undefined;
      startOn?: string | undefined;
      dueOn?: string | undefined;
      parentId?: string | undefined;
      milestoneId?: string | undefined;
      setLabels?: boolean;
      labelIds?: readonly string[];
      afterTaskId?: string;
      beforeTaskId?: string;
      boardId?: string | undefined;
    },
  ): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    const task = t.task;
    const log: Array<[string, JsonObject, JsonObject]> = [];
    let notice: { kind: TaskNoticeKind; to: Set<string> } | undefined;
    if (req.boardId !== undefined && req.boardId !== task.boardId) return this.moveToBoard(t, b, userId, req.boardId);
    this.requireTaskFeatures(b.board, task, { ...req, ...(req.setLabels ? {} : { labelIds: undefined }) });
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title || chars(title) > 200) throw invalid('title', 'title must be 1..200 characters');
      log.push(['title', { title: task.title }, { title }]);
      if (title !== task.title) this.resetVotes(t, userId);
      task.title = title;
    }
    if (req.description !== undefined && req.description !== task.description) {
      log.push(['description', {}, {}]);
      this.resetVotes(t, userId);
      task.description = req.description.slice(0, 20000);
    }
    if (req.priority !== undefined && req.priority !== task.priority) {
      log.push(['priority', { priority: task.priority }, { priority: req.priority }]);
      task.priority = req.priority;
    }
    if (req.estimate !== undefined && req.estimate !== task.estimate) {
      if (req.estimate > 21) throw invalid('estimate', 'estimate 1..21');
      log.push(['estimate', { estimate: task.estimate }, { estimate: req.estimate }]);
      task.estimate = req.estimate;
    }
    if (req.startOn !== undefined || req.dueOn !== undefined) {
      const s0 = task.startOn;
      const d0 = task.dueOn;
      if (req.startOn !== undefined) task.startOn = req.startOn;
      if (req.dueOn !== undefined) task.dueOn = req.dueOn;
      if (s0 !== task.startOn || d0 !== task.dueOn) log.push(['dates', { start_on: s0, due_on: d0 }, { start_on: task.startOn, due_on: task.dueOn }]);
    }
    if (req.parentId !== undefined && req.parentId !== task.parentId) {
      if (req.parentId === id) throw invalid('parent_id', 'not itself');
      const old = task.parentId;
      log.push(['parent', { parent_id: old }, { parent_id: req.parentId }]);
      task.parentId = req.parentId;
      if (old) this.bumpParent(old);
      if (req.parentId) this.bumpParent(req.parentId);
    }
    if (req.milestoneId !== undefined && req.milestoneId !== task.milestoneId) {
      if (req.milestoneId && !b.board.milestones.some((m) => m.id === req.milestoneId)) throw invalid('milestone_id', 'unknown milestone');
      log.push(['milestone', { milestone_id: task.milestoneId }, { milestone_id: req.milestoneId }]);
      task.milestoneId = req.milestoneId;
    }
    if (req.setLabels) {
      for (const l of req.labelIds ?? []) if (!b.board.labels.some((x) => x.id === l)) throw invalid('label_ids', 'unknown label');
      log.push(['labels', { label_ids: [...task.labelIds] }, { label_ids: [...(req.labelIds ?? [])] }]);
      task.labelIds = [...(req.labelIds ?? [])];
    }
    const statusChange = req.statusId !== undefined && req.statusId !== task.statusId;
    if (req.statusId !== undefined) {
      const st = b.board.statuses.find((s) => s.id === req.statusId);
      if (!st) throw invalid('status_id', 'unknown status');
      approvalGate(task, b.board.statuses.find((s) => s.id === task.statusId), st);
      const from = task.statusId;
      task.statusId = st.id;
      // A kanban move: between the neighbours (neither = last).
      const col = [...this.tasks.values()]
        .map((x) => x.task)
        .filter((x) => x.boardId === task.boardId && x.statusId === st.id && !x.archivedAt && x.id !== id)
        .sort((x, y) => x.position - y.position);
      const a = req.afterTaskId ? col.find((x) => x.id === req.afterTaskId) : undefined;
      const bf = req.beforeTaskId ? col.find((x) => x.id === req.beforeTaskId) : undefined;
      if (a && bf) task.position = (a.position + bf.position) / 2;
      else if (a) {
        const nx = col.find((x) => x.position > a.position);
        task.position = nx ? (a.position + nx.position) / 2 : a.position + 1024;
      } else if (bf) {
        const pv = [...col].reverse().find((x) => x.position < bf.position);
        task.position = pv ? (pv.position + bf.position) / 2 : bf.position - 1024;
      } else if (statusChange) task.position = (col.at(-1)?.position ?? 0) + 1024;
      if (statusChange) {
        log.push(['status', { status_id: from, status_type: TYPE_TOKEN[this.statusType(b)(from)] ?? '' }, { status_id: st.id, status_type: TYPE_TOKEN[st.type] ?? '' }]);
        if (st.type === BoardStatusType.STARTED && !task.startedAt) task.startedAt = this.host.tick();
        if (st.type === BoardStatusType.COMPLETED || st.type === BoardStatusType.CANCELLED) {
          task.completedAt = this.host.tick();
          task.completedBy = userId;
        } else {
          delete task.completedAt;
          task.completedBy = '';
        }
        const subs = new Set([...t.subscribers].filter(([u, muted]) => !muted && u !== userId).map(([u]) => u));
        for (const u of subs) t.unread.add(u);
        notice = { kind: TaskNoticeKind.STATUS, to: subs };
        if (task.parentId) this.bumpParent(task.parentId);
      }
    }
    task.updatedAt = this.host.tick();
    for (const [kind, bf, af] of log) this.journal(t, userId, kind, bf, af);
    this.emitTask(t, 'taskUpdate', notice ? { ...notice, actor: userId } : undefined);
    return t;
  }

  /** ADR-0049 §3: a new title / description puts every vote back to pending (before the gate). */
  private resetVotes(t: TaskRec, userId: string): void {
    const voted = t.task.approvers.filter((a) => a.state !== ApproverState.PENDING);
    if (!voted.length) return;
    const approved = voted.filter((a) => a.state === ApproverState.APPROVED).length;
    for (const a of t.task.approvers) {
      a.state = ApproverState.PENDING;
      a.comment = '';
      delete a.decidedAt;
    }
    this.journal(t, userId, 'approvals_reset', { approved, rejected: voted.length - approved }, {});
    const to = new Set(t.task.approvers.map((a) => a.userId).filter((u) => u !== userId));
    for (const u of to) t.unread.add(u);
    if (to.size) this.emitTask(t, 'taskUpdate', { kind: TaskNoticeKind.APPROVAL_REQUESTED, actor: userId, to });
  }

  private checkApprovers(rec: BoardRec, ids: readonly string[], required: number, idsField: string, requiredField: string): void {
    if (ids.length > MAX_APPROVERS) throw invalid(idsField, 'at most 10 approvers');
    const seen = new Set<string>();
    ids.forEach((u, i) => {
      const m = this.host.member(rec.board.workspaceId, u);
      const bot = this.host.state.users.get(u)?.user.isBot ?? false;
      if (seen.has(u) || !m || m.role === WorkspaceRole.GUEST || bot || !this.perms(rec.board, u)) throw invalid(`${idsField}[${i}]`, 'not a possible approver');
      seen.add(u);
    });
    if (required > ids.length) throw invalid(requiredField, 'more approvals than approvers');
  }

  /** PUT /tasks/{id}/approvers: the full list and the quorum; kept votes stay, new ones pending. */
  setApprovers(id: string, userId: string, userIds: readonly string[], required: number): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    this.checkApprovers(b, userIds, required, 'userIds', 'required');
    const now = this.host.tick();
    const prev = new Map(t.task.approvers.map((a) => [a.userId, a]));
    const before = { user_ids: t.task.approvers.map((a) => a.userId), required: t.task.approvalRequired };
    t.task.approvers = userIds.map((u) => prev.get(u) ?? create(TaskApproverSchema, { userId: u, state: ApproverState.PENDING, addedBy: userId, addedAt: now }));
    t.task.approvalRequired = required;
    t.task.updatedAt = now;
    const newly = new Set(userIds.filter((u) => !prev.has(u) && u !== userId));
    for (const u of newly) {
      if (!t.subscribers.has(u)) t.subscribers.set(u, false);
      t.unread.add(u);
    }
    this.journal(t, userId, 'approvers', before, { user_ids: [...userIds], required });
    this.emitTask(t, 'taskUpdate', newly.size ? { kind: TaskNoticeKind.APPROVAL_REQUESTED, actor: userId, to: newly } : undefined);
    return t;
  }

  /**
   * PUT / DELETE /tasks/{id}/watchers (ADR-0076): an editor adds or removes anyone; a watcher removes
   * themselves. Guests are refused (422).
   */
  setWatcher(id: string, userId: string, target: string, on: boolean): TaskRec {
    const { t, p } = this.taskFor(id, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!(target === userId && !on) && !this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    const m = this.host.member(t.task.workspaceId, target);
    if (on && (!m || m.role === WorkspaceRole.GUEST)) throw invalid('userId', 'the user does not see this board');
    const before = { user_ids: [...t.task.watcherIds] };
    const has = t.task.watcherIds.includes(target);
    if (has === on) return t;
    t.task.watcherIds = on ? [...t.task.watcherIds, target].sort() : t.task.watcherIds.filter((u) => u !== target);
    if (on && !t.subscribers.has(target)) t.subscribers.set(target, false);
    t.task.updatedAt = this.host.tick();
    this.journal(t, userId, 'watchers', before, { user_ids: [...t.task.watcherIds] });
    this.emitTask(t, 'taskUpdate');
    return t;
  }

  /** POST /tasks/{id}/approval: the caller's own vote. */
  vote(id: string, userId: string, decision: TaskApprovalDecision, comment: string): TaskRec {
    const { t } = this.taskFor(id, userId);
    const a = t.task.approvers.find((x) => x.userId === userId);
    if (!a) throw forbidden('not an approver');
    if (decision === TaskApprovalDecision.UNSPECIFIED) throw invalid('decision', 'decision required');
    const text = comment.trim();
    if (decision === TaskApprovalDecision.REJECT && (!text || chars(text) > 500)) throw invalid('comment', 'a comment of 1..500 characters');
    const state = decision === TaskApprovalDecision.APPROVE ? ApproverState.APPROVED : decision === TaskApprovalDecision.REJECT ? ApproverState.REJECTED : ApproverState.PENDING;
    if (a.state === state && (state !== ApproverState.REJECTED || a.comment === text)) return t;
    const was = approvalOf(t.task);
    a.state = state;
    a.comment = state === ApproverState.REJECTED ? text : '';
    if (state === ApproverState.PENDING) delete a.decidedAt;
    else a.decidedAt = this.host.tick();
    t.task.updatedAt = this.host.tick();
    this.journal(t, userId, 'approval', {}, { user_id: userId, state: VOTE_TOKEN[state] ?? 'pending', comment: a.comment });
    const now = approvalOf(t.task);
    const kind = now === TaskApprovalState.REJECTED && state === ApproverState.REJECTED ? TaskNoticeKind.REJECTED : now === TaskApprovalState.APPROVED && was !== TaskApprovalState.APPROVED ? TaskNoticeKind.APPROVED : undefined;
    const to = new Set([t.task.createdBy, ...t.task.assignees.filter((x) => x.isLead).map((x) => x.userId)].filter((u) => u && u !== userId));
    if (kind) for (const u of to) t.unread.add(u);
    this.emitTask(t, 'taskUpdate', kind && to.size ? { kind, actor: userId, to } : undefined);
    return t;
  }

  private moveToBoard(t: TaskRec, from: BoardRec, userId: string, boardId: string): TaskRec {
    this.need(from, userId, MANAGE_BOARD);
    const to = this.boardFor(boardId, userId);
    this.need(to, userId, MANAGE_BOARD);
    const task = t.task;
    const fromType = this.statusType(from)(task.statusId);
    const st = to.board.statuses.find((s) => s.type === fromType) ?? to.board.statuses.find((s) => s.isDefault);
    if (!st) throw invalid('board_id', 'the target board has no status');
    this.emitTaskDelete(t, false, from);
    const labelNames = new Map(from.board.labels.map((l) => [l.id, l.name.toLowerCase()]));
    task.labelIds = to.board.labels.filter((l) => task.labelIds.some((id) => labelNames.get(id) === l.name.toLowerCase())).map((l) => l.id);
    task.milestoneId = '';
    task.boardId = to.board.id;
    task.number = to.nextNumber;
    task.key = `${to.board.key}-${to.nextNumber}`;
    to.nextNumber += 1;
    task.statusId = st.id;
    task.position = this.lastPosition(to.board.id, st.id) + 1024;
    task.updatedAt = this.host.tick();
    this.journal(t, userId, 'moved_board', { board_id: from.board.id }, { board_id: to.board.id });
    this.emitTask(t, 'taskCreate');
    return t;
  }

  archiveTask(id: string, userId: string, archived: boolean): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    const mayArchive = p & EDIT_TASKS || (p & CREATE_TASKS && t.task.createdBy === userId);
    if (!mayArchive) throw forbidden('cannot archive this task');
    if (archived === !!t.task.archivedAt) return t;
    if (archived) {
      t.task.archivedAt = this.host.tick();
      this.journal(t, userId, 'archived', {}, {});
      this.emitTaskDelete(t, false, b);
    } else {
      delete t.task.archivedAt;
      t.task.updatedAt = this.host.tick();
      this.journal(t, userId, 'restored', {}, {});
      this.emitTask(t, 'taskCreate');
    }
    if (t.task.parentId) this.bumpParent(t.task.parentId);
    return t;
  }

  setAssignees(id: string, userId: string, list: readonly Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>[]): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    this.checkAssignees(b, list);
    const now = this.host.tick();
    const prev = new Map(t.task.assignees.map((a) => [a.userId, a]));
    const beforeJson = t.task.assignees.map((a) => ({ user_id: a.userId, is_lead: a.isLead, note: a.note }));
    t.task.assignees = [...list]
      .sort((x, y) => Number(y.isLead) - Number(x.isLead))
      .map((a) => {
        const was = prev.get(a.userId);
        return create(TaskAssigneeSchema, { userId: a.userId, isLead: a.isLead, note: a.note, assignedBy: was?.assignedBy ?? userId, ...(was?.assignedAt ? { assignedAt: was.assignedAt } : { assignedAt: now }) });
      });
    const newly = new Set(
      t.task.assignees
        .filter((a) => a.userId !== userId && (!prev.has(a.userId) || (a.isLead && !prev.get(a.userId)?.isLead)))
        .map((a) => a.userId),
    );
    for (const u of newly) {
      if (!t.subscribers.has(u)) t.subscribers.set(u, false);
      t.unread.add(u);
    }
    t.task.updatedAt = now;
    this.journal(t, userId, 'assignees', { assignees: beforeJson }, { assignees: t.task.assignees.map((a) => ({ user_id: a.userId, is_lead: a.isLead, note: a.note })) });
    this.emitTask(t, 'taskUpdate', newly.size ? { kind: TaskNoticeKind.ASSIGNED, actor: userId, to: newly } : undefined);
    return t;
  }

  setRelation(id: string, userId: string, relatedId: string, kind: TaskRelationKind, on: boolean): TaskRec {
    const { t, p } = this.taskFor(id, userId);
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    if (relatedId === id) throw invalid('related_id', 'not itself');
    const other = this.tasks.get(relatedId);
    const ob = other ? this.boards.get(other.task.boardId) : undefined;
    if (!other || !ob || ob.board.workspaceId !== t.task.workspaceId || !this.perms(ob.board, userId)) throw invalid('related_id', 'unknown task');
    const same = (r: { taskId: string; relatedId: string; kind: TaskRelationKind }): boolean =>
      r.kind === kind && ((r.taskId === id && r.relatedId === relatedId) || (kind !== TaskRelationKind.BLOCKS && r.taskId === relatedId && r.relatedId === id));
    for (const x of [t, other]) {
      x.task.relations = x.task.relations.filter((r) => !same(r));
      if (on) x.task.relations.push(create(TaskRelationSchema, { taskId: id, relatedId, kind }));
      x.task.updatedAt = this.host.tick();
    }
    this.journal(t, userId, 'relation', on ? {} : { related_id: relatedId, kind }, on ? { related_id: relatedId, kind } : {});
    this.emitTask(t, 'taskUpdate');
    this.emitTask(other, 'taskUpdate');
    return t;
  }

  setSubscription(id: string, userId: string, muted: boolean): TaskRec {
    const { t } = this.taskFor(id, userId);
    t.subscribers.set(userId, muted);
    this.host.fanout((u) => (u === userId ? { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true) } } } : null));
    return t;
  }

  markRead(id: string, userId: string): void {
    const { t } = this.taskFor(id, userId);
    if (!t.unread.delete(userId)) return;
    this.host.fanout((u) => (u === userId ? { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true) } } } : null));
  }

  /** A comment in a task room (the message mock created it): counts, subscription, notices. */
  onComment(roomId: string, authorId: string, msg: Message, mentioned: readonly string[]): void {
    const taskId = this.roomTask.get(roomId);
    const t = taskId ? this.tasks.get(taskId) : undefined;
    if (!t) return;
    t.task.commentCount += 1;
    t.task.attachmentCount += msg.attachments.length;
    if (!t.subscribers.has(authorId)) t.subscribers.set(authorId, false);
    for (const u of mentioned) if (!t.subscribers.has(u)) t.subscribers.set(u, false);
    const to = new Set([...t.subscribers].filter(([u, muted]) => !muted && u !== authorId).map(([u]) => u));
    for (const u of to) t.unread.add(u);
    const mentionSet = new Set(mentioned.filter((u) => u !== authorId));
    const b = this.boards.get(t.task.boardId);
    if (!b) return;
    const sees = this.viewers(b);
    this.host.fanout((u) => {
      if (!sees(u)) return null;
      const kind = mentionSet.has(u) ? TaskNoticeKind.MENTIONED : to.has(u) ? TaskNoticeKind.COMMENT : undefined;
      return { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true), ...(kind ? { notice: { kind, actorId: authorId, messageId: msg.id } } : {}) } } };
    });
  }

  onCommentDeleted(roomId: string): void {
    const taskId = this.roomTask.get(roomId);
    const t = taskId ? this.tasks.get(taskId) : undefined;
    if (!t || t.task.commentCount === 0) return;
    t.task.commentCount -= 1;
    this.emitTask(t, 'taskUpdate');
  }

  /** GET /tasks/{id}/activity: comments and journal rows, newest first. */
  feed(id: string, userId: string, before: string, limit: number): { items: Array<{ message?: Message; activity?: TaskActivity }>; hasMore: boolean } {
    const { t } = this.taskFor(id, userId);
    const msgs = (this.host.state.messages.get(t.task.roomId) ?? []).map((m) => ({ at: m.createdAt ? timestampMs(m.createdAt) : 0, id: m.id, message: m }));
    const acts = this.activity.filter((a) => a.taskId === id).map((a) => ({ at: a.createdAt ? timestampMs(a.createdAt) : 0, id: a.id, activity: a }));
    const all = [...msgs, ...acts].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const start = before ? all.findIndex((x) => x.id === before) + 1 : 0;
    const n = Math.max(1, Math.min(100, limit || 50));
    const page = all.slice(start, start + n);
    return {
      items: page.map((x) => ('message' in x ? { message: x.message } : { activity: x.activity })),
      hasMore: start + n < all.length,
    };
  }

  /** GET /me/tasks. */
  mine(wsId: string, userId: string, scope: string, open: boolean): Task[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    const out: TaskRec[] = [];
    for (const t of this.tasks.values()) {
      if (t.task.workspaceId !== wsId || t.task.archivedAt) continue;
      const b = this.boards.get(t.task.boardId);
      if (!b || b.board.archivedAt || !this.perms(b.board, userId)) continue;
      const type = this.statusType(b)(t.task.statusId);
      if (open && (type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED)) continue;
      const ok =
        scope === 'lead'
          ? t.task.assignees.some((a) => a.userId === userId && a.isLead)
          : scope === 'created'
            ? t.task.createdBy === userId
            : scope === 'subscribed'
              ? t.subscribers.get(userId) === false
              : t.task.assignees.some((a) => a.userId === userId);
      if (ok) out.push(t);
    }
    out.sort((a, b) => timestampMs(b.task.updatedAt ?? ts('1970-01-01T00:00:00Z')) - timestampMs(a.task.updatedAt ?? ts('1970-01-01T00:00:00Z')) || b.task.id.localeCompare(a.task.id));
    return out.slice(0, 200).map((t) => this.taskOut(t, userId, true));
  }

  /** ⌘K search: by key (FNG-12, FNG) and words. */
  search(wsId: string, userId: string, q: string, limit: number): Task[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const words = needle.split(/\s+/);
    const out: TaskRec[] = [];
    for (const t of this.tasks.values()) {
      if (t.task.workspaceId !== wsId || t.task.archivedAt) continue;
      const b = this.boards.get(t.task.boardId);
      if (!b || !this.perms(b.board, userId)) continue;
      const key = t.task.key.toLowerCase();
      const hay = `${t.task.title} ${t.task.description}`.toLowerCase();
      if (key === needle || key.startsWith(`${needle}-`) || words.every((w) => hay.includes(w) || key.includes(w))) out.push(t);
    }
    return out.slice(0, Math.max(1, Math.min(50, limit || 20))).map((t) => this.taskOut(t, userId, false));
  }

  // ---------------------------------------------------------------- fixtures

  /**
   * Scenario `data`: «Команда Calab» has «Разработка» (CAL, development template, 8 tasks,
   * labels, a milestone, comments on CAL-3) and «Маркетинг» (MKT, simple, 2 tasks).
   */
  seed(): void {
    const ws = IDS.workspaces.main;
    const { anna, boris, vera, grigory } = IDS.users;
    const host = this.host as { fanout: BoardsHost['fanout']; tick: BoardsHost['tick'] };
    const quiet = host.fanout;
    const clock = host.tick;
    // Seeding emits nothing (nobody is connected yet) and keeps the runtime clock untouched: the
    // fixtures are dated the day before the visual-test clock, a minute apart.
    let n = 0;
    host.fanout = () => undefined;
    host.tick = () => timestampFromMs(Date.parse('2026-01-14T08:00:00Z') + n++ * 60_000);
    try {
      const dev = this.createBoard(ws, anna, { name: 'Разработка', key: 'CAL', emoji: '🛠️', isPrivate: false, description: 'Задачи продукта Calab', template: BoardTemplate.DEVELOPMENT });
      const b = dev.board.id;
      const st = (name: string): string => dev.board.statuses.find((s) => s.name === name)?.id ?? '';
      this.createLabel(b, anna, { name: 'Баг', color: 0xff453a });
      this.createLabel(b, anna, { name: 'Фича', color: 0xbf5af2 });
      this.createLabel(b, anna, { name: 'Дизайн', color: 0x0a84ff });
      this.createMilestone(b, anna, { name: 'Релиз 1.1', dueOn: '2026-01-30' });
      const lb = (name: string): string => dev.board.labels.find((l) => l.name === name)?.id ?? '';
      const milestone = dev.board.milestones[0]?.id ?? '';
      const base = { description: '', priority: TaskPriority.NONE, assignees: [] as TaskAssigneeInput[], labelIds: [] as string[], startOn: '', dueOn: '', estimate: 0, parentId: '', milestoneId: '', afterTaskId: '' };
      const lead = (u: string, note = ''): Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'> => ({ userId: u, isLead: true, note });
      const helper = (u: string, note = ''): Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'> => ({ userId: u, isLead: false, note });
      this.createTask(b, anna, { ...base, title: 'Экспорт доски в CSV', statusId: st('Backlog'), priority: TaskPriority.LOW, labelIds: [lb('Фича')] });
      this.createTask(b, anna, { ...base, title: 'Тёмная тема для публичной страницы встречи', statusId: st('Todo'), priority: TaskPriority.MEDIUM, labelIds: [lb('Дизайн')], assignees: [lead(vera)], dueOn: '2026-01-20' });
      const t3 = this.createTask(b, anna, {
        ...base,
        title: 'Эхо в звонке при включённых колонках',
        description: 'Повторяется на Windows 11 с внешними колонками. Шаги в комментариях.',
        statusId: st('В работе'),
        priority: TaskPriority.URGENT,
        labelIds: [lb('Баг')],
        assignees: [lead(boris, 'Аудиопайплайн'), helper(anna, 'Проверка на Mac')],
        startOn: '2026-01-12',
        dueOn: '2026-01-14',
        estimate: 3,
        milestoneId: milestone,
      });
      this.createTask(b, anna, { ...base, title: 'Карточки задач в чате (unfurl)', statusId: st('В работе'), priority: TaskPriority.HIGH, labelIds: [lb('Фича')], assignees: [lead(anna)], startOn: '2026-01-13', dueOn: '2026-01-15', estimate: 5, milestoneId: milestone });
      this.createTask(b, anna, { ...base, title: 'Подзадача: воспроизвести на стенде', statusId: st('Todo'), parentId: t3.task.id, assignees: [lead(boris)] });
      const review = this.createTask(b, anna, { ...base, title: 'Ревью: права досок и приватные доски', statusId: st('Ревью'), priority: TaskPriority.HIGH, assignees: [lead(grigory, 'Security-ревью')], dueOn: '2026-01-22', approverIds: [anna, boris] });
      this.createTask(b, anna, { ...base, title: 'Горячие клавиши досок', statusId: st('Готово'), priority: TaskPriority.MEDIUM, labelIds: [lb('Фича')], assignees: [lead(anna)] });
      this.createTask(b, anna, { ...base, title: 'Старый прототип канбана', statusId: st('Отменено'), priority: TaskPriority.NONE });
      this.setRelation(t3.task.id, anna, [...this.tasks.values()].find((x) => x.task.title.startsWith('Карточки'))?.task.id ?? '', TaskRelationKind.BLOCKS, true);
      const mk = this.createBoard(ws, anna, { name: 'Маркетинг', key: 'MKT', emoji: '📣', isPrivate: false, description: '', template: BoardTemplate.SIMPLE });
      const mst = (name: string): string => mk.board.statuses.find((s) => s.name === name)?.id ?? '';
      this.createTask(mk.board.id, anna, { ...base, title: 'Пост о досках задач', statusId: mst('Todo'), assignees: [lead(vera)], dueOn: '2026-01-28' });
      this.createTask(mk.board.id, anna, { ...base, title: 'Скриншоты для лендинга', statusId: mst('В работе'), assignees: [lead(anna)] });
      // ADR-0049: CAL-6 — Анна approved, Борис has not yet (the card shows ✓ 1/2). Last, so the
      // ids and times of the other fixtures stay as they were.
      this.vote(review.task.id, anna, TaskApprovalDecision.APPROVE, '');
      // ADR-0076: CAL-3 is watched by Вера and Григорий («Наблюдатели» in the panel).
      t3.task.watcherIds = [vera, grigory].sort();
      // Unread: CAL-3 for Анна (Борис commented), nothing else.
      review.unread.clear();
      t3.unread.add(anna);
      // ADR-0058 (last, so the ids above stay): a checklist on CAL-3 (1 of 3 done — «1/3» on the
      // card) and the board category «Продвижение» with «Маркетинг» in it.
      const qa = this.createChecklist(t3.task.id, anna, { title: 'Проверка' }).checklist?.id ?? '';
      this.addChecklistItem(qa, anna, { text: 'Windows 11 + колонки' });
      this.addChecklistItem(qa, anna, { text: 'macOS, встроенные динамики' });
      this.addChecklistItem(qa, anna, { text: 'Гарнитура Bluetooth' });
      const first = this.checklists.get(t3.task.id)?.[0]?.items[0]?.id ?? '';
      this.updateChecklistItem(first, boris, { done: true });
      const promo = this.createCategory(ws, anna, { name: 'Продвижение' });
      this.setOrder(ws, anna, { boards: [{ boardId: mk.board.id, categoryId: promo.id, position: 0 }], categories: [] });
    } finally {
      host.fanout = quiet;
      host.tick = clock;
    }
  }

  /** The seeded CAL-3 (comments fixture): its task and room ids. */
  taskByKey(key: string): TaskRec | undefined {
    return [...this.tasks.values()].find((t) => t.task.key === key);
  }

  /** Test helper: an update as `actor` (e.g. another user renames a task during a call). */
  updateAs(actor: string, taskId: string, patch: Parameters<BoardsMock['updateTask']>[2]): Task {
    return this.taskOut(this.updateTask(taskId, actor, patch), actor, false);
  }

  // ---------------------------------------------------------------- ADR-0058: board categories

  categoriesOf(wsId: string): BoardCategory[] {
    return [...this.categories.values()].filter((c) => c.workspaceId === wsId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  /** BOARD_CATEGORY_* go to every member of the workspace except guests. */
  private emitCategory(wsId: string, ev: EventInit['event']): void {
    const members = new Set(this.host.state.members.filter((m) => m.workspaceId === wsId && m.role !== WorkspaceRole.GUEST).map((m) => m.userId));
    this.host.fanout((u) => (members.has(u) ? ({ event: ev } as EventInit) : null));
  }

  listCategories(wsId: string, userId: string): BoardCategory[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    if (m.role === WorkspaceRole.GUEST) throw forbidden('boards are not available for guests');
    return this.categoriesOf(wsId);
  }

  private categoryFor(id: string, userId: string): BoardCategory {
    const c = this.categories.get(id);
    if (!c || !this.host.member(c.workspaceId, userId)) throw notFound('category not found');
    if (!this.mayCreateBoards(c.workspaceId, userId)) throw forbidden('CREATE_BOARDS required');
    return c;
  }

  private renumberCategories(wsId: string, moved: BoardCategory, index: number): void {
    const list = this.categoriesOf(wsId).filter((c) => c.id !== moved.id);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved);
    list.forEach((c, i) => {
      if (c.position === i && c !== moved) return;
      c.position = i;
      this.emitCategory(wsId, { case: 'boardCategoryUpdate', value: { category: c } });
    });
  }

  createCategory(wsId: string, userId: string, req: { name: string; position?: number | undefined }): BoardCategory {
    if (!this.host.member(wsId, userId)) throw notFound('workspace not found');
    if (!this.mayCreateBoards(wsId, userId)) throw forbidden('CREATE_BOARDS required');
    const name = req.name.trim();
    if (!name || chars(name) > 100) throw invalid('name', 'name must be 1..100 characters');
    const list = this.categoriesOf(wsId);
    if (list.length >= 50) throw conflict('too many board categories', '', 'BOARD_CATEGORY_LIMIT');
    const c = create(BoardCategorySchema, { id: this.id('category'), workspaceId: wsId, name, position: list.length });
    this.categories.set(c.id, c);
    this.emitCategory(wsId, { case: 'boardCategoryCreate', value: { category: c } });
    if (req.position !== undefined && req.position < list.length) this.renumberCategories(wsId, c, req.position);
    return c;
  }

  updateCategory(id: string, userId: string, req: { name?: string | undefined; position?: number | undefined }): BoardCategory {
    const c = this.categoryFor(id, userId);
    if (req.name !== undefined) {
      const name = req.name.trim();
      if (!name || chars(name) > 100) throw invalid('name', 'name must be 1..100 characters');
      c.name = name;
      this.emitCategory(c.workspaceId, { case: 'boardCategoryUpdate', value: { category: c } });
    }
    if (req.position !== undefined) this.renumberCategories(c.workspaceId, c, req.position);
    return c;
  }

  /** Its boards go to «без категории» at the end (BOARD_UPDATE each). */
  deleteCategory(id: string, userId: string): void {
    const c = this.categoryFor(id, userId);
    let end = [...this.boards.values()].filter((r) => r.board.workspaceId === c.workspaceId && !r.board.categoryId && !r.board.archivedAt).length;
    for (const r of this.boards.values()) {
      if (r.board.categoryId !== id) continue;
      r.board.categoryId = '';
      r.board.position = end++;
      this.emitBoard(r, 'boardUpdate');
    }
    this.categories.delete(id);
    this.emitCategory(c.workspaceId, { case: 'boardCategoryDelete', value: { workspaceId: c.workspaceId, categoryId: id } });
  }

  /** PUT /workspaces/{id}/boards/order: one drag & drop (MANAGE_BOARD per board, CREATE_BOARDS for categories). */
  setOrder(wsId: string, userId: string, req: { boards: ReadonlyArray<{ boardId: string; categoryId: string; position: number }>; categories: ReadonlyArray<{ categoryId: string; position: number }> }): { boards: Board[]; categories: BoardCategory[] } {
    if (!this.host.member(wsId, userId)) throw notFound('workspace not found');
    if (req.categories.length && !this.mayCreateBoards(wsId, userId)) throw forbidden('CREATE_BOARDS required to order board categories');
    const recs = req.boards.map((p, i) => {
      const r = this.boards.get(p.boardId);
      if (!r || r.board.workspaceId !== wsId || r.board.archivedAt || !this.perms(r.board, userId)) throw invalid(`boards[${i}].boardId`, 'board not found in this workspace');
      if (!(this.perms(r.board, userId) & MANAGE_BOARD)) throw forbidden('MANAGE_BOARD required on every board placed');
      if (p.categoryId && this.categories.get(p.categoryId)?.workspaceId !== wsId) throw invalid(`boards[${i}].categoryId`, 'unknown category');
      return r;
    });
    req.categories.forEach((p, i) => {
      if (this.categories.get(p.categoryId)?.workspaceId !== wsId) throw invalid(`categories[${i}].categoryId`, 'unknown category');
    });
    recs.forEach((r, i) => {
      const p = req.boards[i];
      if (!p || (r.board.categoryId === p.categoryId && r.board.position === p.position)) return;
      r.board.categoryId = p.categoryId;
      r.board.position = p.position;
      this.emitBoard(r, 'boardUpdate');
    });
    for (const p of req.categories) {
      const c = this.categories.get(p.categoryId);
      if (!c || c.position === p.position) continue;
      c.position = p.position;
      this.emitCategory(wsId, { case: 'boardCategoryUpdate', value: { category: c } });
    }
    return { boards: this.snapshot(wsId, userId).boards, categories: this.categoriesOf(wsId) };
  }

  // ---------------------------------------------------------------- ADR-0058: features and plan flags

  /** 409 FEATURE_DISABLED with the JSON field name, when `sets` and the feature is off. */
  private requireFeature(b: Board, f: BoardFeature, field: string, sets: boolean): void {
    if (sets && b.disabledFeatures.includes(f)) throw conflict(`the board feature ${BoardFeature[f]} is switched off`, field, 'FEATURE_DISABLED');
  }

  /** Every field a task write sets to a non-empty value, checked against the board's features. */
  private requireTaskFeatures(b: Board, prev: Task | undefined, req: { priority?: TaskPriority | undefined; estimate?: number | undefined; startOn?: string | undefined; dueOn?: string | undefined; labelIds?: readonly string[] | undefined; milestoneId?: string | undefined; parentId?: string | undefined; approverIds?: readonly string[] | undefined }): void {
    const sets = <T>(v: T | undefined, empty: (x: T) => boolean, same: (x: T) => boolean): boolean => v !== undefined && !empty(v) && !same(v);
    this.requireFeature(b, BoardFeature.PRIORITY, 'priority', sets(req.priority, (x) => x === TaskPriority.NONE, (x) => prev?.priority === x));
    this.requireFeature(b, BoardFeature.ESTIMATE, 'estimate', sets(req.estimate, (x) => x === 0, (x) => prev?.estimate === x));
    this.requireFeature(b, BoardFeature.START_DATE, 'startOn', sets(req.startOn, (x) => x === '', (x) => prev?.startOn === x));
    this.requireFeature(b, BoardFeature.DUE_DATE, 'dueOn', sets(req.dueOn, (x) => x === '', (x) => prev?.dueOn === x));
    this.requireFeature(b, BoardFeature.LABELS, 'labelIds', sets(req.labelIds, (x) => x.length === 0, (x) => !!prev && x.join() === prev.labelIds.join()));
    this.requireFeature(b, BoardFeature.MILESTONES, 'milestoneId', sets(req.milestoneId, (x) => x === '', (x) => prev?.milestoneId === x));
    this.requireFeature(b, BoardFeature.SUBTASKS, 'parentId', sets(req.parentId, (x) => x === '', (x) => prev?.parentId === x));
    this.requireFeature(b, BoardFeature.APPROVALS, 'approverIds', sets(req.approverIds, (x) => x.length === 0, () => false));
    // The estimate scale (ADR-0058 §3): a new value outside it is 422.
    if (req.estimate && req.estimate !== prev?.estimate) {
      const scale = b.estimateScale === EstimateScale.LINEAR ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : b.estimateScale === EstimateScale.TSHIRT ? [1, 2, 3, 5, 8] : [1, 2, 3, 5, 8, 13, 21];
      if (!scale.includes(req.estimate)) throw invalid('estimate', 'estimate outside the board scale');
    }
  }

  private planFlags(wsId: string): { checklists: boolean; webhooks: boolean } {
    const l = this.host.state.workspaces.get(wsId)?.plan?.limits;
    return { checklists: !l?.checklistsDisabled, webhooks: !l?.boardWebhooksDisabled };
  }

  // ---------------------------------------------------------------- ADR-0058: checklists

  private checklistList(taskId: string): TaskChecklist[] {
    return [...(this.checklists.get(taskId) ?? [])].sort((a, b) => a.position - b.position);
  }

  /** A write to a task's checklists: the task's edit right, the plan (PLAN_LIMIT), the feature (unless deleting). */
  private checklistWrite(taskId: string, userId: string, deleting = false): { t: TaskRec; b: BoardRec } {
    const { t, b, p } = this.taskFor(taskId, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    if (!this.planFlags(t.task.workspaceId).checklists) throw new BoardError(409, ErrorCode.CONFLICT, 'checklists is not included in the plan', '', 'PLAN_LIMIT', { used: 0, limit: 0 });
    if (!deleting) this.requireFeature(b.board, BoardFeature.CHECKLISTS, 'checklists', true);
    return { t, b };
  }

  private findChecklist(id: string): { taskId: string; c: TaskChecklist } {
    for (const [taskId, list] of this.checklists) {
      const c = list.find((x) => x.id === id);
      if (c) return { taskId, c };
    }
    throw notFound('checklist not found');
  }

  private findItem(id: string): { taskId: string; c: TaskChecklist; index: number } {
    for (const [taskId, list] of this.checklists) {
      for (const c of list) {
        const index = c.items.findIndex((x) => x.id === id);
        if (index >= 0) return { taskId, c, index };
      }
    }
    throw notFound('checklist item not found');
  }

  /** Recounts the task, journals, sends TASK_CHECKLIST_UPDATE / _DELETE (never TASK_UPDATE). */
  private afterChecklist(t: TaskRec, b: BoardRec, actor: string, c: TaskChecklist | null, deletedId: string, after: JsonObject): { checklist?: TaskChecklist; checklistTotal: number; checklistDone: number } {
    const all = this.checklistList(t.task.id);
    t.task.checklistTotal = all.reduce((n, x) => n + x.items.length, 0);
    t.task.checklistDone = all.reduce((n, x) => n + x.items.filter((i) => i.done).length, 0);
    t.task.updatedAt = this.host.tick();
    this.journal(t, actor, 'checklist', {}, after);
    const sees = this.viewers(b);
    const counts = { checklistTotal: t.task.checklistTotal, checklistDone: t.task.checklistDone };
    const base = { workspaceId: t.task.workspaceId, boardId: t.task.boardId, taskId: t.task.id, ...counts };
    if (c) {
      c.items.sort((x, y) => x.position - y.position);
      const out = clone(TaskChecklistSchema, c);
      this.host.fanout((u) => (sees(u) ? { event: { case: 'taskChecklistUpdate', value: { ...base, checklist: out } } } : null));
      return { checklist: out, ...counts };
    }
    this.host.fanout((u) => (sees(u) ? { event: { case: 'taskChecklistDelete', value: { ...base, checklistId: deletedId } } } : null));
    return counts;
  }

  createChecklist(taskId: string, userId: string, req: { title: string; position?: number | undefined }): ReturnType<BoardsMock['afterChecklist']> {
    const { t, b } = this.checklistWrite(taskId, userId);
    const title = req.title.trim();
    if (!title || chars(title) > 100) throw invalid('title', 'title must be 1..100 characters');
    const list = this.checklistList(taskId);
    if (list.length >= 10) throw conflict('too many checklists', '', 'CHECKLIST_LIMIT');
    const c = create(TaskChecklistSchema, { id: this.id('checklist'), taskId, title, position: list.length, createdBy: userId, createdAt: this.host.tick() });
    this.checklists.set(taskId, [...list, c]);
    return this.afterChecklist(t, b, userId, c, '', { checklist_id: c.id, title, action: 'created' });
  }

  updateChecklist(id: string, userId: string, req: { title?: string | undefined; position?: number | undefined }): ReturnType<BoardsMock['afterChecklist']> {
    const { taskId, c } = this.findChecklist(id);
    const { t, b } = this.checklistWrite(taskId, userId);
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title || chars(title) > 100) throw invalid('title', 'title must be 1..100 characters');
      c.title = title;
    }
    if (req.position !== undefined) {
      const list = this.checklistList(taskId).filter((x) => x.id !== id);
      list.splice(Math.max(0, Math.min(req.position, list.length)), 0, c);
      list.forEach((x, i) => (x.position = i));
    }
    return this.afterChecklist(t, b, userId, c, '', { checklist_id: id, title: c.title, action: 'renamed' });
  }

  deleteChecklist(id: string, userId: string): ReturnType<BoardsMock['afterChecklist']> {
    const { taskId, c } = this.findChecklist(id);
    const { t, b } = this.checklistWrite(taskId, userId, true);
    this.checklists.set(taskId, this.checklistList(taskId).filter((x) => x.id !== id));
    return this.afterChecklist(t, b, userId, null, id, { checklist_id: id, title: c.title, action: 'deleted' });
  }

  addChecklistItem(id: string, userId: string, req: { text: string; position?: number | undefined }): ReturnType<BoardsMock['afterChecklist']> {
    const { taskId, c } = this.findChecklist(id);
    const { t, b } = this.checklistWrite(taskId, userId);
    const text = req.text.trim();
    if (!text || chars(text) > 500) throw invalid('text', 'text must be 1..500 characters');
    if (c.items.length >= 100) throw conflict('too many items', '', 'CHECKLIST_ITEM_LIMIT');
    const position = req.position ?? (c.items.at(-1)?.position ?? 0) + 1024;
    const item = create(TaskChecklistItemSchema, { id: this.id('item'), checklistId: id, taskId, text, position, createdBy: userId, createdAt: this.host.tick() });
    c.items.push(item);
    return this.afterChecklist(t, b, userId, c, '', { checklist_id: id, title: c.title, item_id: item.id, text, action: 'item_added' });
  }

  updateChecklistItem(id: string, userId: string, req: { text?: string | undefined; done?: boolean | undefined; position?: number | undefined; checklistId?: string | undefined }): ReturnType<BoardsMock['afterChecklist']> {
    const { taskId, c, index } = this.findItem(id);
    const { t, b } = this.checklistWrite(taskId, userId);
    const item = c.items[index];
    if (!item) throw notFound('checklist item not found');
    let action = 'item_edited';
    let target = c;
    if (req.checklistId !== undefined && req.checklistId !== c.id) {
      const to = this.checklistList(taskId).find((x) => x.id === req.checklistId);
      if (!to) throw invalid('checklistId', 'not a checklist of this task');
      if (to.items.length >= 100) throw conflict('too many items', '', 'CHECKLIST_ITEM_LIMIT');
      c.items.splice(index, 1);
      item.checklistId = to.id;
      to.items.push(item);
      target = to;
      action = 'item_moved';
    }
    if (req.text !== undefined) {
      const text = req.text.trim();
      if (!text || chars(text) > 500) throw invalid('text', 'text must be 1..500 characters');
      item.text = text;
    }
    if (req.position !== undefined) {
      item.position = req.position;
      if (action === 'item_edited') action = 'item_moved';
    }
    if (req.done !== undefined && req.done !== item.done) {
      item.done = req.done;
      item.doneBy = req.done ? userId : '';
      if (req.done) item.doneAt = this.host.tick();
      else delete item.doneAt;
      action = req.done ? 'item_done' : 'item_undone';
    }
    if (target !== c) {
      // The source checklist changed too: its own event first.
      const sees = this.viewers(b);
      const out = clone(TaskChecklistSchema, c);
      this.host.fanout((u) => (sees(u) ? { event: { case: 'taskChecklistUpdate', value: { workspaceId: t.task.workspaceId, boardId: t.task.boardId, taskId, checklist: out, checklistTotal: t.task.checklistTotal, checklistDone: t.task.checklistDone } } } : null));
    }
    return this.afterChecklist(t, b, userId, target, '', { checklist_id: target.id, title: target.title, item_id: id, text: item.text, action });
  }

  deleteChecklistItem(id: string, userId: string): ReturnType<BoardsMock['afterChecklist']> {
    const { taskId, c, index } = this.findItem(id);
    const { t, b } = this.checklistWrite(taskId, userId);
    const [item] = c.items.splice(index, 1);
    return this.afterChecklist(t, b, userId, c, '', { checklist_id: c.id, title: c.title, item_id: id, text: item?.text ?? '', action: 'item_removed' });
  }

  /** POST /checklist-items/{id}/convert: a subtask with the item's text; the item goes (SUBTASKS, not a subtask). */
  convertChecklistItem(id: string, userId: string): { task: Task; checklist: TaskChecklist; checklistTotal: number; checklistDone: number } {
    const { taskId, c, index } = this.findItem(id);
    const { t, b } = this.checklistWrite(taskId, userId);
    this.requireFeature(b.board, BoardFeature.SUBTASKS, 'parentId', true);
    if (t.task.parentId) throw invalid('parentId', 'a subtask cannot have subtasks');
    const item = c.items[index];
    if (!item) throw notFound('checklist item not found');
    const sub = this.createTask(t.task.boardId, userId, { title: item.text.slice(0, 200), description: '', statusId: '', priority: TaskPriority.NONE, assignees: [], labelIds: [], startOn: '', dueOn: '', estimate: 0, parentId: taskId, milestoneId: '', afterTaskId: '' });
    c.items.splice(index, 1);
    const r = this.afterChecklist(t, b, userId, c, '', { checklist_id: c.id, title: c.title, item_id: id, text: item.text, action: 'converted' });
    return { task: this.taskOut(sub, userId, true), checklist: r.checklist ?? clone(TaskChecklistSchema, c), checklistTotal: r.checklistTotal, checklistDone: r.checklistDone };
  }

  // ---------------------------------------------------------------- ADR-0058: board webhook

  /** MANAGE_BOARD on the board and MANAGE_INTEGRATIONS of the workspace (owner / ADMINISTRATOR: all). */
  private hookFor(boardId: string, userId: string): BoardRec {
    const rec = this.boardFor(boardId, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const wsId = rec.board.workspaceId;
    const m = this.host.member(wsId, userId);
    const perms = m ? this.host.rolesOf(m).reduce((a, r) => a | r.permissions, 0n) : 0n;
    if (this.host.ownerOf(wsId) !== userId && !(perms & (ADMINISTRATOR | MANAGE_INTEGRATIONS))) throw forbidden('MANAGE_INTEGRATIONS required');
    return rec;
  }

  private hookOut(rec: BoardRec): BoardWebhook | undefined {
    const h = this.webhooks.get(rec.board.id);
    if (!h) return undefined;
    const out = clone(BoardWebhookSchema, h.hook);
    out.pausedReason = this.planFlags(rec.board.workspaceId).webhooks ? BoardWebhookPauseReason.UNSPECIFIED : BoardWebhookPauseReason.PLAN;
    return out;
  }

  private hookPlan(rec: BoardRec): void {
    if (!this.planFlags(rec.board.workspaceId).webhooks) throw new BoardError(409, ErrorCode.CONFLICT, 'board_webhooks is not included in the plan', '', 'PLAN_LIMIT', { used: 0, limit: 0 });
  }

  getWebhook(boardId: string, userId: string): { webhook?: BoardWebhook } {
    const w = this.hookOut(this.hookFor(boardId, userId));
    return w ? { webhook: w } : {};
  }

  setWebhook(boardId: string, userId: string, req: { url: string; secret: string }): { webhook?: BoardWebhook; secret: string } {
    const rec = this.hookFor(boardId, userId);
    this.hookPlan(rec);
    const url = req.url.trim();
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url) || /^https:\/\/(localhost|127\.|10\.|192\.168\.)/i.test(url) || url.length > 2048) throw invalid('url', 'https and a public address only');
    const secret = req.secret || `whsec_${'0123456789abcdef'.repeat(3)}`.slice(0, 43);
    if (chars(secret) < 16 || chars(secret) > 256) throw invalid('secret', 'secret must be 16..256 characters');
    const now = this.host.tick();
    const prev = this.webhooks.get(boardId)?.hook;
    const hook = create(BoardWebhookSchema, { boardId, url, hasSecret: true, enabled: true, createdBy: prev?.createdBy ?? userId, createdAt: prev?.createdAt ?? now, updatedAt: now, ...(prev?.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}) });
    this.webhooks.set(boardId, { hook, secret });
    const w = this.hookOut(rec);
    return { ...(w ? { webhook: w } : {}), secret };
  }

  deleteWebhook(boardId: string, userId: string): void {
    const rec = this.hookFor(boardId, userId);
    if (!this.webhooks.delete(rec.board.id)) throw notFound('webhook not found');
  }

  /** A deterministic «ping»: the receiver answers 200 (a URL with «fail» — 500). */
  pingWebhook(boardId: string, userId: string): { ok: boolean; status: number; error: string } {
    const rec = this.hookFor(boardId, userId);
    this.hookPlan(rec);
    const h = this.webhooks.get(boardId);
    if (!h) throw notFound('webhook not found');
    const fail = /fail/i.test(h.hook.url);
    if (fail) {
      h.hook.failingSince ??= this.host.tick();
      h.hook.lastError = 'HTTP 500';
      return { ok: false, status: 500, error: 'HTTP 500' };
    }
    h.hook.lastOkAt = this.host.tick();
    delete h.hook.failingSince;
    h.hook.lastError = '';
    return { ok: true, status: 200, error: '' };
  }

  /** Fixture timestamp helper for comments seeded by the server mock. */
  static at(iso: string): Timestamp {
    return timestampFromMs(Date.parse(iso));
  }
}
