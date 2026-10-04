/**
 * Workspace calendar in the mock (ADR-0038): the stored meetings and their pure logic —
 * occurrence expansion, answers, counts, address masking, the signed-answer tokens of external
 * attendees. The routes and gateway fan-out live in mock-server.ts (`calendarRoutes`).
 *
 * Simplifications against the server: repeats are expanded in UTC (fixtures use UTC meetings),
 * no mail is sent, guest links are made only on request (`eventGuestLink`; `guestLinks` stays
 * false).
 */
import { clone, create } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  AttendeeStatus,
  CalendarEventCountsSchema,
  CalendarEventSchema,
  EventRepeat,
  type CalendarEvent,
  type CalendarEventAttendee,
} from '@calaba/protocol';

/** A stored meeting: the series (occurrence_at unset), its cancelled occurrences and recordings. */
export interface CalEventRec {
  ev: CalendarEvent;
  /** Cancelled occurrence starts (ms). */
  exceptions: Set<number>;
  /** Recording of an occurrence: start (ms) → recording id. */
  recordings: Map<number, string>;
  /** Guest links of external attendees made by `eventGuestLink`: email → room invite id. */
  guestLinks?: Map<string, string>;
}

export interface Occurrence {
  startMs: number;
  endMs: number;
}

/** A room shows its meeting this long before the start (ADR-0038 §6). */
export const ACTIVE_BEFORE_MS = 15 * 60_000;

const DAY = 86_400_000;

function nth(startMs: number, repeat: EventRepeat, n: number): number | null {
  switch (repeat) {
    case EventRepeat.DAILY:
      return startMs + n * DAY;
    case EventRepeat.WEEKLY:
      return startMs + n * 7 * DAY;
    case EventRepeat.BIWEEKLY:
      return startMs + n * 14 * DAY;
    case EventRepeat.MONTHLY: {
      const d = new Date(startMs);
      const day = d.getUTCDate();
      d.setUTCMonth(d.getUTCMonth() + n);
      return d.getUTCDate() === day ? d.getTime() : null; // months without that day are skipped
    }
    default:
      return n === 0 ? startMs : null;
  }
}

/** Live occurrences of a series overlapping [fromMs, toMs), in order (≤ 500). */
export function occurrences(rec: CalEventRec, fromMs: number, toMs: number): Occurrence[] {
  const e = rec.ev;
  const start = e.startsAt ? timestampMs(e.startsAt) : 0;
  const dur = (e.endsAt ? timestampMs(e.endsAt) : start) - start;
  const until = e.repeatUntil ? timestampMs(e.repeatUntil) : Infinity;
  const out: Occurrence[] = [];
  for (let n = 0; n < 5000 && out.length < 500; n++) {
    const s = nth(start, e.repeat, n);
    if (s === null) {
      if (e.repeat === EventRepeat.UNSPECIFIED) break;
      continue;
    }
    if (s >= toMs || s > until) break;
    if (s + dur > fromMs && !rec.exceptions.has(s)) out.push({ startMs: s, endMs: s + dur });
  }
  return out;
}

/** The occurrence active at nowMs (from 15 minutes before its start until its end), if any. */
export function activeOccurrence(rec: CalEventRec, nowMs: number): Occurrence | null {
  if (!rec.ev.roomId || rec.ev.cancelledAt) return null;
  return occurrences(rec, nowMs, nowMs + ACTIVE_BEFORE_MS + 1).find((o) => nowMs >= o.startMs - ACTIVE_BEFORE_MS && nowMs < o.endMs) ?? null;
}

export function counts(attendees: readonly CalendarEventAttendee[]): ReturnType<typeof create<typeof CalendarEventCountsSchema>> {
  const c = create(CalendarEventCountsSchema);
  for (const a of attendees) {
    if (a.status === AttendeeStatus.ACCEPTED) c.accepted++;
    else if (a.status === AttendeeStatus.DECLINED) c.declined++;
    else if (a.status === AttendeeStatus.MAYBE) c.maybe++;
    else c.pending++;
  }
  return c;
}

