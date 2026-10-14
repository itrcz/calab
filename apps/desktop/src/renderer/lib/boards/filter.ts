import { create } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  ApproverState,
  BoardStatusType,
  TaskApprovalState,
  TaskConditionSchema,
  TaskField,
  TaskFilterSchema,
  TaskOp,
  TaskRelationKind,
  type BoardStatus,
  type Task,
  type TaskFilter,
} from '@calaba/protocol';
import { fieldDef, opNeedsValue } from './filterFields';

/**
 * The universal filter on the client (ADR-0042 §3): the editable form (`FilterState`, what the
 * chips show and localStorage keeps), its conversion to / from the wire `TaskFilter` (saved views,
 * `?filter=`), and matching a task locally — the board is loaded whole, so a filter change or a
 * live TASK_UPDATE never needs a refetch. Semantics follow boards.proto `TaskField` / `TaskOp`.
 * Pure.
 */
export interface Cond {
  field: TaskField;
  op: TaskOp;
  /** Ids / tokens / "YYYY-MM-DD" dates / relative date tokens / text; numbers as strings. */
  values: string[];
}

export interface FilterState {
  conds: Cond[];
  /** Any condition instead of all. */
  any: boolean;
}

/**
 * Client-only ASSIGNEE value «бывшие участники» (ADR-0097 §4): matches a task that has an assignee
 * who is no longer a member (`MatchCtx.gone`). The server knows no such id, so a condition that
 * carries it is never sent (`toTaskFilter`).
 */
export const FORMER = '@former';

export const EMPTY_FILTER: FilterState = { conds: [], any: false };

/** A condition is complete (applies) when its op needs no value or it has one. */
export function complete(c: Cond): boolean {
  return !opNeedsValue(c.op) || c.values.some((v) => v !== '');
}

export function activeConds(f: FilterState): Cond[] {
  return f.conds.filter(complete);
}

// ------------------------------------------------------------------ wire conversion

const DAY = 86_400_000;

function utcDayMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function utcKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The wire form: instants (created / updated) as from / to; ESTIMATE GT / LT as `number`. */
export function toTaskFilter(f: FilterState): TaskFilter {
  const conditions = activeConds(f)
    .filter((c) => !c.values.includes(FORMER))
    .map((c) => {
    const def = fieldDef(c.field);
    if (def?.kind === 'datetime') {
      const [a = '', b = ''] = c.values;
      const init: Parameters<typeof create<typeof TaskConditionSchema>>[1] = { field: c.field, op: c.op };
      if (c.op === TaskOp.BEFORE && ISO_DAY.test(a)) init.to = timestampFromMs(utcDayMs(a));
      else if (c.op === TaskOp.AFTER && ISO_DAY.test(a)) init.from = timestampFromMs(utcDayMs(a));
      else if (c.op === TaskOp.BETWEEN && ISO_DAY.test(a) && ISO_DAY.test(b)) {
        init.from = timestampFromMs(utcDayMs(a));
        init.to = timestampFromMs(utcDayMs(b) + DAY - 1);
      }
      return create(TaskConditionSchema, init);
    }
    if (c.field === TaskField.ESTIMATE && (c.op === TaskOp.GT || c.op === TaskOp.LT)) {
      return create(TaskConditionSchema, { field: c.field, op: c.op, number: Number(c.values[0] ?? 0) || 0 });
    }
    return create(TaskConditionSchema, { field: c.field, op: c.op, values: opNeedsValue(c.op) ? c.values.filter((v) => v !== '') : [] });
  });
  return create(TaskFilterSchema, { conditions, any: f.any });
}

export function fromTaskFilter(tf: TaskFilter | undefined): FilterState {
  if (!tf) return EMPTY_FILTER;
  const conds: Cond[] = [];
  for (const c of tf.conditions) {
    const def = fieldDef(c.field);
    if (!def) continue; // a field this client does not know: dropped from the chips
    if (def.kind === 'datetime') {
      const from = c.from ? utcKey(timestampMs(c.from)) : '';
      const to = c.to ? utcKey(timestampMs(c.to)) : '';
      const values = c.op === TaskOp.BETWEEN ? [from, to] : c.op === TaskOp.BEFORE ? [to] : [from];
      conds.push({ field: c.field, op: c.op, values });
      continue;
    }
    if (c.field === TaskField.ESTIMATE && (c.op === TaskOp.GT || c.op === TaskOp.LT)) {
      conds.push({ field: c.field, op: c.op, values: [String(c.number)] });
      continue;
    }
    conds.push({ field: c.field, op: c.op, values: [...c.values] });
  }
  return { conds, any: tf.any };
}

