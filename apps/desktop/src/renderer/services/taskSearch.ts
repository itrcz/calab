import type { SavedTaskSearch, SearchTasksResponse, Task } from '@calaba/protocol';
import { t } from '../i18n';
import { toTaskFilter } from '../lib/boards/filter';
import { searchParams, toSavedQuery, fromSavedQuery, type TaskQuery } from '../lib/boards/taskSearch';
import { log } from '../lib/log';
import { useBoards } from '../stores/boards';
import { MY_TASKS, useBoardsUi } from '../stores/boardsUi';
import { useTaskSearch } from '../stores/taskSearch';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { openBoard } from './boards';
import { openTaskOrTab, type TabClickEvent } from './taskTab';
import { boardsApi } from './boardsApi';

/**
 * The task search (ADR-0139): pages of GET …/tasks/search, opening a found task (archived ones
 * too) and the caller's saved searches.
 */

/** One page; the live tasks go to the boards store (rows stay fresh), archived ones only in the answer. */
export async function searchTasksPage(workspaceId: string, q: TaskQuery, boardId: string, cursor: string, signal: AbortSignal): Promise<SearchTasksResponse> {
  const p = searchParams(q);
  const filter = toTaskFilter(q.filter);
  const r = await boardsApi.tasks.find(
    workspaceId,
    { ...p, ...(boardId ? { boardId } : {}), ...(filter.conditions.length ? { filter } : {}), ...(cursor ? { cursor } : {}), limit: PAGE },
    signal,
  );
  const live = r.tasks.filter((x) => !x.archivedAt);
  if (r.keyTask && !r.keyTask.archivedAt) live.push(r.keyTask);
  if (live.length) useBoards.getState().upsertTasks(live);
  return r;
}

export const PAGE = 30;

/**
 * Opens a found task in the boards (its workspace, its board, the full-screen card). An archived
 * one is not in the boards store (it drops archived tasks): it goes in as is, like the board
 * archive's rows, and the card shows «Задача в архиве» with «Восстановить».
 */
export function openFoundTask(task: Task, from = '', e?: TabClickEvent): boolean {
  if (task.archivedAt) useBoards.setState((d) => (d.tasks[task.id] ? {} : { tasks: { ...d.tasks, [task.id]: task } }));
  // Ctrl/⌘: a background tab, the search stays as it is.
  if (openTaskOrTab(task, e)) return true;
  if (from) useBoardsUi.getState().openTask(task.id, from);
  return false;
}

/** The results page: «Мои задачи» on its search tab, the workspace's last query (or `q`). */
export function openSearchPage(workspaceId: string, q?: TaskQuery, savedId = ''): void {
  const ts = useTaskSearch.getState();
  if (q) ts.setQuery(workspaceId, q);
  ts.setActiveSaved(workspaceId, savedId);
  ts.setWantPage(true);
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== workspaceId) ui.setWorkspace(workspaceId);
  const bu = useBoardsUi.getState();
  bu.setActive(true);
  openBoard(workspaceId, MY_TASKS);
  bu.openTask(null);
}

// ------------------------------------------------------------------ saved searches

const loading = new Set<string>();

/** The caller's saved searches of a workspace, once (the left panel). */
export function loadSavedSearches(workspaceId: string, force = false): void {
  if (!force && (useTaskSearch.getState().saved[workspaceId] || loading.has(workspaceId))) return;
  loading.add(workspaceId);
  boardsApi.savedSearches.list(workspaceId).then(
    (r) => useTaskSearch.getState().setSaved(workspaceId, r.searches),
    (e: unknown) => log.warn('saved task searches failed', e),
  ).finally(() => loading.delete(workspaceId));
}

const sorted = (list: SavedTaskSearch[]): SavedTaskSearch[] => [...list].sort((a, b) => a.position - b.position);

/** «Сохранить фильтр»: a new named search; it becomes the page's open one. */
export async function saveSearch(workspaceId: string, name: string, q: TaskQuery): Promise<SavedTaskSearch | null> {
  try {
    const r = await boardsApi.savedSearches.create(workspaceId, { name, query: toSavedQuery(q) });
    const s = r.search;
    if (!s) return null;
    const ts = useTaskSearch.getState();
    ts.setSaved(workspaceId, sorted([...(ts.saved[workspaceId] ?? []), s]));
    ts.setActiveSaved(workspaceId, s.id);
    toast.success(t('ts.saved', { name: s.name }));
    return s;
  } catch (e) {
    toast.fail(e);
    return null;
  }
}

/** Rename and / or replace the conditions of a saved search. */
export async function updateSavedSearch(workspaceId: string, id: string, patch: { name?: string; query?: TaskQuery }): Promise<void> {
  try {
    const r = await boardsApi.savedSearches.update(workspaceId, id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.query ? { query: toSavedQuery(patch.query) } : {}) });
    const s = r.search;
    if (!s) return;
    const ts = useTaskSearch.getState();
    ts.setSaved(workspaceId, sorted((ts.saved[workspaceId] ?? []).map((x) => (x.id === id ? s : x))));
  } catch (e) {
    toast.fail(e);
  }
}

export async function removeSavedSearch(workspaceId: string, id: string): Promise<void> {
  try {
    await boardsApi.savedSearches.remove(workspaceId, id);
    const ts = useTaskSearch.getState();
    ts.setSaved(workspaceId, (ts.saved[workspaceId] ?? []).filter((x) => x.id !== id));
    if (ts.activeSaved[workspaceId] === id) ts.setActiveSaved(workspaceId, '');
  } catch (e) {
    toast.fail(e);
  }
}

/** A saved search in one click: its conditions on the results page. */
export function openSavedSearch(workspaceId: string, s: SavedTaskSearch): void {
  openSearchPage(workspaceId, fromSavedQuery(s.query), s.id);
}