export function involves(ev: CalendarEvent, userId: string): boolean {
  return ev.organizerId === userId || ev.attendees.some((a) => a.userId === userId);
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${Array.from(email.slice(0, at))[0] ?? ''}***${email.slice(at)}`;
}

/** How a viewer sees external addresses: in full, masked, or not at all (bots). */
export type EmailView = 'full' | 'masked' | 'none';

/**
 * The event as one viewer sees it: `occ` = one occurrence (lists), null = the series; `view`
 * applies to external addresses; `me` fills my_status / can_edit ('' = a gateway payload).
 */
export function eventOut(rec: CalEventRec, occ: Occurrence | null, view: EmailView, me: string, canEdit: boolean): CalendarEvent {
  const out = clone(CalendarEventSchema, rec.ev);
  out.counts = counts(out.attendees);
  out.cancelledOccurrences = [...rec.exceptions].sort((a, b) => a - b).map((ms) => timestampFromMs(ms));
  if (occ) {
    out.startsAt = timestampFromMs(occ.startMs);
    out.endsAt = timestampFromMs(occ.endMs);
    out.occurrenceAt = timestampFromMs(occ.startMs);
    out.recordingId = rec.recordings.get(occ.startMs) ?? '';
  }
  for (const a of out.attendees) {
    if (!a.email) continue;
    if (view === 'none') a.email = '';
    else if (view === 'masked') a.email = maskEmail(a.email);
  }
  if (me) {
    out.myStatus = out.attendees.find((a) => a.userId === me)?.status ?? AttendeeStatus.UNSPECIFIED;
    out.canEdit = canEdit;
  }
  return out;
}

/**
 * The event as a guest of the workspace (ADR-0016) sees the meeting active in a room it can view
 * (ADR-0038 «Диплинки для приглашённых»): no attendees (counts only), no recording, no rights.
 */
export function eventForGuest(ev: CalendarEvent): CalendarEvent {
  const out = clone(CalendarEventSchema, ev);
  out.attendees = [];
  out.recordingId = '';
  out.myStatus = AttendeeStatus.UNSPECIFIED;
  out.canEdit = false;
  out.guestLinks = false;
  return out;
}

/**
 * The mock's answer link token of an external attendee: `mock.<eventId>.<base64url(email)>.<status>`
 * (the server signs it; the mock only needs to round-trip it for the web page). Status
 * UNSPECIFIED is the view token of the mail's meeting link (/e/<id>?t=…): it opens the page but
 * cannot answer.
 */
export function rsvpToken(eventId: string, email: string, status: AttendeeStatus): string {
  return `mock.${eventId}.${Buffer.from(email).toString('base64url')}.${String(status)}`;
}

/** The view token of an external attendee (the meeting link of its mail: /e/<id>?t=…). */
export function viewToken(eventId: string, email: string): string {
  return rsvpToken(eventId, email, AttendeeStatus.UNSPECIFIED);
}

/** Statuses a token may carry: UNSPECIFIED = view, else the answer. */
const TOKEN_STATUSES: readonly AttendeeStatus[] = [AttendeeStatus.UNSPECIFIED, AttendeeStatus.ACCEPTED, AttendeeStatus.DECLINED, AttendeeStatus.MAYBE];

export function parseRsvpToken(tok: string): { eventId: string; email: string; status: AttendeeStatus; view: boolean } | null {
  const [pre, eventId, email, status] = tok.split('.');
  const st: AttendeeStatus | undefined = TOKEN_STATUSES.find((x) => String(x) === status);
  if (pre !== 'mock' || !eventId || !email || st === undefined) return null;
  return { eventId, email: Buffer.from(email, 'base64url').toString(), status: st, view: st === AttendeeStatus.UNSPECIFIED };
}

/** Allowed reminder minutes (ADR-0038 §1). */
export const REMINDER_CHOICES = [5, 10, 15, 30, 60, 120, 1440];

// ---------------------------------------------------------------- free / busy (ADR-0041)

/*
 * Free / busy of the mock: one person's busy time (their meetings — not declined — and the external
 * calendar's), the suggest slots (one per common free window, 15-minute aligned, ≤ 10), the CalDAV
 * account. The interval math is the client's own pure module (lib/calendar/freebusy.ts), so the
 * mock and the grid agree by construction; the server has its own.
 */
export interface Span {
  startMs: number;
  endMs: number;
}

export interface WorkHoursRec {
  startMin: number;
  endMin: number;
  days: number[];
}

export const DEFAULT_WORK_HOURS: WorkHoursRec = { startMin: 600, endMin: 1140, days: [1, 2, 3, 4, 5] };

/** A user's meeting occurrences in [from, to): organizer, or an attendee who has not declined. */
export function meetingBusy(recs: Iterable<CalEventRec>, workspaceId: string, userId: string, fromMs: number, toMs: number): Array<Occurrence & { rec: CalEventRec }> {
  const out: Array<Occurrence & { rec: CalEventRec }> = [];
  for (const rec of recs) {
    const ev = rec.ev;
    if (ev.workspaceId !== workspaceId || ev.cancelledAt) continue;
    const mine = ev.organizerId === userId || ev.attendees.some((a) => a.userId === userId && a.status !== AttendeeStatus.DECLINED);
    if (!mine) continue;
    for (const o of occurrences(rec, fromMs, toMs)) out.push({ ...o, rec });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The first 15-minute-aligned slot of `durationMin` in each free window, earliest first, ≤ `max`. */
export function slotsOf(windows: readonly { start: number; end: number }[], durationMin: number, max = 10): Span[] {
  const q = 15 * 60_000;
  const len = durationMin * 60_000;
  const out: Span[] = [];
  for (const w of windows) {
    const s = Math.ceil(w.start / q) * q;
    if (s + len <= w.end) out.push({ startMs: s, endMs: s + len });
    if (out.length >= max) break;
  }
  return out;
}

/** The fake CalDAV account of a user (ADR-0041 §4); the password is never returned. */
export interface CalDavRec {
  url: string;
  username: string;
  calendarHref: string;
  import: boolean;
  push: boolean;
  lastSyncAt: number | null;
  lastError: string;
  /** What colleagues see of the imported events (ADR-0045 §2). */
  shareLevel?: ShareLevelRec;
}

export type ShareLevelRec = 'busy' | 'title' | 'details';

/** An imported external event (ADR-0045 §1): a busy span with its details (all optional). */
export interface ExternalSpan extends Span {
  uid?: string;
  summary?: string;
  location?: string;
  attendees?: ReadonlyArray<{ email: string; name?: string }>;
  organizer?: string;
  url?: string;
  /** ADR-0045 amendment 1: the object (deletable when set), a series, the provider's page. */
  href?: string;
  recurring?: boolean;
  webUrl?: string;
}

const SHARE_WIRE: Record<ShareLevelRec, string> = { busy: 'CAL_DAV_SHARE_LEVEL_BUSY', title: 'CAL_DAV_SHARE_LEVEL_TITLE', details: 'CAL_DAV_SHARE_LEVEL_DETAILS' };

/** PATCH /api/me/caldav's share_level (the JSON enum name or number) → the stored level; null = invalid. */
export function shareLevelIn(v: unknown): ShareLevelRec | null {
  switch (v) {
    case 'CAL_DAV_SHARE_LEVEL_BUSY':
    case 1:
      return 'busy';
    case 'CAL_DAV_SHARE_LEVEL_TITLE':
    case 2:
      return 'title';
    case 'CAL_DAV_SHARE_LEVEL_DETAILS':
    case 3:
      return 'details';
  }
  return null;
}

/**
 * What a colleague sees of an external span (ADR-0045 §4): the title at title / details, the
 * attendees who are members (`member(email)` → user id or '') at details. Never the place,
 * organizer or link.
 */
export function sharedBusy(x: ExternalSpan, level: ShareLevelRec, member: (email: string) => string): { title?: string; attendeeUserIds?: string[] } {
  if (level === 'busy' || !x.summary) return {};
  if (level === 'title') return { title: x.summary };
  const ids = [...new Set((x.attendees ?? []).map((a) => member(a.email.toLowerCase())).filter(Boolean))];
  return { title: x.summary, ...(ids.length ? { attendeeUserIds: ids } : {}) };
}

/** ExternalEventsResponse of the owner over [from, to): every detail; `member` gives attendees' ids ('' = none). */
export function externalEventsOut(list: readonly ExternalSpan[], fromMs: number, toMs: number, member: (email: string) => string): Record<string, unknown> {
  const iso = (t: number): string => new Date(t).toISOString();
  const events = list
    .filter((x) => x.endMs > fromMs && x.startMs < toMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((x, i) => ({
      uid: x.uid ?? `ext${i}`,
      startsAt: iso(x.startMs),
      endsAt: iso(x.endMs),
      summary: x.summary ?? '',
      location: x.location ?? '',
      attendees: (x.attendees ?? []).map((a) => {
        const email = a.email.toLowerCase();
        const userId = member(email);
        return { email, name: a.name ?? '', ...(userId ? { userId } : {}) };
      }),
      organizer: x.organizer ?? '',
      url: x.url ?? '',
      href: x.href ?? '',
      recurring: !!x.recurring,
      webUrl: x.webUrl ?? '',
    }));
  return { events };
}

/** The calendars the fake discovery finds under a server address. */
export function davCalendars(url: string): Array<{ href: string; name: string; color: string }> {
  const base = url.replace(/\/+$/, '');
  return [
    { href: `${base}/calendars/work/`, name: 'Работа', color: '#0a84ff' },
    { href: `${base}/calendars/home/`, name: 'Личное', color: '#30d158' },
  ];
}

/** CalDavAccountResponse: `{account}`, or `{}` without one. */
export function davOut(a: CalDavRec | undefined): Record<string, unknown> {
  if (!a) return {};
  return {
    account: {
      url: a.url,
      username: a.username,
      calendarHref: a.calendarHref,
      import: a.import,
      push: a.push,
      ...(a.lastSyncAt ? { lastSyncAt: new Date(a.lastSyncAt).toISOString() } : {}),
      lastError: a.lastError,
      calendars: davCalendars(a.url),
      shareLevel: SHARE_WIRE[a.shareLevel ?? 'busy'],
    },
  };
}
