import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import { useSyncExternalStore } from 'react';
import { getLocale, numberFormat, t } from '../i18n';

export const toDate = (ts: Timestamp | undefined): Date => (ts ? timestampDate(ts) : new Date());

/**
 * Clock format of the current workspace (docs/09 #73, Workspace.time_format): `auto` — what the UI
 * language's `Intl` gives (as before), `h24` — «16:50», `h12` — «4:50 PM». Set by
 * services/timeFormat (from the workspace store); React re-renders through `useTimeFormat()`.
 */
export type TimeFormatPref = 'auto' | 'h24' | 'h12';

let timeFormat: TimeFormatPref = 'auto';
const timeFormatListeners = new Set<() => void>();

export const getTimeFormat = (): TimeFormatPref => timeFormat;

export function setTimeFormat(f: TimeFormatPref): void {
  if (f === timeFormat) return;
  timeFormat = f;
  for (const l of timeFormatListeners) l();
}

function subscribeTimeFormat(cb: () => void): () => void {
  timeFormatListeners.add(cb);
  return () => timeFormatListeners.delete(cb);
}

/** Subscribes a component (memo rows, the app root) to the clock format; returns it. */
export function useTimeFormat(): TimeFormatPref {
  return useSyncExternalStore(subscribeTimeFormat, getTimeFormat, getTimeFormat);
}

/** Applies the clock format to options that show the hour (`hour` or `timeStyle`). */
function withClock(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  if (timeFormat === 'auto' || (!opts.hour && !opts.timeStyle)) return opts;
  if (timeFormat === 'h24') return { ...opts, ...(opts.hour ? { hour: '2-digit' } : {}), hourCycle: 'h23' };
  return { ...opts, ...(opts.hour ? { hour: 'numeric' } : {}), hour12: true };
}

/**
 * Dates, times, numbers and sizes in the current UI language (ADR-0022): one place, `Intl.*` only.
 * Formatters are cached per locale + options (with the clock format); everything reads the locale
 * and the clock format at call time, so a switch applies on the next render.
 */
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = getLocale();
  const opts = withClock(options);
  const id = `${locale}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dtfCache.set(id, f);
  }
  return f;
}

/** A cached `Intl.DateTimeFormat` of the current locale and clock format (calendar, lib/calendar). */
export const dateTimeFormat = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => dtf(options);

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

function rtf(): Intl.RelativeTimeFormat {
  const locale = getLocale();
  let f = rtfCache.get(locale);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    rtfCache.set(locale, f);
  }
  return f;
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

function isYesterday(d: Date, now: Date): boolean {
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return sameDay(d, y);
}

const thisYear = (d: Date, now: Date): Intl.DateTimeFormatOptions => (d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' });

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Infinity],
];

export const fmt = {
  /** «14:05» / “2:05 PM” (auto); «16:50» (h24); «4:50 PM» (h12). */
  time: (d: Date): string => dtf({ hour: '2-digit', minute: '2-digit' }).format(d),
  /** «14:05» on the wall clock of IANA zone `tz` (a member's local time, docs/09 #48). */
  timeIn: (d: Date, tz: string): string => dtf({ hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d),
  /** Tooltip over a message time: weekday, full date, time. */
  full: (d: Date): string => dtf({ dateStyle: 'full', timeStyle: 'short' }).format(d),
  /** «14 января 2025 г.» / “January 14, 2025”. */
  date: (d: Date): string => dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(d),
  /** «3 окт.» / “Oct 3” — day and short month (the achievement card, ADR-0061). */
  dayMonth: (d: Date): string => dtf({ day: 'numeric', month: 'short' }).format(d),
  /** «1 дек 2025» / “Dec 1, 2025” — compact date for lists (member since, …). */
  shortDate(d: Date): string {
    if (getLocale() !== 'ru') return dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(d);
    // ru: Intl gives «1 дек. 2025 г.»; lists use the shorter «1 дек 2025».
    const parts = dtf({ day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(d);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('day')} ${part('month').replace(/\.$/, '')} ${part('year')}`;
  },
  /** Chat day separators: «Сегодня», «Вчера», «14 января», «14 января 2025» (year only when not this one). */
  dayLabel(d: Date, now = new Date()): string {
    if (sameDay(d, now)) return t('chat.today');
    if (isYesterday(d, now)) return t('chat.yesterday');
    return dtf({ day: 'numeric', month: 'long', ...thisYear(d, now) }).format(d);
  },
  /** «сегодня в 14:05», else «14 января 2025 г. 14:05» (sessions, invite expiry). */
  stamp(d: Date, now = new Date()): string {
    if (sameDay(d, now)) return t('date.todayAt', { time: fmt.time(d) });
    return `${fmt.date(d)} ${fmt.time(d)}`;
  },
  /** «14:30» today, «16 янв., 14:30» on another day (mute until …). */
  until(d: Date, now = new Date()): string {
    return sameDay(d, now) ? fmt.time(d) : dtf({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  },
  /** «1 октября, 12:00» (month long) or «1 окт., 12:00» (short); the year when it is not this one. */
  dateTime(d: Date, month: 'long' | 'short' = 'long', now = new Date()): string {
    return dtf({ day: 'numeric', month, ...thisYear(d, now), hour: '2-digit', minute: '2-digit' }).format(d);
  },
  /** List rows (DMs): «14:05» today, «вчера», «14 янв.» earlier. */
  listTime(d: Date, now = new Date()): string {
    if (sameDay(d, now)) return fmt.time(d);
    if (isYesterday(d, now)) return t('date.yesterday');
    return dtf({ day: 'numeric', month: 'short' }).format(d);
  },
  /** «5 минут назад», «через 2 часа», «вчера» — the largest unit that fits. */
  relative(d: Date, now = new Date()): string {
    let v = (d.getTime() - now.getTime()) / 1000;
    for (const [unit, size] of RELATIVE_STEPS) {
      if (Math.abs(v) < size) return rtf().format(Math.round(v), unit);
      v /= size;
    }
    return rtf().format(Math.round(v), 'year');
  },
  /** A number in the current locale («1 234,5» / “1,234.5”). */
  number: (n: number, opts?: Intl.NumberFormatOptions): string => numberFormat(opts).format(n),
  /** «512 Б», «1,5 КБ», «12,3 МБ», «1,25 ГБ» (binary units, as before). */
  size(bytes: number | bigint): string {
    const b = Number(bytes);
    const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    if (b < 1024) return t('unit.b', { n: fmt.number(b) });
    if (b < 1024 * 1024) return t('unit.kb', { n: fmt.number(b / 1024, one) });
    if (b < 1024 ** 3) return t('unit.mb', { n: fmt.number(b / 1024 / 1024, one) });
    return t('unit.gb', { n: fmt.number(b / 1024 ** 3, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  },
};
