import type { Task } from '@calaba/protocol';
import { EyeOff, Plus, X } from 'lucide-react';
import { memo, useState, type DragEvent, type ReactNode } from 'react';
import { ProfileTarget } from '../../components/ProfileTarget';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayRemoveWatcher, watcherControls } from '../../lib/boards/watchers';
import { setWatcher } from '../../services/boards';
import { myUserId } from '../../stores/session';
import { useMemberName } from '../../stores/workspaces';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { MemberAvatar, WatcherMenu } from './menus';

/**
 * «Наблюдатели» (ADR-0076 §7, docs/08 «Доски»): a properties row under «Исполнители» /
 * «Согласование» — watcher chips (avatar + name, ✕ on hover; always on the phone), «+ Добавить»
 * for whoever may edit the task, and «Перестать наблюдать» for me as a watcher. A member dragged
 * here becomes a watcher (as onto «Исполнители»).
 */
export function WatchersSection({ task, canEdit }: { task: Pick<Task, 'id' | 'workspaceId' | 'boardId' | 'watcherIds' | 'archivedAt'>; canEdit: boolean }): ReactNode {
  const me = myUserId();
  const c = watcherControls(task, canEdit, me);
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
    <div
      className={cx('flex min-h-8 items-start gap-3 rounded-[var(--radius-row)] mobile:flex-col mobile:gap-0.5 mobile:py-1', over && 'ring-2 ring-accent')}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid="prop-watchers"
    >
      <span className="w-[104px] shrink-0 pt-1.5 text-caption text-muted mobile:w-auto mobile:pt-0">{t('boards.watchers')}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 mobile:w-full">
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
    </div>
  );
}

const valueBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-control text-fg hover:bg-hover mobile:h-8';

/** One watcher: memo on primitives, so a TASK_UPDATE re-renders only the chips that changed. */
const WatcherChip = memo(function WatcherChip({ workspaceId, taskId, userId, removable }: { workspaceId: string; taskId: string; userId: string; removable: boolean }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return (
    <span className="group/w inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line pl-0.5 pr-2 mobile:h-8" data-testid="watcher-chip" data-user={userId}>
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
