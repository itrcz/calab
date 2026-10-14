import { MessageKind } from '@calaba/protocol';
import type { Message } from '@calaba/protocol';
import { keyIndex, type ChatMessage } from '../../stores/messages';
import { toDate } from '../../lib/format';

/** Telegram-style grouping: consecutive messages of one author within 5 minutes. */
export const GROUP_MS = 5 * 60 * 1000;

export interface RowMeta {
  /** Date pill above the row. */
  day: boolean;
  /** «НОВОЕ» pill above the row (first unread message at the moment the room was opened). */
  isNew: boolean;
  /** First bubble of a group: author name (others). */
  first: boolean;
  /** Last bubble of a group: tail + avatar (others). */
  last: boolean;
}

/** Day and time of a message, computed once per message object (`toDateString` is not cheap). */
const times = new WeakMap<Message, { day: string; ms: number }>();
function timeOf(c: ChatMessage): { day: string; ms: number } {
  let t = times.get(c.msg);
  if (!t) {
    const d = toDate(c.msg.createdAt);
    t = { day: d.toDateString(), ms: d.getTime() };
    times.set(c.msg, t);
  }
  return t;
}
const dayKey = (c: ChatMessage): string => timeOf(c).day;
const ms = (c: ChatMessage): number => timeOf(c).ms;

export function startsNew(c: ChatMessage, prev: ChatMessage | undefined, newMarker: string, me: string): boolean {
  return (
    !!newMarker &&
    c.status === 'sent' &&
    c.msg.id > newMarker &&
    c.msg.authorId !== me &&
    (!prev || prev.status !== 'sent' || prev.msg.id <= newMarker)
  );
}

/** Whether `c` continues the group of `prev`. */
export function continues(c: ChatMessage, prev: ChatMessage | undefined, newMarker: string, me: string): boolean {
  if (!prev || prev.msg.authorId !== c.msg.authorId) return false;
  // A system card (ADR-0025) stands alone: it neither joins nor continues a group of bubbles.
  if (prev.msg.kind === MessageKind.SYSTEM || c.msg.kind === MessageKind.SYSTEM) return false;
  if (dayKey(prev) !== dayKey(c) || startsNew(c, prev, newMarker, me)) return false;
  const dt = ms(c) - ms(prev);
  return dt >= 0 && dt < GROUP_MS;
}

export function rowMeta(items: readonly ChatMessage[], i: number, newMarker: string, me: string): RowMeta {
  const c = items[i];
  if (!c) return { day: false, isNew: false, first: true, last: true };
  const prev = items[i - 1];
  const next = items[i + 1];
  return {
    day: !prev || dayKey(prev) !== dayKey(c),
    isNew: startsNew(c, prev, newMarker, me),
    first: !continues(c, prev, newMarker, me),
    last: !next || !continues(next, c, newMarker, me),
  };
}

const same = (a: RowMeta, b: RowMeta): boolean => a.day === b.day && a.isNew === b.isNew && a.first === b.first && a.last === b.last;

/**
 * Metas for the whole list, reusing the previous object per message when nothing changed, so
 * memoised rows re-render only where grouping actually changed (a new message touches at most
 * the previous row).
 */
export function buildMetas(items: readonly ChatMessage[], newMarker: string, me: string, cache: Map<string, RowMeta>): RowMeta[] {
  const out = new Array<RowMeta>(items.length);
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    if (!c) continue;
    const m = rowMeta(items, i, newMarker, me);
    const old = cache.get(c.key);
    const v = old && same(old, m) ? old : m;
    cache.set(c.key, v);
    seen.add(c.key);
    out[i] = v;
  }
  if (cache.size > seen.size * 2 + 64) for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return out;
}

export type MetaBuilder = (items: readonly ChatMessage[], newMarker: string, me: string) => RowMeta[];

/**
 * Incremental `buildMetas` for the feed (docs/14 «Лента на 20 тыс. сообщений»). A row's meta
 * depends only on itself and its two neighbours, and windows are immutable arrays where an
 * unchanged row keeps its object. So against the previous call: the common prefix and suffix
 * (by identity) keep their metas, and only the changed middle plus one row on each side is
 * recomputed — a new message, an edit or a reaction touches 1–3 rows, not the whole window.
 * A different marker or viewer recomputes everything. Unchanged metas keep their objects.
 */
export function createMetaBuilder(): MetaBuilder {
  let prevItems: readonly ChatMessage[] | null = null;
  let prevMetas: RowMeta[] = [];
  let prevMarker = '';
  let prevMe = '';
  return (items, newMarker, me) => {
    if (items === prevItems && newMarker === prevMarker && me === prevMe) return prevMetas;
    const old = prevItems ?? [];
    const oldMetas = prevMetas;
    const n = items.length;
    const o = old.length;
    let a = 0;
    let b = 0;
    if (prevItems && newMarker === prevMarker && me === prevMe) {
      while (a < n && a < o && items[a] === old[a]) a++;
      while (b < n - a && b < o - a && items[n - 1 - b] === old[o - 1 - b]) b++;
    }
    const out = new Array<RowMeta>(n);
    for (let i = 0; i < a; i++) out[i] = oldMetas[i] as RowMeta;
    for (let i = n - b; i < n; i++) out[i] = oldMetas[i - n + o] as RowMeta;
    // Previous meta of a recomputed row: same position when the middle kept its length (an
    // edit, a reaction), otherwise looked up by key (a page, a jump).
    const sameShape = n === o;
    const oldIdx = sameShape || o === 0 ? null : keyIndex(old);
    for (let i = Math.max(0, a - 1), hi = Math.min(n - 1, n - b); i <= hi; i++) {
      const c = items[i];
      if (!c) continue;
      const m = rowMeta(items, i, newMarker, me);
      const j =
        i < a ? i : i >= n - b ? i - n + o : sameShape ? (old[i]?.key === c.key ? i : -1) : (oldIdx?.get(c.key) ?? -1);
      const prev = j >= 0 ? oldMetas[j] : undefined;
      out[i] = prev && same(prev, m) ? prev : m;
    }
    prevItems = items;
    prevMetas = out;
    prevMarker = newMarker;
    prevMe = me;
    return out;
  };
}

/** Stable colour index (0..7) of a user; must match components/Avatar `colorOf`. */
export function userColorIndex(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 8;
}
