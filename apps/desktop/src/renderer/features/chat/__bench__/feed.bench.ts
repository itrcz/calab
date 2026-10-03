import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MessageSchema, type Message } from '@calaba/protocol';
import { describe, it } from 'vitest';
import { firstUnreadIndex, lastSentId, useMessages, type ChatMessage } from '../../../stores/messages';
import { useRooms } from '../../../stores/rooms';
import { createMetaBuilder, type RowMeta } from '../grouping';

/**
 * Chat at scale (docs/14 «Лента на 20 тыс. сообщений»): a room scrolled back through 20k
 * messages via the real store, then single events on the open window. Not part of `pnpm test`
 * (vitest.config includes only *.test.ts); run with `pnpm --filter @calaba/desktop bench:feed`.
 */

const TOTAL = 20_000;
const PAGE = 50;
const ROUNDS = 50;
const ROOM = 'r';
const ME = 'u-me';
const T0 = Date.parse('2026-06-01T09:00:00Z');
const id = (n: number): string => `0199${n.toString(16).padStart(12, '0')}-7000-8000-000000000000`;
const authors = ['u-a', 'u-b', 'u-c', ME];

function message(n: number): Message {
  return create(MessageSchema, {
    id: id(n),
    roomId: ROOM,
    authorId: authors[(n * 7) % authors.length] ?? ME,
    content: `Message number ${n}: some ordinary chat text of a typical length, a link or two, nothing special.`,
    createdAt: timestampFromMs(T0 + n * 45_000),
  });
}

/** API page before `beforeN` (newest first), like GET /messages?before=. */
function page(beforeN: number): Message[] {
  const out: Message[] = [];
  for (let n = beforeN - 1; n >= Math.max(0, beforeN - PAGE); n--) out.push(message(n));
  return out;
}

function bytes(v: unknown): number {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)).length;
}

const items = (): ChatMessage[] => useMessages.getState().rooms[ROOM]?.items ?? [];

