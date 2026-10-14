import { MessageKind, RoomType, type DmLastMessage, type DmSummary, type Message, type Room } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { create } from 'zustand';
import { systemPreview } from '../lib/recording';
import { stickerPreview } from '../lib/stickers';

/**
 * Direct messages (ADR-0020). A DM is a room without a workspace: the room itself lives in
 * stores/rooms.ts (read state, unread / mention counters, notification settings — all shared
 * with workspace rooms), the peer's profile in stores/workspaces.ts `users`. This store keeps
 * what only DMs have: who the peer is, the last activity (list order) and the last message
 * preview shown in the list.
 */
export interface DmEntry {
  roomId: string;
  peerId: string;
  /** Last activity, unix ms: the newest message, else the DM's creation. Sorts the list. */
  activity: number;
  /** In my archive since (unix ms); 0 = not archived (docs/09 #51). */
  archivedAt: number;
  /** «Удалить чат»: messages with ids <= this are hidden from me; '' = never cleared. */
  clearedBefore: string;
}

export interface DmPreview {
  messageId: string;
  authorId: string;
  content: string;
  attachments: number;
  at: number;
}

interface DmsState {
  byRoom: Record<string, DmEntry>;
  /**
   * Newest message per DM (null = no messages): from DmSummary.last_message (READY, DM_CREATE,
   * GET /api/dms), then kept by live events. Absent = unknown (its message was deleted and the
   * next one is being fetched).
   */
  preview: Record<string, DmPreview | null>;
  reset: () => void;
  /** READY: the whole list (replaces it, previews from the summaries). */
  setAll: (list: DmSummary[]) => void;
  upsert: (dm: DmSummary) => void;
  /** A message in a DM: newest preview + activity (older or equal ids are ignored). */
  onMessage: (m: Message) => void;
  /** An edit / deletion of the previewed message: `null` = deleted (the caller refetches it). */
  onChanged: (roomId: string, messageId: string, m: Message | null) => void;
  setPreview: (roomId: string, m: Message | null) => void;
  /**
   * My own state of a DM (DM_STATE_UPDATE, PATCH /api/dms/{id}/state): archive / «Удалить чат».
   * A newer clear mark drops the preview it hides.
   */
  setState: (roomId: string, archivedAt: number, clearedBefore: string) => void;
}

/** The «Личные» pseudo-workspace id in the UI store (Discord's `@me`). Never a real workspace id. */
export const HOME = '@me';

export const isDm = (room: Pick<Room, 'type'> | undefined): boolean => room?.type === RoomType.DM;

const ms = (t: Parameters<typeof timestampMs>[0] | undefined): number => (t ? timestampMs(t) : 0);

function entryOf(dm: DmSummary): DmEntry | null {
  if (!dm.room || !dm.peer) return null;
  return {
    roomId: dm.room.id,
    peerId: dm.peer.id,
    activity: Math.max(ms(dm.lastMessageAt ?? dm.room.lastMessageAt), ms(dm.room.createdAt)),
    archivedAt: ms(dm.archivedAt),
    clearedBefore: dm.clearedBeforeMessageId,
  };
}

export function previewOf(m: Message): DmPreview {
  // A system card previews as its one line (ADR-0025; its content is empty).
  return { messageId: m.id, authorId: m.authorId, content: systemPreview(m) || m.content, attachments: m.attachments.length, at: ms(m.createdAt) };
}

/** The summary's preview (DmSummary.last_message; content ≤ 200 characters); null = no messages. */
function summaryPreview(dm: DmSummary): DmPreview | null {
  return lastMessagePreview(dm.lastMessage);
}

/** A list preview from DmLastMessage (DMs and notes shelves, ADR-0039); null = no messages. */
export function lastMessagePreview(m: DmLastMessage | undefined): DmPreview | null {
  if (!m?.id) return null;
  // A sticker (ADR-0030) previews as «😀 Стикер» (its content is empty); a system card of a room
  // (DmLastMessage.system, e.g. the room picture, ADR-0092) as its one line.
  const content = m.stickerEmoji ? stickerPreview(m.stickerEmoji) : (m.system && systemPreview({ kind: MessageKind.SYSTEM, system: m.system })) || m.content;
  return { messageId: m.id, authorId: m.authorId, content, attachments: m.attachmentCount, at: ms(m.createdAt) };
}

