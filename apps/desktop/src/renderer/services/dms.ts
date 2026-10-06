import type { DmSummary, Message } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { HOME, dmWith, isDm, useDms } from '../stores/dms';
import { useMessages } from '../stores/messages';
import { useNotes } from '../stores/notes';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { useReadReceipts } from '../stores/readReceipts';
import { useRoomPreviews } from '../stores/roomPreviews';

/**
 * Direct messages (ADR-0020, docs/05 «Личные сообщения»): the DM room goes into the rooms store
 * like any room (messages, read state, counters, notification settings use the room code), the
 * peer's profile into the users map, the DM itself into stores/dms.ts.
 */
export function applyDm(dm: DmSummary, withReadState: boolean): void {
  const room = dm.room;
  if (!room || !dm.peer) return;
  const rooms = useRooms.getState();
  rooms.upsert(room);
  if (room.lastMessageId) rooms.setLastMessage(room.id, room.lastMessageId);
  // The peer's profile: only when we don't share a workspace (a member entry is fresher then).
  useWorkspaces.getState().upsertUser(dm.peer);
  if (withReadState && dm.readState) {
    rooms.setRead(room.id, dm.readState.lastReadMessageId);
    rooms.setCounts(room.id, dm.readState.unreadCount, dm.readState.mentionCount);
  }
  if (dm.peerReadMessageId) useReadReceipts.getState().set(room.id, dm.peerReadMessageId);
  useDms.getState().upsert(dm);
}

/**
 * My own state of a DM (docs/09 #51): from DM_STATE_UPDATE, a PATCH answer or an optimistic
 * change. A new «Удалить чат» mark drops the loaded history and the counters (the server counts
 * from the mark too) and closes the chat if it is open here.
 */
export function applyDmState(roomId: string, archivedAt: number, clearedBefore: string): void {
  const dms = useDms.getState();
  const prev = dms.byRoom[roomId];
  if (!prev) return;
  const cleared = clearedBefore !== '' && clearedBefore > prev.clearedBefore;
  if (clearedBefore < prev.clearedBefore) clearedBefore = prev.clearedBefore; // a stale event never un-hides
  dms.setState(roomId, archivedAt, clearedBefore);
  if (!cleared) return;
  useMessages.getState().unload(roomId);
  useRooms.getState().setCounts(roomId, 0, 0);
  const ui = useUi.getState();
  if (ui.lastRoom[HOME] === roomId) ui.selectDefaultRoom(HOME, '');
}

/** Applies a DmSummary's own state (PATCH answer). */
function applySummaryState(dm: DmSummary): void {
  if (dm.room) applyDmState(dm.room.id, dm.archivedAt ? timestampMs(dm.archivedAt) : 0, dm.clearedBeforeMessageId);
}

/** «В архив» / «Вернуть из архива»: for me only; optimistic, rolled back on failure. */
export async function setDmArchived(roomId: string, archived: boolean): Promise<void> {
  const prev = useDms.getState().byRoom[roomId];
  if (!prev) return;
  useDms.getState().setState(roomId, archived ? Date.now() : 0, prev.clearedBefore);
  try {
    const res = await api.dms.setState(roomId, { archived });
    if (res.dm) applySummaryState(res.dm);
  } catch (e) {
    log.warn('dm archive failed', e);
    useDms.getState().setState(roomId, prev.archivedAt, prev.clearedBefore);
    toast.error(t('dm.errState'));
  }
}

/**
 * «Удалить чат» (for me only; the UI confirms first): the history up to now is no longer shown to
 * me, the peer keeps theirs. The DM leaves the list until a new message arrives.
 */
export async function clearDm(roomId: string): Promise<boolean> {
  try {
    const res = await api.dms.setState(roomId, { cleared: true });
    if (res.dm) applySummaryState(res.dm);
    return true;
  } catch (e) {
    log.warn('dm delete failed', e);
    toast.error(t('dm.errState'));
    return false;
  }
}

/** Opens the DM in the «Личные» view. */
export function openDm(roomId: string): void {
  useUi.getState().openRoom(HOME, roomId);
}

/**
 * «Написать»: opens the DM with the user, creating it first when needed (POST /api/dms is
 * get-or-create; the new DM also arrives as DM_CREATE, applying it twice is harmless).
 */
export async function startDm(userId: string): Promise<boolean> {
  const known = dmWith(userId);
  if (known) {
    openDm(known.roomId);
    return true;
  }
  try {
    const res = await api.dms.create(userId);
    if (!res.dm?.room) return false;
    applyDm(res.dm, true);
    openDm(res.dm.room.id);
    return true;
  } catch (e) {
    log.warn('create dm failed', e);
    toast.error(dmErrorText(e));
    return false;
  }
}

