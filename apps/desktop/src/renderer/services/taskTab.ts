import type { Task } from '@calaba/protocol';
import type { MouseEvent } from 'react';
import { isMobileNow } from '../lib/mobile';
import { useBoards } from '../stores/boards';
import { useBoardsUi } from '../stores/boardsUi';
import { useTaskTabs, type TaskTab } from '../stores/taskTabs';
import { openTaskAnywhere } from './boards';

/** The part of a click that decides «new tab or in place». */
export type TabClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'>;

/** A tab entry for a task: the store's task when loaded, else only where it lives. */
export function entryOf(id: string, workspaceId: string, boardId: string): TaskTab {
  const task = useBoards.getState().tasks[id];
  const prev = useTaskTabs.getState().tabs.find((x) => x.id === id);
  return { id, ws: task?.workspaceId ?? prev?.ws ?? workspaceId, board: task?.boardId ?? prev?.board ?? boardId, key: task?.key ?? prev?.key ?? '', title: task?.title ?? prev?.title ?? '', at: Date.now() };
}

/**
 * «Открыть в новой вкладке» (Ctrl/⌘-click on a task anywhere, the card menu): the task joins the
 * strip in the background; the open one (if any) stays open and joins too, so it is not lost.
 */
export function openInTab(id: string, workspaceId: string, boardId: string): void {
  const open = useBoardsUi.getState().taskId;
  useTaskTabs.getState().add(entryOf(id, workspaceId, boardId), open ? entryOf(open, workspaceId, boardId) : undefined);
}

/** Ctrl/⌘ held on a click — and not on the phone, which has no tabs. */
export function wantsTab(e?: TabClickEvent | null): boolean {
  return !!e && (e.metaKey || e.ctrlKey) && !isMobileNow();
}

/**
 * Opens a task from a click: with Ctrl/⌘ as a background tab (the screen stays), else in place
 * (openTaskAnywhere). True when it went to a tab, so the caller keeps its dialog / query open.
 */
export function openTaskOrTab(task: Pick<Task, 'id' | 'workspaceId' | 'boardId'>, e?: TabClickEvent | null): boolean {
  if (wantsTab(e)) {
    openInTab(task.id, task.workspaceId, task.boardId);
    return true;
  }
  openTaskAnywhere(task);
  return false;
}
