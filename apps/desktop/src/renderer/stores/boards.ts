import { create } from 'zustand';
import type { Board, BoardCategory, Task, TaskActivity, TaskChecklist, TaskMilestone, TaskNotice } from '@calaba/protocol';
import { milestoneChip } from '../lib/boards/milestones';
import {
  EMPTY_DATA,
  appendActivity,
  checkCountsOf,
  removeCategory,
  removeChecklist,
  setChecklists,
  setWorkspaceCategories,
  upsertCategory,
  upsertChecklist,
  removeBoard,
  removeTask,
  setBoardTasks,
  setPositions,
  setUnread,
  setWorkspaceBoards,
  upsertBoard,
  upsertTask,
  type BoardsData,
} from '../lib/boards/reducers';
import { boardVisible, taskBits } from '../lib/boards/access';

/**
 * Task boards data (ADR-0042 §5): boards by id, tasks by id, each status column as an id list,
 * the task rooms and the unread tasks. services/boards.ts fills it from READY, REST and the
 * gateway (events 75–81); the transitions are pure (lib/boards/reducers.ts). Components select a
 * task / a board / a column by id — never the maps whole (CLAUDE.md «Ререндеры»).
 */
export type LoadState = 'loading' | 'ready' | 'error';

/** The last notice of a task this session (TaskUpdate.notice), for «Непрочитанное». */
export type LastNotice = Pick<TaskNotice, 'kind' | 'actorId' | 'text' | 'reRequested' | 'dueOn' | 'daysLeft'> & { at: number };

/** How many tasks «Недавние» keeps (the server's limit, CBF-179). */
export const RECENT_LIMIT = 50;

/** A «Недавние» task as the server named it, for a row whose task the store lacks. */
export interface RecentRef {
  workspaceId: string;
  key: string;
  title: string;
  boardId: string;
}

/** One «Недавние» entry: the task, how it is named and its latest notice (`at` = the notice time). */
export interface RecentEntry {
  taskId: string;
  ref: RecentRef;
  notice: LastNotice;
}

interface BoardsState extends BoardsData {
  /** Board tasks loaded (the columns exist once 'ready'). */
  load: Readonly<Record<string, LoadState>>;
  /** Task id → its last notice received live (cards never select it). */
  notices: Readonly<Record<string, LastNotice>>;
  setNotice: (taskId: string, n: LastNotice) => void;
  /** «Недавние» (CBF-179): workspace → task ids, latest notice first; absent until loaded. */
  recent: Readonly<Record<string, readonly string[]>>;
  /** Task id → its key, title and board as GET recent-tasks named it (rows prefer the task). */
  recentRefs: Readonly<Record<string, RecentRef>>;
  /**
   * The server's list replaces the workspace's; its notices fill `notices` where none is newer.
   * `since` — when the request left: a task bumped live after it stays on top.
   */
  setRecent: (workspaceId: string, entries: readonly RecentEntry[], since?: number) => void;
  /** A live notice: the task moves to the top (one row per task) of a loaded list. */
  bumpRecent: (workspaceId: string, taskId: string, ref: RecentRef) => void;
  /** The task's name changed: a known ref follows it. */
  renameRecent: (taskId: string, ref: RecentRef) => void;
  /** The task is gone for me: out of every list. */
  dropRecent: (taskId: string) => void;
  reset: () => void;
  setLoad: (boardId: string, s: LoadState) => void;
  upsertBoard: (b: Board, event?: boolean) => void;
  setWorkspaceBoards: (workspaceId: string, list: readonly Board[]) => void;
  removeBoard: (boardId: string) => void;
  setBoardTasks: (boardId: string, list: readonly Task[]) => void;
  upsertTask: (t: Task) => void;
  upsertTasks: (list: readonly Task[]) => void;
  removeTask: (taskId: string) => void;
  setPositions: (positions: Readonly<Record<string, number>>) => void;
  setUnread: (workspaceId: string, ids: readonly string[]) => void;
  appendActivity: (a: TaskActivity | undefined, replacedId?: string, taskId?: string) => void;
  setWorkspaceCategories: (workspaceId: string, list: readonly BoardCategory[]) => void;
  upsertCategory: (c: BoardCategory) => void;
  removeCategory: (categoryId: string) => void;
  setChecklists: (taskId: string, list: readonly TaskChecklist[]) => void;
  upsertChecklist: (taskId: string, c: TaskChecklist | undefined, total: number, done: number) => void;
  removeChecklist: (taskId: string, checklistId: string, total: number, done: number) => void;
}

