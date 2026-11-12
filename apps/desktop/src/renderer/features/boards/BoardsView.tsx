import * as Dropdown from '../../components/radix/dropdown-menu';
import { ArrowDownUp, Check, CheckCheck, History, Inbox, ListFilter, Plus, SquareKanban } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Task } from '@calaba/protocol';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { Choice } from '../../components/Choice';
import { t } from '../../i18n';
import { mayCreateBoards } from '../../lib/permissions';
import { ensureBoardTasks, ensureUnreadTasks, loadBoard, loadMyTasks, loadRecent, myTasksKey, unreadReason, useTaskDetails } from '../../services/boards';
import type { TaskScope } from '../../services/boardsApi';
import { boardLayout } from '../../lib/boards/categories';
import { recentIds, unreadCount, unreadOrdered, useBoards, workspaceBoards, workspaceCategories } from '../../stores/boards';
import { taskShown } from '../../lib/boards/completion';
import { MY_DUES, MY_SORTS, EMPTY_MY_FILTER, matchMine, myFilterCount, sortMine, type MyDue, type MyFilter } from '../../lib/boards/myTasks';
import { CountBadge } from './FilterBar';
import { PRIORITIES, PRIORITY_LABEL, PriorityIcon } from './visuals';
import { useToday } from './menus';
import { CompletionSwitch } from './CompletionSwitch';
import { BoardSearchResults, TaskSearchPage } from './TaskSearch';
import { useTaskSearch } from '../../stores/taskSearch';
import { MY_TASKS, useBoardsUi } from '../../stores/boardsUi';
import { useSession } from '../../stores/session';
import { useMemberRoles } from '../../stores/workspaces';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { BoardArchive } from './BoardArchive';
import { BoardHeader } from './BoardHeader';
import { BoardSettingsHost } from './BoardSettings';
import { FilterChips } from './FilterBar';
import { HotkeysSheet } from './HotkeysSheet';
import { Kanban } from './Kanban';
import { EmptyBoard, ListRow, ListView } from './ListView';
import { doneType, hasBit, CREATE_TASKS } from './model';
import { TaskPanel } from './TaskPanel';
import { useTaskTabs } from '../../stores/taskTabs';
import { TaskView } from './TaskView';
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
 * timeline) or «Мои задачи», the create / settings dialogs and the «?» sheet. Keys: hotkeys.ts.
 * The open task (owner 14.10, Linear) covers the whole area on the desktop (TaskView) with the
 * board kept mounted underneath — hidden and inert, its scrolls, groups and selection intact, so
 * Esc returns to it as it was; on the phone it is a pushed full-screen page (TaskPanel).
 */
export function BoardsView({ workspaceId, mobile = false }: { workspaceId: string; mobile?: boolean }): ReactNode {
  const boardId = useActiveBoard(workspaceId);
  const taskId = useBoardsUi((s) => s.taskId);
  const phone = useMobile() || mobile;
  const covered = !!taskId && !phone;
  const board = useRef<HTMLElement>(null);
  useBoardHotkeys(workspaceId, boardId);
  // The title-bar tabs highlight the open task only while this section is the one on screen.
  useEffect(() => {
    if (phone) return;
    useTaskTabs.getState().setShown(true);
    return () => useTaskTabs.getState().setShown(false);
  }, [phone]);
  useEffect(() => {
    if (boardId === MY_TASKS) return;
    void ensureBoardTasks(boardId);
    void loadBoard(boardId);
  }, [boardId]);
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="boards-view">
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/* `invisible` keeps the layout (and so every scroll offset) but paints nothing under the task. */}
        <section ref={board} className={cx('mat-content flex min-w-0 flex-1 flex-col', covered && 'invisible')} aria-label={t('boards.boards')} inert={covered} aria-hidden={covered || undefined} data-toast-anchor>
          {boardId === MY_TASKS ? <MyTasks key={workspaceId} workspaceId={workspaceId} /> : <Board boardId={boardId} workspaceId={workspaceId} />}
        </section>
        {taskId ? phone ? <TaskPanel taskId={taskId} /> : <TaskView taskId={taskId} boardId={boardId} workspaceId={workspaceId} boardRef={board} /> : null}
        <BoardSettingsHost />
        <HotkeysSheet />
      </div>
    </div>
  );
}

