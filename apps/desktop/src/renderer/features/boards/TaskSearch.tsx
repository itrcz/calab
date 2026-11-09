import * as Popover from '../../components/radix/popover';
import { BoardStatusType, type Task, type TaskSearchSnippet } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { ArrowDown, ArrowUp, Bookmark, CornerDownLeft, ListFilter, Search } from 'lucide-react';
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Choice } from '../../components/Choice';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ageOf } from '../../lib/boards/age';
import { EMPTY_FILTER, activeConds, type FilterState } from '../../lib/boards/filter';
import { SEARCH_STATES, hasConditions, isModified, nextSort, queryKey, soleBoard, sortOf, type SearchState, type SortColumn, type TaskQuery } from '../../lib/boards/taskSearch';
import { log } from '../../lib/log';
import { useMobile } from '../../lib/mobile';
import { openFoundTask, saveSearch, searchTasksPage, updateSavedSearch } from '../../services/taskSearch';
import type { TabClickEvent } from '../../services/taskTab';
import { useBoards } from '../../stores/boards';
import { prefsOf, useBoardsUi } from '../../stores/boardsUi';
import { queryOf, useTaskSearch } from '../../stores/taskSearch';
import { Snippet, Words } from '../search/hitParts';
import { AssigneeStack } from './AssigneeStack';
import { CountBadge, ConditionChips, FilterPopover } from './FilterBar';
import { StatusIcon } from './visuals';

/**
 * The task search (ADR-0139): one component in ⌘K «Задачи» (`dialog`, the text is the dialog's
 * field), on the results page (`page`, with its own field) and in a board (`board`: the text and
 * the conditions live in the board header, here only the state switch and the list). The bar:
 * «Все / Незавершённые / Завершённые / В архиве», «Фильтр» (the board's universal filter, across
 * boards with «Доска»), the chips, «Сбросить», «Сохранить». The list: a table with sortable
 * columns (key, title, board, status, assignee, updated) on the desktop, cards on the phone;
 * pages load as the end scrolls into view (no timer while idle). A typed key comes first as
 * «Открыть DOC-426».
 */

export interface TaskSearchHandle {
  /** The field's keys: ↑↓ move, ↩ opens. True when handled. */
  key: (e: KeyboardEvent) => boolean;
}

const STATE_LABEL: Record<SearchState, MessageKey> = { all: 'ts.state.all', open: 'ts.state.open', done: 'ts.state.done', archived: 'ts.state.archived' };

const DEBOUNCE_MS = 250;
/** The server's offset cursor stops here (MaxSearchOffset): «уточните поиск». */
const SEARCH_CAP = 2000;

interface Results {
  key: string;
  ids: string[];
  byId: Record<string, Task>;
  snippets: Record<string, TaskSearchSnippet>;
  keyTask: Task | null;
  next: string;
  failed: boolean;
}

