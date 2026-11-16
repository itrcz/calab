import { BoardStatusType } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { Archive, ArchiveRestore, ArrowLeft, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Bar } from '../../components/Bar';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { useMobile } from '../../lib/mobile';
import { loadMoreArchive, openArchived, openArchiveList, restoreFromArchive } from '../../services/boardArchive';
import { useBoardArchive } from '../../stores/boardArchive';
import { useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { myUserId } from '../../stores/session';
import { mayRestoreTask } from './model';
import { StatusIcon } from './visuals';
import { useTaskPerms } from './useTaskPerms';

/**
 * «Архив задач» (owner 18.10): the archive mode of a board — archived tasks (manual and
 * auto-archived), newest archived first, read-only rows, a search and «Восстановить». The data
 * lives in its own store (stores/boardArchive.ts), never in the boards store: nothing here can
 * leak into the kanban, the lists, «Мои задачи» or the counters. A row opens the normal task view
 * (read-only, with the «Задача в архиве» banner). A task restored anywhere (this row, the banner,
 * another client) leaves the list when the boards store sees it live again.
 */
export function BoardArchive({ boardId }: { boardId: string }): ReactNode {
  const [text, setText] = useState('');
  const query = useBoardArchive((s) => s.query);
  const shown = useBoardArchive((s) => s.ids.length);
  const more = useBoardArchive((s) => s.cursor !== '');
  const load = useBoardArchive((s) => s.load);
  const fetching = useBoardArchive((s) => s.more);
  const ids = useBoardArchive((s) => s.ids);
  const name = useBoards((s) => s.boards[boardId]?.name ?? '');
  // The search is answered by the server (title, description, key); typing waits 300 ms, clearing is at once.
  useEffect(() => {
    const id = setTimeout(() => void openArchiveList(boardId, text), text.trim() ? 300 : 0);
    return () => clearTimeout(id);
  }, [boardId, text]);
  // A task live again in the boards store (restored from the banner, by another client) leaves the list.
  useEffect(
    () =>
      useBoards.subscribe((s, prev) => {
        const a = useBoardArchive.getState();
        for (const id of a.ids) {
          const now = s.tasks[id];
          if (now && !now.archivedAt && now !== prev.tasks[id]) a.drop(id);
        }
      }),
    [],
  );
  const back = useCallback(() => useBoardsUi.getState().setArchiveOf(null), []);
  const open = useCallback((id: string, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    const task = useBoardArchive.getState().tasks[id];
    if (task) openArchived(task);
  }, []);
  const mobile = useMobile();
  const field = (
    <Input
      icon={<Search />}
      value={text}
      onChange={(e) => setText(e.target.value)}
      placeholder={t('boards.archiveSearch')}
      aria-label={t('boards.archiveSearch')}
      maxLength={100}
      data-testid="archive-search"
    />
  );
  const count = more ? `${shown}+` : String(shown);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="board-archive">
      <Bar plain className="gap-2 pl-2 pr-3 mobile:pl-1" data-testid="archive-header">
        <Button variant="ghost" size="md" onClick={back} data-testid="archive-back">
          <ArrowLeft className="size-4" aria-hidden /> {t('boards.archiveBack')}
        </Button>
        <h1 className="flex min-w-0 flex-1 items-center gap-2 truncate text-headline font-semibold mobile:text-list" title={name}>
          <Archive className="size-[18px] shrink-0 text-muted" aria-hidden />
          <span className="truncate" data-testid="archive-title">
            {t('boards.archiveTitle', { n: count })}
          </span>
        </h1>
        {mobile ? null : <div className="w-60">{field}</div>}
      </Bar>
      {mobile ? <div className="shrink-0 px-3 pb-2">{field}</div> : null}
      {load === 'error' ? (
        <div className="grid flex-1 place-items-center">
          <Button variant="secondary" onClick={() => void openArchiveList(boardId, query)}>
            {t('common.retry')}
          </Button>
        </div>
      ) : load !== 'ready' ? (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      ) : ids.length === 0 ? (
        <div className="grid flex-1 place-items-center p-8 text-center text-body text-muted" data-testid="archive-empty">
          {query.trim() ? t('boards.archiveNoMatch') : t('boards.archiveEmpty')}
        </div>
      ) : (
        <Virtuoso
          className="scrollbar-thin"
          style={{ flex: 1 }}
          data={ids}
          computeItemKey={(_, id) => id}
          increaseViewportBy={300}
          endReached={() => void loadMoreArchive()}
          itemContent={(_, id) => <ArchiveRow id={id} boardId={boardId} onOpen={open} />}
          components={{ Footer: () => (fetching ? <div className="grid h-12 place-items-center"><Spinner /></div> : null) }}
        />
      )}
    </div>
  );
}

/** One archived task: read-only cells, «Восстановить» on hover (always visible on the phone). */
const ArchiveRow = memo(function ArchiveRow({ id, boardId, onOpen }: { id: string; boardId: string; onOpen: (id: string, e: MouseEvent) => void }): ReactNode {
  const task = useBoardArchive((s) => s.tasks[id]);
  const status = useBoards((s) => (task ? s.boards[boardId]?.statuses.find((x) => x.id === task.statusId) : undefined));
  const perms = useTaskPerms(task);
  const focused = useBoardsUi((s) => s.focused === id || s.taskId === id);
  const [busy, setBusy] = useState(false);
  if (!task) return null;
  const at = task.archivedAt ? new Date(timestampMs(task.archivedAt)) : null;
  const when = at ? fmt.dateTime(at, 'short') : '';
  const can = mayRestoreTask(task, perms, myUserId());
  return (
    <div
      data-archive-task={id}
      data-testid="archive-row"
      data-key={task.key}
      onClick={(e) => onOpen(id, e)}
      className={cx(
        'group/row flex h-9 cursor-default items-center gap-2 border-b border-line pl-4 pr-3 text-control mobile:h-auto mobile:min-h-14 mobile:flex-wrap mobile:content-center mobile:gap-y-0 mobile:py-2 mobile:pl-3',
        focused ? 'bg-active' : 'hover:bg-[color-mix(in_srgb,var(--color-fill)_50%,transparent)]',
      )}
    >
      <span className="w-[64px] shrink-0 truncate text-caption tabular-nums text-muted mobile:hidden">{task.key}</span>
      <span className="grid size-6 shrink-0 place-items-center" title={status?.name}>
        <StatusIcon type={status?.type ?? BoardStatusType.UNSPECIFIED} color={status?.color ?? 0} icon={status?.icon} />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted mobile:line-clamp-2 mobile:whitespace-normal mobile:text-body mobile:text-fg mobile:[overflow-wrap:anywhere]">{task.title}</span>
      <span className="hidden max-w-[140px] shrink-0 truncate text-caption text-muted min-[900px]:block" data-testid="archive-status">
        {status?.name}
      </span>
      <span className="hidden h-0 basis-full mobile:block" aria-hidden />
      <span className="shrink-0 text-caption tabular-nums text-faint mobile:min-w-0 mobile:flex-1 mobile:truncate" data-testid="archive-when">
        <span className="hidden mobile:inline">{task.key} · </span>
        {when}
      </span>
      {can ? (
        <IconButton
          size="sm"
          label={t('boards.restore')}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setBusy(true);
            void restoreFromArchive(task).finally(() => setBusy(false));
          }}
          className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 mobile:opacity-100"
          data-testid="archive-restore"
        >
          <ArchiveRestore className="size-4" aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
});
