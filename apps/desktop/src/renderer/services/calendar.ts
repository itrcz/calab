import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  AttendeeStatus,
  EventRepeat,
  WorkspaceRole,
  type CalendarEvent,
  type CalendarEventAttendeeInputSchema,
  type CalendarEventReminder,
  type ExternalEvent as WireExternalEvent,
  type CalendarEventRsvp,
  type RoomEventActive,
  type RoomEventEnded,
  type CreateCalendarEventRequestSchema,
  type UpdateCalendarEventRequestSchema,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { ApiError } from '../lib/api/client';
import {
  applyCreate,
  applyDelete,
  applyRsvp,
  applyUpdate,
  keyEventId,
  occKey,
  replaceWindow,
  withActive,
  withAnswer,
  withoutActive,
  type Applied,
} from '../lib/calendar/events';
import { externalReminderText, reminderText, remindNow } from '../lib/calendar/reminders';
import { dayKey, eventSpan, formatWhen, gridWindow, monthOf, occurrenceMs, viewerZone } from '../lib/calendar/time';
import { can, mayManageEvents, roomPerms } from '../lib/permissions';
import { log } from '../lib/log';
import { platform } from '../platform';
import { useCalendar } from '../stores/calendar';
import { useFreeBusy } from '../stores/freebusy';
import { prefs } from '../stores/prefs';
import { useRooms } from '../stores/rooms';
import { myUserId, useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { rolesOf, useWorkspaces } from '../stores/workspaces';
import { voice } from './voice';
import { invalidateBusy } from './freebusy';

/**
 * Workspace calendar (ADR-0038 §7): listing month windows, the gateway events, reminders, the
 * room badges' active meetings, the header's count, the meeting actions (answer, create, change,
 * move by drag, cancel) and the `/e/<id>` link. The store is written once per server answer or
 * gateway event — never per pointer move (the day view's drag keeps its own leaf state).
 */

const cal = (): ReturnType<typeof useCalendar.getState> => useCalendar.getState();

// ---------------------------------------------------------------- listing

const monthId = (workspaceId: string, month: string): string => `${workspaceId}|${month}`;
const inflight = new Map<string, Promise<void>>();

async function fetchMonth(workspaceId: string, month: string): Promise<void> {
  const id = monthId(workspaceId, month);
  const [from, to] = gridWindow(month);
  try {
    const r = await api.calendar.list(workspaceId, new Date(from), new Date(to));
    useCalendar.setState((s) => ({ occ: replaceWindow(s.occ, workspaceId, from, to, r.events), months: s.months[id] ? s.months : { ...s.months, [id]: true } }));
  } catch (e) {
    // A guest (403) or a network error: nothing to show; the next open tries again.
    log.warn('calendar: list failed', e);
    useCalendar.setState((s) => {
      if (!s.months[id]) return s;
      const months = { ...s.months };
      delete months[id];
      return { months };
    });
  }
}

/** Lists a month's grid window of a workspace once (the mini calendar, the day view). */
export function ensureMonth(workspaceId: string, month: string): void {
  const id = monthId(workspaceId, month);
  if (cal().months[id] || inflight.has(id)) return;
  useCalendar.setState((s) => ({ months: { ...s.months, [id]: true } }));
  const p = fetchMonth(workspaceId, month).finally(() => inflight.delete(id));
  inflight.set(id, p);
}

const refetchTimers = new Map<string, number>();

/** Lists every loaded month of a workspace again, once for a burst of changes (250 ms). */
export function refetchWorkspace(workspaceId: string): void {
  if (refetchTimers.has(workspaceId)) return;
  refetchTimers.set(
    workspaceId,
    window.setTimeout(() => {
      refetchTimers.delete(workspaceId);
      for (const id of Object.keys(cal().months)) {
        const [ws, month] = id.split('|');
        if (ws === workspaceId && month) void fetchMonth(workspaceId, month);
      }
    }, 250),
  );
}

// ---------------------------------------------------------------- today's count

let todayTimer: number | null = null;
let todayDebounce: number | null = null;

/** GET /api/me/events/today; the next refresh when the earliest of them ends, or at midnight. */
async function loadToday(): Promise<void> {
  if (todayTimer !== null) window.clearTimeout(todayTimer);
  todayTimer = null;
  if (!useSession.getState().ready) return;
  try {
    const r = await api.calendar.today(viewerZone());
    useCalendar.setState({ todayCount: r.count });
    const now = Date.now();
    const d = new Date(now);
    let next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    for (const ev of r.events) {
      const { end } = eventSpan(ev);
      if (end > now) next = Math.min(next, end);
    }
    todayTimer = window.setTimeout(() => void loadToday(), Math.max(1000, next - now + 1000));
  } catch (e) {
    log.warn('calendar: today failed', e);
  }
}

/** Refreshes the header's number soon (a burst of events → one request). */
export function refreshToday(): void {
  if (todayDebounce !== null) return;
  todayDebounce = window.setTimeout(() => {
    todayDebounce = null;
    void loadToday();
  }, 300);
}

// ---------------------------------------------------------------- READY / gateway

/** READY: the rooms' active meetings from the snapshots; loaded months and the count again. */
export function onCalendarReady(snaps: readonly WorkspaceSnapshot[]): void {
  let active = {};
  for (const snap of snaps) for (const ev of snap.activeEvents) if (ev.roomId) active = withActive(active, ev.roomId, ev);
  useCalendar.setState({ active });
  const alive = new Set(snaps.map((s) => s.workspace?.id ?? ''));
  const months: Record<string, true> = {};
  for (const id of Object.keys(cal().months)) if (alive.has(id.split('|')[0] ?? '')) months[id] = true;
  useCalendar.setState((s) => ({ months, occ: Object.fromEntries(Object.entries(s.occ).filter(([, ev]) => alive.has(ev.workspaceId))) }));
  for (const ws of alive) if (ws) refetchWorkspace(ws);
  void loadToday();
  takePendingEvent();
}

/** WORKSPACE_CREATE: its active meetings. */
export function applySnapshotEvents(snap: WorkspaceSnapshot): void {
  if (!snap.activeEvents.length) return;
  useCalendar.setState((s) => {
    let active = s.active;
    for (const ev of snap.activeEvents) if (ev.roomId) active = withActive(active, ev.roomId, ev);
    return { active };
  });
}

/** WORKSPACE_DELETE / left: its meetings go. */
export function dropWorkspaceEvents(workspaceId: string): void {
  useCalendar.setState((s) => ({
    occ: Object.fromEntries(Object.entries(s.occ).filter(([, ev]) => ev.workspaceId !== workspaceId)),
    active: Object.fromEntries(Object.entries(s.active).filter(([, list]) => list[0]?.workspaceId !== workspaceId)),
    months: Object.fromEntries(Object.entries(s.months).filter(([id]) => !id.startsWith(`${workspaceId}|`))),
  }));
}

function applied(workspaceId: string, r: Applied): void {
  useCalendar.setState({ occ: r.occ });
  if (r.refetch) refetchWorkspace(workspaceId);
}

const involvesMe = (ev: CalendarEvent): boolean => ev.organizerId === myUserId() || ev.attendees.some((a) => a.userId === myUserId());

export function onEventCreate(ev: CalendarEvent): void {
  applied(ev.workspaceId, applyCreate(cal().occ, ev));
  invalidateBusy(ev.workspaceId);
  if (involvesMe(ev)) refreshToday();
}

export function onEventUpdate(ev: CalendarEvent): void {
  applied(ev.workspaceId, applyUpdate(cal().occ, ev));
  invalidateBusy(ev.workspaceId);
  const series = cal().series;
  if (series[ev.id]) useCalendar.setState({ series: { ...series, [ev.id]: ev } });
  // A room's badge follows the meeting's title / attendees (its times: ROOM_EVENT_*).
  useCalendar.setState((s) => {
    if (!Object.values(s.active).some((list) => list.some((e) => e.id === ev.id))) return s;
    const active: Record<string, readonly CalendarEvent[]> = {};
    for (const [room, list] of Object.entries(s.active)) {
      active[room] = list.map((e) =>
        e.id === ev.id ? { ...ev, startsAt: e.startsAt, endsAt: e.endsAt, occurrenceAt: e.occurrenceAt, recordingId: e.recordingId, canEdit: e.canEdit } : e,
      );
    }
    return { active };
  });
  refreshToday();
}

export function onEventDelete(ev: CalendarEvent): void {
  invalidateBusy(ev.workspaceId);
  useCalendar.setState((s) => {
    const series = { ...s.series };
    delete series[ev.id];
    return { occ: applyDelete(s.occ, ev.id), series };
  });
  const ui = useUi.getState();
  if (ui.calEvent && keyEventId(ui.calEvent) === ev.id) ui.selectCalEvent(null);
  refreshToday();
}

export function onEventRsvp(v: CalendarEventRsvp): void {
  const a = v.attendee;
  if (!a) return;
  // A «declined» frees the attendee's time (ADR-0041 §1).
  invalidateBusy(v.workspaceId);
  useCalendar.setState((s) => {
    const occ = applyRsvp(s.occ, v.eventId, a, v.counts);
    const one = s.series[v.eventId];
    const activeChanged = Object.values(s.active).some((list) => list.some((e) => e.id === v.eventId));
    const active: Record<string, readonly CalendarEvent[]> = {};
    if (activeChanged) for (const [room, list] of Object.entries(s.active)) active[room] = list.map((e) => (e.id === v.eventId ? withAnswer(e, a, v.counts) : e));
    return {
      occ,
      ...(one ? { series: { ...s.series, [v.eventId]: withAnswer(one, a, v.counts) } } : {}),
      ...(activeChanged ? { active } : {}),
    };
  });
  if (a.userId === myUserId()) refreshToday();
}

export function onRoomEventActive(v: RoomEventActive): void {
  if (!v.event || !v.roomId) return;
  const ev = v.event;
  useCalendar.setState((s) => ({ active: withActive(s.active, v.roomId, ev) }));
}

export function onRoomEventEnded(v: RoomEventEnded): void {
  useCalendar.setState((s) => ({ active: withoutActive(s.active, v.roomId, v.eventId, v.occurrenceAt ? timestampMs(v.occurrenceAt) : null) }));
  refreshToday();
}

// ---------------------------------------------------------------- reminders

/**
 * EVENT_REMINDER → a system notification «Через 15 минут: Планёрка · Переговорка» (click: into the
 * room, or the meeting without one) and the same as an in-app toast with «Перейти в комнату».
 * «Не беспокоить» silences it only with «Напоминать при "Не беспокоить"» off.
 */
export function onEventReminder(v: CalendarEventReminder): void {
  const dnd = useSession.getState().me?.settings?.eventRemindersDnd ?? true;
  if (!remindNow(prefs().presence, dnd)) return;
  const ev = v.event;
  if (!ev) {
    if (v.externalEvent) remindExternal(v.minutes, v.externalEvent);
    return;
  }
  const room = ev.roomId ? useRooms.getState().byId[ev.roomId] : undefined;
  const text = reminderText(v.minutes, ev.title, room?.name ?? '');
  const act = room ? (): void => goToRoom(ev) : (): void => openEvent(ev);
  notifyReminder(text, room ? t('cal.goToRoom') : t('cal.openEvent'), `event:${occKey(ev)}:${v.minutes}`, act);
}

/**
 * A reminder of my imported CalDAV event (ADR-0045 amendment 3), the same notification and toast:
 * «Подключиться» opens its conference link; without one — its day in the calendar.
 */
function remindExternal(minutes: number, ev: WireExternalEvent): void {
  const start = ev.startsAt ? timestampMs(ev.startsAt) : Date.now();
  const text = externalReminderText(minutes, ev.summary, ev.location, t('ext.noTitle'));
  const link = ev.url;
  const act = link ? (): void => void platform.app.openExternal(link) : (): void => useUi.getState().openCalendarDay(dayKey(start), null);
  notifyReminder(text, link ? t('ext.join') : t('cal.openEvent'), `external:${ev.uid}:${start}:${minutes}`, act);
}

/** The system notification (one per tag on a machine) and the in-app toast with its action. */
function notifyReminder(text: string, action: string, tag: string, act: () => void): void {
  try {
    const n = new Notification(text, { body: action, tag });
    n.onclick = () => {
      window.focus();
      act();
    };
  } catch {
    // notifications unavailable: the toast below still says it
  }
  useToasts.getState().push('info', text, { label: action, run: act }, 15_000);
  platform.app.attention();
}

// ---------------------------------------------------------------- navigation

/** «Перейти»: the meeting's room, joining its voice (unless already there). */
export function goToRoom(ev: Pick<CalendarEvent, 'workspaceId' | 'roomId'>): void {
  if (!ev.roomId) return;
  useUi.getState().openRoom(ev.workspaceId, ev.roomId);
  if (useVoice.getState().roomId !== ev.roomId) void voice.join(ev.roomId, ev.workspaceId);
}

/** Shows the occurrence in the day view with its card (its workspace made active). */
export function openEvent(ev: CalendarEvent): void {
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== ev.workspaceId) ui.setWorkspace(ev.workspaceId);
  // «Подобрать время» ends with the meeting shown in its day (ADR-0041 §3).
  if (useFreeBusy.getState().find) useFreeBusy.getState().setFind(null);
  const { start } = eventSpan(ev);
  const day = ev.allDay ? dayKey(start, ev.tz || 'UTC') : dayKey(start);
  useUi.getState().openCalendarDay(day, occKey(ev));
  ensureMonth(ev.workspaceId, monthOf(day));
}

