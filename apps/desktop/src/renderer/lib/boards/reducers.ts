import type { Board, BoardCategory, Task, TaskActivity, TaskChecklist } from '@calaba/protocol';
import { putChecklist, putChecklists } from './checklists';
import { mergeMilestones } from './milestones';
import { byPosition } from './position';

/**
 * The boards store's data and its pure transitions (ADR-0042 §5 «Производительность»: the store
 * is normalized — tasks by id, the order of each status column as an id list). Transitions keep
 * every untouched object and array by reference, so a TASK_UPDATE that changes a title replaces
 * one task object and nothing else: one card re-renders, the columns' id lists stay as they were.
 * Used by stores/boards.ts; unit-tested in reducers.test.ts.
 */
export interface BoardsData {
  boards: Readonly<Record<string, Board>>;
  tasks: Readonly<Record<string, Task>>;
  /** Board id → status id → live (not archived) task ids in board order; only loaded boards. */
  columns: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /** Task room id → task id (comments are messages of that room). */
  roomTask: Readonly<Record<string, string>>;
  /** Tasks with something unseen → their workspace (the boards icon badge). */
  unread: Readonly<Record<string, string>>;
  /** Journal entries that arrived live, per task (the panel merges them with its loaded page). */
  activity: Readonly<Record<string, readonly TaskActivity[]>>;
  /** Board categories by id (ADR-0058 §1; READY + BOARD_CATEGORY_*). */
  categories: Readonly<Record<string, BoardCategory>>;
  /** Task id → its checklists by position: only tasks opened in the panel (GET /tasks/{id}). */
  checklists: Readonly<Record<string, readonly TaskChecklist[]>>;
  /**
   * Task id → checklist counters newer than the task object (TASK_CHECKLIST_* carry them without
   * a TASK_UPDATE, ADR-0058 §2): the task object stays, so a toggle re-renders only the card's
   * progress leaf. Dropped once a task with other counters arrives (then the task is newer).
   */
  checkCounts: Readonly<Record<string, CheckCounts>>;
}

export interface CheckCounts {
  total: number;
  done: number;
}

export const EMPTY_DATA: BoardsData = { boards: {}, tasks: {}, columns: {}, roomTask: {}, unread: {}, activity: {}, categories: {}, checklists: {}, checkCounts: {} };

const EMPTY_IDS: readonly string[] = [];

function without<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out = { ...rec };
  delete out[key];
  return out;
}

/** Inserts `id` into an ordered column by (position, id). */
function insertOrdered(ids: readonly string[], id: string, tasks: Readonly<Record<string, Task>>): string[] {
  const me = tasks[id];
  if (!me) return [...ids];
  const out = ids.filter((x) => x !== id);
  let lo = 0;
  let hi = out.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const other = tasks[out[mid] as string];
    if (other && byPosition(other, me) < 0) lo = mid + 1;
    else hi = mid;
  }
  out.splice(lo, 0, id);
  return out;
}

// ------------------------------------------------------------------ boards

/**
 * A board from READY / REST / BOARD_CREATE / BOARD_UPDATE. `event`: BOARD_* events carry 0 for
 * my_open_tasks and only the shared views — the known count and my personal views stay.
 */
export function upsertBoard(d: BoardsData, board: Board, event = false): Partial<BoardsData> {
  const prev = d.boards[board.id];
  let next = board;
  if (prev && event) {
    const mine = prev.views.filter((v) => !v.shared);
    next = { ...board, myOpenTasks: prev.myOpenTasks, views: [...board.views.filter((v) => v.shared), ...mine] };
  }
  return { boards: { ...d.boards, [board.id]: next } };
}

