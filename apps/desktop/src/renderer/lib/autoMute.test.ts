import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_MUTE_DEFAULT, AutoMuteTimer, autoMuteArmed, normalizeAutoMute, type AutoMuteArmInput } from './autoMute';
import type { Timers } from './speaking';

const timers: Timers = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (id) => clearTimeout(id) };

const base: AutoMuteArmInput = { live: true, mode: 'voice', muted: false, deafened: false, serverMuted: false, canSpeak: true };

describe('autoMuteArmed', () => {
  it('arms only a live, open mic in voice activation', () => {
    expect(autoMuteArmed(base)).toBe(true);
    expect(autoMuteArmed({ ...base, live: false })).toBe(false);
    expect(autoMuteArmed({ ...base, mode: 'ptt' })).toBe(false);
    expect(autoMuteArmed({ ...base, muted: true })).toBe(false);
    expect(autoMuteArmed({ ...base, deafened: true })).toBe(false);
    expect(autoMuteArmed({ ...base, serverMuted: true })).toBe(false);
    expect(autoMuteArmed({ ...base, canSpeak: false })).toBe(false);
  });
});

describe('normalizeAutoMute', () => {
  it('is off by default and keeps only the offered options', () => {
    expect(AUTO_MUTE_DEFAULT).toBe(0);
    expect(normalizeAutoMute(undefined)).toBe(0);
    expect(normalizeAutoMute(45)).toBe(0);
    expect(normalizeAutoMute('300')).toBe(0);
    for (const v of [0, 30, 60, 300, 600]) expect(normalizeAutoMute(v)).toBe(v);
  });
});

describe('AutoMuteTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (): { t: AutoMuteTimer; fired: number[] } => {
    const fired: number[] = [];
    return { t: new AutoMuteTimer((s) => fired.push(s), timers), fired };
  };

  it('fires once after the full period of silence', () => {
    const { t, fired } = make();
    t.update(true, false, 30);
    vi.advanceTimersByTime(29_999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([30]);
    expect(t.running).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(fired).toEqual([30]);
  });

  it('repeated silent updates keep counting (no restart on every call)', () => {
    const { t, fired } = make();
    t.update(true, false, 60);
    vi.advanceTimersByTime(40_000);
    t.update(true, false, 60);
    vi.advanceTimersByTime(20_000);
    expect(fired).toEqual([60]);
  });

  it('speech resets: the period starts again when the silence comes back', () => {
    const { t, fired } = make();
    t.update(true, false, 30);
    vi.advanceTimersByTime(25_000);
    t.update(true, true, 30);
    expect(t.running).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    t.update(true, false, 30);
    vi.advanceTimersByTime(29_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([30]);
  });

  it('does not start when disarmed (PTT, muted, not in voice) or off', () => {
    const { t, fired } = make();
    t.update(false, false, 30);
    t.update(true, false, 0);
    expect(t.running).toBe(false);
    vi.advanceTimersByTime(700_000);
    expect(fired).toEqual([]);
  });

  it('cancels on leave / mute / setting off', () => {
    const { t, fired } = make();
    t.update(true, false, 30);
    t.update(false, false, 30); // muted or left
    t.update(true, false, 30);
    t.cancel(); // teardown
    t.update(true, false, 30);
    t.update(true, false, 0); // setting off
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('a new period restarts the countdown', () => {
    const { t, fired } = make();
    t.update(true, false, 30);
    vi.advanceTimersByTime(20_000);
    t.update(true, false, 300);
    vi.advanceTimersByTime(20_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(280_000);
    expect(fired).toEqual([300]);
  });
});
