import * as Popover from '../../components/radix/popover';
import { AtSign, Hash, Inbox, SquareCheckBig, Volume2, X } from 'lucide-react';
import { TaskPriority, type Message, type Task, type TaskNoticeEntry } from '@calaba/protocol';
import { memo, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { CountBadge, Empty, IconButton, Spinner, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { systemPreview } from '../../lib/recording';
import { noticeText } from '../../services/boards';
import { openTaskOrTab } from '../../services/taskTab';
import { dismissInboxItem, loadMentions, markReadUpTo } from '../../services/mentions';
import { useBoards } from '../../stores/boards';
import { useInbox } from '../../stores/inbox';
import { inboxBadgeCount, inboxRows, unreadInboxItems, unreadNoticeTasks } from '../../stores/inboxUnread';
import { idAfter, isVoice, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from '../chat/chatView';
import { usePreviewText } from '../chat/mentionText';
import { popoverBox } from './menu';

/**
 * Mentions inbox (docs/09 #1, ADR-0141): chat mentions (GET /api/me/mentions, all workspaces) and
 * task notices (GET /api/me/task-notices), merged with the live ones, newest first. Read items
 * stay listed; unread ones carry a dot. The badge counts unread mentions («read» is the room's
 * read marker being at or after the mention, stores/inboxUnread.ts) plus the tasks with an unread
 * notice here (the boards' unread set, one per task).
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
            data-bar-ctl
            className="relative grid size-(--control-h-bar) place-items-center rounded-full text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
          >
            <Inbox className="size-[18px]" aria-hidden />
            <InboxBadge />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16} data-inbox-popover aria-label={t('shell.inbox')} className={cx(popoverBox, 'w-[380px] p-0')}>
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
  const notices = useInbox((s) => s.notices);
  const chats = useRooms((s) => inboxBadgeCount({ items, loaded, hasMore }, s.readState, s.mentions, s.byId));
  // Unread task notices count like mentions (bug #146): the badge is the whole inbox's unread.
  const tasks = useBoards((s) => unreadNoticeTasks(notices, s.unread));
  const total = chats + tasks;
  if (total <= 0) return null;
  return (
    <CountBadge count={total} data-testid="inbox-badge" role="status" aria-label={`${t('shell.inbox')}: ${total}`} className="absolute -right-1 -top-1" />
  );
}

function InboxList(): ReactNode {
  const all = useInbox((s) => s.items);
  const notices = useInbox((s) => s.notices);
  const loaded = useInbox((s) => s.loaded);
  const loading = useInbox((s) => s.loading);
  const more = useInbox((s) => s.hasMore || s.noticesHasMore);
  // Mentions of rooms (and workspaces) this client still knows, task notices of known
  // workspaces: access may have changed (the server rechecks on every load).
  const mentions = useRooms(
    useShallow((s) =>
      all.filter((m) => {
        const room = s.byId[m.roomId];
        return !!room && !!useWorkspaces.getState().byId[room.workspaceId];
      }),
    ),
  );
  const tasks = useWorkspaces(useShallow((s) => notices.filter((e) => !!s.byId[e.workspaceId])));
  const unread = useRooms(useShallow((s) => unreadInboxItems(mentions, s.readState)));
  const rows = useMemo(() => inboxRows(mentions, tasks), [mentions, tasks]);
  const markAll = useCallback((): void => {
    // Per room: the newer of its newest unread mention and its last known message.
    const newest = new Map<string, string>();
    for (const m of unread) if (m.id > (newest.get(m.roomId) ?? '')) newest.set(m.roomId, m.id);
    const rooms = useRooms.getState();
    for (const [roomId, mid] of newest) {
      const last = rooms.lastMessage[roomId];
      markReadUpTo(roomId, last && last > mid ? last : mid);
    }
  }, [unread]);
  return (
    <div className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="flex items-center gap-1.5 text-body font-semibold">
          <AtSign className="size-4 text-muted" aria-hidden />
          {t('shell.inbox')}
        </span>
        {unread.length ? (
          <button type="button" onClick={markAll} className="rounded-[var(--radius-control)] px-1.5 py-0.5 text-caption text-accent-text hover:bg-hover">
            {t('shell.inboxMarkRead')}
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
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
          {rows.map((r) => (r.m ? <InboxItem key={r.id} m={r.m} /> : r.e ? <NoticeItem key={r.id} e={r.e} latest={r.latest} /> : null))}
          {more ? (
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

/** «Не прочитано»: an accent dot before the time (the row's own primitive selector decides). */
function UnreadDot(): ReactNode {
  return <span role="img" aria-label={t('shell.inboxUnread')} className="size-2 shrink-0 self-center rounded-full bg-accent" />;
}

/** The card's own button: room on the right for the ✕ (44 px on the phone). */
const ROW_BTN = 'flex w-full items-start gap-2.5 rounded-[var(--radius-row)] py-2 pl-2 pr-9 text-left hover:bg-hover mobile:pr-12';

/**
 * The ✕ in the card's top-right corner (CBF-155, ADR-0163): a sibling of the card's button (a
 * button cannot nest one), outside Popover.Close so the popover stays open.
 */
function DismissButton({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <IconButton label={t('shell.inboxDismiss')} size="sm" data-inbox-dismiss onClick={onClick} className="absolute right-0.5 top-0.5">
      <X className="size-4" strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
}

const InboxItem = memo(function InboxItem({ m }: { m: Message }): ReactNode {
  const room = useRooms((s) => s.byId[m.roomId]);
  const unread = useRooms((s) => idAfter(m.id, s.readState[m.roomId]));
  const wsId = room?.workspaceId ?? null;
  const wsName = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.name : undefined));
  const author = useMemberName(wsId, m.authorId);
  const avatar = useWorkspaces((s) => s.users[m.authorId]?.avatarFileId);
  // Re-renders on nickname changes of mentioned people only.
  const preview = usePreviewText(wsId, m.content);
  const text = systemPreview(m) || preview || t('chat.attachment');
  const openRoom = useUi((s) => s.openRoom);
  const dismiss = useCallback(() => void dismissInboxItem({ m }), [m]);
  if (!room) return null;
  const Icon = isVoice(room) ? Volume2 : Hash;
  const d = toDate(m.createdAt);
  return (
    <li className="relative">
      <Popover.Close asChild>
        <button
          type="button"
          onClick={() => {
            // Opening the message reads it: the marker moves to it.
            markReadUpTo(m.roomId, m.id);
            openRoom(room.workspaceId, room.id);
            useChatView.getState().requestJump(room.id, m.id);
          }}
          className={ROW_BTN}
        >
          <Avatar userId={m.authorId} name={author} fileId={avatar || undefined} size={28} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate text-body font-semibold" title={author}>
                {author}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-micro text-muted">
                {unread ? <UnreadDot /> : null}
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
      <DismissButton onClick={dismiss} />
    </li>
  );
});

/** No task in the store yet: what noticeText needs of it (REJECTED's comment and PRIORITY's value are then generic). */
const NO_TASK: Pick<Task, 'approvers' | 'priority'> = { approvers: [], priority: TaskPriority.NONE };

/**
 * A task notice (ADR-0141): who, the task (key · title — the source) and what happened. Unread
 * while the task is in «Непрочитанное», marked on its newest notice only.
 */
const NoticeItem = memo(function NoticeItem({ e, latest }: { e: TaskNoticeEntry; latest: boolean }): ReactNode {
  const n = e.notice;
  const actorId = n?.actorId ?? '';
  const unread = useBoards((s) => latest && s.unread[e.taskId] !== undefined);
  const task = useBoards((s) => s.tasks[e.taskId]);
  const actor = useMemberName(e.workspaceId, actorId);
  const avatar = useWorkspaces((s) => (actorId ? s.users[actorId]?.avatarFileId : undefined));
  const wsName = useWorkspaces((s) => s.byId[e.workspaceId]?.ws.name);
  const text = n ? noticeText(task ?? { ...NO_TASK, workspaceId: e.workspaceId }, n) : '';
  const source = `${e.taskKey} · ${e.taskTitle}`;
  const d = toDate(e.createdAt);
  const dismiss = useCallback(() => void dismissInboxItem({ e, latest }), [e, latest]);
  return (
    <li className="relative">
      <Popover.Close asChild>
        <button
          type="button"
          onClick={(ev) => {
            // Ctrl/⌘-click: a background tab; the preventDefault keeps the popover open (Popover.Close honours it).
            if (openTaskOrTab({ id: e.taskId, workspaceId: e.workspaceId, boardId: e.boardId }, ev)) ev.preventDefault();
          }}
          className={ROW_BTN}
        >
          {actorId ? (
            <Avatar userId={actorId} name={actor} fileId={avatar || undefined} size={28} />
          ) : (
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-hover text-muted">
              <SquareCheckBig className="size-4" aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate text-body font-semibold" title={actorId ? actor : t('shell.inboxTasks')}>
                {actorId ? actor : t('shell.inboxTasks')}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-micro text-muted">
                {unread ? <UnreadDot /> : null}
                {fmt.dayLabel(d)}, {fmt.time(d)}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-caption text-muted">
              <SquareCheckBig className="size-3 shrink-0" aria-hidden />
              <span className="truncate" title={`${source} · ${wsName ?? ''}`}>
                {source}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 break-words text-body text-fg">{text}</span>
          </span>
        </button>
      </Popover.Close>
      <DismissButton onClick={dismiss} />
    </li>
  );
});
