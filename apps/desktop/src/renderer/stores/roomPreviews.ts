import type { Message, WorkspaceSnapshot } from '@calaba/protocol';
import { create } from 'zustand';
import { lastMessagePreview, newer, previewOf, type DmPreview } from './dms';

/**
 * Last message preview of workspace rooms for the phone room list (ADR-0073 §5). Same shape as a
 * DM preview. Filled from READY / WORKSPACE_CREATE (WorkspaceSnapshot.room_last_messages) and
 * kept by live MESSAGE_CREATE / UPDATE / DELETE events (services/dispatch.ts); a deleted preview
 * is refetched lazily (services/dms.ts `refreshRoomPreview`).
 *
 * Every action changes only the keys it touches and returns the same state when nothing changes
 * (no notification), so a row subscribed with `useRoomPreview` re-renders only for its own room.
 */
interface RoomPreviewsState {
  /** roomId → newest message; null = room has no messages; absent = unknown / not loaded. */
  preview: Record<string, DmPreview | null>;
  reset: () => void;
  /** READY: the previews of every snapshot replace the store (rooms without an entry: null). */
  setAll: (snaps: WorkspaceSnapshot[]) => void;
  /** WORKSPACE_CREATE: one workspace's previews merged in (a newer live one already held wins). */
  applySnapshot: (snap: WorkspaceSnapshot) => void;
  /** A message in a workspace room: the newest preview (older or equal ids are ignored). */
  onMessage: (m: Message) => void;
  /** An edit / deletion of the previewed message: `null` = deleted (unknown; the caller refetches). */
  onChanged: (roomId: string, messageId: string, m: Message | null) => void;
  /** The refetched newest message (null = the room has none left). */
  setPreview: (roomId: string, m: Message | null) => void;
  /** Rooms gone (ROOM_DELETE, WORKSPACE_DELETE): their previews dropped. */
  drop: (roomIds: string[]) => void;
}

function snapshotPreviews(snap: WorkspaceSnapshot, into: Record<string, DmPreview | null>): void {
  for (const room of snap.rooms) into[room.id] = lastMessagePreview(snap.roomLastMessages[room.id]);
}

export const useRoomPreviews = create<RoomPreviewsState>()((set) => ({
  preview: {},
  reset: () => set({ preview: {} }),
  setAll: (snaps) => {
    const preview: Record<string, DmPreview | null> = {};
    for (const snap of snaps) snapshotPreviews(snap, preview);
    set({ preview });
  },
  applySnapshot: (snap) =>
    set((s) => {
      const fresh: Record<string, DmPreview | null> = {};
      snapshotPreviews(snap, fresh);
      const preview = { ...s.preview };
      for (const [id, p] of Object.entries(fresh)) preview[id] = newer(s.preview[id], p);
      return { preview };
    }),
  onMessage: (m) =>
    set((s) => {
      const cur = s.preview[m.roomId];
      if (cur && cur.messageId >= m.id) return s;
      return { preview: { ...s.preview, [m.roomId]: previewOf(m) } };
    }),
  onChanged: (roomId, messageId, m) =>
    set((s) => {
      if (s.preview[roomId]?.messageId !== messageId) return s;
      const preview = { ...s.preview };
      if (m) preview[roomId] = previewOf(m);
      else delete preview[roomId];
      return { preview };
    }),
  setPreview: (roomId, m) => set((s) => ({ preview: { ...s.preview, [roomId]: m ? previewOf(m) : null } })),
  drop: (roomIds) =>
    set((s) => {
      const gone = roomIds.filter((id) => id in s.preview);
      if (gone.length === 0) return s;
      const preview = { ...s.preview };
      for (const id of gone) delete preview[id];
      return { preview };
    }),
}));

/** One room's preview (leaf subscription: a row re-renders only when its own preview changes). */
export const useRoomPreview = (roomId: string): DmPreview | null | undefined =>
  useRoomPreviews((s) => s.preview[roomId]);
