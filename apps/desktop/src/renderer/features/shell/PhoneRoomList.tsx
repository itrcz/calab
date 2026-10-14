import { NotificationLevel, WorkspaceRole, type Role, type Room } from '@calaba/protocol';
import { Bell, BellOff, CheckCheck, ChevronDown, Plus, Volume2 } from 'lucide-react';
import { memo, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { RoomIcon } from '../../components/RoomIcon';
import { Button, CountBadge, Empty, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { fmt, useTimeFormat } from '../../lib/format';
import { mayArrangeRooms, mayInviteMembers, mayManageRoomWith, mayRoomInvite, roomPerms } from '../../lib/permissions';
import { useRowSwipe } from '../../lib/rowSwipe';
import { sortTempRooms } from '../../lib/tempRooms';
import { markRead } from '../../services/chat';
import { setRoomNotifications } from '../../services/mentions';
import { useRoomPreview } from '../../stores/roomPreviews';
import { groupRooms, isUnread, isVoice, roomNotify, roomsOfWorkspace, showsUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { usePreviewParts } from '../chat/mentionText';
import { PreviewRuns } from '../chat/PreviewRuns';
import { KnockBadge } from '../guests/KnockBadge';
import { CallTimer, CategoryDialog, PeoplePill, RoomMenu, WorkspaceHeader } from './Sidebar';
import { SpeakingStack, VoicePeoplePopover, useRoomPeople } from './VoicePeopleCard';

/**
 * «Команда» on a phone (ADR-0073 §3): the workspace header (name and menu, «+»; the boards are the «Доски» tab) and
 * the rooms as a messenger's chat list — 68 px rows, the whole row opens the room, a long press
 * opens the room menu, no «Войти» (the voice is entered inside the room, §4). Categories are
 * collapsible section headers (the desktop's collapse state). The desktop column (Sidebar) is not
 * touched.
 *
 * Re-renders (CLAUDE.md): the list re-renders on room / category changes only; each row is memo
 * and subscribes by its own id (unread, mentions, preview, voice people); the call timer is a
 * leaf with its own clock.
 */
export function PhoneRoomList({ workspaceId }: { workspaceId: string }): ReactNode {
  const exists = useWorkspaces((s) => !!s.byId[workspaceId]);
  const [catDialog, setCatDialog] = useState(false);
  if (!exists) return null;
  return (
    <aside className="mat-content flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('room.list')} data-testid="phone-room-list">
      <WorkspaceHeader workspaceId={workspaceId} onCreateCategory={() => setCatDialog(true)} />
      <Rooms workspaceId={workspaceId} />
      {catDialog ? <CategoryDialog workspaceId={workspaceId} onClose={() => setCatDialog(false)} /> : null}
    </aside>
  );
}

function Rooms({ workspaceId }: { workspaceId: string }): ReactNode {
  const roomsById = useRooms((s) => s.byId);
  const categoriesById = useRooms((s) => s.categories);
  const notify = useRooms((s) => s.notify);
  const hideMuted = useUi((s) => s.hideMuted);
  const voiceRoom = useVoice((s) => s.roomId);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const role = useMemberRoles(workspaceId, me);
  const manageRooms = mayArrangeRooms(role);
  const admin = mayInviteMembers(role);
  const open = useUi((s) => s.openDialog);
  const { groups, temps } = useMemo(() => {
    let rooms = roomsOfWorkspace(roomsById, workspaceId);
    // «Скрыть заглушённые»: my voice room stays.
    if (hideMuted) rooms = rooms.filter((r) => r.id === voiceRoom || roomNotify(notify[r.id]).mutedUntil === null);
    const cats = Object.values(categoriesById).filter((c) => c.workspaceId === workspaceId);
    return { groups: groupRooms(rooms, cats, manageRooms), temps: sortTempRooms(rooms.filter((r) => !!r.expiresAt)) };
  }, [roomsById, categoriesById, workspaceId, manageRooms, hideMuted, notify, voiceRoom]);
  const row = (r: Room): ReactNode => <PhoneRoomRow key={r.id} room={r} workspaceId={workspaceId} me={me} role={role} admin={admin} canOrder={manageRooms && !r.expiresAt} />;

  return (
    <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4" data-testid="room-list">
      {groups.length === 0 && temps.length === 0 ? (
        <Empty
          action={
            manageRooms ? (
              <Button size="sm" onClick={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                <Plus className="size-3.5" /> {t('room.create')}
              </Button>
            ) : undefined
          }
        >
          {manageRooms ? t('shell.noRooms') : t('shell.noRoomsMember')}
        </Empty>
      ) : null}
      {groups.map((g) =>
        g.category ? (
          <Section key={g.category.id} id={g.category.id} title={g.category.name} keep={voiceRoom}>
            {g.rooms.map(row)}
          </Section>
        ) : (
          <ul key="none" className="flex flex-col">
            {g.rooms.map(row)}
          </ul>
        ),
      )}
      {temps.length ? (
        <Section id={`temp:${workspaceId}`} title={t('temp.group')} keep={voiceRoom}>
          {temps.map(row)}
        </Section>
      ) : null}
    </div>
  );
}

/** A collapsible category (the desktop's collapse state): collapsed, only my voice room stays. */
function Section({ id, title, keep, children }: { id: string; title: string; keep: string | null; children: ReactNode[] }): ReactNode {
  const collapsed = useUi((s) => !!s.collapsed[id]);
  const toggle = useUi((s) => s.toggleCategory);
  const visible = collapsed ? children.filter((c) => (c as { key?: string | null }).key === keep) : children;
  return (
    <section aria-label={title} data-cat-section={id}>
      <button
        type="button"
        onClick={() => toggle(id)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('shell.categoryExpand', { name: title }) : t('shell.categoryCollapse', { name: title })}
        className="flex h-11 w-full min-w-0 items-center gap-1 px-3 pt-2 text-left text-micro font-semibold uppercase tracking-[0.04em] text-muted"
      >
        <ChevronDown className={cx('size-3.5 shrink-0 transition-transform duration-[var(--motion-fast)]', collapsed && '-rotate-90')} strokeWidth={2.25} aria-hidden />
        <span className="truncate">{title}</span>
      </button>
      {visible.length ? <ul className="flex flex-col">{visible}</ul> : null}
    </section>
  );
}

/**
 * One room (ADR-0073 §3): 44 px icon · name (bold when unread) and the last message's time ·
 * «Автор: текст» (or the topic until the previews arrive) with the unread / @ badge. A voice
 * room with people: «🔊 Борис, Вера» in green instead of the preview, their avatars (≤ 3), the
 * call timer and n/max.
 */
const PhoneRoomRow = memo(function PhoneRoomRow({
  room,
  workspaceId,
  me,
  role,
  admin,
  canOrder,
}: {
  room: Room;
  workspaceId: string;
  me: string;
  role: readonly Role[];
  admin: boolean;
  canOrder: boolean;
}): ReactNode {
  useLocale();
  const openRoom = useUi((s) => s.openRoom);
  const unread = useRooms((s) => showsUnread(room.id, s));
  const mentions = useRooms((s) => s.mentions[room.id] ?? 0);
  const inRoom = useVoice((s) => s.roomId === room.id);
  const voice = isVoice(room);
  const people = useRoomPeople(workspaceId, voice ? room.id : '');
  const perms = roomPerms(role, me, room);
  const live = voice && people.length > 0;
  const label = [room.name, mentions > 0 ? plural('shell.unreadMentions', mentions) : unread ? t('ws.unread') : '', live ? t('shell.peopleIn', { n: people.length }) : '']
    .filter(Boolean)
    .join(', ');
  // A left swipe reveals «Прочитано» · «Тихо / Звук» (docs/08 «Свайпы и долгое нажатие»).
  const swipe = useRowSwipe(true, 2);
  const shifted = swipe.offset !== 0;
  // A tap on the avatar stack opens «В голосе» (docs/08 «Кто в голосе»); the rest of the row opens the room.
  const [peopleOpen, setPeopleOpen] = useState(false);
  const onTap = (e: MouseEvent<HTMLButtonElement>): void => {
    if (shifted) swipe.close();
    else if (live && onStack(e)) setPeopleOpen(true);
    else openRoom(workspaceId, room.id);
  };
  return (
    <li className="relative flex" {...swipe.handlers}>
      {shifted ? <RoomSwipeActions roomId={room.id} width={Math.min(-swipe.offset, swipe.width)} close={swipe.close} /> : null}
      <RoomMenu
        room={room}
        canManage={mayManageRoomWith(perms, role, me, room)}
        canOrder={canOrder}
        admin={admin}
        inviteRoom={mayRoomInvite(perms)}
        guest={role.some((r) => r.builtin === WorkspaceRole.GUEST)}
      >
        <button
          type="button"
          onClick={onTap}
          aria-label={label}
          data-testid="phone-room-row"
          data-room={room.id}
          style={shifted ? { marginRight: -swipe.offset } : undefined}
          className={cx(
            'flex h-[68px] min-w-0 flex-1 select-none items-center gap-3 px-3 text-left duration-[var(--motion-fast)] active:bg-hover',
            swipe.dragging ? 'transition-colors' : 'transition-[margin,background-color]',
          )}
        >
          <RoomIcon roomId={room.id} size={44} live={live || inRoom} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 border-b border-line py-2.5 [li:last-child_&]:border-b-0">
            <span className="flex h-5 min-w-0 items-center gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-list leading-5', unread ? 'font-semibold text-fg' : 'text-fg')}>{room.name}</span>
              {live ? <CallTimer roomId={room.id} className="shrink-0 text-caption text-[var(--color-green-text)]" /> : <RowTime roomId={room.id} unread={unread} />}
            </span>
            <span className="flex h-5 min-w-0 items-center gap-2">
              {live ? <VoiceLine workspaceId={workspaceId} people={people} /> : <PreviewLine workspaceId={workspaceId} room={room} me={me} unread={unread} />}
              {live ? (
                <span className="flex shrink-0" data-voice-stack>
                  <SpeakingStack workspaceId={workspaceId} people={people} />
                </span>
              ) : null}
              {live ? <PeoplePill n={people.length} max={room.userLimit} /> : null}
              <KnockBadge roomId={room.id} />
              <Counter mentions={mentions} unread={unread} />
            </span>
          </span>
        </button>
      </RoomMenu>
      {live ? (
        <VoicePeoplePopover workspaceId={workspaceId} room={room} perms={perms} open={peopleOpen} onOpenChange={setPeopleOpen}>
          <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-px" />
        </VoicePeoplePopover>
      ) : null}
    </li>
  );
});

/** The stack's touch zone in a room row: its box grown to 44 px tall and 8 px on each side (a pointer tap; a keyboard click opens the room). */
function onStack(e: MouseEvent<HTMLElement>): boolean {
  if (e.detail === 0) return false;
  const stack = e.currentTarget.querySelector('[data-voice-stack]');
  if (!stack) return false;
  const r = stack.getBoundingClientRect();
  const cy = r.top + r.height / 2;
  return e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && Math.abs(e.clientY - cy) <= 22;
}

/**
 * The actions under a swiped room row: «Прочитано» (the menu's «Отметить прочитанным») and
 * «Тихо» / «Звук» — the room's notifications «Ничего» ↔ «Как в пространстве» (the menu's
 * «Уведомления ›»). Mounted only while the row is open; a tap closes the row.
 */
function RoomSwipeActions({ roomId, width, close }: { roomId: string; width: number; close: () => void }): ReactNode {
  const unread = useRooms((s) => isUnread(roomId, s));
  const quiet = useRooms((s) => {
    const n = roomNotify(s.notify[roomId]);
    return n.mutedUntil !== null || n.level === NotificationLevel.NONE;
  });
  const action = 'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden px-1 text-center text-micro font-medium';
  return (
    <div className="absolute inset-y-0 right-0 flex overflow-hidden" style={{ width }} data-testid="room-swipe-action">
      <button
        type="button"
        disabled={!unread}
        onClick={() => {
          close();
          const last = useRooms.getState().lastMessage[roomId];
          if (last) markRead(roomId, last);
        }}
        className={cx(action, 'bg-accent-strong text-accent-fg disabled:opacity-60')}
        data-testid="room-swipe-read"
      >
        <CheckCheck className="size-4 shrink-0" aria-hidden />
        <span className="line-clamp-2">{t('room.swipeRead')}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          close();
          void setRoomNotifications(roomId, quiet ? NotificationLevel.INHERIT : NotificationLevel.NONE, null);
        }}
        className={cx(action, 'bg-attention text-attention-fg')}
        data-testid="room-swipe-mute"
      >
        {quiet ? <Bell className="size-4 shrink-0" aria-hidden /> : <BellOff className="size-4 shrink-0" aria-hidden />}
        <span className="line-clamp-2">{t(quiet ? 'room.swipeUnmute' : 'room.swipeMute')}</span>
      </button>
    </div>
  );
}

/** The last message's time («14:05», «Вчера», «12.03»), from the room preview (ADR-0073 §5). */
function RowTime({ roomId, unread }: { roomId: string; unread: boolean }): ReactNode {
  useTimeFormat();
  const at = useRoomPreview(roomId)?.at;
  if (!at) return null;
  return <span className={cx('shrink-0 text-micro tabular-nums', unread ? 'text-fg' : 'text-faint')}>{fmt.listTime(new Date(at))}</span>;
}

/**
 * «Автор: текст» of the last message. Until the previews arrive (or without the right to read the
 * history) the line shows the room topic, or stays empty — always one line tall, no jump.
 */
function PreviewLine({ workspaceId, room, me, unread }: { workspaceId: string; room: Room; me: string; unread: boolean }): ReactNode {
  const preview = useRoomPreview(room.id);
  const author = useWorkspaces(() => (preview && preview.authorId !== me ? memberName(workspaceId, preview.authorId) : ''));
  const parts = usePreviewParts(workspaceId, preview?.content ?? '');
  const tone = unread ? 'text-fg' : 'text-muted';
  if (!preview) {
    return <span className="fade-end min-w-0 flex-1 overflow-hidden whitespace-nowrap text-caption leading-5 text-muted">{room.topic}</span>;
  }
  return (
    <span className={cx('fade-end min-w-0 flex-1 overflow-hidden whitespace-nowrap text-caption leading-5', tone)} data-testid="room-preview">
      <span className="text-fg">{preview.authorId === me ? t('dm.you') : author}: </span>
      {parts.length ? <PreviewRuns parts={parts} /> : preview.attachments ? t('chat.attachment') : ''}
    </span>
  );
}

/** «🔊 Борис, Вера» — who is in the call, in green. */
function VoiceLine({ workspaceId, people }: { workspaceId: string; people: string[] }): ReactNode {
  const names = useWorkspaces(() => people.map((id) => memberName(workspaceId, id).split(' ')[0]).join(', '));
  return (
    <span className="fade-end flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-caption font-medium leading-5 text-[var(--color-green-text)]" data-testid="room-voice-line">
      <Volume2 className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{names}</span>
    </span>
  );
}

/** The mention count (red), else an unread dot. */
function Counter({ mentions, unread }: { mentions: number; unread: boolean }): ReactNode {
  if (mentions > 0) {
    return <CountBadge count={mentions} aria-hidden />;
  }
  return unread ? <span className="size-2.5 shrink-0 rounded-full bg-accent" aria-hidden /> : null;
}
