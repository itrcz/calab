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

interface BoardsState extends BoardsData {
  /** Board tasks loaded (the columns exist once 'ready'). */
  load: Readonly<Record<string, LoadState>>;
  /** Task id → its last notice received live (cards never select it). */
  notices: Readonly<Record<string, LastNotice>>;
  setNotice: (taskId: string, n: LastNotice) => void;
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
  reset: () => set({ ...EMPTY_DATA, load: {}, notices: {} }),
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
export function taskPermsOf(s: Pick<BoardsData, 'boards'>, task: Pick<Task, 'boardId' | 'assignees' | 'approvers' | 'watcherIds' | 'archivedAt'>, me: string): bigint {
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
