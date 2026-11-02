import type { PermissionBits, Room } from '@calaba/protocol';
import { BlockedGate } from './BlockedRow';
import { ArrowDown, Hash, NotebookText, Volume2 } from 'lucide-react';
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso';
import { MessageKind, RoomType } from '@calaba/protocol';
import { Spinner, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { ensureLoaded, loadNewer, loadOlder, loadPresent, markRead, reloadRoom, STALE_LOAD_MS } from '../../services/chat';
import { log } from '../../lib/log';
import { EMPTY_ROOM_MESSAGES, WINDOW_CAP, findByKey, firstUnreadIndex, keyIndex, lastSentId as lastSentOf, opensAwayFromPresent, useMessages, type ChatMessage } from '../../stores/messages';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { streamCoversChat, useVoice } from '../../stores/voice';
import { voice } from '../../services/voice';
import { useStreamFullscreen } from '../voice/fullscreen';
import { toast } from '../../stores/toasts';
import { useChatView } from './chatView';
import { createMetaBuilder, type RowMeta } from './grouping';
import { createBottomPin, initialFeedLocation, isOwnSend } from './lastRowPin';
import { hasFeedPosition, readFeedPosition, saveFeedPosition, takeFeedPosition } from './feedPosition';
import { useUi } from '../../stores/ui';
import { DisclosureScope } from '../../lib/disclosure';
import { DatePill, MessageRow, SystemRow } from './MessageBubble';
import { useMiniPlayerShown } from './MediaPlayer';
import { EmptyRoom } from './RoomPanels';
import { Avatar } from '../../components/Avatar';
import { ProfileTarget } from '../../components/ProfileTarget';
import { useDms } from '../../stores/dms';
import { useNotes } from '../../stores/notes';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';

/** Virtual index of a window's base (the store's `base` moves it both ways; Virtuoso needs ≥ 0). */
const START_INDEX = 1_000_000_000;
/** Live messages may grow the open window this far past WINDOW_CAP before its top is cut. */
const CAP_SLACK = 100;
const HIGHLIGHT_MS = 1800;
/** Rows above the first rendered one at which the next page of older history is requested. */
const PREFETCH_ROWS = 20;
/** The floating date fades out this long after scrolling stops (Telegram). */
const STICKY_IDLE_MS = 1000;

export function MessageList({
  workspaceId,
  room,
  perms,
  newMarker,
}: {
  workspaceId: string;
  room: Room;
  perms: PermissionBits;
  newMarker: string;
}): ReactNode {
  // The expanded stream stage of my voice room covers the feed: the welcome shrinks to a row under it.
  const underStage = useVoice((s) => s.roomId === room.id && s.stage === 'expanded' && s.streams.some((x) => x.trackSid === s.watching));
  // Primitives only: this shell must not re-render on every message (Feed has its own subscription).
  const loaded = useMessages((s) => s.rooms[room.id]?.loaded ?? false);
  const error = useMessages((s) => s.rooms[room.id]?.error ?? null);
  const empty = useMessages((s) => {
    const r = s.rooms[room.id];
    return !!r && r.items.length === 0 && !r.hasMoreBefore && !r.hasMoreAfter;
  });
  // CBF-31: a window left away from the present (a jump) is still in the store when the room is
  // opened again — the present is loaded before the feed mounts, so it opens at the latest message.
  // Decided once per open (this shell is keyed by room): a later jump in the open feed is left alone.
  const detached = useMessages((s) => s.rooms[room.id]?.hasMoreAfter ?? false);
  const [reopen, setReopen] = useState(() => opensAwayFromPresent(useMessages.getState().rooms[room.id], hasFeedPosition(room.id)));
  if (reopen && !detached) setReopen(false);
  useEffect(() => {
    if (reopen) void loadPresent(room.id);
  }, [reopen, room.id]);
  if (!loaded || reopen) return <FirstLoad roomId={room.id} error={error} present={reopen} />;
  if (empty) {
    return <EmptyRoom workspaceId={workspaceId} room={room} perms={perms} underStage={underStage} />;
  }
  return <Feed workspaceId={workspaceId} room={room} perms={perms} newMarker={newMarker} />;
}

/**
 * The room's first load: a spinner, and «Не удалось загрузить сообщения · Повторить» on an error
 * or once the load has been pending STALE_LOAD_MS (docs/09 #146 — never a spinner forever). One
 * timer while this is shown, nothing after.
 */
function FirstLoad({ roomId, error, present }: { roomId: string; error: string | null; present: boolean }): ReactNode {
  const [attempt, setAttempt] = useState(0);
  // The attempt (room + retry count) whose load outlived STALE_LOAD_MS.
  const key = `${roomId}:${attempt}`;
  const [slowKey, setSlowKey] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSlowKey(key), STALE_LOAD_MS);
    return () => window.clearTimeout(id);
  }, [key]);
  const slow = slowKey === key;
  const retry = (): void => {
    setAttempt((n) => n + 1);
    // The room is loaded, only away from the present (CBF-31): reloading it would be a no-op.
    void (present ? loadPresent(roomId) : reloadRoom(roomId));
  };
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-feed">
      {error || slow ? (
        <button type="button" className="text-danger-text hover:underline" onClick={retry} data-testid="chat-load-failed">
          {error || t('err.ctx.loadMessages')} · {t('common.retry')}
        </button>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

/**
 * One message row that throws while rendering shows a placeholder instead of taking the whole
 * feed (and, without a boundary, the whole window) down with it.
 */
class RowBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(e: unknown): void {
    log.error('message row render failed', this.props.id, e);
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="px-4 py-1 text-caption italic text-muted" data-message-id={this.props.id}>{t('chat.rowFailed')}</div>;
  }
}

/** What rows, header and footer read from the feed: passed as Virtuoso `context`, so their renderers stay stable. */
interface FeedContext {
  workspaceId: string;
  roomId: string;
  room: Room;
  perms: PermissionBits;
  me: string;
  metas: readonly RowMeta[];
  firstIndex: number;
  highlight: string | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loading: boolean;
}

function FeedHeader({ context }: { context: FeedContext }): ReactNode {
  return context.hasMoreBefore ? (
    <div className="grid h-12 place-items-center">{context.loading ? <Spinner /> : null}</div>
  ) : (
    <HistoryStart room={context.room} />
  );
}

function FeedFooter({ context }: { context: FeedContext }): ReactNode {
  return context.hasMoreAfter ? <div className="grid h-12 place-items-center"><Spinner /></div> : <div className="h-3" />;
}

const FEED_COMPONENTS = { Header: FeedHeader, Footer: FeedFooter };
const INCREASE_VIEWPORT = { top: 800, bottom: 400 };
const itemKey = (_i: number, c: ChatMessage): string => c.key;

/**
 * One row, memoised on primitives: Virtuoso re-runs every mounted row's renderer whenever its
 * rendered range changes (each row mounted or unmounted while scrolling); unchanged rows stop here.
 */
const FeedRow = memo(function FeedRow({
  c,
  meta,
  own,
  workspaceId,
  roomId,
  perms,
  highlighted,
}: {
  c: ChatMessage;
  meta: RowMeta;
  own: boolean;
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
  highlighted: boolean;
}): ReactNode {
  return (
    <RowBoundary id={c.key}>
      {/* Disclosures in the row («Показать всё») outlive its unmount (lib/disclosure.ts). */}
      <DisclosureScope.Provider value={c.key}>
        {c.msg.kind === MessageKind.SYSTEM ? (
          <SystemRow c={c} meta={meta} workspaceId={workspaceId} perms={perms} highlighted={highlighted} />
        ) : (
          <BlockedGate authorId={own ? '' : c.msg.authorId} msgKey={c.key}>
            <MessageRow c={c} meta={meta} own={own} workspaceId={workspaceId} roomId={roomId} perms={perms} highlighted={highlighted} />
          </BlockedGate>
        )}
      </DisclosureScope.Provider>
    </RowBoundary>
  );
});

function feedRow(index: number, c: ChatMessage, x: FeedContext): ReactNode {
  return (
    <FeedRow
      c={c}
      meta={x.metas[index - x.firstIndex] ?? FALLBACK_META}
      own={c.msg.authorId === x.me}
      workspaceId={x.workspaceId}
      roomId={x.roomId}
      perms={x.perms}
      highlighted={x.highlight === c.key}
    />
  );
}

/** The virtualised feed; mounted once the first window is loaded (so the initial position is known). */
function Feed({ workspaceId, room, perms, newMarker }: { workspaceId: string; room: Room; perms: PermissionBits; newMarker: string }): ReactNode {
  const roomId = room.id;
  const state = useMessages((s) => s.rooms[roomId] ?? EMPTY_ROOM_MESSAGES);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const highlight = useChatView((s) => s.highlight);
  const jump = useChatView((s) => s.jump);
  // The mini-player covers the feed's top strip: the unread banner and the date pill go below it.
  const mini = useMiniPlayerShown();
  const items = state.items;
  const virtuoso = useRef<VirtuosoHandle>(null);
  // False until Virtuoso reports it: opening at the first unread must not mark the room read.
  const [atBottom, setAtBottom] = useState(false);

  // Grouping, incremental: only changed rows and their neighbours are recomputed; unchanged rows
  // keep their meta object → no re-render (docs/14 «Лента на 20 тыс. сообщений»).
  const [metaBuilder] = useState(createMetaBuilder);
  const metas = useMemo(() => metaBuilder(items, newMarker, me), [metaBuilder, items, newMarker, me]);

  // Older rows prepended / the oldest rows dropped keep the scroll position via Virtuoso's
  // firstItemIndex; the store keeps the window's base exact for every change.
  const firstIndex = START_INDEX + state.base;

  // Opens at the last row's bottom, always the present (CBF-31: never at the first unread).
  // docs/09 #149: the last row growing in place (reaction, upload → preview, image/link preview,
  // edit), a new message or the composer growing keep it there while stuck (lastRowPin.ts).
  // Back from a screen pushed over the room (phone: members, settings…): where the reader left it.
  const [{ location: initialIndex, stuck: openStuck }] = useState(() => {
    const pos = takeFeedPosition(roomId);
    const at = pos ? keyIndex(items).get(pos.key) : undefined;
    if (pos && at !== undefined) return { location: { index: at, align: 'start' as const, offset: -pos.offset }, stuck: false };
    return initialFeedLocation(state.hasMoreAfter);
  });
  const [bottomPin] = useState(() => createBottomPin(openStuck));

  const lastSentId = useMemo(() => lastSentOf(items), [items]);

  // The stream stage / stream full screen covers this feed: messages behind it are unseen,
  // so they keep their unread state and the marker must not move (issue #35).
  const streamFs = useStreamFullscreen((s) => s.on);
  const covered = useVoice((s) => streamCoversChat(s, roomId, streamFs));

  // Read state: the newest message is on screen and the window is focused. The marker itself is
  // read only by FeedOverlays, so moving it does not re-render the feed.
  useEffect(() => {
    if (!atBottom || !lastSentId || covered) return;
    const mark = (): void => {
      if (document.hasFocus()) markRead(roomId, lastSentId, true);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [atBottom, lastSentId, roomId, covered]);

  // At the present with the bottom on screen, live messages grow the window: cut its top (far
  // above the viewport) back to WINDOW_CAP; the base keeps the position.
  const overCap = atBottom && !state.hasMoreAfter && items.length > WINDOW_CAP + CAP_SLACK;
  useEffect(() => {
    if (overCap) useMessages.getState().capOpen(roomId);
  }, [overCap, roomId]);

  // Jump requests (search, reply quotes, pins): load the window if needed, scroll, highlight.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!jump || jump.roomId !== roomId) return;
    // Clearing the request re-runs this effect; the pending load must survive that (no cleanup).
    useChatView.getState().clearJump();
    const target = jump.messageId;
    void ensureLoaded(roomId, target).then((ok) => {
      if (!alive.current) return;
      if (!ok) {
        toast.info(t('chat.messageGone'));
        return;
      }
      // Two frames: the list has rendered the (possibly new) window before we scroll.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const r = useMessages.getState().rooms[roomId];
          const i = r ? (keyIndex(r.items).get(target) ?? -1) : -1;
          if (!alive.current || i < 0) return;
          virtuoso.current?.scrollToIndex({ index: i, align: 'center', behavior: 'auto' });
          useChatView.getState().setHighlight(target);
          window.setTimeout(() => {
            if (useChatView.getState().highlight === target) useChatView.getState().setHighlight(null);
          }, HIGHLIGHT_MS);
        }),
      );
    });
  }, [jump, roomId]);

  const startReached = useCallback(() => {
    if (state.hasMoreBefore && !state.loading) void loadOlder(roomId);
  }, [roomId, state.hasMoreBefore, state.loading]);
  // Older history is asked for while the reader is still PREFETCH_ROWS above its first row, not
  // when that row is already on screen: the page lands (and its rows are measured) above the
  // viewport instead of under the reader's finger at the very top of the window.
  const rangeChanged = useCallback(
    (r: ListRange) => {
      if (r.startIndex - firstIndex < PREFETCH_ROWS) startReached();
    },
    [firstIndex, startReached],
  );
  const endReached = useCallback(() => {
    if (state.hasMoreAfter) void loadNewer(roomId);
  }, [roomId, state.hasMoreAfter]);

  // A new item never scrolls by itself (no Virtuoso followOutput): the bottom pin is the feed's only
  // writer of «to the bottom» (CBF-13, ADR-0110, lastRowPin.ts). Layout effects: a window loaded
  // away from the present must stop the pin before the next ResizeObserver delivery (which precedes
  // passive effects), or it would chase endReached.
  useLayoutEffect(() => bottomPin.setLive(!state.hasMoreAfter), [bottomPin, state.hasMoreAfter]);
  // The last row, as primitives: my own optimistic row appearing is a send, which sticks the pin
  // wherever the reader was (isOwnSend). Layout effect: before the ResizeObserver delivery that
  // measures the new row.
  const last = items[items.length - 1];
  const lastKey = last?.key ?? '';
  const lastOwn = !!last && last.msg.authorId === me;
  const lastPending = !!last && last.status !== 'sent';
  const lastKeyRef = useRef(lastKey);
  useLayoutEffect(() => {
    if (lastKeyRef.current === lastKey) return;
    lastKeyRef.current = lastKey;
    if (isOwnSend({ key: lastKey, own: lastOwn, pending: lastPending })) bottomPin.stick();
  }, [bottomPin, lastKey, lastOwn, lastPending]);

  // Floating date: the day of the topmost visible row, hidden while that day's own pill is in view.
  const scroller = useRef<HTMLElement | null>(null);
  const scrollerRef = useCallback((r: HTMLElement | Window | null) => {
    scroller.current = r instanceof HTMLElement ? r : null;
  }, []);

  // docs/09 #149, CBF-13: keep the bottom while stuck to it. One observer, called by the browser
  // only when a size changes (no per-render or per-frame work), on two elements: the scroller (its
  // height — the composer growing, the window resizing) and Virtuoso's item list, border box (the
  // rendered rows — a new message appended, any row growing: a link preview, an image, a reaction,
  // an edit — and its padding, Virtuoso's estimate of rows not rendered). Every report while stuck
  // pins, including the first one of someone else's new row: it is set before paint, so the new
  // message is never painted under the composer. A hidden window gets the report when shown again.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (bottomPin.resized(root)) root.scrollTop = root.scrollHeight;
    });
    ro.observe(root);
    const list = root.querySelector('[data-testid="virtuoso-item-list"]');
    if (list) ro.observe(list, { box: 'border-box' });
    return () => ro.disconnect();
  }, [bottomPin]);

  // Phone: the room screen unmounts under a pushed screen (ADR-0073) — keep the reader's place
  // for its return, unless they sat at the bottom (then it opens there anyway). Layout cleanup:
  // the rows are still in the document.
  useLayoutEffect(
    () => () => {
      const el = scroller.current;
      const covered = useUi.getState().phone.stack.some((x) => (x.kind === 'room' || x.kind === 'dm') && x.room === roomId);
      saveFeedPosition(roomId, covered && el && !bottomPin.isStuck() ? readFeedPosition(el) : null);
    },
    [bottomPin, roomId],
  );

  // An unfold the reader clicked («Показать всё») grows its row down from where they read: the
  // bottom pin lets go, or a last row unfolding at the bottom threw them to the end of its text.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const onClick = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('[data-feed-expand]')) bottomPin.release();
    };
    root.addEventListener('click', onClick, true);
    return () => root.removeEventListener('click', onClick, true);
  }, [bottomPin]);

  // Phone: a scroll the finger did not make (opening at the bottom, the composer growing, a
  // re-pin) must not flash the floating date over a message or the «Новые сообщения» divider.
  const fingerDown = useRef(false);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const down = (): void => {
      fingerDown.current = true;
    };
    root.addEventListener('touchstart', down, { passive: true });
    return () => root.removeEventListener('touchstart', down);
  }, []);

  // The floating date and the scrolling flag change while scrolling: only FeedOverlays reads them
  // (a Feed render re-runs every mounted row's renderer).
  const [view] = useState(createScrollView);
  const frame = useRef(0);
  // Telegram: the floating date shows while scrolling and fades out 1 s after it stops; the
  // overlay scrollbar (styles.css, non-mac) follows the same [data-scrolling] flag.
  const idle = useRef(0);
  const onScroll = useCallback(() => {
    if (scroller.current) bottomPin.scrolled(scroller.current);
    const programmatic = !fingerDown.current && window.matchMedia('(pointer: coarse)').matches;
    if (!programmatic) view.setScrolling(true);
    scroller.current?.setAttribute('data-scrolling', '');
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      fingerDown.current = false;
      view.setScrolling(false);
      scroller.current?.removeAttribute('data-scrolling');
    }, STICKY_IDLE_MS);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const rows = el.querySelectorAll<HTMLElement>('[data-message-id]');
      const list = Array.from(rows);
      const i = list.findIndex((row) => row.getBoundingClientRect().bottom > top + 8);
      const row = list[i];
      if (row) {
        const r = row.getBoundingClientRect();
        const pillInView = row.dataset['dayStart'] === '1' && r.top >= top - 4;
        // The next day's pill is about to reach the top: let it take over (no two pills at once).
        const nextPillNear = list.slice(i + 1, i + 4).some((n) => n.dataset['dayStart'] === '1' && n.getBoundingClientRect().top < top + 72);
        view.setSticky(pillInView || nextPillNear || el.scrollTop < 8 ? null : (row.dataset['messageId'] ?? null));
        return;
      }
      view.setSticky(null);
    });
  }, [bottomPin, view]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(idle.current);
    },
    [],
  );

  const context = useMemo<FeedContext>(
    () => ({
      workspaceId,
      roomId,
      room,
      perms,
      me,
      metas,
      firstIndex,
      highlight,
      hasMoreBefore: state.hasMoreBefore,
      hasMoreAfter: state.hasMoreAfter,
      loading: state.loading,
    }),
    [workspaceId, roomId, room, perms, me, metas, firstIndex, highlight, state.hasMoreBefore, state.hasMoreAfter, state.loading],
  );

  return (
    <div className="relative min-h-0 flex-1 bg-feed">
      <Virtuoso
        ref={virtuoso}
        // Never a horizontal scroll in the feed (docs/09 #74): rows clip, the action bar is clamped.
        className="h-full overflow-x-hidden"
        data={items}
        context={context}
        firstItemIndex={firstIndex}
        initialTopMostItemIndex={initialIndex}
        startReached={startReached}
        rangeChanged={rangeChanged}
        endReached={endReached}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={48}
        // Measure rows in the ResizeObserver callback, before paint, not a frame later: a row
        // mounted while scrolling whose real height differs from the estimate otherwise paints one
        // frame with the whole feed shifted by the difference (the «flicker» while scrolling).
        skipAnimationFrameInResizeObserver
        scrollerRef={scrollerRef}
        onScroll={onScroll}
        increaseViewportBy={INCREASE_VIEWPORT}
        computeItemKey={itemKey}
        components={FEED_COMPONENTS}
        itemContent={feedRow}
      />
      <FeedOverlays
        roomId={roomId}
        items={items}
        metas={metas}
        me={me}
        newMarker={newMarker}
        lastSentId={lastSentId}
        hasMoreAfter={state.hasMoreAfter}
        atBottom={atBottom}
        mini={mini}
        view={view}
        virtuoso={virtuoso}
      />
    </div>
  );
}

