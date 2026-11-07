import type { SearchHit, SearchResponse } from '@calaba/protocol';
import { hitId, type SectionName } from './sections';
import type { SearchParams } from './query';

/**
 * Search of the «Личные» column (CBF-159): the messages of my DMs only — `scope=dms`, the messages
 * feed (a cursor, newest first) — plus the DMs whose peer's name matches. Pure: the request, the
 * mapping of hits to rows and the paging; the debounce lives in runner.ts, the fetch in the hook.
 */

const MESSAGES: SectionName = 'messages';

/** One page of the feed of messages of my DMs. */
export function dmSearchParams(q: string, cursor = ''): SearchParams {
  const p: SearchParams = { q: q.trim(), scope: 'dms', type: MESSAGES, sort: 'new' };
  if (cursor) p['cursor'] = cursor;
  return p;
}

/** A hit of a DM message, as the column's row needs it. */
export interface DmHitRow {
  id: string;
  roomId: string;
  messageId: string;
  /** The server's snippet (U+0002 … U+0003 around the words). */
  snippet: string;
  /** Unix ms of the message, 0 = unknown. */
  at: number;
  hit: SearchHit;
}

/** Message hits of a page as rows (anything else — notes, a room — never belongs to this list). */
export function dmHitRows(hits: readonly SearchHit[], at: (h: SearchHit) => number): DmHitRow[] {
  const out: DmHitRow[] = [];
  for (const h of hits) {
    if (h.ref.case !== 'message') continue;
    out.push({ id: hitId(h), roomId: h.ref.value.roomId, messageId: h.ref.value.messageId, snippet: h.snippet, at: at(h), hit: h });
  }
  return out;
}

export interface DmFeed {
  /** The request this feed answers (params key). */
  key: string;
  rows: DmHitRow[];
  cursor: string;
  done: boolean;
  failed: boolean;
}

/** The first page of an answer. */
export function firstPage(key: string, r: SearchResponse, at: (h: SearchHit) => number): DmFeed {
  const s = r.sections[0];
  return { key, rows: dmHitRows(s?.items ?? [], at), cursor: s?.nextCursor ?? '', done: !s?.nextCursor, failed: false };
}

/** The next page appended (a hit already shown is skipped); a feed of another request is left as is. */
export function appendPage(feed: DmFeed, key: string, r: SearchResponse, at: (h: SearchHit) => number): DmFeed {
  if (feed.key !== key) return feed;
  const next = firstPage(key, r, at);
  const seen = new Set(feed.rows.map((x) => x.id));
  return { ...next, rows: [...feed.rows, ...next.rows.filter((x) => !seen.has(x.id))] };
}

/** DMs whose peer's name contains every word of the query (case-insensitive), in the given order. */
export function matchPeers<T extends { peerId: string }>(dms: readonly T[], name: (peerId: string) => string, q: string, max = 5): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: T[] = [];
  for (const d of dms) {
    const n = name(d.peerId).toLowerCase();
    if (words.every((w) => n.includes(w))) out.push(d);
    if (out.length >= max) break;
  }
  return out;
}