/** A workspace's boards from READY: others of that workspace go (not visible any more). */
export function setWorkspaceBoards(d: BoardsData, workspaceId: string, boards: readonly Board[]): Partial<BoardsData> {
  let data: BoardsData = d;
  const keep = new Set(boards.map((b) => b.id));
  for (const b of Object.values(d.boards)) if (b.workspaceId === workspaceId && !keep.has(b.id)) data = { ...data, ...removeBoard(data, b.id) };
  const next = { ...data.boards };
  for (const b of boards) {
    const prev = next[b.id];
    // READY has shared views only: my personal ones (fetched with the board) stay.
    next[b.id] = prev ? { ...b, views: [...b.views, ...prev.views.filter((v) => !v.shared)] } : b;
  }
  return { ...data, boards: next };
}

export function removeBoard(d: BoardsData, boardId: string): Partial<BoardsData> {
  if (!d.boards[boardId] && !d.columns[boardId]) return {};
  const tasks: Record<string, Task> = {};
  const roomTask: Record<string, string> = {};
  for (const [id, t] of Object.entries(d.tasks)) if (t.boardId !== boardId) tasks[id] = t;
  for (const [room, id] of Object.entries(d.roomTask)) if (tasks[id]) roomTask[room] = id;
  return { boards: without(d.boards, boardId), columns: without(d.columns, boardId), tasks, roomTask };
}

// ------------------------------------------------------------------ tasks

/** A board's live tasks (the full list loaded page by page): its columns are rebuilt. */
export function setBoardTasks(d: BoardsData, boardId: string, list: readonly Task[]): Partial<BoardsData> {
  const tasks: Record<string, Task> = {};
  for (const [id, t] of Object.entries(d.tasks)) if (t.boardId !== boardId) tasks[id] = t;
  const roomTask = { ...d.roomTask };
  const cols: Record<string, string[]> = {};
  const sorted = [...list].filter((t) => !t.archivedAt).sort(byPosition);
  let counts = d.checkCounts;
  for (const t of sorted) {
    counts = keepCounts(counts, d.tasks[t.id], t);
    tasks[t.id] = keepMilestones(d.tasks[t.id], keepViewer(d.tasks[t.id], t));
    if (t.roomId) roomTask[t.roomId] = t.id;
    (cols[t.statusId] ??= []).push(t.id);
  }
  return { tasks, roomTask, columns: { ...d.columns, [boardId]: cols }, ...(counts !== d.checkCounts ? { checkCounts: counts } : {}) };
}

/** A task with other checklist counters than the stored one is newer than the override. */
function keepCounts(counts: BoardsData['checkCounts'], prev: Task | undefined, next: Task): BoardsData['checkCounts'] {
  if (!counts[next.id]) return counts;
  if (prev && prev.checklistTotal === next.checklistTotal && prev.checklistDone === next.checklistDone) return counts;
  return without(counts, next.id);
}

/** An unread task counted by the «Мои задачи» badge: open (not completed / cancelled). */
export function countsUnread(t: Task): boolean {
  return t.unread && !t.completedAt;
}

/** subscribed / muted / unread are meaningful only with viewer_state (boards.proto). */
function keepViewer(prev: Task | undefined, t: Task): Task {
  if (t.viewerState || !prev) return t;
  if (prev.subscribed === t.subscribed && prev.muted === t.muted && prev.unread === t.unread) return t;
  return { ...t, subscribed: prev.subscribed, muted: prev.muted, unread: prev.unread };
}

/**
 * The task's milestones (ADR-0063) travel in every task: unchanged ones keep their objects, so a
 * TASK_UPDATE re-renders only the milestone rows / diamonds that changed.
 */
function keepMilestones(prev: Task | undefined, t: Task): Task {
  if (!prev || prev.milestones === t.milestones || (!prev.milestones.length && !t.milestones.length)) return t;
  const milestones = mergeMilestones(prev.milestones, t.milestones);
  const p = prev.milestoneProgress;
  const q = t.milestoneProgress;
  const milestoneProgress = p && q && p.done === q.done && p.total === q.total ? p : q;
  return milestones === t.milestones && milestoneProgress === q ? t : { ...t, milestones, milestoneProgress };
}

/**
 * TASK_CREATE / TASK_UPDATE / a REST answer / an optimistic change. The column lists change only
 * when the status or the position did; an archived task leaves the board.
 */
