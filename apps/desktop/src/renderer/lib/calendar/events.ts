import { clone } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import {
  AttendeeStatus,
  CalendarEventSchema,
  EventRepeat,
  type CalendarEvent,
  type CalendarEventAttendee,
  type CalendarEventCounts,
} from '@calaba/protocol';
import { dayEnd, dayStart, eventDays, eventSpan, occurrenceMs } from './time';

/*
 * The client's copy of the calendar (ADR-0038): occurrences as the server lists them (the client
 * never expands repeats — ADR-0038 §1), keyed `<event id>@<occurrence start ms>`, and what the
 * gateway events do to them. Pure: the store (stores/calendar.ts) keeps the result.
 */

export type OccMap = Readonly<Record<string, CalendarEvent>>;

export const occKey = (ev: Pick<CalendarEvent, 'id' | 'occurrenceAt' | 'startsAt'>): string => `${ev.id}@${occurrenceMs(ev)}`;

/** Event id of an occurrence key. */
export const keyEventId = (key: string): string => key.slice(0, key.lastIndexOf('@'));

/** My answer: `my_status` from the lists, else my row in `attendees` (gateway payloads). */
export function myStatusOf(ev: Pick<CalendarEvent, 'myStatus' | 'attendees'>, me: string): AttendeeStatus {
  if (ev.myStatus !== AttendeeStatus.UNSPECIFIED) return ev.myStatus;
  return ev.attendees.find((a) => a.userId === me)?.status ?? AttendeeStatus.UNSPECIFIED;
}

/**
 * The «Люди» filter (ADR-0041 §3): a meeting of one of them — organizer, or an attendee who has
 * not declined.
 */
export function involvesAny(ev: Pick<CalendarEvent, 'organizerId' | 'attendees'>, people: ReadonlySet<string>): boolean {
  if (people.has(ev.organizerId)) return true;
  return ev.attendees.some((a) => !!a.userId && people.has(a.userId) && a.status !== AttendeeStatus.DECLINED);
}

export const isAttendee =(ev: Pick<CalendarEvent, 'attendees'>, me: string): boolean => ev.attendees.some((a) => a.userId === me);

/**
 * The invitation rule (ADR-0038 amendment «Кому уходит приглашение»), the client's half of the
 * invariant the server holds for mail (calendar/recipients.go): I am invited only by an explicit
 * attendee row of mine on a meeting I do not organize — never by a meeting I merely see because
 * its room is visible to me (EVENT_* reaches every viewer of the room), never by my own meeting,
 * and never through `my_status` alone. Everything that offers Accept / Decline checks this and
 * nothing else; guests have no calendar (the caller checks the role).
 */
export const isInvitee = (ev: Pick<CalendarEvent, 'organizerId' | 'attendees'>, me: string): boolean => !!me && ev.organizerId !== me && isAttendee(ev, me);

/** An invitee who has not answered: the only state in which anything may read as an invitation. */
export const awaitsAnswer = (ev: Pick<CalendarEvent, 'organizerId' | 'attendees' | 'myStatus'>, me: string): boolean =>
  isInvitee(ev, me) && myStatusOf(ev, me) === AttendeeStatus.PENDING;

/** My meetings (docs/09 #140): I organize it or I am on its attendee list. `mine` '' = no filter. */
export const isMine = (ev: Pick<CalendarEvent, 'organizerId' | 'attendees'>, mine: string): boolean => !mine || ev.organizerId === mine || isAttendee(ev, mine);

/**
 * The calendar's scope: without a «Люди» selection — my meetings (`mine`, owner 02.10); with one —
 * only the meetings of the selected people (owner, 05.10: «когда выбраны люди, нужно показывать
 * встречи выбранных людей», not mine; me among them brings mine back). Neither given = everything.
 */
const inScope = (ev: Pick<CalendarEvent, 'organizerId' | 'attendees'>, people: ReadonlySet<string> | undefined, mine: string): boolean =>
  people ? involvesAny(ev, people) : !mine || isMine(ev, mine);

/**
 * Which of the selected people (positions in the filter's order — their chip colours) a meeting
 * involves: the person dots on its block in the filtered day.
 */
export function involvedIndexes(ev: Pick<CalendarEvent, 'organizerId' | 'attendees'>, people: readonly string[]): number[] {
  const out: number[] = [];
  people.forEach((id, i) => {
    if (involvesAny(ev, new Set([id]))) out.push(i);
  });
  return out;
}

const overlaps = (ev: CalendarEvent, from: number, to: number): boolean => {
  const { start, end } = eventSpan(ev);
  return start < to && Math.max(end, start + 1) > from;
};

