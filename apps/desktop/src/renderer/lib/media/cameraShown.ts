/**
 * Which remote cameras are on screen right now (ADR-0066 §4): every mounted camera <video> — a
 * gallery tile of the current page, the large tile, a visible strip tile, the PiP — holds a claim
 * on its participant. The engine subscribes to claimed cameras only (services/voice.ts
 * applyCameras). A released claim lingers RELEASE_MS, so flipping pages back and forth does not
 * churn subscriptions; a new claim within that time cancels the release.
 *
 * Each claim says the layer it needs: `medium` for tiles of a 16+ gallery page (360p cap), `high`
 * otherwise (adaptive stream still picks by element size). A camera claimed by several elements
 * gets the highest one. Changes reach the listener once per microtask (a page flip claims up to
 * 25 tiles in one commit).
 */

export type ShownQuality = 'high' | 'medium';

export const RELEASE_MS = 3000;

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class CameraShown {
  private readonly claims = new Map<string, Map<number, ShownQuality>>();
  /** Released claims still counted until their timer fires. */
  private readonly lingering = new Map<string, { quality: ShownQuality; timer: unknown }>();
  private nextId = 1;
  private queued = false;

  constructor(
    private readonly onChange: () => void,
    private readonly timers: Timers = realTimers,
    private readonly releaseMs = RELEASE_MS,
  ) {}

  /** A camera element for `userId` is on screen; call the returned function when it is gone. */
  claim(userId: string, quality: ShownQuality): () => void {
    const before = this.quality(userId);
    const id = this.nextId++;
    let set = this.claims.get(userId);
    if (!set) this.claims.set(userId, (set = new Map<number, ShownQuality>()));
    set.set(id, quality);
    const linger = this.lingering.get(userId);
    if (linger) {
      this.timers.clearTimeout(linger.timer);
      this.lingering.delete(userId);
    }
    if (this.quality(userId) !== before) this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.claims.get(userId);
      const q = cur?.get(id);
      if (!cur || q === undefined) return;
      const was = this.max(cur);
      cur.delete(id);
      if (cur.size > 0) {
        // Still on screen elsewhere; the layer may drop to what the others need.
        if (this.max(cur) !== was) this.changed();
        return;
      }
      this.claims.delete(userId);
      const timer = this.timers.setTimeout(() => {
        if (this.lingering.get(userId)?.timer !== timer) return;
        this.lingering.delete(userId);
        this.changed();
      }, this.releaseMs);
      this.lingering.set(userId, { quality: was, timer });
    };
  }

  /** The layer `userId` needs, or null when no element shows them (nor did in the last RELEASE_MS). */
  quality(userId: string): ShownQuality | null {
    const set = this.claims.get(userId);
    if (set && set.size > 0) return this.max(set);
    return this.lingering.get(userId)?.quality ?? null;
  }

  /** Everyone claimed or lingering. */
  ids(): Set<string> {
    return new Set([...this.claims.keys(), ...this.lingering.keys()]);
  }

  private max(set: ReadonlyMap<number, ShownQuality>): ShownQuality {
    for (const q of set.values()) if (q === 'high') return 'high';
    return 'medium';
  }

  private changed(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.onChange();
    });
  }
}
