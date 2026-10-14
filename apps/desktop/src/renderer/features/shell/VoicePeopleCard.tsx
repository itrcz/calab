import * as Popover from '@radix-ui/react-popover';
import { WorkspaceRole, type PermissionBits, type Room } from '@calaba/protocol';
import { LogOut, MonitorUp, Phone, Video, Volume2 } from 'lucide-react';
import { memo, useMemo, useRef, type ReactElement, type ReactNode, type SyntheticEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { Button, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { can } from '../../lib/permissions';
import { joinOutcome } from '../../lib/voiceEntry';
import { voice } from '../../services/voice';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useVoice } from '../../stores/voice';
import { useConnectingRing, useVoiceStateOf } from '../../stores/voicePending';
import { memberName, useRoleLook, useWorkspaces } from '../../stores/workspaces';
import { roleTextClass, roleTextStyle } from '../people/MemberBits';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { MusicianIcon, VoiceStateIcons } from '../voice/VoiceStateIcons';
import { CallTimer } from './Sidebar';
import { cardOrder, firstNames, stackOrder, stackSlice } from './voicePeople';

/**
 * «Кто в голосе» on a phone (ADR-0073 §4, owner 13.10: «и людей посмотреть можно было, и чат
 * открывался сразу, без нагромождения»). The chat opens at once as before; who is in the room's
 * voice is a stack of avatars (the room header, the «В голосе» banner, the room row), and a tap on
 * it opens the «В голосе» card — a centred card like every phone menu (lib/phoneMenus.ts): «В
 * голосе · 3 · 25:00», a 56 px row per person (speaking ring, name in the role colour, mic /
 * headphones / camera / stream), a tap on a person opens their member menu, and «Присоединиться» /
 * «Выйти» at the bottom.
 *
 * Re-renders (CLAUDE.md): the card is mounted only while open (Radix portal); rows are memo and
 * subscribe by their user id (voice state, speaking); the stack subscribes to the people's ids and
 * to which of them speak (a shallow id list); the timer is a leaf with its own clock.
 */

// ---------------------------------------------------------------- people of a room

/** Voice participants of a room (server states + me while I connect to it), by join time. */
export function useRoomPeople(workspaceId: string, roomId: string): string[] {
  const server = useWorkspaces(
    useShallow((s) => {
      const states = roomId ? s.byId[workspaceId]?.voice : undefined;
      if (!states) return NONE;
      return Object.values(states)
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

/** «Борис, Вера» of the people (first names, in the given order): a string, member churn re-renders nothing. */
function usePeopleNames(workspaceId: string, people: readonly string[]): string {
  return useWorkspaces(() => firstNames(people.map((id) => memberName(workspaceId, id))));
}

// ---------------------------------------------------------------- the stack

/** Up to three avatars of the call, overlapping (−6 px; −8 px from 28 px), and «+N» for the rest. */
export function AvatarStack({
  workspaceId,
  people,
  size = 20,
  ring = 'ring-[var(--color-sidebar,var(--color-bg))]',
  counter = false,
}: {
  workspaceId: string;
  people: readonly string[];
  size?: number;
  /** The ring colour: the background the stack sits on. */
  ring?: string;
  /** Show «+N» when there are more than three. */
  counter?: boolean;
}): ReactNode {
  const { shown, more } = stackSlice(people);
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((id, i) => (
        <StackAvatar key={id} workspaceId={workspaceId} userId={id} size={size} ring={ring} overlap={i === 0 ? '' : size >= 28 ? '-ml-2' : '-ml-1.5'} />
      ))}
      {counter && more > 0 ? (
        <span className="ml-1 text-caption font-semibold tabular-nums text-[var(--color-green-text)]" data-testid="voice-stack-more">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

function StackAvatar({ workspaceId, userId, size, ring, overlap }: { workspaceId: string; userId: string; size: number; ring: string; overlap: string }): ReactNode {
  const fileId = useWorkspaces((s) => s.users[userId]?.avatarFileId ?? '');
  const name = useWorkspaces(() => memberName(workspaceId, userId));
  return (
    <span className={cx('flex rounded-full ring-2', ring, overlap)}>
      <Avatar userId={userId} name={name} fileId={fileId || undefined} size={size} />
    </span>
  );
}

/**
 * The stack in the order the phone shows it: me first, then whoever speaks, then the rest. Its own
 * subscriber to «who of them speaks» (a shallow id list), so speech re-renders only the stack.
 */
export function SpeakingStack({ workspaceId, people, size, ring, counter }: { workspaceId: string; people: readonly string[]; size?: number; ring?: string; counter?: boolean }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const speaking = useVoice(useShallow((s) => people.filter((id) => s.speaking[id])));
  const order = useMemo(() => stackOrder(people, me, speaking), [people, me, speaking]);
  return <AvatarStack workspaceId={workspaceId} people={order} size={size} ring={ring} counter={counter} />;
}

/**
 * The header's stack (a voice room with people, me among them or not): replaces the room's icon
 * disc; a tap opens the «В голосе» card. 36 px tall with the bar's 44 px target.
 */
export function HeaderVoicePeople({ workspaceId, room, perms, people }: { workspaceId: string; room: Room; perms: PermissionBits; people: readonly string[] }): ReactNode {
  useLocale();
  const names = usePeopleNames(workspaceId, people);
  return (
    <VoicePeoplePopover workspaceId={workspaceId} room={room} perms={perms}>
      <button
        type="button"
        aria-label={t('mobile.voicePeople', { names })}
        className="flex shrink-0 items-center rounded-full px-0.5 active:opacity-70"
        data-testid="room-voice-people"
      >
        <SpeakingStack workspaceId={workspaceId} people={people} size={28} ring="ring-[var(--color-toolbar)]" counter />
      </button>
    </VoicePeoplePopover>
  );
}

// ---------------------------------------------------------------- join

export interface VoiceJoin {
  run: () => void;
  disabled: boolean;
  label: string;
}

/** «Войти в голос» of a room I read without being in its voice: the room row's rules (joinOutcome). */
export function useVoiceJoin(workspaceId: string, room: Room, perms: PermissionBits, people: number): VoiceJoin {
  const suspended = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.suspension);
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  return {
    disabled: suspended,
    label: suspended ? t('suspended.voice') : t('voicePreview.join'),
    run: () => {
      const next = joinOutcome({ inRoom: false, canConnect: can(perms, 'CONNECT'), owner, people, limit: room.userLimit });
      if (next === 'full') toast.info(t('shell.roomFull'));
      else if (next === 'join') void voice.join(room.id, workspaceId);
    },
  };
}

// ---------------------------------------------------------------- the card

/**
 * The «В голосе» card around a trigger (`children`: a button), or — with `open` — around an anchor
 * that is not a button (the room row: the row itself is the button, the stack is a zone of it).
 * Events inside the card stop at it: the card is a React child of the row / header, and a swipe or
 * a tap in it must not reach their handlers (the row's swipe, «open the room»).
 */
export function VoicePeoplePopover({
  workspaceId,
  room,
  perms,
  open,
  onOpenChange,
  children,
}: {
  workspaceId: string;
  room: Room;
  perms: PermissionBits;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactElement;
}): ReactNode {
  const anchored = open !== undefined;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {anchored ? <Popover.Anchor asChild>{children}</Popover.Anchor> : <Popover.Trigger asChild>{children}</Popover.Trigger>}
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('people.inVoice')}
          className="mat-popover anim-in z-[var(--z-popover)] flex w-[320px] flex-col rounded-[var(--radius-panel)] py-1.5 text-fg focus:outline-none"
          data-testid="voice-people-card"
          // No focus jump into the list (a phone: no keyboard focus ring on open).
          onOpenAutoFocus={(e) => e.preventDefault()}
          onClick={stop}
          onTouchStart={stop}
          onTouchMove={stop}
          onTouchEnd={stop}
          onTouchCancel={stop}
          onContextMenu={stop}
        >
          <VoicePeopleCard workspaceId={workspaceId} room={room} perms={perms} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const stop = (e: SyntheticEvent): void => e.stopPropagation();

function VoicePeopleCard({ workspaceId, room, perms }: { workspaceId: string; room: Room; perms: PermissionBits }): ReactNode {
  useLocale();
  const people = useRoomPeople(workspaceId, room.id);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const inRoom = useVoice((s) => s.roomId === room.id);
  const join = useVoiceJoin(workspaceId, room, perms, people.length);
  const rows = useMemo(() => cardOrder(people, me), [people, me]);
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-2.5 text-list font-semibold" data-testid="voice-people-title">
        <Volume2 className="size-[18px] shrink-0 text-ok" aria-hidden />
        <span className="truncate text-[var(--color-green-text)]">{t('mobile.inVoice', { n: people.length })}</span>
        <CardTimer roomId={room.id} />
      </div>
      <ul className="flex flex-col">
        {rows.map((id) => (
          <VoicePersonRow key={id} workspaceId={workspaceId} userId={id} self={id === me} />
        ))}
      </ul>
      <div className="px-1 pt-1.5">
        <Popover.Close asChild>
          {inRoom ? (
            <Button size="lg" variant="destructive" className="w-full" onClick={() => void voice.leave()} data-testid="voice-people-leave">
              <LogOut className="size-4" aria-hidden />
              {t('mobile.leaveVoice')}
            </Button>
          ) : (
            <Button size="lg" className="w-full" disabled={join.disabled} onClick={join.run} data-testid="voice-people-join">
              <Phone className="size-4" aria-hidden />
              {t('mobile.joinVoice')}
            </Button>
          )}
        </Popover.Close>
      </div>
    </>
  );
}

/** «· 25:00» after the count while the call runs (the timer is a leaf with its own clock). */
function CardTimer({ roomId }: { roomId: string }): ReactNode {
  const running = useRooms((s) => !!s.byId[roomId]?.voiceStartedAt);
  if (!running) return null;
  return (
    <>
      <span className="text-faint" aria-hidden>
        ·
      </span>
      <CallTimer roomId={roomId} className="text-list font-normal text-muted" />
    </>
  );
}

/**
 * One person of the call: 40 px avatar with the speaking ring, the name in the role colour, «Вы»
 * at mine, the voice state icons. A tap (and a long press) opens the member menu — the one member
 * menu of the app (profile, volume, moderation), as a level over the card.
 */
const VoicePersonRow = memo(function VoicePersonRow({ workspaceId, userId, self }: { workspaceId: string; userId: string; self: boolean }): ReactNode {
  useLocale();
  const v = useVoiceStateOf(workspaceId, userId);
  const speaking = useVoice((s) => s.speaking[userId] ?? false);
  const connecting = useConnectingRing(workspaceId, userId, v?.pending ?? false);
  const fileId = useWorkspaces((s) => s.users[userId]?.avatarFileId ?? '');
  const name = useWorkspaces(() => memberName(workspaceId, userId));
  const role = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.role);
  const look = useRoleLook(workspaceId, userId);
  const ref = useRef<HTMLButtonElement>(null);
  const talking = speaking && !v?.muted && !connecting;
  // A tap opens the member menu (Radix ContextMenu opens on `contextmenu`), as the header's «…».
  const openMenu = (): void => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.bottom }));
  };
  return (
    <li>
      <MemberContextMenu workspaceId={workspaceId} userId={userId}>
        <button
          ref={ref}
          type="button"
          onClick={openMenu}
          aria-label={self ? `${name} (${t('dm.you')})` : name}
          aria-haspopup="menu"
          data-testid="voice-people-row"
          data-speaking={talking || undefined}
          className="flex h-14 w-full min-w-0 select-none items-center gap-3 rounded-[var(--radius-row)] px-2 text-left transition-colors duration-[var(--motion-fast)] active:bg-hover"
        >
          <Avatar userId={userId} name={name} fileId={fileId || undefined} size={40} speaking={talking} connecting={connecting} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className={cx('min-w-0 truncate text-list font-medium leading-5', roleTextClass(role, 'role', look))} style={roleTextStyle(role, 'role', look)}>
              {name}
            </span>
            {self ? <span className="shrink-0 text-caption text-muted">{t('dm.you')}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {v?.streaming ? <MonitorUp className="size-4 shrink-0 text-danger" aria-label={t('people.streaming')} role="img" /> : null}
            {v?.camera ? <Video className="size-4 shrink-0 text-muted" aria-label={t('video.stateOn')} role="img" /> : null}
            {v?.musician ? <MusicianIcon /> : null}
            {v ? <VoiceStateIcons muted={v.muted} deafened={v.deafened} serverMuted={v.serverMuted} /> : null}
          </span>
        </button>
      </MemberContextMenu>
    </li>
  );
});
