import type { Task } from '@calaba/protocol';

/** At most this many watchers on one task (the server answers 409 beyond, ADR-0076). */
export const MAX_WATCHERS = 50;

export interface WatcherControls {
  /** The «Наблюдатели» row is shown: there are watchers or the viewer may add them. */
  visible: boolean;
  /** «+ Добавить»: only someone who may edit the task opens a card to others (ADR-0076 §4). */
  add: boolean;
  /** I watch this task: «Перестать наблюдать». */
  watching: boolean;
}

/**
 * What the task panel offers for watchers (ADR-0076 §4, §6, §7). canEdit is mayEditTask (false
 * on an archived task). Removing someone else takes canEdit; removing myself is always allowed
 * on a live task.
 */
export function watcherControls(task: Pick<Task, 'watcherIds' | 'archivedAt'>, canEdit: boolean, me: string): WatcherControls {
  const live = !task.archivedAt;
  return {
    visible: task.watcherIds.length > 0 || (canEdit && live),
    add: canEdit && live && task.watcherIds.length < MAX_WATCHERS,
    watching: live && task.watcherIds.includes(me),
  };
}

/** Whether the viewer may remove watcher `userId` (an editor anyone, a watcher themselves). */
export function mayRemoveWatcher(task: Pick<Task, 'archivedAt'>, canEdit: boolean, me: string, userId: string): boolean {
  return !task.archivedAt && (canEdit || userId === me);
}

/** The list with userId added (sorted by id, as the server sends it) or removed. */
export function toggleWatcher(ids: readonly string[], userId: string): string[] {
  return ids.includes(userId) ? ids.filter((x) => x !== userId) : [...ids, userId].sort();
}