// ------------------------------------------------------------------ editing

export function addCond(f: FilterState, field: TaskField, values: string[] = []): FilterState {
  const def = fieldDef(field);
  if (!def) return f;
  return { ...f, conds: [...f.conds, { field, op: def.op, values }] };
}

export function setCond(f: FilterState, index: number, patch: Partial<Cond>): FilterState {
  return { ...f, conds: f.conds.map((c, i) => (i === index ? { ...c, ...patch } : c)) };
}

export function removeCond(f: FilterState, index: number): FilterState {
  return { ...f, conds: f.conds.filter((_, i) => i !== index) };
}

/** Checks / unchecks a value of a multi-value condition (single-value fields replace it). */
export function toggleValue(c: Cond, value: string): Cond {
  const multi = fieldDef(c.field)?.multi ?? false;
  if (!multi) return { ...c, values: [value] };
  return { ...c, values: c.values.includes(value) ? c.values.filter((v) => v !== value) : [...c.values, value] };
}

// ------------------------------------------------------------------ quick chips

export type QuickChip = 'mine' | 'overdue' | 'unassigned' | 'approval';

const QUICK: Record<QuickChip, Cond> = {
  mine: { field: TaskField.ASSIGNEE, op: TaskOp.IS, values: ['me'] },
  // «Ждут моего согласования» (ADR-0049): my vote is still pending.
  approval: { field: TaskField.APPROVER_PENDING, op: TaskOp.IS, values: ['me'] },
  overdue: { field: TaskField.DUE_ON, op: TaskOp.BEFORE, values: ['today'] },
  unassigned: { field: TaskField.ASSIGNEE, op: TaskOp.EMPTY, values: [] },
};

const sameCond = (a: Cond, b: Cond): boolean => a.field === b.field && a.op === b.op && a.values.join('\u0000') === b.values.join('\u0000');

export function quickOn(f: FilterState, chip: QuickChip): boolean {
  return f.conds.some((c) => sameCond(c, QUICK[chip]));
}

/** Toggles a quick chip: adds its condition, or removes it (mine / unassigned exclude each other). */
export function toggleQuick(f: FilterState, chip: QuickChip): FilterState {
  if (quickOn(f, chip)) return { ...f, conds: f.conds.filter((c) => !sameCond(c, QUICK[chip])) };
  const other: QuickChip | null = chip === 'mine' ? 'unassigned' : chip === 'unassigned' ? 'mine' : null;
  const conds = other ? f.conds.filter((c) => !sameCond(c, QUICK[other])) : f.conds;
  return { ...f, conds: [...conds, { ...QUICK[chip], values: [...QUICK[chip].values] }] };
}

// ------------------------------------------------------------------ dates

/** "today", "week_start", "week_end", "month_end", "-7d", "+14d" → "YYYY-MM-DD" (local `today`). */
export function resolveDay(value: string, today: string): string {
  if (ISO_DAY.test(value)) return value;
  const base = utcDayMs(today);
  const dow = (new Date(base).getUTCDay() + 6) % 7; // Monday = 0
  switch (value) {
    case 'today':
      return today;
    case 'week_start':
      return utcKey(base - dow * DAY);
    case 'week_end':
      return utcKey(base + (6 - dow) * DAY);
    case 'month_end': {
      const d = new Date(base);
      return utcKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    }
    default: {
      const m = /^([+-]\d{1,4})d$/.exec(value);
      return m ? utcKey(base + Number(m[1]) * DAY) : today;
    }
  }
}

// ------------------------------------------------------------------ matching

