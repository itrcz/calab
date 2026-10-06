import { RoomType, type SearchHit } from '@calaba/protocol';
import { Paperclip, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, CloseButton, Input, Select, Spinner, cx } from '../../components/ui';
import { PhoneBack } from '../../components/PhoneHeader';
import { getLocale, t } from '../../i18n';
import { log } from '../../lib/log';
import { NO_FILTERS, panelRequest, paramsKey, type PanelFilters, type Period, type RoomKindOf } from '../../lib/search/query';
import { debouncedSearch } from '../../lib/search/runner';
import { scopeParam, writeScope } from '../../lib/search/scope';
import { SECTION_ORDER, hitId, messageLike, orderedSections, sectionTotal, type SectionName } from '../../lib/search/sections';
import { openHit } from '../../services/searchNav';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { HOME } from '../../stores/dms';
import { useRooms } from '../../stores/rooms';
import { useSearchPanel } from '../../stores/searchPanel';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { roomLabel } from '../chat/roomLabel';
import { HitIcon, HitTitle, Snippet, hasFragment, hitPlace, sectionTitle, totalText } from './hitParts';
import { fetchSearch, searchCache, useSearchSummary } from './useSearch';

/** Pages in a row that added no visible row (filters on) before the list waits for «Искать дальше». */
const MAX_EMPTY_RUN = 4;

interface Feed {
  /** The request (first page's parameters) these hits answer. */
  key: string;
  hits: SearchHit[];
  cursor: string;
  done: boolean;
  total: number;
  timedOut: boolean;
  failed: boolean;
  /** Pages in a row that added no row passing the filters. */
  emptyRun: number;
}

const roomKindOf: RoomKindOf = (roomId) => {
  const type = useRooms.getState().byId[roomId]?.type;
  return type === RoomType.TASK ? 'task' : type === RoomType.NOTES ? 'notes' : 'chat';
};

function nowMs(): number {
  return Date.now();
}

/**
 * «Результаты поиска» (ADR-0062 §4, docs/08): the right panel beside the chat — a column from
 * 1200 px, floating below, full screen on a phone. Section tabs with counts (the ⌘K summary,
 * cached), filters (author, room / board, period, «Только с файлами»), relevance / newest, and an
 * endless list by cursor. The hits live in this component's state only: no feed store is
 * written; a click opens the hit where it lives (services/searchNav.ts).
 */
