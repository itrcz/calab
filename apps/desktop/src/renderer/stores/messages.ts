import type { Message, Reaction } from '@calaba/protocol';
import { create } from 'zustand';

export type SendStatus = 'sent' | 'pending' | 'failed';

export interface PendingUpload {
  key: string;
  name: string;
  size: number;
  progress: number; // 0..1
  previewUrl?: string;
}

export interface ChatMessage {
  /** Server id, or `local:<nonce>` while pending. */
  key: string;
  msg: Message;
  status: SendStatus;
  uploads?: PendingUpload[];
  error?: string;
}

/**
 * A contiguous window of a room's history. Normally it ends at the newest message
 * (`hasMoreAfter = false`); after a jump to an old message (search, reply, first unread)
 * it may end earlier and grows downwards with `appendPage`.
 */
export interface RoomMessages {
  items: ChatMessage[]; // ascending by id (oldest first)
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /**
   * Virtual index of `items[0]` for the list's `firstItemIndex` (Virtuoso keeps the scroll
   * position by it): rows added at the top lower it, rows dropped from the top raise it. Kept by
   * the store for every change (`anchored`), so it is exact for each step of the window.
   */
  base: number;
}

const sent = (m: Message): ChatMessage => ({ key: m.id, msg: m, status: 'sent' });

const EMPTY: RoomMessages = { items: [], hasMoreBefore: true, hasMoreAfter: false, loading: false, loaded: false, error: null, base: 0 };

/**
 * `next.base` from the window it replaces: its first row was the previous first row's k-th
 * predecessor (older rows prepended) or its d-th successor (oldest rows dropped). A window that
 * shares neither (a jump) keeps the base — the list scrolls to the target explicitly.
 */
export function anchorBase(prev: RoomMessages | undefined, next: RoomMessages): number {
  const base = prev?.base ?? next.base;
  if (!prev || prev.items === next.items) return base;
  const was = prev.items[0]?.key;
  const now = next.items[0]?.key;
  if (!was || !now || was === now) return base;
  const k = keyIndex(next.items).get(was);
  if (k !== undefined) return base - k;
  const d = keyIndex(prev.items).get(now);
  return d !== undefined ? base + d : base;
}

/** Applies `anchorBase` to every room a store update changes. */
function anchored(s: MessagesState, patch: Partial<MessagesState>): Partial<MessagesState> {
  const rooms = patch.rooms;
  if (!rooms || rooms === s.rooms) return patch;
  for (const id of Object.keys(rooms)) {
    const next = rooms[id];
    const prev = s.rooms[id];
    if (!next || next === prev) continue;
    const base = anchorBase(prev, next);
    if (base !== next.base) rooms[id] = { ...next, base };
  }
  return patch;
}

/**
 * The most sent messages a room window holds (docs/14 «Лента на 20 тыс. сообщений»). Paging
 * past it drops the far end: older pages drop the newest rows (`hasMoreAfter`), newer pages the
 * oldest (`hasMoreBefore`); the dropped side reloads by the same cursor paging when scrolled to.
 */
export const WINDOW_CAP = 1500;

/**
 * key → index of a window's rows, built lazily once per `items` array (windows are immutable:
 * every change makes a new array). Lookups by id — reply quotes, the composer, upsert, the
 * reaction path — are O(1) instead of a scan of the whole window per store change.
 */
const indexes = new WeakMap<readonly ChatMessage[], Map<string, number>>();

export function keyIndex(items: readonly ChatMessage[]): Map<string, number> {
  let idx = indexes.get(items);
  if (!idx) {
    idx = new Map();
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      if (c) idx.set(c.key, i);
    }
    indexes.set(items, idx);
  }
  return idx;
}

/** The row with this key (server id or `local:<nonce>`) in a window. */
export function findByKey(items: readonly ChatMessage[], key: string): ChatMessage | undefined {
  const i = keyIndex(items).get(key);
  return i === undefined ? undefined : items[i];
}

/** Selector: a message of a room's loaded window by id (stable reference while it is unchanged). */
export function messageById(s: { rooms: Record<string, RoomMessages> }, roomId: string, id: string): Message | undefined {
  const r = s.rooms[roomId];
  return r && id ? findByKey(r.items, id)?.msg : undefined;
}

