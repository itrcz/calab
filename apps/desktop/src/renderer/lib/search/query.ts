import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { SearchHit } from '@calaba/protocol';
import { messageLike, type SectionName } from './sections';

/**
 * Query strings of GET /api/search (ADR-0062 §1) and the results panel's filters (§4).
 *
 * The endpoint takes q / scope / types / type / limit / cursor / sort only. The panel's author,
 * room / board and period filters are applied to the hits of each loaded page (the list then
 * loads further pages until it has enough rows); «Только с файлами» on a message-like tab asks
 * for the files section and keeps the attachments of that tab's rooms.
 */

export type SearchParams = Record<string, string>;

/** The ⌘K summary: every section, `limit` hits each (server default 4). */
export function summaryParams(q: string, scope: string, limit?: number): SearchParams {
  const p: SearchParams = { q: q.trim(), scope };
  if (limit !== undefined) p['limit'] = String(limit);
  return p;
}

export type SortMode = 'relevance' | 'new';

/** One page of a section feed. */
export function feedParams(q: string, scope: string, type: SectionName, sort: SortMode, cursor = ''): SearchParams {
  const p: SearchParams = { q: q.trim(), scope, type };
  if (sort === 'new') p['sort'] = 'new';
  if (cursor) p['cursor'] = cursor;
  return p;
}

/** A cache / request key of the parameters (order-independent). */
export function paramsKey(p: SearchParams): string {
  return Object.keys(p)
    .sort()
    .map((k) => `${k}=${p[k] ?? ''}`)
    .join('&');
}

export type Period = 'any' | 'today' | '7d' | '30d' | 'range';

export interface PanelFilters {
  /** Author user id ('' = anyone). */
  author: string;
  /** Room id (messages, comments, files, notes, transcripts, events) or board id (tasks); '' = any. */
  place: string;
  period: Period;
  /** `YYYY-MM-DD` (local), used with period 'range'; '' = open end. */
  from: string;
  to: string;
  /** Message-like tabs: only messages with attachments (shown as the files they carry). */
  withFiles: boolean;
  sort: SortMode;
}

export const NO_FILTERS: PanelFilters = { author: '', place: '', period: 'any', from: '', to: '', withFiles: false, sort: 'relevance' };

/** What kind of room a room id is (for «Только с файлами»): its tab. */
export type RoomKindOf = (roomId: string) => 'chat' | 'task' | 'notes';

export interface PanelRequest {
  /** The section actually requested. */
  type: SectionName;
  /** Query string of the first page (add `cursor` for the next ones). */
  params: SearchParams;
  /** Whether a hit of that section passes the client-side filters. */
  match: (h: SearchHit) => boolean;
  /** Any client-side filter is on (a page may then show fewer rows than it holds). */
  filtered: boolean;
}

const DAY = 86_400_000;

function localDay(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** [from, to) in ms of the period, null ends = open. */
export function periodRange(f: Pick<PanelFilters, 'period' | 'from' | 'to'>, now: number): { from: number | null; to: number | null } {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (f.period) {
    case 'today':
      return { from: today, to: null };
    case '7d':
      return { from: now - 7 * DAY, to: null };
    case '30d':
      return { from: now - 30 * DAY, to: null };
    case 'range': {
      const from = localDay(f.from);
      const to = localDay(f.to);
      if (to === null) return { from, to: null };
      // The end date is included: up to the start of the next day (DST-safe: a calendar step).
      const e = new Date(to);
      return { from, to: new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1).getTime() };
    }
    default:
      return { from: null, to: null };
  }
}

/** The room of a hit ('' when it has none: tasks, events without a room). */
export function hitRoom(h: SearchHit): string {
  const r = h.ref;
  switch (r.case) {
    case 'message':
    case 'note':
    case 'taskComment':
    case 'file':
    case 'transcript':
    case 'event':
      return r.value.roomId;
    default:
      return '';
  }
}

/** The place a hit is filtered by: the board of a task, else its room. */
export function hitPlace(h: SearchHit): string {
  return h.ref.case === 'task' ? h.ref.value.boardId : hitRoom(h);
}

export function panelRequest(base: { q: string; scope: string; tab: SectionName }, f: PanelFilters, now: number, roomKind: RoomKindOf): PanelRequest {
  const files = f.withFiles && messageLike(base.tab);
  const type: SectionName = files ? 'files' : base.tab;
  const want = base.tab === 'task_comments' ? 'task' : base.tab === 'notes' ? 'notes' : 'chat';
  const { from, to } = periodRange(f, now);
  const checks: Array<(h: SearchHit) => boolean> = [];
  if (files) checks.push((h) => roomKind(hitRoom(h)) === want);
  if (f.author) checks.push((h) => h.authorId === f.author);
  if (f.place) checks.push((h) => hitPlace(h) === f.place);
  if (from !== null || to !== null) {
    checks.push((h) => {
      const at = h.at ? timestampMs(h.at) : NaN;
      return Number.isFinite(at) && (from === null || at >= from) && (to === null || at < to);
    });
  }
  return {
    type,
    params: feedParams(base.q, base.scope, type, f.sort),
    match: (h) => checks.every((c) => c(h)),
    filtered: checks.length > 0,
  };
}
