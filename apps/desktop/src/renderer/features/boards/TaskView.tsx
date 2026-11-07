import * as Dropdown from '../../components/radix/dropdown-menu';
import { BoardFeature, type Task } from '@calaba/protocol';
import { ArrowDown, Bell, BellOff, ChevronDown, ChevronRight, ChevronUp, Hash, Inbox, Link2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bar } from '../../components/Bar';
import { ResizeHandle } from '../../components/ResizeHandle';
import { CloseButton, IconButton, Spinner, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { featureOn } from '../../lib/boards/features';
import { loadPresent } from '../../services/chat';
import { replaceNextNav } from '../../services/navHistory';
import { copyTaskKey, copyTaskLink, loadTask, moveTaskToBoard, openBoard, setSubscription, useTaskDetails } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { useMessages } from '../../stores/messages';
import { MY_TASKS, PROPS_DEFAULT, PROPS_MAX, PROPS_MIN, prefsOf, useBoardsUi } from '../../stores/boardsUi';
import { useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { menuBox, menuItem } from '../shell/menu';
import { Checklists } from './Checklists';
import { GitSection } from './GitLinks';
import { MemberAvatar } from './menus';
import { hasBit, mayEditTask, CREATE_TASKS, MANAGE_BOARD } from './model';
import { Activity, ArchivedBanner, CommentBox, DescriptionEditor, Prop, Properties, Relations, Subtasks, TaskMoreMenu, TitleEditor, lacksFiles, useMoveTargets, useRefetchLostFiles, valueBtn } from './TaskPanel';
import { TaskDates } from './TaskDates';
import { TaskMilestones } from './TaskMilestones';
import { boardOrder, keepOrder, positionOf, stepTask, taskNav } from './taskOrder';
import { useDisabledFeatures, useMatchCtx, useViewKind } from './useBoardView';
import { useBoardScoped, useTaskPerms } from './useTaskPerms';
import { WatchersSection } from './Watchers';

/**
 * The task on the desktop (owner 14.10, «как в Linear»; docs/08 «Доски задач»): the whole board
 * area, the board kept mounted (inert, hidden) underneath, so Esc brings it back exactly as it was —
 * scroll, filters, groups, selection. Bar: crumbs, subscribe, ⋯ and «3 / 24 ↓ ↑» (J/K) through the
 * order of the view the task came from (taskOrder.ts). Body: the content column (title,
 * description, subtasks, checklists, activity, composer) and the properties column on the right.
 */
/** Tasks fetched in full this session, and the scroll of each card left (tabs return to where they were). */
const loaded = new Set<string>();
const scrolls = new Map<string, number>();

/** The main column never gets narrower than this (px); keep in sync with the aside's max-w. */
const MAIN_MIN = 480;

/** J/K (and the header's next / previous buttons): the next task replaces the open one in the ‹ › history (board #113). */
function stepTo(id: string): void {
  replaceNextNav();
  useBoardsUi.getState().openTask(id);
}

export function TaskView({ taskId, boardId, workspaceId, boardRef }: { taskId: string; boardId: string; workspaceId: string; boardRef: RefObject<HTMLElement | null> }): ReactNode {
  const task = useBoards((s) => s.tasks[taskId]);
  const root = useRef<HTMLElement>(null);
  const order = useOrder(boardId, workspaceId, taskId);
  useRefetchLostFiles(taskId, lacksFiles(task));
  useEffect(() => {
    // A task already loaded in this session (switching tabs, ↑/↓ back) is not fetched again: it is
    // live through the gateway, so the card does not blink; an unread one is fetched to mark it read,
    // a light one (its files dropped by a board list since, CBF-160) to show them.
    const cur = useBoards.getState().tasks[taskId];
    if (!loaded.has(taskId) || cur?.unread || lacksFiles(cur)) {
      loaded.add(taskId);
      void loadTask(taskId);
    }
    // The board's focus follows the task (Linear): back on the board, the last one seen is marked.
    useBoardsUi.getState().setFocused(taskId);
  }, [taskId]);
  // ↑/↓ and J/K come through the board keys (useBoardHotkeys) — one listener; this is its handle.
  const latest = useRef({ order, taskId });
  useEffect(() => {
    latest.current = { order, taskId };
  });
  useEffect(() => {
    taskNav.set({
      step: (dir) => {
        const next = stepTask(latest.current.order, latest.current.taskId, dir);
        if (next) stepTo(next);
      },
      contains: (el) => !!el && !!root.current?.contains(el),
    });
    return () => taskNav.set(null);
  }, []);
  // Focus: into the view on open (the board under it is inert); back where it was on close.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    const board = boardRef.current;
    root.current?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        const focused = useBoardsUi.getState().focused;
        if (opener && opener !== document.body && opener.isConnected && board?.contains(opener)) opener.focus({ preventScroll: true });
        else if (document.activeElement instanceof HTMLElement && !document.activeElement.isConnected) document.activeElement.blur();
        if (focused) board?.querySelector(`[data-task="${CSS.escape(focused)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
  }, [boardRef, opener]);
  return (
    <section ref={root} tabIndex={-1} className="mat-content absolute inset-0 z-[var(--z-sticky)] flex min-w-0 flex-col outline-none" aria-label={task ? `${task.key} ${task.title}` : t('boards.task')} data-testid="task-panel" data-view="full">
      {task ? (
        <>
          <TaskBar task={task} boardId={boardId} workspaceId={workspaceId} order={order} />
          <ArchivedBanner task={task} />
          <TaskBody task={task} />
        </>
      ) : (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      )}
    </section>
  );
}

/**
 * The order of the view under the task, recomputed when its inputs change (prefs, view kind, the
 * board's columns) or the task does — not on every store change. «Мои задачи» is read off its rows.
 */
function useOrder(boardId: string, workspaceId: string, taskId: string): readonly string[] {
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const kind = useViewKind(boardId);
  const ctx = useMatchCtx(boardId);
  const board = useBoards((s) => s.boards[boardId]);
  const columns = useBoards((s) => s.columns[boardId]);
  const fresh = useMemo(
    () => {
      if (boardId === MY_TASKS) return myTasksOrder();
      return board ? boardOrder(useBoards.getState(), board, prefs, kind, ctx, workspaceId) : [];
    },
    // `columns` and `taskId` stand for what is read through getState() / the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, board, columns, prefs, kind, ctx, workspaceId, taskId],
  );
  const [kept, setKept] = useState<{ fresh: readonly string[]; order: readonly string[] }>({ fresh, order: fresh });
  if (kept.fresh !== fresh) setKept({ fresh, order: keepOrder(kept.order, fresh, taskId) });
  return kept.fresh === fresh ? kept.order : keepOrder(kept.order, fresh, taskId);
}

/** «Мои задачи» rows (scopes, «Непрочитанное», «Все задачи»): short, unvirtualised, so the DOM is the order. */
function myTasksOrder(): string[] {
  const ids = [...document.querySelectorAll<HTMLElement>('[data-testid=boards-view] :is([data-testid=my-tasks-view], [data-testid=unread-view], [data-testid=all-tasks-view]) [data-task]')].map((n) => n.dataset.task ?? '');
  return [...new Set(ids.filter(Boolean))];
}

// ------------------------------------------------------------------ bar

const TaskBar = memo(function TaskBar({ task, boardId, workspaceId, order }: { task: Task; boardId: string; workspaceId: string; order: readonly string[] }): ReactNode {
  const perms = useTaskPerms(task);
  const scoped = useBoardScoped(task.boardId);
  const emoji = useBoards((s) => s.boards[task.boardId]?.emoji ?? '');
  const name = useBoards((s) => s.boards[task.boardId]?.name ?? '');
  const parentKey = useBoards((s) => (task.parentId ? (s.tasks[task.parentId]?.key ?? '') : ''));
  const subscribed = task.subscribed && !task.muted;
  const pos = positionOf(order, task.id);
  const prev = stepTask(order, task.id, -1);
  const next = stepTask(order, task.id, 1);
  // The board crumb: back to the board under the view; from «Мои задачи» — to the task's board.
  const toBoard = useCallback(() => {
    if (boardId === task.boardId) useBoardsUi.getState().openTask(null);
    else openBoard(workspaceId, task.boardId);
  }, [boardId, task.boardId, workspaceId]);
  const crumbBase = 'whitespace-nowrap rounded-[var(--radius-icon)] px-1.5 py-1 text-control hover:bg-hover';
  const crumb = cx(crumbBase, 'shrink-0');
  // Opened from «Мои задачи» (#89): the path starts there — «Мои задачи › поиск «…»» — and leads back to it.
  const fromMine = boardId === MY_TASKS;
  const searchFrom = useBoardsUi((s) => s.searchFrom);
  const toList = useCallback(() => useBoardsUi.getState().openTask(null), []);
  return (
    <Bar plain className="gap-1 pl-3 pr-2" data-testid="task-panel-header">
      {fromMine ? (
        <>
          <button type="button" onClick={toList} className={cx(crumb, 'flex items-center gap-1.5 text-muted hover:text-fg')} title={t('boards.crumb.back')} data-testid="panel-crumb-mine">
            <Inbox className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{t('boards.myTasks')}</span>
          </button>
          {searchFrom ? (
            <>
              <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
              <button type="button" onClick={toList} className={cx(crumbBase, 'min-w-0 max-w-[160px] shrink truncate text-muted hover:text-fg')} title={t('boards.crumb.back')} data-testid="panel-crumb-search">
                {t('boards.crumb.search', { q: searchFrom })}
              </button>
            </>
          ) : null}
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
        </>
      ) : null}
      <button type="button" onClick={toBoard} className={cx(crumb, 'flex min-w-0 items-center gap-1.5 text-muted hover:text-fg', searchFrom ? 'max-w-[96px]' : 'max-w-[30%]')} data-testid="panel-crumb-board">
        <span aria-hidden>{emoji || '📋'}</span>
        <span className="truncate">{name}</span>
      </button>
      {task.parentId && parentKey ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
          <button type="button" onClick={() => useBoardsUi.getState().openTask(task.parentId)} className={cx(crumb, 'tabular-nums text-muted hover:text-fg')} data-testid="panel-crumb-parent">
            {parentKey}
          </button>
        </>
      ) : null}
      <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
      <button type="button" onClick={() => copyTaskLink(task.key)} className={cx(crumb, 'font-medium tabular-nums text-fg')} title={t('boards.copyLink')} data-testid="panel-key">
        {task.key}
      </button>
      {/* The long search path takes the room; the title is right below in the card anyway. */}
      {searchFrom ? null : (
        <span className="min-w-0 shrink-[3] truncate px-1 text-control text-muted" data-testid="panel-title">
          {task.title}
        </span>
      )}
      <IconButton label={subscribed ? t('boards.unsubscribe') : t('boards.subscribe')} active={subscribed} onClick={() => void setSubscription(task.id, subscribed)} data-testid="panel-subscribe">
        {subscribed ? <Bell className="size-4" aria-hidden /> : <BellOff className="size-4" aria-hidden />}
      </IconButton>
      <TaskMoreMenu task={task} perms={perms} scoped={scoped} />
      <span className="min-w-0 flex-1" />
      {pos && !searchFrom ? (
        <span className="shrink-0 px-1.5 text-caption tabular-nums text-muted" aria-label={t('boards.taskPos', { n: pos.n, total: pos.total })} data-testid="task-position">
          {pos.n} / {pos.total}
        </span>
      ) : null}
      <IconButton label={t('boards.nextTask')} shortcut="J" disabled={!next} onClick={() => next && stepTo(next)} data-testid="task-next">
        <ChevronDown className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('boards.prevTask')} shortcut="K" disabled={!prev} onClick={() => prev && stepTo(prev)} data-testid="task-prev">
        <ChevronUp className="size-4" aria-hidden />
      </IconButton>
      <CloseButton onClick={toList} data-testid="task-close" />
    </Bar>
  );
});

// ------------------------------------------------------------------ body

const TaskBody = memo(function TaskBody({ task }: { task: Task }): ReactNode {
  const perms = useTaskPerms(task);
  const scoped = useBoardScoped(task.boardId);
  const subtasks = useTaskDetails((s) => s.byTask[task.id]?.subtasks);
  const related = useTaskDetails((s) => s.byTask[task.id]?.related);
  const room = useRooms((s) => (task.roomId ? s.byId[task.roomId] : undefined));
  const canEdit = mayEditTask(task, perms, myUserId());
  // Board features (ADR-0058 §3): a disabled feature's fields and sections are hidden, data kept.
  const disabled = useDisabledFeatures(task.boardId);
  const on = (f: BoardFeature): boolean => featureOn(disabled, f);
  const scroller = useRef<HTMLDivElement>(null);
  const toEnd = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  // Another task (↑/↓, a subtask, a tab): where that card was left, else its top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrolls.get(task.id) ?? 0;
  }, [task.id]);
  const commentsOff = !on(BoardFeature.COMMENTS);
  const propsWidth = useBoardsUi((s) => s.propsWidth);
  const root = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLElement>(null);
  return (
    <div ref={root} className="flex min-h-0 flex-1">
      {/* Main column: the content scrolls, the composer stays pinned under it (as in the side panel). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scroller} onScroll={(e) => scrolls.set(task.id, e.currentTarget.scrollTop)} className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="task-scroll">
          <div className="px-6 pb-10 pt-8 min-[1200px]:px-12">
            <div className="mx-auto flex max-w-[760px] flex-col gap-5">
              <TitleEditor task={task} canEdit={canEdit} large />
              <TaskDates id={task.id} />
              <DescriptionEditor task={task} canEdit={canEdit} attachments={on(BoardFeature.ATTACHMENTS)} />
              {on(BoardFeature.GIT_LINKS) ? <GitSection taskId={task.id} /> : null}
              {on(BoardFeature.SUBTASKS) ? <Subtasks task={task} ids={subtasks ?? NONE} canCreate={hasBit(perms, CREATE_TASKS) && !scoped} /> : null}
              {on(BoardFeature.CHECKLISTS) ? <Checklists taskId={task.id} workspaceId={task.workspaceId} canEdit={canEdit} subtasks={on(BoardFeature.SUBTASKS) && !task.parentId} /> : null}
              {on(BoardFeature.MILESTONES) && !task.parentId ? <TaskMilestones taskId={task.id} canEdit={canEdit} /> : null}
              {on(BoardFeature.RELATIONS) ? <Relations task={task} ids={related ?? NONE} canEdit={canEdit} /> : null}
              {room ? (
                <Activity task={task} room={room} toEnd={toEnd} commentsOff={commentsOff} aside={<ActivityAside task={task} />} />
              ) : (
                <div className="grid h-16 place-items-center">
                  <Spinner />
                </div>
              )}
            </div>
          </div>
        </div>
        {room ? (
          <div className="relative shrink-0 px-6 pb-3 min-[1200px]:px-12" data-testid="task-composer-dock">
            {/* A short fade so the text does not end on a hard edge above the composer (no backdrop-filter: docs/08). */}
            <span className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-[var(--color-bg)] to-transparent" aria-hidden />
            {task.roomId ? <JumpToLatest scroller={scroller} roomId={task.roomId} toEnd={toEnd} /> : null}
            <div className="mx-auto max-w-[760px]">
              <CommentBox key={room.id} task={task} room={room} perms={perms} commentsOff={commentsOff} autoFocus={false} className="" />
            </div>
          </div>
        ) : null}
      </div>
      {/* The handle's line is the column border. While dragging only the column's style is written;
          the store (and the persisted value) is set on release. */}
      <ResizeHandle
        edge="left"
        width={() => useBoardsUi.getState().propsWidth}
        min={PROPS_MIN}
        max={() => Math.min(PROPS_MAX, Math.max(PROPS_MIN, (root.current?.clientWidth ?? Infinity) - MAIN_MIN))}
        label={t('boards.propsResize')}
        onChange={(w, final) => {
          if (column.current) column.current.style.width = `${w}px`;
          if (final) useBoardsUi.getState().setPropsWidth(w);
        }}
        onReset={() => {
          if (column.current) column.current.style.width = `${PROPS_DEFAULT}px`;
          useBoardsUi.getState().setPropsWidth(PROPS_DEFAULT);
        }}
        testId="task-props-resize"
      />
      <aside ref={column} style={{ width: propsWidth }} className="scrollbar-thin flex max-w-[max(240px,calc(100%-480px))] shrink-0 flex-col gap-3 overflow-y-auto px-3 pb-6 pt-2 [&_[data-prop-label]]:w-[88px]" aria-label={t('boards.properties')} data-testid="task-props-column">
        <div className="flex items-center justify-end gap-0.5">
          <IconButton size="sm" label={t('boards.copyKey')} onClick={() => copyTaskKey(task.key)} data-testid="task-copy-key">
            <Hash className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton size="sm" label={t('boards.copyLink')} onClick={() => copyTaskLink(task.key)} data-testid="task-copy-link">
            <Link2 className="size-3.5" aria-hidden />
          </IconButton>
        </div>
        <div className="flex flex-col gap-0.5">
          <Properties task={task} canEdit={canEdit} perms={perms} scoped={scoped} disabled={disabled} bare />
          <BoardProp task={task} perms={perms} scoped={scoped} />
        </div>
        <WatchersSection task={task} canEdit={canEdit} />
      </aside>
    </div>
  );
});

const NONE: string[] = [];

/** «Доска»: the task's board; with MANAGE_BOARD — a menu of the boards it can move to (as in ⋯). */
function BoardProp({ task, perms, scoped }: { task: Task; perms: bigint | undefined; scoped: boolean }): ReactNode {
  const emoji = useBoards((s) => s.boards[task.boardId]?.emoji ?? '');
  const name = useBoards((s) => s.boards[task.boardId]?.name ?? '');
  const targets = useMoveTargets(task);
  const movable = targets.length > 0 && !scoped && hasBit(perms, MANAGE_BOARD);
  const value = (
    <>
      <span aria-hidden>{emoji || '📋'}</span> <span className="truncate">{name}</span>
    </>
  );
  return (
      <Prop label={t('boards.f.board')} testId="prop-board">
        {movable ? (
          <Dropdown.Root modal={false}>
            <Dropdown.Trigger asChild>
              <button type="button" className={valueBtn} data-testid="prop-board-value">
                {value}
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className={cx(menuBox, 'w-56')} sideOffset={4} align="start" collisionPadding={16}>
                {targets.map((x) => {
                  const [id = '', label = ''] = x.split('\u0000');
                  return (
                    <Dropdown.Item key={id} className={menuItem} onSelect={() => void moveTaskToBoard(task.id, id)}>
                      {label}
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        ) : (
          <span className={cx(valueBtn, 'hover:bg-transparent')} data-testid="prop-board-value">
            {value}
          </span>
        )}
      </Prop>
  );
}

/** «Активность» header's right side: subscribe and the watchers' avatars (up to 4, then «+N»). */
function ActivityAside({ task }: { task: Task }): ReactNode {
  const subscribed = task.subscribed && !task.muted;
  const shown = task.watcherIds.slice(0, 4);
  const more = task.watcherIds.length - shown.length;
  return (
    <>
      <button type="button" onClick={() => void setSubscription(task.id, subscribed)} className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-caption text-muted hover:bg-hover hover:text-fg" data-testid="activity-subscribe">
        {subscribed ? <BellOff className="size-3.5" aria-hidden /> : <Bell className="size-3.5" aria-hidden />}
        {subscribed ? t('boards.unsubscribe') : t('boards.subscribe')}
      </button>
      {shown.length ? (
        <span className="flex items-center -space-x-1.5" aria-label={t('boards.watchers')} data-testid="activity-watchers">
          {shown.map((u) => (
            <span key={u} className="rounded-full ring-2 ring-[var(--color-bg)]">
              <MemberAvatar workspaceId={task.workspaceId} userId={u} size={20} />
            </span>
          ))}
          {more > 0 ? <span className="pl-2.5 text-caption tabular-nums text-muted">+{more}</span> : null}
        </span>
      ) : null}
    </>
  );
}

/** Farther than this from the end of the scroll (px) the «down» button shows. */
const LATEST_GAP = 160;

/**
 * «To the latest comment» (CBF-28): a round button docked above the composer at the column's right
 * edge (the border with the properties column), shown while the scroll is above the end of the task
 * or the room's newest page is not loaded. Leaf: owns its scroll subscription and writes state only
 * when the flag flips, so a scroll tick re-renders nothing else.
 */
const JumpToLatest = memo(function JumpToLatest({ scroller, roomId, toEnd }: { scroller: RefObject<HTMLDivElement | null>; roomId: string; toEnd: () => void }): ReactNode {
  const tab = useBoardsUi((s) => s.activityTab);
  const hasMoreAfter = useMessages((s) => !!s.rooms[roomId]?.hasMoreAfter);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = (): void => setAway(el.scrollHeight - el.scrollTop - el.clientHeight > LATEST_GAP);
    check();
    el.addEventListener('scroll', check, { passive: true });
    // Content growth (comments arriving, sections opening) and window resizes move the end too.
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, [scroller, tab]);
  if (tab !== 'comments' || !(away || hasMoreAfter)) return null;
  const go = (): void => {
    if (hasMoreAfter) void loadPresent(roomId).then(() => requestAnimationFrame(toEnd));
    else toEnd();
  };
  return (
    <div className="pointer-events-none absolute -top-14 right-3 z-[var(--z-sticky)] min-[1200px]:right-6">
      <Tip label={t('boards.toLatest')} side="left">
        <button type="button" onClick={go} aria-label={t('boards.toLatest')} className="mat-popover anim-in pointer-events-auto grid size-9 place-items-center rounded-full text-muted hover:text-fg" data-testid="task-to-latest">
          <ArrowDown className="size-4" aria-hidden />
        </button>
      </Tip>
    </div>
  );
});
