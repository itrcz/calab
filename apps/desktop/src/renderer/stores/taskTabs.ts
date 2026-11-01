import { create } from 'zustand';
import { persist, type StateStorage } from 'zustand/middleware';

/**
 * Open tasks as browser-like tabs (#93, desktop web client only). A tab remembers where its task
 * lives (workspace, board) and a snapshot of key + title, so the strip is complete after F5 before
 * any task is loaded. The active tab is not stored: it is the open task (useBoardsUi.taskId).
 * Kept per browser in localStorage (every access guarded: it may throw or be absent); no sync.
 */
export interface TaskTab {
  id: string;
  ws: string;
  /** The board of a task tab; '' for a file tab. */
  board: string;
  /** A task's key (CAL-3); a file tab's extension label (XLSX). */
  key: string;
  /** A task's title; a file tab's name. */
  title: string;
  /** Absent = a task tab (the first kind, stored before files existed). */
  kind?: 'task' | 'file';
  /** A file tab: the Disk item it edits, or (view only) the plain API file. Exactly one is set. */
  itemId?: string;
  fileId?: string;
  /**
   * A task tab opened with Ctrl/⌘-click or «Открыть в новой вкладке» (#105): held for its task until
   * closed. Every task tab is pinned now (#137); an explicit false is a legacy «preview» tab, dropped on restore.
   */
  pinned?: boolean;
  /** When it was last the open task (ms): the oldest one is dropped past {@link MAX_TABS}. */
  at: number;
}

export interface TabsState {
  tabs: TaskTab[];
  /** The tab of the open task; null = the open task has no tab (or none is open). */
  cur: string | null;
}

export const MAX_TABS = 10;

/** Makes room for one more: drops the least recently used tab that is not `keep`. */
function fit(tabs: TaskTab[], keep: string): TaskTab[] {
  const out = [...tabs];
  while (out.length > MAX_TABS) {
    let oldest = -1;
    out.forEach((tb, i) => {
      if (tb.id !== keep && (oldest < 0 || tb.at < (out[oldest]?.at ?? Infinity))) oldest = i;
    });
    if (oldest < 0) break;
    out.splice(oldest, 1);
  }
  return out;
}

/**
 * A task became the open one (a plain open): an existing tab just becomes current; a task without a
 * tab gets none (#137: tabs come only from ⌘-click / «Открыть в новой вкладке») and no tab is current.
 * Pinned tabs are never replaced (#105); file tabs are never touched.
 */
export function reduceActivate(s: TabsState, entry: TaskTab): TabsState {
  const have = s.tabs.findIndex((x) => x.id === entry.id);
  if (have >= 0) return { tabs: s.tabs.map((x, i) => (i === have ? { ...x, at: entry.at } : x)), cur: entry.id };
  return s.cur === null ? s : { tabs: s.tabs, cur: null };
}

/**
 * «Открыть в новой вкладке»: appended in the background (the open task stays open) and pinned to its
 * task (#105). The task that is open right now (`open`) joins the strip first when it is not there
 * yet, so it is not lost, and is pinned too; a task that already has a preview tab pins it.
 */
export function reduceAdd(s: TabsState, entry: TaskTab, open?: TaskTab): TabsState {
  let tabs = s.tabs;
  for (const e of open ? [open, entry] : [entry]) {
    tabs = tabs.some((x) => x.id === e.id) ? tabs.map((x) => (x.id === e.id && x.kind !== 'file' ? { ...x, pinned: true } : x)) : [...tabs, { ...e, pinned: true }];
  }
  return { tabs: fit(tabs, open?.id ?? entry.id), cur: s.cur };
}

/** Closes a tab; `next` is the tab to show instead when it was the open one (right neighbour first). */
export function reduceClose(s: TabsState, id: string): { state: TabsState; next: TaskTab | null } {
  const i = s.tabs.findIndex((x) => x.id === id);
  if (i < 0) return { state: s, next: null };
  const tabs = s.tabs.filter((x) => x.id !== id);
  return { state: { tabs, cur: s.cur === id ? null : s.cur }, next: tabs[i] ?? tabs[i - 1] ?? null };
}

/**
 * A file was opened (ADR-0143): an existing tab for the same source is just activated; otherwise it
 * is appended (a plain open replaces nothing), the least recently used other tab dropping past
 * {@link MAX_TABS}. Never touches `cur` (the open task).
 */
export function reduceOpenFile(s: TabsState, entry: TaskTab): TabsState {
  const have = s.tabs.findIndex((x) => x.id === entry.id);
  if (have >= 0) return { ...s, tabs: s.tabs.map((x, i) => (i === have ? { ...x, at: entry.at } : x)) };
  return { ...s, tabs: fit([...s.tabs, entry], entry.id) };
}

/** Refreshes the snapshot of key + title; the same object when nothing changed. */
export function reduceSync(s: TabsState, id: string, key: string, title: string): TabsState {
  const tb = s.tabs.find((x) => x.id === id);
  if (!tb || (tb.key === key && tb.title === title)) return s;
  return { ...s, tabs: s.tabs.map((x) => (x.id === id ? { ...x, key, title } : x)) };
}

