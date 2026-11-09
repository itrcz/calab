import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { SearchHit } from '@calaba/protocol';
import { Search } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { BarContext, Input, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { fmt, useTimeFormat } from '../../lib/format';
import { log } from '../../lib/log';
import { useMobile } from '../../lib/mobile';
import { appendPage, dmSearchParams, firstPage, matchPeers, type DmFeed, type DmHitRow } from '../../lib/search/dmSearch';
import { paramsKey } from '../../lib/search/query';
import { debouncedSearch } from '../../lib/search/runner';
import { openHit } from '../../services/searchNav';
import { sortedDms, useDms } from '../../stores/dms';
import { useSession } from '../../stores/session';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { Snippet } from '../search/hitParts';
import { fetchSearch, searchCache } from '../search/useSearch';
import { GROUP_LABEL, ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { DmRow } from './DmRow';

const hitAt = (h: SearchHit): number => (h.at ? timestampMs(h.at) : 0);

/**
 * Search of the «Личные» column (CBF-159, owner 07.11; it replaces the 07.10 «no search in the
 * column»): the field above the list. A query shows, in place of the list, «Чаты» (DMs by the
 * peer's name, the usual rows) and «Сообщения» (hits in the messages of my DMs, newest first,
 * endless by cursor); a click opens the chat on the message and the results stay. «×» / Esc
 * clear it. The query lives here: the DM list above does not re-render on a keystroke (it only
 * learns whether a search is on), and the results exist only while there is a query.
 */
export function DmSearch({ onActive }: { onActive: (active: boolean) => void }): ReactNode {
  const [q, setQ] = useState('');
  const text = q.trim();
  const active = text !== '';
  const mobile = useMobile();
  useEffect(() => {
    onActive(active);
  }, [active, onActive]);
  const clear = useCallback(() => setQ(''), []);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    // Esc with a query clears it; with an empty field it is left to the shell.
    if (e.currentTarget.value === '') return;
    e.stopPropagation();
    setQ('');
  }, []);
  const field = (
    <Input
      type="search"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onKeyDown={onKeyDown}
      onClear={clear}
      icon={<Search aria-hidden />}
      placeholder={t('dm.searchMessages')}
      aria-label={t('dm.searchMessages')}
      autoComplete="off"
      spellCheck={false}
      data-testid="dm-search"
    />
  );
  return (
    <>
      {mobile ? (
        // Phone: where the «find» button was (the tab root keeps its title and «+»).
        <div className="flex h-16 shrink-0 items-center border-b border-line px-2.5">{field}</div>
      ) : (
        // Desktop: under the column header, the bar-height field.
        <div className="shrink-0 px-2 pb-1.5">
          <BarContext.Provider value>{field}</BarContext.Provider>
        </div>
      )}
      {active ? <DmSearchResults text={text} /> : null}
    </>
  );
}

function useDmFeed(text: string): { feed: DmFeed | null; fresh: boolean; sentinel: (el: HTMLElement | null) => void; root: (el: HTMLElement | null) => void } {
  const params = useMemo(() => dmSearchParams(text), [text]);
  const key = paramsKey(params);
  const [feed, setFeed] = useState<DmFeed | null>(null);
  useEffect(
    () =>
      debouncedSearch({
        key,
        run: (signal) => fetchSearch(params, signal),
        cache: searchCache,
        onDone: (k, r) => setFeed(firstPage(k, r, hitAt)),
        onError: (k, e) => {
          // 422: no words in the query (punctuation only) — the same as nothing found.
          const empty = e instanceof ApiError && e.status === 422;
          if (!empty) log.warn('dm search failed', e);
          setFeed({ key: k, rows: [], cursor: '', done: true, failed: !empty });
        },
      }),
    [key, params],
  );

  const fresh = feed?.key === key;
  const more = useRef<AbortController | null>(null);
  const feedNow = useRef(feed);
  useEffect(() => {
    feedNow.current = feed;
  }, [feed]);
  const loadMore = useCallback(() => {
    const f = feedNow.current;
    if (!f || f.key !== key || f.done || !f.cursor || more.current) return;
    const ctl = new AbortController();
    more.current = ctl;
    const p = dmSearchParams(text, f.cursor);
    const pageKey = paramsKey(p);
    const cached = searchCache.get(pageKey);
    (cached ? Promise.resolve(cached) : fetchSearch(p, ctl.signal)).then(
      (r) => {
        if (ctl.signal.aborted) return;
        searchCache.set(pageKey, r);
        more.current = null;
        setFeed((cur) => (cur ? appendPage(cur, key, r, hitAt) : cur));
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        more.current = null;
        log.warn('dm search page failed', e);
        setFeed((cur) => (cur && cur.key === key ? { ...cur, done: true, failed: true } : cur));
      },
    );
  }, [key, text]);
  // A newer query abandons the page in flight.
  useEffect(
    () => () => {
      more.current?.abort();
      more.current = null;
    },
    [key],
  );

  // Endless list: the sentinel under the rows loads the next page while it is in view.
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!rootEl || !sentinelEl) return;
    const io = new IntersectionObserver((es) => setInView(es.some((e) => e.isIntersecting)), { root: rootEl, rootMargin: '200px' });
    io.observe(sentinelEl);
    return () => io.disconnect();
  }, [rootEl, sentinelEl]);
  useEffect(() => {
    if (inView && fresh && !feed.done) loadMore();
  }, [inView, fresh, feed, loadMore]);
  return { feed, fresh, sentinel: setSentinelEl, root: setRootEl };
}

