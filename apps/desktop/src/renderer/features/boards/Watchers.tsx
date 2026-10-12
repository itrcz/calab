import type { Task } from '@calaba/protocol';
import { ChevronRight, Eye, EyeOff, Plus, X } from 'lucide-react';
import { memo, useState, type DragEvent, type ReactNode } from 'react';
import { ProfileTarget } from '../../components/ProfileTarget';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayRemoveWatcher, watcherControls } from '../../lib/boards/watchers';
import { setWatcher } from '../../services/boards';
import { myUserId } from '../../stores/session';
import { useMemberName } from '../../stores/workspaces';
import { useBoardsUi } from '../../stores/boardsUi';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { MemberAvatar, WatcherMenu } from './menus';

/**
 * «Наблюдатели» (ADR-0076 §7, docs/08 «Доски»): a section of its own under the properties block,
 * collapsed by default — the header «Наблюдатели · N» toggles it (remembered, boardsUi). Open:
 * watcher chips (avatar + name, ✕ on hover; always on the phone), «+ Добавить» for whoever may
 * edit the task, and «Перестать наблюдать» for me as a watcher. A member dragged onto the section
 * becomes a watcher (as onto «Исполнители»).
 */
export function WatchersSection({ task, canEdit }: { task: Pick<Task, 'id' | 'workspaceId' | 'boardId' | 'watcherIds' | 'archivedAt'>; canEdit: boolean }): ReactNode {
  const me = myUserId();
  const c = watcherControls(task, canEdit, me);
  const open = useBoardsUi((s) => s.watchersOpen);
  const [over, setOver] = useState(false);
  if (!c.visible) return null;
  const onDragOver = (e: DragEvent): void => {
    if (c.add && dragKind(e.dataTransfer) === 'user') {
      e.preventDefault();
      setOver(true);
    }
  };
  const onDrop = (e: DragEvent): void => {
    setOver(false);
    const userId = e.dataTransfer.getData(DRAG_USER);
    if (!userId) return;
    e.preventDefault();
    void setWatcher(task.id, userId, true);
  };
  return (
    <section
      className={cx('-mt-2 flex flex-col gap-1 rounded-[var(--radius-row)]', over && 'ring-2 ring-accent')}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      aria-label={t('boards.watchers')}
      data-testid="prop-watchers"
      data-open={open ? 'true' : 'false'}
    >
      <WatchersHeader n={task.watcherIds.length} open={open} />
      {open ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1 pl-1" data-testid="watchers-body">
          {task.watcherIds.map((u) => (
            <WatcherChip key={u} workspaceId={task.workspaceId} taskId={task.id} userId={u} removable={mayRemoveWatcher(task, canEdit, me, u)} />
          ))}
          {c.add ? (
            <WatcherMenu workspaceId={task.workspaceId} boardId={task.boardId} value={task.watcherIds} onToggle={(u) => void setWatcher(task.id, u, !task.watcherIds.includes(u))}>
              <button type="button" className={cx(valueBtn, 'text-muted')} data-testid="watcher-add">
                <Plus className="size-3.5" aria-hidden /> {t('boards.addWatcher')}
              </button>
            </WatcherMenu>
          ) : null}
          {c.watching ? (
            <button type="button" onClick={() => void setWatcher(task.id, me, false)} className={cx(valueBtn, 'text-muted')} data-testid="watcher-leave">
              <EyeOff className="size-3.5" aria-hidden /> {t('boards.stopWatching')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** «▸ 👁 Наблюдатели  3» — the toggle (exported for tests: SSR without the store). */
export function WatchersHeader({ n, open, onToggle }: { n: number; open: boolean; onToggle?: () => void }): ReactNode {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle ?? (() => useBoardsUi.getState().setWatchersOpen(!open))}
      className="flex h-8 items-center gap-1.5 self-start rounded-[var(--radius-row)] px-1 text-caption font-semibold text-muted hover:bg-hover hover:text-fg"
      data-testid="watchers-toggle"
    >
      <ChevronRight className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', open && 'rotate-90')} aria-hidden />
      <Eye className="size-3.5" aria-hidden />
      {t('boards.watchers')}
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-hover px-1 text-micro font-medium tabular-nums text-fg" data-testid="watchers-count">
        {n}
      </span>
    </button>
  );
}

const valueBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-control text-fg hover:bg-hover mobile:h-8';

/** One watcher: memo on primitives, so a TASK_UPDATE re-renders only the chips that changed. */
const WatcherChip = memo(function WatcherChip({ workspaceId, taskId, userId, removable }: { workspaceId: string; taskId: string; userId: string; removable: boolean }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return (
    <span className="group/w inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full border border-line pl-0.5 pr-2 mobile:h-8 mobile:max-w-full" data-testid="watcher-chip" data-user={userId}>
      <ProfileTarget userId={userId} name={name} workspaceId={workspaceId} tabbable className="inline-flex min-w-0 items-center gap-1.5 rounded-full text-left">
        <MemberAvatar workspaceId={workspaceId} userId={userId} size={22} />
        <span className="min-w-0 truncate text-control">{name}</span>
      </ProfileTarget>
      {removable ? (
        <button
          type="button"
          aria-label={t('boards.removeWatcher', { name })}
          onClick={() => void setWatcher(taskId, userId, false)}
          className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/w:opacity-100 mobile:opacity-100"
          data-testid="watcher-remove"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
});
