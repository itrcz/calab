import type { Task } from '@calaba/protocol';
import { taskPermsOf, useBoards } from '../../stores/boards';
import { myUserId } from '../../stores/session';

/**
 * The viewer's bits on one task (ADR-0059 §2, `taskPermissions`): the one hook for the task panel,
 * cards, rows and the timeline. A bigint is a primitive: the component re-renders only when the
 * bits change, not on every board / task update.
 */
export function useTaskPerms(task: Pick<Task, 'boardId' | 'assignees' | 'approvers' | 'archivedAt'> | undefined): bigint {
  const me = myUserId();
  return useBoards((s) => (task ? taskPermsOf(s, task, me) : 0n));
}

/** The board is seen only through the viewer's cards: «create» surfaces stay hidden even though an assignee holds CREATE_TASKS on the card. */
export function useBoardScoped(boardId: string): boolean {
  return useBoards((s) => s.boards[boardId]?.taskScoped ?? false);
}
