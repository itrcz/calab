import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEGRADED_DELAY_MS, PROBE_MAX_MS, ServerHealth, outageStatus } from './health';

describe('ServerHealth (ADR-0166)', () => {
  let hidden = false;
  const onChange = vi.fn();
  const onRecovered = vi.fn();
  const probe = vi.fn();
  const make = (): ServerHealth => new ServerHealth({ onChange, onRecovered, probe, isHidden: () => hidden, random: () => 1 });

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    onChange.mockClear();
    onRecovered.mockClear();
    probe.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('outages: no answer and 502/503/504 only', () => {
    expect([0, 502, 503, 504].every(outageStatus)).toBe(true);
    expect([200, 401, 403, 404, 409, 429, 500].some(outageStatus)).toBe(false);
  });

  it('a blip answered within the delay never shows the banner', () => {
    const h = make();
    h.failed();
    vi.advanceTimersByTime(DEGRADED_DELAY_MS - 1);
    h.ok();
    vi.advanceTimersByTime(DEGRADED_DELAY_MS);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a lasting outage: degraded, probes at a capped backoff, recovers on the first answer', () => {
    const h = make();
    h.failed();
    vi.advanceTimersByTime(DEGRADED_DELAY_MS);
    expect(onChange).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(5000);
    expect(probe).toHaveBeenCalledTimes(1);
    h.failed(); // the probe failed
    for (let i = 0; i < 20; i++) vi.advanceTimersByTime(PROBE_MAX_MS);
    // Never more often than the cap: one per 30 s once backed off.
    expect(probe.mock.calls.length).toBeLessThanOrEqual(25);
    expect(probe.mock.calls.length).toBeGreaterThan(15);
    h.ok();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    const n = probe.mock.calls.length;
    vi.advanceTimersByTime(10 * PROBE_MAX_MS);
    expect(probe.mock.calls.length).toBe(n); // healthy: no probing at all
  });

  it('hidden: no probes until shown again (wake)', () => {
    const h = make();
    h.failed();
    vi.advanceTimersByTime(DEGRADED_DELAY_MS);
    hidden = true;
    vi.advanceTimersByTime(10 * PROBE_MAX_MS);
    expect(probe).not.toHaveBeenCalled();
    hidden = false;
    h.wake();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reset (logout) hides it without a recovery', () => {
    const h = make();
    h.failed();
    vi.advanceTimersByTime(DEGRADED_DELAY_MS);
    h.reset();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(h.isDegraded).toBe(false);
  });
});
