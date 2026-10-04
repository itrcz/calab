import { TaskRelationKind, type Task } from '@calaba/protocol';

/**
 * Timeline (Gantt) math (ADR-0042 §5 «Таймлайн»): dates as day numbers, the scale of each zoom,
 * a bar's span and geometry, what a drag (move / resize / place) turns into as a PATCH, the
 * «blocked too late» marker and the rows in the visible window. Pure: the view only draws.
 * Dates are the contract's "YYYY-MM-DD" (boards.proto), counted in UTC days so no zone shifts them.
 */

export type Zoom = 'week' | 'month' | 'quarter';
export type DragMode = 'move' | 'start' | 'end';

/** Pixels per day of each zoom. */
export const DAY_PX: Record<Zoom, number> = { week: 44, month: 18, quarter: 6 };

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" → days since 1970-01-01 (NaN for an empty / malformed date). */
export function dayNum(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return NaN;
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

export function isoDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Saturday / Sunday. */
export function isWeekend(n: number): boolean {
  const wd = new Date(n * DAY_MS).getUTCDay();
  return wd === 0 || wd === 6;
}

export interface Span {
  start: number;
  end: number; // inclusive
}

/** A task's bar: start … due; one date alone is a one-day bar; none = not on the scale. */
export function spanOf(t: Pick<Task, 'startOn' | 'dueOn'>): Span | null {
  const s = dayNum(t.startOn);
  const e = dayNum(t.dueOn);
  if (Number.isNaN(s) && Number.isNaN(e)) return null;
  const a = Number.isNaN(s) ? e : s;
  const b = Number.isNaN(e) ? s : e;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Left offset and width (px) of a span on a scale starting at `origin`. */
export function barBox(span: Span, origin: number, px: number): { left: number; width: number } {
  return { left: (span.start - origin) * px, width: (span.end - span.start + 1) * px };
}

/** Pointer travel → whole days (snapped to the nearest day). */
export function daysOf(dx: number, px: number): number {
  const d = Math.round(dx / px);
  return d === 0 ? 0 : d; // no -0
}

/** The span after a drag of `delta` days: moved, or one edge resized (never past the other edge). */
export function dragSpan(span: Span, mode: DragMode, delta: number): Span {
  switch (mode) {
    case 'move':
      return { start: span.start + delta, end: span.end + delta };
    case 'start':
      return { start: Math.min(span.start + delta, span.end), end: span.end };
    case 'end':
      return { start: span.start, end: Math.max(span.end + delta, span.start) };
  }
}

/**
 * The PATCH of a dragged bar: only the dates that changed. A task with one date keeps one date
 * when moved; resizing a one-date task gives it the other date too.
 */
export function datePatch(t: Pick<Task, 'startOn' | 'dueOn'>, next: Span): { startOn?: string; dueOn?: string } {
  const hasStart = !Number.isNaN(dayNum(t.startOn));
  const hasDue = !Number.isNaN(dayNum(t.dueOn));
  const out: { startOn?: string; dueOn?: string } = {};
  let startOn = isoDay(next.start);
  let dueOn = isoDay(next.end);
  if (next.start === next.end && !(hasStart && hasDue)) {
    if (hasDue) startOn = '';
    else dueOn = '';
  }
  if (startOn !== t.startOn) out.startOn = startOn;
  if (dueOn !== t.dueOn) out.dueOn = dueOn;
  return out;
}

/** A task dropped from «Без дат» onto a day: a one-day bar (start = due). */
export function placePatch(day: number): { startOn: string; dueOn: string } {
  const d = isoDay(day);
  return { startOn: d, dueOn: d };
}

/**
 * The keys of the tasks that block `t` and end after it starts (a red marker on its bar): a
 * `blocks` relation stored as blocker.task_id → t.related_id.
 */
export function lateBlockers(t: Pick<Task, 'id' | 'startOn' | 'dueOn' | 'relations'>, tasks: Readonly<Record<string, Pick<Task, 'key' | 'startOn' | 'dueOn'> | undefined>>): string[] {
  const span = spanOf(t);
  if (!span) return [];
  const out: string[] = [];
  for (const r of t.relations) {
    if (r.kind !== TaskRelationKind.BLOCKS || r.relatedId !== t.id) continue;
    const b = tasks[r.taskId];
    const bs = b ? spanOf(b) : null;
    if (b && bs && bs.end >= span.start) out.push(b.key);
  }
  return out;
}

/** The scale's first and last day: the tasks and milestones with a margin, today always in. */
export function scaleRange(days: readonly number[], today: number): Span {
  let lo = today;
  let hi = today;
  for (const d of days) {
    if (Number.isNaN(d)) continue;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { start: lo - 14, end: hi + 45 };
}

/** Rows [first, last) intersecting the viewport (plus `over` rows of overscan each side). */
export function rowWindow(scrollTop: number, height: number, rowPx: number, count: number, over = 6): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowPx) - over);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowPx) + over);
  return { first, last: Math.max(first, last) };
}