/** The Feed's per-render passes besides metas (MessageList.tsx): lastSentId, firstUnread, unread. */
function feedPasses(list: readonly ChatMessage[], readMarker: string): number {
  const lastSent = lastSentId(list);
  const first = firstUnreadIndex(list, readMarker, ME);
  let n = 0;
  if (first >= 0) for (let i = first; i < list.length; i++) if (list[i]?.status === 'sent' && list[i]?.msg.authorId !== ME) n++;
  return n + lastSent.length;
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('feed at 20k messages', () => {
  it('scroll back, then events', () => {
    const s = useMessages.getState();
    s.reset();
    const build = createMetaBuilder();
    const metas = (list: readonly ChatMessage[]): RowMeta[] => build(list, '', ME);

    // Scroll back: open at the newest page, then prepend older pages until the start.
    let oldest = TOTAL;
    const tScroll = time(() => {
      while (oldest > 0) {
        s.prependPage(ROOM, page(oldest), oldest - PAGE > 0);
        oldest -= PAGE;
        metas(items()); // the Feed renders once per page
      }
    });
    const list = items();
    const storeBytes = bytes(useMessages.getState().rooms);
    const marker = list[Math.floor(list.length / 2)]?.msg.id ?? '';

    // One event on a message near the top of the window (where the user is reading).
    const target = list[10]?.msg ?? message(0);
    let next = TOTAL;
    const events: Record<string, () => void> = {
      'MESSAGE_CREATE (newest)': () => s.upsert(message(next++)),
      'MESSAGE_UPDATE (visible)': () => s.upsert({ ...target, content: `${target.content}!` }),
      'reaction (visible)': () => s.applyReaction(ROOM, target.id, '👍', true, false),
      setLoading: () => s.setLoading(ROOM, true),
    };
    const rows: string[] = [];
    for (const [name, ev] of Object.entries(events)) {
      let tMetas = 0;
      let tPasses = 0;
      let changed = 0;
      for (let k = 0; k < ROUNDS; k++) {
        const before = metas(items());
        ev();
        const now = items();
        let out: RowMeta[] = [];
        tMetas += time(() => {
          out = metas(now);
        });
        tPasses += time(() => feedPasses(now, marker));
        changed += out.filter((m, i) => m !== before[i]).length;
      }
      rows.push(`${name.padEnd(26)} metas ${(tMetas / ROUNDS).toFixed(3)} ms · passes ${(tPasses / ROUNDS).toFixed(3)} ms · meta objects changed ${(changed / ROUNDS).toFixed(1)}`);
    }
    // The same room back at the present (newest 1500 rows, hasMoreAfter = false): a new message lands.
    const present: Message[] = [];
    for (let n = TOTAL - 1500; n < TOTAL; n++) present.push(message(n));
    s.setWindow(ROOM, present, true, false);
    let tCreate = 0;
    let changedCreate = 0;
    for (let k = 0; k < ROUNDS; k++) {
      const before = metas(items());
      s.upsert(message(next++));
      const now = items();
      let out: RowMeta[] = [];
      tCreate += time(() => {
        out = metas(now);
      });
      changedCreate += out.filter((m, i) => m !== before[i]).length;
    }
    rows.push(`${'MESSAGE_CREATE (present)'.padEnd(26)} metas ${(tCreate / ROUNDS).toFixed(3)} ms · window ${items().length} rows · meta objects changed ${(changedCreate / ROUNDS).toFixed(1)}`);
    console.log(
      [
        `scroll back ${TOTAL} msgs: ${tScroll.toFixed(0)} ms total, window ${list.length} rows, store ${(storeBytes / 1e6).toFixed(2)} MB (JSON)`,
        ...rows,
      ].join('\n'),
    );
  });

  it('scroll forward from the start (jump, then loadNewer)', () => {
    const s = useMessages.getState();
    s.reset();
    const build = createMetaBuilder();
    const asc = (from: number): Message[] => Array.from({ length: Math.min(PAGE, TOTAL - from) }, (_, k) => message(from + k));
    s.setWindow(ROOM, asc(0), false, true);
    let from = PAGE;
    let tAppend = 0;
    let tMetas = 0;
    while (from < TOTAL) {
      const p = asc(from);
      tAppend += time(() => s.appendPage(ROOM, p, from + PAGE < TOTAL));
      tMetas += time(() => build(items(), '', ME));
      from += PAGE;
    }
    console.log(`scroll forward ${TOTAL} msgs: appendPage ${tAppend.toFixed(0)} ms total, metas ${tMetas.toFixed(0)} ms total, window ${items().length} rows`);
  });

  it('Feed renders per incoming message at the bottom', () => {
    // What Feed (MessageList.tsx) subscribes to; a step re-renders it when any of these changes.
    // (Before 2.3.0 it also read readState and lastMessage of the room; FeedOverlays does now.)
    // React batches the dispatch step (upsert + setLastMessage) into one render; markRead runs
    // from Feed's effect afterwards, a separate render if Feed reads the marker.
    const FEED_SUBSCRIBES: (() => unknown)[] = [
      () => useMessages.getState().rooms[ROOM],
    ];
    const snap = (): unknown[] => FEED_SUBSCRIBES.map((f) => f());
    const differs = (a: unknown[], b: unknown[]): boolean => a.some((x, i) => !Object.is(x, b[i]));
    const s = useMessages.getState();
    s.reset();
    useRooms.getState().reset();
    s.prependPage(ROOM, page(500), true);
    useRooms.getState().setLastMessage(ROOM, id(499));
    useRooms.getState().setRead(ROOM, id(499));
    let renders = 0;
    for (let n = 500; n < 500 + ROUNDS; n++) {
      let before = snap();
      s.upsert(message(n));
      useRooms.getState().setLastMessage(ROOM, id(n));
      if (differs(before, snap())) renders++;
      before = snap();
      useRooms.getState().setRead(ROOM, id(n)); // Feed effect: at bottom → markRead
      if (differs(before, snap())) renders++;
    }
    console.log(`Feed renders per incoming message at the bottom: ${(renders / ROUNDS).toFixed(1)}`);
  });
});