/** The shareable link of a meeting: https://<server>/e/<id>. */
export function eventLink(id: string): string {
  const serverUrl = useSession.getState().serverUrl;
  const web = import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' ? location.origin : '';
  const origin = [serverUrl, web].map((s) => s.trim().replace(/\/+$/, '')).find((s) => /^https?:\/\//.test(s));
  return `${origin ?? ''}/e/${id}`;
}

let pendingEvent: string | null = null;

/** `/e/<id>` (web path, calab://e/<id>): the meeting's card, after sign-in / READY if need be. */
export function openEventLink(id: string): void {
  pendingEvent = id;
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && location.pathname.startsWith('/e/')) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  if (useSession.getState().ready) takePendingEvent();
}

function takePendingEvent(): void {
  const id = pendingEvent;
  pendingEvent = null;
  if (id) void showEventById(id);
}

/**
 * A search hit (ADR-0062 §4): the meeting's card on the matched occurrence (`at`, its start in
 * ms; a series is one hit with its nearest occurrence).
 */
export function openEventOccurrence(id: string, at: number): Promise<void> {
  return showEventById(id, at);
}

async function showEventById(id: string, at?: number): Promise<void> {
  try {
    const r = await api.calendar.get(id);
    const series = r.event;
    if (!series || series.cancelledAt) throw new ApiError('ERROR_CODE_NOT_FOUND', 'cancelled', 404);
    if (!calendarAvailable(series.workspaceId)) {
      // A guest of the room (ADR-0038 «Диплинки для приглашённых»): no calendar — the room, with its
      // meeting card open on the badge (the server answers only while the meeting is active).
      if (!series.roomId) throw new ApiError('ERROR_CODE_NOT_FOUND', 'no room', 404);
      const roomId = series.roomId;
      useCalendar.setState((s) => ({ active: withActive(s.active, roomId, series), badgeOpen: roomId }));
      useUi.getState().openRoom(series.workspaceId, roomId);
      return;
    }
    useCalendar.setState((s) => ({ series: { ...s.series, [id]: series } }));
    let target: CalendarEvent = series;
    if (series.repeat !== EventRepeat.UNSPECIFIED && at !== undefined) {
      // That occurrence (the server expands the day around it).
      const list = await api.calendar.list(series.workspaceId, new Date(at - 86_400_000), new Date(at + 86_400_000)).catch(() => null);
      target = list?.events.find((e) => e.id === id && (occurrenceMs(e) === at || eventSpan(e).start === at)) ?? series;
    } else if (series.repeat !== EventRepeat.UNSPECIFIED) {
      // The next occurrence from today (the server expands; ≤ 62 days ahead).
      const now = Date.now();
      const list = await api.calendar.list(series.workspaceId, new Date(now - 86_400_000), new Date(now + 61 * 86_400_000)).catch(() => null);
      target = list?.events.find((e) => e.id === id && eventSpan(e).end > now) ?? series;
    }
    openEvent(target);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) toast.info(t('cal.notFound'));
    else toast.fail(e, t('cal.notFound'));
  }
}

