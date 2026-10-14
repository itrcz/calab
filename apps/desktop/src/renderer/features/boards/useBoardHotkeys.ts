import { BoardFeature } from '@calaba/protocol';
import { useEffect } from 'react';
import { featureOn } from '../../lib/boards/features';
import { archiveTask, copyTaskKey, copyTaskLink, moveTask } from '../../services/boards';
import { IS_MAC } from '../../services/hotkeys';
import { taskPermsOf, useBoards } from '../../stores/boards';
import { MY_TASKS, prefsOf, useBoardsUi, type ViewKind } from '../../stores/boardsUi';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { hotkeyOf, type BoardHotkeyId } from './hotkeys';
import { hasBit, mayArchiveTask, mayEditTask, CREATE_TASKS } from './model';

/** Where the keyboard is typing: single-letter keys stay text there. */
function typing(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** A menu, popover or dialog has the focus / is open: its own keys win. */
function layerOpen(): boolean {
  if (useUi.getState().dialog) return true;
  const b = useBoardsUi.getState();
  if (b.createFor || b.settingsFor || b.helpOpen) return true;
  return !!document.querySelector('[role=menu], [role=dialog], [data-radix-popper-content-wrapper]');
}

/** The board as the screen shows it: columns of card ids (kanban) or one column of rows (list). */
function layout(): string[][] {
  const cols = [...document.querySelectorAll<HTMLElement>('[data-testid=kanban] [data-column]')];
  if (cols.length) return cols.map((c) => [...c.querySelectorAll<HTMLElement>('[data-card]')].map((n) => n.dataset.card ?? ''));
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid=list-view] [data-task], [data-testid=my-tasks-view] [data-task]')].map((n) => n.dataset.task ?? '');
  return rows.length ? [rows] : [];
}

function position(grid: string[][], id: string | null): [number, number] | null {
  if (!id) return null;
  for (let c = 0; c < grid.length; c++) {
    const r = grid[c]?.indexOf(id) ?? -1;
    if (r >= 0) return [c, r];
  }
  return null;
}

