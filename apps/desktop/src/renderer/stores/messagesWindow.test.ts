import { create } from '@bufbuild/protobuf';
import { MessageSchema, type Message } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstUnreadIndex, mergeAscending, messageById, useMessages, WINDOW_CAP, type ChatMessage } from './messages';

const R = 'r';
const id = (n: number): string => `m${String(n).padStart(6, '0')}`;
const msg = (n: number, authorId = 'u', content = id(n)): Message => create(MessageSchema, { id: id(n), roomId: R, authorId, content });
const sentRow = (m: Message): ChatMessage => ({ key: m.id, msg: m, status: 'sent' });
const st = () => useMessages.getState().rooms[R];
const keys = (): string[] => st()?.items.map((c) => c.key) ?? [];

/** Deterministic PRNG for the property tests. */
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

/** API page before n (newest first). */
const olderPage = (n: number, size = 50): Message[] => Array.from({ length: Math.min(size, n) }, (_, k) => msg(n - 1 - k));
/** API page after n (oldest first). */
const newerPage = (n: number, size = 50): Message[] => Array.from({ length: size }, (_, k) => msg(n + 1 + k));

beforeEach(() => useMessages.getState().reset());

describe('window cap (WINDOW_CAP)', () => {
  it('prepending past the cap drops the newest rows, keeps pending ones, sets hasMoreAfter', () => {
    const s = useMessages.getState();
    s.prependPage(R, olderPage(100_000), true);
    s.addPending(R, { key: 'local:n', msg: create(MessageSchema, { roomId: R, nonce: 'n' }), status: 'pending' });
    let n = 100_000 - 50;
    while (st()?.items.length !== WINDOW_CAP + 1) {
      s.prependPage(R, olderPage(n), true);
      n -= 50;
    }
    expect(st()?.hasMoreAfter).toBe(false);
    const newest = st()?.items.at(-2)?.key;
    s.prependPage(R, olderPage(n), true);
    expect(st()?.items).toHaveLength(WINDOW_CAP + 1);
    expect(st()?.items.at(-1)?.key).toBe('local:n');
    expect(keys()).not.toContain(newest);
    expect(st()?.hasMoreAfter).toBe(true);
    expect(st()?.items[0]?.key).toBe(id(n - 50));
  });

  it('appending past the cap drops the oldest rows and sets hasMoreBefore', () => {
    const s = useMessages.getState();
    s.setWindow(R, [msg(0)], false, true);
    let n = 0;
    while ((st()?.items.length ?? 0) + 50 <= WINDOW_CAP) {
      s.appendPage(R, newerPage(n), true);
      n += 50;
    }
    expect(st()?.hasMoreBefore).toBe(false);
    s.appendPage(R, newerPage(n), false);
    expect(st()?.items).toHaveLength(WINDOW_CAP);
    expect(st()?.hasMoreBefore).toBe(true);
    expect(st()?.hasMoreAfter).toBe(false);
    expect(st()?.items.at(-1)?.key).toBe(id(n + 50));
    expect(st()?.items[0]?.key).toBe(id(n + 51 - WINDOW_CAP));
  });

  it('base: prepended rows lower it, dropped top rows raise it, so a row keeps its virtual index', () => {
    const s = useMessages.getState();
    s.prependPage(R, olderPage(10_000), true);
    const at = (k: string): number => (st()?.base ?? 0) + keys().indexOf(k);
    const anchor = id(9_990);
    const v0 = at(anchor);
    s.prependPage(R, olderPage(9_950), true);
    expect(st()?.base).toBe(-50);
    expect(at(anchor)).toBe(v0);
    // A jump to a window that still holds the old first row keeps the rows where they were.
    s.setWindow(R, olderPage(10_000, 1000).reverse(), true, true); // 9000..9999
    expect(at(anchor)).toBe(v0);
    s.appendPage(R, newerPage(9_999, 600), false); // 10000..10599: 1600 rows > cap
    expect(st()?.items).toHaveLength(WINDOW_CAP);
    expect(st()?.items[0]?.key).toBe(id(9_100));
    expect(at(anchor)).toBe(v0);
    // A jump far away (nothing shared) keeps the base: the list scrolls to the target itself.
    const base = st()?.base;
    s.setWindow(R, olderPage(500, 100).reverse(), true, true);
    expect(st()?.base).toBe(base);
  });

  it('capOpen cuts the open window at the present back to the cap, never one browsing history', () => {
    const s = useMessages.getState();
    s.setWindow(R, Array.from({ length: WINDOW_CAP + 300 }, (_, k) => msg(k)), true, false);
    const lastKey = keys().at(-1);
    s.capOpen(R);
    expect(st()?.items).toHaveLength(WINDOW_CAP);
    expect(keys().at(-1)).toBe(lastKey);
    expect(st()?.base).toBe(300);
    s.setWindow(R, Array.from({ length: WINDOW_CAP + 300 }, (_, k) => msg(k)), true, true);
    const before = st();
    s.capOpen(R);
    expect(st()).toBe(before);
  });

  it('random paging both ways: rows stay contiguous, sorted, ≤ cap, and anchored', () => {
    const rand = rng(7);
    const s = useMessages.getState();
    const TOTAL = 20_000;
    s.setWindow(R, Array.from({ length: 50 }, (_, k) => msg(15_000 + k)), true, true);
    const num = (c: ChatMessage | undefined): number => Number(c?.key.slice(1));
    let bad = 0;
    for (let step = 0; step < 400; step++) {
      const r = st();
      if (!r) throw new Error('no room');
      const first = num(r.items[0]);
      const last = num(r.items.at(-1));
      const size = 1 + Math.floor(rand() * 80);
      if (rand() < 0.5 && first > 0) s.prependPage(R, olderPage(first, size), first - size > 0);
      else if (last < TOTAL - 1) s.appendPage(R, newerPage(last, Math.min(size, TOTAL - 1 - last)), last + size < TOTAL - 1);
      const next = st();
      if (!next) throw new Error('no room');
      if (next.items.length > WINDOW_CAP) bad++;
      // Contiguous and sorted: row i is message first+i; anchored: message n sits at virtual index
      // (base + i) unchanged — both hold iff base - first(id) is the same before and after.
      next.items.forEach((c, i) => {
        if (num(c) !== num(next.items[0]) + i) bad++;
      });
      if (next.base - num(next.items[0]) !== r.base - first) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe('appendPage merge', () => {
  it('equals the sorted union of the window and the page, pending rows last', () => {
    const rand = rng(42);
    for (let round = 0; round < 200; round++) {
      const have = new Set<number>();
      for (let k = 0; k < 30; k++) have.add(Math.floor(rand() * 100));
      const page = new Set<number>();
      for (let k = 0; k < 20; k++) page.add(Math.floor(rand() * 120));
      const items: ChatMessage[] = [...have].sort((a, b) => a - b).map((n) => sentRow(msg(n)));
      items.push({ key: 'local:p', msg: create(MessageSchema, { roomId: R, nonce: 'p' }), status: 'pending' });
      const pageMsgs = [...page].sort((a, b) => a - b).map((n) => msg(n));
      if (round % 3 === 0) pageMsgs.reverse(); // order of the page does not matter
      const out = mergeAscending(items, pageMsgs);
      const want = [...new Set([...have, ...page])].sort((a, b) => a - b).map(id);
      expect(out.map((c) => c.key)).toEqual([...want, 'local:p']);
      // Rows already loaded keep their objects (their memoised bubbles do not re-render).
      for (const c of items) expect(out.find((x) => x.key === c.key)).toBe(c);
    }
  });

  it('a page of known rows changes nothing', () => {
    const items = [sentRow(msg(1)), sentRow(msg(2))];
    expect(mergeAscending(items, [msg(1), msg(2)])).toBe(items);
  });
});

describe('firstUnreadIndex (binary search, then skip my own)', () => {
  it('matches a scan from the start on random windows', () => {
    const rand = rng(3);
    for (let round = 0; round < 300; round++) {
      const n = Math.floor(rand() * 60);
      const items: ChatMessage[] = [];
      let at = 0;
      for (let k = 0; k < n; k++) {
        at += 1 + Math.floor(rand() * 3);
        items.push(sentRow(msg(at, rand() < 0.4 ? 'me' : 'other')));
      }
      if (rand() < 0.3) items.push({ key: 'local:x', msg: create(MessageSchema, { roomId: R, authorId: 'other' }), status: 'pending' });
      const marker = rand() < 0.1 ? '' : id(Math.floor(rand() * (at + 3)));
      const naive = items.findIndex((c) => c.status === 'sent' && !!marker && c.msg.id > marker && c.msg.authorId !== 'me');
      expect(firstUnreadIndex(items, marker, 'me')).toBe(naive);
    }
  });
});

describe('messageById (reply quotes, composer)', () => {
  it('returns the same object until that message changes', () => {
    const s = useMessages.getState();
    s.prependPage(R, olderPage(100, 100), false);
    const q = messageById(useMessages.getState(), R, id(10));
    expect(q?.id).toBe(id(10));
    s.applyReaction(R, id(50), '👍', true, false); // another row
    s.upsert(msg(100)); // a new message
    expect(messageById(useMessages.getState(), R, id(10))).toBe(q);
    s.upsert(msg(10, 'u', 'edited'));
    expect(messageById(useMessages.getState(), R, id(10))?.content).toBe('edited');
    s.remove(R, id(10));
    expect(messageById(useMessages.getState(), R, id(10))).toBeUndefined();
    expect(messageById(useMessages.getState(), 'other', id(10))).toBeUndefined();
    expect(messageById(useMessages.getState(), R, '')).toBeUndefined();
  });
});