// ---------------------------------------------------------------- rights

/**
 * May I change / cancel it (ADR-0038 §2, ADR-0048): `can_edit` from the server when it sends it;
 * else the organizer, MANAGE_ROOM in its room, or MANAGE_EVENTS (a meeting without a room, or in a
 * room I see).
 */
export function canEditEvent(ev: Pick<CalendarEvent, 'canEdit' | 'organizerId' | 'roomId' | 'workspaceId'>): boolean {
  if (ev.canEdit) return true;
  const me = myUserId();
  if (!me) return false;
  if (ev.organizerId === me) return true;
  const roles = rolesOf(useWorkspaces.getState().byId[ev.workspaceId], me);
  if (ev.roomId) {
    const room = useRooms.getState().byId[ev.roomId];
    return !!room && (can(roomPerms(roles, me, room), 'MANAGE_ROOM') || (can(roomPerms(roles, me, room), 'VIEW_ROOM') && mayManageEvents(roles)));
  }
  return mayManageEvents(roles);
}

/** Guests see no calendar (ADR-0038 §2). */
export function calendarAvailable(workspaceId: string): boolean {
  const role = useWorkspaces.getState().byId[workspaceId]?.role;
  return role !== undefined && role !== WorkspaceRole.GUEST;
}

// ---------------------------------------------------------------- actions

