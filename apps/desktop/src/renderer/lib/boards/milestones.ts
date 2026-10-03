import type { Task, TaskMilestone } from '@calaba/protocol';
import { itemPosition } from './checklists';

/**
 * Milestones inside a task on the client (ADR-0063). Pure: the section's state of a milestone,
 * the card's chip, identity-preserving merges (a TASK_UPDATE of the task re-renders only the
 * milestone rows that changed), positions of a drag and the subtask field's choices.
 */

/** ≤ 20 milestones per task, names ≤ 60 (ADR-0063 §1). */
export const MAX_TASK_MILESTONES = 20;
export const MILESTONE_NAME_MAX = 60;

export type MilestoneState = 'done' | 'overdue' | 'open';

/** Completed (a filled diamond), overdue (a red outline: the date passed, not completed) or open. */
export function milestoneState(m: { completedAt?: unknown; dueOn: string }, today: string): MilestoneState {
  if (m.completedAt) return 'done';
  return m.dueOn && m.dueOn < today ? 'overdue' : 'open';
}

/** The server keeps the completion while live non-cancelled subtasks are linked (no manual toggle). */
export const isAuto = (m: Pick<TaskMilestone, 'total'>): boolean => m.total > 0;

/** A row's «3/5» of linked subtasks, '' when none are linked. */
export const subtaskProgress = (m: Pick<TaskMilestone, 'done' | 'total'>): string => (m.total > 0 ? `${m.done}/${m.total}` : '');

/** The card's chip «2/4» (completed of all milestones), '' when the task has none. */
export function milestoneChip(t: Pick<Task, 'milestoneProgress'> | undefined): string {
  const p = t?.milestoneProgress;
  return p && p.total > 0 ? `${p.done}/${p.total}` : '';
}

const tsKey = (m: TaskMilestone): string => (m.completedAt ? `${m.completedAt.seconds}.${m.completedAt.nanos}` : '');

export const sameMilestone = (a: TaskMilestone, b: TaskMilestone): boolean =>
  a.id === b.id && a.name === b.name && a.dueOn === b.dueOn && a.position === b.position && a.done === b.done && a.total === b.total && a.completedBy === b.completedBy && tsKey(a) === tsKey(b);

const byPos = (a: TaskMilestone, b: TaskMilestone): number => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * `next` (by position) with every milestone equal to one of `prev` kept by reference, and `prev`
 * itself when nothing changed: the store keeps the task's milestone objects across TASK_UPDATEs.
 */
export function mergeMilestones(prev: readonly TaskMilestone[] | undefined, next: readonly TaskMilestone[]): TaskMilestone[] {
  const sorted = [...next].sort(byPos);
  if (!prev?.length) return sorted;
  const old = new Map(prev.map((m) => [m.id, m]));
  const out = sorted.map((m) => {
    const o = old.get(m.id);
    return o && sameMilestone(o, m) ? o : m;
  });
  return out.length === prev.length && out.every((m, i) => m === prev[i]) ? (prev as TaskMilestone[]) : out;
}

/** The position of a milestone dropped at `index` of the ordered list (the moved one excluded). */
export const milestonePosition = (list: readonly Pick<TaskMilestone, 'id' | 'position'>[], movedId: string, index: number): number => itemPosition(list, movedId, index);

/** The list after a local (optimistic) change of one milestone, by position. */
export function withMilestone(list: readonly TaskMilestone[], next: TaskMilestone): TaskMilestone[] {
  const has = list.some((m) => m.id === next.id);
  return (has ? list.map((m) => (m.id === next.id ? next : m)) : [...list, next]).sort(byPos);
}

/** The task's progress over its milestones after a local change. */
export function progressOf(list: readonly Pick<TaskMilestone, 'completedAt'>[]): { done: number; total: number } {
  return { done: list.filter((m) => !!m.completedAt).length, total: list.length };
}

/**
 * The add row's keys (ADR-0063 §5): Enter saves (a name is required), Escape cancels; other keys
 * stay with the field.
 */
export function addRowKey(key: string, name: string): 'save' | 'cancel' | null {
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter') return name.trim() ? 'save' : null;
  return null;
}

/** «Прототип · 5 окт · 3/5» — the diamond's hint on the timeline (date / progress when set). */
export function milestoneHint(m: Pick<TaskMilestone, 'name' | 'done' | 'total'>, date: string): string {
  return [m.name, date, subtaskProgress(m)].filter(Boolean).join(' · ');
}
