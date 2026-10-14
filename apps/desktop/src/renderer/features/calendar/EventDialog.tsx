import { EventRepeat, RoomType, WorkspaceRole } from '@calaba/protocol';
import { CalendarSearch, Mail, Plus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, Input, Modal, Select, Switch, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import {
  MAX_DESCRIPTION,
  MAX_TITLE,
  addEmail,
  addMember,
  copyDraft,
  draftDirty,
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
import { createEvent, eventOf, updateEvent } from '../../services/calendar';
import { roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { MEMBERS_COLUMN_MIN, type EventDraftInit } from '../../stores/ui';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useFormerInfo, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { FormerChip } from '../people/MemberBits';
import { memberItems } from '../people/memberPickItems';
import { MemberPicker } from '../people/MemberPicker';
import { REPEAT_LABEL } from './EventCard';
import { dragKind, dragPayload, useRoomDropHover } from './dragState';
import { AvailabilityStrip } from './AvailabilityStrip';
import { FindTimeDialog } from './FindTime';

const REPEATS = [EventRepeat.UNSPECIFIED, EventRepeat.DAILY, EventRepeat.WEEKLY, EventRepeat.BIWEEKLY, EventRepeat.MONTHLY] as const;
/** 00:00 … 23:45. */
const STARTS = Array.from({ length: 96 }, (_, i) => i * 15);

/**
 * Create / edit a meeting (ADR-0038 §7; docs/08 modal, a sheet on phones): title, date, start / end
 * in 15-minute steps (the viewer's zone, shown), «Весь день», room (voice rooms, or none),
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
  // A series is changed as a whole: its first start, to shift by the occurrence's move.
  const [seriesStart, setSeriesStart] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!editing || editing.repeat === EventRepeat.UNSPECIFIED) return;
    let live = true;
    void api.calendar.get(editing.id).then(
      (r) => live && r.event && setSeriesStart(eventSpan(r.event).start),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A series' first start is needed to move it by the occurrence's shift: saving waits for it.
  const seriesPending = !!editing && editing.repeat !== EventRepeat.UNSPECIFIED && seriesStart === undefined;

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
    setBusy(true);
    try {
      if (editing && eventKey) {
        const patch = toUpdate(d, initial, zone, seriesStart);
        if (Object.keys(patch).length) await updateEvent(eventKey, patch);
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
              <p className="min-w-0 text-caption text-faint">{t('cal.f.zone', { zone })}</p>
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
        <RoomField workspaceId={workspaceId} value={d.roomId} onChange={(roomId) => set({ roomId })} />
        <AttendeesField workspaceId={workspaceId} draft={d} onChange={(attendees) => set({ attendees })} error={err('attendees')} />
        {init?.outside?.length ? (
          // From an external event (ADR-0045 §3): who was there but is not a member here.
          <p className="-mt-2 text-caption text-muted" data-testid="event-outside">
            {t('ext.outside', { list: init.outside.join(', ') })}
          </p>
        ) : null}
        <Field label={t('cal.f.description')} error={err('description')}>
          <textarea
            value={d.description}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            placeholder={t('cal.f.descriptionPh')}
            onChange={(e) => set({ description: e.target.value })}
            className="min-h-[72px] w-full resize-y rounded-[12px] bg-input px-3 py-2 text-body text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('cal.f.repeat')}>
            <Select value={d.repeat} onChange={(e) => set({ repeat: Number(e.target.value) })} data-testid="event-repeat">
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

/** Voice rooms of the workspace (or none); a voice room row dragged from the room list lands here. */
function RoomField({ workspaceId, value, onChange }: { workspaceId: string; value: string; onChange: (roomId: string) => void }): ReactNode {
  const byId = useRooms((s) => s.byId);
  const rooms = useMemo(() => roomsOfWorkspace(byId, workspaceId).filter((r) => r.type === RoomType.VOICE), [byId, workspaceId]);
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
      <Field label={t('cal.f.room')} hint={t('cal.f.roomHint')}>
        <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid="event-room">
          <option value="">{t('cal.f.noRoom')}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** Attendee chips (a click toggles required / optional), the member picker, external addresses; members dropped here are added. */
function AttendeesField({ workspaceId, draft, onChange, error }: { workspaceId: string; draft: EventDraft; onChange: (list: EventDraft['attendees']) => void; error: string | undefined }): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const [picking, setPicking] = useState(false);
  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const id = useId();
  const me = myUserId();
  // The members list stands beside the day view only from 1200 px: the drag hint only then.
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  const groups = useMemo(() => {
    const taken = new Set([me, ...draft.attendees.map((a) => a.userId).filter(Boolean)]);
    const list = Object.values(members ?? {}).filter((m) => m.user && !m.user.isBot && m.role !== WorkspaceRole.GUEST);
    return [{ id: 'members', label: '', items: memberItems(list, { exclude: taken, ...(roles ? { roles } : {}) }) }];
  }, [members, roles, draft.attendees, me]);

  const add = (userId: string): void => onChange(addMember(draft.attendees, userId));
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
      <span id={`${id}-label`} className="text-caption font-medium text-muted">
        {t('cal.f.attendees')}
      </span>
      <ul aria-labelledby={`${id}-label`} className="flex flex-wrap gap-1.5">
        {draft.attendees.map((a, i) => (
          <Chip
            key={a.userId || a.email}
            workspaceId={workspaceId}
            userId={a.userId}
            email={a.email}
            required={a.required}
            onToggle={() => onChange(draft.attendees.map((x, j) => (j === i ? { ...x, required: !x.required } : x)))}
            onRemove={() => onChange(draft.attendees.filter((_, j) => j !== i))}
          />
        ))}
        <li>
          <MemberPicker open={picking} onOpenChange={setPicking} groups={groups} onSelect={(it) => it.kind === 'member' && add(it.userId)} placeholder={t('picker.searchPeople')} label={t('cal.f.addPeople')} testId="event-member-picker">
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

function Chip({
  workspaceId,
  userId,
  email,
  required,
  onToggle,
  onRemove,
}: {
  workspaceId: string;
  userId: string;
  email: string;
  required: boolean;
  onToggle: () => void;
  onRemove: () => void;
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
        onClick={onToggle}
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
      <button type="button" onClick={onRemove} aria-label={t('cal.f.remove', { name: label })} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}