export function upsertTask(d: BoardsData, task: Task): Partial<BoardsData> {
  if (task.archivedAt) return removeTask(d, task.id, task);
  const prev = d.tasks[task.id];
  const next = keepMilestones(prev, keepViewer(prev, task));
  const out: Partial<BoardsData> = { tasks: { ...d.tasks, [task.id]: next } };
  const cc = keepCounts(d.checkCounts, prev, next);
  if (cc !== d.checkCounts) out.checkCounts = cc;
  if (next.roomId && d.roomTask[next.roomId] !== next.id) out.roomTask = { ...d.roomTask, [next.roomId]: next.id };
  // The badge counts what «Мои задачи» lists: open tasks only (a closed one keeps its own mark).
  const counts = countsUnread(next);
  if ((task.viewerState || next.completedAt) && !!d.unread[task.id] !== counts) out.unread = counts ? { ...d.unread, [task.id]: next.workspaceId } : without(d.unread, task.id);
  const cols = d.columns[next.boardId];
  const moved = !prev || prev.statusId !== next.statusId || prev.position !== next.position || prev.boardId !== next.boardId;
  if (moved) {
    const columns: Record<string, Readonly<Record<string, readonly string[]>>> = { ...d.columns };
    // Left its old column (another status or another board).
    if (prev) {
      const old = d.columns[prev.boardId];
      const oldIds = old?.[prev.statusId];
      if (old && oldIds?.includes(prev.id) && (prev.statusId !== next.statusId || prev.boardId !== next.boardId)) {
        columns[prev.boardId] = { ...old, [prev.statusId]: oldIds.filter((x) => x !== prev.id) };
      }
    }
    if (cols) {
      const base = columns[next.boardId] ?? cols;
      const tasks = out.tasks as Record<string, Task>;
      columns[next.boardId] = { ...base, [next.statusId]: insertOrdered(base[next.statusId] ?? EMPTY_IDS, next.id, tasks) };
    }
    out.columns = columns;
  }
  return out;
}

/** TASK_DELETE (archived / purged) or an archive answer: out of the board and its column. */
export function removeTask(d: BoardsData, taskId: string, archived?: Task): Partial<BoardsData> {
  const prev = d.tasks[taskId];
  if (!prev) return {};
  const out: Partial<BoardsData> = {};
  // An archived task stays known (an open panel shows it read-only) but leaves the columns.
  out.tasks = archived ? { ...d.tasks, [taskId]: archived } : without(d.tasks, taskId);
  const cols = d.columns[prev.boardId];
  const ids = cols?.[prev.statusId];
  if (cols && ids?.includes(taskId)) out.columns = { ...d.columns, [prev.boardId]: { ...cols, [prev.statusId]: ids.filter((x) => x !== taskId) } };
  if (d.unread[taskId]) out.unread = without(d.unread, taskId);
  return out;
}

/** Positions of several tasks at once (a renumbered column after a tight drop). */
export function setPositions(d: BoardsData, positions: Readonly<Record<string, number>>): Partial<BoardsData> {
  let data: BoardsData = d;
  for (const [id, position] of Object.entries(positions)) {
    const t = data.tasks[id];
    if (t && t.position !== position) data = { ...data, ...upsertTask(data, { ...t, position }) };
  }
  return data;
}

/** READY: a workspace's unread task ids replace what was known for it. */
export function setUnread(d: BoardsData, workspaceId: string, ids: readonly string[]): Partial<BoardsData> {
  const unread: Record<string, string> = {};
  for (const [id, ws] of Object.entries(d.unread)) if (ws !== workspaceId) unread[id] = ws;
  for (const id of ids) unread[id] = workspaceId;
  return { unread };
}

/** TASK_ACTIVITY: one journal row (dedup by id). */
export function appendActivity(d: BoardsData, a: TaskActivity): Partial<BoardsData> {
  const list = d.activity[a.taskId] ?? [];
  if (list.some((x) => x.id === a.id)) return {};
  return { activity: { ...d.activity, [a.taskId]: [...list, a] } };
}