/** The occurrence (or the fetched series) behind a key. */
export function eventOf(key: string): CalendarEvent | undefined {
  const s = cal();
  return s.occ[key] ?? s.series[keyEventId(key)];
}

/** «Приму / Отклоню / Может быть»: my row changes at once, back on an error. */
export async function answer(ev: CalendarEvent, status: AttendeeStatus): Promise<void> {
  const me = myUserId();
  const mine = ev.attendees.find((a) => a.userId === me);
  if (!mine) return;
  const before = mine.status;
  const optimistic = { ...mine, status };
  useCalendar.setState((s) => ({ occ: applyRsvp(s.occ, ev.id, optimistic, undefined) }));
  try {
    await api.calendar.rsvp(ev.id, status);
    refreshToday();
  } catch (e) {
    useCalendar.setState((s) => ({ occ: applyRsvp(s.occ, ev.id, { ...mine, status: before }, undefined) }));
    toast.fail(e, t('cal.rsvp.failed'));
  }
}

export type CreateInit = MessageInitShape<typeof CreateCalendarEventRequestSchema>;
export type UpdateInit = MessageInitShape<typeof UpdateCalendarEventRequestSchema>;

/** Creates a meeting; the new occurrence is selected in the day view of its date. */
export async function createEvent(workspaceId: string, init: CreateInit): Promise<CalendarEvent> {
  const r = await api.calendar.create(workspaceId, init);
  const ev = r.event;
  if (!ev) throw new ApiError('ERROR_CODE_UNSPECIFIED', 'empty response', 500);
  // EVENT_CREATE may come before or after the response: put the single meeting in either way.
  applied(workspaceId, applyCreate(cal().occ, ev));
  const one = { ...ev, occurrenceAt: ev.startsAt };
  openEvent(one);
  refreshToday();
  return ev;
}