export const useBoards = create<BoardsState>()((set) => ({
  ...EMPTY_DATA,
  load: {},
  notices: {},
  setNotice: (taskId, n) => set((d) => ({ notices: { ...d.notices, [taskId]: n } })),
  recent: {},
  recentRefs: {},
  setRecent: (ws, entries, since) => set((d) => setRecent(d, ws, entries, since)),
  bumpRecent: (ws, taskId, ref) => set((d) => bumpRecent(d, ws, taskId, ref)),
  renameRecent: (taskId, ref) =>
    set((d) => {
      const was = d.recentRefs[taskId];
      if (!was || (was.key === ref.key && was.title === ref.title && was.boardId === ref.boardId)) return {};
      return { recentRefs: { ...d.recentRefs, [taskId]: ref } };
    }),
  dropRecent: (taskId) =>
    set((d) => {
      let changed = false;
      const recent: Record<string, readonly string[]> = {};
      for (const [ws, ids] of Object.entries(d.recent)) {
        if (ids.includes(taskId)) {
          changed = true;
          recent[ws] = ids.filter((id) => id !== taskId);
        } else recent[ws] = ids;
      }
      return changed ? { recent } : {};
    }),
  reset: () => set({ ...EMPTY_DATA, load: {}, notices: {}, recent: {}, recentRefs: {} }),
  setLoad: (boardId, s) => set((d) => (d.load[boardId] === s ? {} : { load: { ...d.load, [boardId]: s } })),
  upsertBoard: (b, event) => set((d) => upsertBoard(d, b, event)),
  setWorkspaceBoards: (wsId, list) => set((d) => setWorkspaceBoards(d, wsId, list)),
  removeBoard: (id) =>
    set((d) => {
      const load = { ...d.load };
      delete load[id];
      return { ...removeBoard(d, id), load };
    }),
  setBoardTasks: (id, list) => set((d) => setBoardTasks(d, id, list)),
  upsertTask: (t) => set((d) => upsertTask(d, t)),
  upsertTasks: (list) =>
    set((d) => {
      let data: BoardsData = d;
      for (const t of list) data = { ...data, ...upsertTask(data, t) };
      return data;
    }),
  removeTask: (id) => set((d) => removeTask(d, id)),
  setPositions: (p) => set((d) => setPositions(d, p)),
  setUnread: (ws, ids) => set((d) => setUnread(d, ws, ids)),
  appendActivity: (a, replacedId, taskId) => set((d) => appendActivity(d, a, replacedId, taskId)),
  setWorkspaceCategories: (ws, list) => set((d) => setWorkspaceCategories(d, ws, list)),
  upsertCategory: (c) => set((d) => upsertCategory(d, c)),
  removeCategory: (id) => set((d) => removeCategory(d, id)),
  setChecklists: (taskId, list) => set((d) => setChecklists(d, taskId, list)),
  upsertChecklist: (taskId, c, total, done) => set((d) => upsertChecklist(d, taskId, c, total, done)),
  removeChecklist: (taskId, id, total, done) => set((d) => removeChecklist(d, taskId, id, total, done)),
}));

const NONE: readonly string[] = [];
const NO_CHECKLISTS: readonly TaskChecklist[] = [];

/** A task's loaded checklists (stable reference while they do not change). */
export function checklistsOf(s: BoardsData, taskId: string): readonly TaskChecklist[] {
  return s.checklists[taskId] ?? NO_CHECKLISTS;
}

/** The card's «3/7» (a primitive: the progress leaf re-renders only when it changes). */
export function checklistProgress(s: BoardsData, taskId: string): string {
  const c = checkCountsOf(s, taskId);
  return c.total > 0 ? `${c.done}/${c.total}` : '';
}

const NO_MILESTONES: readonly TaskMilestone[] = [];

/** A task's milestones by position (ADR-0063; kept by reference while they do not change). */
export function taskMilestonesOf(s: Pick<BoardsData, 'tasks'>, taskId: string): readonly TaskMilestone[] {
  return s.tasks[taskId]?.milestones ?? NO_MILESTONES;
}

/** The card's «2/4» of the task's milestones (a primitive for a leaf chip). */
export function milestoneChipOf(s: Pick<BoardsData, 'tasks'>, taskId: string): string {
  return milestoneChip(s.tasks[taskId]);
}

/** Board categories of a workspace by position. */
export function workspaceCategories(categories: Readonly<Record<string, BoardCategory>>, workspaceId: string): BoardCategory[] {
  return Object.values(categories)
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
}

/** A status column's ids (stable reference while the column does not change). */
export function columnIds(s: BoardsData, boardId: string, statusId: string): readonly string[] {
  return s.columns[boardId]?.[statusId] ?? NONE;
}