// ------------------------------------------------------------------ board categories (ADR-0058 §1)

/** READY: a workspace's categories replace what was known for it. */
export function setWorkspaceCategories(d: BoardsData, workspaceId: string, list: readonly BoardCategory[]): Partial<BoardsData> {
  const categories: Record<string, BoardCategory> = {};
  for (const [id, c] of Object.entries(d.categories)) if (c.workspaceId !== workspaceId) categories[id] = c;
  for (const c of list) categories[c.id] = c;
  return { categories };
}

export function upsertCategory(d: BoardsData, c: BoardCategory): Partial<BoardsData> {
  const prev = d.categories[c.id];
  if (prev && prev.name === c.name && prev.position === c.position) return {};
  return { categories: { ...d.categories, [c.id]: c } };
}

/** BOARD_CATEGORY_DELETE: its boards move to «без категории» (their BOARD_UPDATE follows). */
export function removeCategory(d: BoardsData, categoryId: string): Partial<BoardsData> {
  if (!d.categories[categoryId]) return {};
  return { categories: without(d.categories, categoryId) };
}

// ------------------------------------------------------------------ checklists (ADR-0058 §2)

function setCounts(d: BoardsData, taskId: string, total: number, done: number): Partial<BoardsData> {
  const cur = d.checkCounts[taskId];
  const t = d.tasks[taskId];
  if (cur ? cur.total === total && cur.done === done : t && t.checklistTotal === total && t.checklistDone === done) return {};
  return { checkCounts: { ...d.checkCounts, [taskId]: { total, done } } };
}

/** GET /tasks/{id}: the task's checklists (the panel shows them). */
export function setChecklists(d: BoardsData, taskId: string, list: readonly TaskChecklist[]): Partial<BoardsData> {
  const next = putChecklists(d.checklists[taskId], list);
  return next === d.checklists[taskId] ? {} : { checklists: { ...d.checklists, [taskId]: next } };
}

/**
 * TASK_CHECKLIST_UPDATE / a checklist answer / an optimistic change: the counters always, the
 * checklist only for a task whose checklists are loaded (the store does not collect every
 * checklist of every board).
 */
export function upsertChecklist(d: BoardsData, taskId: string, c: TaskChecklist | undefined, total: number, done: number): Partial<BoardsData> {
  // A task nothing shows (its board not loaded): nothing to keep (as TASK_UPDATE, services/boards.ts).
  if (!d.tasks[taskId] && !d.checklists[taskId]) return {};
  const out = setCounts(d, taskId, total, done);
  const list = d.checklists[taskId];
  if (c && list) {
    // An item moved to another checklist leaves its old one (that checklist's event may lag).
    const ids = new Set(c.items.map((x) => x.id));
    const others = list.map((x) => (x.id !== c.id && x.items.some((i) => ids.has(i.id)) ? { ...x, items: x.items.filter((i) => !ids.has(i.id)) } : x));
    const base = others.some((x, i) => x !== list[i]) ? others : list;
    const next = putChecklist(base, c);
    if (next !== list) out.checklists = { ...d.checklists, [taskId]: next };
  }
  return out;
}

/** TASK_CHECKLIST_DELETE / DELETE answer. */
export function removeChecklist(d: BoardsData, taskId: string, checklistId: string, total: number, done: number): Partial<BoardsData> {
  if (!d.tasks[taskId] && !d.checklists[taskId]) return {};
  const out = setCounts(d, taskId, total, done);
  const list = d.checklists[taskId];
  if (list?.some((c) => c.id === checklistId)) out.checklists = { ...d.checklists, [taskId]: list.filter((c) => c.id !== checklistId) };
  return out;
}

/** The checklist counters a card shows: the newer override, else the task's own. */
export function checkCountsOf(d: Pick<BoardsData, 'tasks' | 'checkCounts'>, taskId: string): CheckCounts {
  const c = d.checkCounts[taskId];
  if (c) return c;
  const t = d.tasks[taskId];
  return { total: t?.checklistTotal ?? 0, done: t?.checklistDone ?? 0 };
}