/** Number of sent rows: they come first, pending / failed ones stay at the end. */
function sentCount(items: readonly ChatMessage[]): number {
  let n = items.length;
  while (n > 0 && items[n - 1]?.status !== 'sent') n--;
  return n;
}

/** Index of the first sent row with an id above `id` (sent rows are ascending by id); binary search. */
export function firstSentAfter(items: readonly ChatMessage[], id: string): number {
  let lo = 0;
  let hi = sentCount(items);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((items[mid]?.msg.id ?? '') > id) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The first unread message from others (index, -1 if none): a binary search past the read
 * marker, then my own messages skipped — usually a few rows from the end, not a scan from the start.
 */
export function firstUnreadIndex(items: readonly ChatMessage[], readMarker: string, me: string): number {
  if (!readMarker) return -1;
  for (let i = firstSentAfter(items, readMarker); i < items.length; i++) {
    const c = items[i];
    if (c?.status !== 'sent') return -1;
    if (c.msg.authorId !== me) return i;
  }
  return -1;
}

/** The newest sent message id of a window ('' if none). */
export function lastSentId(items: readonly ChatMessage[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const c = items[i];
    if (c?.status === 'sent') return c.msg.id;
  }
  return '';
}

/** Cuts the newest sent rows past WINDOW_CAP (an older page came in); pending rows stay. */
function capNewest(r: RoomMessages): RoomMessages {
  const n = sentCount(r.items);
  if (n <= WINDOW_CAP) return r;
  return { ...r, items: [...r.items.slice(0, WINDOW_CAP), ...r.items.slice(n)], hasMoreAfter: true };
}

/** Cuts the oldest sent rows so that at most `keep` remain (a newer page came in); pending rows stay. */
export function capOldest(r: RoomMessages, keep = WINDOW_CAP): RoomMessages {
  const n = sentCount(r.items);
  if (n <= keep) return r;
  return { ...r, items: r.items.slice(n - keep), hasMoreBefore: true };
}

/**
 * Merges an ascending page of sent messages into a window: one pass over two sorted lists,
 * duplicates (already loaded ids) skipped; pending rows stay at the end.
 */
export function mergeAscending(items: readonly ChatMessage[], page: readonly Message[]): ChatMessage[] {
  const known = keyIndex(items);
  const fresh = page.filter((m) => !known.has(m.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (fresh.length === 0) return items as ChatMessage[];
  const n = sentCount(items);
  const out: ChatMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < fresh.length) {
    const a = items[i];
    const b = fresh[j];
    if (a && i < n && (!b || a.msg.id <= b.id)) {
      out.push(a);
      i++;
    } else if (b) {
      if (out[out.length - 1]?.key !== b.id) out.push(sent(b));
      j++;
    } else break;
  }
  for (let k = n; k < items.length; k++) {
    const c = items[k];
    if (c) out.push(c);
  }
  return out;
}

export interface UpsertOptions {
  /** REST responses carry a meaningful `Reaction.me`; events don't (proto/message.proto). */
  rest?: boolean;
}

interface MessagesState {
  rooms: Record<string, RoomMessages>;
  /** Pinned messages per room (most recently pinned first); undefined = not loaded. */
  pins: Record<string, Message[] | undefined>;
  /** Ids known to be deleted (MESSAGE_DELETE, own delete, a failed jump): reply quotes show «deleted». */
  gone: Record<string, true | undefined>;
  markGone: (id: string) => void;
  reset: () => void;
  setLoading: (roomId: string, loading: boolean, error?: string | null) => void;
  /** Older page, as returned by the API (newest first). */
  prependPage: (roomId: string, page: Message[], hasMore: boolean) => void;
  /** Newer page, as returned by the API for `after` (oldest first). */
  appendPage: (roomId: string, page: Message[], hasMore: boolean) => void;
  /** Replaces the loaded window (ascending), e.g. around a message we jump to. */
  setWindow: (roomId: string, asc: Message[], hasMoreBefore: boolean, hasMoreAfter: boolean) => void;
  /** Server message (MESSAGE_CREATE/UPDATE or a REST response): replaces the optimistic copy by nonce. */
  upsert: (m: Message, opts?: UpsertOptions) => void;
  addPending: (roomId: string, c: ChatMessage) => void;
  patchPending: (roomId: string, key: string, patch: Partial<ChatMessage>) => void;
  dropPending: (roomId: string, key: string) => void;
  remove: (roomId: string, id: string) => void;
  unload: (roomId: string) => void;
  /** Background room: keep only its newest `keep` messages (memory, review M10). */
  trim: (roomId: string, keep: number) => void;
  /**
   * The open room at the present, grown past WINDOW_CAP by live messages while the user sits at
   * the bottom: drop its oldest rows (far above the viewport) down to WINDOW_CAP.
   */
  capOpen: (roomId: string) => void;
  /** After a fresh IDENTIFY (missed events are not replayed): merge the newest page into the window. */
  resyncLatest: (roomId: string, latestDesc: Message[], hasMore: boolean) => void;
  /** MESSAGE_REACTION_ADD/REMOVE or an optimistic toggle; `mine` = the reacting user is me. */
  applyReaction: (roomId: string, messageId: string, emoji: string, add: boolean, mine: boolean) => void;
  setPins: (roomId: string, pins: Message[]) => void;
}

function room(s: MessagesState, id: string): RoomMessages {
  return s.rooms[id] ?? EMPTY;
}

function insertSorted(items: ChatMessage[], c: ChatMessage): ChatMessage[] {
  // Pending messages stay at the end until the server assigns an id.
  const out = items.slice();
  let i = out.length;
  while (i > 0) {
    const prev = out[i - 1];
    if (!prev || prev.status !== 'sent' || prev.msg.id <= c.msg.id) break;
    i--;
  }
  // Keep new server messages before trailing pending ones.
  while (i > 0 && out[i - 1]?.status !== 'sent') i--;
  out.splice(i, 0, c);
  return out;
}

/** Keeps my own `me` flags when the incoming copy comes from an event (where `me` is always false). */
export function mergeReactions(incoming: Reaction[], previous: Reaction[] | undefined): Reaction[] {
  if (!previous?.length) return incoming;
  return incoming.map((r) => {
    const old = previous.find((p) => p.emoji === r.emoji);
    return old?.me && !r.me ? { ...r, me: r.count > 0 } : r;
  });
}

/**
 * Applies one reaction change. For my own changes the flag `me` makes it idempotent: an
 * optimistic toggle followed by its gateway echo (or an echo from my other device) counts once.
 */
export function reactWith(list: Reaction[], emoji: string, add: boolean, mine: boolean): Reaction[] {
  const i = list.findIndex((r) => r.emoji === emoji);
  const cur = list[i];
  if (mine && cur && cur.me === add) return list;
  if (mine && !cur && !add) return list;
  if (add) {
    if (!cur) return [...list, { $typeName: 'calaba.v1.Reaction', emoji, count: 1, me: mine } satisfies Reaction];
    const next = list.slice();
    next[i] = { ...cur, count: cur.count + 1, me: cur.me || mine };
    return next;
  }
  if (!cur) return list;
  if (cur.count <= 1) return list.filter((_, j) => j !== i);
  const next = list.slice();
  next[i] = { ...cur, count: cur.count - 1, me: mine ? false : cur.me };
  return next;
}

function updatePins(pins: Message[] | undefined, m: Message): Message[] | undefined {
  if (!pins) return pins;
  const rest = pins.filter((p) => p.id !== m.id);
  if (!m.pinnedAt) return rest.length === pins.length ? pins : rest;
  const next = [m, ...rest];
  const at = (x: Message): number => Number(x.pinnedAt?.seconds ?? 0n) * 1000 + (x.pinnedAt?.nanos ?? 0) / 1e6;
  return next.sort((a, b) => at(b) - at(a));
}


/**
 * Merges the newest page (API order: newest first) into a room window after a re-IDENTIFY,
 * without clearing what is on screen:
 * - the covered range (ids ≥ the page's oldest id) is replaced by the page — picks up missed
 *   new messages, edits and deletions;
 * - older loaded messages stay; pending (unsent) ones stay at the end;
 * - if our newest message is older than the whole page (a gap we can't bridge), the window
 *   becomes the page, so the list never shows a hole.
 * A window browsing old history (hasMoreAfter) is left alone — it reloads when it reaches the end.
 */
export function mergeLatest(r: RoomMessages, latestDesc: Message[], hasMore: boolean): RoomMessages {
  if (r.hasMoreAfter || latestDesc.length === 0) return r;
  const page = [...latestDesc].reverse();
  const oldest = page[0]?.id ?? '';
  const sentItems = r.items.filter((c) => c.status === 'sent');
  const pending = r.items.filter((c) => c.status !== 'sent');
  const newestKnown = sentItems[sentItems.length - 1]?.msg.id ?? '';
  const prev = new Map(sentItems.map((c) => [c.msg.id, c]));
  // Keep reactions' `me` flags we knew (the page from REST carries them too; prefer the page).
  const fresh = page.map((m) => ({ ...(prev.get(m.id) ?? sent(m)), msg: m, key: m.id, status: 'sent' as const }));
  if (newestKnown && newestKnown < oldest && sentItems.length > 0) {
    return { ...r, items: [...fresh, ...pending], hasMoreBefore: hasMore, loaded: true, loading: false, error: null };
  }
  const kept = sentItems.filter((c) => c.msg.id < oldest);
  return { ...r, items: [...kept, ...fresh, ...pending], hasMoreBefore: kept.length > 0 ? r.hasMoreBefore : hasMore, loaded: true, loading: false, error: null };
}

/**
 * A background room's window cut to its newest `keep` sent messages (+ pending ones). A window
 * that browses old history (hasMoreAfter) returns null: drop it, the room reloads at the present
 * when opened again — unless it holds pending / failed messages (the user's unsent text): then it
 * is kept as is (review N2). Returns `r` itself when nothing needs to go.
 */
export function trimWindow(r: RoomMessages, keep: number): RoomMessages | null {
  if (r.hasMoreAfter) return r.items.some((c) => c.status !== 'sent') ? r : null;
  const sentItems = r.items.filter((c) => c.status === 'sent');
  if (sentItems.length <= keep) return r;
  const pending = r.items.filter((c) => c.status !== 'sent');
  return { ...r, items: [...sentItems.slice(sentItems.length - keep), ...pending], hasMoreBefore: true };
}

export const useMessages = create<MessagesState>()((rawSet) => {
  const set = (fn: (s: MessagesState) => Partial<MessagesState>): void => rawSet((s) => anchored(s, fn(s)));
  return {
    rooms: {},
    pins: {},
    gone: {},
    markGone: (id) => set((s) => (s.gone[id] ? {} : { gone: { ...s.gone, [id]: true } })),
    reset: () => rawSet({ rooms: {}, pins: {}, gone: {} }),
    setLoading: (roomId, loading, error = null) =>
      set((s) => ({ rooms: { ...s.rooms, [roomId]: { ...room(s, roomId), loading, error } } })),
    prependPage: (roomId, page, hasMore) =>
      set((s) => {
        const r = room(s, roomId);
        const known = keyIndex(r.items);
        const older = page
          .filter((m) => !known.has(m.id))
          .reverse()
          .map((m) => sent(m));
        const next = capNewest({ ...r, items: [...older, ...r.items], hasMoreBefore: hasMore, loading: false, loaded: true, error: null });
        return { rooms: { ...s.rooms, [roomId]: next } };
      }),
    appendPage: (roomId, page, hasMore) =>
      set((s) => {
        const r = room(s, roomId);
        const next = capOldest({ ...r, items: mergeAscending(r.items, page), hasMoreAfter: hasMore, loading: false, loaded: true, error: null });
        return { rooms: { ...s.rooms, [roomId]: next } };
      }),
    setWindow: (roomId, asc, hasMoreBefore, hasMoreAfter) =>
      set((s) => {
        const pending = room(s, roomId).items.filter((c) => c.status !== 'sent');
        return {
          rooms: {
            ...s.rooms,
            [roomId]: { items: [...asc.map((m) => sent(m)), ...pending], hasMoreBefore, hasMoreAfter, loading: false, loaded: true, error: null, base: room(s, roomId).base },
          },
        };
      }),
    upsert: (m, opts = {}) =>
      set((s) => {
        const pins = updatePins(s.pins[m.roomId], m);
        const pinsPatch = pins !== s.pins[m.roomId] ? { pins: { ...s.pins, [m.roomId]: pins } } : {};
        const r = s.rooms[m.roomId];
        if (!r?.loaded) return pinsPatch; // not open: fetched fresh when opened
        let idx = keyIndex(r.items).get(m.id) ?? -1;
        // The optimistic copy (pending / failed rows are at the end).
        for (let i = r.items.length - 1; idx < 0 && m.nonce !== '' && i >= 0; i--) {
          const c = r.items[i];
          if (!c || c.status === 'sent') break;
          if (c.msg.nonce === m.nonce) idx = i;
        }
        const old = r.items[idx];
        const msg = opts.rest ? m : { ...m, reactions: mergeReactions(m.reactions, old?.msg.reactions) };
        let items: ChatMessage[];
        if (idx >= 0) {
          items = r.items.slice();
          if (old?.key === m.id) {
            items[idx] = { key: m.id, msg, status: 'sent' };
          } else {
            items.splice(idx, 1);
            items = insertSorted(items, { key: m.id, msg, status: 'sent' });
          }
        } else {
          // Viewing an older window: newer messages arrive when the user scrolls down / jumps to present.
          const newest = lastSentId(r.items);
          if (r.hasMoreAfter && (!newest || m.id > newest)) return pinsPatch;
          items = insertSorted(r.items, { key: m.id, msg, status: 'sent' });
        }
        return { ...pinsPatch, rooms: { ...s.rooms, [m.roomId]: { ...r, items } } };
      }),
    addPending: (roomId, c) =>
      set((s) => {
        const r = room(s, roomId);
        return { rooms: { ...s.rooms, [roomId]: { ...r, items: [...r.items, c] } } };
      }),
    patchPending: (roomId, key, patch) =>
      set((s) => {
        const r = s.rooms[roomId];
        if (!r) return {};
        return { rooms: { ...s.rooms, [roomId]: { ...r, items: r.items.map((c) => (c.key === key ? { ...c, ...patch } : c)) } } };
      }),
    dropPending: (roomId, key) =>
      set((s) => {
        const r = s.rooms[roomId];
        if (!r) return {};
        return { rooms: { ...s.rooms, [roomId]: { ...r, items: r.items.filter((c) => c.key !== key) } } };
      }),
    remove: (roomId, id) =>
      set((s) => {
        const r = s.rooms[roomId];
        const pins = s.pins[roomId];
        const pinsPatch = pins?.some((p) => p.id === id) ? { pins: { ...s.pins, [roomId]: pins.filter((p) => p.id !== id) } } : {};
        const gonePatch = { gone: { ...s.gone, [id]: true as const } };
        if (!r) return { ...pinsPatch, ...gonePatch };
        return { ...pinsPatch, ...gonePatch, rooms: { ...s.rooms, [roomId]: { ...r, items: r.items.filter((c) => c.key !== id) } } };
      }),
    resyncLatest: (roomId, latestDesc, hasMore) =>
      set((s) => {
        const r = s.rooms[roomId];
        if (!r?.loaded) return {};
        return { rooms: { ...s.rooms, [roomId]: mergeLatest(r, latestDesc, hasMore) } };
      }),
    unload: (roomId) =>
      set((s) => {
        const rooms = { ...s.rooms };
        delete rooms[roomId];
        const pins = { ...s.pins };
        delete pins[roomId];
        return { rooms, pins };
      }),
    trim: (roomId, keep) =>
      set((s) => {
        const r = s.rooms[roomId];
        if (!r) return {};
        const next = trimWindow(r, keep);
        if (next === r) return {};
        const rooms = { ...s.rooms };
        if (next) rooms[roomId] = next;
        else delete rooms[roomId];
        return { rooms };
      }),
    capOpen: (roomId) =>
      set((s) => {
        const r = s.rooms[roomId];
        if (!r || r.hasMoreAfter) return {};
        const next = capOldest(r);
        return next === r ? {} : { rooms: { ...s.rooms, [roomId]: next } };
      }),
    applyReaction: (roomId, messageId, emoji, add, mine) =>
      set((s) => {
        const r = s.rooms[roomId];
        if (!r) return {};
        const idx = keyIndex(r.items).get(messageId) ?? -1;
        const c = r.items[idx];
        if (!c) return {};
        const reactions = reactWith(c.msg.reactions, emoji, add, mine);
        if (reactions === c.msg.reactions) return {};
        const items = r.items.slice();
        items[idx] = { ...c, msg: { ...c.msg, reactions } };
        return { rooms: { ...s.rooms, [roomId]: { ...r, items } } };
      }),
    setPins: (roomId, pins) => set((s) => ({ pins: { ...s.pins, [roomId]: pins } })),
  };
});

export const EMPTY_ROOM_MESSAGES = EMPTY;