/** Pages of the search for `query` (debounced, the previous request aborted); `more` loads the next page. */
function useResults(workspaceId: string, boardId: string, query: TaskQuery, enabled: boolean): { res: Results | null; busy: boolean; more: () => void; loadingMore: boolean } {
  const key = enabled ? `${workspaceId}|${boardId}|${queryKey(query)}` : '';
  const [res, setRes] = useState<Results | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      searchTasksPage(workspaceId, query, boardId, '', ctl.signal).then(
        (r) => {
          const byId: Record<string, Task> = {};
          for (const x of r.tasks) byId[x.id] = x;
          const snippets: Record<string, TaskSearchSnippet> = {};
          for (const s of r.snippets) snippets[s.taskId] = s;
          setRes({ key, ids: r.tasks.map((x) => x.id), byId, snippets, keyTask: r.keyTask ?? null, next: r.nextCursor, failed: false });
        },
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          log.warn('task search failed', e);
          setRes({ key, ids: [], byId: {}, snippets: {}, keyTask: null, next: '', failed: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
    // `key` carries the query (queryKey): a new query object with the same conditions is no new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId, boardId]);
  const inFlight = useRef('');
  const more = useCallback(() => {
    if (!res || !res.next || res.key !== key || inFlight.current === `${key}|${res.next}`) return;
    const cursor = res.next;
    inFlight.current = `${key}|${cursor}`;
    setLoadingMore(true);
    const ctl = new AbortController();
    searchTasksPage(workspaceId, query, boardId, cursor, ctl.signal)
      .then(
        (r) =>
          setRes((cur) => {
            if (!cur || cur.key !== key) return cur;
            const byId = { ...cur.byId };
            const ids = [...cur.ids];
            for (const x of r.tasks) {
              if (!byId[x.id]) ids.push(x.id);
              byId[x.id] = x;
            }
            const snippets = { ...cur.snippets };
            for (const s of r.snippets) snippets[s.taskId] = s;
            return { ...cur, ids, byId, snippets, next: r.nextCursor };
          }),
        (e: unknown) => log.warn('task search page failed', e),
      )
      .finally(() => {
        inFlight.current = '';
        setLoadingMore(false);
      });
  }, [res, key, workspaceId, boardId, query]);
  const fresh = !!res && res.key === key;
  return { res: key && fresh ? res : key ? (res?.key.startsWith(`${workspaceId}|${boardId}|`) ? res : null) : null, busy: !!key && !fresh, more, loadingMore };
}

export const TaskSearch = forwardRef<
  TaskSearchHandle,
  {
    workspaceId: string;
    /** A board's search: only its tasks; the conditions are the board's filter (shown in the board header). */
    boardId?: string;
    query: TaskQuery;
    onQuery: (q: TaskQuery) => void;
    variant: 'dialog' | 'page' | 'board';
    /** After a task is opened (⌘K closes). */
    onOpened?: () => void;
  }
>(function TaskSearch({ workspaceId, boardId = '', query, onQuery, variant, onOpened }, ref) {
  const mobile = useMobile();
  const enabled = variant !== 'dialog' || hasConditions(query);
  const { res, busy, more, loadingMore } = useResults(workspaceId, boardId, query, enabled);
  const [selAt, setSelAt] = useState<{ key: string; i: number }>({ key: '', i: 0 });
  const keyTask = res?.keyTask ?? null;
  const rows = useMemo(() => (res ? res.ids.filter((id) => id !== keyTask?.id) : []), [res, keyTask]);
  const count = rows.length + (keyTask ? 1 : 0);
  const resKey = res?.key ?? '';
  // A new answer starts at its first row.
  const sel = selAt.key === resKey ? selAt.i : 0;
  const cur = Math.min(sel, Math.max(0, count - 1));
  const setSel = useCallback((i: number) => setSelAt({ key: resKey, i }), [resKey]);
  const text = query.q.trim();

  const open = useCallback(
    (task: Task, e?: TabClickEvent) => {
      // Ctrl/⌘-click: a background tab; the search / ⌘K stays open with its query.
      if (openFoundTask(task, variant === 'page' ? text : '', e)) return;
      onOpened?.();
    },
    [variant, text, onOpened],
  );
  const taskAt = (i: number): Task | null => {
    if (keyTask) {
      if (i === 0) return keyTask;
      i -= 1;
    }
    const id = rows[i];
    return id ? (useBoards.getState().tasks[id] ?? res?.byId[id] ?? null) : null;
  };
  useImperativeHandle(ref, () => ({
    key: (e) => {
      if (e.nativeEvent.isComposing) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!count) return false;
        e.preventDefault();
        setSel(e.key === 'ArrowDown' ? Math.min(count - 1, cur + 1) : Math.max(0, cur - 1));
        return true;
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        const task = taskAt(cur);
        if (!task) return false;
        e.preventDefault();
        open(task);
        return true;
      }
      return false;
    },
  }));
  const pick = useCallback((id: string, e?: TabClickEvent) => {
    const task = id === keyTask?.id ? keyTask : (useBoards.getState().tasks[id] ?? res?.byId[id]);
    if (task) open(task, e);
  }, [keyTask, res, open]);

  // Infinite load: the sentinel under the last row (an observer, no timer).
  const sentinel = useRef<HTMLDivElement>(null);
  const moreRef = useRef(more);
  useEffect(() => {
    moreRef.current = more;
  });
  const hasNext = !!res?.next;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNext) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) moreRef.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNext, resKey]);

  const sorting = sortOf(query.sort);
  const onSort = useCallback((col: SortColumn) => onQuery({ ...query, sort: nextSort(query.sort, col) }), [query, onQuery]);
  const showBoard = !boardId;
  const failed = !!res?.failed;

  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-testid={`task-search-${variant}`}>
      <SearchBar workspaceId={workspaceId} boardId={boardId} query={query} onQuery={onQuery} variant={variant} busy={busy} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" aria-busy={busy || undefined} data-testid="task-search-list">
        {!enabled ? (
          <p className="px-6 py-10 text-center text-body text-muted" data-testid="task-search-hint">
            {t('ts.hint')}
          </p>
        ) : !res && busy ? (
          <div className="grid h-32 place-items-center">
            <Spinner />
          </div>
        ) : failed ? (
          <p className="px-6 py-10 text-center text-body text-muted">{t('ts.failed')}</p>
        ) : count === 0 ? (
          <p className="px-6 py-10 text-center text-body text-muted" data-testid="task-search-empty">
            {t('ts.empty')}
          </p>
        ) : (
          <>
            {mobile ? null : <HeaderRow sorting={sorting} onSort={onSort} showBoard={showBoard} />}
            <div id={`task-search-${variant}-list`} role="listbox" aria-label={t('ts.results')}>
            {keyTask ? <KeyRow task={keyTask} selected={cur === 0 && variant === 'dialog'} onPick={pick} onHover={() => setSel(0)} /> : null}
            {rows.map((id, i) => (
              <ResultRow
                key={id}
                id={id}
                index={i + (keyTask ? 1 : 0)}
                fallback={res?.byId[id] ?? null}
                snippet={res?.snippets[id]}
                q={text}
                workspaceId={workspaceId}
                showBoard={showBoard}
                card={mobile}
                selected={variant === 'dialog' && cur === i + (keyTask ? 1 : 0)}
                onPick={pick}
                onHover={setSel}
              />
            ))}
            </div>
            <div ref={sentinel} className="h-px" aria-hidden />
            {loadingMore ? (
              <div className="grid h-10 place-items-center">
                <Spinner className="size-4" label={t('ts.more')} />
              </div>
            ) : null}
            {!hasNext && (res?.ids.length ?? 0) >= SEARCH_CAP ? <p className="px-4 py-3 text-caption text-muted">{t('ts.cap', { n: SEARCH_CAP })}</p> : null}
          </>
        )}
      </div>
    </div>
  );
});

