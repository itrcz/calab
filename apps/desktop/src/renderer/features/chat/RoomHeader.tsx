import { NotificationLevel, PresenceStatus, RoomType, WorkspaceRole, type Message, type PermissionBits, type Room } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Bell, BellOff, BellRing, Hash, Phone, Pin, PinOff, Search, SlidersHorizontal, Timer, Users, Video, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { ProfileTarget } from '../../components/ProfileTarget';
import { Button, IconButton, MOD, Tip, cx } from '../../components/ui';
import { t, useLocale, type MessageKey } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { can, mayPin } from '../../lib/permissions';
import { setPinned } from '../../services/chat';
import { setRoomNotifications } from '../../services/mentions';
import { useMobile } from '../../lib/mobile';
import { NavButton } from '../shell/MobileShell';
import { effectiveNotify, useRooms } from '../../stores/rooms';
import { useMessages } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useVoiceStates } from '../../stores/voicePending';
import { toast } from '../../stores/toasts';
import { voice } from '../../services/voice';
import { isVoicePreview, joinOutcome } from '../../lib/voiceEntry';
import { useDms } from '../../stores/dms';
import { DmActionsMenu } from '../dm/DmActionsMenu';
import { DmCallSlot, OnCallMark } from '../call/CallBits';
import { useCall } from '../../stores/call';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { roomLabel } from './roomLabel';
import { menuBox } from '../shell/menu';
import { RoleMark, roleTextClass, useSharedRole } from '../people/MemberBits';
import { LEVEL_LABEL, NotifyMenuItems, mutedText, type LevelOption } from './NotifyMenu';
import { previewPartsOf } from './mentionText';
import { PreviewRuns } from './PreviewRuns';
import { TypingDots, useTypingText } from './TypingIndicator';
import { systemPreview } from '../../lib/recording';
import { headerFit, measureHeader, type HeaderFit } from './headerFit';
import { RoomEventBadge } from '../calendar/RoomEvent';
import { SipDialButton } from '../voice/Sip';

const NO_PINS: never[] = [];

/**
 * Room header (docs/09 #7): icon, name, • topic (or «… печатает» while someone types), and on
 * the right: search in room, pinned, notifications, settings, members. Workspace search lives in the
 * title bar only (docs/09 #53). It never spills out of the chat column (it used to paint over the
 * members column): the spacing tightens first, then the name truncates.
 */
