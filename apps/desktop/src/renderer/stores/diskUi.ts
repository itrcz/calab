import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ROOT } from '../lib/disk';
import { useBoardsUi } from './boardsUi';

/**
 * The «Диск» section's UI state (ADR-0094 §8): whether the disk mode covers the column and the
 * centre, the open folder of each workspace (remembered), the trash view, the search text of the
 * open folder, the inline rename and the dialog on top. The view (tiles / list) and the sort are
 * device prefs (stores/prefs.ts).
 *
 * Exclusive with the other workspace modes, like the boards: the boards turned on anywhere turn
 * the disk off (below); a room, a day or history travel turn it off in stores/ui.ts (leaveDisk);
 * the rail's sections go through features/shell/sectionNav.ts showMode.
 */
export type DiskDialog =
  | { kind: 'access'; itemId: string }
  | { kind: 'link'; itemId: string }
  | { kind: 'history'; itemId: string }
  | { kind: 'move'; itemIds: readonly string[] }
  | { kind: 'disk-history'; wsId: string }
  /** «Место»; `full`: opened by a 413 on upload (the title says the storage is full). */
  | { kind: 'usage'; wsId: string; full?: boolean }
  | { kind: 'preview'; itemId: string };

interface DiskUiState {
  active: boolean;
  setActive: (on: boolean) => void;
  /** Workspace → the open folder id (ROOT = the root). */
  folderOf: Readonly<Record<string, string>>;
  /** Workspace → the trash is shown instead of a folder. */
  trashOf: Readonly<Record<string, true>>;
  openFolder: (wsId: string, folderId: string) => void;
  openTrash: (wsId: string, on: boolean) => void;
  /** The bar's search: filters the open listing on the client; cleared on navigation. */
  query: string;
  setQuery: (q: string) => void;
  /** The item whose name is an input now. */
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  /** The highlighted item (click; the context menu). */
  selected: string | null;
  select: (id: string | null) => void;
  dialog: DiskDialog | null;
  openDialog: (d: DiskDialog | null) => void;
}

export const useDiskUi = create<DiskUiState>()(
  persist(
    (set) => ({
      active: false,
      setActive: (active) => set((s) => (s.active === active ? s : active ? { active } : { active, renaming: null, selected: null, query: '' })),
      folderOf: {},
      trashOf: {},
      openFolder: (wsId, folderId) =>
        set((s) => {
          const trashOf = { ...s.trashOf };
          delete trashOf[wsId];
          return { folderOf: { ...s.folderOf, [wsId]: folderId }, trashOf, query: '', renaming: null, selected: null };
        }),
      openTrash: (wsId, on) =>
        set((s) => {
          const trashOf = { ...s.trashOf };
          if (on) trashOf[wsId] = true;
          else delete trashOf[wsId];
          return { trashOf, query: '', renaming: null, selected: null };
        }),
      query: '',
      setQuery: (query) => set({ query }),
      renaming: null,
      setRenaming: (renaming) => set((s) => (s.renaming === renaming ? s : { renaming })),
      selected: null,
      select: (selected) => set((s) => (s.selected === selected ? s : { selected })),
      dialog: null,
      openDialog: (dialog) => set({ dialog }),
    }),
    {
      name: 'calaba-disk-ui',
      version: 1,
      partialize: (s) => ({ folderOf: s.folderOf }),
      merge: (stored, cur) => {
        const p = (stored ?? {}) as Partial<DiskUiState>;
        const folderOf: Record<string, string> = {};
        if (p.folderOf && typeof p.folderOf === 'object') for (const [k, v] of Object.entries(p.folderOf)) if (typeof v === 'string') folderOf[k] = v;
        return { ...cur, folderOf };
      },
    },
  ),
);

/** The open folder of a workspace (a string: a selector re-renders only when it changes). */
export const folderOf = (s: Pick<DiskUiState, 'folderOf'>, wsId: string): string => s.folderOf[wsId] ?? ROOT;

/** Leaves the disk mode (a room, a day, a board opened from anywhere). */
export function leaveDisk(): void {
  if (useDiskUi.getState().active) useDiskUi.getState().setActive(false);
}

// The boards turned on from anywhere (a link, «Мои задачи», a task) leave the disk.
useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveDisk();
});
