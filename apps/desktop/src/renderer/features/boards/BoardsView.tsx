import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Inbox, Plus, SquareKanban } from 'lucide-react';
import { useCallback, useEffect, useMemo, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Segmented, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayCreateBoards } from '../../lib/permissions';
import { ensureBoardTasks, loadBoard, loadMyTasks, useTaskDetails } from '../../services/boards';
import type { TaskScope } from '../../services/boardsApi';
import { boardLayout } from '../../lib/boards/categories';
import { useBoards, workspaceBoards, workspaceCategories } from '../../stores/boards';
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
        {boardId === MY_TASKS ? <MyTasks workspaceId={workspaceId} /> : <Board boardId={boardId} workspaceId={workspaceId} />}
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

/** «Мои задачи» (GET /me/tasks): open tasks of every board by scope, grouped by board. */
function MyTasks({ workspaceId }: { workspaceId: string }): ReactNode {
  const scope = useBoardsUi((s) => s.myScope);
  const setScope = useBoardsUi((s) => s.setMyScope);
  const key = `${workspaceId}|${scope}`;
  const entry = useTaskDetails((s) => s.mine[key]);
  const boards = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).filter((b) => hasBit(b.permissions, CREATE_TASKS)).map((b) => `${b.id}\u0000${b.emoji} ${b.name}`)));
  const me = useSession((s) => s.me?.user?.id ?? '');
  const creator = mayCreateBoards(useMemberRoles(workspaceId, me));
  const anyBoard = useBoards((s) => workspaceBoards(s.boards, workspaceId).length > 0);
  const mobile = useMobile();
  useEffect(() => {
    void loadMyTasks(workspaceId, scope);
  }, [workspaceId, scope]);
  // Group by board, boards in their order.
  const groups = useBoards(
    useShallow((s) => {
      const ids = entry?.ids ?? [];
      const out: string[] = [];
      for (const b of workspaceBoards(s.boards, workspaceId)) for (const id of ids) if (s.tasks[id]?.boardId === b.id && !s.tasks[id].archivedAt) out.push(`${b.id}:${id}`);
      return out;
    }),
  );
  const onClick = useCallback((id: string, e: MouseEvent) => {
    const ui = useBoardsUi.getState();
    if (e.metaKey || e.ctrlKey) {
      ui.toggleSelected(id);
      return;
    }
    ui.setFocused(id);
    ui.openTask(id);
  }, []);
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
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2 mobile:gap-1 mobile:pl-0.5" data-testid="my-tasks-header">
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
      </header>
      <div className="flex h-10 shrink-0 items-center px-3">
        <Segmented value={scope} options={SCOPES.map((s) => ({ value: s.value, label: t(s.label) }))} onChange={setScope} label={t('boards.myTasks')} />
      </div>
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
                <ListRow key={id} id={id} boardId={g.board} workspaceId={workspaceId} onClick={onClick} selecting={false} />
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

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
