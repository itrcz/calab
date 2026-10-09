import { create } from 'zustand';
import type { Board, BoardCategory, Task, TaskActivity, TaskChecklist, TaskMilestone } from '@calaba/protocol';
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

interface BoardsState extends BoardsData {
  /** Board tasks loaded (the columns exist once 'ready'). */
  load: Readonly<Record<string, LoadState>>;
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
  reset: () => set({ ...EMPTY_DATA, load: {} }),
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

/** The number of unread tasks of a workspace (the header icon badge). */
export function unreadCount(s: BoardsData, workspaceId: string): number {
  let n = 0;
  for (const ws of Object.values(s.unread)) if (ws === workspaceId) n++;
  return n;
}
