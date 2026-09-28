import { describe, expect, it, vi } from 'vitest';
import { formatDuration, inviteRowUntil, inviteRowVisible, pad2, parseUserLimit, recordingTime, clockFor } from './voiceFormat';

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(25 * 60_000)).toBe('25:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5000)).toBe('0:00');
  });
});

describe('pad2', () => {
  it('zero-pads 0..99', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(2)).toBe('02');
    expect(pad2(42)).toBe('42');
    expect(pad2(99)).toBe('99');
  });
  it('clamps out-of-range input', () => {
    expect(pad2(-1)).toBe('00');
    expect(pad2(150)).toBe('99');
  });
});

describe('inviteRowVisible', () => {
  it('visible right after joining, gone after 30 s, hidden when the room is full', () => {
    expect(inviteRowVisible(1000, 1000, false)).toBe(true); // 0 s
    expect(inviteRowVisible(1000, 1000 + 31_000, false)).toBe(false); // 31 s
    expect(inviteRowVisible(1000, 1000, true)).toBe(false); // room at its limit
    expect(inviteRowVisible(null, 1000, false)).toBe(false); // not in this room
  });

  it('the window ends 30 s after the join (the one timer the row sets)', () => {
    expect(inviteRowUntil(1000)).toBe(31_000);
    expect(inviteRowUntil(null)).toBeNull();
    expect(inviteRowVisible(1000, 30_999, false)).toBe(true);
    expect(inviteRowVisible(1000, 31_000, false)).toBe(false);
  });
});

describe('parseUserLimit', () => {
  it('accepts 0..99, empty = 0', () => {
    expect(parseUserLimit('')).toBe(0);
    expect(parseUserLimit(' 5 ')).toBe(5);
    expect(parseUserLimit('99')).toBe(99);
    expect(parseUserLimit('100')).toBeNull();
    expect(parseUserLimit('-1')).toBeNull();
    expect(parseUserLimit('2.5')).toBeNull();
  });
});

describe('recordingTime', () => {
  it('counts from the recording start', () => {
    const since = 1_000_000;
    expect(recordingTime(since, since)).toBe('0:00');
    expect(recordingTime(since, since + 754_000)).toBe('12:34');
    expect(recordingTime(since, since + 3_600_000)).toBe('1:00:00');
    // A clock behind the server's `since` never shows a negative time.
    expect(recordingTime(since, since - 5_000)).toBe('0:00');
  });
});

describe('useNow(0)', () => {
  it('subscribes to no timer (a zero period must not spin)', () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const unsubscribe = clockFor(0).subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(before);
    expect(typeof clockFor(0).now).toBe('number');
    unsubscribe();
    vi.useRealTimers();
  });
});
