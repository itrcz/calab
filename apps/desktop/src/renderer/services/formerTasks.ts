import { TaskField } from '@calaba/protocol';
import { FORMER, addCond, EMPTY_FILTER, isDone } from '../lib/boards/filter';
import { useBoards, workspaceBoards } from '../stores/boards';
import { MY_TASKS, useBoardsUi } from '../stores/boardsUi';
import { useUi } from '../stores/ui';
import { openBoard } from './boards';

/**
 * Open tasks of the workspace assigned to `userId`, counted from the tasks the client has loaded
 * (boards load lazily): 0 means «none loaded or none», so callers omit the hint then (ADR-0097 §4).
 */
export function loadedOpenTasksOf(workspaceId: string, userId: string): number {
  const s = useBoards.getState();
  let n = 0;
  for (const t of Object.values(s.tasks)) {
    if (t.workspaceId !== workspaceId || t.archivedAt || !t.assignees.some((a) => a.userId === userId)) continue;
    const statuses: Record<string, { type: number }> = {};
    for (const st of s.boards[t.boardId]?.statuses ?? []) statuses[st.id] = { type: st.type };
    if (!isDone(t, statuses)) n++;
  }
  return n;
}

/**
 * «Открытых задач: N» in «Бывшие»: opens the workspace's board (the one last open, else the first)
 * with the filter «Исполнитель: бывшие участники» so the lead can hand the tasks out.
 */
export function showFormerTasks(workspaceId: string): void {
  const ui = useBoardsUi.getState();
  const boards = workspaceBoards(useBoards.getState().boards, workspaceId);
  const last = ui.boardOf[workspaceId];
  const board = boards.find((b) => b.id === last) ?? boards[0];
  useUi.getState().openDialog(null);
  if (useUi.getState().activeWorkspaceId !== workspaceId) useUi.getState().setWorkspace(workspaceId);
  if (!board) {
    openBoard(workspaceId, MY_TASKS);
    return;
  }
  ui.setPrefs(board.id, { filter: addCond(EMPTY_FILTER, TaskField.ASSIGNEE, [FORMER]) });
  openBoard(workspaceId, board.id);
}
