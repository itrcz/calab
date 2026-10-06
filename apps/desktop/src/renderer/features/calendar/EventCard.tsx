import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { AttendeeStatus, EventRepeat, RoomType, WorkspaceRole, type CalendarEvent, type CalendarEventAttendee } from '@calaba/protocol';
import { ArrowLeft, Check, CircleHelp, Clock, Copy, FileAudio, Link2, Mail, Pencil, Repeat, Timer, Trash2, Volume2, X, CircleDashed } from 'lucide-react';
import { Suspense, lazy, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { ProfileTarget } from '../../components/ProfileTarget';
import { Button, CloseButton, IconButton, cx } from '../../components/ui';
import { t, useLocale, type MessageKey } from '../../i18n';
import { keyEventId, myStatusOf, occKey } from '../../lib/calendar/events';
import { eventSpan, formatWhen } from '../../lib/calendar/time';
import { fmt } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { answer, addAttendee, canEditEvent, copyEventLink, goToRoom, setEventRoom } from '../../services/calendar';
import { useCalendar } from '../../stores/calendar';
import { useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';
import { cancelWithConfirm, duplicateEvent, editEvent } from './actions';
import { dragKind, dragPayload, useRoomDropHover } from './dragState';

const RecordingTranscript = lazy(() => import('../chat/RecordingTranscript'));

export const REPEAT_LABEL: Record<EventRepeat, MessageKey> = {
  [EventRepeat.UNSPECIFIED]: 'cal.repeat.none',
  [EventRepeat.DAILY]: 'cal.repeat.daily',
  [EventRepeat.WEEKLY]: 'cal.repeat.weekly',
  [EventRepeat.BIWEEKLY]: 'cal.repeat.biweekly',
  [EventRepeat.MONTHLY]: 'cal.repeat.monthly',
};

const STATUS_LABEL: Record<AttendeeStatus, MessageKey> = {
  [AttendeeStatus.UNSPECIFIED]: 'cal.status.pending',
  [AttendeeStatus.PENDING]: 'cal.status.pending',
  [AttendeeStatus.ACCEPTED]: 'cal.status.accepted',
  [AttendeeStatus.DECLINED]: 'cal.status.declined',
  [AttendeeStatus.MAYBE]: 'cal.status.maybe',
};

/** Attendee status glyph (✓ ✗ ? ·), with its name for screen readers. */
export function StatusIcon({ status, className }: { status: AttendeeStatus; className?: string }): ReactNode {
  const label = t(STATUS_LABEL[status]);
  const cls = cx('size-3.5 shrink-0', className);
  if (status === AttendeeStatus.ACCEPTED) return <Check className={cx(cls, 'text-[var(--color-green-text)]')} aria-label={label} role="img" />;
  if (status === AttendeeStatus.DECLINED) return <X className={cx(cls, 'text-danger-text')} aria-label={label} role="img" />;
  if (status === AttendeeStatus.MAYBE) return <CircleHelp className={cx(cls, 'text-warn')} aria-label={label} role="img" />;
  return <CircleDashed className={cx(cls, 'text-faint')} aria-label={label} role="img" />;
}

/**
 * The right panel of the day view (ADR-0038 §7: «справа вместо участников — выбранная встреча»): a
 * column from 1200 px, a floating panel over the grid below (like the members list); on a phone the
 * whole screen with ←.
 */
export function EventPanel({ occ, floating = false, page = false }: { occ: string; floating?: boolean; page?: boolean }): ReactNode {
  const ev = useCalendar((s) => s.occ[occ] ?? s.series[keyEventId(occ)]);
  const close = (): void => useUi.getState().selectCalEvent(null);
  if (!ev) return null;
  return (
    <aside
      aria-label={t('cal.card')}
      data-testid="event-panel"
      className={
        page
          ? 'mat-content flex min-h-0 flex-1 flex-col'
          : floating
            ? 'mat-popover anim-in absolute bottom-3 right-3 top-[60px] z-[var(--z-popover)] flex w-80 flex-col overflow-hidden rounded-[var(--radius-panel)]'
            : 'mat-sidebar flex w-80 shrink-0 flex-col border-l border-line'
      }
    >
      <EventCard event={ev} occ={occ} onClose={close} variant={page ? 'page' : 'panel'} />
    </aside>
  );
}

/**
 * The meeting card (ADR-0038 §7), one component for the day view's panel, the room badge's popover
 * and the phone's full screen: title, date and time in my zone, repeat, room + «Перейти»,
 * organizer, my answer (Приму / Отклоню / Может быть), recording, description, attendees with their
 * answers, «Изменить» / «Отменить» for those allowed. A member dropped on it becomes an attendee, a
 * voice room its room (owner addendum, editors only).
 */
export function EventCard({
  event: ev,
  occ,
  onClose,
  variant,
}: {
  event: CalendarEvent;
  occ?: string;
  onClose?: () => void;
  variant: 'panel' | 'popover' | 'page';
}): ReactNode {
  useLocale();
  const me = myUserId();
  const key = occ ?? occKey(ev);
  const room = useRooms((s) => (ev.roomId ? s.byId[ev.roomId] : undefined));
  const guest = useWorkspaces((s) => s.byId[ev.workspaceId]?.role === WorkspaceRole.GUEST);
  const organizer = useMemberName(ev.workspaceId, ev.organizerId);
  const organizerAvatar = useWorkspaces((s) => s.byId[ev.workspaceId]?.members[ev.organizerId]?.user?.avatarFileId ?? '');
  const editable = !guest && canEditEvent(ev);
  const mine = myStatusOf(ev, me);
  const attending = !guest && ev.attendees.some((a) => a.userId === me) && ev.organizerId !== me;
  const [transcript, setTranscript] = useState(false);
  const drop = useDropTarget(key, editable);
  const externals = ev.attendees.filter((a) => !a.userId);

  // «Дублировать» and «Копировать ссылку» next to «×» (the block's context menu has them too).
  const tools = (
    <>
      {!guest ? (
        <IconButton size="sm" label={t('cal.duplicate')} onClick={() => duplicateEvent(key)}>
          <Copy className="size-4" />
        </IconButton>
      ) : null}
      <IconButton size="sm" label={t('cal.copyLink')} onClick={() => copyEventLink(ev.id)}>
        <Link2 className="size-4" />
      </IconButton>
    </>
  );
  const title = (
    <h2 className={cx('min-w-0 flex-1 break-words font-semibold', variant === 'popover' ? 'text-body' : 'text-headline')} data-testid="event-title">
      {ev.title}
    </h2>
  );

  return (
    <div {...drop.props} className={cx('relative flex min-h-0 flex-1 flex-col', drop.over && 'outline outline-2 -outline-offset-2 outline-accent')} data-testid="event-card">
      <div className={cx('flex items-start gap-2', variant === 'popover' ? 'px-3 pt-3' : variant === 'page' ? 'mat-toolbar h-12 shrink-0 items-center border-b border-line px-1' : 'px-4 pt-4')}>
        {variant === 'page' ? (
          <>
            <IconButton label={t('cal.back')} onClick={onClose} className="size-10 rounded-full">
              <ArrowLeft className="size-5" />
            </IconButton>
            <span className="min-w-0 flex-1 truncate text-list font-semibold">{t('cal.card')}</span>
            {tools}
          </>
        ) : (
          <>
            {title}
            <span className="-mr-1 -mt-0.5 flex shrink-0 items-center">
              {tools}
              {onClose ? <CloseButton label={t('cal.closeCard')} onClick={onClose} /> : null}
            </span>
          </>
        )}
      </div>
      <div className={cx('min-h-0 flex-1 overflow-y-auto', variant === 'popover' ? 'px-3 pb-3' : 'px-4 pb-4', variant === 'page' && 'pt-4')}>
        {variant === 'page' ? <div className="mb-1">{title}</div> : null}
        <Line icon={<Clock className="size-4" aria-hidden />}>
          <span data-testid="event-when">{formatWhen(ev)}</span>
        </Line>
        {ev.repeat !== EventRepeat.UNSPECIFIED ? (
          <Line icon={<Repeat className="size-4" aria-hidden />}>
            {ev.repeatUntil
              ? t('cal.repeatUntil', { repeat: t(REPEAT_LABEL[ev.repeat]), date: fmt.date(new Date(timestampMs(ev.repeatUntil))) })
              : t(REPEAT_LABEL[ev.repeat])}
          </Line>
        ) : null}
        {room ? (
          <Line icon={room.expiresAt ? <Timer className="size-4" aria-label={t('temp.icon')} role="img" /> : <Volume2 className="size-4" aria-hidden />}>
            <span className="min-w-0 flex-1 truncate">{room.name}</span>
            <Button size="sm" variant="secondary" onClick={() => goToRoom(ev)} aria-label={t('cal.goRoom', { room: room.name })} data-testid="event-go">
              {t('cal.go')}
            </Button>
          </Line>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <ProfileTarget userId={ev.organizerId} name={organizer} workspaceId={ev.workspaceId} tabbable className="flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] text-left">
            <Avatar userId={ev.organizerId} name={organizer} {...(organizerAvatar ? { fileId: organizerAvatar } : {})} size={20} />
            <span className="min-w-0 truncate text-body">{organizer}</span>
          </ProfileTarget>
          <span className="shrink-0 text-caption text-muted">{t('cal.organizer')}</span>
        </div>

        {attending ? <RsvpButtons ev={ev} mine={mine} /> : null}

        {ev.recordingId && room ? (
          <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-card)] bg-[var(--color-card)] px-2.5 py-2">
            <FileAudio className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-body">{t('cal.recording')}</span>
            <Button size="sm" variant="secondary" onClick={() => setTranscript(true)}>
              {t('cal.transcript')}
            </Button>
          </div>
        ) : null}

        {ev.description ? (
          <section className="mt-3" aria-label={t('cal.description')}>
            <div className="select-text whitespace-pre-wrap break-words text-body text-fg [&_a]:text-accent-text">
              <Markdown text={ev.description} mention={(v, k) => <span key={k}>@{v}</span>} />
            </div>
          </section>
        ) : null}

        <Attendees ev={ev} guest={guest} />
        {ev.roomId && externals.length > 0 && !ev.guestLinks && !guest ? <p className="mt-2 text-caption text-muted">{t('cal.noGuestLinks')}</p> : null}
      </div>
      {editable ? (
        <div className={cx('flex shrink-0 flex-wrap items-center gap-2 border-t border-line', variant === 'popover' ? 'px-3 py-2' : 'px-4 py-3')}>
          <Button size="sm" variant="secondary" onClick={() => editEvent(key)} data-testid="event-edit">
            <Pencil className="size-3.5" aria-hidden />
            {t('cal.edit')}
          </Button>
          <CancelButton ev={ev} occ={key} />
        </div>
      ) : null}
      {drop.over ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-[var(--radius-card)] bg-accent-strong px-3 py-1.5 text-center text-caption font-medium text-accent-fg">{t('cal.dropHere')}</div>
      ) : null}
      {transcript && ev.recordingId && ev.roomId ? (
        <Suspense fallback={null}>
          <RecordingTranscript roomId={ev.roomId} recordingId={ev.recordingId} title={ev.title} started={new Date(eventSpan(ev).start)} track={null} onClose={() => setTranscript(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="mt-2 flex min-h-7 items-center gap-2 text-body text-fg">
      <span className="grid size-5 shrink-0 place-items-center text-muted">{icon}</span>
      {children}
    </div>
  );
}

const RSVP: Array<{ status: AttendeeStatus; key: MessageKey }> = [
  { status: AttendeeStatus.ACCEPTED, key: 'cal.rsvp.accept' },
  { status: AttendeeStatus.DECLINED, key: 'cal.rsvp.decline' },
  { status: AttendeeStatus.MAYBE, key: 'cal.rsvp.maybe' },
];

/** «Приму / Отклоню / Может быть» — my current answer highlighted (informational, ADR-0038). */
export function RsvpButtons({
  ev,
  mine,
  onAnswer,
  className = 'mt-3',
}: {
  ev?: CalendarEvent;
  mine: AttendeeStatus;
  onAnswer?: (s: AttendeeStatus) => void;
  className?: string;
}): ReactNode {
  // Unique: the meeting panel and an external event's popover can be open together.
  const labelId = useId();
  return (
    <div className={className}>
      <p id={labelId} className="mb-1.5 text-caption font-medium text-muted">
        {t('cal.rsvp.title')}
      </p>
      <div role="group" aria-labelledby={labelId} className="grid grid-cols-3 gap-1 rounded-[var(--radius-control)] bg-hover p-0.5" data-testid="rsvp">
        {RSVP.map((r) => {
          const on = mine === r.status;
          return (
            <button
              key={r.status}
              type="button"
              aria-pressed={on}
              onClick={() => (onAnswer ? onAnswer(r.status) : ev && void answer(ev, r.status))}
              className={cx(
                'h-7 min-w-0 truncate rounded-full px-1 text-control font-medium transition-colors duration-[var(--motion-fast)] mobile:h-9',
                on ? 'bg-accent-strong text-accent-fg' : 'text-fg hover:bg-[var(--color-fill)]',
              )}
            >
              {t(r.key)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Attendees with their answers and the counts; guests see the counts only. */
function Attendees({ ev, guest }: { ev: CalendarEvent; guest: boolean }): ReactNode {
  const c = ev.counts;
  return (
    <section className="mt-4" aria-labelledby="event-attendees">
      <h3 id="event-attendees" className="flex items-center gap-2 text-micro font-semibold uppercase tracking-wide text-faint">
        <span>
          {t('cal.attendees')} — {ev.attendees.length}
        </span>
      </h3>
      {c ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted" aria-label={t('cal.counts')} data-testid="event-counts">
          <Count status={AttendeeStatus.ACCEPTED} n={c.accepted} />
          <Count status={AttendeeStatus.DECLINED} n={c.declined} />
          <Count status={AttendeeStatus.MAYBE} n={c.maybe} />
          <Count status={AttendeeStatus.PENDING} n={c.pending} />
        </p>
      ) : null}
      {guest ? null : (
        <ul className="mt-2 flex flex-col gap-0.5">
          {ev.attendees.map((a) => (
            <AttendeeRow key={a.userId || a.email} workspaceId={ev.workspaceId} a={a} organizer={a.userId === ev.organizerId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Count({ status, n }: { status: AttendeeStatus; n: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={t(STATUS_LABEL[status])}>
      <StatusIcon status={status} className="size-3" />
      {n}
    </span>
  );
}

function AttendeeRow({ workspaceId, a, organizer }: { workspaceId: string; a: CalendarEventAttendee; organizer: boolean }): ReactNode {
  const name = useMemberName(workspaceId, a.userId);
  const avatar = useWorkspaces((s) => (a.userId ? (s.byId[workspaceId]?.members[a.userId]?.user?.avatarFileId ?? '') : ''));
  return (
    <li className="flex h-8 items-center gap-2" data-testid="event-attendee">
      {a.userId ? (
        <ProfileTarget userId={a.userId} name={name} workspaceId={workspaceId} tabbable className="flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] text-left">
          <Avatar userId={a.userId} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} />
          <span className="min-w-0 truncate text-body">{name}</span>
        </ProfileTarget>
      ) : (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-fill)]" title={t('cal.external')}>
          <Mail className="size-3 text-muted" aria-label={t('cal.external')} role="img" />
        </span>
      )}
      {a.userId ? null : <span className="min-w-0 truncate text-body">{a.email}</span>}
      {!a.required ? <span className="shrink-0 text-caption text-muted">{t('cal.optional')}</span> : null}
      {organizer ? <span className="shrink-0 text-caption text-muted">· {t('cal.organizer').toLowerCase()}</span> : null}
      <span className="flex-1" />
      <StatusIcon status={a.status} />
    </li>
  );
}

/** «Отменить встречу»; a series offers this occurrence or all of them. */
function CancelButton({ ev, occ }: { ev: CalendarEvent; occ: string }): ReactNode {
  if (ev.repeat === EventRepeat.UNSPECIFIED) {
    return (
      <Button size="sm" variant="destructive" onClick={() => void cancelWithConfirm(occ)} data-testid="event-cancel">
        <Trash2 className="size-3.5" aria-hidden />
        {t('cal.cancel')}
      </Button>
    );
  }
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <Button size="sm" variant="destructive" data-testid="event-cancel">
          <Trash2 className="size-3.5" aria-hidden />
          {t('cal.cancel')}
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="start" collisionPadding={16}>
          <Dropdown.Item className={menuItem} onSelect={() => void cancelWithConfirm(occ)}>
            {t('cal.cancelOne')}
          </Dropdown.Item>
          <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void cancelWithConfirm(occ, true)}>
            {t('cal.cancelAll')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/**
 * The card as a drop target (owner addendum): a member (native drag from the members panel) →
 * attendee; a voice room (native drag, or the room list's own reordering drag released here —
 * `calab-drop-room`) → the meeting's room. Editors only.
 */
function useDropTarget(key: string, editable: boolean): { over: boolean; props: Record<string, unknown> } {
  const [native, setOver] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // The room list's own drag (not a native one) over the card: highlighted the same way.
  const hovered = useRoomDropHover((s) => editable && s.el !== null && s.el === ref.current);
  const over = native || hovered;
  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;
    const onRoom = (e: Event): void => {
      const roomId = (e as CustomEvent<string>).detail;
      const room = useRooms.getState().byId[roomId];
      if (room?.type === RoomType.VOICE) void setEventRoom(key, roomId);
    };
    el.addEventListener('calab-drop-room', onRoom);
    return () => el.removeEventListener('calab-drop-room', onRoom);
  }, [key, editable]);
  if (!editable) return { over: false, props: { ref } };
  return {
    over,
    props: {
      ref,
      'data-drop-room': '',
      onDragOver: (e: DragEvent) => {
        if (!dragKind(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const p = dragPayload(e.dataTransfer);
        if (!p) return;
        e.preventDefault();
        if (p.userId) void addAttendee(key, p.userId);
        else if (p.roomId) {
          const room = useRooms.getState().byId[p.roomId];
          if (room?.type === RoomType.VOICE) void setEventRoom(key, p.roomId);
        }
      },
    },
  };
}
