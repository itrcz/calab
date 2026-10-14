import { create } from 'zustand';
import type { SectionName } from '../lib/search/sections';
import { useBoardsUi } from './boardsUi';
import { useUi } from './ui';
import { useWebApps } from './webApps';

/**
 * «Результаты поиска» (ADR-0062 §4): which search the right panel shows — the query, its scope and
 * the open tab. Only the request lives here; the hits stay in the panel's own state (no feed
 * store is touched). Not persisted.
 */
interface SearchPanelState {
  open: boolean;
  /** Bumped by every show(): the panel remounts with the new query (its field and filters reset). */
  seq: number;
  q: string;
  /** A workspace id or "all". */
  scope: string;
  tab: SectionName;
  show: (q: string, scope: string, tab: SectionName) => void;
  setTab: (tab: SectionName) => void;
  setQuery: (q: string) => void;
  setScope: (scope: string) => void;
  close: () => void;
}

export const useSearchPanel = create<SearchPanelState>()((set) => ({
  open: false,
  seq: 0,
  q: '',
  scope: 'all',
  tab: 'messages',
  show: (q, scope, tab) => {
    // The panel stands beside a chat: leave the boards / calendar / web app views for it.
    if (useBoardsUi.getState().active) useBoardsUi.getState().setActive(false);
    if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
    const ui = useUi.getState();
    if (ui.calDay) ui.closeCalendar();
    if (ui.membersOverlay) ui.setMembersOverlay(false);
    set((s) => ({ open: true, seq: s.seq + 1, q: q.trim(), scope, tab }));
  },
  setTab: (tab) => set({ tab }),
  setQuery: (q) => set({ q }),
  setScope: (scope) => set({ scope }),
  close: () => set({ open: false }),
}));
