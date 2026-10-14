import { BoardStatusType, type Board, type Task, type UnfurlResponse } from '@calaba/protocol';

/**
 * A task / board link in chat as a card (ADR-0042 §5 «Ссылки»): what the card shows, from the
 * server's unfurl (`task` / `board`, answered by the viewer's rights) and — fresher — the task or
 * board the client already holds. Pure; features/boards/TaskLinkCard.tsx draws it.
 */
export type LinkCard =
  | {
      kind: 'task';
      id: string;
      workspaceId: string;
      boardId: string;
      key: string;
      title: string;
      statusName: string;
      statusType: BoardStatusType | 0;
      statusColor: number;
      /** BoardStatus.icon ('' = by type, ADR-0093). */
      statusIcon: string;
      done: boolean;
      dueOn: string;
      /** Lead first, at most three; `more` = the rest. */
      assignees: string[];
      more: number;
      boardName: string;
    }
  | { kind: 'board'; id: string; workspaceId: string; name: string; emoji: string; key: string; openTasks: number };

const DONE = new Set<number>([BoardStatusType.COMPLETED, BoardStatusType.CANCELLED]);

export function linkCard(res: Pick<UnfurlResponse, 'task' | 'board'>, live?: { task?: Task | undefined; board?: Board | undefined }): LinkCard | null {
  const board = live?.board ?? res.board;
  const task = live?.task ?? res.task;
  if (task) {
    const st = board?.statuses.find((s) => s.id === task.statusId);
    const ids = [...task.assignees].sort((a, b) => Number(b.isLead) - Number(a.isLead)).map((a) => a.userId);
    return {
      kind: 'task',
      id: task.id,
      workspaceId: task.workspaceId || board?.workspaceId || '',
      boardId: task.boardId,
      key: task.key,
      title: task.title,
      statusName: st?.name ?? '',
      statusType: st?.type ?? 0,
      statusColor: st?.color ?? 0x8e8e93,
      statusIcon: st?.icon ?? '',
      done: !!st && DONE.has(st.type),
      dueOn: task.dueOn,
      assignees: ids.slice(0, 3),
      more: Math.max(0, ids.length - 3),
      boardName: board?.name ?? '',
    };
  }
  if (board) return { kind: 'board', id: board.id, workspaceId: board.workspaceId, name: board.name, emoji: board.emoji, key: board.key, openTasks: board.openTasks };
  return null;
}