/** The newer of two previews (message ids are time-ordered uuidv7): a live event may be ahead of a summary. */
export function newer(a: DmPreview | null | undefined, b: DmPreview | null): DmPreview | null {
  if (!a) return b;
  if (!b) return a;
  return a.messageId > b.messageId ? a : b;
}

export const useDms = create<DmsState>()((set) => ({
  byRoom: {},
  preview: {},
  reset: () => set({ byRoom: {}, preview: {} }),
  setAll: (list) =>
    set(() => {
      const byRoom: Record<string, DmEntry> = {};
      const preview: Record<string, DmPreview | null> = {};
      for (const dm of list) {
        const e = entryOf(dm);
        if (!e) continue;
        byRoom[e.roomId] = e;
        preview[e.roomId] = summaryPreview(dm);
      }
      return { byRoom, preview };
    }),
  upsert: (dm) =>
    set((s) => {
      const e = entryOf(dm);
      if (!e) return {};
      const prev = s.byRoom[e.roomId];
      return {
        byRoom: { ...s.byRoom, [e.roomId]: prev ? { ...e, activity: Math.max(prev.activity, e.activity) } : e },
        preview: { ...s.preview, [e.roomId]: newer(s.preview[e.roomId], summaryPreview(dm)) },
      };
    }),
  onMessage: (m) =>
    set((s) => {
      const e = s.byRoom[m.roomId];
      if (!e) return {};
      const cur = s.preview[m.roomId];
      if (cur && cur.messageId >= m.id) return {};
      const p = previewOf(m);
      return {
        byRoom: { ...s.byRoom, [m.roomId]: { ...e, activity: Math.max(e.activity, p.at) } },
        preview: { ...s.preview, [m.roomId]: p },
      };
    }),
  onChanged: (roomId, messageId, m) =>
    set((s) => {
      if (s.preview[roomId]?.messageId !== messageId) return {};
      const preview = { ...s.preview };
      if (m) preview[roomId] = previewOf(m);
      else delete preview[roomId];
      return { preview };
    }),
  setPreview: (roomId, m) => set((s) => ({ preview: { ...s.preview, [roomId]: m ? previewOf(m) : null } })),
  setState: (roomId, archivedAt, clearedBefore) =>
    set((s) => {
      const e = s.byRoom[roomId];
      if (!e) return {};
      const out: Partial<DmsState> = { byRoom: { ...s.byRoom, [roomId]: { ...e, archivedAt, clearedBefore } } };
      const p = s.preview[roomId];
      if (clearedBefore && p && p.messageId <= clearedBefore) out.preview = { ...s.preview, [roomId]: null };
      return out;
    }),
}));

/**
 * A DM I deleted («Удалить чат») with nothing newer since: not listed until a new message
 * arrives (the same room then shows as a clean chat). An unknown preview (being refetched) counts
 * as not hidden.
 */
export function isHiddenDm(e: DmEntry, preview: DmPreview | null | undefined): boolean {
  if (!e.clearedBefore) return false;
  return preview === null || (preview !== undefined && preview.messageId <= e.clearedBefore);
}

/**
 * The «Личные» list split (docs/09 #51): the main list and «Архив», both by last activity.
 * Deleted chats are left out, except `keep` (the open DM: «Написать» to a deleted chat opens it).
 */
export function splitDms(byRoom: Record<string, DmEntry>, preview: Record<string, DmPreview | null>, keep = ''): { main: DmEntry[]; archived: DmEntry[] } {
  const main: DmEntry[] = [];
  const archived: DmEntry[] = [];
  for (const e of sortedDms(byRoom)) {
    if (e.roomId !== keep && isHiddenDm(e, preview[e.roomId])) continue;
    (e.archivedAt ? archived : main).push(e);
  }
  return { main, archived };
}

/** DMs, most recent activity first (ties: newest room first). */
export function sortedDms(byRoom: Record<string, DmEntry>): DmEntry[] {
  return Object.values(byRoom).sort((a, b) => b.activity - a.activity || b.roomId.localeCompare(a.roomId));
}

/** The DM with this user, if there is one. */
export function dmWith(userId: string): DmEntry | undefined {
  return Object.values(useDms.getState().byRoom).find((e) => e.peerId === userId);
}

/** The peer of a DM room ('' when unknown). */
export function dmPeer(roomId: string): string {
  return useDms.getState().byRoom[roomId]?.peerId ?? '';
}