/** A stored value from another build must not break the strip. */
export function sanitizeTabs(raw: unknown): TabsState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { tabs?: unknown; cur?: unknown };
  const list = Array.isArray(o.tabs) ? o.tabs : [];
  const tabs: TaskTab[] = [];
  for (const x of list) {
    const v = (x ?? {}) as Partial<TaskTab>;
    if (typeof v.id !== 'string' || !v.id || typeof v.ws !== 'string' || typeof v.board !== 'string') continue;
    if (tabs.some((y) => y.id === v.id)) continue;
    const base = { id: v.id, ws: v.ws, board: v.board, key: typeof v.key === 'string' ? v.key : '', title: typeof v.title === 'string' ? v.title : '', at: typeof v.at === 'number' ? v.at : 0 };
    if (v.kind === 'file') {
      // A file tab names exactly one source: a Disk item or a plain file.
      if (typeof v.itemId === 'string' && v.itemId) tabs.push({ ...base, kind: 'file', itemId: v.itemId });
      else if (typeof v.fileId === 'string' && v.fileId) tabs.push({ ...base, kind: 'file', fileId: v.fileId });
      continue;
    }
    // A «preview» tab stored by an older build (#137: plain opens no longer make tabs) is dropped;
    // a tab stored before the flag existed was opened with ⌘, so it stays pinned.
    if (v.pinned === false) continue;
    tabs.push({ ...base, pinned: true });
  }
  const cur = typeof o.cur === 'string' && tabs.some((x) => x.id === o.cur) ? o.cur : null;
  return { tabs: fit(tabs, ''), cur };
}

const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      /* quota / blocked storage: the tabs just stay in memory */
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* nothing to remove */
    }
  },
};

/** A file tab's mark: unsaved / saving changes, or a save that failed while leaving the file. */
export type FileMark = 'dirty' | 'warn';

interface TabsStore extends TabsState {
  /**
   * File view (ADR-0143): the file tab on screen (null = none), the tab whose editor exists (it
   * outlives the view only while it saves on the way out), the marks, and a pending «save and close».
   * Not persisted: a reload shows no file, only its tab.
   */
  fileActive: string | null;
  fileMounted: string | null;
  fileMark: Record<string, FileMark>;
  fileClosing: string | null;
  showFile: (id: string) => void;
  /** The file view is left (the editor may still be saving). */
  leaveFile: () => void;
  /** The editor of `id` is gone: the next one (the active tab) may mount. */
  editorGone: (id: string) => void;
  setFileMark: (id: string, mark: FileMark | null) => void;
  setFileClosing: (id: string | null) => void;
  /** Opens (or activates) a file tab and shows it. */
  openFile: (entry: TaskTab) => void;
  /** The boards section is on screen (BoardsView mounted); not persisted. */
  shown: boolean;
  setShown: (on: boolean) => void;
  activate: (entry: TaskTab) => void;
  add: (entry: TaskTab, open?: TaskTab) => void;
  close: (id: string) => TaskTab | null;
  /** Removes a file tab (the caller has settled unsaved changes); its editor unmounts with it. */
  removeFile: (id: string) => void;
  sync: (id: string, key: string, title: string) => void;
}

export const useTaskTabs = create<TabsStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      cur: null,
      shown: false,
      fileActive: null,
      fileMounted: null,
      fileMark: {},
      fileClosing: null,
      showFile: (id) => set((s) => ({ fileActive: id, fileMounted: s.fileMounted ?? id })),
      leaveFile: () => set((s) => (s.fileActive === null ? s : { fileActive: null })),
      editorGone: (id) =>
        set((s) => {
          if (s.fileMounted !== id) return s;
          const mark = { ...s.fileMark };
          delete mark[id];
          return { fileMounted: s.fileActive, fileMark: mark, fileClosing: s.fileClosing === id ? null : s.fileClosing };
        }),
      setFileMark: (id, mark) =>
        set((s) => {
          if ((s.fileMark[id] ?? null) === mark) return s;
          const next = { ...s.fileMark };
          if (mark) next[id] = mark;
          else delete next[id];
          return { fileMark: next };
        }),
      setFileClosing: (id) => set({ fileClosing: id }),
      openFile: (entry) =>
        set((s) => ({ ...reduceOpenFile(s, entry), fileActive: entry.id, fileMounted: s.fileMounted ?? entry.id })),
      removeFile: (id) =>
        set((s) => {
          const tabs = s.tabs.filter((x) => x.id !== id);
          const mark = { ...s.fileMark };
          delete mark[id];
          return { tabs, fileMark: mark, fileActive: s.fileActive === id ? null : s.fileActive, fileMounted: s.fileMounted === id ? s.fileActive === id ? null : s.fileActive : s.fileMounted, fileClosing: null };
        }),
      setShown: (shown) => set({ shown }),
      activate: (entry) => set((s) => reduceActivate(s, entry)),
      add: (entry, open) => set((s) => reduceAdd(s, entry, open)),
      close: (id) => {
        const r = reduceClose(get(), id);
        set(r.state);
        return r.next;
      },
      sync: (id, key, title) => set((s) => reduceSync(s, id, key, title)),
    }),
    {
      name: 'calaba-task-tabs',
      version: 1,
      storage: {
        getItem: (name) => {
          const raw = safeStorage.getItem(name) as string | null;
          if (!raw) return null;
          try {
            return JSON.parse(raw) as { state: TabsState };
          } catch {
            return null;
          }
        },
        setItem: (name, value) => safeStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => safeStorage.removeItem(name),
      },
      partialize: (s) => ({ tabs: s.tabs, cur: s.cur }),
      merge: (stored, cur) => ({ ...cur, ...sanitizeTabs(stored) }),
    },
  ),
);
