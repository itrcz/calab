import type { WikiPage } from '@calaba/protocol';
import { create } from 'zustand';
import { applyList, applyRemove, applyUpsert, dropWorkspace, type WikiData } from '../lib/wiki/tree';

/**
 * Wiki data (ADR-0096), normalized like the Disk (docs/08 «Производительность»): pages by id,
 * child lists as ordered id lists per parent (loaded lazily when a node is expanded; lib/wiki/tree
 * childKey) and the trash per workspace (trashKey), with each list's load state. A tree row reads
 * its page by id and its children's ids (useShallow) — an upsert re-renders that row and the one
 * list it moved through. The reducers are pure (lib/wiki/tree.ts).
 */
export type LoadState = 'loading' | 'ready' | 'error';

interface WikiState extends WikiData {
  load: Readonly<Record<string, LoadState>>;
  setLoad: (key: string, v: LoadState) => void;
  setList: (key: string, pages: readonly WikiPage[]) => void;
  upsert: (page: WikiPage, fromEvent?: boolean) => void;
  /** Pages known without touching any list (GET …/path, GET a page). */
  put: (pages: readonly WikiPage[]) => void;
  remove: (id: string) => void;
  dropWorkspace: (wsId: string) => void;
  /** The lists of a workspace are stale (events while the section was closed): reloaded on the next open. */
  forgetLists: (wsId: string) => void;
}

export const useWiki = create<WikiState>()((set) => ({
  pages: {},
  lists: {},
  load: {},
  setLoad: (key, v) => set((s) => (s.load[key] === v ? s : { load: { ...s.load, [key]: v } })),
  setList: (key, pages) =>
    set((s) => ({
      ...applyList(s, key, pages),
      load: { ...s.load, [key]: 'ready' },
    })),
  upsert: (page, fromEvent) => set((s) => applyUpsert(s, page, fromEvent)),
  put: (list) =>
    set((s) => {
      if (!list.length) return s;
      const pages = { ...s.pages };
      for (const p of list) pages[p.id] = p;
      return { pages };
    }),
  remove: (id) => set((s) => applyRemove(s, id)),
  dropWorkspace: (wsId) => set((s) => ({ ...dropWorkspace(s, wsId), load: dropKeys(s.load, wsId) })),
  forgetLists: (wsId) =>
    set((s) => ({
      lists: dropKeys(s.lists, wsId),
      load: dropKeys(s.load, wsId),
    })),
}));

function dropKeys<T>(m: Readonly<Record<string, T>>, wsId: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith(`${wsId}/`)) out[k] = v;
  return out;
}
