import { WorkspaceRole, type Role, type Room } from '@calaba/protocol';
import { ChevronDown, Hash, Lock, Plus, Timer, Volume2 } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { Button, Empty, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { fmt, useTimeFormat } from '../../lib/format';
import { mayArrangeRooms, mayInviteMembers, mayManageRoomWith, mayRoomInvite, roomPerms } from '../../lib/permissions';
import { sortTempRooms } from '../../lib/tempRooms';
import { useRoomPreview } from '../../stores/roomPreviews';
import { groupRooms, isVoice, roomNotify, roomsOfWorkspace, showsUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { usePreviewParts } from '../chat/mentionText';
import { PreviewRuns } from '../chat/PreviewRuns';
import { KnockBadge } from '../guests/KnockBadge';
import { CallTimer, CategoryDialog, PeoplePill, RoomMenu, WorkspaceHeader } from './Sidebar';

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
    <aside className="mat-sidebar flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('room.list')} data-testid="phone-room-list">
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

/** Voice participants of a room (server states + me while I connect to it), by join time. */
export function useRoomPeople(workspaceId: string, roomId: string): string[] {
  const server = useWorkspaces(
    useShallow((s) => {
      const voice = roomId ? s.byId[workspaceId]?.voice : undefined;
      if (!voice) return NONE;
      return Object.values(voice)
        .filter((v) => v.roomId === roomId)
        .sort((a, b) => Number(a.joinedAt?.seconds ?? 0n) - Number(b.joinedAt?.seconds ?? 0n) || a.userId.localeCompare(b.userId))
        .map((v) => v.userId);
    }),
  );
  const me = useSession((s) => s.me?.user?.id ?? '');
  const joining = useVoice((s) => (s.joining?.roomId ?? (s.phase === 'connecting' ? s.roomId : null)) === roomId);
  return useMemo(() => (joining && me && !server.includes(me) ? [...server, me] : server), [server, joining, me]);
}
const NONE: string[] = [];

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
  return (
    <li>
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
          onClick={() => openRoom(workspaceId, room.id)}
          aria-label={label}
          data-testid="phone-room-row"
          data-room={room.id}
          className="flex h-[68px] w-full min-w-0 select-none items-center gap-3 px-3 text-left transition-colors duration-[var(--motion-fast)] active:bg-hover"
        >
          <RoomIcon room={room} live={live || inRoom} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 border-b border-line py-2.5 [li:last-child_&]:border-b-0">
            <span className="flex h-5 min-w-0 items-center gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-list leading-5', unread ? 'font-semibold text-fg' : 'text-fg')}>{room.name}</span>
              {live ? <CallTimer roomId={room.id} className="shrink-0 text-caption text-[var(--color-green-text)]" /> : <RowTime roomId={room.id} unread={unread} />}
            </span>
            <span className="flex h-5 min-w-0 items-center gap-2">
              {live ? <VoiceLine workspaceId={workspaceId} people={people} /> : <PreviewLine workspaceId={workspaceId} room={room} me={me} unread={unread} />}
              {live ? <AvatarStack workspaceId={workspaceId} people={people} /> : null}
              {live ? <PeoplePill n={people.length} max={room.userLimit} /> : null}
              <KnockBadge roomId={room.id} />
              <Counter mentions={mentions} unread={unread} />
            </span>
          </span>
        </button>
      </RoomMenu>
    </li>
  );
});

function RoomIcon({ room, live }: { room: Room; live: boolean }): ReactNode {
  const Icon = room.expiresAt ? Timer : isVoice(room) ? Volume2 : Hash;
  return (
    <span className={cx('relative grid size-11 shrink-0 place-items-center rounded-full', live ? 'bg-[color-mix(in_srgb,var(--color-ok)_18%,transparent)] text-ok' : 'bg-[var(--color-fill)] text-muted')}>
      <Icon className="size-[22px]" aria-hidden />
      {room.isPrivate ? (
        <span role="img" aria-label={t('room.private')} className="absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full border-2 border-[var(--color-sidebar,var(--color-bg))] bg-[var(--color-fill-hover)]">
          <Lock className="size-2.5 text-fg" aria-hidden />
        </span>
      ) : null}
    </span>
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

/** Up to three avatars of the call, overlapping. */
export function AvatarStack({ workspaceId, people, size = 20 }: { workspaceId: string; people: string[]; size?: number }): ReactNode {
  const shown = people.slice(0, 3);
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((id, i) => (
        <StackAvatar key={id} workspaceId={workspaceId} userId={id} size={size} first={i === 0} />
      ))}
    </span>
  );
}

function StackAvatar({ workspaceId, userId, size, first }: { workspaceId: string; userId: string; size: number; first: boolean }): ReactNode {
  const fileId = useWorkspaces((s) => s.users[userId]?.avatarFileId ?? '');
  const name = useWorkspaces(() => memberName(workspaceId, userId));
  return (
    <span className={cx('flex rounded-full ring-2 ring-[var(--color-sidebar,var(--color-bg))]', !first && '-ml-1.5')}>
      <Avatar userId={userId} name={name} fileId={fileId || undefined} size={size} />
    </span>
  );
}

/** The mention count (red), else an unread dot. */
function Counter({ mentions, unread }: { mentions: number; unread: boolean }): ReactNode {
  if (mentions > 0) {
    return <span className="shrink-0 rounded-full bg-danger-fill px-1.5 text-micro font-bold leading-[18px] text-white" aria-hidden>{mentions > 99 ? '99+' : mentions}</span>;
  }
  return unread ? <span className="size-2.5 shrink-0 rounded-full bg-accent" aria-hidden /> : null;
}
