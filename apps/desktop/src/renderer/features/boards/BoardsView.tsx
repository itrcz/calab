import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CheckCheck, Inbox, Plus, SquareKanban } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Spinner, cx } from '../../components/ui';
import { Choice } from '../../components/Choice';
import { t } from '../../i18n';
import { mayCreateBoards } from '../../lib/permissions';
import { ensureBoardTasks, ensureUnreadTasks, loadBoard, loadMyTasks, myTasksKey, unreadReason, useTaskDetails } from '../../services/boards';
import type { TaskScope } from '../../services/boardsApi';
import { boardLayout } from '../../lib/boards/categories';
import { unreadCount, unreadOrdered, useBoards, workspaceBoards, workspaceCategories } from '../../stores/boards';
import { taskShown } from '../../lib/boards/completion';
import { CompletionSwitch } from './CompletionSwitch';
import { MY_TASKS, useBoardsUi } from '../../stores/boardsUi';
import { useSession } from '../../stores/session';
import { useMemberRoles } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';
import { BoardHeader } from './BoardHeader';
import { BoardSettingsHost } from './BoardSettings';
import { FilterChips } from './FilterBar';
import { HotkeysSheet } from './HotkeysSheet';
import { Kanban } from './Kanban';
import { EmptyBoard, ListRow, ListView } from './ListView';
import { hasBit, CREATE_TASKS } from './model';
import { TaskPanel } from './TaskPanel';
import { Timeline } from './Timeline';
import { useBoardHotkeys } from './useBoardHotkeys';
import { CreateButton } from '../../components/CreateButton';
import { Bar } from '../../components/Bar';
import { NavButton } from '../../components/PhoneHeader';
import { useMobile } from '../../lib/mobile';
import { useViewKind } from './useBoardView';

/** The board shown for a workspace: the remembered one if it still exists, else the first, else «Мои задачи». */
export function useActiveBoard(workspaceId: string): string {
  const remembered = useBoardsUi((s) => s.boardOf[workspaceId]);
  const exists = useBoards((s) => (remembered && remembered !== MY_TASKS ? !!s.boards[remembered] && !s.boards[remembered].archivedAt : false));
  // The first in the sidebar order (uncategorised, then by category), not the first by raw position (positions are per category).
  const first = useBoards((s) => boardLayout(workspaceBoards(s.boards, workspaceId), workspaceCategories(s.categories, workspaceId), false).find((c) => c.rooms.length)?.rooms[0] ?? '');
  if (remembered === MY_TASKS) return MY_TASKS;
  if (remembered && exists) return remembered;
  return first || MY_TASKS;
}

/**
 * The centre in boards mode (ADR-0042 §5): the open board (header, filter chips, kanban / list /
 * timeline) or «Мои задачи», the task panel on the right (a column from 1200 px, floating below,
 * the whole centre with ⌘\), the create / settings dialogs and the «?» sheet. Keys: hotkeys.ts.
 */
export function BoardsView({ workspaceId, wide, mobile = false }: { workspaceId: string; wide: boolean; mobile?: boolean }): ReactNode {
  const boardId = useActiveBoard(workspaceId);
  const taskId = useBoardsUi((s) => s.taskId);
  useBoardHotkeys(workspaceId, boardId);
  useEffect(() => {
    if (boardId === MY_TASKS) return;
    void ensureBoardTasks(boardId);
    void loadBoard(boardId);
  }, [boardId]);
  return (
    <div className="relative flex min-w-0 flex-1" data-testid="boards-view">
      <section className="mat-content flex min-w-0 flex-1 flex-col" aria-label={t('boards.boards')} data-toast-anchor>
        {boardId === MY_TASKS ? <MyTasks key={workspaceId} workspaceId={workspaceId} /> : <Board boardId={boardId} workspaceId={workspaceId} />}
      </section>
      {taskId ? <TaskPanel taskId={taskId} floating={!wide} page={mobile} /> : null}
      <BoardSettingsHost />
      <HotkeysSheet />
    </div>
  );
}