function reveal(id: string): void {
  document.querySelector(`[data-card="${id}"], [data-task="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const VIEWS: ViewKind[] = ['kanban', 'list', 'timeline'];

const MENU_FEATURE: Partial<Record<string, BoardFeature>> = {
  priority: BoardFeature.PRIORITY,
  label: BoardFeature.LABELS,
  due: BoardFeature.DUE_DATE,
  estimate: BoardFeature.ESTIMATE,
  milestone: BoardFeature.MILESTONES,
};

/**
 * The boards mode's keyboard (ADR-0042 «Хоткеи», registry features/boards/hotkeys.ts). Active
 * while the mode is on; single letters are ignored in text fields and while a menu / dialog is
 * open; the menus handle their own keys (digits, search, Enter, Esc).
 */
export function useBoardHotkeys(workspaceId: string, boardId: string): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const h = hotkeyOf(e, IS_MAC);
      if (!h) return;
      const inField = typing(document.activeElement);
      const hasMod = e.metaKey || e.ctrlKey;
      if (inField && h.id !== 'expandPanel') return;
      if (layerOpen() && h.id !== 'expandPanel') return;
      const ui = useBoardsUi.getState();
      const s = useBoards.getState();
      const board = boardId !== MY_TASKS ? s.boards[boardId] : undefined;
      const target = ui.focused ?? ui.taskId;
      const task = target ? s.tasks[target] : undefined;
      const me = myUserId();
      // Per-task bits (ADR-0059): a scoped viewer holds them on his own cards only.
      const perms = task ? taskPermsOf(s, task, me) : board?.permissions;
      const scoped = !!board?.taskScoped;
      if (h.needsTask && !task) return;
      // ⌘C with text selected is the system copy.
      if ((h.id === 'copyKey' || h.id === 'copyLink') && (window.getSelection()?.toString() ?? '') !== '') return;
      const run = (id: BoardHotkeyId): boolean => {
        switch (id) {
          case 'newTask':
            if (!board || !hasBit(board.permissions, CREATE_TASKS)) return false;
            ui.openCreate({ boardId, ...(task && task.boardId === boardId ? { statusId: task.statusId } : {}) });
            return true;
          case 'filter':
            if (!board) return false;
            ui.setFilterOpen(true);
            return true;
          case 'cycleView': {
            if (!board) return false;
            const cur = prefsOf(ui, boardId).kind;
            // TIMELINE off (ADR-0058 §3): V cycles kanban ↔ list.
            const views = featureOn(board.disabledFeatures, BoardFeature.TIMELINE) ? VIEWS : VIEWS.filter((v) => v !== 'timeline');
            ui.setPrefs(boardId, { kind: views[(views.indexOf(cur) + 1) % views.length] ?? 'kanban' });
            return true;
          }
          case 'viewKanban':
          case 'viewList':
          case 'viewTimeline':
            if (!board || (id === 'viewTimeline' && !featureOn(board.disabledFeatures, BoardFeature.TIMELINE))) return false;
            ui.setPrefs(boardId, { kind: id === 'viewKanban' ? 'kanban' : id === 'viewList' ? 'list' : 'timeline' });
            return true;
          case 'up':
          case 'down':
          case 'left':
          case 'right':
          case 'extendUp':
          case 'extendDown': {
            const grid = layout();
            if (!grid.length) return false;
            const at = position(grid, ui.focused);
            let next: string | undefined;
            if (!at) next = grid.find((c) => c.length)?.[0];
            else {
              const [c, r] = at;
              const here = grid.at(c) ?? [];
              if (id === 'up' || id === 'extendUp') next = here.at(Math.max(0, r - 1));
              else if (id === 'down' || id === 'extendDown') next = here.at(Math.min(here.length - 1, r + 1));
              else {
                const dir = id === 'left' ? -1 : 1;
                for (let k = c + dir; k >= 0 && k < grid.length; k += dir) {
                  const col = grid[k] ?? [];
                  if (col.length) {
                    next = col[Math.min(r, col.length - 1)];
                    break;
                  }
                }
              }
            }
            if (!next) return true;
            if ((id === 'extendUp' || id === 'extendDown') && ui.focused && !scoped) {
              const sel = { ...ui.selected, [ui.focused]: true as const, [next]: true as const };
              ui.setSelected(sel);
            }
            ui.setFocused(next);
            // The open panel follows the keyboard (Linear).
            if (ui.taskId) ui.openTask(next);
            reveal(next);
            return true;
          }
          case 'open':
            if (!task) return false;
            ui.openTask(task.id);
            return true;
          case 'edit':
            if (!task) return false;
            ui.openTask(task.id);
            window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-testid=task-title]')?.focus(), 50);
            return true;
          case 'close':
            if (ui.taskId) ui.openTask(null);
            else if (Object.keys(ui.selected).length) ui.clearSelection();
            else if (ui.focused) ui.setFocused(null);
            else ui.setActive(false);
            return true;
          case 'expandPanel':
            if (!ui.taskId) return false;
            ui.setPanelWide(!ui.panelWide);
            return true;
          case 'status':
          case 'assignee':
          case 'priority':
          case 'label':
          case 'due':
          case 'estimate':
          case 'milestone': {
            if (!task || !mayEditTask(task, perms, me)) return false;
            // A menu of a disabled feature has nowhere to open (ADR-0058 §3).
            const f = MENU_FEATURE[id];
            if (f !== undefined && !featureOn(useBoards.getState().boards[task.boardId]?.disabledFeatures, f)) return false;
            ui.openMenu(task.id, id);
            reveal(task.id);
            return true;
          }
          case 'archive':
            if (!task || !mayArchiveTask(task, perms, me)) return false;
            void archiveTask(task.id);
            return true;
          case 'copyKey':
            if (!task) return false;
            copyTaskKey(task.key);
            return true;
          case 'copyLink':
            if (!task) return false;
            copyTaskLink(task.key);
            return true;
          case 'select':
            // No multi-selection on a board seen only through its cards (no bulk actions, ADR-0059).
            if (!task || scoped) return false;
            ui.toggleSelected(task.id);
            return true;
          case 'moveLeft':
          case 'moveRight': {
            if (!task || !mayEditTask(task, perms, me)) return false;
            const b = s.boards[task.boardId];
            const list = [...(b?.statuses ?? [])].sort((x, y) => x.position - y.position);
            const i = list.findIndex((x) => x.id === task.statusId) + (id === 'moveLeft' ? -1 : 1);
            const to = list[i];
            if (!to) return true;
            const col = s.columns[task.boardId]?.[to.id] ?? [];
            void moveTask(task.id, to.id, col.at(-1) ?? '', '');
            return true;
          }
          case 'moveUp':
          case 'moveDown': {
            if (!task || !mayEditTask(task, perms, me)) return false;
            const grid = layout();
            const at = position(grid, task.id);
            if (!at) return true;
            const col = (grid[at[0]] ?? []).filter((x) => x !== task.id);
            const to = at[1] + (id === 'moveUp' ? -1 : 1);
            if (to < 0 || to > col.length) return true;
            void moveTask(task.id, task.statusId, col[to - 1] ?? '', col[to] ?? '');
            return true;
          }
          case 'help':
            ui.setHelpOpen(true);
            return true;
          default:
            return false;
        }
      };
      if (!hasMod && e.shiftKey && h.id !== 'help' && h.id !== 'extendUp' && h.id !== 'extendDown' && h.id !== 'edit') return;
      if (run(h.id)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceId, boardId]);
}
