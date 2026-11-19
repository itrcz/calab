/**
 * «Speaking but silent» self-heal (docs/02 «Тихий собеседник»): a remote participant is speaking
 * (server active speakers or the receiver's RFC 6464 level) while their subscribed mic plays
 * nothing here — the SFU stopped forwarding to us, or our player stopped pulling. Checked only when
 * someone starts speaking (one baseline + one one-shot timer per mic), never by a permanent timer
 * (docs/14-energy.md). Steps per mic publication, bounded: re-attach the element, then resubscribe,
 * then give up (logged) — never a rejoin.
 */

/** How long a speaking mic is watched before its counters are compared. */
export const SILENT_CHECK_MS = 3_000;
/** A mic found healthy is not probed again for this long (talk is a stream of speaking events). */
export const SILENT_OK_COOLDOWN_MS = 30_000;
/** Element re-attaches per mic publication and connection before a resubscribe. */
export const SILENT_REATTACHES = 1;
/** Resubscriptions (setSubscribed false → true) per mic publication and connection. */
export const SILENT_RESUBSCRIBES = 2;

/** One mic's receive side at a moment (its receiver's inbound-rtp and our element). */
export interface VoiceFlow {
  /** inbound-rtp `packetsReceived`: the SFU forwards to us. */
  packets: number;
  /**
   * inbound-rtp `totalSamplesReceived` (concealed samples included): grows while a player pulls
   * the track's audio out of the jitter buffer; null where the engine does not report it.
   */
  samples: number | null;
  /** Our <audio> holds this very track and is not paused. */
  bound: boolean;
}

export type SilentStep = 'reattach' | 'resubscribe' | 'give-up';
export type SilentVerdict = 'ok' | SilentStep;

/**
 * Over a window in which the participant spoke: packets arrived, the player pulled samples and the
 * element holds the track → fine. Otherwise the next step of the budget: a re-attach (a stale or
 * dead player, a paused element), then a resubscription (a new downtrack and track from the SFU).
 */
export function silentVerdict(before: VoiceFlow, after: VoiceFlow, spent: { reattaches: number; resubscribes: number }): SilentVerdict {
  const received = after.packets > before.packets;
  const played = before.samples === null || after.samples === null || after.samples > before.samples;
  if (received && played && after.bound) return 'ok';
  if (spent.reattaches < SILENT_REATTACHES) return 'reattach';
  if (spent.resubscribes < SILENT_RESUBSCRIBES) return 'resubscribe';
  return 'give-up';
}

export interface SilentVoiceDeps {
  /** The mic's flow now; null = nothing to measure (no track / receiver / stats): nothing is done. */
  probe(sid: string): Promise<VoiceFlow | null>;
  /** The mic's owner still speaks (the check is only meaningful while they do). */
  speaking(sid: string): boolean;
  act(sid: string, step: SilentStep, why: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

interface MicWatch {
  /** A check is armed or in flight (a burst of speaking events arms one). */
  busy: boolean;
  /** The one-shot timer of the current step; null between them. */
  timer: unknown;
  /** Bumped on every arm / reset: a probe that resolves for an older one is dropped. */
  gen: number;
  reattaches: number;
  resubscribes: number;
  okUntil: number;
  gaveUp: boolean;
}

export class SilentVoiceWatch {
  private readonly mics = new Map<string, MicWatch>();

  constructor(private readonly deps: SilentVoiceDeps) {}

  /** The mic's owner started speaking: take a baseline and look again after SILENT_CHECK_MS. */
  onSpeaking(sid: string): void {
    const w = this.mic(sid);
    if (w.busy || w.gaveUp || this.deps.now() < w.okUntil) return;
    void this.arm(sid, w, 0);
  }

  /** Leave / rejoin / a new room: every budget and timer goes. */
  reset(): void {
    for (const w of this.mics.values()) if (w.timer !== null) this.deps.clearTimeout(w.timer);
    this.mics.clear();
  }

  /** Watching this mic now (tests, logs). */
  pending(sid: string): boolean {
    return this.mics.get(sid)?.busy ?? false;
  }

  private mic(sid: string): MicWatch {
    let w = this.mics.get(sid);
    if (!w) {
      w = { busy: false, timer: null, gen: 0, reattaches: 0, resubscribes: 0, okUntil: 0, gaveUp: false };
      this.mics.set(sid, w);
    }
    return w;
  }

  /** `delay`: after a step the new player / subscription gets that long before the baseline. */
  private async arm(sid: string, w: MicWatch, delay: number): Promise<void> {
    const gen = ++w.gen;
    w.busy = true;
    if (delay > 0) w.timer = this.deps.setTimeout(() => void this.baseline(sid, w, gen), delay);
    else await this.baseline(sid, w, gen);
  }

  private idle(w: MicWatch): void {
    w.busy = false;
    w.timer = null;
  }

  private async baseline(sid: string, w: MicWatch, gen: number): Promise<void> {
    if (this.mics.get(sid) !== w || w.gen !== gen) return;
    w.timer = null;
    if (!this.deps.speaking(sid)) {
      this.idle(w);
      return;
    }
    const before = await this.deps.probe(sid);
    if (this.mics.get(sid) !== w || w.gen !== gen) return;
    if (!before) {
      this.idle(w);
      return;
    }
    w.timer = this.deps.setTimeout(() => void this.check(sid, w, gen, before), SILENT_CHECK_MS);
  }

  private async check(sid: string, w: MicWatch, gen: number, before: VoiceFlow): Promise<void> {
    if (this.mics.get(sid) !== w || w.gen !== gen) return;
    w.timer = null;
    // Stopped speaking within the window: no verdict (silence proves nothing); the next start re-arms.
    if (!this.deps.speaking(sid)) {
      this.idle(w);
      return;
    }
    const after = await this.deps.probe(sid);
    if (this.mics.get(sid) !== w || w.gen !== gen) return;
    this.idle(w);
    if (!after) return;
    const verdict = silentVerdict(before, after, w);
    if (verdict === 'ok') {
      w.reattaches = 0;
      w.resubscribes = 0;
      w.okUntil = this.deps.now() + SILENT_OK_COOLDOWN_MS;
      return;
    }
    const why = `packets ${before.packets}→${after.packets}, samples ${before.samples ?? '?'}→${after.samples ?? '?'}, ${after.bound ? 'bound' : 'not bound'}`;
    if (verdict === 'reattach') w.reattaches++;
    else if (verdict === 'resubscribe') w.resubscribes++;
    else w.gaveUp = true;
    this.deps.act(sid, verdict, why);
    // Verify the step while they keep speaking (bounded by the budget above).
    if (verdict !== 'give-up') void this.arm(sid, w, SILENT_CHECK_MS);
  }
}
