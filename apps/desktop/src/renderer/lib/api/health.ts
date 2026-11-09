/**
 * «Нет связи с сервером — восстанавливаем…» for the REST side (ADR-0166). A database stall
 * leaves the gateway socket up (the server keeps it), so only API answers tell the client the
 * server cannot serve it: network errors and 502/503/504. Pure (timers, clock and the probe are
 * injected) and cheap: a few timers while degraded, nothing otherwise; a hidden window does not
 * probe (CPU rules, docs/14) — wake() on focus / `online` resumes.
 *
 * - degraded after the first failure that no success follows within DEGRADED_DELAY_MS;
 * - while degraded: one probe request (GET /api/me) at a capped backoff with jitter, 5 s → 30 s;
 * - any answer below 500 (the probe or any other request) ends it: onChange(false), onRecovered();
 * - degraded again within RELAPSE_MS of a recovery (a partial stall: the probe answers, the
 *   reloads it triggers time out), the backoff goes on where it was instead of starting at 5 s —
 *   each recovery re-issues every failed load, and a flapping server must not get them every 8 s.
 */

export const DEGRADED_DELAY_MS = 3000;
export const PROBE_BASE_MS = 5000;
export const PROBE_MAX_MS = 30_000;
export const RELAPSE_MS = 60_000;

export interface HealthTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HealthDeps {
  onChange(degraded: boolean): void;
  onRecovered(): void;
  probe(): void;
  isHidden(): boolean;
  timers?: HealthTimers;
  random?: () => number;
}

const realTimers: HealthTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Network error (status 0) or the server/proxy could not serve now: an outage, not an answer. */
export function outageStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export class ServerHealth {
  private degraded = false;
  private failing = false;
  private delayTimer: unknown = null;
  private probeTimer: unknown = null;
  private relapseTimer: unknown = null;
  private probes = 0;
  private readonly timers: HealthTimers;
  private readonly rnd: () => number;

  constructor(private readonly deps: HealthDeps) {
    this.timers = deps.timers ?? realTimers;
    this.rnd = deps.random ?? Math.random;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  /** An API request got no answer, or 502/503/504. */
  failed(): void {
    if (this.degraded) {
      this.scheduleProbe(); // the probe itself failed: next one later
      return;
    }
    if (this.failing) return;
    this.failing = true;
    this.delayTimer = this.timers.setTimeout(() => {
      this.delayTimer = null;
      if (!this.failing) return;
      this.degraded = true;
      // probes: 0 unless this is a relapse within RELAPSE_MS (the backoff then goes on).
      this.clearRelapse();
      this.deps.onChange(true);
      this.scheduleProbe();
    }, DEGRADED_DELAY_MS);
  }

  /** An API request got an answer below 500. */
  ok(): void {
    this.failing = false;
    if (this.delayTimer !== null) this.timers.clearTimeout(this.delayTimer);
    this.delayTimer = null;
    if (!this.degraded) return;
    this.degraded = false;
    this.clearProbe();
    this.clearRelapse();
    this.relapseTimer = this.timers.setTimeout(() => {
      this.relapseTimer = null;
      this.probes = 0; // healthy for RELAPSE_MS: the next outage starts the backoff afresh
    }, RELAPSE_MS);
    this.deps.onChange(false);
    this.deps.onRecovered();
  }

  /** The window is shown again / the network is back: probe at once while degraded. */
  wake(): void {
    if (!this.degraded) return;
    this.clearProbe();
    this.probes = 0;
    this.deps.probe();
    this.scheduleProbe();
  }

  /** Logout / a new account: forget everything. */
  reset(): void {
    const was = this.degraded;
    this.failing = false;
    this.degraded = false;
    if (this.delayTimer !== null) this.timers.clearTimeout(this.delayTimer);
    this.delayTimer = null;
    this.clearProbe();
    this.clearRelapse();
    this.probes = 0;
    if (was) this.deps.onChange(false);
  }

  private clearRelapse(): void {
    if (this.relapseTimer !== null) this.timers.clearTimeout(this.relapseTimer);
    this.relapseTimer = null;
  }

  private clearProbe(): void {
    if (this.probeTimer !== null) this.timers.clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }

  private scheduleProbe(): void {
    if (this.probeTimer !== null) return;
    const base = Math.min(PROBE_MAX_MS, PROBE_BASE_MS * 2 ** this.probes);
    this.probes++;
    const delay = Math.round(base * (0.5 + this.rnd() * 0.5));
    this.probeTimer = this.timers.setTimeout(() => {
      this.probeTimer = null;
      if (!this.degraded) return;
      // Hidden: no probe (wake() on show resumes); any request the app makes still counts.
      if (this.deps.isHidden()) return;
      this.deps.probe();
      this.scheduleProbe(); // a probe that never settles must not end the probing
    }, delay);
  }
}