export interface MatchCtx {
  me: string;
  /** The board's statuses by id (status type of a task). */
  statuses: Readonly<Record<string, Pick<BoardStatus, 'type'>>>;
  /** Today's key in the viewer's zone ("YYYY-MM-DD"). */
  today: string;
  /** Not a member of the workspace any more (ADR-0097); absent = nobody is. */
  gone?: (userId: string) => boolean;
}

const TYPE_TOKEN: Record<number, string> = {
  [BoardStatusType.BACKLOG]: 'backlog',
  [BoardStatusType.UNSTARTED]: 'unstarted',
  [BoardStatusType.STARTED]: 'started',
  [BoardStatusType.COMPLETED]: 'completed',
  [BoardStatusType.CANCELLED]: 'cancelled',
};

const PRIORITY_TOKEN: Record<string, string> = { none: '0', low: '1', medium: '2', high: '3', urgent: '4' };

/** Task.approvalState → the APPROVAL_STATE filter value (ADR-0049). */
const APPROVAL_TOKEN: Record<number, string> = {
  [TaskApprovalState.NONE]: 'none',
  [TaskApprovalState.PENDING]: 'pending',
  [TaskApprovalState.APPROVED]: 'approved',
  [TaskApprovalState.REJECTED]: 'rejected',
};

const me = (v: string, ctx: MatchCtx): string => (v === 'me' ? ctx.me : v);

function setMatch(have: readonly string[], c: Cond, ctx: MatchCtx, all = false): boolean {
  const want = c.values.map((v) => me(v, ctx));
  switch (c.op) {
    case TaskOp.IS:
      return all ? want.every((v) => have.includes(v)) : want.some((v) => have.includes(v));
    case TaskOp.ANY_OF:
      return want.some((v) => have.includes(v));
    case TaskOp.IS_NOT:
    case TaskOp.NONE_OF:
      return !want.some((v) => have.includes(v));
    case TaskOp.EMPTY:
      return have.length === 0;
    case TaskOp.NOT_EMPTY:
      return have.length > 0;
    default:
      return true;
  }
}

function dateMatch(day: string, c: Cond, ctx: MatchCtx): boolean {
  if (c.op === TaskOp.EMPTY) return day === '';
  if (c.op === TaskOp.NOT_EMPTY) return day !== '';
  if (day === '') return false;
  const [a = '', b = ''] = c.values.map((v) => resolveDay(v, ctx.today));
  switch (c.op) {
    case TaskOp.BEFORE:
      return day < a;
    case TaskOp.AFTER:
      return day >= a;
    case TaskOp.BETWEEN:
      return day >= a && day <= b;
    default:
      return true;
  }
}

function instantDay(ts: Task['createdAt']): string {
  return ts ? utcKey(timestampMs(ts)) : '';
}

function relationTokens(t: Task): string[] {
  const out = new Set<string>();
  for (const r of t.relations) {
    if (r.kind === TaskRelationKind.BLOCKS) out.add(r.taskId === t.id ? 'blocks' : 'blocked');
    else if (r.kind === TaskRelationKind.RELATES) out.add('relates');
    else if (r.kind === TaskRelationKind.DUPLICATES) out.add('duplicates');
  }
  return [...out];
}

function boolMatch(v: boolean, c: Cond): boolean {
  if (c.op === TaskOp.EMPTY) return !v;
  if (c.op === TaskOp.NOT_EMPTY) return v;
  return (c.values[0] ?? 'true') === 'true' ? v : !v;
}

/** setMatch() that also understands the FORMER token (an assignee who left). */
function assigneeMatch(have: readonly string[], c: Cond, ctx: MatchCtx): boolean {
  if (!c.values.includes(FORMER)) return setMatch(have, c, ctx);
  const rest = { ...c, values: c.values.filter((v) => v !== FORMER) };
  const former = !!ctx.gone && have.some((id) => ctx.gone?.(id));
  const other = rest.values.length > 0 && setMatch(have, rest, ctx);
  if (c.op === TaskOp.IS_NOT || c.op === TaskOp.NONE_OF) return !former && (rest.values.length === 0 || setMatch(have, rest, ctx));
  return former || other;
}