export function RoomHeader({
  workspaceId,
  room,
  perms,
  membersOpen,
  toggleMembers,
}: {
  workspaceId: string;
  room: Room;
  perms: PermissionBits;
  membersOpen: boolean;
  toggleMembers: () => void;
}): ReactNode {
  const openDialog = useUi((s) => s.openDialog);
  const typing = useTypingText(workspaceId, room.id);
  const searchOpen = useChatView((s) => s.searchRoom === room.id);
  const setSearch = useChatView((s) => s.setSearch);
  const voiceRoom = room.type === RoomType.VOICE;
  // A temporary room (ADR-0044): its own `Timer` icon, as in the room list.
  const Icon = room.expiresAt ? Timer : voiceRoom ? Volume2 : Hash;
  // Phone layout (ADR-0021): this header is the top bar — ☰ (rooms drawer) first, the name takes
  // the room; search, notifications and members stay (pins show in the pinned bar, room settings in
  // the drawer's room menu), 40 px touch targets.
  const mobile = useMobile();
  const touch = mobile ? 'size-10 rounded-full' : undefined;
  // Re-render (and re-measure) when «Войти в голос» appears or goes.
  const preview = useVoice((s) => voiceRoom && isVoicePreview(room, s.roomId));
  // «Видео · N» (ADR-0066 §3): a boolean here (re-measure when it appears), the count in the leaf.
  const videoButton = useVoice((s) => voiceRoom && hasHiddenVideo(s, room.id));
  const [fit, headerEl] = useHeaderFit(!mobile);

  return (
    <header
      ref={headerEl}
      className={cx(
        'mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-line pl-4 pr-2',
        fit.tight && !mobile && 'gap-1 pl-3 pr-1',
        mobile && 'gap-1 pl-1 pr-1',
      )}
    >
      {mobile ? <NavButton /> : null}
      <Icon className="size-5 shrink-0 text-faint" aria-hidden />
      <h1 data-header-name className={cx('min-w-0 max-w-[40%] truncate text-list font-semibold', mobile && 'max-w-none flex-1')} title={room.name}>
        {room.name}
      </h1>
      {voiceRoom ? <RoomEventBadge roomId={room.id} variant="header" compact={mobile} /> : null}
      {preview ? <VoicePreviewBar workspaceId={workspaceId} room={room} perms={perms} /> : null}
      {videoButton ? <VideoButton roomId={room.id} compact={mobile} /> : null}
      {mobile ? null : typing ? (
        <span data-header-fill className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-accent-text" aria-live="polite">
          <span className="text-faint" aria-hidden>
            •
          </span>
          <span className="truncate">{typing}</span>
          <TypingDots />
        </span>
      ) : room.topic ? (
        <Topic topic={room.topic} />
      ) : (
        <div data-header-fill className="flex-1" />
      )}
      <div className="no-drag flex shrink-0 items-center gap-0.5">
        {/* ADR-0046: «Позвонить на номер» — in this room's call, PLACE_CALLS, telephony on (phone: the members drawer). */}
        {voiceRoom && !mobile ? <SipDialButton workspaceId={workspaceId} roomId={room.id} variant="header" /> : null}
        <IconButton label={t('chat.searchInRoom', { room: roomLabel(room) })} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)} className={touch}>
          <Search className="size-[18px]" />
        </IconButton>
        {mobile ? null : <PinsButton workspaceId={workspaceId} roomId={room.id} canManage={mayPin(perms, room)} />}
        <NotifyButton roomId={room.id} className={touch} />
        {can(perms, 'MANAGE_ROOM') && !mobile ? (
          <IconButton label={t('room.settings')} onClick={() => openDialog({ kind: 'room-settings', roomId: room.id })}>
            <SlidersHorizontal className="size-[18px]" />
          </IconButton>
        ) : null}
        <IconButton label={t('shell.members')} active={membersOpen} onClick={toggleMembers} className={touch}>
          <Users className="size-[18px]" />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * Measures the header (headerFit.ts) before paint and whenever it or the room name resizes; the
 * items that change without a resize (name, «Войти в голос», typing) re-render the header, which
 * re-measures too.
 */
function useHeaderFit(enabled: boolean): [HeaderFit, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState<HeaderFit>({ tight: false });
  const measure = useCallback(() => {
    if (!el || !enabled) return;
    const { width, used } = measureHeader(el);
    const next = headerFit(width, used);
    setFit((f) => (f.tight === next.tight ? f : next));
  }, [el, enabled]);
  // Every render: cheap (a handful of rects), and the header re-renders rarely. DOM measurement
  // before paint has to set state here; the setter bails out when nothing changed.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useLayoutEffect(measure);
  useEffect(() => {
    if (!el || !enabled) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const name = el.querySelector('[data-header-name]');
    if (name) ro.observe(name);
    return () => ro.disconnect();
  }, [el, enabled, measure]);
  return [fit, setEl];
}

/** In this room's voice, someone's camera is on and the call view is closed. */
function hasHiddenVideo(s: { roomId: string | null; stage: string; cameras: readonly unknown[] }, roomId: string): boolean {
  return s.roomId === roomId && s.stage === 'pip' && s.cameras.length > 0;
}

/**
 * «Видео · N» (ADR-0066 §3): the way to the call view from the chat — remote cameras are on but
 * only the PiP (or nothing) shows them. Its own subscriber: the count changes re-render only it.
 */
function VideoButton({ roomId, compact }: { roomId: string; compact: boolean }): ReactNode {
  useLocale();
  const n = useVoice((s) => (hasHiddenVideo(s, roomId) ? s.cameras.length : 0));
  if (n === 0) return null;
  return (
    <Button size="sm" variant="secondary" onClick={() => voice.showVideo()} title={t('video.watchHint')} aria-label={`${t('video.watchHint')} · ${n}`} className="no-drag" data-testid="header-video">
      <Video className="size-3.5" aria-hidden />
      {compact ? n : t('video.watch', { n })}
    </Button>
  );
}

/**
 * A voice room's chat read without being in its voice (docs/09 #14): «Вы не в голосе» and
 * «Войти в голос» next to the name (same join rules as a click on the room). A call in another
 * room is not touched until the button is pressed. Phone: the button only, icon-sized.
 */