/** Days [first, last] visible on the scale (with a little overscan). */
export function dayWindow(scrollLeft: number, width: number, px: number, range: Span): Span {
  const first = Math.max(range.start, range.start + Math.floor(scrollLeft / px) - 2);
  const last = Math.min(range.end, range.start + Math.ceil((scrollLeft + width) / px) + 2);
  return { start: first, end: Math.max(first, last) };
}

/** A bar intersects the visible days (else it is not drawn). */
export const spanVisible = (s: Span, win: Span): boolean => s.end >= win.start && s.start <= win.end;

export type TimelineGroup = 'none' | 'assignee' | 'milestone';

/** A group header row of the timeline: `g:<key>` (key '' = «Без исполнителя» / «Без вехи»). */
export const GROUP_ROW = 'g:';

type RowTask = Pick<Task, 'id' | 'startOn' | 'dueOn' | 'number' | 'assignees' | 'milestoneId'>;

function groupKey(t: RowTask, group: TimelineGroup): string {
  if (group === 'assignee') return (t.assignees.find((a) => a.isLead) ?? t.assignees[0])?.userId ?? '';
  if (group === 'milestone') return t.milestoneId;
  return '';
}

/**
 * The timeline's rows: dated tasks by start (then number), under group headers when grouped
 * (groups in the order of their first task, the empty group last); undated tasks apart («Без дат»).
 */
export function timelineRows(tasks: readonly RowTask[], group: TimelineGroup): { rows: string[]; undated: string[] } {
  const dated: Array<{ t: RowTask; s: Span }> = [];
  const undated: string[] = [];
  for (const t of tasks) {
    const s = spanOf(t);
    if (s) dated.push({ t, s });
    else undated.push(t.id);
  }
  dated.sort((a, b) => a.s.start - b.s.start || a.s.end - b.s.end || a.t.number - b.t.number);
  if (group === 'none') return { rows: dated.map((x) => x.t.id), undated };
  const groups = new Map<string, string[]>();
  for (const x of dated) {
    const k = groupKey(x.t, group);
    const list = groups.get(k);
    if (list) list.push(x.t.id);
    else groups.set(k, [x.t.id]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0));
  const rows: string[] = [];
  for (const k of keys) rows.push(GROUP_ROW + k, ...(groups.get(k) ?? []));
  return { rows, undated };
}

// ------------------------------------------------------------------ scale «меньше цифр» (ADR-0063, «Дополнение»)

/** A Monday: the scale's numbers stand at week starts. */
export function isWeekStart(n: number): boolean {
  return new Date(n * DAY_MS).getUTCDay() === 1;
}

/**
 * The scale's labels in [d0, d1] (as Linear): on the week / month zoom a number at each Monday;
 * the months as segments a row above — each starts at the 1st (the first segment at d0, so the
 * month in view keeps its name at the left edge); on the quarter zoom the months only. Weekends
 * have no labels (the grid shades them).
 */
export function scaleMarks(d0: number, d1: number, zoom: Zoom): { weeks: number[]; months: number[] } {
  const weeks: number[] = [];
  const months: number[] = [d0];
  for (let d = d0; d <= d1; d++) {
    if (d > d0 && new Date(d * DAY_MS).getUTCDate() === 1) months.push(d);
    if (zoom !== 'quarter' && isWeekStart(d)) weeks.push(d);
  }
  return { weeks, months };
}

/** The first day of the next month after day d (a month segment's end). */
export function nextMonth(d: number): number {
  const date = new Date(d * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${locale}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
    fmtCache.set(k, f);
  }
  return f;
}

/** A short month of the locale without its abbreviation dot: «окт», «Oct», «10月». */
function monthPart(d: number, locale: string): string {
  return fmt(locale, { month: 'short' }).format(new Date(d * DAY_MS)).replace(/\.$/, '');
}

const yearOf = (d: number): number => new Date(d * DAY_MS).getUTCFullYear();

/** The scale's month: short, upper case, with the year when it is not today's («ОКТ», «ЯНВ 2027»). */
export function monthLabel(d: number, today: number, locale: string): string {
  const m = monthPart(d, locale).toLocaleUpperCase(locale);
  return yearOf(d) === yearOf(today) ? m : `${m} ${yearOf(d)}`;
}