// ------------------------------------------------------------------ the bar

function SearchBar({ workspaceId, boardId, query, onQuery, variant, busy }: { workspaceId: string; boardId: string; query: TaskQuery; onQuery: (q: TaskQuery) => void; variant: 'dialog' | 'page' | 'board'; busy: boolean }): ReactNode {
  const states = useMemo(() => SEARCH_STATES.map((s) => ({ value: s, label: t(STATE_LABEL[s]) })), []);
  const setState = useCallback((state: SearchState) => onQuery({ ...query, state }), [query, onQuery]);
  const setFilter = useCallback((filter: FilterState) => onQuery({ ...query, filter }), [query, onQuery]);
  const sole = soleBoard(query.filter);
  const board = useBoards((s) => (sole ? s.boards[sole] : undefined));
  const [filterOpen, setFilterOpen] = useState(false);
  const n = activeConds(query.filter).length;
  // In a board the conditions are the board's own filter: its chips and «Фильтр» sit in the board header.
  const own = variant !== 'board';
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2" data-testid="task-search-bar">
      {variant === 'page' ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              icon={<Search />}
              type="search"
              value={query.q}
              onChange={(e) => onQuery({ ...query, q: e.target.value })}
              onClear={() => onQuery({ ...query, q: '' })}
              maxLength={200}
              autoFocus
              placeholder={t('ts.placeholder')}
              aria-label={t('ts.page')}
              data-testid="all-tasks-search"
            />
          </div>
          {busy ? <Spinner className="size-4" /> : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <div className="shrink-0" data-testid="task-search-state" data-value={query.state}>
          <Choice phone="picker" value={query.state} options={states} onChange={setState} label={t('ts.state.label')} />
        </div>
        {own ? (
          <>
            <FilterPopover board={board} workspaceId={workspaceId} filter={query.filter} setFilter={setFilter} open={filterOpen} setOpen={setFilterOpen} label={t('ts.addFilter')} scope="search">
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className="relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-control text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg tap-hit mobile:h-9 mobile:border-transparent mobile:bg-hover mobile:px-3 mobile:font-medium mobile:text-fg"
                  data-testid="task-search-filter"
                >
                  <ListFilter className="size-3.5" aria-hidden />
                  {t('ts.addFilter')}
                  <CountBadge n={n} />
                </button>
              </Popover.Trigger>
            </FilterPopover>
            <ConditionChips board={board} workspaceId={workspaceId} filter={query.filter} setFilter={setFilter} className="contents" reset={false} />
          </>
        ) : null}
        <span className="flex-1" />
        {own && isModified(query) ? (
          <button type="button" onClick={() => onQuery({ q: variant === 'dialog' ? query.q : '', state: 'all', filter: EMPTY_FILTER, sort: '' })} className="h-7 shrink-0 rounded-full px-2.5 text-control text-muted hover:bg-hover hover:text-fg" data-testid="task-search-reset">
            {t('ts.reset')}
          </button>
        ) : null}
        {own && !boardId ? <SaveButton workspaceId={workspaceId} query={query} /> : null}
      </div>
    </div>
  );
}

/** «Сохранить»: a name for the current conditions; with a saved search open and changed, «Обновить «…»» too. */
function SaveButton({ workspaceId, query }: { workspaceId: string; query: TaskQuery }): ReactNode {
  const activeId = useTaskSearch((s) => s.activeSaved[workspaceId] ?? '');
  const active = useTaskSearch((s) => (activeId ? s.saved[workspaceId]?.find((x) => x.id === activeId) : undefined));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!hasConditions(query)) return null;
  const submit = (): void => {
    const v = name.trim();
    if (!v || busy) return;
    setBusy(true);
    void saveSearch(workspaceId, v, query).then((s) => {
      setBusy(false);
      if (s) {
        setOpen(false);
        setName('');
      }
    });
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <IconButton size="sm" label={t('ts.saveAction')} className="shrink-0 data-[state=open]:bg-active" data-testid="task-search-save">
          <Bookmark className="size-4" aria-hidden />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={8} onKeyDown={(e) => e.stopPropagation()} onCloseAutoFocus={(e) => e.preventDefault()} className="mat-popover anim-in z-[var(--z-modal-popover)] flex w-[280px] flex-col gap-2 rounded-[var(--radius-card)] p-3" data-testid="task-search-save-menu">
          {active ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void updateSavedSearch(workspaceId, active.id, { query }).then(() => setOpen(false));
              }}
              data-testid="task-search-update"
            >
              {t('ts.update', { name: active.name })}
            </Button>
          ) : null}
          <label className="text-caption font-medium text-muted" htmlFor="task-search-save-name">
            {t('ts.saveName')}
          </label>
          <Input
            id="task-search-save-name"
            autoFocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            data-testid="task-search-save-name"
          />
          <Button size="sm" disabled={!name.trim()} busy={busy} onClick={submit} data-testid="task-search-save-submit">
            {t('ts.saveAction')}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ------------------------------------------------------------------ rows