function VoicePreviewBar({ workspaceId, room, perms }: { workspaceId: string; room: Room; perms: PermissionBits }): ReactNode {
  const preview = useVoice((s) => isVoicePreview(room, s.roomId));
  const states = useVoiceStates(workspaceId);
  const mobile = useMobile();
  const suspended = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.suspension);
  if (!preview) return null;
  const people = Object.values(states).filter((v) => v.roomId === room.id).length;
  const canConnect = can(perms, 'CONNECT');
  const join = (): void => {
    const next = joinOutcome({ inRoom: false, canConnect, canMove: can(perms, 'MOVE_MEMBERS'), people, limit: room.userLimit });
    if (next === 'full') toast.info(t('shell.roomFull'));
    else if (next === 'join') void voice.join(room.id, workspaceId);
  };
  return (
    <div className="no-drag flex shrink-0 items-center gap-2" data-testid="voice-preview">
      {mobile ? null : (
        // Same height as the «Join voice» button next to it (Button size="sm", h-6).
        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-hover px-2.5 text-caption font-medium text-muted">{t('voicePreview.notInVoice')}</span>
      )}
      {!canConnect ? null : mobile ? (
        <IconButton label={suspended ? t('suspended.voice') : t('voicePreview.join')} disabled={suspended} onClick={join} className="size-10 rounded-full text-ok">
          <Phone className="size-5" />
        </IconButton>
      ) : (
        <Button size="sm" onClick={join} disabled={suspended} title={suspended ? t('suspended.voice') : undefined}>
          <Phone className="size-3.5" aria-hidden />
          {t('voicePreview.join')}
        </Button>
      )}
    </div>
  );
}

const PRESENCE_KEY: Partial<Record<PresenceStatus, MessageKey>> = {
  [PresenceStatus.ONLINE]: 'presence.online',
  [PresenceStatus.IDLE]: 'presence.idle',
  [PresenceStatus.DND]: 'presence.dnd',
};

/**
 * DM header (ADR-0020): the peer's avatar with presence, name, • presence and custom status
 * (or «… печатает»); on the right search in the chat, pinned, notifications. No members
 * or settings: a DM has none of them. Both participants pin (docs/04).
 */
export function DmHeader({ room }: { room: Room }): ReactNode {
  const peerId = useDms((s) => s.byRoom[room.id]?.peerId ?? '');
  const name = useMemberName(null, peerId);
  const user = useWorkspaces((s) => s.users[peerId]);
  const status = useWorkspaces((s) => s.presences[peerId]?.status);
  // A DM has no workspace: the peer's most senior role among the shared ones (docs/09 #26).
  const shared = useSharedRole(peerId);
  const typing = useTypingText('', room.id);
  const searchOpen = useChatView((s) => s.searchRoom === room.id);
  const setSearch = useChatView((s) => s.setSearch);
  // In this DM's call (ADR-0034) the call pill takes the presence line's place.
  const inCall = useCall((s) => s.phase === 'active' && s.call?.dmRoomId === room.id);
  const presenceKey = status !== undefined ? PRESENCE_KEY[status] : undefined;
  const custom = [user?.statusEmoji, user?.statusText].filter(Boolean).join(' ');
  const sub = [t(presenceKey ?? 'members.offline'), custom].filter(Boolean).join(' · ');
  // Phone layout (ADR-0021): the top bar — ☰ (DM list drawer) first, 40 px touch targets, pins
  // in the pinned bar.
  const mobile = useMobile();
  const touch = mobile ? 'size-10 rounded-full' : undefined;
  return (
    <header
      className={cx('mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2', mobile && 'gap-1.5 pl-1 pr-1')}
      data-testid="dm-header"
    >
      {mobile ? <NavButton /> : null}
      <ProfileTarget userId={peerId} name={name} tabbable className="no-drag flex shrink-0 rounded-full">
        <Avatar userId={peerId} name={name} fileId={user?.avatarFileId || undefined} size={28} presence ring="var(--color-bg)" />
      </ProfileTarget>
      <h1 className={cx('min-w-0 max-w-[40%] shrink-0 truncate text-list font-semibold', roleTextClass(shared?.role), mobile && 'max-w-none shrink')} title={name}>
        {name}
      </h1>
      {shared ? <RoleMark role={shared.role} label={`${t(shared.role === WorkspaceRole.OWNER ? 'role.owner' : 'role.admin')} · ${shared.workspace}`} /> : null}
      <OnCallMark userId={peerId} />
      <span className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-body', (mobile || inCall) && 'hidden')} aria-live="polite">
        <span className="text-faint" aria-hidden>
          •
        </span>
        {typing ? (
          <>
            <span className="truncate text-accent-text">{typing}</span>
            <TypingDots />
          </>
        ) : (
          <span className="truncate text-muted" title={sub}>
            {sub}
          </span>
        )}
      </span>
      <div className={cx('no-drag flex shrink-0 items-center gap-0.5', (mobile || inCall) && 'ml-auto')}>
        <IconButton label={t('dm.searchIn')} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)} className={touch}>
          <Search className="size-[18px]" />
        </IconButton>
        {mobile ? null : <PinsButton workspaceId="" roomId={room.id} canManage />}
        <NotifyButton roomId={room.id} className={touch} />
        {/* ADR-0034: the phone left of «⋯»; in this DM's call — «Звонок · 00:42» + «Завершить». */}
        <DmCallSlot roomId={room.id} peerId={peerId} className={touch} />
        <DmActionsMenu roomId={room.id} className={touch} />
      </div>
    </header>
  );
}

