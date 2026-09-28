import type { PermissionBits, Room } from '@calaba/protocol';
import { ArrowDown, Hash, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageKind, RoomType } from '@calaba/protocol';
import { Spinner, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { ensureLoaded, loadNewer, loadOlder, loadPresent, markRead } from '../../services/chat';
import { EMPTY_ROOM_MESSAGES, useMessages, type ChatMessage } from '../../stores/messages';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { toast } from '../../stores/toasts';
import { useChatView } from './chatView';
import { buildMetas, type RowMeta } from './grouping';
import { DatePill, MessageRow, SystemRow } from './MessageBubble';
import { useMiniPlayerShown } from './MediaPlayer';
import { EmptyRoom } from './RoomPanels';
import { Avatar } from '../../components/Avatar';
import { useDms } from '../../stores/dms';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';

const START_INDEX = 1_000_000;
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
  const state = useMessages((s) => s.rooms[room.id] ?? EMPTY_ROOM_MESSAGES);
  if (!state.loaded) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-feed">
        {state.error ? (
          <button type="button" className="text-danger-text hover:underline" onClick={() => void loadOlder(room.id)}>
            {state.error} · {t('common.retry')}
          </button>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  if (state.items.length === 0 && !state.hasMoreBefore && !state.hasMoreAfter) {
    return <EmptyRoom workspaceId={workspaceId} room={room} perms={perms} underStage={underStage} />;
  }
  return <Feed workspaceId={workspaceId} room={room} perms={perms} newMarker={newMarker} />;
}

/** The virtualised feed; mounted once the first window is loaded (so the initial position is known). */
function Feed({ workspaceId, room, perms, newMarker }: { workspaceId: string; room: Room; perms: PermissionBits; newMarker: string }): ReactNode {
  const roomId = room.id;
  const state = useMessages((s) => s.rooms[roomId] ?? EMPTY_ROOM_MESSAGES);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const readMarker = useRooms((s) => s.readState[roomId] ?? '');
  const newestKnown = useRooms((s) => s.lastMessage[roomId] ?? '');
  const highlight = useChatView((s) => s.highlight);
  const jump = useChatView((s) => s.jump);
  // The mini-player covers the feed's top strip: the unread banner and the date pill go below it.
  const mini = useMiniPlayerShown();
  const items = state.items;
  const virtuoso = useRef<VirtuosoHandle>(null);
  // False until Virtuoso reports it: opening at the first unread must not mark the room read.
  const [atBottom, setAtBottom] = useState(false);

  // Grouping, memoised per message (unchanged rows keep their meta object → no re-render).
  const [cache] = useState(() => new Map<string, RowMeta>());
  const metas = useMemo(() => buildMetas(items, newMarker, me, cache), [items, newMarker, me, cache]);

  // Prepending keeps the scroll position via Virtuoso's firstItemIndex (derived during render).
  const [track, setTrack] = useState(() => ({ first: items[0]?.key, index: START_INDEX }));
  let firstIndex = track.index;
  if (items[0]?.key !== track.first) {
    const k = track.first ? items.findIndex((c) => c.key === track.first) : -1;
    firstIndex = k > 0 ? track.index - k : track.index;
    setTrack({ first: items[0]?.key, index: firstIndex });
  }

  // Opens at the first unread message (docs/09 #39), otherwise at the bottom.
  const [initialIndex] = useState(() => {
    const i = metas.findIndex((m) => m.isNew);
    return i >= 0 ? { index: i, align: 'start' as const, offset: -40 } : Math.max(0, items.length - 1);
  });

  const lastSentId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i];
      if (c?.status === 'sent') return c.msg.id;
    }
    return '';
  }, [items]);

  const firstUnread = useMemo(
    () => items.findIndex((c) => c.status === 'sent' && !!readMarker && c.msg.id > readMarker && c.msg.authorId !== me),
    [items, readMarker, me],
  );
  const unread = useMemo(() => {
    if (firstUnread < 0) return 0;
    let n = 0;
    for (let i = firstUnread; i < items.length; i++) {
      const c = items[i];
      if (c && c.status === 'sent' && c.msg.authorId !== me) n++;
    }
    return n;
  }, [items, firstUnread, me]);
  const moreUnread = state.hasMoreAfter && newestKnown > lastSentId;

  // Read state: the newest message is on screen and the window is focused.
  useEffect(() => {
    if (!atBottom || !lastSentId) return;
    const mark = (): void => {
      if (document.hasFocus()) markRead(roomId, lastSentId);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [atBottom, lastSentId, roomId]);

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
          const i = useMessages.getState().rooms[roomId]?.items.findIndex((c) => c.key === target) ?? -1;
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

  // Floating date: the day of the topmost visible row, hidden while that day's own pill is in view.
  const scroller = useRef<HTMLElement | null>(null);
  const [sticky, setSticky] = useState<string | null>(null);
  const frame = useRef(0);
  // Telegram: the floating date shows while scrolling and fades out 1 s after it stops; the
  // overlay scrollbar (styles.css, non-mac) follows the same [data-scrolling] flag.
  const [scrolling, setScrolling] = useState(false);
  const idle = useRef(0);
  const onScroll = useCallback(() => {
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
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(idle.current);
    },
    [],
  );

  const toBottom = (): void => {
    if (state.hasMoreAfter) {
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

  const stickyMsg = sticky ? items.find((c) => c.key === sticky) : undefined;
  const stickyDate = stickyMsg ? toDate(stickyMsg.msg.createdAt) : null;
  const showBanner = !!newMarker && unread > 0;
  const firstUnreadMsg = firstUnread >= 0 ? items[firstUnread] : undefined;

  return (
    <div className="relative min-h-0 flex-1 bg-feed">
      <Virtuoso
        ref={virtuoso}
        // Never a horizontal scroll in the feed (docs/09 #74): rows clip, the action bar is clamped.
        className="h-full overflow-x-hidden"
        data={items}
        firstItemIndex={firstIndex}
        initialTopMostItemIndex={initialIndex}
        startReached={startReached}
        endReached={endReached}
        followOutput={followOutput}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={48}
        scrollerRef={(r) => {
          scroller.current = r instanceof HTMLElement ? r : null;
        }}
        onScroll={onScroll}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        computeItemKey={(_i, c: ChatMessage) => c.key}
        components={{
          Header: () =>
            state.hasMoreBefore ? (
              <div className="grid h-12 place-items-center">{state.loading ? <Spinner /> : null}</div>
            ) : (
              <HistoryStart room={room} />
            ),
          Footer: () => (state.hasMoreAfter ? <div className="grid h-12 place-items-center"><Spinner /></div> : <div className="h-3" />),
        }}
        itemContent={(index, c: ChatMessage) => {
          const meta = metas[index - firstIndex] ?? FALLBACK_META;
          if (c.msg.kind === MessageKind.SYSTEM)
            return <SystemRow c={c} meta={meta} workspaceId={workspaceId} perms={perms} highlighted={highlight === c.key} />;
          return (
            <MessageRow
              c={c}
              meta={meta}
              own={c.msg.authorId === me}
              workspaceId={workspaceId}
              roomId={roomId}
              perms={perms}
              highlighted={highlight === c.key}
            />
          );
        }}
      />

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
          )}
          data-idle={scrolling ? undefined : ''}
        >
          <DatePill date={stickyDate} floating />
        </div>
      ) : null}

      {!atBottom || state.hasMoreAfter ? (
        <Tip label={t('chat.toBottom')} side="left">
        <button
          type="button"
          onClick={toBottom}
          aria-label={unread ? t('chat.toBottomUnread', { n: unread }) : t('chat.toBottom')}
          className="mat-popover anim-in absolute bottom-4 right-5 z-[var(--z-sticky)] grid size-10 place-items-center rounded-full text-muted hover:text-fg"
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
    </div>
  );
}

const FALLBACK_META: RowMeta = { day: false, isNew: false, first: true, last: true };

/** Top of the history: what this room is (a DM: who it is with, ADR-0020). */
function HistoryStart({ room }: { room: Room }): ReactNode {
  if (room.type === RoomType.DM) return <DmHistoryStart roomId={room.id} />;
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

function DmHistoryStart({ roomId }: { roomId: string }): ReactNode {
  const peerId = useDms((s) => s.byRoom[roomId]?.peerId ?? '');
  const name = useMemberName(null, peerId);
  const avatar = useWorkspaces((s) => s.users[peerId]?.avatarFileId ?? '');
  return (
    <div className="flex flex-col items-center px-4 pb-2 pt-8 text-center">
      <Avatar userId={peerId} name={name} fileId={avatar || undefined} size={56} />
      <div className="mt-2 text-headline font-semibold">{name}</div>
      <div className="text-body text-muted">{t('dm.welcomeText', { name })}</div>
    </div>
  );
}