export function SearchResultsPanel({ floating = false, page = false }: { floating?: boolean; page?: boolean }): ReactNode {
  const q = useSearchPanel((s) => s.q);
  const scope = useSearchPanel((s) => s.scope);
  const tab = useSearchPanel((s) => s.tab);
  const close = useSearchPanel((s) => s.close);
  const activeWs = useUi((s) => (s.activeWorkspaceId && s.activeWorkspaceId !== HOME ? s.activeWorkspaceId : null));
  const [draft, setDraft] = useState(q);
  const [filters, setFilters] = useState<PanelFilters>(NO_FILTERS);
  // The moment the period is measured from: set when a period is picked (render stays pure).
  const [anchor, setAnchor] = useState(nowMs);
  const commit = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(commit.current), []);

  const onDraft = (v: string): void => {
    setDraft(v);
    window.clearTimeout(commit.current);
    commit.current = window.setTimeout(() => useSearchPanel.getState().setQuery(v.trim()), 300);
  };
  const pickTab = (s: SectionName): void => {
    useSearchPanel.getState().setTab(s);
    // Board / room ids differ between tabs; the rest of the filters stay.
    setFilters((f) => ({ ...f, place: '' }));
  };
  const setFilter = <K extends keyof PanelFilters>(k: K, v: PanelFilters[K]): void => {
    if (k === 'period') setAnchor(Date.now());
    setFilters((f) => ({ ...f, [k]: v }));
  };

  // Tab counts: the ⌘K summary of the same query (usually cached already).
  const summary = useSearchSummary(q, scope);
  const counts = useMemo(() => {
    const out: Partial<Record<SectionName, number>> = {};
    if (summary.data) for (const { name, section } of orderedSections(summary.data)) out[name] = section.timedOut ? -1 : sectionTotal(section);
    return out;
  }, [summary.data]);
  const tabs = useMemo(() => SECTION_ORDER.filter((s) => s === tab || !summary.data || (counts[s] ?? 0) !== 0), [tab, summary.data, counts]);

  const req = useMemo(() => panelRequest({ q, scope, tab }, filters, anchor, roomKindOf), [q, scope, tab, filters, anchor]);
  const reqKey = q ? paramsKey(req.params) : '';
  const [feed, setFeed] = useState<Feed | null>(null);
  const loadingMore = useRef<AbortController | null>(null);

  // The first page: debounced (typing in the panel's field), cached, the previous one aborted.
  useEffect(() => {
    if (!reqKey) return;
    const params = req.params;
    const match = req.match;
    loadingMore.current?.abort();
    loadingMore.current = null;
    return debouncedSearch({
      key: reqKey,
      delayMs: 120,
      run: (signal) => fetchSearch(params, signal),
      cache: searchCache,
      onDone: (key, r) => {
        const s = r.sections[0];
        const hits = s?.items ?? [];
        setFeed({ key, hits, cursor: s?.nextCursor ?? '', done: !s?.nextCursor, total: s ? sectionTotal(s) : 0, timedOut: !!s?.timedOut, failed: false, emptyRun: hits.some(match) ? 0 : 1 });
      },
      onError: (key, e) => {
        log.warn('search page failed', e);
        setFeed({ key, hits: [], cursor: '', done: true, total: 0, timedOut: false, failed: true, emptyRun: 0 });
      },
    });
  }, [reqKey, req]);

  const current = feed?.key === reqKey ? feed : null;
  const rows = useMemo(() => {
    if (!current) return [];
    const seen = new Set<string>();
    return current.hits.filter((h) => {
      const id = hitId(h);
      if (seen.has(id) || !req.match(h)) return false;
      seen.add(id);
      return true;
    });
  }, [current, req]);

  const loadMore = useCallback(() => {
    const f = feed;
    if (!f || f.key !== reqKey || f.done || !f.cursor || loadingMore.current) return;
    const ctl = new AbortController();
    loadingMore.current = ctl;
    const params = { ...req.params, cursor: f.cursor };
    const pageKey = paramsKey(params);
    const cached = searchCache.get(pageKey);
    const p = cached ? Promise.resolve(cached) : fetchSearch(params, ctl.signal);
    const match = req.match;
    p.then(
      (r) => {
        if (ctl.signal.aborted) return;
        searchCache.set(pageKey, r);
        loadingMore.current = null;
        const s = r.sections[0];
        const more = s?.items ?? [];
        setFeed((cur) =>
          cur && cur.key === f.key
            ? { ...cur, hits: [...cur.hits, ...more], cursor: s?.nextCursor ?? '', done: !s?.nextCursor, timedOut: cur.timedOut || !!s?.timedOut, emptyRun: more.some(match) ? 0 : cur.emptyRun + 1 }
            : cur,
        );
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        loadingMore.current = null;
        log.warn('search page failed', e);
        setFeed((cur) => (cur && cur.key === f.key ? { ...cur, done: true, failed: true } : cur));
      },
    );
  }, [feed, reqKey, req]);
  useEffect(() => () => loadingMore.current?.abort(), []);

  // Endless list: the sentinel under the rows loads the next page while it is in view (also
  // right after a page whose hits the filters dropped), up to MAX_EMPTY_RUN empty pages in a row.
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    const root = scroller.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((es) => setInView(es.some((e) => e.isIntersecting)), { root, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [current?.key]);
  const waiting = !!current && !current.done && current.emptyRun >= MAX_EMPTY_RUN;
  useEffect(() => {
    if (inView && current && !current.done && !waiting) loadMore();
  }, [inView, current, waiting, loadMore]);

  // A phone shows the results full screen: they give way to what was opened.
  const onOpen = useCallback(
    (h: SearchHit) => {
      if (page) useSearchPanel.getState().close();
      openHit(h);
    },
    [page],
  );
  const resultSection: SectionName = req.type;
  const anyFilter = req.filtered || filters.sort !== 'relevance';
  const changeScope = (v: 'workspace' | 'all'): void => {
    writeScope(v);
    useSearchPanel.getState().setScope(scopeParam(v, activeWs));
  };

  return (
    <aside
      aria-label={t('search.panel.title')}
      data-testid="search-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) close();
      }}
      className={
        page
          ? 'mat-content flex min-h-0 flex-1 flex-col'
          : floating
            ? 'mat-popover anim-in absolute bottom-3 right-3 top-[60px] z-[var(--z-popover)] flex w-[340px] flex-col overflow-hidden rounded-[var(--radius-panel)]'
            : 'mat-sidebar flex w-[340px] shrink-0 flex-col border-l border-line'
      }
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 pb-2 pt-3">
        <div className={cx('flex items-center gap-1', page && '-mx-3 -mt-3 mb-1 h-12 border-b border-line pl-0.5 pr-3')}>
          {page ? <PhoneBack /> : null}
          <h2 className={cx('min-w-0 flex-1 truncate font-semibold', page ? 'text-list leading-5' : 'pl-1 text-headline')}>{t('search.panel.title')}</h2>
          {anyFilter ? (
            <button type="button" aria-label={t('search.panel.reset')} className="shrink-0 rounded-full px-1.5 text-caption text-accent-text hover:underline" onClick={() => setFilters(NO_FILTERS)}>
              {t('search.panel.resetShort')}
            </button>
          ) : null}
          {page ? null : <CloseButton label={t('search.panel.close')} onClick={close} />}
        </div>
        <Input
          icon={<Search className="size-3.5" aria-hidden />}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={t('search.panel.query')}
          aria-label={t('search.panel.query')}
          data-testid="search-panel-query"
        />
        {/* Seven sections fit in two rows of pills: every one stays in sight (no hidden scroll). */}
        <div role="tablist" aria-label={t('search.panel.tabs')} className="flex flex-wrap gap-1" data-testid="search-tabs">
          {tabs.map((s) => {
            const n = counts[s];
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={s === tab}
                onClick={() => pickTab(s)}
                className={cx(
                  'flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-control font-medium',
                  s === tab ? 'bg-accent-strong text-accent-fg' : 'text-fg hover:bg-hover',
                )}
              >
                {sectionTitle(s)}
                {n !== undefined && n > 0 ? <span className={cx('tabular-nums', s === tab ? 'opacity-80' : 'text-muted')}>{totalText(n)}</span> : null}
              </button>
            );
          })}
        </div>
        <Filters tab={tab} filters={filters} scope={scope} activeWs={activeWs} onChange={setFilter} onScope={changeScope} />
      </div>
      <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" data-testid="search-results">
        {!q ? (
          <p className="px-3 py-6 text-center text-body text-muted">{t('search.panel.typeQuery')}</p>
        ) : !current ? (
          <div className="grid h-24 place-items-center">
            <Spinner />
          </div>
        ) : current.timedOut && rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-body text-muted">{t('search.panel.timedOut')}</p>
        ) : current.failed && rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-body text-muted">{t('search.panel.failed')}</p>
        ) : rows.length === 0 && current.done ? (
          <p className="px-3 py-6 text-center text-body text-muted">{req.filtered ? t('search.panel.emptyFiltered') : t('search.panel.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {rows.map((h) => (
              <ResultRow key={hitId(h)} hit={h} section={resultSection} q={q} activeWs={activeWs} onOpen={onOpen} />
            ))}
          </ul>
        )}
        <div ref={sentinel} className="grid min-h-8 place-items-center py-2">
          {current && !current.done ? (
            waiting ? (
              <Button size="sm" variant="secondary" onClick={() => setFeed((f) => (f ? { ...f, emptyRun: 0 } : f))}>
                {t('search.panel.more')}
              </Button>
            ) : (
              <Spinner className="size-4" />
            )
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/** Author, room / board, period (presets + dates), «Только с файлами», sort. Lists hold ids and names only. */
function Filters({
  tab,
  filters: f,
  scope,
  activeWs,
  onChange,
  onScope,
}: {
  tab: SectionName;
  filters: PanelFilters;
  scope: string;
  activeWs: string | null;
  onChange: <K extends keyof PanelFilters>(k: K, v: PanelFilters[K]) => void;
  onScope: (v: 'workspace' | 'all') => void;
}): ReactNode {
  // The workspace whose people and places are offered: the scope's, else the open one.
  const ws = scope !== 'all' ? scope : activeWs;
  const people = useWorkspaces(
    useShallow((s) =>
      Object.values((ws ? s.byId[ws]?.members : undefined) ?? {})
        .filter((m) => !!m.user)
        .map((m) => `${m.user?.id ?? ''}\u0000${m.nickname || m.user?.displayName || ''}`)
        .sort((a, b) => (a.split('\u0000')[1] ?? '').localeCompare(b.split('\u0000')[1] ?? '', getLocale())),
    ),
  );
  const boards = tab === 'tasks';
  const places = useRooms(
    useShallow((s) =>
      boards || !ws
        ? []
        : Object.values(s.byId)
            .filter((r) => r.workspaceId === ws && r.type !== RoomType.TASK && (tab !== 'notes' || r.type === RoomType.NOTES))
            .map((r) => `${r.id}\u0000${roomLabel(r)}`)
            .sort((a, b) => (a.split('\u0000')[1] ?? '').localeCompare(b.split('\u0000')[1] ?? '', getLocale())),
    ),
  );
  const boardList = useBoards(useShallow((s) => (boards && ws ? workspaceBoards(s.boards, ws).map((b) => `${b.id}\u0000${b.name}`) : [])));
  const placeList = boards ? boardList : places;
  // Comments: the room is the task's own — no place filter there (the task key is in each row).
  const showPlace = tab !== 'task_comments' && placeList.length > 0;
  const periods: Array<{ value: Period; key: Parameters<typeof t>[0] }> = [
    { value: 'any', key: 'search.period.any' },
    { value: 'today', key: 'search.period.today' },
    { value: '7d', key: 'search.period.7d' },
    { value: '30d', key: 'search.period.30d' },
    { value: 'range', key: 'search.period.range' },
  ];
  // A 2-column grid of pop-ups, filled in order: where, sort, author, room / board, period, files.
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={t('search.panel.filters')} data-testid="search-filters">
      <div className="grid grid-cols-2 gap-2">
        {activeWs ? (
          <Select value={scope === 'all' ? 'all' : 'workspace'} onChange={(e) => onScope(e.target.value === 'all' ? 'all' : 'workspace')} aria-label={t('search.scope')}>
            <option value="workspace">{t('search.filter.thisWorkspace')}</option>
            <option value="all">{t('search.scopeAll')}</option>
          </Select>
        ) : null}
        <Select value={f.sort} onChange={(e) => onChange('sort', e.target.value === 'new' ? 'new' : 'relevance')} aria-label={t('search.sort.label')}>
          <option value="relevance">{t('search.sort.relevance')}</option>
          <option value="new">{t('search.sort.new')}</option>
        </Select>
        <Select value={f.author} onChange={(e) => onChange('author', e.target.value)} aria-label={t('search.filter.author')}>
          <option value="">{t('search.filter.anyone')}</option>
          {people.map((p) => {
            const [id = '', name = ''] = p.split('\u0000');
            return (
              <option key={id} value={id}>
                {name}
              </option>
            );
          })}
        </Select>
        {showPlace ? (
          <Select value={f.place} onChange={(e) => onChange('place', e.target.value)} aria-label={boards ? t('search.filter.board') : t('search.filter.room')}>
            <option value="">{boards ? t('search.filter.anyBoard') : t('search.filter.anyRoom')}</option>
            {placeList.map((p) => {
              const [id = '', name = ''] = p.split('\u0000');
              return (
                <option key={id} value={id}>
                  {name}
                </option>
              );
            })}
          </Select>
        ) : null}
        <Select value={f.period} onChange={(e) => onChange('period', e.target.value as Period)} aria-label={t('search.filter.period')}>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {t(p.key)}
            </option>
          ))}
        </Select>
        {messageLike(tab) ? (
          <button
            type="button"
            aria-pressed={f.withFiles}
            aria-label={t('search.filter.withFiles')}
            onClick={() => onChange('withFiles', !f.withFiles)}
            className={cx(
              'flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-full border px-2.5 text-control font-medium',
              f.withFiles ? 'border-transparent bg-accent-strong text-accent-fg' : 'border-line text-fg hover:bg-hover',
            )}
          >
            <Paperclip className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t('search.filter.withFilesShort')}</span>
          </button>
        ) : null}
      </div>
      {f.period === 'range' ? (
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" value={f.from} max={f.to || undefined} onChange={(e) => onChange('from', e.target.value)} aria-label={t('search.filter.from')} />
          <Input type="date" value={f.to} min={f.from || undefined} onChange={(e) => onChange('to', e.target.value)} aria-label={t('search.filter.to')} />
        </div>
      ) : null}
    </div>
  );
}

/** One result: icon, the name / fragment with the matches marked, the place line. */
const ResultRow = memo(function ResultRow({
  hit,
  section,
  q,
  activeWs,
  onOpen,
}: {
  hit: SearchHit;
  section: SectionName;
  q: string;
  activeWs: string | null;
  onOpen: (h: SearchHit) => void;
}): ReactNode {
  const place = hitPlace(hit, activeWs);
  return (
    <li>
      <button type="button" onClick={() => onOpen(hit)} className="flex w-full gap-2.5 rounded-[var(--radius-row)] px-2.5 py-2 text-left hover:bg-hover" data-testid="search-result">
        <HitIcon section={section} hit={hit} className="mt-0.5 size-4 shrink-0 text-muted" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 break-words text-body text-fg">
            <HitTitle hit={hit} q={q} />
          </span>
          {hasFragment(hit) ? (
            <span className="line-clamp-2 break-words text-caption text-muted">
              <Snippet text={hit.snippet} />
            </span>
          ) : null}
          {place ? <span className="truncate text-caption text-muted">{place}</span> : null}
        </span>
      </button>
    </li>
  );
});