function Board({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const kind = useViewKind(boardId);
  const load = useBoards((s) => s.load[boardId]);
  const archive = useBoardsUi((s) => s.archiveOf === boardId);
  // Text in the board's search field: the search over the board instead of the view (ADR-0139).
  const searching = useTaskSearch((s) => !!s.boardText[boardId]?.trim());
  if (archive) return <BoardArchive boardId={boardId} />;
  return (
    <>
      <BoardHeader boardId={boardId} workspaceId={workspaceId} />
      <FilterChips boardId={boardId} workspaceId={workspaceId} />
      {searching ? (
        <BoardSearchResults boardId={boardId} workspaceId={workspaceId} />
      ) : load === 'ready' ? (
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

/**
 * «Мои задачи» tabs: «Непрочитанное» (the badge's set), «Недавние» (the last tasks I got a notice
 * about, CBF-179), a GET /me/tasks scope or «Все задачи» (search over every board).
 */
type MyTab = 'unread' | 'recent' | 'all' | TaskScope;

/**
 * «Мои задачи»: «Непрочитанное · N» first — every task that lights the badge, newest notice
 * first, each with why — «Недавние» next (read ones too), then the GET /me/tasks scopes (grouped by board). «Непрочитанное» opens
 * by default while anything is unread, otherwise the remembered scope. «Все задачи» last: a search
 * over every board the caller sees (CBF-35).
 */
function MyTasks({ workspaceId }: { workspaceId: string }): ReactNode {
  const scope = useBoardsUi((s) => s.myScope);
  const [tab, setTab] = useState<MyTab>(() => (useTaskSearch.getState().wantPage ? 'all' : unreadCount(useBoards.getState(), workspaceId) > 0 ? 'unread' : useBoardsUi.getState().myScope));
  // A saved search or ⌘↩ in ⌘K «Задачи» opens the search tab (ADR-0139).
  const wantPage = useTaskSearch((s) => s.wantPage);
  useEffect(() => {
    if (!wantPage) return;
    // An outside request (a saved search, ⌘↩) switches the local tab once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab('all');
    useTaskSearch.getState().setWantPage(false);
  }, [wantPage]);
  const unread = useBoards((s) => unreadCount(s, workspaceId));
  // The server's latest notice per task: «Недавние» and the reasons of «Непрочитанное» after a reload.
  useEffect(() => {
    void loadRecent(workspaceId);
  }, [workspaceId]);
  const boards = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).filter((b) => hasBit(b.permissions, CREATE_TASKS)).map((b) => `${b.id}\u0000${b.emoji} ${b.name}`)));
  const mobile = useMobile();
  const onTab = useCallback((v: MyTab) => {
    setTab(v);
    if (v !== 'unread' && v !== 'recent' && v !== 'all') useBoardsUi.getState().setMyScope(v);
    if (v !== 'all') useTaskSearch.getState().setActiveSaved(workspaceId, '');
  }, [workspaceId]);
  const tabs = useMemo(
    (): Array<{ value: MyTab; label: string }> => [
      { value: 'unread', label: unread ? t('boards.unreadTabN', { n: unread }) : t('boards.unreadTab') },
      { value: 'recent', label: t('boards.recentTab') },
      ...SCOPES.map((s) => ({ value: s.value, label: t(s.label) })), { value: 'all', label: t('ts.tabSearch') }],
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
        {tab === 'unread' || tab === 'recent' || tab === 'all' ? null : (
          <>
            <span className="flex-1" />
            <MyFilterMenu workspaceId={workspaceId} />
            <MySortMenu />
            <MyCompletion />
          </>
        )}
      </div>
      {tab === 'unread' ? <UnreadList workspaceId={workspaceId} /> : tab === 'recent' ? <RecentList workspaceId={workspaceId} /> : tab === 'all' ? <TaskSearchPage workspaceId={workspaceId} /> : <ScopeList workspaceId={workspaceId} scope={scope} />}
    </>
  );
}

const MY_SORT_LABEL = { created: 'boards.my.sortCreated', updated: 'boards.my.sortUpdated', due: 'boards.my.sortDue', priority: 'boards.my.sortPriority' } as const;
const MY_DUE_LABEL = { overdue: 'boards.date.overdue', dated: 'boards.my.dated' } as const;
const toggleIn = <T,>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** A menu row with a trailing check; `keep` leaves the menu open (multi-choice). */
function CheckItem({ checked, onSelect, keep, testId, children }: { checked: boolean; onSelect: () => void; keep?: boolean; testId?: string; children: ReactNode }): ReactNode {
  return (
    <Dropdown.Item
      className={menuItem}
      onSelect={(e) => {
        if (keep) e.preventDefault();
        onSelect();
      }}
      data-testid={testId}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {checked ? <Check className="size-4 shrink-0" aria-hidden /> : null}
    </Dropdown.Item>
  );
}

/** «Мои задачи» sort (default: newest first) and «Группировать по доскам». */
function MySortMenu(): ReactNode {
  const sort = useBoardsUi((s) => s.mySort);
  const group = useBoardsUi((s) => s.myGroup);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton size="sm" label={t('boards.sortBy')} active={sort !== 'created' || group} className="data-[state=open]:bg-active" data-testid="my-sort">
          <ArrowDownUp className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="end">
          {MY_SORTS.map((v) => (
            <CheckItem key={v} checked={sort === v} onSelect={() => useBoardsUi.getState().setMySort(v)} testId={`my-sort-${v}`}>
              {t(MY_SORT_LABEL[v])}
            </CheckItem>
          ))}
          <Dropdown.Separator className={menuSeparator} />
          <CheckItem checked={group} keep onSelect={() => useBoardsUi.getState().setMyGroup(!group)} testId="my-group">
            {t('boards.my.groupByBoard')}
          </CheckItem>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** «Мои задачи» light filter: priority, due, board — a checked menu with the count badge. */
function MyFilterMenu({ workspaceId }: { workspaceId: string }): ReactNode {
  const priorities = useBoardsUi((s) => s.myFilter.priorities);
  const due = useBoardsUi((s) => s.myFilter.due);
  const boardIds = useBoardsUi((s) => s.myFilter.boards);
  const boards = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).map((b) => `${b.id}\u0000${b.emoji || '📋'} ${b.name}`)));
  const count = myFilterCount({ priorities, due, boards: boardIds });
  const set = (p: Partial<MyFilter>): void => {
    const ui = useBoardsUi.getState();
    ui.setMyFilter({ ...ui.myFilter, ...p });
  };
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton size="sm" label={t('boards.filter')} className="relative data-[state=open]:bg-active" data-testid="my-filter">
          <ListFilter className="size-4" aria-hidden />
          <CountBadge n={count} />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'max-h-[min(70vh,28rem)] w-60 overflow-y-auto')} sideOffset={4} align="end" data-testid="my-filter-menu">
          <div className={menuLabel}>{t('boards.f.priority')}</div>
          {PRIORITIES.map((p) => (
            <CheckItem key={p} checked={priorities.includes(p)} keep onSelect={() => set({ priorities: toggleIn(priorities, p) })} testId={`my-filter-prio-${p}`}>
              <PriorityIcon priority={p} />
              {t(PRIORITY_LABEL[p] ?? 'boards.prio.none')}
            </CheckItem>
          ))}
          <Dropdown.Separator className={menuSeparator} />
          <div className={menuLabel}>{t('boards.my.filterDue')}</div>
          {MY_DUES.filter((v): v is Exclude<MyDue, 'any'> => v !== 'any').map((v) => (
            <CheckItem key={v} checked={due === v} keep onSelect={() => set({ due: due === v ? 'any' : v })} testId={`my-filter-due-${v}`}>
              {t(MY_DUE_LABEL[v])}
            </CheckItem>
          ))}
          {boards.length > 1 ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              <div className={menuLabel}>{t('boards.my.filterBoards')}</div>
              {boards.map((x) => {
                const [id = '', label = ''] = x.split('\u0000');
                return (
                  <CheckItem key={id} checked={boardIds.includes(id)} keep onSelect={() => set({ boards: toggleIn(boardIds, id) })}>
                    {label}
                  </CheckItem>
                );
              })}
            </>
          ) : null}
          {count ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().setMyFilter(EMPTY_MY_FILTER)} data-testid="my-filter-reset">
                {t('boards.my.resetFilter')}
              </Dropdown.Item>
            </>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
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
  // From «Все задачи» the crumbs start with the query (#89): read off the field, the list owns it.
  const q = document.querySelector<HTMLInputElement>('[data-testid=all-tasks-search]')?.value.trim() ?? '';
  ui.openTask(id, q);
};

