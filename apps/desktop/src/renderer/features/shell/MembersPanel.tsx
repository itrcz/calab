import * as Popover from '@radix-ui/react-popover';
import { WorkspaceRole, type UpcomingBirthday, type WorkspaceMember } from '@calaba/protocol';
import { ChevronRight, MonitorUp, Phone, Video, Volume2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { type MessageKey, t, useLocale } from '../../i18n';
import { greetingRoomId, useRooms } from '../../stores/rooms';
import { useConnectingRing, useVoiceStateOf, useVoiceStates } from '../../stores/voicePending';
import { useVoice } from '../../stores/voice';
import { isGuest, useMemberName, useRoleLook, useWorkspaces } from '../../stores/workspaces';
import { BotBadge, GuestBadge, roleTextClass, roleTextStyle } from '../people/MemberBits';
import { BadgeOrRoleMark } from '../people/MemberBadge';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { BirthdayMark } from '../people/Birthday';
import { MutedByMe } from '../../components/SpeakerIdentity';
import { MusicianIcon, VoiceStateIcons } from '../voice/VoiceStateIcons';
import { JustJoinedDot } from '../voice/JustJoinedDot';
import { joinedAtMs } from '../../lib/justJoined';
import { customStatusLine, groupMembers, memberActivity, memberSecondLine, nameOf } from '../people/members';
import { openProfile as openFullProfile } from '../people/actions';
import { useUpcomingBirthdays } from '../people/upcomingBirthdays';
import { cardDueAt, formatBirthdayShort, greetZone } from '../../lib/birthday';
import { fmt } from '../../lib/format';
import { useSession } from '../../stores/session';
import { congratulate } from '../people/congratulate';
import { NicknameDialog } from '../people/NicknameDialog';
import { ProfileCard } from '../people/ProfileCard';
import { useOnCall } from '../call/CallBits';
import { DRAG_USER } from '../calendar/dragState';
import { AdmissionsGroup } from '../guests/AdmissionsGroup';
import { useKnockingKey } from '../guests/stores/admissions';
import { SipDialButton } from '../voice/Sip';

export const ROLE_LABEL: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

/**
 * Members column (docs/09 #12): 240 px next to the chat from MEMBERS_COLUMN_MIN, a floating
 * panel below it (Esc closes it: services/hotkeys.ts). Groups «В сети» / «Не в сети», each ordered owner → admins →
 * members → guests, then «Боты» (ADR-0031: bots are not people online or offline — their own
 * section, like Discord's apps). With a handful of built-in roles, role headers would mostly be groups of
 * one, so the role shows as the name colour (+ RoleMark: crown / shield) instead — the Discord look without
 * the noise. Click → profile, right click → member menu.
 */
export function MembersPanel({ workspaceId, floating = false, drawer = false }: { workspaceId: string; floating?: boolean; drawer?: boolean }): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const presences = useWorkspaces((s) => s.presences);
  const voice = useVoiceStates(workspaceId); // + me while connecting (optimistic join)
  // Guests still knocking (ADR-0040) are not in yet: only in «Ожидают подтверждения», not as members.
  const knocking = useKnockingKey(workspaceId);
  const groups = useMemo(() => {
    const out = knocking ? new Set(knocking.split(',')) : null;
    const list = Object.values(members ?? {});
    return groupMembers(out ? list.filter((m) => !out.has(m.user?.id ?? '')) : list, presences, voice);
  }, [members, presences, voice, knocking]);
  const [profile, setProfile] = useState<string | null>(null);
  // Stable: a new closure per row each render defeated MemberRow's memo (every presence change
  // re-rendered every row). A row closes only its own card: a late close from the previous row
  // (Radix dismiss / close focus) must not wipe the card another row just opened.
  const openProfile = useCallback((userId: string | null, open: boolean) => setProfile((cur) => (open ? userId : cur === userId ? null : cur)), []);

  const section = (key: 'on' | 'off' | 'bots', title: string, list: WorkspaceMember[]): ReactNode =>
    list.length > 0 ? (
      <section aria-labelledby={`members-${key}`} className="mt-4 flex flex-col first:mt-0">
        <h3 id={`members-${key}`} className="px-2 pb-1 text-micro font-semibold uppercase tracking-wide text-faint">
          {title} — {list.length}
        </h3>
        <ul className="flex flex-col gap-px">
          {list.map((m) => (
            <li key={m.user?.id}>
              <MemberRow
                workspaceId={workspaceId}
                member={m}
                offline={key === 'off'}
                open={profile === m.user?.id}
                onOpenProfile={openProfile}
              />
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <aside
      className={
        drawer
          ? // phone layout (ADR-0021): fills the right drawer (MobileShell)
            'min-h-0 flex-1 overflow-y-auto px-2 pb-[calc(var(--safe-bottom,0px)+16px)] pt-4'
          : floating
          ? 'mat-popover dense anim-in absolute bottom-[calc(var(--composer-height,64px)+8px)] right-3 top-[60px] z-[var(--z-popover)] w-60 overflow-y-auto rounded-[var(--radius-panel)] px-2 py-3'
          : 'mat-sidebar w-60 shrink-0 overflow-y-auto border-l border-line px-2 pb-4 pt-4'
      }
      aria-label={t('shell.members')}
    >
      {drawer ? <DrawerDial workspaceId={workspaceId} /> : null}
      <AdmissionsGroup workspaceId={workspaceId} />
      <BirthdaysSection workspaceId={workspaceId} />
      {section('on', t('members.online'), groups.online)}
      {section('off', t('members.offline'), groups.offline)}
      {section('bots', t('bots.section'), groups.bots)}
      {groups.online.length + groups.offline.length + groups.bots.length === 0 ? <p className="px-2 text-body text-muted">{t('people.empty')}</p> : null}
    </aside>
  );
}

/**
 * Phone layout (ADR-0021): «Позвонить на номер» on top of the members drawer for the room of my
 * call (ADR-0046) — the room header there has no room for it. Nothing unless the gate passes.
 */
function DrawerDial({ workspaceId }: { workspaceId: string }): ReactNode {
  const roomId = useVoice((s) => (s.workspaceId === workspaceId ? s.roomId : null));
  return roomId ? <SipDialButton workspaceId={workspaceId} roomId={roomId} variant="sheet" /> : null;
}

/**
 * Birthdays above «В сети» (docs/09 #76, #100; docs/08 «Панель участников — дни рождения»):
 * today's people on a festive plate at the very top (the chat card's gradient + 🎂, one plate
 * with a row per person), then «Скоро» — the next 7 days, collapsed: name and a short date. Only
 * when there is someone. Its own query subscription and a useShallow slice of the members by id:
 * presence or voice changes elsewhere do not re-render it.
 */
const BirthdaysSection = memo(function BirthdaysSection({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const upcoming = useUpcomingBirthdays(workspaceId);
  const [soonOpen, setSoonOpen] = useState(false);
  const list = upcoming ?? NONE;
  // The people (bots have none; members who left are skipped).
  const members = useWorkspaces(
    useShallow((s) =>
      list.map((b) => {
        const m = s.byId[workspaceId]?.members[b.userId];
        return m?.user && !m.user.isBot ? m : undefined;
      }),
    ),
  );
  const today: UpcomingBirthday[] = [];
  const soon: { m: WorkspaceMember; label: string }[] = [];
  list.forEach((b, i) => {
    const m = members[i];
    if (!m || !b.birthday) return;
    if (b.inDays === 0) today.push(b);
    else soon.push({ m, label: formatBirthdayShort(b.birthday) });
  });
  if (today.length + soon.length === 0) return null;
  return (
    <section aria-labelledby="members-bday" className="mt-4 flex flex-col first:mt-0" data-testid="members-birthdays">
      {today.length > 0 ? (
        <div
          data-testid="members-birthday-plate"
          className="birthday-surface mb-2 flex flex-col gap-2 rounded-[var(--radius-card)] px-3 py-2.5 shadow-[var(--shadow-card)]"
        >
          <h3 id="members-bday" className="flex items-center gap-2 text-body font-semibold">
            <span aria-hidden className="text-[22px] leading-none">
              🎂
            </span>
            <span className="min-w-0">{t('birthday.cardTitle')}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {today.map((b) => (
              <li key={b.userId}>
                <PlateRow workspaceId={workspaceId} userId={b.userId} day={b.birthday?.day ?? 0} month={b.birthday?.month ?? 0} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <h3 id="members-bday" className="px-2 pb-1 text-micro font-semibold uppercase tracking-wide text-faint">
          🎂 {t('birthday.tableTitle')} — {soon.length}
        </h3>
      )}
      {soon.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={soonOpen}
            data-testid="members-birthdays-soon"
            className="flex h-7 w-full items-center gap-1 rounded-[var(--radius-row)] px-2 text-left text-caption text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
            onClick={() => setSoonOpen((v) => !v)}
          >
            <ChevronRight className={cx('size-3.5 shrink-0 transition-transform duration-[var(--motion-fast)]', soonOpen && 'rotate-90')} aria-hidden />
            <span className="truncate">
              {t('birthday.soon')} — {soon.length}
            </span>
          </button>
          {soonOpen ? (
            <ul className="flex flex-col gap-px">
              {soon.map(({ m, label }) => {
                const id = m.user?.id ?? '';
                const name = nameOf(m);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-label={`${t('people.openProfile', { name })} · ${label}`}
                      className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover"
                      onClick={() => openFullProfile(workspaceId, id)}
                    >
                      <Avatar userId={id} name={name} fileId={m.user?.avatarFileId || undefined} size={20} />
                      <span className="min-w-0 flex-1 truncate text-body">{name}</span>
                      <span className="shrink-0 text-caption tabular-nums text-muted">{label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
});

/**
 * One celebrant on the plate: avatar 28 · **name** (opens the profile) · «Поздравить» (docs/09
 * #120: opens the greeting room — where the card is posted — scrolls to today's card and puts
 * `@Имя ` in the composer; not for myself, none without a text room; the DM stays in the
 * profile), and before the chat card is posted a quiet «Открытка в чате появится в 09:00».
 * Primitive props and selectors by id.
 */
const PlateRow = memo(function PlateRow({ workspaceId, userId, day, month }: { workspaceId: string; userId: string; day: number; month: number }): ReactNode {
  useLocale();
  const name = useMemberName(workspaceId, userId);
  const avatarFileId = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId || undefined);
  const me = useSession((s) => s.me?.user?.id ?? '');
  // A primitive: room list changes elsewhere (unread counts…) do not re-render the row.
  const hasRoom = useRooms((s) => !!greetingRoomId(s.byId, s.categories, workspaceId));
  return (
    // The panel is 240 px: name and hint get the full width, the button goes under them.
    <div className="flex min-w-0 items-start gap-2" data-testid="members-birthday-today">
      <Avatar userId={userId} name={name} fileId={avatarFileId} size={28} />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <button
          type="button"
          aria-label={t('people.openProfile', { name })}
          className="w-full min-w-0 truncate rounded-[var(--radius-control)] text-left text-body font-semibold leading-[18px] hover:underline"
          onClick={() => openFullProfile(workspaceId, userId)}
        >
          {name}
        </button>
        <CardHint workspaceId={workspaceId} userId={userId} day={day} month={month} />
        {hasRoom && userId !== me ? (
          <button
            type="button"
            aria-label={t('birthday.congratulateName', { name })}
            data-testid="members-birthday-congratulate"
            className="mt-1 h-6 rounded-[var(--radius-control)] bg-white px-2.5 text-caption font-semibold text-[color:var(--color-accent-strong)] transition-colors duration-[var(--motion-fast)] hover:bg-white/90"
            onClick={() => congratulate(workspaceId, userId, { day, month })}
          >
            {t('birthday.congratulate')}
          </button>
        ) : null}
      </span>
    </div>
  );
});

/**
 * «Открытка в чате появится в 09:00» while the server has not posted the card yet (the same rule:
 * 09:00 of greetZone — the celebrant's zone, else the owner's, else UTC — shown in my local
 * time). One timeout to that moment hides it; no ticking.
 */
function CardHint({ workspaceId, userId, day, month }: { workspaceId: string; userId: string; day: number; month: number }): ReactNode {
  const tz = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.timezone);
  const ownerTz = useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    return e ? e.members[e.ws.ownerId]?.user?.timezone : undefined;
  });
  const [, setPassed] = useState(0);
  const due = cardDueAt({ day, month }, greetZone(tz, ownerTz));
  const dueMs = due?.getTime() ?? 0;
  useEffect(() => {
    if (!dueMs) return undefined;
    const id = window.setTimeout(() => setPassed((n) => n + 1), Math.max(0, dueMs - Date.now()) + 1000);
    return () => window.clearTimeout(id);
  }, [dueMs]);
  if (!due) return null;
  return (
    <span className="text-caption leading-4" data-testid="members-birthday-hint">
      {t('birthday.cardAt', { time: fmt.time(due) })}
    </span>
  );
}

const NONE: never[] = [];

/** One 42 px row; memoised so presence changes re-render only that row. */
const MemberRow = memo(function MemberRow({
  workspaceId,
  member: m,
  offline,
  open,
  onOpenProfile,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  offline: boolean;
  open: boolean;
  onOpenProfile: (userId: string | null, open: boolean) => void;
}): ReactNode {
  // Memo row: re-render on a language switch too (ADR-0022).
  useLocale();
  const u = m.user;
  const userId = u?.id ?? '';
  const onOpenChange = useCallback((o: boolean) => onOpenProfile(u?.id ?? null, o), [onOpenProfile, u?.id]);
  const v = useVoiceStateOf(workspaceId, userId);
  const connectingRing = useConnectingRing(workspaceId, userId, v?.pending ?? false);
  const roomName = useRooms((s) => (v?.roomId ? s.byId[v.roomId]?.name : undefined));
  const look = useRoleLook(workspaceId, userId);
  // In a one-to-one call (ADR-0034, Presence.on_call): a primitive per row.
  const onCall = useOnCall(userId);
  const [renaming, setRenaming] = useState(false);
  // A press on another member row moves the card there (docs/08 «Карточка участника»): not an
  // outside click — that row's own click opens its card, which closes this one via `open`. The
  // close must then not return focus to this row's trigger (Radix does on a non-outside close):
  // that focus would land outside the new card and dismiss it at once.
  const switching = useRef(false);
  const onInteractOutside = useCallback((e: Event) => {
    const row = (e.target as Element | null)?.closest('[data-member-row]');
    if (row && row.getAttribute('data-member-row') !== userId) {
      switching.current = true;
      e.preventDefault();
    }
  }, [userId]);
  const onCloseAutoFocus = useCallback((e: Event) => {
    if (switching.current) e.preventDefault();
    switching.current = false;
  }, []);
  if (!u) return null;
  const name = nameOf(m);
  // Second line (docs/08 «Колонка участников»): the custom status stays visible in voice — the
  // live activity (stream / voice room / call) follows it compactly after «·»; one 16 px line
  // either way, so the row height never changes.
  const line = memberSecondLine(customStatusLine(u), memberActivity(v, onCall));
  let activity: ReactNode = null;
  let activityLabel = '';
  if (line.activity === 'stream') {
    activityLabel = t('people.streaming');
    activity = (
      <>
        <MonitorUp className="size-3.5 shrink-0 text-danger" aria-hidden />
        <span className="min-w-0 truncate">{activityLabel}</span>
      </>
    );
  } else if (line.activity === 'voice' && v) {
    activityLabel = roomName ?? t('people.inVoice');
    activity = (
      <>
        <Volume2 className="size-3.5 shrink-0 text-ok" aria-hidden />
        <span className="min-w-0 truncate">{activityLabel}</span>
        {v.camera ? <Video className="size-3.5 shrink-0" aria-label={t('video.stateOn')} role="img" /> : null}
        {v.musician ? <MusicianIcon className="size-3.5" /> : null}
        <VoiceStateIcons muted={v.muted} deafened={v.deafened} serverMuted={v.serverMuted} />
      </>
    );
  } else if (line.activity === 'call') {
    activityLabel = t('call.onCall');
    activity = (
      <>
        <Phone className="size-3.5 shrink-0 text-ok" aria-hidden />
        <span className="min-w-0 truncate">{activityLabel}</span>
      </>
    );
  }
  const second: ReactNode = line.compact ? (
    <>
      <span className="min-w-0 max-w-[70%] shrink-0 truncate" data-testid="member-custom-status">
        {line.status}
      </span>
      <span aria-hidden className="shrink-0 text-faint">
        ·
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1" data-testid="member-activity">
        {activity}
      </span>
    </>
  ) : line.status ? (
    <span className="truncate" data-testid="member-custom-status">
      {line.status}
    </span>
  ) : activity ? (
    activity
  ) : u.username && !u.isBot ? (
    // The nickname (ADR-0077) when nothing more current is to be said.
    <span className="truncate">@{u.username}</span>
  ) : null;
  const secondTitle = [line.status, activityLabel].filter(Boolean).join(' · ');

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <MemberContextMenu workspaceId={workspaceId} userId={userId}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={t('people.openProfile', { name })}
            data-member-row={userId}
            // A member dragged onto a meeting (the dialog's attendees, the card — ADR-0038, owner 29.09).
            draggable={!u.isBot && !isGuest(m)}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_USER, userId);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            title={connectingRing ? `${name} · ${t('voice.pendingMember')}` : name}
            className={cx(
              'relative flex h-[42px] w-full items-center gap-3 rounded-[var(--radius-row)] px-2 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover',
              open && 'bg-active',
            )}
          >
            {/* «Только вошёл» in voice: in the 8 px row padding, 2 px left of the 32 px avatar. */}
            {v?.roomId ? <JustJoinedDot joinedAt={joinedAtMs(v.joinedAt)} className="absolute left-0 top-1/2 -translate-y-1/2" /> : null}
            {/* Offline: grey, faded avatar + secondary text — never opacity on text (≥ 4.5:1). */}
            <span className={cx('flex shrink-0', offline && 'opacity-60 grayscale')}>
              <Avatar userId={userId} name={name} fileId={u.avatarFileId || undefined} size={32} presence connecting={connectingRing} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className={cx('truncate text-body font-medium leading-[18px]', roleTextClass(m.role, offline ? 'muted' : 'role', look))}
                  style={roleTextStyle(m.role, offline ? 'muted' : 'role', look)}
                >
                  {name}
                </span>
                <BadgeOrRoleMark workspaceId={workspaceId} userId={userId} role={m.role} custom={look} tone={offline ? 'muted' : 'role'} badgeClassName={offline ? 'opacity-60 grayscale' : undefined} />
                <BirthdayMark userId={userId} />
                {onCall ? <Phone className="size-3.5 shrink-0 text-ok" role="img" aria-label={t('call.onCall')} /> : null}
                {isGuest(m) ? <GuestBadge /> : null}
                {u.isBot ? <BotBadge /> : null}
                <MutedByMe userId={userId} className="size-3.5" />
              </span>
              {second ? (
                <span className="flex min-w-0 items-center gap-1 text-caption leading-4 text-muted" title={secondTitle}>
                  {second}
                </span>
              ) : null}
            </span>
          </button>
        </Popover.Trigger>
      </MemberContextMenu>
      <Popover.Portal>
        <Popover.Content
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="mat-popover dense anim-in z-[var(--z-popover)] rounded-[var(--radius-panel)] text-fg focus:outline-none"
          aria-label={name}
          onInteractOutside={onInteractOutside}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <ProfileCard
            workspaceId={workspaceId}
            userId={userId}
            onRename={() => {
              onOpenChange(false);
              setRenaming(true);
            }}
            onClose={() => onOpenChange(false)}
          />
        </Popover.Content>
      </Popover.Portal>
      {renaming ? <NicknameDialog workspaceId={workspaceId} userId={userId} onClose={() => setRenaming(false)} /> : null}
    </Popover.Root>
  );
});