/**
 * Sends a text to the user's DM without opening it (the room invite, docs/09 #33): the DM is
 * created first when needed (POST /api/dms is get-or-create). Throws on failure — the caller
 * shows the error on its own row.
 */
export async function sendDmText(userId: string, content: string): Promise<void> {
  await api.messages.create(await ensureDm(userId), { content, nonce: crypto.randomUUID() });
}

/** The DM room with the user, created when needed (POST /api/dms is get-or-create). Throws on failure. */
export async function ensureDm(userId: string): Promise<string> {
  const known = dmWith(userId)?.roomId;
  if (known) return known;
  const res = await api.dms.create(userId);
  if (!res.dm?.room) throw new Error('no dm in the answer');
  applyDm(res.dm, true);
  return res.dm.room.id;
}

/**
 * A `/dm/<id>` link (links.ts) opened «Личные» on that id. Once signed in, a DM this user is not
 * in (someone else's link, a deleted DM, a guest account) gets a clear error instead of an empty
 * «Личные», and the id is forgotten. An unknown DM is re-read first (GET /api/dms).
 */
export function checkDmLink(roomId: string): void {
  const verify = async (): Promise<void> => {
    if (isDm(useRooms.getState().byId[roomId])) return;
    await refreshDms();
    if (isDm(useRooms.getState().byId[roomId])) return;
    toast.error(t('dm.errLink'));
    const ui = useUi.getState();
    if (ui.lastRoom[HOME] === roomId) ui.selectDefaultRoom(HOME, '');
  };
  if (useSession.getState().ready) {
    void verify();
    return;
  }
  const stop = useSession.subscribe((s) => {
    if (!s.ready) return;
    stop();
    void verify();
  });
}

export function dmErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return t('dm.errRateLimited');
    if (e.status === 403) return t('dm.errGuest');
    if (e.status === 404) return t('dm.errNoCommon');
    if (e.status === 422) return t('dm.errSelf');
  }
  return t('dm.errCreate');
}

let refreshing: Promise<void> | null = null;

/** GET /api/dms: re-reads the list (a DM seen only through its messages). */
export function refreshDms(): Promise<void> {
  refreshing ??= api.dms
    .list()
    .then((res) => {
      for (const dm of res.dms) if (!useRooms.getState().byId[dm.room?.id ?? '']) applyDm(dm, true);
    })
    .catch((e: unknown) => log.warn('list dms failed', e))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const previewLoading = new Set<string>();

/** A store holding list previews by room (DMs, notes shelves, workspace rooms). */
interface PreviewStore {
  getState: () => { preview: Record<string, unknown>; setPreview: (roomId: string, m: Message | null) => void };
}

/**
 * The previewed last message of a DM was deleted: the next newest one comes from the loaded
 * chat when it has the end of the history, else from one GET …/messages?limit=1. Every other
 * preview comes with DmSummary.last_message (no request per DM when the list opens).
 */
export async function refreshDmPreview(roomId: string): Promise<void> {
  // A notes shelf (ADR-0039) keeps its preview the same way.
  await refreshPreview(useDms.getState().byRoom[roomId] ? useDms : useNotes, roomId);
}

/**
 * A workspace room's previewed last message was deleted (ADR-0073 §5): as refreshDmPreview. The
 * other previews come with WorkspaceSnapshot.room_last_messages.
 */
export async function refreshRoomPreview(roomId: string): Promise<void> {
  await refreshPreview(useRoomPreviews, roomId);
}

async function refreshPreview(store: PreviewStore, roomId: string): Promise<void> {
  if (store.getState().preview[roomId] !== undefined || previewLoading.has(roomId)) return;
  const loaded = useMessages.getState().rooms[roomId];
  if (loaded?.loaded && !loaded.hasMoreAfter) {
    const newest = [...loaded.items].reverse().find((c) => c.status === 'sent')?.msg;
    store.getState().setPreview(roomId, newest ?? null);
    return;
  }
  previewLoading.add(roomId);
  try {
    const res = await api.messages.list(roomId, { limit: 1 });
    // A live message may have landed meanwhile: it is the newer preview then.
    if (store.getState().preview[roomId] === undefined) store.getState().setPreview(roomId, res.messages[0] ?? null);
  } catch (e) {
    log.warn('preview failed', roomId, e);
  } finally {
    previewLoading.delete(roomId);
  }
}

export function resetDmCaches(): void {
  previewLoading.clear();
}