function Board({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const kind = useViewKind(boardId);
  const load = useBoards((s) => s.load[boardId]);
  return (
    <>
      <BoardHeader boardId={boardId} workspaceId={workspaceId} />
      <FilterChips boardId={boardId} workspaceId={workspaceId} />
      {load === 'ready' ? (
        kind === 'kanban' ? (
          <Kanban boardId={boardId} workspaceId={workspaceId} />
        ) : kind === 'list' ? (
          <ListView boardId={boardId} workspaceId={workspaceId} />
        ) : (
          <Timeline boardId={boardId} workspaceId={workspaceId} />
        )
      ) : load === 'error' ? (
        <div className="grid flex-1 place-items-center">
          <Button variant="secondary" onClick={() => void ensureBoardTasks(boardId, true)}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      )}
    </>
  );
}

const SCOPES: ReadonlyArray<{ value: TaskScope; label: 'boards.scope.assigned' | 'boards.scope.lead' | 'boards.scope.created' | 'boards.scope.subscribed' }> = [
  { value: 'assigned', label: 'boards.scope.assigned' },
  { value: 'lead', label: 'boards.scope.lead' },
  { value: 'created', label: 'boards.scope.created' },
  { value: 'subscribed', label: 'boards.scope.subscribed' },
];

/** «Мои задачи» tabs: «Непрочитанное» (the badge's set) or a GET /me/tasks scope. */
type MyTab = 'unread' | TaskScope;

/**
 * «Мои задачи»: «Непрочитанное · N» first — every task that lights the badge, newest notice
 * first, each with why — then the GET /me/tasks scopes (grouped by board). «Непрочитанное» opens
 * by default while anything is unread, otherwise the remembered scope.
 */
function MyTasks({ workspaceId }: { workspaceId: string }): ReactNode {
  const scope = useBoardsUi((s) => s.myScope);
  const [tab, setTab] = useState<MyTab>(() => (unreadCount(useBoards.getState(), workspaceId) > 0 ? 'unread' : useBoardsUi.getState().myScope));
  const unread = useBoards((s) => unreadCount(s, workspaceId));
  const boards = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).filter((b) => hasBit(b.permissions, CREATE_TASKS)).map((b) => `${b.id}\u0000${b.emoji} ${b.name}`)));
  const mobile = useMobile();
  const onTab = useCallback((v: MyTab) => {
    setTab(v);
    if (v !== 'unread') useBoardsUi.getState().setMyScope(v);
  }, []);
  const tabs = useMemo(
    (): Array<{ value: MyTab; label: string }> => [{ value: 'unread', label: unread ? t('boards.unreadTabN', { n: unread }) : t('boards.unreadTab') }, ...SCOPES.map((s) => ({ value: s.value, label: t(s.label) }))],
    [unread],
  );
  return (
    <>
      <Bar plain className="gap-2 pl-4 pr-2" data-testid="my-tasks-header">
        {mobile ? <NavButton /> : null}
        <Inbox className="size-[18px] text-muted" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-headline font-semibold mobile:text-list">{t('boards.myTasks')}</h1>
        {boards.length ? (
          <Dropdown.Root modal={false}>
            <Dropdown.Trigger asChild>
              {mobile ? (
                <CreateButton label={t('boards.newTask')} tip={false} data-testid="my-new-task" />
              ) : (
                <Button aria-label={t('boards.newTask')} data-testid="my-new-task">
                  <Plus className="size-4" aria-hidden /> <span>{t('boards.task')}</span>
                </Button>
              )}
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className={cx(menuBox, 'w-56')} sideOffset={4} align="end">
                {boards.map((x) => {
                  const [id = '', label = ''] = x.split('\u0000');
                  return (
                    <Dropdown.Item key={id} className={menuItem} onSelect={() => useBoardsUi.getState().openCreate({ boardId: id })}>
                      {label}
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        ) : null}
      </Bar>
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto px-3 [scrollbar-width:none] mobile:overflow-visible" data-testid="my-tasks-tabs">
        <Choice phone="picker" testId="my-tasks-scope" value={tab} options={tabs} onChange={onTab} label={t('boards.myTasks')} />
        {tab === 'unread' ? null : (
          <>
            <span className="flex-1" />
            <MyCompletion />
          </>
        )}
      </div>
      {tab === 'unread' ? <UnreadList workspaceId={workspaceId} /> : <ScopeList workspaceId={workspaceId} scope={scope} />}
    </>
  );
}

function MyCompletion(): ReactNode {
  const value = useBoardsUi((s) => s.myCompletion);
  const onChange = useBoardsUi((s) => s.setMyCompletion);
  return <CompletionSwitch value={value} onChange={onChange} />;
}

const openFromList = (id: string, e: MouseEvent): void => {
  const ui = useBoardsUi.getState();
  if (e.metaKey || e.ctrlKey) {
    ui.toggleSelected(id);
    return;
  }
  ui.setFocused(id);
  ui.openTask(id);
};

/** A GET /me/tasks scope, grouped by board, with the completion filter. */
function ScopeList({ workspaceId, scope }: { workspaceId: string; scope: TaskScope }): ReactNode {
  const completion = useBoardsUi((s) => s.myCompletion);
  const open = completion === 'open';
  const entry = useTaskDetails((s) => s.mine[myTasksKey(workspaceId, scope, open)]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const creator = mayCreateBoards(useMemberRoles(workspaceId, me));
  const anyBoard = useBoards((s) => workspaceBoards(s.boards, workspaceId).length > 0);
  useEffect(() => {
    void loadMyTasks(workspaceId, scope, open);
  }, [workspaceId, scope, open]);
  // Group by board, boards in their order.
  const groups = useBoards(
    useShallow((s) => {
      const ids = entry?.ids ?? [];
      const out: string[] = [];
      for (const b of workspaceBoards(s.boards, workspaceId))
        for (const id of ids) {
          const x = s.tasks[id];
          if (x?.boardId === b.id && !x.archivedAt && taskShown(completion, x)) out.push(`${b.id}:${id}`);
        }
      return out;
    }),
  );
  const rows = useMemo(() => {
    const out: Array<{ board: string; ids: string[] }> = [];
    for (const g of groups) {
      const [b = '', id = ''] = g.split(':');
      const last = out[out.length - 1];
      if (last?.board === b) last.ids.push(id);
      else out.push({ board: b, ids: [id] });
    }
    return out;
  }, [groups]);
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="my-tasks-view">
      {entry?.loading && !groups.length ? (
        <div className="grid h-32 place-items-center">
          <Spinner />
        </div>
      ) : !groups.length ? (
        anyBoard ? (
          <EmptyBoard />
        ) : (
          <div className="flex flex-col items-center gap-3 p-10 text-center text-body text-muted">
            <SquareKanban className="size-10" strokeWidth={1.25} aria-hidden />
            <p>{creator ? t('boards.noBoardsAdmin') : t('boards.noBoards')}</p>
            {creator ? (
              <Button onClick={() => useBoardsUi.getState().openSettings({ boardId: '', workspaceId })}>
                <Plus className="size-4" aria-hidden /> {t('boards.newBoard')}
              </Button>
            ) : null}
          </div>
        )
      ) : (
        rows.map((g) => (
          <div key={g.board}>
            <MyTasksGroup boardId={g.board} n={g.ids.length} />
            {g.ids.map((id) => (
              <ListRow key={id} id={id} boardId={g.board} workspaceId={workspaceId} onClick={openFromList} selecting={false} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * «Непрочитанное»: exactly the badge's set (unreadOrdered over the same `unread` map), newest
 * notice first. Tasks READY named but the store lacks are fetched one by one. Opening a row opens
 * the task, which marks it seen (loadTask → PUT /read) — the row then leaves the list.
 */
function UnreadList({ workspaceId }: { workspaceId: string }): ReactNode {
  const ids = useBoards(useShallow((s) => unreadOrdered(s, workspaceId)));
  const missing = useBoards((s) => ids.some((id) => !s.tasks[id]));
  useEffect(() => {
    if (missing) void ensureUnreadTasks(workspaceId);
  }, [workspaceId, missing]);
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="unread-view">
      {ids.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-10 text-center text-body text-muted" data-testid="unread-empty">
          <CheckCheck className="size-10" strokeWidth={1.25} aria-hidden />
          <p>{t('boards.allRead')}</p>
        </div>
      ) : (
        <>
          {ids.map((id) => (
            <UnreadRow key={id} id={id} onClick={openFromList} />
          ))}
          {missing ? (
            <div className="grid h-12 place-items-center">
              <Spinner />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One unread task: key, title, why (the last notice) and the board. Primitive selectors only. */
const UnreadRow = memo(function UnreadRow({ id, onClick }: { id: string; onClick: (id: string, e: MouseEvent) => void }): ReactNode {
  const key = useBoards((s) => s.tasks[id]?.key ?? '');
  const title = useBoards((s) => s.tasks[id]?.title ?? '');
  const boardId = useBoards((s) => s.tasks[id]?.boardId ?? '');
  const board = useBoards((s) => (boardId ? `${s.boards[boardId]?.emoji || '📋'} ${s.boards[boardId]?.name ?? ''}` : ''));
  const reason = useBoards((s) => unreadReason(s, id));
  const active = useBoardsUi((s) => s.taskId === id);
  if (!key) return null;
  return (
    <button
      type="button"
      onClick={(e) => onClick(id, e)}
      className={cx('flex w-full min-w-0 items-start gap-3 border-b border-line px-4 py-2 text-left hover:bg-hover', active && 'bg-active')}
      data-testid="unread-row"
      data-task={id}
    >
      <span className="mt-[7px] size-2 shrink-0 rounded-full bg-accent" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2 text-control">
          <span className="shrink-0 tabular-nums text-muted">{key}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{title}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-caption text-muted">
          <span className="min-w-0 truncate text-fg" data-testid="unread-reason">
            {reason || t('boards.unread')}
          </span>
          <span aria-hidden>·</span>
          <span className="min-w-0 shrink-0 truncate">{board}</span>
        </span>
      </span>
    </button>
  );
});

function MyTasksGroup({ boardId, n }: { boardId: string; n: number }): ReactNode {
  const name = useBoards((s) => s.boards[boardId]?.name ?? '');
  const emoji = useBoards((s) => s.boards[boardId]?.emoji ?? '');
  return (
    <div className="sticky top-0 z-[1] flex h-9 items-center gap-2 border-b border-line bg-[var(--color-bg)] px-4 text-control font-semibold">
      <span aria-hidden>{emoji || '📋'}</span> {name}
      <span className="text-caption font-normal tabular-nums text-muted">{n}</span>
    </div>
  );
}