/**
 * Room notifications (docs/05 «Уведомления», docs/09 item 22): «Как в пространстве» (the
 * default) / all / mentions / nothing, and «Заглушить» for a while or for good. Server-synced
 * across devices; the bell shows the effective state (crossed out while silent).
 */
function NotifyButton({ roomId, className }: { roomId: string; className?: string | undefined }): ReactNode {
  const stored = useRooms((s) => s.notify[roomId]);
  const room = useRooms((s) => s.byId[roomId]);
  const wsId = room?.workspaceId ?? '';
  const wsStored = useRooms((s) => (wsId ? s.wsNotify[wsId] : undefined));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // «Где настроить» in Settings → Звуки opens this menu (after the settings dialog closes).
  const req = useUi((s) => s.notifyMenuReq);
  const seenReq = useRef(req);
  useEffect(() => {
    if (req === seenReq.current) return;
    seenReq.current = req;
    const id = window.setTimeout(() => {
      setNow(Date.now());
      setOpen(true);
    }, 150);
    return () => window.clearTimeout(id);
  }, [req]);
  const eff = effectiveNotify(
    roomId,
    {
      byId: room ? { [roomId]: room } : {},
      notify: stored ? { [roomId]: stored } : {},
      wsNotify: wsStored ? { [wsId]: wsStored } : {},
    },
    now,
  );
  // Re-evaluate when a temporary mute (of the room or its workspace) runs out: the icon flips back.
  const nextEnd = Math.min(eff.room.mutedUntil ?? Infinity, eff.dm ? Infinity : (eff.workspace.mutedUntil ?? Infinity));
  useEffect(() => {
    if (nextEnd === Infinity) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(nextEnd - Date.now() + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [nextEnd]);
  const wsLevel = t(LEVEL_LABEL[eff.workspace.level] ?? 'chat.notifyMentions');
  // A DM notifies every message: «Все сообщения» (the default) or «Ничего».
  const options: LevelOption[] = eff.dm
    ? [
        { level: NotificationLevel.INHERIT, label: t('chat.notifyAll') },
        { level: NotificationLevel.NONE, label: t('chat.notifyNone') },
      ]
    : [
        { level: NotificationLevel.INHERIT, label: t('chat.notifyInherit', { level: wsLevel }) },
        { level: NotificationLevel.ALL, label: t('chat.notifyAll') },
        { level: NotificationLevel.MENTIONS, label: t('chat.notifyMentions') },
        { level: NotificationLevel.NONE, label: t('chat.notifyNone') },
      ];
  const value = eff.dm && eff.room.level !== NotificationLevel.NONE ? NotificationLevel.INHERIT : eff.room.level;
  const Icon = eff.quiet ? BellOff : !eff.dm && eff.level === NotificationLevel.ALL ? BellRing : Bell;
  const wsMuted = !eff.dm && eff.workspace.mutedUntil ? eff.workspace.mutedUntil : null;
  const state = eff.room.mutedUntil
    ? mutedText(eff.room.mutedUntil)
    : wsMuted
      ? t('chat.notifyWsMutedUntil', { time: fmt.until(new Date(wsMuted)) })
      : (options.find((o) => o.level === value)?.label ?? '');
  const tip = t('chat.notifyState', { state: state.toLowerCase() });
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v) setNow(Date.now());
      }}>
      <Tip label={tip}>
        <Dropdown.Trigger asChild>
          <IconButton tip={false} label={tip} active={open} className={cx(eff.quiet && !open && 'text-faint', className)}>
            <Icon className="size-[18px]" />
          </IconButton>
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} collisionPadding={16} className={menuBox} aria-label={t('chat.notify')}>
          <NotifyMenuItems
            title={t('chat.notify')}
            options={options}
            value={value}
            mutedUntil={eff.room.mutedUntil}
            defaultLevel={NotificationLevel.INHERIT}
            note={wsMuted && !eff.room.mutedUntil ? t('chat.notifyWsMutedUntil', { time: fmt.until(new Date(wsMuted)) }) : undefined}
            onChange={(level, until) => void setRoomNotifications(roomId, level, until)}
          />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Topic: one line with ellipsis; click shows the whole text. */