/** Changes the series of `key`; the held occurrences follow at once. */
export async function updateEvent(key: string, init: UpdateInit): Promise<CalendarEvent | undefined> {
  const id = keyEventId(key);
  const r = await api.calendar.update(id, init);
  const ev = r.event;
  if (!ev) return undefined;
  onEventUpdate(ev);
  const held = eventOf(key);
  // A single meeting's key moves with its start: keep it selected.
  if (ev.repeat === EventRepeat.UNSPECIFIED && useUi.getState().calEvent === key) {
    const nk = occKey({ ...ev, occurrenceAt: ev.startsAt });
    if (nk !== key) useUi.getState().selectCalEvent(nk);
  }
  return held;
}

/** Cancels the meeting, or (`one`) that occurrence of a series only. */
export async function cancelEvent(ev: CalendarEvent, one: boolean): Promise<void> {
  try {
    if (one) await api.calendar.cancel(ev.id, new Date(occurrenceMs(ev)));
    else await api.calendar.cancel(ev.id);
    if (one) {
      const k = occKey(ev);
      useCalendar.setState((s) => {
        const occ = { ...s.occ };
        delete occ[k];
        return { occ };
      });
    } else onEventDelete(ev);
    if (useUi.getState().calEvent === occKey(ev)) useUi.getState().selectCalEvent(null);
    toast.info(t('cal.cancelled'));
  } catch (e) {
    toast.fail(e, t('cal.err.save'));
  }
}

