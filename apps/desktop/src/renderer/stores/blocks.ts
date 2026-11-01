import { create } from 'zustand';

/*
 * People I blocked (ADR-0154; GET /api/me/blocked-users on every READY, USER_BLOCKS_UPDATE from
 * my other devices). The server refuses DMs and calls; shared rooms are hidden here: a message
 * row subscribes to `isBlocked(authorId)` — a primitive — so a block re-renders only that
 * author's rows. `revealed` keeps the hidden messages the user chose to show (this session only).
 */
interface BlocksState {
  /** null until loaded. */
  ids: Record<string, true> | null;
  revealed: Record<string, true>;
  setAll: (ids: readonly string[]) => void;
  setOne: (userId: string, blocked: boolean) => void;
  reveal: (messageKey: string) => void;
  reset: () => void;
}

export const useBlocks = create<BlocksState>()((set) => ({
  ids: null,
  revealed: {},
  setAll: (ids) => set({ ids: Object.fromEntries(ids.map((id) => [id, true as const])) }),
  setOne: (userId, blocked) =>
    set((s) => {
      if (!!s.ids?.[userId] === blocked) return s;
      const next = { ...(s.ids ?? {}) };
      if (blocked) next[userId] = true;
      else delete next[userId];
      return { ids: next };
    }),
  reveal: (messageKey) => set((s) => (s.revealed[messageKey] ? s : { revealed: { ...s.revealed, [messageKey]: true } })),
  reset: () => set({ ids: null, revealed: {} }),
}));

/** Non-React check (notifications, sounds): did I block this user? */
export const isBlocked = (userId: string): boolean => !!useBlocks.getState().ids?.[userId];

/** Selector for rows: a primitive. */
export const selectBlocked =
  (userId: string) =>
  (s: BlocksState): boolean =>
    !!s.ids?.[userId];