/** A GET /me/tasks scope, grouped by board, with the completion filter. */
function ScopeList({ workspaceId, scope }: { workspaceId: string; scope: TaskScope }): ReactNode {
  const completion = useBoardsUi((s) => s.myCompletion);
  const open = completion === 'open';
  const sort = useBoardsUi((s) => s.mySort);
  const group = useBoardsUi((s) => s.myGroup);
  const fPriorities = useBoardsUi((s) => s.myFilter.priorities);
  const fDue = useBoardsUi((s) => s.myFilter.due);
  const fBoards = useBoardsUi((s) => s.myFilter.boards);
  const today = useToday();
  const entry = useTaskDetails((s) => s.mine[myTasksKey(workspaceId, scope, open)]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const creator = mayCreateBoards(useMemberRoles(workspaceId, me));
  const anyBoard = useBoards((s) => workspaceBoards(s.boards, workspaceId).length > 0);
  useEffect(() => {
    void loadMyTasks(workspaceId, scope, open);
  }, [workspaceId, scope, open]);
  // Filter, then sort (newest first by default). Grouped: boards in their order, the sort inside a
  // board; flat: one global order. Primitives out: «boardId:taskId».
  const groups = useBoards(
    useShallow((s) => {
      const ids = entry?.ids ?? [];
      const filter: MyFilter = { priorities: fPriorities, due: fDue, boards: fBoards };
      const all: Task[] = [];
      const out: string[] = [];
      for (const b of workspaceBoards(s.boards, workspaceId)) {
        const list: Task[] = [];
        for (const id of ids) {
          const x = s.tasks[id];
          if (x?.boardId !== b.id || x.archivedAt || !taskShown(completion, x)) continue;
          if (matchMine(x, filter, today, doneType(b.statuses.find((y) => y.id === x.statusId)?.type))) list.push(x);
        }
        if (group) for (const x of sortMine(list, sort)) out.push(`${b.id}:${x.id}`);
        else all.push(...list);
      }
      return group ? out : sortMine(all, sort).map((x) => `${x.boardId}:${x.id}`);
    }),
  );
  // Flat list: each row carries its board («emoji name»), a primitive per row.
  const names = useBoards(useShallow((s) => (group ? [] : workspaceBoards(s.boards, workspaceId).map((b) => `${b.id}\u0000${b.emoji || '📋'} ${b.name}`))));
  const nameOf = useMemo(() => new Map(names.map((x) => x.split('\u0000') as [string, string])), [names]);
  const rows = useMemo(() => {
    const out: Array<{ board: string; ids: string[] }> = [];
    for (const g of groups) {
      const [b = '', id = ''] = g.split(':');
      const last = out[out.length - 1];
      if (group && last?.board === b) last.ids.push(id);
      else out.push({ board: b, ids: [id] });
    }
    return out;
  }, [groups, group]);
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
        group ? (
          rows.map((g) => (
            <div key={g.board}>
              <MyTasksGroup boardId={g.board} n={g.ids.length} />
              {g.ids.map((id) => (
                <ListRow key={id} id={id} boardId={g.board} workspaceId={workspaceId} onClick={openFromList} selecting={false} />
              ))}
            </div>
          ))
        ) : (
          rows.map((g) => <ListRow key={g.ids[0]} id={g.ids[0] ?? ''} boardId={g.board} boardLabel={nameOf.get(g.board)} workspaceId={workspaceId} onClick={openFromList} selecting={false} />)
        )
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
            <NoticeRow key={id} id={id} onClick={openFromList} />
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

/**
 * «Недавние» (CBF-179): the last tasks I got a notice about, latest notice first, one row per task;
 * read ones stay (without the dot). The server's list (loadRecent), kept current by live notices.
 */
function RecentList({ workspaceId }: { workspaceId: string }): ReactNode {
  const ids = useBoards((s) => recentIds(s, workspaceId));
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="recent-view">
      {ids === null ? (
        <div className="grid h-24 place-items-center">
          <Spinner />
        </div>
      ) : ids.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-10 text-center text-body text-muted" data-testid="recent-empty">
          <History className="size-10" strokeWidth={1.25} aria-hidden />
          <p>{t('boards.recentEmpty')}</p>
        </div>
      ) : (
        ids.map((id) => <NoticeRow key={id} id={id} onClick={openFromList} />)
      )}
    </div>
  );
}

