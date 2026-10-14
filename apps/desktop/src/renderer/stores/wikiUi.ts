import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WikiSyncStatus } from '../lib/wikiSync';
import { useBoardsUi } from './boardsUi';
import { useDiskUi } from './diskUi';

/**
 * The «Вики» section's UI state (ADR-0096 §9): whether the wiki covers the column and the centre,
 * the open page of each workspace, the trash view, the expanded tree nodes, the tree column's
 * width (persisted), the tree's title filter, the dialog on top and the sync status of the open
 * page (written by the lazy document, read by the header's pill).
 *
 * Exclusive with the other workspace modes like the Disk: the boards or the Disk turned on anywhere
 * turn it off (below); a room, a day or history travel turn it off in stores/ui.ts (leaveWiki);
 * the rail's sections go through features/shell/sectionNav.ts showMode.
 */
export type WikiDialog = { kind: 'share'; pageId: string; tab: 'access' | 'link' } | { kind: 'versions'; pageId: string } | { kind: 'move'; pageId: string };

export const TREE_MIN = 220;
export const TREE_MAX = 360;
export const TREE_DEFAULT = 260;

export const clampTree = (w: number): number => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, Number.isFinite(w) ? w : TREE_DEFAULT)));

interface WikiUiState {
  active: boolean;
  setActive: (on: boolean) => void;
  /** Workspace → the open page id ('' = none yet). */
  pageOf: Readonly<Record<string, string>>;
  openPage: (wsId: string, pageId: string) => void;
  /** Workspace → the tree column shows the trash. */
  trashOf: Readonly<Record<string, true>>;
  openTrash: (wsId: string, on: boolean) => void;
  /** Expanded tree nodes (page ids, any workspace). */
  expanded: Readonly<Record<string, true>>;
  setExpanded: (id: string, on: boolean) => void;
  treeWidth: number;
  setTreeWidth: (w: number) => void;
  /** The tree's title filter; cleared when the section closes. */
  query: string;
  setQuery: (q: string) => void;
  dialog: WikiDialog | null;
  openDialog: (d: WikiDialog | null) => void;
  /** The open page's sync status ('online' while nothing is open). */
  sync: WikiSyncStatus;
  setSync: (s: WikiSyncStatus) => void;
  /** Phone: how many other people are on the open page (awareness; the header's «ещё N редактируют»). */
  peers: number;
  setPeers: (n: number) => void;
}

export const useWikiUi = create<WikiUiState>()(
  persist(
    (set) => ({
      active: false,
      setActive: (active) => set((s) => (s.active === active ? s : active ? { active } : { active, query: '', dialog: null })),
      pageOf: {},
      openPage: (wsId, pageId) =>
        set((s) => {
          if (s.pageOf[wsId] === pageId && !s.trashOf[wsId]) return s;
          return { pageOf: { ...s.pageOf, [wsId]: pageId }, dialog: null };
        }),
      trashOf: {},
      openTrash: (wsId, on) =>
        set((s) => {
          const trashOf = { ...s.trashOf };
          if (on) trashOf[wsId] = true;
          else delete trashOf[wsId];
          return { trashOf, query: '' };
        }),
      expanded: {},
      setExpanded: (id, on) =>
        set((s) => {
          if (!!s.expanded[id] === on) return s;
          const expanded = { ...s.expanded };
          if (on) expanded[id] = true;
          else delete expanded[id];
          return { expanded };
        }),
      treeWidth: TREE_DEFAULT,
      setTreeWidth: (w) => set((s) => (s.treeWidth === clampTree(w) ? s : { treeWidth: clampTree(w) })),
      query: '',
      setQuery: (query) => set({ query }),
      dialog: null,
      openDialog: (dialog) => set({ dialog }),
      sync: 'online',
      setSync: (sync) => set((s) => (s.sync === sync ? s : { sync })),
      peers: 0,
      setPeers: (peers) => set((s) => (s.peers === peers ? s : { peers })),
    }),
    {
      name: 'calaba-wiki-ui',
      version: 1,
      partialize: (s) => ({
        pageOf: s.pageOf,
        expanded: s.expanded,
        treeWidth: s.treeWidth,
      }),
      merge: (stored, cur) => {
        const p = (stored ?? {}) as Partial<WikiUiState>;
        const pageOf: Record<string, string> = {};
        if (p.pageOf && typeof p.pageOf === 'object') for (const [k, v] of Object.entries(p.pageOf)) if (typeof v === 'string') pageOf[k] = v;
        const expanded: Record<string, true> = {};
        if (p.expanded && typeof p.expanded === 'object') for (const [k, v] of Object.entries(p.expanded as Record<string, unknown>)) if (v === true) expanded[k] = true;
        return {
          ...cur,
          pageOf,
          expanded,
          treeWidth: clampTree(typeof p.treeWidth === 'number' ? p.treeWidth : TREE_DEFAULT),
        };
      },
    },
  ),
);

/** The open page of a workspace (a string: a selector re-renders only when it changes). */
export const pageOf = (s: Pick<WikiUiState, 'pageOf'>, wsId: string): string => s.pageOf[wsId] ?? '';

/** Leaves the wiki (a room, a day, a board or the Disk opened from anywhere). */
export function leaveWiki(): void {
  if (useWikiUi.getState().active) useWikiUi.getState().setActive(false);
}

// The boards or the Disk turned on from anywhere leave the wiki.
useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveWiki();
});
useDiskUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveWiki();
});
