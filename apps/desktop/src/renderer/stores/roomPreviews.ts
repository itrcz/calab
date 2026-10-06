import { create } from 'zustand';
import type { DmPreview } from './dms';

/**
 * Last message preview of workspace rooms for the phone room list (ADR-0073 §5). Same shape as a
 * DM preview. Filled from READY (WorkspaceSnapshot) and kept by live MESSAGE_CREATE / UPDATE /
 * DELETE events.
 *
 * Contract stub: the protocol task fills `preview`; the UI only reads it via `useRoomPreview`.
 */
interface RoomPreviewsState {
  /** roomId → newest message; null = room has no messages; absent = unknown / not loaded. */
  preview: Record<string, DmPreview | null>;
  reset: () => void;
}

export const useRoomPreviews = create<RoomPreviewsState>()((set) => ({
  preview: {},
  reset: () => set({ preview: {} }),
}));

/** One room's preview (leaf subscription: a row re-renders only when its own preview changes). */
export const useRoomPreview = (roomId: string): DmPreview | null | undefined =>
  useRoomPreviews((s) => s.preview[roomId]);
