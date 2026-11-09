import { X } from 'lucide-react';
import { memo, useCallback, useEffect, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { isMobileNow } from '../../lib/mobile';
import { openTaskAnywhere } from '../../services/boards';
import { entryOf, openInTab } from '../../services/taskTab';
import { useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { useUi } from '../../stores/ui';
import { useTaskTabs } from '../../stores/taskTabs';
import { closeFileTab, showFileTab } from '../disk/office/fileTabs';
import { FileTypeIcon } from '../disk/visuals';

export { openInTab };

/**
 * Ctrl/⌘-click on a card or row opens a background tab (#93) — unless a selection is under way,
 * where ⌘-click keeps toggling it — and never on the phone (no tabs there). True when it did.
 */
export function tabClick(id: string, e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>, workspaceId: string, boardId: string): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || isMobileNow()) return false;
  if (Object.keys(useBoardsUi.getState().selected).length > 0) return false;
  openInTab(id, workspaceId, boardId);
  return true;
}

/**
 * The open tasks and office files (ADR-0143) as browser tabs in ONE strip in the title bar (desktop only; #93 follow-up): they stay in
 * every section (Disk, Calendar, chats…), so a task is one click away for a demo. Follows the open
 * task: a plain open of a task without a tab creates none (#137; stores/taskTabs.ts). Renders nothing without tabs —
 * no empty bar. Each tab is a leaf with its own subscriptions; no timers.
 */
export const TaskTabs = memo(function TaskTabs(): ReactNode {
  const taskId = useBoardsUi((s) => s.taskId);
  useEffect(() => {
    if (!taskId) return;
    const ws = useUi.getState().activeWorkspaceId ?? '';
    useTaskTabs.getState().activate(entryOf(taskId, ws, useBoardsUi.getState().boardOf[ws] ?? ''));
    // A new open task only: the current workspace and board are its fallback place, not triggers.
  }, [taskId]);
  const ids = useTaskTabs(useShallow((s) => s.tabs.map((x) => x.id)));
  if (ids.length === 0 || isMobileNow()) return null;
  return (
    <nav aria-label={t('office.tabs')} className="scrollbar-none mx-1 flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="task-tabs">
      {ids.map((id) => (id.startsWith('f:') ? <FileTabItem key={id} id={id} /> : <TabItem key={id} id={id} />))}
    </nav>
  );
});

const TabItem = memo(function TabItem({ id }: { id: string }): ReactNode {
  // Highlighted only while the card is actually on screen (the boards section is the one shown).
  const open = useBoardsUi((s) => s.taskId === id);
  const shown = useTaskTabs((s) => s.shown);
  const active = open && shown;
  const stored = useTaskTabs((s) => s.tabs.find((x) => x.id === id));
  const key = useBoards((s) => s.tasks[id]?.key ?? '') || stored?.key || '';
  const title = useBoards((s) => s.tasks[id]?.title ?? '') || stored?.title || '';
  // The snapshot follows the live task, so the strip is right after a reload too.
  useEffect(() => {
    if (key || title) useTaskTabs.getState().sync(id, key, title);
  }, [id, key, title]);
  const go = useCallback(() => {
    const tab = useTaskTabs.getState().tabs.find((x) => x.id === id);
    // A task over an open file view: the file view gives way (its editor saves and goes).
    useTaskTabs.getState().leaveFile();
    if (tab) openTaskAnywhere({ id, workspaceId: tab.ws, boardId: tab.board });
  }, [id]);
  const close = useCallback((e?: MouseEvent) => {
    e?.stopPropagation();
    const wasOpen = useBoardsUi.getState().taskId === id;
    const next = useTaskTabs.getState().close(id);
    if (!wasOpen) return;
    if (next) openTaskAnywhere({ id: next.id, workspaceId: next.ws, boardId: next.board });
    else useBoardsUi.getState().openTask(null);
  }, [id]);
  return (
    <div
      className={cx('group flex h-7 min-w-[120px] max-w-[200px] shrink items-center rounded-[var(--radius-row)] text-control', active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
      onAuxClick={(e) => e.button === 1 && close()}
      data-testid="task-tab"
      data-task-tab={id}
      data-active={active || undefined}
    >
      <button type="button" onClick={go} aria-current={active ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] py-1 pl-2 pr-1 text-left" title={`${key} ${title}`.trim()}>
        <span className="shrink-0 font-medium tabular-nums">{key}</span>
        <span className="min-w-0 truncate">{title}</span>
      </button>
      <Tip label={t('boards.tab.close')}>
        <button type="button" onClick={close} aria-label={t('boards.tab.close')} className="mr-1 grid size-5 shrink-0 place-items-center rounded-[var(--radius-icon)] text-faint hover:bg-hover hover:text-fg" data-testid="task-tab-close">
          <X className="size-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      </Tip>
    </div>
  );
});

/**
 * An opened office file (ADR-0143): the type icon, the name, a dot while changes are pending (a
 * warning dot when leaving it could not save), the cross; a middle click closes too. Active while
 * its view is on screen. Leaf with primitive selectors; no timers.
 */
const FileTabItem = memo(function FileTabItem({ id }: { id: string }): ReactNode {
  const name = useTaskTabs((s) => s.tabs.find((x) => x.id === id)?.title ?? '');
  const active = useTaskTabs((s) => s.fileActive === id);
  const mark = useTaskTabs((s) => s.fileMark[id]);
  const go = useCallback(() => showFileTab(id), [id]);
  const close = useCallback(
    (e?: MouseEvent) => {
      e?.stopPropagation();
      closeFileTab(id);
    },
    [id],
  );
  return (
    <div
      className={cx('group flex h-7 min-w-[120px] max-w-[200px] shrink items-center rounded-[var(--radius-row)] text-control', active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
      onAuxClick={(e) => e.button === 1 && close()}
      data-testid="file-tab"
      data-file-tab={id}
      data-active={active || undefined}
      data-mark={mark}
    >
      <button type="button" onClick={go} aria-current={active ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] py-1 pl-2 pr-1 text-left" title={name}>
        <FileTypeIcon file={{ mime: '', name }} className="h-4 w-[13px] shrink-0" compact />
        <span className="min-w-0 truncate">{name}</span>
        {mark ? <span className={cx('size-1.5 shrink-0 rounded-full', mark === 'warn' ? 'bg-danger-fill' : 'bg-accent')} role="img" aria-label={mark === 'warn' ? t('office.tab.warn') : t('office.saving')} data-testid="file-tab-dot" /> : null}
      </button>
      <Tip label={t('office.tab.close')}>
        <button type="button" onClick={close} aria-label={t('office.tab.close')} className="mr-1 grid size-5 shrink-0 place-items-center rounded-[var(--radius-icon)] text-faint hover:bg-hover hover:text-fg" data-testid="file-tab-close">
          <X className="size-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      </Tip>
    </div>
  );
});
