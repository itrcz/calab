import { timestampFromMs, timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  AttendeeStatus,
  BusyKind,
  CalDavAccountResponseSchema,
  CalDavShareLevel,
  ConnectCalDavRequestSchema,
  DeleteExternalEventRequestSchema,
  ExternalDeleteScope,
  ExternalEventsResponseSchema,
  RespondExternalEventRequestSchema,
  SetCalDavShareRequestSchema,
  FreeBusyResponseSchema,
  SuggestSlotsRequestSchema,
  SuggestSlotsResponseSchema,
  UpdateCalDavRequestSchema,
  type CalDavAccountResponse,
  type FreeBusyUser as WireUser,
  type WorkHours as WireWorkHours,
} from '@calaba/protocol';
import { api } from '../api/endpoints';
import { ApiError, body, call, callEmpty, qs } from '../api/client';
import { DEFAULT_WORK_HOURS, type Interval, type WorkHours } from './freebusy';

/*
 * The free / busy, find-a-time and CalDAV endpoints of ADR-0041 (§1, §2, §4) through the generated
 * contract (event.proto FreeBusy* / SuggestSlots* / CalDav*, user.proto WorkHours), mapped to the
 * client's view types in plain milliseconds (what the grid, the store and the pure math use).
 */

export type BusyKindName = 'meeting' | 'external';

export interface BusyInterval extends Interval {
  /** Set only when the viewer may see that meeting (ADR-0041 §1, ADR-0038 §2). */
  eventId: string;
  kind: BusyKindName;
  allDay: boolean;
  /** An external interval of a colleague: its title when they share it (ADR-0045 §4), else ''. */
  title: string;
  /** …and the attendees who are members of this workspace, at «details». */
  attendees: readonly string[];
}

export interface FreeBusyUser {
  userId: string;
  timezone: string;
  workHours: WorkHours;
  busy: BusyInterval[];
}

export interface CalDavCalendar {
  href: string;
  name: string;
  color: string;
}

export interface CalDavAccount {
  url: string;
  username: string;
  calendarHref: string;
  import: boolean;
  push: boolean;
  lastSyncAt: number | null;
  lastError: string;
  calendars: CalDavCalendar[];
  /** What colleagues see of my external events (ADR-0045 §2). */
  shareLevel: ShareLevel;
}

export type ShareLevel = 'busy' | 'title' | 'details';

/** One attendee of my external event; `userId` — a member of the asked workspace with that address. */
export interface ExternalAttendee {
  email: string;
  name: string;
  userId: string;
  /** Their answer as the calendar has it (PARTSTAT). */
  status: AttendeeStatus;
}

/** One of my imported external events with its details (ADR-0045 §3). */
export interface ExternalEvent {
  /** Hash of the VEVENT UID: the same for the occurrences of a series (with `start` — a key). */
  uid: string;
  start: number;
  end: number;
  allDay: boolean;
  summary: string;
  location: string;
  attendees: readonly ExternalAttendee[];
  organizer: string;
  /** «Подключиться»: the conference link (ADR-0045 amendment 1); '' = none. */
  url: string;
  /** The calendar object (what «Удалить из календаря» names); '' until the next import. */
  href: string;
  /** An occurrence of a series: the delete offers «only this» / «the whole series». */
  recurring: boolean;
  /** «Открыть в календаре»: the provider's page of the event, only when reliable; '' = no button. */
  webUrl: string;
  /**
   * My answer when I am an attendee, not the organizer (ADR-0045 amendment 2): «Приму / Отклоню /
   * Может быть» are offered; UNSPECIFIED = no answer buttons.
   */
  myStatus: AttendeeStatus;
}

/** The answers I can give to an external event. */
export type ExternalAnswer = AttendeeStatus.ACCEPTED | AttendeeStatus.DECLINED | AttendeeStatus.MAYBE;

export type ExternalDeleteScopeName = 'this' | 'series';

export interface SuggestInit {
  users: readonly string[];
  durationMin: number;
  from: number;
  to: number;
  withinWorkHours: boolean;
  roomId?: string;
}

const ms = (t: Timestamp | undefined): number => (t ? timestampMs(t) : 0);

