import { create } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { MessageSchema, type FileMeta, type Message, type UnfurlResponse } from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { errorText } from '../lib/api/errors';
import { api, uploadFile, uploadPath, type UploadHandle } from '../lib/api/endpoints';
import { sendSticker } from './stickers';
import { voiceQuery, type VoiceMeta } from '../lib/voiceNote';
import { attachmentFile } from '../lib/image';
import { canToggleReaction } from '../features/chat/reactionLimit';
import { reportPlanError } from './plan';
import { log } from '../lib/log';
import { findByKey, lastSentId, messageById, useMessages, type ChatMessage, type PendingUpload } from '../stores/messages';
import { idAfter, useRooms } from '../stores/rooms';
import { useBoards } from '../stores/boards';
import { myUserId } from '../stores/session';
import { toast } from '../stores/toasts';
import { sendTyping } from './gateway';

const PAGE = 50;

/** A row of a room's loaded window by key (O(1), stores/messages `keyIndex`). */
const findMessage = (roomId: string, key: string): ChatMessage | undefined => findByKey(useMessages.getState().rooms[roomId]?.items ?? [], key);
export const MAX_ATTACHMENTS = 20;
export const MAX_CONTENT = 4000;

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_RATE_LIMITED')) return t('chat.rateLimited');
  }
  return errorText(e);
}

/**
 * A page request that takes longer than this is abandoned (docs/09 #146): a request that stalled
 * (sleep / a network switch / a dead connection while it was in flight) kept the room's load
 * pending forever, and the in-flight dedupe turned every later open of that room into a no-op —
 * an endless spinner until the app restarted.
 */
export const LOAD_TIMEOUT_MS = 15_000;
/** A load pending this long no longer blocks a new one when the room is opened again. */
export const STALE_LOAD_MS = 10_000;

class LoadTimeout extends Error {
  constructor() {
    super('messages request timed out');
    this.name = 'LoadTimeout';
  }
}

type Page = Awaited<ReturnType<typeof api.messages.list>>;

