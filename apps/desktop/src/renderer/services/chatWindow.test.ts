import { create } from '@bufbuild/protobuf';
import { MessageSchema, type Message } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// docs/14 «Лента на 20 тыс. сообщений»: the open room's window is capped while paging both
// ways through a long history, and the virtual index of every row (Virtuoso firstItemIndex +
// position) never moves, so the scroll position does not jump.

type Page = { messages: Message[]; hasMore: boolean };
type Params = { before?: string; after?: string; limit?: number };
const list = vi.fn<(roomId: string, p: Params, signal?: AbortSignal) => Promise<Page>>();
vi.mock('../lib/api/endpoints', () => ({
  api: { messages: { list: (roomId: string, p: Params, signal?: AbortSignal) => list(roomId, p, signal) } },
  uploadFile: vi.fn(),
}));
vi.mock('./gateway', () => ({ sendTyping: () => undefined }));
vi.mock('../stores/toasts', () => ({ toast: { fail: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { openRoom, loadOlder, loadNewer, ensureLoaded, loadPresent, resetChatCaches } = await import('./chat');
const { useMessages, WINDOW_CAP } = await import('../stores/messages');
const { useRooms } = await import('../stores/rooms');

const R = 'room';
const TOTAL = 4000;
const id = (n: number): string => `m${String(n).padStart(6, '0')}`;
const all = Array.from({ length: TOTAL }, (_, n) => create(MessageSchema, { id: id(n), roomId: R, authorId: 'u', content: id(n) }));

/** The server's cursor pagination (internal/messages): before → newest first, after → oldest first. */
function serve(_roomId: string, p: Params): Promise<Page> {
  const limit = p.limit ?? 50;
  if (p.after !== undefined) {
    const after = p.after;
    const rest = all.filter((m) => m.id > after);
    return Promise.resolve({ messages: rest.slice(0, limit), hasMore: rest.length > limit });
  }
  const before = p.before;
  const older = before === undefined ? all : all.filter((m) => m.id < before);
  return Promise.resolve({ messages: older.slice(-limit).reverse(), hasMore: older.length > limit });
}

const st = () => useMessages.getState().rooms[R];

/** Virtual index (base + position) of every row: must be the same for a row in both windows. */
function virtual(): Map<string, number> {
  const r = st();
  return new Map(r?.items.map((c, i) => [c.key, r.base + i]) ?? []);
}
function expectAnchored(before: Map<string, number>): void {
  const after = virtual();
  let shared = 0;
  for (const [k, v] of before) {
    const w = after.get(k);
    if (w === undefined) continue;
    shared++;
    expect(w, k).toBe(v);
  }
  expect(shared).toBeGreaterThan(0);
}

beforeEach(() => {
  resetChatCaches();
  useMessages.getState().reset();
  useRooms.setState({ readState: {}, lastMessage: {} });
  list.mockReset();
  list.mockImplementation(serve);
});

describe('open room window cap', () => {
  it('scrolling back past the cap drops the newest rows; scrolling down drops the oldest; rows never move', async () => {
    await openRoom(R);
    expect(st()?.items).toHaveLength(50);
    // Up to the very start of the history.
    while (st()?.hasMoreBefore) {
      const v = virtual();
      await loadOlder(R);
      expectAnchored(v);
      expect(st()?.items.length).toBeLessThanOrEqual(WINDOW_CAP);
    }
    expect(st()?.items[0]?.key).toBe(id(0));
    expect(st()?.items).toHaveLength(WINDOW_CAP);
    expect(st()?.hasMoreAfter).toBe(true);
    expect(st()?.items.at(-1)?.key).toBe(id(WINDOW_CAP - 1));

    // Down to the present again.
    while (st()?.hasMoreAfter) {
      const v = virtual();
      await loadNewer(R);
      expectAnchored(v);
      expect(st()?.items.length).toBeLessThanOrEqual(WINDOW_CAP);
    }
    expect(st()?.items.at(-1)?.key).toBe(id(TOTAL - 1));
    expect(st()?.hasMoreBefore).toBe(true);
    const keys = st()?.items.map((c) => c.key) ?? [];
    expect(keys).toEqual(all.slice(TOTAL - WINDOW_CAP).map((m) => m.id)); // contiguous, sorted, no gaps
  });

  it('a jump to a message far outside the window still lands on it, and paging around it stays anchored', async () => {
    await openRoom(R);
    expect(await ensureLoaded(R, id(1234))).toBe(true);
    expect(st()?.items.some((c) => c.key === id(1234))).toBe(true);
    expect(st()?.hasMoreBefore).toBe(true);
    expect(st()?.hasMoreAfter).toBe(true);
    for (let k = 0; k < 40; k++) {
      const v = virtual();
      await (k % 2 ? loadNewer(R) : loadOlder(R));
      expectAnchored(v);
    }
    expect(st()?.items.length).toBeLessThanOrEqual(WINDOW_CAP);
    await loadPresent(R);
    expect(st()?.hasMoreAfter).toBe(false);
    expect(st()?.items.at(-1)?.key).toBe(id(TOTAL - 1));
  });
});