export function workHoursOf(w: WireWorkHours | undefined): WorkHours {
  if (!w || w.endMin <= w.startMin) return DEFAULT_WORK_HOURS;
  return { startMin: w.startMin, endMin: w.endMin, days: [...new Set(w.days.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b) };
}

function userOf(u: WireUser): FreeBusyUser {
  return {
    userId: u.userId,
    timezone: u.timezone || 'UTC',
    workHours: workHoursOf(u.workHours),
    busy: u.busy
      .map((b) => ({
        start: ms(b.startsAt),
        end: ms(b.endsAt),
        eventId: b.eventId,
        kind: b.kind === BusyKind.EXTERNAL ? ('external' as const) : ('meeting' as const),
        allDay: b.allDay,
        title: b.kind === BusyKind.EXTERNAL ? b.title : '',
        attendees: b.kind === BusyKind.EXTERNAL ? b.attendeeUserIds : [],
      }))
      .filter((b) => b.end > b.start),
  };
}

function accountOf(r: CalDavAccountResponse): CalDavAccount | null {
  const a = r.account;
  if (!a?.url) return null;
  return {
    url: a.url,
    username: a.username,
    calendarHref: a.calendarHref,
    import: a.import,
    push: a.push,
    lastSyncAt: a.lastSyncAt ? ms(a.lastSyncAt) : null,
    lastError: a.lastError,
    calendars: a.calendars.map((c) => ({ href: c.href, name: c.name, color: c.color })),
    shareLevel: a.shareLevel === CalDavShareLevel.DETAILS ? 'details' : a.shareLevel === CalDavShareLevel.TITLE ? 'title' : 'busy',
  };
}

const SHARE_WIRE: Record<ShareLevel, CalDavShareLevel> = { busy: CalDavShareLevel.BUSY, title: CalDavShareLevel.TITLE, details: CalDavShareLevel.DETAILS };

const iso = (t: number): string => new Date(t).toISOString();

export const freebusyApi = {
  /** GET …/freebusy: ≤ 20 people, a window ≤ 14 days; 403 for guests and bots. */
  async get(workspaceId: string, users: readonly string[], from: number, to: number, signal?: AbortSignal): Promise<FreeBusyUser[]> {
    const r = await call('GET', `/api/workspaces/${workspaceId}/freebusy${qs({ users: users.join(','), from: iso(from), to: iso(to) })}`, FreeBusyResponseSchema, undefined, signal);
    return r.users.map(userOf);
  },
  /** POST …/freebusy/suggest: ≤ 10 nearest windows; 409 NO_COMMON_HOURS (see `noCommonHours`). */
  async suggest(workspaceId: string, s: SuggestInit, signal?: AbortSignal): Promise<Interval[]> {
    const req = body(SuggestSlotsRequestSchema, {
      users: [...s.users],
      durationMin: s.durationMin,
      from: timestampFromMs(s.from),
      to: timestampFromMs(s.to),
      withinWorkHours: s.withinWorkHours,
      roomId: s.roomId ?? '',
    });
    const r = await call('POST', `/api/workspaces/${workspaceId}/freebusy/suggest`, SuggestSlotsResponseSchema, req, signal);
    return r.slots.map((x) => ({ start: ms(x.startsAt), end: ms(x.endsAt) })).filter((x) => x.end > x.start);
  },
  /**
   * GET /api/me/external-events: my imported events of [from, to) (≤ 14 days) with their details;
   * with a workspace, attendees who are its members carry their id. 403 for guests and bots.
   */
  async externalEvents(workspaceId: string, from: number, to: number, signal?: AbortSignal): Promise<ExternalEvent[]> {
    const r = await call('GET', `/api/me/external-events${qs({ from: iso(from), to: iso(to), workspace: workspaceId })}`, ExternalEventsResponseSchema, undefined, signal);
    return r.events
      .map((e) => ({
        uid: e.uid,
        start: ms(e.startsAt),
        end: ms(e.endsAt),
        allDay: e.allDay,
        summary: e.summary,
        location: e.location,
        attendees: e.attendees.map((a) => ({ email: a.email, name: a.name, userId: a.userId, status: a.status })),
        organizer: e.organizer,
        url: e.url,
        href: e.href,
        recurring: e.recurring,
        webUrl: e.webUrl,
        myStatus: e.myStatus,
      }))
      .filter((e) => e.end > e.start);
  },
  /**
   * DELETE /api/me/external-events (ADR-0045 amendment 1): the event (or this occurrence of its
   * series) out of my CalDAV calendar. 409 CONFLICT — it changed there (reload); 422 — the
   * calendar is read-only (reason CALENDAR_READ_ONLY); 404 — not mine / gone.
   */
  deleteExternal: (e: Pick<ExternalEvent, 'uid' | 'href' | 'start'>, scope: ExternalDeleteScopeName): Promise<void> =>
    callEmpty(
      'DELETE',
      '/api/me/external-events',
      body(DeleteExternalEventRequestSchema, {
        uid: e.uid,
        href: e.href,
        start: timestampFromMs(e.start),
        scope: scope === 'series' ? ExternalDeleteScope.SERIES : ExternalDeleteScope.THIS,
      }),
    ),
  /**
   * POST /api/me/external-events/rsvp (ADR-0045 amendment 2): my answer written into my CalDAV
   * calendar for the whole series (the provider mails it to the organizer). 409 — it changed there
   * (reload); 422 — the calendar is read-only (CALENDAR_READ_ONLY) or I am not an attendee.
   */
  respondExternal: (e: Pick<ExternalEvent, 'uid' | 'href' | 'start'>, status: ExternalAnswer): Promise<void> =>
    callEmpty(
      'POST',
      '/api/me/external-events/rsvp',
      body(RespondExternalEventRequestSchema, { uid: e.uid, href: e.href, start: timestampFromMs(e.start), status }),
    ),
  /** PATCH /api/me {work_hours}: the updated Me. */
  saveWorkHours: (wh: WorkHours) => api.me.update({ workHours: { startMin: wh.startMin, endMin: wh.endMin, days: [...wh.days] } }),
  caldav: {
    /** account null = none; planLocked: no plan of mine includes CalDAV, sync is stopped (ADR-0024, 30.09). */
    get: async (): Promise<{ account: CalDavAccount | null; planLocked: boolean }> => {
      const r = await call('GET', '/api/me/caldav', CalDavAccountResponseSchema);
      return { account: accountOf(r), planLocked: r.planLocked };
    },
    /** Connects (the server discovers the calendars); 422 url / password when it cannot be used. */
    connect: async (url: string, username: string, password: string): Promise<CalDavAccount | null> =>
      accountOf(await call('POST', '/api/me/caldav', CalDavAccountResponseSchema, body(ConnectCalDavRequestSchema, { url, username, password }))),
    update: async (p: { calendarHref: string; import: boolean; push: boolean }): Promise<CalDavAccount | null> =>
      accountOf(await call('PUT', '/api/me/caldav', CalDavAccountResponseSchema, body(UpdateCalDavRequestSchema, p))),
    /** PATCH {share_level}: what colleagues see (ADR-0045 §2). */
    setShare: async (level: ShareLevel): Promise<CalDavAccount | null> =>
      accountOf(await call('PATCH', '/api/me/caldav', CalDavAccountResponseSchema, body(SetCalDavShareRequestSchema, { shareLevel: SHARE_WIRE[level] }))),
    remove: (): Promise<void> => callEmpty('DELETE', '/api/me/caldav'),
    /** A manual sync (≤ 1 a minute: 429). */
    sync: async (): Promise<CalDavAccount | null> => accountOf(await call('POST', '/api/me/caldav/sync', CalDavAccountResponseSchema)),
  },
};

/** The delete of an external event failed because it changed in the calendar (409) / the calendar is read-only (422). */
export const externalChanged = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && e.code === 'ERROR_CODE_CONFLICT' && e.extra.reason !== 'PLAN_LIMIT';
export const externalReadOnly = (e: unknown): boolean => e instanceof ApiError && e.status === 422 && e.extra.reason === 'CALENDAR_READ_ONLY';

/** 409 NO_COMMON_HOURS: the people's work hours never overlap (ADR-0041 §2). */
export const noCommonHours = (e: unknown): boolean => e instanceof ApiError && (e.code === 'ERROR_CODE_NO_COMMON_HOURS' || e.reason === 'NO_COMMON_HOURS');