/** One page of a room, abandoned after LOAD_TIMEOUT_MS (also when the transport ignores the abort). */
async function listPage(roomId: string, p: { before?: string; after?: string; limit?: number }): Promise<Page> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => {
      ctl.abort();
      rej(new LoadTimeout());
    }, LOAD_TIMEOUT_MS);
  });
  const req = api.messages.list(roomId, p, ctl.signal);
  req.catch(() => undefined); // when it loses the race, its AbortError is not an unhandled rejection
  try {
    return await Promise.race([req, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first load / older page of each room in flight: its generation and start. A newer load of
 * the same room (a retry, or an open after STALE_LOAD_MS) supersedes it: the late answer of the
 * old one is dropped and never touches the newer one's state.
 */
const loads = new Map<string, { gen: number; at: number }>();
let loadGen = 0;

function inFlight(roomId: string): boolean {
  const l = loads.get(roomId);
  return !!l && Date.now() - l.at < STALE_LOAD_MS;
}

function beginLoad(roomId: string): number {
  const gen = ++loadGen;
  loads.set(roomId, { gen, at: Date.now() });
  useMessages.getState().setLoading(roomId, true);
  return gen;
}

const isCurrent = (roomId: string, gen: number): boolean => loads.get(roomId)?.gen === gen;

function endLoad(roomId: string, gen: number): void {
  if (isCurrent(roomId, gen)) loads.delete(roomId);
}

function loadErrText(e: unknown): string {
  return e instanceof LoadTimeout || (e instanceof DOMException && e.name === 'AbortError') ? t('err.ctx.loadMessages') : errText(e);
}

/**
 * First load of a room. With unread messages it loads a window starting just above the
 * first unread one (the list opens there, docs/09 #39); otherwise the newest page.
 */
export async function openRoom(roomId: string): Promise<void> {
  const st = useMessages.getState().rooms[roomId];
  if (st?.loaded || inFlight(roomId)) return;
  const rooms = useRooms.getState();
  const marker = rooms.readState[roomId];
  if (marker && idAfter(rooms.lastMessage[roomId], marker)) {
    const gen = beginLoad(roomId);
    try {
      const after = await listPage(roomId, { after: marker, limit: PAGE });
      const first = after.messages[0];
      if (first) {
        const before = await listPage(roomId, { before: first.id, limit: 30 });
        if (!isCurrent(roomId, gen)) return; // superseded by a retry
        useMessages.getState().setWindow(roomId, [...before.messages].reverse().concat(after.messages), before.hasMore, after.hasMore);
        return;
      }
    } catch (e) {
      log.warn('load unread window failed', e);
    } finally {
      endLoad(roomId, gen);
    }
    // Superseded by a retry that runs or already loaded the room.
    if (loads.has(roomId) || useMessages.getState().rooms[roomId]?.loaded) return;
  }
  await loadOlder(roomId, true);
}

/**
 * «Повторить» and the reconnect retry (docs/09 #146): forgets a pending load of the room (its late
 * answer is dropped) and loads the room again.
 */
export function reloadRoom(roomId: string): Promise<void> {
  loads.delete(roomId);
  const st = useMessages.getState().rooms[roomId];
  if (st && !st.loaded) useMessages.getState().setLoading(roomId, false);
  return openRoom(roomId);
}

/** After READY / RESUMED: rooms whose first load failed (the error state) load again. */
export async function retryFailedLoads(): Promise<void> {
  const failed = Object.entries(useMessages.getState().rooms).filter(([id, r]) => !r.loaded && !!r.error && !inFlight(id));
  await Promise.all(failed.map(([id]) => reloadRoom(id)));
}

/**
 * Cursor pagination upwards (`before` = oldest loaded id). `first`: the room's first load from
 * openRoom, where a load pending longer than STALE_LOAD_MS no longer blocks.
 */
export async function loadOlder(roomId: string, first = false): Promise<void> {
  if (first ? inFlight(roomId) : loads.has(roomId)) return;
  const st = useMessages.getState().rooms[roomId];
  if (st?.loaded && !st.hasMoreBefore) return;
  const gen = beginLoad(roomId);
  try {
    const oldest = st?.items.find((c) => c.status === 'sent')?.msg.id;
    const res = await listPage(roomId, { ...(oldest ? { before: oldest } : {}), limit: PAGE });
    if (!isCurrent(roomId, gen)) return; // superseded by a retry
    useMessages.getState().prependPage(roomId, res.messages, res.hasMore);
    const newest = res.messages[0];
    if (!oldest && newest) useRooms.getState().setLastMessage(roomId, newest.id);
  } catch (e) {
    if (!isCurrent(roomId, gen)) return;
    log.warn('load messages failed', e);
    useMessages.getState().setLoading(roomId, false, loadErrText(e));
  } finally {
    endLoad(roomId, gen);
  }
}

const newerLoading = new Set<string>();

/** Cursor pagination downwards, while the loaded window doesn't reach the newest message. */
export async function loadNewer(roomId: string): Promise<void> {
  if (newerLoading.has(roomId)) return;
  const st = useMessages.getState().rooms[roomId];
  if (!st?.loaded || !st.hasMoreAfter) return;
  const newest = lastSentId(st.items);
  if (!newest) return;
  newerLoading.add(roomId);
  try {
    const res = await listPage(roomId, { after: newest, limit: PAGE });
    useMessages.getState().appendPage(roomId, res.messages, res.hasMore);
    if (!res.hasMore) {
      // Events that arrived while the window was detached were skipped: one catch-up page.
      const last = res.messages.at(-1)?.id ?? newest;
      const tail = await listPage(roomId, { after: last, limit: PAGE });
      useMessages.getState().appendPage(roomId, tail.messages, tail.hasMore);
    }
  } catch (e) {
    log.warn('load newer failed', e);
  } finally {
    newerLoading.delete(roomId);
  }
}

/**
 * Makes sure `messageId` is in the loaded window (search result, reply quote, pin).
 * Returns false if it no longer exists.
 */
export async function ensureLoaded(roomId: string, messageId: string): Promise<boolean> {
  const has = (): boolean => !!messageById(useMessages.getState(), roomId, messageId);
  if (has()) return true;
  try {
    const after = await listPage(roomId, { after: messageId, limit: 25 });
    const first = after.messages[0];
    const before = await listPage(roomId, { ...(first ? { before: first.id } : {}), limit: first ? 26 : PAGE });
    const asc = [...before.messages].reverse().concat(after.messages);
    if (!asc.some((m) => m.id === messageId)) {
      useMessages.getState().markGone(messageId);
      return false;
    }
    useMessages.getState().setWindow(roomId, asc, before.hasMore, after.hasMore);
    return true;
  } catch (e) {
    log.warn('jump failed', e);
    toast.fail(e, t('err.ctx.loadMessage'));
    return false;
  }
}

/** Resolves true once `ok()` holds (polled every 50 ms; only while a jump waits), false after `ms`. */
async function waitFor(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Like ensureLoaded, but keeps the window contiguous with the newest message: pages upwards from
 * the present until `messageId` is loaded (≤ `maxPages`). For feeds without «load newer» — a
 * task's activity (a search hit in its comments, ADR-0062 §4). False when it was not reached.
 */
export async function revealOlder(roomId: string, messageId: string, maxPages = 20): Promise<boolean> {
  const st = (): ReturnType<typeof useMessages.getState>['rooms'][string] | undefined => useMessages.getState().rooms[roomId];
  const has = (): boolean => !!findMessage(roomId, messageId);
  void openRoom(roomId);
  if (!(await waitFor(() => !!st()?.loaded || !!st()?.error, 15_000))) return has();
  for (let i = 0; i < maxPages && !has(); i++) {
    if (!st()?.hasMoreBefore) break;
    if (!(await waitFor(() => !loads.has(roomId), 15_000))) break;
    await loadOlder(roomId);
  }
  return has();
}

/**
 * After a fresh IDENTIFY (server deploy → INVALID_SESSION{resumable:false}) missed events are
 * not replayed: refetch the newest page of every loaded room and merge it in place (no flicker).
 */
export async function resyncLoadedRooms(): Promise<void> {
  const loaded = Object.entries(useMessages.getState().rooms).filter(([, r]) => r.loaded && !r.hasMoreAfter);
  await Promise.all(
    loaded.map(async ([roomId]) => {
      try {
        const res = await listPage(roomId, { limit: PAGE });
        useMessages.getState().resyncLatest(roomId, res.messages, res.hasMore);
      } catch (e) {
        log.warn('resync failed', roomId, e);
      }
    }),
  );
}

/** Back to the newest messages after browsing an older window. */
export async function loadPresent(roomId: string): Promise<void> {
  const st = useMessages.getState().rooms[roomId];
  if (!st?.hasMoreAfter) return;
  try {
    const res = await listPage(roomId, { limit: PAGE });
    useMessages.getState().setWindow(roomId, [...res.messages].reverse(), res.hasMore, false);
  } catch (e) {
    toast.fail(e, t('err.ctx.loadMessages'), () => void loadPresent(roomId));
  }
}

// ---- reactions / pins

/**
 * Adds or removes the viewer's `emoji`. At most MAX_REACTIONS_PER_USER different emojis per
 * message (docs/09 #27): a new one past the limit is not sent, only the hint is shown; the
 * server's 409 REACTION_LIMIT (a stale view, another device) shows the same hint.
 */
export async function toggleReaction(roomId: string, m: Message, emoji: string): Promise<void> {
  // The store's copy: the caller's may be a render old.
  const cur = messageById(useMessages.getState(), roomId, m.id) ?? m;
  const mine = cur.reactions.find((r) => r.emoji === emoji)?.me ?? false;
  const add = !mine;
  if (add && !canToggleReaction(cur.reactions, emoji)) {
    toast.info(t('chat.reactionLimit'));
    return;
  }
  useMessages.getState().applyReaction(roomId, m.id, emoji, add, true);
  try {
    await (add ? api.messages.addReaction(m.id, emoji) : api.messages.removeReaction(m.id, emoji));
  } catch (e) {
    useMessages.getState().applyReaction(roomId, m.id, emoji, !add, true);
    if (e instanceof ApiError && e.reason === 'REACTION_LIMIT') toast.info(t('chat.reactionLimit'));
    else toast.fail(e, t('err.ctx.react'));
  }
}

export async function setPinned(m: Message, pin: boolean): Promise<void> {
  try {
    await (pin ? api.messages.pin(m.id) : api.messages.unpin(m.id));
    // MESSAGE_UPDATE brings pinned_at to everyone, including us.
  } catch (e) {
    toast.fail(e, t(pin ? 'err.ctx.pin' : 'err.ctx.unpin'));
  }
}

/**
 * «Скрыть превью» (docs/09 #51): author or MANAGE_MESSAGES. Optimistic; the server answers with
 * the message and fans out MESSAGE_UPDATE (no edited_at: it is not an edit). Rolls back on error.
 */
export async function setEmbedsHidden(m: Message, hidden: boolean): Promise<void> {
  const apply = (v: boolean): void => {
    const cur = messageById(useMessages.getState(), m.roomId, m.id) ?? m;
    if (cur.embedsHidden !== v) useMessages.getState().upsert({ ...cur, embedsHidden: v }, { rest: true });
  };
  apply(hidden);
  try {
    const r = await api.messages.setEmbedsHidden(m.id, hidden);
    if (r.message) useMessages.getState().upsert(r.message, { rest: true });
  } catch (e) {
    apply(!hidden);
    toast.fail(e, hidden ? t('chat.embedHideFailed') : t('chat.embedShowFailed'));
  }
}

const pinsLoading = new Set<string>();

/**
 * Pins of a room, fetched once: afterwards MESSAGE_UPDATE / MESSAGE_DELETE keep them current
 * (stores/messages updatePins), including while the room is closed. Refetched only after a fresh
 * IDENTIFY (resyncPins: missed events are not replayed) or once the store dropped them (unload).
 */
export async function loadPins(roomId: string, force = false): Promise<void> {
  if (pinsLoading.has(roomId) || (!force && useMessages.getState().pins[roomId] !== undefined)) return;
  pinsLoading.add(roomId);
  try {
    const res = await api.messages.pins(roomId);
    useMessages.getState().setPins(roomId, res.messages);
  } catch (e) {
    log.warn('load pins failed', e);
  } finally {
    pinsLoading.delete(roomId);
  }
}

/** After a fresh IDENTIFY: refetch every room's pins we hold (see loadPins). */
export async function resyncPins(): Promise<void> {
  const held = Object.entries(useMessages.getState().pins).filter(([, p]) => p !== undefined);
  await Promise.all(held.map(([roomId]) => loadPins(roomId, true)));
}

// ---- link previews: one request per URL per session (the server caches for everyone)

const unfurlCache = new Map<string, Promise<UnfurlResponse | null>>();
const UNFURL_CACHE_MAX = 300;

export function unfurl(url: string): Promise<UnfurlResponse | null> {
  const hit = unfurlCache.get(url);
  if (hit) return hit;
  const p = api.unfurl.get(url).then(
    (r) => (r.title || r.description || r.imageUrl || r.task || r.board ? r : null),
    () => null,
  );
  unfurlCache.set(url, p);
  if (unfurlCache.size > UNFURL_CACHE_MAX) {
    const oldest = unfurlCache.keys().next().value;
    if (oldest !== undefined) unfurlCache.delete(oldest);
  }
  return p;
}

export interface OutgoingFile {
  file: Blob;
  name: string;
  previewUrl?: string;
  /** A voice message (docs/09 #43): uploaded with its duration and waveform. */
  voice?: VoiceMeta;
}

function newNonce(): string {
  return crypto.randomUUID();
}

/** Where an attachment of this room goes: a task comment → its board (ADR-0042), else uploadPath. */
function attachmentPath(workspaceId: string, roomId: string): string {
  const b = useBoards.getState();
  const taskId = b.roomTask[roomId];
  const boardId = taskId ? b.tasks[taskId]?.boardId : undefined;
  return boardId ? `/api/boards/${boardId}/files` : uploadPath(workspaceId, roomId);
}

/**
 * Optimistic send: shows the message immediately (pending), uploads files
 * with progress, then POSTs with a `nonce` — retries are idempotent on the
 * server (docs/04, "Сообщения: порядок и идемпотентность").
 */
export async function sendMessage(
  workspaceId: string,
  roomId: string,
  content: string,
  files: OutgoingFile[],
  replyToId: string | undefined,
  nonce = newNonce(),
): Promise<void> {
  const key = `local:${nonce}`;
  const uploads: PendingUpload[] = files.map((f, i) => ({
    key: `${nonce}:${i}`,
    name: f.name,
    size: f.file.size,
    progress: 0,
    ...(f.previewUrl ? { previewUrl: f.previewUrl } : {}),
  }));
  const msg = create(MessageSchema, {
    id: '',
    roomId,
    authorId: myUserId(),
    content,
    nonce,
    replyToId: replyToId ?? '',
    createdAt: timestampNow(),
  });
  const existing = findMessage(roomId, key);
  if (existing) useMessages.getState().patchPending(roomId, key, { status: 'pending', uploads, error: '' });
  else useMessages.getState().addPending(roomId, { key, msg, status: 'pending', uploads } satisfies ChatMessage);

  try {
    const metas: FileMeta[] = [];
    const handles: UploadHandle[] = [];
    for (const [i, f] of files.entries()) {
      const path = attachmentPath(workspaceId, roomId) + (f.voice ? voiceQuery(f.voice) : '');
      // HEIC (iPhone photos) → JPEG `.jpg` that every client shows (docs/02 «Изображения»).
      const out = f.voice ? { blob: f.file, name: f.name } : await attachmentFile(f.file, f.name);
      if (out.blob !== f.file) {
        const cur = findMessage(roomId, key);
        if (cur?.uploads) {
          useMessages.getState().patchPending(roomId, key, {
            uploads: cur.uploads.map((u, j) => (j === i ? { ...u, name: out.name, size: out.blob.size } : u)),
          });
        }
      }
      const h = uploadFile(path, out.blob, out.name, (p) => {
        const cur = findMessage(roomId, key);
        if (!cur?.uploads) return;
        useMessages.getState().patchPending(roomId, key, {
          uploads: cur.uploads.map((u, j) => (j === i ? { ...u, progress: p } : u)),
        });
      });
      handles.push(h);
      metas.push(await h.promise);
    }
    const res = await api.messages.create(roomId, {
      content,
      attachmentIds: metas.map((m) => m.id),
      replyToId: replyToId ?? '',
      nonce,
    });
    if (res.message) {
      useMessages.getState().upsert(res.message, { rest: true });
      useRooms.getState().setLastMessage(roomId, res.message.id);
      useRooms.getState().setRead(roomId, res.message.id);
    }
  } catch (e) {
    log.warn('send failed', e);
    useMessages.getState().patchPending(roomId, key, { status: 'failed', error: errText(e) });
    // 413 FILE_QUOTA_EXCEEDED: how full the storage is, and «Связаться» when the plan is the cause (ADR-0024).
    reportPlanError(e, workspaceId);
  }
}

/** Retry keeps the same nonce, so the server never creates a duplicate. */
export function retrySend(workspaceId: string, roomId: string, c: ChatMessage, files: OutgoingFile[] = []): Promise<void> {
  if (c.msg.sticker) return sendSticker(workspaceId, roomId, c.msg.sticker, c.msg.replyToId || undefined, c.msg.nonce);
  return sendMessage(workspaceId, roomId, c.msg.content, files, c.msg.replyToId || undefined, c.msg.nonce);
}

export async function editMessage(id: string, content: string): Promise<void> {
  try {
    const r = await api.messages.update(id, content);
    if (r.message) useMessages.getState().upsert(r.message, { rest: true });
  } catch (e) {
    toast.fail(e, t('err.ctx.edit'));
  }
}

export async function deleteMessage(roomId: string, id: string): Promise<void> {
  try {
    await api.messages.remove(id);
    useMessages.getState().remove(roomId, id);
  } catch (e) {
    toast.fail(e, t('err.ctx.delete'));
  }
}

// ---- read state: move the marker forward when the newest message is on screen ----

const readTimers = new Map<string, number>();
const sentRead = new Map<string, string>();

export function markRead(roomId: string, messageId: string): void {
  if (!messageId || messageId.startsWith('local:')) return;
  useRooms.getState().setRead(roomId, messageId);
  if ((sentRead.get(roomId) ?? '') >= messageId) return;
  const t = readTimers.get(roomId);
  if (t) window.clearTimeout(t);
  readTimers.set(
    roomId,
    window.setTimeout(() => {
      readTimers.delete(roomId);
      sentRead.set(roomId, messageId);
      void api.messages.markRead(roomId, messageId).catch((e: unknown) => log.warn('mark read failed', e));
    }, 600),
  );
}

// ---- typing: at most one TYPING per 3 s per room (server rate limit 1/3 s) ----

const lastTyping = new Map<string, number>();

export function notifyTyping(roomId: string): void {
  const now = Date.now();
  if (now - (lastTyping.get(roomId) ?? 0) < 3000) return;
  lastTyping.set(roomId, now);
  sendTyping(roomId);
}

export function resetChatCaches(): void {
  loads.clear();
  newerLoading.clear();
  pinsLoading.clear();
  unfurlCache.clear();
  sentRead.clear();
  lastTyping.clear();
  for (const t of readTimers.values()) window.clearTimeout(t);
  readTimers.clear();
}

/** Drop only the revoked workspace room windows and their pending read/typing work. */
export function clearChatRooms(ids: ReadonlySet<string>): void {
  for (const id of ids) {
    loads.delete(id);
    newerLoading.delete(id);
    pinsLoading.delete(id);
    sentRead.delete(id);
    lastTyping.delete(id);
    const timer = readTimers.get(id);
    if (timer) window.clearTimeout(timer);
    readTimers.delete(id);
  }
  unfurlCache.clear();
}
