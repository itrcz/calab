import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { fmt, getTimeFormat, setTimeFormat } from './format';

// Local wall clock: fmt.time formats in the process zone.
const at = (h: number, m: number): Date => new Date(2026, 0, 5, h, m);
// ICU versions differ in the space before AM/PM (U+202F / U+00A0 / U+0020).
const sp = (s: string): string => s.replace(/[\u202f\u00a0]/g, ' ');

describe('fmt clock format (docs/09 #73)', () => {
  afterEach(async () => {
    setTimeFormat('auto');
    await setLocale('ru');
  });

  it('h24: «16:50», midnight «00:07», minutes padded', () => {
    setTimeFormat('h24');
    expect(fmt.time(at(16, 50))).toBe('16:50');
    expect(fmt.time(at(0, 7))).toBe('00:07');
    expect(fmt.time(at(9, 5))).toBe('09:05');
  });

  it('h24 in English too (no AM/PM)', async () => {
    await setLocale('en');
    setTimeFormat('h24');
    expect(fmt.time(at(16, 50))).toBe('16:50');
    expect(fmt.time(at(0, 0))).toBe('00:00');
  });

  it('h12: «4:50 PM», midnight «12:07 AM», noon «12:00 PM»', async () => {
    await setLocale('en');
    setTimeFormat('h12');
    expect(sp(fmt.time(at(16, 50)))).toBe('4:50 PM');
    expect(sp(fmt.time(at(0, 7)))).toBe('12:07 AM');
    expect(sp(fmt.time(at(12, 0)))).toBe('12:00 PM');
    expect(sp(fmt.time(at(9, 5)))).toBe('9:05 AM');
  });

  it('h12 in Russian keeps the minutes and marks the half of the day', () => {
    setTimeFormat('h12');
    const s = fmt.time(at(16, 50));
    expect(s).toMatch(/^4:50\s/);
    expect(s).not.toBe(fmt.time(at(4, 50)));
  });

  it('auto: the UI language decides (ru 24 h, en 12 h), as before', async () => {
    expect(getTimeFormat()).toBe('auto');
    expect(fmt.time(at(16, 50))).toBe('16:50');
    await setLocale('en');
    expect(fmt.time(at(16, 50))).toMatch(/^0?4:50\sPM$/);
  });

  it('applies to every formatter with an hour: timeIn, until, dateTime, full', async () => {
    await setLocale('en');
    setTimeFormat('h24');
    const d = at(16, 50);
    expect(fmt.timeIn(new Date(Date.UTC(2026, 0, 5, 16, 50)), 'UTC')).toBe('16:50');
    expect(fmt.until(new Date(2025, 0, 5, 16, 50), new Date(2026, 0, 5))).toContain('16:50');
    expect(fmt.dateTime(d)).toContain('16:50');
    expect(fmt.full(d)).toContain('16:50');
    setTimeFormat('h12');
    expect(sp(fmt.timeIn(new Date(Date.UTC(2026, 0, 5, 16, 50)), 'UTC'))).toBe('4:50 PM');
    expect(sp(fmt.dateTime(d))).toContain('4:50 PM');
    expect(fmt.full(d)).toMatch(/0?4:50\sPM/);
  });

  it('a switch applies on the next call (formatter cache keyed by the format)', () => {
    setTimeFormat('h24');
    expect(fmt.time(at(16, 50))).toBe('16:50');
    setTimeFormat('h12');
    expect(fmt.time(at(16, 50))).not.toBe('16:50');
    setTimeFormat('h24');
    expect(fmt.time(at(16, 50))).toBe('16:50');
  });
});
