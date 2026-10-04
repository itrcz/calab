import { t } from '../../i18n';
import type { ExternalAttendee, ExternalDeleteScopeName, ExternalEvent } from './freebusyApi';
import { addDays, dayEnd, dayKey, dayStart, formatLongDay } from './time';

/*
 * My external calendar's events on the client (ADR-0045 §3): which local days an event is on, its
 * key on the day grid, who of its attendees the meeting dialog can invite, and how a colleague's
 * external interval reads by what they share (§4). Pure.
 */

/** The day grid's key of an external event (with its occurrence: a series shares the uid). */
export const EXT = 'ext~';
export const externalKey = (e: Pick<ExternalEvent, 'uid' | 'start' | 'end'>): string => `${EXT}${e.uid}~${e.start}~${e.end}`;
export const isExternalKey = (key: string): boolean => key.startsWith(EXT);

export function parseExternalKey(key: string): { uid: string; start: number; end: number } {
  const [, uid = '', s, e] = key.split('~');
  return { uid, start: Number(s), end: Number(e) };
}

/** The local days (`YYYY-MM-DD`) an event is on: from its start's day to the day its end falls in (an end at midnight excluded). */
export function daysOf(e: Pick<ExternalEvent, 'start' | 'end'>): string[] {
  const out: string[] = [];
  let d = dayKey(e.start);
  for (let i = 0; i < 400 && dayStart(d) < e.end; i++) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/**
 * A window's answer as days: every day of [from, to) gets its list (empty ones too — «loaded,
 * nothing»), earliest first. Events crossing the window's edge are on the days inside it only.
 */
export function eventsByDay(events: readonly ExternalEvent[], from: number, to: number): Record<string, ExternalEvent[]> {
  const out: Record<string, ExternalEvent[]> = {};
  for (let d = dayKey(from); dayStart(d) < to; d = addDays(d, 1)) out[d] = [];
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  for (const e of sorted) for (const d of daysOf(e)) out[d]?.push(e);
  return out;
}

/**
 * A window's days put into what is held: a day wholly inside [from, to) is replaced; a day the
 * window only touches (its edges are not local midnights) keeps the other window's events too.
 */
export function mergeDays(
  held: Readonly<Record<string, readonly ExternalEvent[]>>,
  incoming: Record<string, ExternalEvent[]>,
  from: number,
  to: number,
): Record<string, readonly ExternalEvent[]> {
  const out: Record<string, readonly ExternalEvent[]> = { ...held };
  for (const [d, list] of Object.entries(incoming)) {
    const old = held[d];
    if (!old || (dayStart(d) >= from && dayEnd(d) <= to)) {
      out[d] = list;
      continue;
    }
    const keys = new Set(old.map(externalKey));
    out[d] = [...old, ...list.filter((e) => !keys.has(externalKey(e)))].sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return out;
}

/** A day's events as a primitive (the grid re-renders only when the set or a time changes). */
export function externalSignature(list: readonly ExternalEvent[] | undefined): string {
  if (!list?.length) return '';
  return list.map((e) => `${externalKey(e)}~${e.allDay ? 1 : 0}`).join('|');
}

export function parseExternalSignature(sig: string): Array<{ key: string; start: number; end: number; allDay: boolean }> {
  if (!sig) return [];
  return sig.split('|').map((p) => {
    const i = p.lastIndexOf('~');
    const key = p.slice(0, i);
    const { start, end } = parseExternalKey(key);
    return { key, start, end, allDay: p.slice(i + 1) === '1' };
  });
}

/**
 * «Создать встречу в Calab» (ADR-0045 §3): the attendees the dialog can invite — members of this
 * workspace (matched by the server, not me, not a guest or a bot: `canInvite`) — and the others'
 * addresses for the muted «Не в пространстве» line. Me (by id or address) is in neither.
 */
export function splitAttendees(
  attendees: readonly ExternalAttendee[],
  opts: { me: string; myEmail: string; canInvite: (userId: string) => boolean },
): { members: string[]; outside: string[] } {
  const members: string[] = [];
  const outside: string[] = [];
  const myEmail = opts.myEmail.toLowerCase();
  for (const a of attendees) {
    if ((a.userId && a.userId === opts.me) || (myEmail && a.email.toLowerCase() === myEmail)) continue;
    if (a.userId && opts.canInvite(a.userId)) {
      if (!members.includes(a.userId)) members.push(a.userId);
    } else if (a.email && !outside.includes(a.email)) outside.push(a.email);
  }
  return { members, outside };
}

/**
 * How a colleague's external interval reads (ADR-0045 §4): `null` — just «Занято» (they share
 * nothing); a title (they share the title); a title with the number of attendees in this workspace
 * (they share details and there are some).
 */
export function sharedLabel(b: { title: string; attendees: readonly string[] }): { title: string; count: number } | null {
  const title = b.title.trim();
  if (!title) return null;
  return { title, count: b.attendees.length };
}

// ---------------------------------------------------------------- delete (ADR-0045 amendment 1)

/**
 * Whom «Удалить из календаря» reaches: I organize it with others — they get a cancellation from my
 * calendar; otherwise only my calendar changes. `myEmails` — my Calab address and my CalDAV login.
 */
export function deleteRole(e: Pick<ExternalEvent, 'organizer' | 'attendees'>, myEmails: readonly string[]): 'organizer' | 'attendee' {
  const mine = new Set(myEmails.map((m) => m.trim().toLowerCase()).filter(Boolean));
  const org = e.organizer.toLowerCase();
  if (!org || !mine.has(org)) return 'attendee';
  return e.attendees.some((a) => !mine.has(a.email.toLowerCase())) ? 'organizer' : 'attendee';
}

/**
 * The confirmation of «Удалить из календаря»: the title by what goes (the event / this occurrence /
 * the whole series), the text by whom it reaches (`deleteRole`).
 */
export function deletePrompt(
  e: Pick<ExternalEvent, 'summary' | 'start' | 'recurring' | 'organizer' | 'attendees'>,
  scope: ExternalDeleteScopeName,
  myEmails: readonly string[],
): { title: string; text: string; action: string } {
  const title = e.summary || t('ext.noTitle');
  const head = !e.recurring
    ? t('ext.deleteTitle', { title })
    : scope === 'series'
      ? t('ext.deleteSeriesTitle', { title })
      : t('ext.deleteOneTitle', { date: formatLongDay(e.start) });
  return { title: head, text: t(deleteRole(e, myEmails) === 'organizer' ? 'ext.deleteOrganizer' : 'ext.deleteAttendee'), action: t('ext.deleteAction') };
}

/** The deleted event: `whole` — every occurrence of its uid (a series, an event without repeats), else this occurrence. */
const removes =
  (target: Pick<ExternalEvent, 'uid' | 'start'>, whole: boolean) =>
  (e: ExternalEvent): boolean =>
    e.uid === target.uid && (whole || e.start === target.start);

/** The days without the deleted event; `removed` — what was taken out of each day (put back if the server refuses). */
export function withoutExternal(
  days: Readonly<Record<string, readonly ExternalEvent[]>>,
  target: Pick<ExternalEvent, 'uid' | 'start'>,
  whole: boolean,
): { days: Record<string, readonly ExternalEvent[]>; removed: Record<string, ExternalEvent[]> } {
  const out: Record<string, readonly ExternalEvent[]> = { ...days };
  const removed: Record<string, ExternalEvent[]> = {};
  const gone = removes(target, whole);
  for (const [d, list] of Object.entries(days)) {
    if (!list.some(gone)) continue;
    removed[d] = list.filter(gone);
    out[d] = list.filter((e) => !gone(e));
  }
  return { days: out, removed };
}

/** Puts back what `withoutExternal` took out (an event loaded again meanwhile is not doubled). */
export function restoreExternal(
  days: Readonly<Record<string, readonly ExternalEvent[]>>,
  removed: Readonly<Record<string, readonly ExternalEvent[]>>,
): Record<string, readonly ExternalEvent[]> {
  const out: Record<string, readonly ExternalEvent[]> = { ...days };
  for (const [d, back] of Object.entries(removed)) {
    const list = out[d] ?? [];
    const keys = new Set(list.map(externalKey));
    out[d] = [...list, ...back.filter((e) => !keys.has(externalKey(e)))].sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return out;
}