/** A day pill on the scale (today, the hover): the locale's day and short month, upper case («4 ОКТ», «OCT 4»). */
export function dayPill(d: number, locale: string): string {
  return fmt(locale, { day: 'numeric', month: 'short' })
    .formatToParts(new Date(d * DAY_MS))
    .map((p) => (p.type === 'month' ? p.value.replace(/\.$/, '').toLocaleUpperCase(locale) : p.value))
    .join('');
}

/** The x of a day's centre on the scale (today's line, the hover line, a milestone's diamond). */
export const dayCenter = (d: number, origin: number, px: number, left: number): number => left + (d - origin) * px + px / 2;

/** The day under content x (scroll included); null over the sticky list on the left. */
export function dayAt(x: number, origin: number, px: number, left: number): number | null {
  if (x < left) return null;
  return origin + Math.floor((x - left) / px);
}

/** The days the viewport shows (no overscan): the off-screen hints compare against them. */
export function viewDays(scrollLeft: number, width: number, px: number, left: number, origin: number): Span {
  const start = origin + Math.floor(scrollLeft / px);
  return { start, end: Math.max(start, origin + Math.ceil((scrollLeft + Math.max(0, width - left)) / px) - 1) };
}

/** Where a task lies relative to the viewport: entirely before it, after it, or (null) in view. */
export function offscreenSide(span: Span, view: Span): 'left' | 'right' | null {
  if (span.end < view.start) return 'left';
  if (span.start > view.end) return 'right';
  return null;
}

/**
 * The muted hint of an off-screen task: «28 мая – 27 авг» in today's year (day and month), else
 * months with years («апр 2025 – июн 2025», one «янв 2025» when both ends are in one month).
 */
export function offscreenText(span: Span, today: number, locale: string): string {
  const thisYear = yearOf(span.start) === yearOf(today) && yearOf(span.end) === yearOf(today);
  const one = (d: number): string =>
    thisYear
      ? fmt(locale, { day: 'numeric', month: 'short' })
          .formatToParts(new Date(d * DAY_MS))
          .map((p) => (p.type === 'month' ? p.value.replace(/\.$/, '') : p.value))
          .join('')
      : `${monthPart(d, locale)} ${yearOf(d)}`;
  const a = one(span.start);
  const b = one(span.end);
  return a === b ? a : `${a} – ${b}`;
}

/** The scroll offset that puts a span's start a few days from the scale's left edge. */
export function revealScroll(span: Span, origin: number, px: number, zoom: Zoom): number {
  const lead = zoom === 'week' ? 2 : zoom === 'month' ? 4 : 14;
  return Math.max(0, (span.start - origin - lead) * px);
}

/** Minimum gap (px) between two milestone labels, and between a label and the visible edge. */
export const LABEL_GAP = 6;
const LABEL_CHAR_PX = 6.3; // text-micro, average glyph advance (cheap estimate, no DOM reads)
const LABEL_MAX_PX = 112; // max-w-28

/** Estimated width (px) of a milestone label: chars × average advance, capped (the label truncates). */
export function labelWidth(name: string): number {
  return Math.min(LABEL_MAX_PX, Math.ceil(Array.from(name).length * LABEL_CHAR_PX));
}

/**
 * Where the names under a bar's milestone diamonds go. `xs` — diamond centres (px, content
 * coordinates), `widths` — label widths, `minX` — the visible content's left edge (the sticky
 * column's right edge). Returns, per input, the label's left edge: centred under its diamond, or
 * shifted right just enough to clear the previous visible label (gap >= `gap`) and the edge; `null`
 * (hidden, the diamond's tooltip carries the name) when the shift would leave the diamond before
 * the label's start. Pure; labels are laid out left to right whatever the input order.
 */
export function layoutLabels(xs: readonly number[], widths: readonly number[], minX: number, gap = LABEL_GAP): (number | null)[] {
  const out: (number | null)[] = xs.map(() => null);
  const order = xs.map((_, i) => i).sort((a, b) => (xs[a] ?? 0) - (xs[b] ?? 0));
  let edge = minX + gap;
  for (const i of order) {
    const x = xs[i] ?? 0;
    const w = widths[i] ?? 0;
    const left = Math.max(x - w / 2, edge);
    if (left > x) continue; // the diamond would stand before the label's start: no room
    out[i] = left;
    edge = left + w + gap;
  }
  return out;
}