/**
 * The unread banner, the floating date and the «to bottom» button: the only parts of the feed
 * that read the read marker and the room's newest id, so a message read at the bottom (upsert,
 * then markRead → setRead) renders the feed once and only this leaf a second time.
 */
const FeedOverlays = memo(function FeedOverlays({
  roomId,
  items,
  metas,
  me,
  newMarker,
  lastSentId,
  hasMoreAfter,
  atBottom,
  mini,
  view,
  virtuoso,
}: {
  roomId: string;
  items: readonly ChatMessage[];
  metas: readonly RowMeta[];
  me: string;
  newMarker: string;
  lastSentId: string;
  hasMoreAfter: boolean;
  atBottom: boolean;
  mini: boolean;
  view: ScrollView;
  virtuoso: RefObject<VirtuosoHandle | null>;
}): ReactNode {
  const stickyKey = useSyncExternalStore(view.subscribe, view.sticky);
  const scrolling = useSyncExternalStore(view.subscribe, view.scrolling);
  const readMarker = useRooms((s) => s.readState[roomId] ?? '');
  const newestKnown = useRooms((s) => s.lastMessage[roomId] ?? '');
  // The stream stage lies over this feed: scrolling it to the first unread would happen out of
  // sight (issue #110), so the banner opens the chat as the stage's «Chat» button does.
  const covered = useVoice((s) => streamCoversChat(s, roomId));

  const firstUnread = useMemo(() => firstUnreadIndex(items, readMarker, me), [items, readMarker, me]);
  const unread = useMemo(() => {
    if (firstUnread < 0) return 0;
    let n = 0;
    for (let i = firstUnread; i < items.length; i++) {
      const c = items[i];
      if (c && c.status === 'sent' && c.msg.authorId !== me) n++;
    }
    return n;
  }, [items, firstUnread, me]);
  const moreUnread = hasMoreAfter && newestKnown > lastSentId;

  const toBottom = (): void => {
    if (hasMoreAfter) {
      void loadPresent(roomId).then(() => virtuoso.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' }));
      return;
    }
    virtuoso.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
  };
  const toFirstUnread = (): void => {
    const i = metas.findIndex((m) => m.isNew);
    const at = i >= 0 ? i : firstUnread;
    if (at >= 0) virtuoso.current?.scrollToIndex({ index: at, align: 'start', offset: -40, behavior: 'smooth' });
  };

  const stickyMsg = stickyKey ? findByKey(items, stickyKey) : undefined;
  const stickyDate = stickyMsg ? toDate(stickyMsg.msg.createdAt) : null;
  const showBanner = !!newMarker && unread > 0;
  const firstUnreadMsg = firstUnread >= 0 ? items[firstUnread] : undefined;

  return (
    <>
      {showBanner && firstUnreadMsg ? (
        <div
          className={cx(
            'absolute z-[var(--z-sticky)] flex h-8 items-center gap-2 bg-accent-strong pl-4 pr-2 text-body text-accent-fg shadow-[var(--shadow-card)]',
            // Over a stream stage: below its streamer chip / «Chat» button row, not on top of them.
            covered ? 'inset-x-3 top-[3.75rem] rounded-[var(--radius-control)]' : cx('inset-x-0', mini ? 'top-11 mobile:top-12' : 'top-0'),
          )}
          data-testid="unread-banner"
        >
          <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium hover:underline" onClick={covered ? () => voice.setStage('pip') : toFirstUnread}>
            {plural('chat.unreadBanner', unread, {
              n: `${unread}${moreUnread ? '+' : ''}`,
              time: fmt.time(toDate(firstUnreadMsg.msg.createdAt)),
            })}
          </button>
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-[var(--radius-control)] px-2 py-1 font-semibold hover:bg-[rgb(255_255_255/15%)]"
            onClick={() => markRead(roomId, newestKnown > lastSentId ? newestKnown : lastSentId)}
          >
            {t('chat.markRead')}
          </button>
        </div>
      ) : null}

      {stickyDate ? (
        <div
          className={cx(
            'pointer-events-none absolute inset-x-0 z-[var(--z-sticky)] flex justify-center transition-opacity duration-[var(--motion)] ease-out',
            mini ? (showBanner ? 'top-[5.25rem] mobile:top-[5.5rem]' : 'top-[3.25rem] mobile:top-14') : showBanner ? 'top-10' : 'top-2',
            scrolling ? 'opacity-100' : 'opacity-0',
            // Phone: shown only while scrolling — never a static pill over messages / link previews.
            'mobile:data-[idle]:hidden',
          )}
          data-idle={scrolling ? undefined : ''}
        >
          <DatePill date={stickyDate} floating />
        </div>
      ) : null}

      {!atBottom || hasMoreAfter ? (
        <Tip label={t('chat.toBottom')} side="left">
        <button
          type="button"
          onClick={toBottom}
          aria-label={unread ? t('chat.toBottomUnread', { n: unread }) : t('chat.toBottom')}
          className="mat-popover anim-in absolute bottom-4 right-5 z-[var(--z-sticky)] grid size-11 place-items-center rounded-full text-muted hover:text-fg"
        >
          <ArrowDown className="size-5" />
          {unread ? (
            <span className="absolute -top-2 left-1/2 min-w-5 -translate-x-1/2 rounded-full bg-accent-strong px-1.5 py-0.5 text-center text-micro font-semibold leading-none text-accent-fg">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
        </Tip>
      ) : null}
    </>
  );
});

/** The floating date's row and «scrolling now»: set from the feed's scroll handler, read by FeedOverlays only. */
interface ScrollView {
  sticky: () => string | null;
  scrolling: () => boolean;
  setSticky: (key: string | null) => void;
  setScrolling: (v: boolean) => void;
  subscribe: (f: () => void) => () => void;
}

function createScrollView(): ScrollView {
  let sticky: string | null = null;
  let scrolling = false;
  const subs = new Set<() => void>();
  const emit = (): void => subs.forEach((f) => f());
  return {
    sticky: () => sticky,
    scrolling: () => scrolling,
    setSticky: (key) => {
      if (key === sticky) return;
      sticky = key;
      emit();
    },
    setScrolling: (v) => {
      if (v === scrolling) return;
      scrolling = v;
      emit();
    },
    subscribe: (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

const FALLBACK_META: RowMeta = { day: false, isNew: false, first: true, last: true };

/** Top of the history: what this room is (a DM: who it is with, ADR-0020). */
function HistoryStart({ room }: { room: Room }): ReactNode {
  if (room.type === RoomType.DM) return <DmHistoryStart roomId={room.id} />;
  if (room.type === RoomType.NOTES) return <NotesHistoryStart room={room} />;
  const voice = room.type === RoomType.VOICE;
  const Icon = voice ? Volume2 : Hash;
  return (
    <div className="flex flex-col items-center px-4 pb-2 pt-8 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent-text">
        <Icon className="size-7" strokeWidth={1.5} aria-hidden />
      </span>
      <div className="mt-2 text-headline font-semibold">{voice ? t('chat.welcomeVoiceTitle', { name: room.name }) : t('chat.welcomeTitle', { name: room.name })}</div>
      <div className="text-body text-muted">{t('chat.historyStart')}</div>
    </div>
  );
}

/** A notes shelf's start (ADR-0039): its emoji and name, «only you see it», the drag-and-drop hint. */
function NotesHistoryStart({ room }: { room: Room }): ReactNode {
  const emoji = useNotes((s) => s.byRoom[room.id]?.emoji ?? '');
  const name = useNotes((s) => s.byRoom[room.id]?.name ?? room.name);
  return (
    <div className="flex flex-col items-center px-4 pb-2 pt-8 text-center">
      <span className="grid size-14 place-items-center rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[28px] leading-none text-accent-text">
        {emoji || <NotebookText className="size-7" strokeWidth={1.5} aria-hidden />}
      </span>
      <div className="mt-2 text-headline font-semibold">{name}</div>
      <div className="max-w-sm text-body text-muted">{t('notes.welcomeText')}</div>
    </div>
  );
}

function DmHistoryStart({ roomId }: { roomId: string }): ReactNode {
  const peerId = useDms((s) => s.byRoom[roomId]?.peerId ?? '');
  const name = useMemberName(null, peerId);
  const avatar = useWorkspaces((s) => s.users[peerId]?.avatarFileId ?? '');
  return (
    <div className="flex flex-col items-center px-4 pb-2 pt-8 text-center">
      <ProfileTarget userId={peerId} name={name} tabbable className="rounded-full">
        <Avatar userId={peerId} name={name} fileId={avatar || undefined} size={56} />
      </ProfileTarget>
      <div className="mt-2 text-headline font-semibold">{name}</div>
      <div className="text-body text-muted">{t('dm.welcomeText', { name })}</div>
    </div>
  );
}
