import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEGRADED_DELAY_MS, PROBE_BASE_MS, PROBE_MAX_MS, RELAPSE_MS, ServerHealth, outageStatus } from './health';

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

  it('a relapse right after a recovery keeps the backoff; a minute of health starts it afresh', () => {
    const h = make();
    const degrade = (): void => {
      h.failed();
      vi.advanceTimersByTime(DEGRADED_DELAY_MS);
    };
    degrade();
    vi.advanceTimersByTime(PROBE_BASE_MS); // probe 1 (5 s)
    h.failed();
    vi.advanceTimersByTime(2 * PROBE_BASE_MS); // probe 2 (10 s)
    expect(probe).toHaveBeenCalledTimes(2);
    h.ok(); // the probe answered: recovered, its reloads go out…
    expect(onRecovered).toHaveBeenCalledTimes(1);
    degrade(); // …and time out: a relapse
    probe.mockClear();
    vi.advanceTimersByTime(PROBE_MAX_MS - 1); // not at 5 s, not at 10 s
    expect(probe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // the backoff went on (5, 10, 20 → capped): 30 s
    expect(probe).toHaveBeenCalledTimes(1);
    h.ok();
    expect(onRecovered).toHaveBeenCalledTimes(2);
    // Healthy for a minute: the next outage probes at 5 s again.
    vi.advanceTimersByTime(RELAPSE_MS);
    degrade();
    probe.mockClear();
    vi.advanceTimersByTime(PROBE_BASE_MS);
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