/**
 * One task of «Непрочитанное» / «Недавние»: the unread dot, key, title, why (the last notice) and
 * the board. The task from the store, else as «Недавние» named it. Primitive selectors only.
 */
const NoticeRow = memo(function NoticeRow({ id, onClick }: { id: string; onClick: (id: string, e: MouseEvent) => void }): ReactNode {
  const key = useBoards((s) => s.tasks[id]?.key ?? s.recentRefs[id]?.key ?? '');
  const title = useBoards((s) => s.tasks[id]?.title ?? s.recentRefs[id]?.title ?? '');
  const boardId = useBoards((s) => s.tasks[id]?.boardId ?? s.recentRefs[id]?.boardId ?? '');
  const board = useBoards((s) => (boardId ? `${s.boards[boardId]?.emoji || '📋'} ${s.boards[boardId]?.name ?? ''}` : ''));
  const reason = useBoards((s) => unreadReason(s, id));
  const unread = useBoards((s) => !!s.unread[id]);
  const active = useBoardsUi((s) => s.taskId === id);
  if (!key) return null;
  return (
    <button
      type="button"
      onClick={(e) => onClick(id, e)}
      className={cx('flex w-full min-w-0 items-start gap-3 border-b border-line px-4 py-2 text-left hover:bg-hover', active && 'bg-active')}
      data-testid="unread-row"
      data-task={id}
      data-unread={unread || undefined}
    >
      <span className={cx('mt-[7px] size-2 shrink-0 rounded-full', unread && 'bg-accent')} aria-hidden />
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
