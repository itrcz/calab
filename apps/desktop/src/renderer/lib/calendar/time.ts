import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { CalendarEvent } from '@calaba/protocol';
import { t } from '../../i18n';
import { usePrefs } from '../../stores/prefs';
import { dateTimeFormat } from '../format';

/*
 * Calendar dates and times (ADR-0038 §7): the server keeps UTC instants, the client shows them in
 * the viewer's zone. A day is a `YYYY-MM-DD` key of that zone (the device's, or `tz` in tests and
 * for all-day meetings, which belong to the organizer's calendar date). Pure; `Intl` only.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Grid step of the day view and the dialog's time lists. */
export const STEP_MIN = 15;

const pad = (n: number): string => String(n).padStart(2, '0');

const keyFormats = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of an instant on the wall calendar of `tz` (default: the device's zone). */
export function dayKey(at: Date | number, tz?: string): string {
  const d = typeof at === 'number' ? new Date(at) : at;
  if (!tz) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let f = keyFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    keyFormats.set(tz, f);
  }
  return f.format(d);
}

function parts(key: string): [number, number, number] {
  const [y = '1970', m = '1', d = '1'] = key.split('-');
  return [Number(y), Number(m), Number(d)];
}

/** Local midnight of a day key (DST-safe: the Date constructor, not +24 h). */
export function dayStart(key: string): number {
  const [y, m, d] = parts(key);
  return new Date(y, m - 1, d).getTime();
}

/** The next local midnight (a 23- or 25-hour day across DST). */
export function dayEnd(key: string): number {
  const [y, m, d] = parts(key);
  return new Date(y, m - 1, d + 1).getTime();
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = parts(key);
  return dayKey(new Date(y, m - 1, d + n));
}

/** Local `Date` of a day key at `minutes` after its midnight (the dialog's fields). */
export function atMinutes(key: string, minutes: number): Date {
  const [y, m, d] = parts(key);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

/** Minutes since local midnight of an instant. */
export const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** `YYYY-MM` of a day key. */
export const monthOf = (key: string): string => key.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = parts(`${month}-01`);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** The first weekday of every calendar grid (Settings → Календарь, CBF-165): 1 = Monday (default for every language), 0 = Sunday. */
export const weekStart = (): 0 | 1 => usePrefs.getState().weekStartsOn;

/** Reactive `weekStart` for components: a change in settings redraws the grids. */
export const useWeekStart = (): 0 | 1 => usePrefs((s) => s.weekStartsOn);

/** The 6 × 7 day keys of a month's grid (leading / trailing days of the neighbours included). */
export function monthGrid(month: string, first: 0 | 1 = weekStart()): string[] {
  const [y, m] = parts(`${month}-01`);
  const lead = (new Date(y, m - 1, 1).getDay() - first + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => dayKey(new Date(y, m - 1, 1 - lead + i)));
}

/** The 7 day keys of the week holding `day` (the week view), from the locale's first weekday. */
export function weekDays(day: string, first: 0 | 1 = weekStart()): string[] {
  const [y, m, d] = parts(day);
  const lead = (new Date(y, m - 1, d).getDay() - first + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => dayKey(new Date(y, m - 1, d - lead + i)));
}

/** ISO 8601 week number of a day («43 нед.»): the week of its Thursday, weeks from Monday. */
export function isoWeek(day: string): number {
  const [y, m, d] = parts(day);
  // UTC arithmetic: no DST hours in the day count.
  const at = Date.UTC(y, m - 1, d);
  const thursday = at + (3 - ((new Date(at).getUTCDay() + 6) % 7)) * 86_400_000;
  const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - jan1) / 86_400_000 / 7) + 1;
}

/** «UTC+3», «UTC−4:30», «UTC» — the viewer's offset at an instant (the week view's time column). */
export function utcOffsetLabel(at: number): string {
  const off = -new Date(at).getTimezoneOffset();
  if (off === 0) return 'UTC';
  const abs = Math.abs(off);
  const mm = abs % 60;
  return `UTC${off > 0 ? '+' : '−'}${Math.floor(abs / 60)}${mm ? `:${pad(mm)}` : ''}`;
}

/**
 * The week view's title: «Октябрь 2026 г.»; a week across two months — the locale's range form
 * («октябрь – ноябрь 2026 г.»), first letter capitalised.
 */