/**
 * A list response for [from, to) of a workspace replaces what we held for that window: the
 * occurrences overlapping it are dropped, the listed ones put in.
 */
export function replaceWindow(occ: OccMap, workspaceId: string, from: number, to: number, list: readonly CalendarEvent[]): OccMap {
  const next: Record<string, CalendarEvent> = {};
  for (const [k, ev] of Object.entries(occ)) if (ev.workspaceId !== workspaceId || !overlaps(ev, from, to)) next[k] = ev;
  for (const ev of list) next[occKey(ev)] = ev;
  return next;
}

/** Fields of the series every occurrence shares (not its times, recording, my answer or rights). */
function withSeries(o: CalendarEvent, series: CalendarEvent): CalendarEvent {
  const out = clone(CalendarEventSchema, series);
  out.startsAt = o.startsAt;
  out.endsAt = o.endsAt;
  out.occurrenceAt = o.occurrenceAt;
  out.recordingId = o.recordingId;
  out.canEdit = o.canEdit;
  out.myStatus = AttendeeStatus.UNSPECIFIED; // the attendees carry it now
  return out;
}

const cancelledSet = (series: CalendarEvent): Set<number> => new Set(series.cancelledOccurrences.map((ts) => timestampMs(ts)));

export interface Applied {
  occ: OccMap;
  /** The change needs the windows of the workspace listed again (a series' times, a new series). */
  refetch: boolean;
}

/**
 * EVENT_CREATE: a single meeting goes straight in (its only occurrence); a series is expanded by
 * the server — refetch.
 */
export function applyCreate(occ: OccMap, series: CalendarEvent): Applied {
  if (series.repeat !== EventRepeat.UNSPECIFIED) return { occ, refetch: true };
  const one = clone(CalendarEventSchema, series);
  if (one.startsAt) one.occurrenceAt = one.startsAt;
  return { occ: { ...occ, [occKey(one)]: one }, refetch: false };
}

/**
 * EVENT_UPDATE: every held occurrence of the series takes the new shared fields at once; a single
 * meeting also its new time. A series is listed again (its times may have moved — only the server
 * expands it), and so is a meeting we did not hold. Occurrences cancelled one by one
 * (`cancelled_occurrences`) leave.
 */
export function applyUpdate(occ: OccMap, series: CalendarEvent): Applied {
  const single = series.repeat === EventRepeat.UNSPECIFIED;
  const next: Record<string, CalendarEvent> = {};
  const cancelled = cancelledSet(series);
  let held = false;
  let wasSeries = false;
  for (const [k, o] of Object.entries(occ)) {
    if (o.id !== series.id) {
      next[k] = o;
      continue;
    }
    held = true;
    if (o.repeat !== EventRepeat.UNSPECIFIED) wasSeries = true;
    if (cancelled.has(occurrenceMs(o))) continue;
    const one = withSeries(o, series);
    if (single && o.repeat === EventRepeat.UNSPECIFIED) {
      one.startsAt = series.startsAt;
      one.endsAt = series.endsAt;
      if (series.startsAt) one.occurrenceAt = series.startsAt;
      next[occKey(one)] = one;
    } else next[k] = one;
  }
  if (!held) return applyCreate(occ, series);
  return { occ: next, refetch: !single || wasSeries };
}

/** EVENT_DELETE: the meeting is cancelled (or no longer visible to me): every occurrence leaves. */
export function applyDelete(occ: OccMap, eventId: string): OccMap {
  let changed = false;
  const next: Record<string, CalendarEvent> = {};
  for (const [k, o] of Object.entries(occ)) {
    if (o.id === eventId) changed = true;
    else next[k] = o;
  }
  return changed ? next : occ;
}

const sameAttendee = (a: CalendarEventAttendee, b: CalendarEventAttendee): boolean => (a.userId ? a.userId === b.userId : !!a.email && a.email === b.email);

/**
 * EVENT_RSVP: the attendee's new answer and the counts on every held occurrence (and on a series /
 * active meeting passed the same way). Unchanged map when the event is not held.
 */
export function applyRsvp(occ: OccMap, eventId: string, attendee: CalendarEventAttendee, counts: CalendarEventCounts | undefined): OccMap {
  let changed = false;
  const next: Record<string, CalendarEvent> = { ...occ };
  for (const [k, o] of Object.entries(occ)) {
    if (o.id !== eventId) continue;
    changed = true;
    next[k] = withAnswer(o, attendee, counts);
  }
  return changed ? next : occ;
}

