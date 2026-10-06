import * as Popover from '@radix-ui/react-popover';
import { AtSign, Hash, Inbox, Volume2 } from 'lucide-react';
import type { Message } from '@calaba/protocol';
import { memo, useCallback, useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { CountBadge, Empty, Spinner, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt, toDate } from '../../lib/format';
import { systemPreview } from '../../lib/recording';
import { loadMentions } from '../../services/mentions';
import { useInbox } from '../../stores/inbox';
import { inboxBadgeCount, unreadInboxItems } from '../../stores/inboxUnread';
import { isVoice, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from '../chat/chatView';
import { usePreviewText } from '../chat/mentionText';
import { popoverBox } from './menu';


/** Moves the room's read marker forward to `messageId` (local + server; markers never go back). */
function markReadUpTo(roomId: string, messageId: string): void {
  useRooms.getState().setRead(roomId, messageId);
  void api.messages.markRead(roomId, messageId).catch(() => undefined);
}

/**
 * Mentions inbox (docs/09 #1): history from GET /api/me/mentions (all workspaces, newest
 * first) merged with live mentions. Only unread mentions are listed and counted: «read» is the
 * room's read marker being at or after the mention (stores/inboxUnread.ts).
 */
export function InboxButton(): ReactNode {
  const ready = useSession((s) => s.ready);
  // History mentions (from before this session) belong in the badge from the start.
  useEffect(() => {
    if (ready && !useInbox.getState().loaded) void loadMentions();
  }, [ready]);
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) void loadMentions();
      }}
    >
      <Tip label={t('shell.inbox')}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={t('shell.inbox')}
            className="relative grid size-7 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
          >
            <Inbox className="size-[18px]" aria-hidden />
            <InboxBadge />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16} aria-label={t('shell.inbox')} className={cx(popoverBox, 'w-[380px] p-0')}>
          <InboxList />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Leaf: re-renders only when the number itself changes. */
function InboxBadge(): ReactNode {
  const items = useInbox((s) => s.items);
  const loaded = useInbox((s) => s.loaded);
  const hasMore = useInbox((s) => s.hasMore);
  const total = useRooms((s) => inboxBadgeCount({ items, loaded, hasMore }, s.readState, s.mentions, s.byId));
  if (total <= 0) return null;
  return (
    <CountBadge count={total} data-testid="inbox-badge" role="status" aria-label={`${t('shell.inbox')}: ${total}`} className="absolute -right-1 -top-1" />
  );
}

function InboxList(): ReactNode {
  const all = useInbox((s) => s.items);
  const loaded = useInbox((s) => s.loaded);
  const loading = useInbox((s) => s.loading);
  const hasMore = useInbox((s) => s.hasMore);
  // Only unread mentions of rooms (and workspaces) this client still knows: access may have changed.
  const items = useRooms(
    useShallow((s) => unreadInboxItems(all, s.readState, (id) => !!s.byId[id] && !!useWorkspaces.getState().byId[s.byId[id].workspaceId])),
  );
  const markAll = useCallback((): void => {
    // Per room: the newer of its newest unread mention and its last known message.
    const newest = new Map<string, string>();
    for (const m of items) if (m.id > (newest.get(m.roomId) ?? '')) newest.set(m.roomId, m.id);
    const rooms = useRooms.getState();
    for (const [roomId, mid] of newest) {
      const last = rooms.lastMessage[roomId];
      markReadUpTo(roomId, last && last > mid ? last : mid);
    }
  }, [items]);
  return (
    <div className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="flex items-center gap-1.5 text-body font-semibold">
          <AtSign className="size-4 text-muted" aria-hidden />
          {t('shell.inbox')}
        </span>
        {items.length ? (
          <button type="button" onClick={markAll} className="rounded-[var(--radius-control)] px-1.5 py-0.5 text-caption text-accent-text hover:bg-hover">
            {t('shell.inboxMarkRead')}
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        !loaded && loading ? (
          <div className="grid place-items-center py-8">
            <Spinner />
          </div>
        ) : (
          <Empty>
            <div className="font-semibold text-fg">{t('shell.inboxEmpty')}</div>
            <div className="mt-1 text-caption">{t('shell.inboxHint')}</div>
          </Empty>
        )
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {items.map((m) => (
            <InboxItem key={m.id} m={m} />
          ))}
          {hasMore ? (
            <li className="flex justify-center py-1">
              <button
                type="button"
                disabled={loading}
                onClick={() => void loadMentions(true)}
                className="rounded-[var(--radius-control)] px-2 py-1 text-caption text-accent-text hover:bg-hover disabled:opacity-40"
              >
                {t('chat.inboxLoadMore')}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

const InboxItem = memo(function InboxItem({ m }: { m: Message }): ReactNode {
  const room = useRooms((s) => s.byId[m.roomId]);
  const wsId = room?.workspaceId ?? null;
  const wsName = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.name : undefined));
  const author = useMemberName(wsId, m.authorId);
  const avatar = useWorkspaces((s) => s.users[m.authorId]?.avatarFileId);
  // Re-renders on nickname changes of mentioned people only.
  const preview = usePreviewText(wsId, m.content);
  const text = systemPreview(m) || preview || t('chat.attachment');
  const openRoom = useUi((s) => s.openRoom);
  if (!room) return null;
  const Icon = isVoice(room) ? Volume2 : Hash;
  const d = toDate(m.createdAt);
  return (
    <li>
      <Popover.Close asChild>
        <button
          type="button"
          onClick={() => {
            // Opening the message reads it: the marker moves to it, so it leaves the list.
            markReadUpTo(m.roomId, m.id);
            openRoom(room.workspaceId, room.id);
            useChatView.getState().requestJump(room.id, m.id);
          }}
          className="flex w-full items-start gap-2.5 rounded-[var(--radius-row)] px-2 py-2 text-left hover:bg-hover"
        >
          <Avatar userId={m.authorId} name={author} fileId={avatar || undefined} size={28} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate text-body font-semibold" title={author}>
                {author}
              </span>
              <span className="ml-auto shrink-0 text-micro text-muted">
                {fmt.dayLabel(d)}, {fmt.time(d)}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-caption text-muted">
              <Icon className="size-3 shrink-0" aria-hidden />
              <span className="truncate" title={`${room.name} · ${wsName ?? ''}`}>
                {room.name} · {wsName}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 break-words text-body text-fg">{text}</span>
          </span>
        </button>
      </Popover.Close>
    </li>
  );
});
