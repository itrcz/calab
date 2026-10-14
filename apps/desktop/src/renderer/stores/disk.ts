import type { DiskItem, DiskUsage } from '@calaba/protocol';
import { create } from 'zustand';
import { applyListing, applyRemove, applyUpsert, dropWorkspace, type DiskData } from '../lib/disk';

/**
 * Disk data (ADR-0094), normalized like the boards (docs/08 «Производительность»): items by id,
 * listings as ordered id lists per folder / trash key (lib/disk folderKey, trashKey), the storage
 * usage per workspace, the path (crumbs) per folder id and the listing load state. A tile / row
 * reads its item by id — an upsert re-renders that one tile; the listing component reads the
 * list's ids (useShallow). The reducers are pure (lib/disk.ts).
 */
export type LoadState = 'loading' | 'ready' | 'error';

interface DiskState extends DiskData {
  load: Readonly<Record<string, LoadState>>;
  usage: Readonly<Record<string, DiskUsage>>;
  /** Folder id → its ancestors, the root's child first, the folder last (GET …/path). */
  paths: Readonly<Record<string, readonly DiskItem[]>>;
  setLoad: (key: string, v: LoadState) => void;
  setListing: (key: string, items: readonly DiskItem[]) => void;
  upsert: (item: DiskItem, fromEvent?: boolean) => void;
  remove: (id: string) => void;
  setUsage: (wsId: string, u: DiskUsage) => void;
  setPath: (folderId: string, path: readonly DiskItem[]) => void;
  dropWorkspace: (wsId: string) => void;
  /** The listings of a workspace are stale (events while the section was closed): reloaded on the next open. */
  forgetLists: (wsId: string) => void;
}

export const useDisk = create<DiskState>()((set) => ({
  items: {},
  lists: {},
  load: {},
  usage: {},
  paths: {},
  setLoad: (key, v) => set((s) => (s.load[key] === v ? s : { load: { ...s.load, [key]: v } })),
  setListing: (key, items) => set((s) => ({ ...applyListing(s, key, items), load: { ...s.load, [key]: 'ready' } })),
  upsert: (item, fromEvent) => set((s) => applyUpsert(s, item, fromEvent)),
  remove: (id) => set((s) => applyRemove(s, id)),
  setUsage: (wsId, u) => set((s) => ({ usage: { ...s.usage, [wsId]: u } })),
  // The path's items are stored too (a folder opened by its remembered id has its bits for the bar).
  setPath: (folderId, path) =>
    set((s) => {
      const items = { ...s.items };
      for (const it of path) items[it.id] = it;
      return { items, paths: { ...s.paths, [folderId]: path } };
    }),
  dropWorkspace: (wsId) =>
    set((s) => {
      const usage = { ...s.usage };
      delete usage[wsId];
      return { ...dropWorkspace(s, wsId), usage, load: dropKeys(s.load, wsId) };
    }),
  forgetLists: (wsId) => set((s) => ({ lists: dropKeys(s.lists, wsId), load: dropKeys(s.load, wsId) })),
}));

function dropKeys<T>(m: Readonly<Record<string, T>>, wsId: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith(`${wsId}/`)) out[k] = v;
  return out;
}

/** One file going up (drag & drop or «Загрузить файлы»): its own progress, an error stays until closed. */
export interface DiskUpload {
  id: string;
  wsId: string;
  parentId: string;
  name: string;
  /** 0…1. */
  progress: number;
  error: string | null;
  abort: () => void;
}

interface UploadsState {
  byId: Readonly<Record<string, DiskUpload>>;
  order: readonly string[];
  add: (u: DiskUpload) => void;
  /** Progress is written at whole percents only (a row re-renders ≤ 100 times per file). */
  progress: (id: string, fraction: number) => void;
  fail: (id: string, error: string) => void;
  done: (id: string) => void;
}

/** Uploads live apart from the items: a progress tick re-renders the upload row, never the listing. */
export const useDiskUploads = create<UploadsState>()((set) => ({
  byId: {},
  order: [],
  add: (u) => set((s) => ({ byId: { ...s.byId, [u.id]: u }, order: [...s.order, u.id] })),
  progress: (id, fraction) =>
    set((s) => {
      const u = s.byId[id];
      const p = Math.floor(fraction * 100) / 100;
      return !u || u.progress === p ? s : { byId: { ...s.byId, [id]: { ...u, progress: p } } };
    }),
  fail: (id, error) =>
    set((s) => {
      const u = s.byId[id];
      return u ? { byId: { ...s.byId, [id]: { ...u, error } } } : s;
    }),
  done: (id) =>
    set((s) => {
      if (!s.byId[id]) return s;
      const byId = { ...s.byId };
      delete byId[id];
      return { byId, order: s.order.filter((x) => x !== id) };
    }),
}));
