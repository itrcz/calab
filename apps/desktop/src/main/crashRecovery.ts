/**
 * What main does when the app window's renderer dies (Electron-free, unit-tested). Without it a
 * crashed renderer leaves a blank window — and if it dies before `ready-to-show`, no window at all
 * while the process sits in the tray: to a user, «the app crashed». The window is reloaded instead,
 * a bounded number of times, so a renderer that crashes on load cannot spin the CPU forever.
 */

/** `RenderProcessGoneDetails.reason` values that are not a failure: nothing to recover. */
const BENIGN = new Set(['clean-exit']);

/** Reloads allowed within `windowMs`; more crashes than that and the window stays as it is. */
export const RELOADS_MAX = 3;
export const RELOADS_WINDOW_MS = 60_000;

export class RendererCrashBudget {
  private times: number[] = [];

  constructor(
    private readonly max = RELOADS_MAX,
    private readonly windowMs = RELOADS_WINDOW_MS,
  ) {}

  /** Whether a renderer gone for `reason` at `now` should be reloaded (and counts it if so). */
  shouldReload(reason: string, now: number): boolean {
    if (BENIGN.has(reason)) return false;
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

/** One log line's worth of a gone process (render-process-gone / child-process-gone details). */
export function goneDetails(d: { reason?: string; exitCode?: number; type?: string; serviceName?: string; name?: string }): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (d.type) out['type'] = d.type;
  if (d.serviceName) out['service'] = d.serviceName;
  if (d.name) out['name'] = d.name;
  if (d.reason) out['reason'] = d.reason;
  if (typeof d.exitCode === 'number') {
    out['exitCode'] = d.exitCode;
    // Windows reports NTSTATUS codes (0xC0000005 access violation, 0xC0000409 stack buffer overrun…).
    if (d.exitCode < 0 || d.exitCode > 0xffff) out['exitCodeHex'] = `0x${(d.exitCode >>> 0).toString(16).toUpperCase()}`;
  }
  return out;
}