/** One event with an attendee's answer (the RSVP reducer for a single object). */
export function withAnswer(o: CalendarEvent, attendee: CalendarEventAttendee, counts: CalendarEventCounts | undefined): CalendarEvent {
  const one = clone(CalendarEventSchema, o);
  const i = one.attendees.findIndex((a) => sameAttendee(a, attendee));
  if (i >= 0) one.attendees[i] = attendee;
  else one.attendees.push(attendee);
  if (counts) one.counts = counts;
  // my_status (lists) is a copy of my row; the rows are current now — myStatusOf reads them.
  one.myStatus = AttendeeStatus.UNSPECIFIED;
  return one;
}

/** Occurrence keys of a workspace overlapping [from, to), earliest first (the day view). */
export function keysIn(occ: OccMap, workspaceId: string, from: number, to: number): string[] {
  return Object.entries(occ)
    .filter(([, ev]) => ev.workspaceId === workspaceId && overlaps(ev, from, to))
    .sort(([ka, a], [kb, b]) => eventSpan(a).start - eventSpan(b).start || eventSpan(b).end - eventSpan(a).end || (ka < kb ? -1 : 1))
    .map(([k]) => k);
}

/**
 * The occurrences of one day of the viewer's calendar: timed ones overlapping its local
 * [00:00, 24:00), all-day ones on that date of the organizer's calendar. Earliest first.
 */
export function dayKeys(occ: OccMap, workspaceId: string, day: string, people?: ReadonlySet<string>, mine = ''): string[] {
  const from = dayStart(day);
  const to = dayEnd(day);
  return Object.entries(occ)
    .filter(([, ev]) => ev.workspaceId === workspaceId && (ev.allDay ? eventDays(ev).includes(day) : overlaps(ev, from, to)) && inScope(ev, people, mine))
    .sort(([ka, a], [kb, b]) => eventSpan(a).start - eventSpan(b).start || eventSpan(b).end - eventSpan(a).end || (ka < kb ? -1 : 1))
    .map(([k]) => k);
}

/** Day keys (viewer's zone; all-day meetings — the organizer's dates) with a meeting in [from, to): the mini calendar's dots. */
export function busyDays(occ: OccMap, workspaceId: string, from: number, to: number, tz?: string, people?: ReadonlySet<string>, mine = ''): string[] {
  const days = new Set<string>();
  for (const ev of Object.values(occ)) {
    if (ev.workspaceId !== workspaceId || !overlaps(ev, from, to)) continue;
    if (!inScope(ev, people, mine)) continue;
    for (const d of eventDays(ev, tz)) days.add(d);
  }
  return [...days].sort();
}

/** The timed / all-day split of a day's keys, with each timed one's span: a primitive signature for the layout. */
export function daySignature(occ: OccMap, keys: readonly string[]): string {
  return keys
    .map((k) => {
      const ev = occ[k];
      if (!ev) return '';
      const { start, end } = eventSpan(ev);
      return `${k}~${ev.allDay ? 'a' : 't'}~${start}~${end}`;
    })
    .join('|');
}

export interface SigItem {
  key: string;
  allDay: boolean;
  start: number;
  end: number;
}

export function parseSignature(sig: string): SigItem[] {
  if (!sig) return [];
  return sig
    .split('|')
    .filter(Boolean)
    .map((s) => {
      const [key = '', kind, start, end] = s.split('~');
      return { key, allDay: kind === 'a', start: Number(start), end: Number(end) };
    });
}

// ---------------------------------------------------------------- rooms' active meetings

/** Meetings active per room (ROOM_EVENT_ACTIVE / ENDED, WorkspaceSnapshot.active_events). */
export type ActiveMap = Readonly<Record<string, readonly CalendarEvent[]>>;

export function withActive(map: ActiveMap, roomId: string, ev: CalendarEvent): ActiveMap {
  const k = occKey(ev);
  const list = (map[roomId] ?? []).filter((e) => occKey(e) !== k);
  list.push(ev);
  list.sort((a, b) => occurrenceMs(a) - occurrenceMs(b));
  return { ...map, [roomId]: list };
}

export function withoutActive(map: ActiveMap, roomId: string, eventId: string, occurrenceAt: number | null): ActiveMap {
  const list = map[roomId];
  if (!list) return map;
  const rest = list.filter((e) => e.id !== eventId || (occurrenceAt !== null && occurrenceMs(e) !== occurrenceAt));
  if (rest.length === list.length) return map;
  const next = { ...map };
  if (rest.length) next[roomId] = rest;
  else delete next[roomId];
  return next;
}

/** The meeting a room's badge shows: the earliest active one. */
export const roomMeeting = (map: ActiveMap, roomId: string): CalendarEvent | undefined => map[roomId]?.[0];