export function matchCond(t: Task, c: Cond, ctx: MatchCtx): boolean {
  switch (c.field) {
    case TaskField.STATUS:
      return setMatch([t.statusId], c, ctx);
    case TaskField.STATUS_TYPE:
      return setMatch([TYPE_TOKEN[ctx.statuses[t.statusId]?.type ?? 0] ?? ''], c, ctx);
    case TaskField.ASSIGNEE:
      return assigneeMatch(
        t.assignees.map((a) => a.userId),
        c,
        ctx,
      );
    case TaskField.LEAD:
      return setMatch(
        t.assignees.filter((a) => a.isLead).map((a) => a.userId),
        c,
        ctx,
      );
    case TaskField.CREATOR:
      return setMatch([t.createdBy], c, ctx);
    case TaskField.SUBSCRIBER:
      // Only my own subscription is known to the client.
      return c.values.some((v) => me(v, ctx) === ctx.me) ? t.subscribed && !t.muted : false;
    case TaskField.PRIORITY: {
      const values = c.values.map((v) => PRIORITY_TOKEN[v] ?? v);
      return setMatch([String(t.priority)], { ...c, values }, ctx);
    }
    case TaskField.ESTIMATE: {
      const n = Number(c.values[0] ?? 0);
      if (c.op === TaskOp.EMPTY) return t.estimate === 0;
      if (c.op === TaskOp.NOT_EMPTY) return t.estimate > 0;
      if (c.op === TaskOp.GT) return t.estimate > n;
      if (c.op === TaskOp.LT) return t.estimate > 0 && t.estimate < n;
      return setMatch([String(t.estimate)], c, ctx);
    }
    case TaskField.LABEL:
      return setMatch(t.labelIds, c, ctx, true);
    case TaskField.MILESTONE:
      return setMatch(t.milestoneId ? [t.milestoneId] : [], c, ctx);
    case TaskField.PARENT:
      return setMatch(t.parentId ? [t.parentId] : [], c, ctx);
    case TaskField.RELATION:
      return setMatch(relationTokens(t), c, ctx);
    case TaskField.CREATED_AT:
      return dateMatch(instantDay(t.createdAt), c, ctx);
    case TaskField.UPDATED_AT:
      return dateMatch(instantDay(t.updatedAt), c, ctx);
    case TaskField.START_ON:
      return dateMatch(t.startOn, c, ctx);
    case TaskField.DUE_ON:
      return dateMatch(t.dueOn, c, ctx);
    case TaskField.HAS_ATTACHMENTS:
      return boolMatch(t.attachmentCount > 0, c);
    case TaskField.HAS_COMMENTS:
      return boolMatch(t.commentCount > 0, c);
    case TaskField.ARCHIVED:
      return boolMatch(!!t.archivedAt, c);
    case TaskField.APPROVAL_STATE:
      return setMatch([APPROVAL_TOKEN[t.approvalState] ?? 'none'], c, ctx);
    case TaskField.APPROVER_PENDING:
      return setMatch(
        t.approvers.filter((a) => a.state === ApproverState.PENDING).map((a) => a.userId),
        c,
        ctx,
      );
    case TaskField.TEXT: {
      const q = (c.values[0] ?? '').trim().toLowerCase();
      if (!q) return true;
      const hay = `${t.key} ${t.title} ${t.description}`.toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    }
    default:
      return true;
  }
}

/** Does the task pass the filter? (An empty filter passes everything.) */
export function matchTask(t: Task, f: FilterState, ctx: MatchCtx): boolean {
  const conds = activeConds(f);
  if (conds.length === 0) return true;
  return f.any ? conds.some((c) => matchCond(t, c, ctx)) : conds.every((c) => matchCond(t, c, ctx));
}

/** Completed / cancelled — hidden unless «Показывать завершённые». */
export function isDone(t: Pick<Task, 'statusId'>, statuses: MatchCtx['statuses']): boolean {
  const type = statuses[t.statusId]?.type;
  return type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED;
}

/** Stable text of a filter for comparisons (the view is «изменён»). */
export function filterKey(f: FilterState): string {
  return JSON.stringify([f.any, activeConds(f).map((c) => [c.field, c.op, c.values])]);
}
