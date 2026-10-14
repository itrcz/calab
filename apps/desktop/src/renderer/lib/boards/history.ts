import { TaskPriority, type TaskActivity, type TaskActivityItem } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { t, type MessageKey } from '../../i18n';
import { fmt } from '../format';
import { diffStats, diffText, diffable } from '../textDiff';

/**
 * The task history (ADR-0091 §2): one journal entry (`TaskActivity`, before / after JSON of
 * boards.proto) as a timeline row — an action sentence that always names the field and the values
 * («статус: To Do → В работе», «лейблы: +Баг, −Фича») and the details shown on a click (a word
 * diff, a quote, ± chips, task cards). Values come from the snapshots in the entry (ADR-0091 §3);
 * an older entry without them falls back to what the client holds (`HistoryCtx`, by id). Pure
 * apart from `t()` / `fmt`.
 */

export interface FileSnap {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface Chip {
  id: string;
  label: string;
  /** A label's colour (0xRRGGBB). */
  color?: number;
  kind: 'file' | 'label' | 'person';
}

export interface TaskRef {
  id: string;
  key: string;
  title: string;
}

export interface HistoryDetail {
  /** Title / description / comment text: a word diff (or «Было / Стало» when too long). */
  diff?: { before: string; after: string; diffable: boolean };
  /** A comment (or the deleted one): its text and files. */
  quote?: { text: string; files: FileSnap[] };
  /** ± chips: files, labels, people. */
  added?: Chip[];
  removed?: Chip[];
  /** Parent / relation: task cards (`removed` — the link that went away). */
  tasks?: Array<{ ref: TaskRef; removed: boolean }>;
  /** An approval's comment and the like. */
  note?: string;
}

export interface HistoryEntry {
  id: string;
  at: number;
  actorId: string;
  ruleId: string;
  kind: string;
  /** The action sentence after the actor's name. */
  text: string;
  detail: HistoryDetail | null;
}

/** What the client knows by id — the fallback for entries without snapshots. */
export interface HistoryCtx {
  member(id: string): string;
  status(id: string): string | undefined;
  label(id: string): { name: string; color: number } | undefined;
  milestone(id: string): string | undefined;
  /** A subtask's milestone (ADR-0063): one of its parent's milestones. */
  taskMilestone(parentId: string, id: string): string | undefined;
  task(id: string): TaskRef | undefined;
  estimate(n: number): string;
}

type Json = Readonly<Record<string, unknown>> | undefined;

const NONE = '—';

const PRIORITY: Record<number, MessageKey> = {
  [TaskPriority.NONE]: 'boards.prio.none',
  [TaskPriority.LOW]: 'boards.prio.low',
  [TaskPriority.MEDIUM]: 'boards.prio.medium',
  [TaskPriority.HIGH]: 'boards.prio.high',
  [TaskPriority.URGENT]: 'boards.prio.urgent',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : 0);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ids = (v: unknown): string[] => arr(v).map(str).filter(Boolean);

/** «отчёт.pdf» etc.: a file snapshot `{file_id, name, size, mime}`. */
function files(v: unknown): FileSnap[] {
  return arr(v).flatMap((x) => {
    const o = obj(x);
    const id = str(o?.['file_id'] ?? o?.['id']);
    return o && id ? [{ id, name: str(o['name']), size: num(o['size']), mime: str(o['mime']) }] : [];
  });
}

/** «12 янв.» (the year when not this one) for a calendar date `YYYY-MM-DD`. */
export function formatDay(iso: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso || NONE;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === now.getFullYear() ? fmt.dayMonth(d) : fmt.shortDate(d);
}

/** A short quote for a row: one line, ≤ `max` characters. */
export function clip(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** «+Анна, −Борис» from the chips. */
function changes(added: readonly Chip[], removed: readonly Chip[]): string {
  return [...added.map((c) => `+${c.label}`), ...removed.map((c) => `−${c.label}`)].join(', ');
}

/** The ± of two id lists, in their order. */
function delta(was: readonly string[], now: readonly string[]): { added: string[]; removed: string[] } {
  return { added: now.filter((x) => !was.includes(x)), removed: was.filter((x) => !now.includes(x)) };
}

function taskRefText(r: TaskRef): string {
  return r.title ? `${r.key} «${clip(r.title, 40)}»` : r.key || NONE;
}

/** A task by its snapshot (`{key, title}` next to the id, ADR-0091 §3) or the client's copy. */
function taskRef(o: Json, idKey: string, ctx: HistoryCtx): TaskRef | null {
  const id = str(o?.[idKey]);
  if (!id) return null;
  const known = ctx.task(id);
  const key = str(o?.['key']) || known?.key || '';
  const title = str(o?.['title']) || known?.title || '';
  return { id, key: key || NONE, title };
}

const REL_KIND: Record<string, MessageKey> = {
  '1': 'boards.act.rel.blocks',
  blocks: 'boards.act.rel.blocks',
  '2': 'boards.act.rel.relates',
  relates: 'boards.act.rel.relates',
  '3': 'boards.act.rel.duplicates',
  duplicates: 'boards.act.rel.duplicates',
};

function entry(a: TaskActivity, text: string, detail: HistoryDetail | null = null): HistoryEntry {
  return { id: a.id, at: a.createdAt ? timestampMs(a.createdAt) : 0, actorId: a.actorId, ruleId: a.ruleId, kind: a.kind, text, detail };
}

/** One journal entry as a history row. Unknown kinds — «изменил(а) задачу». */
export function describe(a: TaskActivity, ctx: HistoryCtx, now = new Date()): HistoryEntry {
  const b = a.before as Json;
  const f = a.after as Json;
  const person = (id: string): Chip => ({ id, label: ctx.member(id), kind: 'person' });
  switch (a.kind) {
    case 'created':
      return entry(a, t('boards.act.created'));
    case 'status':
      return entry(a, t('boards.act.status', { from: ctx.status(str(b?.['status_id'])) ?? NONE, to: ctx.status(str(f?.['status_id'])) ?? NONE }));
    case 'priority':
      return entry(a, t('boards.act.priority', { from: t(PRIORITY[num(b?.['priority'])] ?? 'boards.prio.none'), to: t(PRIORITY[num(f?.['priority'])] ?? 'boards.prio.none') }));
    case 'estimate': {
      const v = (o: Json): string => (num(o?.['estimate']) ? ctx.estimate(num(o?.['estimate'])) : NONE);
      return entry(a, t('boards.act.estimate', { from: v(b), to: v(f) }));
    }
    case 'dates': {
      const parts: string[] = [];
      const day = (o: Json, k: string): string => (str(o?.[k]) ? formatDay(str(o?.[k]), now) : NONE);
      if (str(b?.['start_on']) !== str(f?.['start_on'])) parts.push(t('boards.act.start', { from: day(b, 'start_on'), to: day(f, 'start_on') }));
      if (str(b?.['due_on']) !== str(f?.['due_on'])) parts.push(t('boards.act.due', { from: day(b, 'due_on'), to: day(f, 'due_on') }));
      return entry(a, parts.join(', ') || t('boards.act.changed'));
    }
    case 'title': {
      const from = str(b?.['title']);
      const to = str(f?.['title']);
      return entry(a, t('boards.act.title', { from: clip(from, 40), to: clip(to, 40) }), { diff: { before: from, after: to, diffable: true } });
    }
    case 'description': {
      const hasText = typeof b?.['text'] === 'string' || typeof f?.['text'] === 'string';
      if (!hasText) return entry(a, t('boards.act.descriptionPlain'));
      const from = str(b?.['text']);
      const to = str(f?.['text']);
      const ok = diffable(from, to);
      // Long texts: the counters from the lengths (a diff of 40 KB is not worth it on every render).
      const s = ok ? diffStats(diffText(from, to)) : { added: Math.max(0, to.length - from.length), removed: Math.max(0, from.length - to.length) };
      return entry(a, t('boards.act.description', { added: s.added, removed: s.removed }), { diff: { before: from, after: to, diffable: ok } });
    }
    case 'assignees': {
      const list = (o: Json): Array<{ id: string; lead: boolean; note: string }> =>
        arr(o?.['assignees']).flatMap((x) => {
          const y = obj(x);
          const id = str(y?.['user_id']);
          return id ? [{ id, lead: y?.['is_lead'] === true, note: str(y?.['note']) }] : [];
        });
      const was = list(b);
      const now2 = list(f);
      const d = delta(was.map((x) => x.id), now2.map((x) => x.id));
      const added = d.added.map(person);
      const removed = d.removed.map(person);
      if (added.length || removed.length) return entry(a, t('boards.act.assignees', { changes: changes(added, removed) }), { added, removed });
      const leadWas = was.find((x) => x.lead)?.id ?? '';
      const leadNow = now2.find((x) => x.lead)?.id ?? '';
      if (leadWas !== leadNow) return entry(a, t('boards.act.lead', { from: leadWas ? ctx.member(leadWas) : NONE, to: leadNow ? ctx.member(leadNow) : NONE }));
      const noted = now2.filter((x) => was.find((y) => y.id === x.id)?.note !== x.note);
      if (noted.length) {
        return entry(a, t('boards.act.assigneeNotes', { names: noted.map((x) => ctx.member(x.id)).join(', ') }), { note: noted.map((x) => `${ctx.member(x.id)}: ${x.note || NONE}`).join('\n') });
      }
      return entry(a, t('boards.act.changed'));
    }
    case 'watchers':
    case 'approvers': {
      const d = delta(ids(b?.['user_ids']), ids(f?.['user_ids']));
      const added = d.added.map(person);
      const removed = d.removed.map(person);
      const parts: string[] = [];
      if (added.length || removed.length) parts.push(t(a.kind === 'watchers' ? 'boards.act.watchers' : 'boards.act.approvers', { changes: changes(added, removed) }));
      if (a.kind === 'approvers') {
        const req = num(f?.['required']);
        const total = ids(f?.['user_ids']).length;
        if (req !== num(b?.['required']) && total > 0) parts.push(t('boards.act.quorum', { n: req > 0 && req < total ? req : total, m: total }));
      }
      return entry(a, parts.join(', ') || t('boards.act.changed'), added.length || removed.length ? { added, removed } : null);
    }
    case 'labels': {
      // Snapshots `labels: [{id, name, color}]` (ADR-0091 §3), else the board's labels by id.
      const snap = new Map<string, { name: string; color: number }>();
      for (const o of [b, f]) for (const x of arr(o?.['labels'])) {
        const y = obj(x);
        if (y && str(y['id'])) snap.set(str(y['id']), { name: str(y['name']), color: num(y['color']) });
      }
      const chip = (id: string): Chip => {
        const l = snap.get(id) ?? ctx.label(id);
        return { id, label: l?.name || NONE, kind: 'label', ...(l ? { color: l.color } : {}) };
      };
      const d = delta(ids(b?.['label_ids']), ids(f?.['label_ids']));
      const added = d.added.map(chip);
      const removed = d.removed.map(chip);
      return entry(a, added.length || removed.length ? t('boards.act.labels', { changes: changes(added, removed) }) : t('boards.act.changed'), { added, removed });
    }
    case 'attachments': {
      const snap = new Map<string, FileSnap>();
      for (const o of [b, f]) for (const x of files(o?.['files'])) snap.set(x.id, x);
      const d = delta(ids(b?.['file_ids']), ids(f?.['file_ids']));
      if (!snap.size) return entry(a, t('boards.act.attachmentsCount', { from: ids(b?.['file_ids']).length, to: ids(f?.['file_ids']).length }));
      const chip = (id: string): Chip => ({ id, label: snap.get(id)?.name || NONE, kind: 'file' });
      const added = d.added.map(chip);
      const removed = d.removed.map(chip);
      return entry(a, t('boards.act.attachments', { changes: changes(added, removed) }), { added, removed });
    }
    case 'milestone': {
      const name = (o: Json): string => str(o?.['name']) || (str(o?.['milestone_id']) ? (ctx.milestone(str(o?.['milestone_id'])) ?? NONE) : '');
      const from = name(b);
      const to = name(f);
      if (!from) return entry(a, t('boards.act.milestoneSet', { name: to || NONE }));
      if (!to) return entry(a, t('boards.act.milestoneCleared', { name: from }));
      return entry(a, t('boards.act.milestone', { from, to }));
    }
    case 'parent': {
      const from = taskRef(b, 'parent_id', ctx);
      const to = taskRef(f, 'parent_id', ctx);
      const tasks = [...(to ? [{ ref: to, removed: false }] : []), ...(from ? [{ ref: from, removed: true }] : [])];
      if (to) return entry(a, t('boards.act.parent', { task: taskRefText(to) }), { tasks });
      return entry(a, from ? t('boards.act.parentRemoved', { task: taskRefText(from) }) : t('boards.act.changed'), tasks.length ? { tasks } : null);
    }
    case 'relation': {
      const added = !!f && !!str(f['related_id']);
      const o = added ? f : b;
      const ref = taskRef(o, 'related_id', ctx);
      const kind = t(REL_KIND[str(o?.['kind'])] ?? 'boards.act.rel.relates');
      if (!ref) return entry(a, t('boards.act.changed'));
      return entry(a, t(added ? 'boards.act.relation' : 'boards.act.relationRemoved', { kind, task: ref.key }), { tasks: [{ ref, removed: !added }] });
    }
    case 'archived':
      return entry(a, t('boards.act.archived'));
    case 'restored':
      return entry(a, t('boards.act.restored'));
    case 'moved_board': {
      const from = str(b?.['key']);
      const to = str(f?.['key']);
      return entry(a, from && to ? t('boards.act.moved', { from, to }) : t('boards.act.movedPlain'));
    }
    case 'approval': {
      const state = str(f?.['state']);
      const comment = str(f?.['comment']);
      const note = comment ? { note: comment } : null;
      if (state === 'approved') return entry(a, t('boards.act.approved'), note);
      if (state === 'rejected') return entry(a, t('boards.act.rejected', { comment: clip(comment, 60) }), note);
      return entry(a, t('boards.act.withdrawn'));
    }
    case 'approvals_reset':
      return entry(a, t('boards.act.approvalsReset'));
    case 'comment': {
      const text = str(f?.['text']);
      const att = files(f?.['attachments']);
      const line = text ? t('boards.act.comment', { text: clip(text) }) : att.length ? t('boards.act.commentFiles', { files: att.map((x) => x.name).join(', ') }) : t('boards.act.commentPlain');
      return entry(a, line, { quote: { text, files: att } });
    }
    case 'comment_edit': {
      const from = str(b?.['text']);
      const to = str(f?.['text']);
      const was = files(b?.['attachments']);
      const now2 = files(f?.['attachments']);
      const d = delta(was.map((x) => x.id), now2.map((x) => x.id));
      const name = (id: string): string => [...was, ...now2].find((x) => x.id === id)?.name || NONE;
      const added = d.added.map((id): Chip => ({ id, label: name(id), kind: 'file' }));
      const removed = d.removed.map((id): Chip => ({ id, label: name(id), kind: 'file' }));
      return entry(a, t('boards.act.commentEdit'), { ...(from !== to ? { diff: { before: from, after: to, diffable: diffable(from, to) } } : {}), added, removed });
    }
    case 'comment_delete': {
      const author = str(b?.['author_id']);
      const text = str(b?.['text']);
      const line = !author || author === a.actorId ? t('boards.act.commentDeleteOwn') : t('boards.act.commentDelete', { author: ctx.member(author) });
      return entry(a, line, { quote: { text, files: files(b?.['attachments']) } });
    }
    case 'checklist':
      return entry(a, checklistText(f));
    case 'milestones':
      return entry(a, milestonesText(f, ctx, now));
    case 'git':
      return entry(a, gitText(f));
    default:
      return entry(a, t('boards.act.changed'));
  }
}

/** A «git» entry (ADR-0060 §4): after {event, kind, repo, ref, state…}. */
function gitText(f: Json): string {
  const s = (k: string): string => str(f?.[k]);
  const kind = s('kind');
  const ref = kind === 'pr' ? `${s('repo')}#${s('ref')}` : kind === 'commit' ? `${s('repo')}@${s('ref').slice(0, 7)}` : s('ref');
  if (kind === 'pr' && s('state') === 'merged') return t('boards.act.gitMerged', { ref });
  if (kind === 'pr' && s('state') === 'closed') return t('boards.act.gitClosed', { ref });
  return t('boards.act.git', { what: t(kind === 'pr' ? 'boards.act.gitPr' : kind === 'commit' ? 'boards.act.gitCommit' : 'boards.act.gitBranch'), ref });
}

/**
 * A «milestones» entry (ADR-0063): after {action, milestone_id, name, due_on} on the task; on a
 * subtask {action: linked | unlinked, task_milestone_id, parent_id} (the name from the parent).
 */
function milestonesText(f: Json, ctx: HistoryCtx, now: Date): string {
  const s = (k: string): string => str(f?.[k]);
  const name = s('name');
  switch (f?.['action']) {
    case 'created':
      return t('boards.act.msCreated', { name });
    case 'renamed':
      return t('boards.act.msRenamed', { name });
    case 'dated':
      return s('due_on') ? t('boards.act.msDated', { name, date: formatDay(s('due_on'), now) }) : t('boards.act.msUndated', { name });
    case 'moved':
      return t('boards.act.msMoved');
    case 'completed':
      return t('boards.act.msCompleted', { name });
    case 'reopened':
      return t('boards.act.msReopened', { name });
    case 'deleted':
      return t('boards.act.msDeleted', { name });
    case 'auto_completed':
      return t('boards.act.msAutoCompleted', { name });
    case 'auto_reopened':
      return t('boards.act.msAutoReopened', { name });
    case 'linked':
      return t('boards.act.msLinked', { name: name || ctx.taskMilestone(s('parent_id'), s('task_milestone_id')) || NONE });
    case 'unlinked':
      return t('boards.act.msUnlinked');
    default:
      return t('boards.act.changed');
  }
}

/** A «checklist» entry (ADR-0058 §2): after {checklist_id, title, item_id?, text?, action}. */
function checklistText(f: Json): string {
  const title = str(f?.['title']);
  const text = str(f?.['text']);
  switch (f?.['action']) {
    case 'created':
      return t('boards.act.clCreated', { title });
    case 'renamed':
      return t('boards.act.clRenamed', { title });
    case 'deleted':
      return t('boards.act.clDeleted', { title });
    case 'item_added':
      return t('boards.act.clItemAdded', { text, title });
    case 'item_edited':
      return t('boards.act.clItemEdited', { text });
    case 'item_done':
      return t('boards.act.clItemDone', { text });
    case 'item_undone':
      return t('boards.act.clItemUndone', { text });
    case 'item_removed':
      return t('boards.act.clItemRemoved', { text });
    case 'item_moved':
      return t('boards.act.clItemMoved', { text, title });
    case 'converted':
      return t('boards.act.clConverted', { text });
    default:
      return t('boards.act.clChanged', { title });
  }
}

// ------------------------------------------------------------------ the list

/**
 * The timeline's entries: the loaded pages and the live TASK_ACTIVITY rows by id (a live copy
 * wins), without merged / cancelled ones (ADR-0081 `activityGone`) and without anything that is
 * not a journal entry; newest first (ids are time-ordered uuidv7 — the tiebreak).
 */
export function mergeHistory(loaded: readonly TaskActivity[], live: readonly TaskActivity[] | undefined, gone: readonly string[] | undefined): TaskActivity[] {
  const byId = new Map<string, TaskActivity>();
  for (const a of loaded) byId.set(a.id, a);
  for (const a of live ?? []) byId.set(a.id, a);
  if (gone) for (const id of gone) byId.delete(id);
  const at = (a: TaskActivity): number => (a.createdAt ? timestampMs(a.createdAt) : 0);
  return [...byId.values()].sort((x, y) => at(y) - at(x) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
}

export interface DayGroup<T> {
  /** Local calendar day `YYYY-MM-DD`. */
  day: string;
  /** Any moment of that day (for «Сегодня» / «Вчера» / «12 окт.»). */
  at: number;
  items: T[];
}

/** Consecutive items of one local day together (the list is newest first, so are the groups). */
export function groupByDay<T>(items: readonly T[], atOf: (x: T) => number): Array<DayGroup<T>> {
  const out: Array<DayGroup<T>> = [];
  for (const x of items) {
    const at = atOf(x);
    const d = new Date(at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const last = out.at(-1);
    if (last?.day === day) last.items.push(x);
    else out.push({ day, at, items: [x] });
  }
  return out;
}

/** A page of the task history (ADR-0091): journal entries newest first and the cursor for the next. */
export interface HistoryPage {
  items: TaskActivity[];
  /** The id of the oldest item of the raw page (a message too, when the server ignores `only`). */
  cursor: string;
  hasMore: boolean;
}

/** A raw `TaskActivityPage`: a server without `only=journal` sends comments too — dropped here. */
export function historyPage(items: readonly TaskActivityItem[], hasMore: boolean): HistoryPage {
  const last = items.at(-1)?.item;
  return {
    items: items.flatMap((i) => (i.item.case === 'activity' ? [i.item.value] : [])),
    cursor: last?.value?.id ?? '',
    hasMore,
  };
}
