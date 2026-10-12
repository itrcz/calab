import { BoardStatusType, type Task } from '@calaba/protocol';

/**
 * The «Незавершённые · Завершённые · Все» quick filter of a board view and of «Мои задачи»
 * (docs/08 «Доски»). «Завершённые» = a status of type COMPLETED or CANCELLED (the board's status
 * types); a task carries it as `completedAt`. Replaces the old «Показывать завершённые» toggle:
 * a stored `showCompleted` false → 'open', true → 'all'.
 */
export type Completion = 'open' | 'done' | 'all';

export const COMPLETIONS: readonly Completion[] = ['open', 'done', 'all'];

export function isCompletion(v: unknown): v is Completion {
  return v === 'open' || v === 'done' || v === 'all';
}

const doneStatus = (type: BoardStatusType | undefined): boolean => type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED;

/** Tasks of a status of this type are shown under the filter. */
export function statusShown(c: Completion, type: BoardStatusType | undefined): boolean {
  return c === 'all' || (c === 'done') === doneStatus(type);
}

/** A task outside a loaded board (my tasks): by `completedAt`, set while in a done status. */
export function taskShown(c: Completion, t: Pick<Task, 'completedAt'>): boolean {
  return c === 'all' || (c === 'done') === !!t.completedAt;
}

/** The filter of stored board prefs: the new field, else the old boolean, else the default. */
export function migrateCompletion(stored: { completion?: unknown; showCompleted?: unknown } | undefined, fallback: Completion = 'open'): Completion {
  if (isCompletion(stored?.completion)) return stored.completion;
  if (typeof stored?.showCompleted === 'boolean') return stored.showCompleted ? 'all' : 'open';
  return fallback;
}
