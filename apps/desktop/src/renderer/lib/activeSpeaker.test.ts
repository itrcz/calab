import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_SPEAKER_HOLD_MS, ACTIVE_SPEAKER_MIN_MS, ActiveSpeaker } from './activeSpeaker';

describe('ActiveSpeaker (800 ms to qualify, 1.5 s minimum hold)', () => {
  let changes: (string | null)[];
  let a: ActiveSpeaker;
  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    a = new ActiveSpeaker((id) => changes.push(id));
  });
  afterEach(() => vi.useRealTimers());

  it('uses the ADR-0066 thresholds', () => {
    expect(ACTIVE_SPEAKER_HOLD_MS).toBe(800);
    expect(ACTIVE_SPEAKER_MIN_MS).toBe(1500);
  });

  it('becomes active only after 800 ms of continuous speech', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(799);
    expect(a.value).toBeNull();
    vi.advanceTimersByTime(1);
    expect(a.value).toBe('b');
    expect(changes).toEqual(['b']);
  });

  it('a short interjection does not switch the picture', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(3000);
    a.update({ b: false, c: true });
    vi.advanceTimersByTime(500);
    a.update({ c: false });
    vi.advanceTimersByTime(5000);
    expect(a.value).toBe('b');
    expect(changes).toEqual(['b']);
  });

  it('stays after falling silent; switches once someone else talks 800 ms', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(800);
    a.update({});
    vi.advanceTimersByTime(10_000);
    expect(a.value).toBe('b');
    a.update({ c: true });
    vi.advanceTimersByTime(800);
    expect(a.value).toBe('c');
  });

  it('the current speaker holds the picture at least 1.5 s', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(800); // b active at t=800
    a.update({ c: true }); // c qualifies at t=1600, but b holds until t=2300
    vi.advanceTimersByTime(800);
    expect(a.value).toBe('b');
    vi.advanceTimersByTime(699);
    expect(a.value).toBe('b');
    vi.advanceTimersByTime(1);
    expect(a.value).toBe('c');
    expect(changes).toEqual(['b', 'c']);
  });

  it('a speaker waiting for the hold who falls silent does not take over', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(800);
    a.update({ c: true });
    vi.advanceTimersByTime(900); // qualified, waiting for b's hold
    a.update({});
    vi.advanceTimersByTime(5000);
    expect(a.value).toBe('b');
    expect(changes).toEqual(['b']);
  });

  it('drop() of the active speaker clears it; reset() cancels pending holds', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(800);
    a.drop('b');
    expect(a.value).toBeNull();
    a.update({ c: true });
    a.reset();
    vi.advanceTimersByTime(5000);
    expect(a.value).toBeNull();
  });
});
