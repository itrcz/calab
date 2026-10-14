import type { PermissionBits, Room } from '@calaba/protocol';
import { ArrowDown, Hash, NotebookText, Volume2 } from 'lucide-react';
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageKind, RoomType } from '@calaba/protocol';
import { Spinner, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { ensureLoaded, loadNewer, loadOlder, loadPresent, markRead, reloadRoom, STALE_LOAD_MS } from '../../services/chat';
import { log } from '../../lib/log';
import { EMPTY_ROOM_MESSAGES, WINDOW_CAP, findByKey, firstUnreadIndex, keyIndex, lastSentId as lastSentOf, useMessages, type ChatMessage } from '../../stores/messages';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { streamCoversChat, useVoice } from '../../stores/voice';
import { useStreamFullscreen } from '../voice/fullscreen';
import { toast } from '../../stores/toasts';
import { useChatView } from './chatView';
import { createMetaBuilder, type RowMeta } from './grouping';
import { createBottomPin, initialFeedLocation } from './lastRowPin';
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
  if (!loaded) return <FirstLoad roomId={room.id} error={error} />;
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
function FirstLoad({ roomId, error }: { roomId: string; error: string | null }): ReactNode {
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
    void reloadRoom(roomId);
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

function feedRow(index: number, c: ChatMessage, x: FeedContext): ReactNode {
  const meta = x.metas[index - x.firstIndex] ?? FALLBACK_META;
  return (
    <RowBoundary id={c.key}>
      {c.msg.kind === MessageKind.SYSTEM ? (
        <SystemRow c={c} meta={meta} workspaceId={x.workspaceId} perms={x.perms} highlighted={x.highlight === c.key} />
      ) : (
        <MessageRow
          c={c}
          meta={meta}
          own={c.msg.authorId === x.me}
          workspaceId={x.workspaceId}
          roomId={x.roomId}
          perms={x.perms}
          highlighted={x.highlight === c.key}
        />
      )}
    </RowBoundary>
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

  // Opens at the first unread message (docs/09 #39), otherwise at the last row's bottom.
  // docs/09 #149: the last row growing in place (reaction, upload → preview, image/link preview,
  // edit) or the composer growing is no new item, so followOutput never sees it (lastRowPin.ts).
  const [{ location: initialIndex, stuck: openStuck }] = useState(() => initialFeedLocation(metas.findIndex((m) => m.isNew), state.hasMoreAfter));
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
      if (document.hasFocus()) markRead(roomId, lastSentId);
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
  const endReached = useCallback(() => {
    if (state.hasMoreAfter) void loadNewer(roomId);
  }, [roomId, state.hasMoreAfter]);

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (state.hasMoreAfter) return false;
      const last = items[items.length - 1];
      if (last && last.msg.authorId === me && last.status !== 'sent') return 'auto';
      return isAtBottom ? 'smooth' : false;
    },
    [items, me, state.hasMoreAfter],
  );
  // Layout effects: a window loaded away from the present must stop the pin before the next
  // ResizeObserver delivery (which precedes passive effects), or it would chase endReached.
  useLayoutEffect(() => bottomPin.setLive(!state.hasMoreAfter), [bottomPin, state.hasMoreAfter]);
  const lastKey = items[items.length - 1]?.key ?? '';
  const lastKeyRef = useRef(lastKey);
  useLayoutEffect(() => {
    lastKeyRef.current = lastKey;
  }, [lastKey]);

  // Floating date: the day of the topmost visible row, hidden while that day's own pill is in view.
  const scroller = useRef<HTMLElement | null>(null);
  const scrollerRef = useCallback((r: HTMLElement | Window | null) => {
    scroller.current = r instanceof HTMLElement ? r : null;
  }, []);

  // docs/09 #149: keep the bottom while stuck to it. One observer, no per-render or per-frame
  // work, on two elements: the scroller (its height — the composer growing, the window resizing)
  // and Virtuoso's item list (the rendered rows' height — any row changing size, the last one
  // included). A new last message is left to followOutput, so incoming ones still scroll smoothly.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let seenKey = lastKeyRef.current;
    const ro = new ResizeObserver(() => {
      const fresh = seenKey !== lastKeyRef.current;
      seenKey = lastKeyRef.current;
      if (bottomPin.resized(root) && !fresh) root.scrollTop = root.scrollHeight;
    });
    ro.observe(root);
    const list = root.querySelector('[data-testid="virtuoso-item-list"]');
    if (list) ro.observe(list);
    return () => ro.disconnect();
  }, [bottomPin]);

  const [sticky, setSticky] = useState<string | null>(null);
  const frame = useRef(0);
  // Telegram: the floating date shows while scrolling and fades out 1 s after it stops; the
  // overlay scrollbar (styles.css, non-mac) follows the same [data-scrolling] flag.
  const [scrolling, setScrolling] = useState(false);
  const idle = useRef(0);
  const onScroll = useCallback(() => {
    if (scroller.current) bottomPin.scrolled(scroller.current);
    setScrolling(true);
    scroller.current?.setAttribute('data-scrolling', '');
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      setScrolling(false);
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
        setSticky(pillInView || nextPillNear || el.scrollTop < 8 ? null : (row.dataset['messageId'] ?? null));
        return;
      }
      setSticky(null);
    });
  }, [bottomPin]);
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
        endReached={endReached}
        followOutput={followOutput}
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
        stickyKey={sticky}
        scrolling={scrolling}
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
  stickyKey,
  scrolling,
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
  stickyKey: string | null;
  scrolling: boolean;
  virtuoso: RefObject<VirtuosoHandle | null>;
}): ReactNode {
  const readMarker = useRooms((s) => s.readState[roomId] ?? '');
  const newestKnown = useRooms((s) => s.lastMessage[roomId] ?? '');

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
            'absolute inset-x-0 z-[var(--z-sticky)] flex h-8 items-center gap-2 bg-accent-strong pl-4 pr-2 text-body text-accent-fg shadow-[var(--shadow-card)]',
            mini ? 'top-11 mobile:top-12' : 'top-0',
          )}
          data-testid="unread-banner"
        >
          <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={toFirstUnread}>
            {plural('chat.unreadBanner', unread, {
              n: `${unread}${moreUnread ? '+' : ''}`,
              time: fmt.time(toDate(firstUnreadMsg.msg.createdAt)),
            })}
          </button>
          <button
            type="button"
            className="shrink-0 rounded-[var(--radius-control)] px-2 py-1 font-semibold hover:bg-[rgb(255_255_255/15%)]"
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