export function formatWeekTitle(days: readonly string[]): string {
  const a = days[0] ?? '';
  const b = days[days.length - 1] ?? a;
  if (monthOf(a) === monthOf(b)) return formatMonth(monthOf(a));
  const s = dateTimeFormat({ month: 'long', year: 'numeric' }).formatRange(dayStart(a), dayStart(b));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** [from, to) of a month's grid: what one list request covers (≤ 62 days, ADR-0038 §3). */
export function gridWindow(month: string, first: 0 | 1 = weekStart()): [number, number] {
  const g = monthGrid(month, first);
  return [dayStart(g[0] ?? `${month}-01`), dayEnd(g[41] ?? `${month}-28`)];
}

/**
 * Short weekday names in grid order (owner, 30.09; docs/09 #140): «Пн Вт Ср Чт Пт Сб Вс», «Mon»,
 * «Lun», «周一» — the locale's short form without a trailing dot, the first letter capitalised.
 */
export function weekdayNames(first: 0 | 1 = weekStart()): string[] {
  const f = dateTimeFormat({ weekday: 'short' });
  // 2026-01-04 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => shortWeekday(f.format(new Date(2026, 0, 4 + first + i))));
}

export function shortWeekday(s: string): string {
  const w = s.replace(/\.$/, '');
  return w.charAt(0).toLocaleUpperCase() + w.slice(1);
}

const tsMs = (ts: Timestamp | undefined, fallback = 0): number => (ts ? timestampMs(ts) : fallback);

/** Start / end of an occurrence (lists) or of the series' first one (GET /api/events/{id}). */
export function eventSpan(ev: Pick<CalendarEvent, 'startsAt' | 'endsAt'>): { start: number; end: number } {
  const start = tsMs(ev.startsAt);
  return { start, end: Math.max(start, tsMs(ev.endsAt, start)) };
}

/** The occurrence's start: its `occurrence_at`, else `starts_at` (a series or a single meeting). */
export const occurrenceMs = (ev: Pick<CalendarEvent, 'occurrenceAt' | 'startsAt'>): number => tsMs(ev.occurrenceAt, tsMs(ev.startsAt));

/**
 * The days an occurrence shows on: an all-day meeting — its dates in the organizer's zone (an
 * all-day «15 января» is 15 January for everyone); a timed one — every local day it overlaps.
 */
export function eventDays(ev: Pick<CalendarEvent, 'startsAt' | 'endsAt' | 'allDay' | 'tz'>, tz?: string): string[] {
  const { start, end } = eventSpan(ev);
  const zone = ev.allDay ? ev.tz || 'UTC' : tz;
  const last = dayKey(Math.max(start, end - 1), zone);
  const out: string[] = [];
  for (let k = dayKey(start, zone); out.length < 62; k = addDays(k, 1)) {
    out.push(k);
    if (k >= last) break;
  }
  return out;
}

const timeOpts = (tz?: string): Intl.DateTimeFormatOptions => ({ hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });

/** «15:00» in the viewer's zone (`tz` for tests / another zone). */
export const formatTime = (ms: number, tz?: string): string => dateTimeFormat(timeOpts(tz)).format(ms);

/** «чт, 15 янв.» — a short date with the weekday. */
export const formatShortDay = (ms: number, tz?: string): string =>
  dateTimeFormat({ weekday: 'short', day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) }).format(ms);

/** «четверг, 15 января» (the day view's title, the card's date). */
export function formatLongDay(ms: number, tz?: string, now = Date.now()): string {
  const year = new Date(ms).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const };
  return dateTimeFormat({ weekday: 'long', day: 'numeric', month: 'long', ...year, ...(tz ? { timeZone: tz } : {}) }).format(ms);
}

/** «январь 2026» — the mini calendar's title. */
export function formatMonth(month: string): string {
  const [y, m] = parts(`${month}-01`);
  const s = dateTimeFormat({ month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The time of an occurrence in the viewer's zone: «15:00 – 16:00»; across midnight «15 янв., 23:00 –
 * 16 янв., 01:00»; all day — «Весь день» (several days: «15 янв. – 17 янв.»).
 */
export function formatRange(ev: Pick<CalendarEvent, 'startsAt' | 'endsAt' | 'allDay' | 'tz'>, tz?: string): string {
  const { start, end } = eventSpan(ev);
  if (ev.allDay) {
    const days = eventDays(ev, tz);
    if (days.length <= 1) return t('cal.allDay');
    const zone = ev.tz || 'UTC';
    const f = dateTimeFormat({ day: 'numeric', month: 'short', timeZone: zone });
    return `${f.format(start)} – ${f.format(end - 1)}`;
  }
  if (dayKey(start, tz) === dayKey(Math.max(start, end - 1), tz)) return `${formatTime(start, tz)} – ${formatTime(end, tz)}`;
  const f = dateTimeFormat({ day: 'numeric', month: 'short', ...timeOpts(tz) });
  return `${f.format(start)} – ${f.format(end)}`;
}

/** «четверг, 15 января · 15:00 – 16:00» — the card's date line in the viewer's zone. */
export function formatWhen(ev: Pick<CalendarEvent, 'startsAt' | 'endsAt' | 'allDay' | 'tz'>, tz?: string, now = Date.now()): string {
  const { start } = eventSpan(ev);
  const day = formatLongDay(start, ev.allDay ? ev.tz || 'UTC' : tz, now);
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${formatRange(ev, tz)}`;
}

/** Rounds minutes down to the grid step (a click on the day grid). */
export const snapDown = (minutes: number, step = STEP_MIN): number => Math.max(0, Math.floor(minutes / step) * step);

/** The times of a day in grid steps, for the dialog's lists: 0, 15, … 1425. */
export const DAY_STEPS: readonly number[] = Array.from({ length: (24 * 60) / STEP_MIN }, (_, i) => i * STEP_MIN);

/** «15:00» for minutes since midnight (the dialog's time lists; the clock format applies). */
export const formatMinutes = (minutes: number): string => dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(new Date(2026, 0, 1, Math.floor(minutes / 60), minutes % 60));

/** The viewer's IANA zone (shown in the dialog, sent as the organizer's zone). */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