/** Boards of a workspace by position (for lists; call inside useShallow / useMemo). */
export function workspaceBoards(boards: Readonly<Record<string, Board>>, workspaceId: string): Board[] {
  return Object.values(boards)
    .filter((b) => b.workspaceId === workspaceId && boardVisible(b))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/**
 * The viewer's bits on a task (ADR-0059): a primitive, so a selector built on it re-renders only
 * when the bits change. Use inside `useBoards(...)` or with `getState()` (hotkeys, bulk actions).
 */
export function taskPermsOf(s: Pick<BoardsData, 'boards'>, task: Pick<Task, 'boardId' | 'assignees' | 'approvers' | 'watcherIds' | 'archivedAt' | 'createdBy'>, me: string): bigint {
  return taskBits(s.boards[task.boardId], task, me);
}

/**
 * The unread tasks of a workspace — the one set behind both the rail / «Мои задачи» badge
 * (unreadCount) and the «Непрочитанное» tab (unreadIds), so the two never disagree. Order: the
 * server's (newest notice first, READY), then the ones that arrived live.
 */
function eachUnread(s: Pick<BoardsData, 'unread'>, workspaceId: string, fn: (id: string) => void): void {
  for (const [id, ws] of Object.entries(s.unread)) if (ws === workspaceId) fn(id);
}

/** The number of unread tasks of a workspace (the header icon badge). */
export function unreadCount(s: Pick<BoardsData, 'unread'>, workspaceId: string): number {
  let n = 0;
  eachUnread(s, workspaceId, () => n++);
  return n;
}

/** Whether a board has an open unread task assigned to me (the sidebar count turns accent) — a primitive, safe as a selector. */
export function boardHasUnread(s: Pick<BoardsData, 'unread' | 'tasks'>, boardId: string, me: string): boolean {
  for (const id in s.unread) {
    const t = s.tasks[id];
    if (t && t.boardId === boardId && !t.completedAt && t.assignees.some((a) => a.userId === me)) return true;
  }
  return false;
}

/** The unread task ids of a workspace (call inside useShallow). */
export function unreadIds(s: Pick<BoardsData, 'unread'>, workspaceId: string): string[] {
  const out: string[] = [];
  eachUnread(s, workspaceId, (id) => out.push(id));
  return out;
}

/**
 * «Непрочитанное»: the unread ids, newest notice first — a notice received this session by its
 * time, the rest in the server's order (newest notice first) after them. Call inside useShallow.
 */
export function unreadOrdered(s: Pick<BoardsData, 'unread'> & { notices: Readonly<Record<string, LastNotice>> }, workspaceId: string): string[] {
  const ids = unreadIds(s, workspaceId);
  const rank = new Map(ids.map((id, i) => [id, i]));
  return ids.sort((a, b) => (s.notices[b]?.at ?? 0) - (s.notices[a]?.at ?? 0) || (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

type RecentData = Pick<BoardsState, 'recent' | 'recentRefs' | 'notices'>;

/** The server's «Недавние» of a workspace; a task whose live notice came after `since` (the request) stays on top. */
export function setRecent(d: RecentData, workspaceId: string, entries: readonly RecentEntry[], since = Infinity): Partial<RecentData> {
  const recentRefs = { ...d.recentRefs };
  const notices = { ...d.notices };
  const ids: string[] = [];
  for (const e of entries) {
    if (ids.includes(e.taskId)) continue;
    ids.push(e.taskId);
    recentRefs[e.taskId] = e.ref;
    if ((notices[e.taskId]?.at ?? 0) < e.notice.at) notices[e.taskId] = e.notice;
  }
  // A notice that arrived while the request was in flight keeps its task on top.
  const live = (d.recent[workspaceId] ?? []).filter((id) => !ids.includes(id) && (d.notices[id]?.at ?? 0) >= since);
  return { recent: { ...d.recent, [workspaceId]: [...live, ...ids].slice(0, RECENT_LIMIT) }, recentRefs, notices };
}

/** A live notice of a task: on top of a loaded list, once. A list not loaded yet stays so (the load brings it). */
export function bumpRecent(d: RecentData, workspaceId: string, taskId: string, ref: RecentRef): Partial<RecentData> {
  const ids = d.recent[workspaceId];
  if (!ids) return {};
  return {
    recent: { ...d.recent, [workspaceId]: ids[0] === taskId ? ids : [taskId, ...ids.filter((id) => id !== taskId)].slice(0, RECENT_LIMIT) },
    recentRefs: { ...d.recentRefs, [taskId]: ref },
  };
}

/** «Недавние» of a workspace (stable while it does not change); null until loaded. */
export function recentIds(s: Pick<RecentData, 'recent'>, workspaceId: string): readonly string[] | null {
  return s.recent[workspaceId] ?? null;
}
