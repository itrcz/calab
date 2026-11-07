import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CalendarEventSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, dayKey, eventDays, formatRange, formatTime, formatWhen, monthGrid, weekDays, weekStart, weekdayNames } from './time';
import { usePrefs } from '../../stores/prefs';

/**
 * The viewer's zone (ADR-0038 §1, TESTING.md C.12): the same UTC meeting reads 15:00 in Moscow (+3)
 * and 19:00 in Krasnoyarsk (+7); a day key belongs to the zone it is taken in.
 */
const at = (iso: string): number => Date.parse(iso);
const meeting = (start: string, end: string, extra: Partial<{ allDay: boolean; tz: string }> = {}) =>
  create(CalendarEventSchema, { startsAt: timestampFromMs(at(start)), endsAt: timestampFromMs(at(end)), tz: 'Europe/Moscow', ...extra });

describe('time in the viewer’s zone', () => {
  it('shows one UTC instant on each viewer’s own clock', () => {
    const noonUtc = at('2026-01-15T12:00:00Z');
    expect(formatTime(noonUtc, 'Europe/Moscow')).toBe('15:00');
    expect(formatTime(noonUtc, 'Asia/Krasnoyarsk')).toBe('19:00');
  });

  it('formats a range, across midnight with the dates', () => {
    expect(formatRange(meeting('2026-01-15T12:00:00Z', '2026-01-15T13:00:00Z'), 'Europe/Moscow')).toBe('15:00 – 16:00');
    // 23:00–01:00 in Moscow crosses midnight there, not in UTC.
    const late = meeting('2026-01-15T20:00:00Z', '2026-01-15T22:00:00Z');
    expect(formatRange(late, 'Europe/Moscow')).toMatch(/^15 янв\.?,? 23:00 – 16 янв\.?,? 01:00$/);
    expect(formatRange(late, 'UTC')).toBe('20:00 – 22:00');
  });

  it('all day: «Весь день», on the organizer’s calendar date for everyone', () => {
    const allDay = meeting('2026-01-14T21:00:00Z', '2026-01-15T21:00:00Z', { allDay: true, tz: 'Europe/Moscow' });
    expect(formatRange(allDay, 'America/New_York')).toBe('Весь день');
    expect(eventDays(allDay, 'America/New_York')).toEqual(['2026-01-15']);
    expect(formatWhen(allDay, 'America/New_York', at('2026-01-15T10:00:00Z'))).toBe('Четверг, 15 января · Весь день');
  });

  it('day keys follow the zone', () => {
    const t = at('2026-01-15T22:30:00Z');
    expect(dayKey(t, 'UTC')).toBe('2026-01-15');
    expect(dayKey(t, 'Europe/Moscow')).toBe('2026-01-16');
    // A timed meeting over midnight shows on both local days.
    expect(eventDays(meeting('2026-01-15T20:00:00Z', '2026-01-15T22:00:00Z'), 'Europe/Moscow')).toEqual(['2026-01-15', '2026-01-16']);
  });
});

describe('calendar grid', () => {
  it('steps days and months', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('a month grid is 6 weeks from the locale’s first weekday', () => {
    const mon = monthGrid('2026-01', 1);
    expect(mon).toHaveLength(42);
    // 1 January 2026 is a Thursday: Monday-first starts on 29 December.
    expect(mon[0]).toBe('2025-12-29');
    expect(mon[3]).toBe('2026-01-01');
    const sun = monthGrid('2026-01', 0);
    expect(sun[0]).toBe('2025-12-28');
    // CBF-165: Monday by default for every language; the setting switches it.
    expect(weekStart()).toBe(1);
    expect(weekdayNames()[0]).not.toBe(weekdayNames(0)[0]);
    usePrefs.getState().setPrefs({ weekStartsOn: 0 });
    expect(weekStart()).toBe(0);
    expect(monthGrid('2026-01')[0]).toBe('2025-12-28');
    expect(weekDays('2026-01-14')[0]).toBe('2026-01-11');
    usePrefs.getState().setPrefs({ weekStartsOn: 1 });
    expect(monthGrid('2026-01')[0]).toBe('2025-12-29');
    expect(weekDays('2026-01-14')[0]).toBe('2026-01-12');
  });
});