function DmSearchResults({ text }: { text: string }): ReactNode {
  useLocale();
  const byRoom = useDms((s) => s.byRoom);
  const users = useWorkspaces((s) => s.users);
  // Archived chats are searched too.
  const chats = useMemo(
    () => matchPeers(sortedDms(byRoom), (id) => memberName(null, id), text),
    // users: a renamed peer re-filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byRoom, users, text],
  );
  const { feed, fresh, sentinel, root } = useDmFeed(text);
  const [opened, setOpened] = useState('');
  const open = useCallback((row: DmHitRow) => {
    setOpened(row.id);
    openHit(row.hit);
  }, []);
  const rows = feed?.rows ?? [];
  const loading = !fresh;
  const nothing = !loading && chats.length === 0 && rows.length === 0 && !feed?.failed;
  return (
    <div
      ref={root}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 mobile:px-0"
      style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}
      data-testid="dm-search-results"
    >
      {chats.length > 0 ? (
        <section aria-label={t('dm.searchChats')}>
          <GroupHeading label={t('dm.searchChats')} />
          <ul className="flex flex-col gap-px mobile:gap-0" data-testid="dm-search-chats">
            {chats.map((e) => (
              <DmRow key={e.roomId} entry={e} />
            ))}
          </ul>
        </section>
      ) : null}
      {rows.length > 0 || (loading && chats.length === 0) || feed?.failed ? (
        <section aria-label={t('search.messages')}>
          <GroupHeading label={t('search.messages')} />
          {rows.length > 0 ? (
            <ul className={cx('flex flex-col gap-px mobile:gap-0', loading && 'opacity-60')} data-testid="dm-search-hits">
              {rows.map((r) => (
                <DmHitItem key={r.id} row={r} opened={r.id === opened} onOpen={open} />
              ))}
            </ul>
          ) : null}
          {rows.length === 0 && loading ? <p className="px-2 py-3 text-body text-muted mobile:px-3">{t('search.searching')}</p> : null}
          {feed?.failed ? <p className="px-2 py-3 text-body text-danger-text mobile:px-3" role="alert">{t('dm.searchFailed')}</p> : null}
        </section>
      ) : null}
      {nothing ? (
        <p className="px-3 py-8 text-center text-body text-muted" data-testid="dm-search-empty">
          {t('search.empty')}
        </p>
      ) : null}
      {fresh && feed && !feed.done ? <div ref={sentinel} className="h-px" aria-hidden /> : null}
    </div>
  );
}

function GroupHeading({ label }: { label: string }): ReactNode {
  return (
    <div className="flex h-9 items-center pr-1 pt-2 mobile:h-11 mobile:pt-0">
      <h2 className={cx('min-w-0 flex-1 truncate pl-2 mobile:pl-3', GROUP_LABEL)}>{label}</h2>
    </div>
  );
}

/** A found message: the chat's avatar and name, the time, the snippet with the words marked. */
const DmHitItem = memo(function DmHitItem({ row, opened, onOpen }: { row: DmHitRow; opened: boolean; onOpen: (r: DmHitRow) => void }): ReactNode {
  useLocale();
  useTimeFormat();
  const phone = useMobile();
  const peerId = useDms((s) => s.byRoom[row.roomId]?.peerId ?? '');
  const name = useMemberName(null, peerId);
  const avatar = useWorkspaces((s) => s.users[peerId]?.avatarFileId ?? '');
  const mine = useSession((s) => s.me?.user?.id === row.hit.authorId);
  return (
    <li className={cx('relative flex items-center transition-colors duration-[var(--motion-fast)]', phone ? 'min-h-[68px]' : 'rounded-[var(--radius-card)]', opened ? ROW_SELECTED : phone ? 'active:bg-hover' : ROW_HOVER)} data-testid="dm-hit">
      <button
        type="button"
        onClick={() => onOpen(row)}
        aria-current={opened ? 'true' : undefined}
        className={cx('flex min-w-0 flex-1 items-center text-left', phone ? 'gap-3 px-3' : 'gap-2.5 rounded-[var(--radius-row)] py-1.5 pl-2 pr-2')}
      >
        <Avatar userId={peerId} name={name} fileId={avatar || undefined} size={phone ? 44 : 32} className="self-start" />
        <span className={cx('flex min-w-0 flex-1 flex-col', phone && 'gap-0.5 border-b border-line py-2.5 [li:last-child_&]:border-b-0')}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-list leading-5 text-fg" title={name}>
              {name}
            </span>
            <span className={cx('shrink-0 text-micro text-faint', phone && 'tabular-nums')}>{row.at ? fmt.listTime(new Date(row.at)) : ''}</span>
          </span>
          <span className="line-clamp-2 min-w-0 break-words text-caption leading-4 text-muted">
            {mine ? `${t('dm.you')}: ` : ''}
            <Snippet text={row.snippet} />
          </span>
        </span>
      </button>
    </li>
  );
});