function Topic({ topic }: { topic: string }): ReactNode {
  return (
    <Popover.Root modal={false}>
      <span className="text-faint" aria-hidden>
        •
      </span>
      <Popover.Trigger asChild>
        <button data-header-fill type="button" className="no-drag min-w-0 flex-1 truncate text-left text-body text-muted hover:text-fg" title={topic} aria-label={t('chat.topic')}>
          {topic}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="mat-popover anim-in selectable z-[var(--z-popover)] max-w-[min(480px,calc(100vw-32px))] whitespace-pre-wrap break-words rounded-[var(--radius-card)] px-3 py-2 text-body text-fg"
        >
          {topic}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function PinsButton({ workspaceId, roomId, canManage }: { workspaceId: string; roomId: string; canManage: boolean }): ReactNode {
  const pins = useMessages((s) => s.pins[roomId] ?? NO_PINS);
  const jump = useChatView((s) => s.requestJump);
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={t('chat.pinned')}>
        <Popover.Trigger asChild>
          <IconButton tip={false} label={pins.length ? `${t('chat.pinned')}: ${pins.length}` : t('chat.pinned')} active={open}>
            <Pin className="size-[18px]" />
          </IconButton>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('chat.pinned')}
          className="mat-popover dense anim-in z-[var(--z-popover)] flex max-h-[min(480px,70vh)] w-[360px] flex-col overflow-hidden rounded-[var(--radius-panel)]"
        >
          <div className="border-b border-line px-4 py-2.5 text-body font-semibold">{t('chat.pinned')}</div>
          {pins.length === 0 ? (
            <p className="px-4 py-8 text-center text-body text-muted">{t('chat.noPins')}</p>
          ) : (
            <ul className="min-h-0 overflow-y-auto p-1">
              {pins.map((m) => {
                const d = toDate(m.createdAt);
                return (
                  <li key={m.id} className="group flex items-start gap-1 rounded-[var(--radius-row)] hover:bg-hover">
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-3 py-2 text-left"
                      onClick={() => {
                        jump(roomId, m.id);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-body font-semibold">{memberName(workspaceId, m.authorId)}</span>
                        <span className="shrink-0 text-caption text-faint">
                          {fmt.dayLabel(d)}, {fmt.time(d)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-body text-muted">
                        <PinPreview workspaceId={workspaceId} m={m} />
                      </span>
                    </button>
                    {canManage ? (
                      <IconButton
                        label={t('chat.unpin')}
                        size="sm"
                        className={cx('mr-1 mt-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                        onClick={() => void setPinned(m, false)}
                      >
                        <PinOff className="size-4" />
                      </IconButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A pinned message in the pins list: system text, the message (code monospace) or «Вложение». */
function PinPreview({ workspaceId, m }: { workspaceId: string; m: Message }): ReactNode {
  const sys = systemPreview(m);
  if (sys) return sys;
  const parts = previewPartsOf(workspaceId, m.content, 400);
  return parts.length ? <PreviewRuns parts={parts} /> : m.attachments.length ? t('chat.attachment') : '';
}