const GRID = 'grid grid-cols-[64px_minmax(0,1fr)_120px_92px_76px] @[720px]:grid-cols-[64px_minmax(0,1fr)_120px_132px_92px_76px] items-center gap-x-3 px-3';
const GRID_NO_BOARD = 'grid grid-cols-[64px_minmax(0,1fr)_120px_92px_76px] items-center gap-x-3 px-3';

const COLS: ReadonlyArray<{ col: SortColumn; label: MessageKey; board?: boolean; end?: boolean }> = [
  { col: 'key', label: 'ts.col.key' },
  { col: 'title', label: 'ts.col.title' },
  { col: 'status', label: 'ts.col.status' },
  { col: 'board', label: 'ts.col.board', board: true },
  { col: 'assignee', label: 'ts.col.assignee' },
  { col: 'updated', label: 'ts.col.updated', end: true },
];

const HeaderRow = memo(function HeaderRow({ sorting, onSort, showBoard }: { sorting: { col: string; desc: boolean } | null; onSort: (c: SortColumn) => void; showBoard: boolean }): ReactNode {
  return (
    <div className={cx(showBoard ? GRID : GRID_NO_BOARD, 'sticky top-0 z-[1] h-8 border-b border-line bg-[var(--color-bg)] text-caption text-muted')} role="presentation" data-testid="task-search-head">
      {COLS.filter((c) => showBoard || !c.board).map((c) => {
        const on = sorting?.col === c.col;
        const desc = !!sorting?.desc;
        return (
          <button
            key={c.col}
            type="button"
            onClick={() => onSort(c.col)}
            className={cx('flex min-w-0 items-center gap-1 truncate text-left hover:text-fg', c.board && 'hidden @[720px]:flex', c.end && 'justify-end', on && 'font-medium text-fg')}
            aria-label={t('ts.sortBy', { col: t(c.label) })}
            aria-sort={on ? (desc ? 'descending' : 'ascending') : undefined}
            data-testid={`task-search-sort-${c.col}`}
          >
            <span className="truncate">{t(c.label)}</span>
            {on ? desc ? <ArrowDown className="size-3 shrink-0" aria-hidden /> : <ArrowUp className="size-3 shrink-0" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
});

const KeyRow = memo(function KeyRow({ task, selected, onPick, onHover }: { task: Task; selected: boolean; onPick: (id: string, e?: TabClickEvent) => void; onHover: () => void }): ReactNode {
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={(e) => onPick(task.id, e)}
      onMouseMove={selected ? undefined : onHover}
      className={cx('mx-1.5 my-1 flex h-9 cursor-default items-center gap-2 rounded-[var(--radius-row)] px-2.5 text-body hover:bg-hover mobile:h-12', selected && 'bg-hover')}
      data-testid="task-search-key"
    >
      <CornerDownLeft className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="shrink-0 font-medium">{t('ts.openKey', { key: task.key })}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{task.title}</span>
      {task.archivedAt ? <Flag label={t('ts.archived')} /> : null}
    </div>
  );
});

function Flag({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'warn' }): ReactNode {
  return (
    <span className={cx('inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-micro font-medium', tone === 'warn' ? 'border-[var(--color-warn-text)] text-[var(--color-warn-text)]' : 'border-line text-muted')} data-testid="task-search-flag">
      {label}
    </span>
  );
}

/**
 * One found task. The store's copy when there is one (live updates), else the answer's (an
 * archived task is not in the store). Desktop: a table row; phone: a card.
 */
const ResultRow = memo(function ResultRow({
  id,
  index,
  fallback,
  snippet,
  q,
  workspaceId,
  showBoard,
  card,
  selected,
  onPick,
  onHover,
}: {
  id: string;
  index: number;
  fallback: Task | null;
  snippet: TaskSearchSnippet | undefined;
  q: string;
  workspaceId: string;
  showBoard: boolean;
  card: boolean;
  selected: boolean;
  onPick: (id: string, e?: TabClickEvent) => void;
  onHover: (i: number) => void;
}): ReactNode {
  const live = useBoards((s) => s.tasks[id]);
  // The age is of the moment the row appeared (no timer: a search list is short-lived).
  const [now] = useState(() => Date.now());
  const task = live ?? fallback;
  const boardId = task?.boardId ?? '';
  const boardName = useBoards((s) => s.boards[boardId]?.name ?? '');
  const boardEmoji = useBoards((s) => s.boards[boardId]?.emoji ?? '');
  const statusId = task?.statusId ?? '';
  const status = useBoards((s) => s.boards[boardId]?.statuses.find((x) => x.id === statusId));
  if (!task) return null;
  const archived = !!task.archivedAt;
  const cancelled = status?.type === BoardStatusType.CANCELLED;
  const updated = task.updatedAt ? timestampMs(task.updatedAt) : 0;
  const age = ageOf(updated, now);
  const flags = (
    <>
      {archived ? <Flag label={t('ts.archived')} /> : null}
      {cancelled ? <Flag label={t('ts.cancelled')} tone="warn" /> : null}
    </>
  );
  const snip = snippet ? (
    <span className="flex min-w-0 items-baseline gap-1 truncate text-caption text-muted">
      {snippet.comment ? <span className="shrink-0 text-faint">{t('ts.inComment')}:</span> : null}
      <span className="truncate">
        <Snippet text={snippet.text} />
      </span>
    </span>
  ) : null;
  const statusCell = status ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <StatusIcon type={status.type} color={status.color} icon={status.icon} />
      <span className="truncate">{status.name}</span>
    </span>
  ) : (
    <span />
  );
  if (card) {
    return (
      <div role="option" aria-selected={selected} onClick={(e) => onPick(id, e)} className="flex cursor-default flex-col gap-1 border-b border-line px-4 py-3 active:bg-hover" data-testid="task-search-row" data-archived={archived || undefined}>
        <span className="flex min-w-0 items-center gap-2 text-caption text-muted">
          <span className="shrink-0 font-medium tabular-nums text-fg">
            <Words text={task.key} q={q} />
          </span>
          {showBoard ? (
            <span className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 text-[12px] leading-none" aria-hidden>
                {boardEmoji || '📋'}
              </span>
              <span className="truncate">{boardName}</span>
            </span>
          ) : null}
          <span className="flex-1" />
          {flags}
        </span>
        <span className="line-clamp-2 break-words text-list text-fg">
          <Words text={task.title} q={q} />
        </span>
        {snip}
        <span className="flex min-w-0 items-center gap-2 text-caption text-muted">
          {statusCell}
          <span className="flex-1" />
          {task.assignees.length ? <AssigneeStack workspaceId={workspaceId} assignees={task.assignees} /> : null}
          {age ? <span className="shrink-0 tabular-nums text-faint">{t(age.key, { n: age.n })}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={(e) => onPick(id, e)}
      onMouseMove={selected ? undefined : () => onHover(index)}
      className={cx(showBoard ? GRID : GRID_NO_BOARD, 'min-h-9 cursor-default border-b border-line py-1.5 text-body hover:bg-hover', selected && 'bg-hover [&_mark]:text-fg [&_mark]:underline')}
      data-testid="task-search-row"
      data-archived={archived || undefined}
    >
      <span className={cx('truncate tabular-nums text-muted', archived && 'line-through decoration-[var(--color-fill-hover)]')}>
        <Words text={task.key} q={q} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            <Words text={task.title} q={q} />
          </span>
          {flags}
        </span>
        {snip}
      </span>
      {statusCell}
      {showBoard ? (
        <span className="hidden min-w-0 items-center gap-1.5 text-muted @[720px]:flex">
          <span className="w-4 shrink-0 text-center text-[13px] leading-none" aria-hidden>
            {boardEmoji || '📋'}
          </span>
          <span className="truncate">{boardName}</span>
        </span>
      ) : null}
      <span className="flex min-w-0 items-center">{task.assignees.length ? <AssigneeStack workspaceId={workspaceId} assignees={task.assignees} /> : null}</span>
      <span className="truncate text-right text-caption tabular-nums text-muted">{age ? t(age.key, { n: age.n }) : ''}</span>
    </div>
  );
});

// ------------------------------------------------------------------ the page

/** The results page («Мои задачи → Все задачи», a saved search): the workspace's last query, remembered. */
export function TaskSearchPage({ workspaceId }: { workspaceId: string }): ReactNode {
  const query = useTaskSearch((s) => queryOf(s, workspaceId));
  const savedName = useTaskSearch((s) => {
    const id = s.activeSaved[workspaceId];
    return id ? (s.saved[workspaceId]?.find((x) => x.id === id)?.name ?? '') : '';
  });
  const onQuery = useCallback((q: TaskQuery) => useTaskSearch.getState().setQuery(workspaceId, q), [workspaceId]);
  return (
    <>
      {savedName ? (
        <div className="flex h-8 shrink-0 items-center gap-1.5 px-4 text-caption text-muted" data-testid="task-search-saved-name">
          <Bookmark className="size-3.5" aria-hidden />
          <span className="truncate font-medium text-fg">{savedName}</span>
        </div>
      ) : null}
      <TaskSearch workspaceId={workspaceId} variant="page" query={query} onQuery={onQuery} />
    </>
  );
}

// ------------------------------------------------------------------ a board

/**
 * The board's search field (ADR-0139): with text in it the board shows the search over its
 * tasks (archive included by default) under the board's own filter (F) instead of the kanban.
 * Esc clears it.
 */
export function BoardSearchField({ boardId, phone = false }: { boardId: string; phone?: boolean }): ReactNode {
  const value = useTaskSearch((s) => s.boardText[boardId] ?? '');
  // A narrow header (the 960 px window) shows the 32 px icon; a click or text opens the field.
  const [opened, setOpened] = useState(false);
  const open = phone || opened || value !== '';
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      {open ? null : (
        <IconButton
          bar
          label={t('ts.boardSearch')}
          className="@[880px]:hidden"
          onClick={() => {
            setOpened(true);
            window.requestAnimationFrame(() => input.current?.focus());
          }}
          data-testid="board-search-open"
        >
          <Search className="size-[18px]" aria-hidden />
        </IconButton>
      )}
      <div className={cx('min-w-0 shrink-0', phone ? 'w-[148px]' : 'w-[180px]', !open && 'hidden @[880px]:block')} data-testid="board-search">
        <Input
          ref={input}
          icon={<Search />}
          type="search"
          value={value}
          maxLength={200}
          onChange={(e) => useTaskSearch.getState().setBoardText(boardId, e.target.value)}
          onClear={() => useTaskSearch.getState().setBoardText(boardId, '')}
          onBlur={() => setOpened(false)}
          onKeyDown={(e) => {
            e.stopPropagation(); // board hotkeys (C, F, 1–3…) stay out of the field
            if (e.key === 'Escape') {
              e.preventDefault();
              useTaskSearch.getState().setBoardText(boardId, '');
              e.currentTarget.blur();
            }
          }}
          placeholder={t('ts.boardPlaceholder')}
          aria-label={t('ts.boardSearch')}
          data-testid="board-search-input"
        />
      </div>
    </>
  );
}

/** The board's search results: its text, the board's filter as conditions, the state and sort of this board's search. */
export function BoardSearchResults({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const text = useTaskSearch((s) => s.boardText[boardId] ?? '');
  const st = useTaskSearch((s) => s.boardState[boardId]);
  const filter = useBoardsUi((s) => prefsOf(s, boardId).filter);
  const query = useMemo((): TaskQuery => ({ q: text, state: st?.state ?? 'all', filter, sort: st?.sort ?? '' }), [text, st, filter]);
  const onQuery = useCallback(
    (q: TaskQuery) => {
      const ts = useTaskSearch.getState();
      ts.setBoardText(boardId, q.q);
      ts.setBoardState(boardId, { state: q.state, sort: q.sort });
      if (q.filter !== filter) useBoardsUi.getState().setPrefs(boardId, { filter: q.filter });
    },
    [boardId, filter],
  );
  return <TaskSearch workspaceId={workspaceId} boardId={boardId} variant="board" query={query} onQuery={onQuery} />;
}