/**
 * A block dropped (the day view's drag): the occurrence moves at once (the store is written once,
 * here), PATCH follows; an error puts it back. A series moves as a whole (v1): its first start
 * shifts by the same amount.
 */
export async function moveOccurrence(key: string, start: number, end: number, allDay?: boolean): Promise<boolean> {
  const ev = eventOf(key);
  if (!ev) return false;
  const span = eventSpan(ev);
  const delta = start - span.start;
  const nextAllDay = allDay ?? ev.allDay;
  const moved = { ...ev, startsAt: timestampFromMs(start), endsAt: timestampFromMs(end), occurrenceAt: timestampFromMs(start), allDay: nextAllDay };
  const nk = occKey(moved);
  const before = cal().occ;
  useCalendar.setState((s) => {
    const occ = { ...s.occ };
    delete occ[key];
    occ[nk] = moved;
    return { occ };
  });
  if (useUi.getState().calEvent === key) useUi.getState().selectCalEvent(nk);
  try {
    let init: UpdateInit = { startsAt: timestampFromMs(start), endsAt: timestampFromMs(end), ...(allDay !== undefined && allDay !== ev.allDay ? { allDay } : {}) };
    if (ev.repeat !== EventRepeat.UNSPECIFIED) {
      const series = (await api.calendar.get(ev.id)).event;
      if (!series) throw new ApiError('ERROR_CODE_NOT_FOUND', 'gone', 404);
      const s = eventSpan(series);
      const dur = end - start;
      init = { ...init, startsAt: timestampFromMs(s.start + delta), endsAt: timestampFromMs(s.start + delta + dur) };
    }
    if (nextAllDay && !ev.allDay) init.tz = viewerZone();
    const r = await api.calendar.update(ev.id, init);
    if (r.event) onEventUpdate(r.event);
    toast.info(t('cal.moved', { when: formatWhen(moved) }));
    return true;
  } catch (e) {
    useCalendar.setState({ occ: before });
    if (useUi.getState().calEvent === nk) useUi.getState().selectCalEvent(key);
    toast.fail(e, t('cal.moveFailed'));
    return false;
  }
}

type AttendeeInit = MessageInitShape<typeof CalendarEventAttendeeInputSchema>;

const attendeeInputs = (ev: CalendarEvent): AttendeeInit[] => ev.attendees.map((a) => ({ userId: a.userId, email: a.email, required: a.required }));

/** A member dropped on the card: added as a required attendee. */
export async function addAttendee(key: string, userId: string): Promise<void> {
  const ev = eventOf(key);
  if (!ev || ev.attendees.some((a) => a.userId === userId)) return;
  try {
    await updateEvent(key, { setAttendees: true, attendees: [...attendeeInputs(ev), { userId, email: '', required: true }] });
    const name = useWorkspaces.getState().byId[ev.workspaceId]?.members[userId]?.user?.displayName ?? '';
    toast.info(t('cal.addedAttendee', { name }));
  } catch (e) {
    toast.fail(e, t('cal.err.save'));
  }
}

/** A voice room dropped on the card: the meeting's room. */
export async function setEventRoom(key: string, roomId: string): Promise<void> {
  const ev = eventOf(key);
  if (!ev || ev.roomId === roomId) return;
  try {
    await updateEvent(key, { roomId });
    toast.info(t('cal.roomSet', { room: useRooms.getState().byId[roomId]?.name ?? '' }));
  } catch (e) {
    toast.fail(e, t('cal.err.save'));
  }
}

/** «Копировать ссылку». */
export function copyEventLink(id: string): void {
  navigator.clipboard.writeText(eventLink(id)).then(
    () => toast.success(t('cal.linkCopied')),
    (e: unknown) => toast.fail(e),
  );
}

/** The recording prompt answered for this occurrence (once each). */
export function markPrompted(key: string): void {
  useCalendar.setState((s) => ({ prompted: { ...s.prompted, [key]: true } }));
}
