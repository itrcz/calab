import { EventRepeat, RoomType, WorkspaceRole } from '@calaba/protocol';
import { CalendarSearch, Check, Mail, Plus, Timer, X } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { PickerPopover } from '../../components/picker/Picker';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { RoomIcon } from '../../components/RoomIcon';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, Input, Modal, Select, Switch, TextArea, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import {
  MAX_ATTENDEES,
  MAX_DESCRIPTION,
  MAX_TITLE,
  addEmail,
  addMember,
  addMembers,
  copyDraft,
  draftDirty,
  draftSpan,
  draftOf,
  fieldOf,
  newDraft,
  toCreate,
  toUpdate,
  validateDraft,
  type DraftErrors,
  type EventDraft,
} from '../../lib/calendar/draft';
import { dayKey, dayStart, eventSpan, formatMinutes, viewerZone } from '../../lib/calendar/time';
import { useMobile } from '../../lib/mobile';
import { mayCreateTempRooms } from '../../lib/permissions';
import { asksScope, touchesRepeat, type SeriesScope } from '../../lib/calendar/scope';
import { createEvent, ensureHolidayCalendar, eventOf, updateEvent, updateOccurrence } from '../../services/calendar';
import { useCalendar } from '../../stores/calendar';
import { roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { MEMBERS_COLUMN_MIN, type EventDraftInit } from '../../stores/ui';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { rolesOf, useFormerInfo, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { roomItems, type RoomPickItem } from '../chat/forwardModel';
import { FormerChip } from '../people/MemberBits';
import { memberItems, type PeoplePickItem, type RolePickItem } from '../people/memberPickItems';
import { MemberPicker } from '../people/MemberPicker';
import { useColleagueClocks } from '../people/useColleagueClocks';
import { REPEAT_LABEL } from './EventCard';
import { dragKind, dragPayload, useRoomDropHover } from './dragState';
import { AvailabilityStrip } from './AvailabilityStrip';
import { ZoneSpan } from './ZoneAxis';
import { FindTimeDialog } from './FindTime';
import { askSeriesScope } from './actions';

const REPEATS = [EventRepeat.UNSPECIFIED, EventRepeat.DAILY, EventRepeat.WORKDAYS, EventRepeat.WEEKLY, EventRepeat.BIWEEKLY, EventRepeat.MONTHLY] as const;
/** 00:00 … 23:45. */
const STARTS = Array.from({ length: 96 }, (_, i) => i * 15);

/**
 * Create / edit a meeting (ADR-0038 §7; docs/08 modal, a sheet on phones): title, date, start / end
 * in 15-minute steps (the viewer's zone, shown), «Весь день», room (a searchable pick of the voice
 * rooms, or none) or «Создать временную комнату» (ADR-0112, CREATE_TEMP_ROOMS, one-off meetings),
 * attendees (member chips, required / optional; external addresses), description, repeat with
 * «до», «Записывать встречу». Server errors show at their field. On the desktop the window stays
 * usable (no scrim): a member from the members list or a voice room from the room list can be
 * dragged in (owner, 29.09). Esc / a click outside closes it, asking first when something changed.
 */
export function EventDialog({ workspaceId, eventKey, draft: init, onClose }: { workspaceId: string; eventKey?: string; draft?: EventDraftInit; onClose: () => void }): ReactNode {
  const mobile = useMobile();
  const editing = eventKey ? eventOf(eventKey) : undefined;
  const initial = useMemo<EventDraft>(() => {
    if (editing) return draftOf(editing);
    const copy = init?.copyOf ? eventOf(init.copyOf) : undefined;
    if (copy) return copyDraft(copy);
    // «Подобрать время» hands over the chosen people; I am the organizer, not an attendee.
    const me = myUserId();
    const draft = newDraft({ ...init, attendees: (init?.attendees ?? []).filter((u) => u !== me) });
    return init?.title ? { ...draft, title: init.title.slice(0, MAX_TITLE) } : draft;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState<EventDraft>(initial);
  const [finding, setFinding] = useState(false);
  const meId = myUserId();
  // ADR-0112: the organizer with CREATE_TEMP_ROOMS asks for the meeting's own room (a one-off
  // meeting); once the server made it, the room field shows it with a note instead.
  const mayTemp = useWorkspaces((st) => mayCreateTempRooms(rolesOf(st.byId[workspaceId], meId)));
  const ownRoom = initial.tempRoom && !!initial.roomId && d.tempRoom && d.roomId === initial.roomId;
  const offerTemp = mayTemp && !ownRoom && d.repeat === EventRepeat.UNSPECIFIED && !editing?.seriesId && (!editing || editing.organizerId === meId);
  // Member attendees as a stable list (the availability strip's people).
  const memberKey = d.attendees.map((a) => a.userId).filter(Boolean).join(',');
  const memberIds = useMemo(() => (memberKey ? memberKey.split(',') : []), [memberKey]);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  // Server texts per field (a 422 with `field`), shown like the local checks.
  const [fieldText, setFieldText] = useState<Partial<Record<keyof DraftErrors, string>>>({});
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const asking = useRef(false);
  const zone = viewerZone();
  // An occurrence of a series is changed «Только эту / Всю серию» (ADR-0157), asked on saving; a
  // series opened without an occurrence changes as a whole: its first start, to shift by the move.
  const scoped = asksScope(editing);
  const [seriesStart, setSeriesStart] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!editing || editing.repeat === EventRepeat.UNSPECIFIED || scoped) return;
    let live = true;
    void api.calendar.get(editing.id).then(
      (r) => live && r.event && setSeriesStart(eventSpan(r.event).start),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // «В рабочие дни» (ADR-0136): a series keeps the calendar it was made with; a new choice takes
  // the workspace's (known once a list answered).
  const workdays = d.repeat === EventRepeat.WORKDAYS;
  const wsHolidays = useCalendar((st) => st.holidays[workspaceId]);
  const holidays = editing?.repeat === EventRepeat.WORKDAYS ? editing.holidayCalendar : wsHolidays;
  useEffect(() => {
    if (workdays) ensureHolidayCalendar(workspaceId);
  }, [workdays, workspaceId]);

  // A series' first start is needed to move it by the occurrence's shift: saving waits for it.
  const seriesPending = !!editing && editing.repeat !== EventRepeat.UNSPECIFIED && !scoped && seriesStart === undefined;

  const set = (patch: Partial<EventDraft>): void => {
    setD((x) => ({ ...x, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k as keyof DraftErrors];
      if ('start' in patch || 'end' in patch) delete next.end;
      return next;
    });
    setFieldText({});
  };

  const close = async (): Promise<void> => {
    if (asking.current) return;
    if (draftDirty(d, initial)) {
      asking.current = true;
      const ok = await confirmAction(t('cal.discardTitle'), t('cal.discardText'), t('cal.discard'));
      asking.current = false;
      if (!ok) return;
    }
    onClose();
  };

  const save = async (): Promise<void> => {
    const errs = validateDraft(d);
    setErrors(errs);
    setGeneral(null);
    if (Object.keys(errs).length) {
      if (errs.title) titleRef.current?.focus();
      return;
    }
    const patch = editing && eventKey ? toUpdate(d, initial, zone, scoped ? undefined : seriesStart) : null;
    let scope: SeriesScope | null = null;
    if (patch && scoped && Object.keys(patch).length) {
      // A new repeat is the series' from this occurrence on: nothing to ask.
      scope = touchesRepeat(patch) ? 'following' : await askSeriesScope('edit', draftSpan(initial).start);
      if (!scope) return; // back to the form
    }
    setBusy(true);
    try {
      if (editing && eventKey && patch) {
        if (scope) await updateOccurrence(eventKey, patch, scope);
        else if (Object.keys(patch).length) await updateEvent(eventKey, patch);
        toast.success(t('cal.saved'));
      } else {
        await createEvent(workspaceId, toCreate(d, zone));
        toast.success(t('cal.created'));
      }
      onClose();
    } catch (e) {
      const field = e instanceof ApiError ? fieldOf(e.field) : null;
      const text = errorText(e, t('cal.err.save'));
      if (field) setFieldText((x) => ({ ...x, [field]: text }));
      else setGeneral(text);
    } finally {
      setBusy(false);
    }
  };
  const err = (f: keyof DraftErrors): string | undefined => (errors[f] ? t(errors[f]) : fieldText[f]);

  const endOptions = useMemo(() => Array.from({ length: 96 }, (_, i) => d.start + (i + 1) * 15), [d.start]);

  return (
    <Modal
      open
      onClose={() => void close()}
      title={editing ? t('cal.editTitle') : t('cal.createTitle')}
      initialFocus={titleRef}
      nonModal={!mobile}
      keepOpen={(el) => !!el.closest('[draggable="true"], [data-room-slot], [role="alertdialog"], [role="dialog"], [data-radix-popper-content-wrapper], [data-sonner-toaster], [data-toasts]')}
      footer={
        <>
          <Button variant="secondary" onClick={() => void close()}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} busy={busy || seriesPending} data-testid="event-save">
            {editing ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        data-testid="event-dialog"
      >
        <Field label={t('cal.f.title')} error={err('title')}>
          <Input ref={titleRef} value={d.title} maxLength={MAX_TITLE} placeholder={t('cal.f.titlePh')} onChange={(e) => set({ title: e.target.value })} aria-invalid={!!err('title')} data-testid="event-title-input" />
        </Field>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3 mobile:grid-cols-1">
          <Field label={t('cal.f.date')}>
            <Input type="date" value={d.day} required onChange={(e) => e.target.value && set({ day: e.target.value })} data-testid="event-date" />
          </Field>
          <div className="flex h-7 items-center gap-2 pb-0.5 mobile:h-auto">
            <Switch label={t('cal.f.allDay')} checked={d.allDay} onChange={(allDay) => set({ allDay })} />
          </div>
        </div>
        {d.allDay ? null : (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('cal.f.start')}>
              <Select
                value={d.start}
                onChange={(e) => {
                  const start = Number(e.target.value);
                  set({ start, end: start + (d.end - d.start) });
                }}
                data-testid="event-start"
              >
                {STARTS.map((m) => (
                  <option key={m} value={m}>
                    {formatMinutes(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('cal.f.end')} error={err('end')}>
              <Select value={d.end} onChange={(e) => set({ end: Number(e.target.value) })} aria-invalid={!!err('end')} data-testid="event-end">
                {(endOptions.includes(d.end) ? endOptions : [d.end, ...endOptions]).map((m) => (
                  <option key={m} value={m}>
                    {formatMinutes(m % 1440)}
                    {m >= 1440 ? ' +1' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2 -mt-1 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="min-w-0 text-caption text-faint">{t('cal.f.zone', { zone })}</p>
                <ZoneSpan day={d.day} start={d.start} end={d.end} />
              </div>
              <Button variant="ghost" size="sm" onClick={() => setFinding(true)} data-testid="event-find">
                <CalendarSearch className="size-3.5" aria-hidden />
                {t('fb.find')}
              </Button>
            </div>
            <AvailabilityStrip workspaceId={workspaceId} users={memberIds} day={d.day} start={d.start} end={d.end} eventId={editing?.id ?? ''} />
          </div>
        )}
        {finding ? (
          <FindTimeDialog
            workspaceId={workspaceId}
            users={meId ? [meId, ...memberIds] : memberIds}
            durationMin={Math.max(15, d.end - d.start)}
            day={d.day}
            onClose={() => setFinding(false)}
            onPick={(slot, users) => {
              const day = dayKey(slot.start);
              const start = Math.round((slot.start - dayStart(day)) / 60_000);
              const me = myUserId();
              const attendees = users.filter((u) => u !== me).reduce((list, u) => addMember(list, u), d.attendees);
              set({ day, start, end: start + Math.round((slot.end - slot.start) / 60_000), attendees });
              setFinding(false);
            }}
          />
        ) : null}
        <RoomField
          workspaceId={workspaceId}
          value={d.roomId}
          temp={d.tempRoom && !d.roomId}
          hint={ownRoom ? t('cal.f.tempRoomOwn') : undefined}
          // A room picked by hand replaces the meeting's own temporary room (ADR-0112).
          onChange={(roomId) => set({ roomId, tempRoom: d.tempRoom && roomId !== '' && roomId === d.roomId })}
        />
        {offerTemp ? (
          <Switch
            label={t('cal.f.tempRoom')}
            hint={t('cal.f.tempRoomHint')}
            checked={d.tempRoom}
            onChange={(tempRoom) => set(tempRoom ? { tempRoom, roomId: '' } : { tempRoom })}
            data-testid="event-temp-room"
          />
        ) : null}
        <AttendeesField workspaceId={workspaceId} draft={d} onChange={(attendees) => set({ attendees })} error={err('attendees')} />
        {init?.outside?.length ? (
          // From an external event (ADR-0045 §3): who was there but is not a member here.
          <p className="-mt-2 text-caption text-muted" data-testid="event-outside">
            {t('ext.outside', { list: init.outside.join(', ') })}
          </p>
        ) : null}
        <Field label={t('cal.f.description')} error={err('description')}>
          <TextArea
            value={d.description}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            placeholder={t('cal.f.descriptionPh')}
            onChange={(e) => set({ description: e.target.value })}
            className="min-h-[72px]"
          />
        </Field>
        {/* A phone stacks the repeat and its end: «В рабочие дни» and its hint need the full width. A
            changed occurrence of a series (ADR-0157) does not repeat: no repeat fields. */}
        {editing?.seriesId ? null : (
          <div className={mobile ? 'grid gap-3' : 'grid grid-cols-2 gap-3'}>
            <Field label={t('cal.f.repeat')} hint={workdays && holidays !== undefined ? t(holidays === 'ru' ? 'cal.repeat.workdaysRu' : 'cal.repeat.workdaysWeek') : undefined}>
              <Select
                value={d.repeat}
                onChange={(e) => {
                  const repeat: EventRepeat = Number(e.target.value);
                  // A series has no own temporary room (ADR-0112): a room made already stays as an ordinary one.
                  set(repeat === EventRepeat.UNSPECIFIED ? { repeat } : { repeat, tempRoom: false });
                }}
                data-testid="event-repeat"
              >
                {REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {t(REPEAT_LABEL[r])}
                  </option>
                ))}
              </Select>
            </Field>
            {d.repeat !== EventRepeat.UNSPECIFIED ? (
              <Field label={t('cal.f.until')} hint={d.until ? undefined : t('cal.f.untilNone')} error={err('until')}>
                <Input type="date" value={d.until} min={d.day} onChange={(e) => set({ until: e.target.value })} data-testid="event-until" />
              </Field>
            ) : null}
          </div>
        )}
        <Switch label={t('cal.f.record')} hint={t('cal.f.recordHint')} checked={d.record} onChange={(record) => set({ record })} />
        {general ? (
          <p role="alert" className="text-caption text-danger-text">
            {general}
          </p>
        ) : null}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

const NO_ROOM = 'none';

/**
 * The meeting's room: a select-looking button that opens the one list picker (docs/08 «Выбор
 * участника», as the payer's country) over «Без комнаты» and the voice rooms of the workspace, with
 * a search; a voice room row dragged from the room list lands here too. `temp`: the meeting asks for
 * its own temporary room (ADR-0112) — the button names it.
 */
function RoomField({
  workspaceId,
  value,
  temp,
  hint,
  onChange,
}: {
  workspaceId: string;
  value: string;
  temp: boolean;
  hint: string | undefined;
  onChange: (roomId: string) => void;
}): ReactNode {
  const byId = useRooms((s) => s.byId);
  const rooms = useMemo(() => roomsOfWorkspace(byId, workspaceId).filter((r) => r.type === RoomType.VOICE), [byId, workspaceId]);
  const [open, setOpen] = useState(false);
  const [native, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The room list's own drag (not a native one) over the field: highlighted the same way.
  const hovered = useRoomDropHover((s) => s.el !== null && s.el === ref.current);
  const over = native || hovered;
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onRoom = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (useRooms.getState().byId[id]?.type === RoomType.VOICE) cb.current(id);
    };
    el.addEventListener('calab-drop-room', onRoom);
    return () => el.removeEventListener('calab-drop-room', onRoom);
  }, []);
  const groups = useMemo<PickerGroup<RoomPickItem>[]>(() => {
    const none: RoomPickItem = { kind: 'room', id: NO_ROOM, roomId: '', name: t('cal.f.noRoom'), voice: true, search: [t('cal.f.noRoom')] };
    return [{ id: 'rooms', label: '', items: [none, ...roomItems(rooms, () => true, (r) => r.name)] }];
  }, [rooms]);
  const pick = useCallback(
    (item: RoomPickItem) => {
      onChange(item.roomId);
      setOpen(false);
    },
    [onChange],
  );
  const renderItem = useCallback(
    (item: RoomPickItem) => (
      <>
        <span className="grid size-4 shrink-0 place-items-center">{item.roomId ? <RoomIcon roomId={item.roomId} size={16} /> : null}</span>
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        <Check className={cx('size-3.5 shrink-0', item.roomId === value ? null : 'invisible')} aria-hidden />
      </>
    ),
    [value],
  );
  const name = value ? (byId[value]?.name ?? '') : '';
  const label = temp ? t('temp.icon') : name || t('cal.f.noRoom');
  return (
    <div
      ref={ref}
      data-drop-room=""
      onDragOver={(e: DragEvent) => {
        if (dragKind(e.dataTransfer) !== 'room') return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        setOver(false);
        const p = dragPayload(e.dataTransfer);
        if (p?.roomId && useRooms.getState().byId[p.roomId]?.type === RoomType.VOICE) {
          e.preventDefault();
          onChange(p.roomId);
        }
      }}
      className={cx('rounded-[var(--radius-card)]', over && 'outline outline-2 outline-offset-2 outline-accent')}
    >
      <Field label={t('cal.f.room')} hint={hint ?? t('cal.f.roomHint')}>
        <PickerPopover<RoomPickItem>
          groups={groups}
          renderItem={renderItem}
          onSelect={pick}
          placeholder={t('cal.f.roomSearch')}
          label={t('cal.f.roomList')}
          emptyText={t('cal.f.roomEmpty')}
          open={open}
          onOpenChange={setOpen}
          testId="event-room-list"
        >
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`${t('cal.f.room')}: ${label}`}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setOpen(true);
              }
            }}
            className="select-chevron flex h-7 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-line bg-elev pl-2 pr-7 text-left text-body shadow-[var(--shadow-card)] hover:bg-[color:var(--color-control-hover)] mobile:tap-h mobile:pl-3.5 mobile:pr-9"
            data-testid="event-room"
          >
            {temp ? <Timer className="size-4 shrink-0 text-muted" aria-hidden /> : value ? <RoomIcon roomId={value} size={16} /> : null}
            <span className={cx('min-w-0 flex-1 truncate', value || temp ? 'text-fg' : 'text-muted')}>{label}</span>
          </button>
        </PickerPopover>
      </Field>
    </div>
  );
}

/** Above this many chips the list folds to the first CHIPS_SHOWN and a «+N» chip (an «@all» of a big workspace). */
const CHIPS_FOLD = 12;
const CHIPS_SHOWN = 10;
/** Id of the picker's «@all» row. */
const ALL_ID = '@all';

const chipKey = (a: { userId: string; email: string }): string => a.userId || a.email;

/**
 * Attendee chips (a click toggles required / optional), the member picker with «@all» (every
 * member of the workspace, not guests or bots — expanded here into the list), external
 * addresses; members dropped here are added.
 */
function AttendeesField({ workspaceId, draft, onChange, error }: { workspaceId: string; draft: EventDraft; onChange: (list: EventDraft['attendees']) => void; error: string | undefined }): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const [picking, setPicking] = useState(false);
  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const id = useId();
  const me = myUserId();
  // The members list stands beside the day view only from 1200 px: the drag hint only then.
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  // Who «@all» means: current members (former ones are not in `members`), not guests or bots, not me.
  const everyone = useMemo(
    () =>
      Object.values(members ?? {})
        .filter((m) => m.user && !m.user.isBot && !m.user.isGuest && m.role !== WorkspaceRole.GUEST && m.user.id !== me)
        .map((m) => m.user?.id ?? ''),
    [members, me],
  );
  // Local time and working hours of colleagues in other zones next to their names (#85); only while the picker is open.
  const pickable = useMemo(() => Object.values(members ?? {}).flatMap((m) => (m.user && !m.user.isBot && m.role !== WorkspaceRole.GUEST && m.user.id !== me ? [m.user.id] : [])), [members, me]);
  const clocks = useColleagueClocks(workspaceId, pickable, picking);
  const groups = useMemo(() => {
    const taken = new Set([me, ...draft.attendees.map((a) => a.userId).filter(Boolean)]);
    const list = Object.values(members ?? {}).filter((m) => m.user && !m.user.isBot && m.role !== WorkspaceRole.GUEST);
    const missing = everyone.filter((u) => !taken.has(u)).length;
    // The organizer takes a place too (MAX_ATTENDEES with them).
    const fits = draft.attendees.length + missing + 1 <= MAX_ATTENDEES;
    const all: RolePickItem[] =
      missing > 1
        ? [
            {
              kind: 'role',
              id: ALL_ID,
              role: WorkspaceRole.MEMBER,
              roleId: '',
              color: 0,
              label: 'all',
              note: fits ? t('cal.f.all', { n: everyone.length }) : t('cal.f.allTooMany'),
              search: ['@all', t('cal.f.allSearch')],
              ...(fits ? {} : { disabled: true }),
            },
          ]
        : [];
    return [
      { id: 'all', label: '', items: all },
      { id: 'members', label: '', items: memberItems(list, { exclude: taken, decorate: (m) => (m.user && clocks[m.user.id] ? { note: clocks[m.user.id] ?? '' } : undefined), ...(roles ? { roles } : {}) }) },
    ];
  }, [members, roles, draft.attendees, me, everyone, clocks]);

  const add = (userId: string): void => onChange(addMember(draft.attendees, userId));
  const select = (it: PeoplePickItem): void => {
    if (it.kind === 'member') add(it.userId);
    else if (it.id === ALL_ID) onChange(addMembers(draft.attendees, everyone));
  };
  const addAddress = (): void => {
    const r = addEmail(draft.attendees, email);
    if ('error' in r) {
      setEmailErr(t(r.error));
      return;
    }
    setEmail('');
    setEmailErr(null);
    onChange(r.list);
  };
  // Chips are memo rows: their handlers are stable and read the latest list.
  const latest = useRef({ list: draft.attendees, onChange });
  useLayoutEffect(() => {
    latest.current = { list: draft.attendees, onChange };
  });
  const toggle = useCallback((key: string) => {
    const { list, onChange: change } = latest.current;
    change(list.map((x) => (chipKey(x) === key ? { ...x, required: !x.required } : x)));
  }, []);
  const remove = useCallback((key: string) => {
    const { list, onChange: change } = latest.current;
    change(list.filter((x) => chipKey(x) !== key));
  }, []);
  const many = draft.attendees.length > CHIPS_FOLD;
  const folded = !unfolded && many;
  const shown = folded ? draft.attendees.slice(0, CHIPS_SHOWN) : draft.attendees;

  return (
    <div
      className={cx('flex flex-col gap-1 rounded-[var(--radius-card)]', over && 'outline outline-2 outline-offset-2 outline-accent')}
      onDragOver={(e: DragEvent) => {
        if (dragKind(e.dataTransfer) !== 'user') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        setOver(false);
        const p = dragPayload(e.dataTransfer);
        if (!p?.userId) return;
        e.preventDefault();
        const m = members?.[p.userId];
        if (m && !m.user?.isBot && m.role !== WorkspaceRole.GUEST && p.userId !== me) add(p.userId);
      }}
      data-testid="event-attendees"
    >
      <span className="flex items-center gap-2 text-caption font-medium text-muted">
        <span id={`${id}-label`}>{t('cal.f.attendees')}</span>
        {many ? (
          <>
            <span className="tabular-nums text-faint">{draft.attendees.length}</span>
            <button type="button" className="ml-auto rounded-full px-1.5 font-normal text-accent-text hover:bg-hover" onClick={() => onChange([])} data-testid="event-remove-all">
              {t('cal.f.removeAll')}
            </button>
          </>
        ) : null}
      </span>
      <ul aria-labelledby={`${id}-label`} className="flex flex-wrap gap-1.5">
        {shown.map((a) => (
          <Chip key={chipKey(a)} chipId={chipKey(a)} workspaceId={workspaceId} userId={a.userId} email={a.email} required={a.required} onToggle={toggle} onRemove={remove} />
        ))}
        {folded ? (
          <li>
            <button
              type="button"
              onClick={() => setUnfolded(true)}
              aria-label={t('cal.f.moreLabel', { n: draft.attendees.length - CHIPS_SHOWN })}
              className="flex h-7 items-center rounded-full bg-[var(--color-fill)] px-2.5 text-caption font-medium tabular-nums text-fg hover:bg-[var(--color-fill-hover)]"
              data-testid="event-chips-more"
            >
              {t('cal.f.more', { n: draft.attendees.length - CHIPS_SHOWN })}
            </button>
          </li>
        ) : many ? (
          <li>
            <Button variant="ghost" size="sm" onClick={() => setUnfolded(false)}>
              {t('cal.f.collapse')}
            </Button>
          </li>
        ) : null}
        <li>
          <MemberPicker open={picking} onOpenChange={setPicking} groups={groups} onSelect={select} placeholder={t('picker.searchPeople')} label={t('cal.f.addPeople')} testId="event-member-picker">
            <Button variant="secondary" size="sm" data-testid="event-add-people">
              <Plus className="size-3.5" aria-hidden />
              {t('cal.f.addPeople')}
            </Button>
          </MemberPicker>
        </li>
      </ul>
      <div className="mt-1 flex gap-2">
        <Input
          type="email"
          value={email}
          placeholder={t('cal.f.emailPh')}
          aria-label={t('cal.f.email')}
          icon={<Mail className="size-4" aria-hidden />}
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addAddress();
            }
          }}
          data-testid="event-email"
        />
        <Button variant="secondary" onClick={addAddress} disabled={!email.trim()}>
          {t('cal.f.emailAdd')}
        </Button>
      </div>
      {emailErr || error ? (
        <span className="text-caption text-danger-text" role="alert">
          {emailErr ?? error}
        </span>
      ) : wide ? (
        <span className="text-caption text-faint">{t('cal.f.attendeesHint')}</span>
      ) : null}
    </div>
  );
}

const Chip = memo(function Chip({
  chipId,
  workspaceId,
  userId,
  email,
  required,
  onToggle,
  onRemove,
}: {
  chipId: string;
  workspaceId: string;
  userId: string;
  email: string;
  required: boolean;
  onToggle: (chipId: string) => void;
  onRemove: (chipId: string) => void;
}): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const avatar = useWorkspaces((s) => (userId ? (s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? s.users[userId]?.avatarFileId ?? '') : ''));
  const former = !!useFormerInfo(workspaceId, userId);
  const label = userId ? name : email;
  return (
    <li
      className={cx('flex h-7 items-center gap-1 rounded-full pl-1 pr-0.5 text-caption', required ? 'bg-[var(--color-fill)]' : 'border border-dashed border-[var(--color-label-tertiary)]')}
      data-testid="event-chip"
    >
      <button
        type="button"
        onClick={() => onToggle(chipId)}
        aria-pressed={!required}
        aria-label={required ? t('cal.f.makeOptional', { name: label }) : t('cal.f.makeRequired', { name: label })}
        title={required ? t('cal.f.required') : t('cal.f.optional')}
        className="flex min-w-0 items-center gap-1.5 rounded-full pr-1"
      >
        {userId ? (
          <Avatar userId={userId} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} former={former} />
        ) : (
          <span className="grid size-5 place-items-center rounded-full bg-[var(--color-fill-hover)]">
            <Mail className="size-3" aria-hidden />
          </span>
        )}
        <span className="max-w-40 truncate text-fg">{label}</span>
        {userId ? <FormerChip workspaceId={workspaceId} userId={userId} /> : null}
        {required ? null : <span className="text-muted">{t('cal.optional')}</span>}
      </button>
      <button type="button" onClick={() => onRemove(chipId)} aria-label={t('cal.f.remove', { name: label })} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
});
