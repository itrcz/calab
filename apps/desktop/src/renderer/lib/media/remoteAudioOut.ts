import { remoteAudio } from '../voiceLogic';

/**
 * Remote audio output (docs/02 «Deafen», echo rules 1–2): one plain <audio> per remote track,
 * WebRTC renders it; playback is only `element.muted` / `element.volume` and the output device
 * only `setSinkId` on the same elements. This class is the ONE place that writes them.
 *
 * Why it owns the elements instead of a fire-and-forget attach: deafen and the per-user volumes
 * must survive everything that touches an element behind our back (issue: a deafened user heard
 * the others when a charger / dock switched the macOS output):
 *  - LiveKit's own device handling: on `devicechange` the Room re-selects the output
 *    (`switchActiveDevice('audiooutput')` → `setSinkId` on our elements) and `Room.startAudio()`
 *    sets `muted = false` on every remote audio element;
 *  - `RemoteAudioTrack.attach()` / `setVolume()` write `muted` / `volume` too;
 *  - Chromium rebuilds the WebRTC audio renderer on a sink switch.
 * So: `apply` runs on every attach, after every sink change (ours or LiveKit's) and whenever an
 * element reports `volumechange` with a state that is not ours.
 */

/**
 * What an output element must look like (a real HTMLMediaElement; a fake in unit tests).
 * `setSinkId` is optional: lib.dom declares it, but engines without per-element output selection
 * (WebKit gates it behind a setting) have no such method — the OS picks the output there.
 */
export type AudioOutElement = Pick<HTMLMediaElement, 'muted' | 'volume' | 'addEventListener' | 'removeEventListener'> &
  Partial<Pick<HTMLMediaElement, 'setSinkId' | 'paused' | 'play' | 'srcObject' | 'error'>>;

/** What one `rebind` pass did. */
export interface RebindResult {
  /** Elements whose stream was detached and attached again. */
  rebound: number;
  /** play() refused without a user gesture (NotAllowedError): the caller offers a tap. */
  blocked: number;
  /**
   * play() failed otherwise or the element reports a media error: the new player found no
   * renderer (its output device was not ready yet). The element's `error` event reaches the
   * owner (`onBroken`), which runs another pass.
   */
  failed: number;
}

/** What one pass of `replayPaused` did. */
export interface ReplayResult {
  /** Paused elements that play again. */
  resumed: number;
  /** play() refused without a user gesture (NotAllowedError): the caller offers a tap. */
  blocked: number;
  /** play() failed otherwise (no source, aborted): left for the next event. */
  failed: number;
}

/** Everything the playback of one element depends on (voice store + prefs). */
export interface AudioOutState {
  deafened: boolean;
  userVolumes: Readonly<Record<string, number>>;
  mutedUsers: Readonly<Record<string, true>>;
  deafUsers?: Readonly<Record<string, true>>;
  streamVolume: Readonly<Record<string, number>>;
  outputVolume?: number;
}

interface Entry<E extends AudioOutElement> {
  sid: string;
  el: E;
  userId: string;
  /** A screen share's system audio (not the voice). */
  stream: boolean;
  guard: () => void;
  /** `error` on the element: the WebRTC renderer died or could not open (see `onBroken`). */
  broken: () => void;
  /**
   * The element's sink ops (setSink, rebind) run one after another: a setSinkId still in flight
   * when a re-bind (or another switch) starts could land last with an older id.
   */
  ops: Promise<void>;
}

/** `volume` values closer than this are equal (the element stores a double as given). */
const EPS = 1e-6;

export class RemoteAudioOut<E extends AudioOutElement = HTMLMediaElement> {
  private readonly els = new Map<string, Entry<E>>();
  private sinkId = '';

  /**
   * `onBroken`: an element fired `error` — Chromium reports a dead or unopenable WebRTC output
   * this way (a render error on the device that went away: MEDIA_ERR_DECODE; a reload whose
   * renderer could not open the device: MEDIA_ERR_SRC_NOT_SUPPORTED). Such an element stays
   * silent and play() cannot revive it; only another `rebind` can. The owner decides when.
   */
  constructor(
    private readonly state: () => AudioOutState,
    private readonly onBroken: (() => void) | null = null,
  ) {}

  has(sid: string): boolean {
    return this.els.has(sid);
  }

  /** The element of a track (the echo detector reads its muted / volume). */
  element(sid: string): E | undefined {
    return this.els.get(sid)?.el;
  }

  get size(): number {
    return this.els.size;
  }

  /**
   * A new remote audio element: playback state first (a deafened user never hears a sample of it),
   * then the output device. Idempotent per track sid.
   */
  add(sid: string, el: E, userId: string, stream: boolean): void {
    if (this.els.has(sid)) return;
    const entry: Entry<E> = {
      sid,
      el,
      userId,
      stream,
      guard: () => this.apply(entry, false),
      broken: () => this.onBroken?.(),
      ops: Promise.resolve(),
    };
    this.els.set(sid, entry);
    // Someone else (LiveKit) wrote muted / volume: put ours back (a no-op when it already matches).
    el.addEventListener('volumechange', entry.guard);
    el.addEventListener('error', entry.broken);
    this.apply(entry, false);
    if (this.sinkId) void this.sink(entry);
  }

  /** The track went away: forget its element (the caller removes it from the DOM). */
  remove(sid: string): E | undefined {
    const entry = this.els.get(sid);
    if (!entry) return undefined;
    entry.el.removeEventListener('volumechange', entry.guard);
    entry.el.removeEventListener('error', entry.broken);
    this.els.delete(sid);
    return entry.el;
  }

  /** Leave: every element is forgotten; returns them for DOM removal. */
  clear(): E[] {
    return [...this.els.keys()].map((sid) => this.remove(sid)).filter((el): el is E => el !== undefined);
  }

  /**
   * The OS switched the audio output (headphones in or out, AirPods, a dock): only people who
   * joined after the switch were heard, the others stayed silent until the room was re-entered
   * (#255, CBF-193). Why a sink write cannot fix it (Chromium, third_party/blink/.../mediastream):
   *  - every remote WebRTC track of the page plays through ONE `WebRtcAudioRenderer`, created by
   *    the first player on that player's sink id and shared by all later ones
   *    (`MediaStreamRendererFactory::GetAudioRenderer`: «Share the existing renderer if any»);
   *  - `setSinkId` with the element's current id resolves without touching the player, and the
   *    renderer's `SwitchOutputDevice` to its current id is a no-op too — a renderer whose output
   *    died with the device stays dead;
   *  - a player whose renderer could not open its device has no audio at all: the element gets
   *    MEDIA_ERR_SRC_NOT_SUPPORTED, play() rejects, a later play() cannot help.
   * So the renderer must be rebuilt: it goes only when its last player stops, i.e. when every
   * remote element has dropped its stream at once. Steps, all elements together:
   *  1. detach every stream (each player stops synchronously; the last one takes the shared
   *     renderer and its output with it) — after the sink ops already queued, so no older
   *     setSinkId lands on the new player;
   *  2. the current sink on each element while it has no player: the next player — and with it
   *     the new renderer — opens on that device directly (no switch on a fresh renderer);
   *  3. attach the same stream again, push the playback state (deafen), play().
   * The element stays the same (echo rule 2). One pass: an element that still fails fires
   * `error`, and the owner (`onBroken`) decides about another pass — no timer here.
   */
  async rebind(): Promise<RebindResult> {
    const out: RebindResult = { rebound: 0, blocked: 0, failed: 0 };
    const entries = [...this.els.values()];
    const run = Promise.all(entries.map((e) => e.ops)).then(async () => {
      // Still ours and with a stream (an element without one has no player to rebuild).
      const live = entries
        .filter((e) => this.els.get(e.sid) === e && e.el.srcObject)
        .map((e) => ({ e, src: e.el.srcObject as MediaProvider }));
      // 1. All players stop in this one synchronous pass: the shared renderer goes with the last.
      for (const { e } of live) e.el.srcObject = null;
      // 2. The sink while there is no player (a gone device rejects: the element keeps its id).
      await Promise.all(
        live.map(async ({ e }) => {
          if (typeof e.el.setSinkId === 'function') await e.el.setSinkId(this.sinkId).catch(() => undefined);
        }),
      );
      // 3. The same stream again, unless something attached a new one meanwhile (LiveKit re-attach).
      await Promise.all(
        live.map(async ({ e, src }) => {
          // The track went away meanwhile: its element is leaving the DOM, it stays detached.
          if (this.els.get(e.sid) !== e) return;
          const { el } = e;
          if (el.srcObject === null) el.srcObject = src;
          out.rebound++;
          this.apply(e, true);
          if (typeof el.play !== 'function') return;
          try {
            await el.play();
            if (el.error) out.failed++;
          } catch (err) {
            if ((err as { name?: unknown } | null)?.name === 'NotAllowedError') out.blocked++;
            else out.failed++;
          }
        }),
      );
    });
    // Sink ops queued meanwhile run after the pass (they read the current sink then).
    const settled = run.catch(() => undefined);
    for (const e of entries) e.ops = settled;
    await run;
    return out;
  }

  /**
   * Plays again every element the system paused behind our back — an audio interruption (another
   * app's music, a video note), the page frozen in the background, a back/forward-cache restore.
   * One play() per paused element and pass, no retry loop: the caller runs a pass on events
   * (page visible, pageshow, Reconnected, a rejoin, an interruption's end). Muted / volume are not
   * touched (deafen stays: a muted element plays silence).
   */
  async replayPaused(): Promise<ReplayResult> {
    const out: ReplayResult = { resumed: 0, blocked: 0, failed: 0 };
    await Promise.all(
      [...this.els.values()].map(async ({ el }) => {
        if (el.paused !== true || typeof el.play !== 'function') return;
        try {
          await el.play();
          out.resumed++;
        } catch (e) {
          if ((e as { name?: unknown } | null)?.name === 'NotAllowedError') out.blocked++;
          else out.failed++;
        }
      }),
    );
    return out;
  }

  /** Deafen / volumes / mutes changed: re-apply to every element. */
  applyAll(): void {
    for (const entry of this.els.values()) this.apply(entry, false);
  }

  /**
   * Output device (echo rule 2: `setSinkId` on the same elements; '' = the system default).
   * Also the re-assert after a device change: whatever the switch did to the renderer, the
   * playback state is pushed again once the sink is in place.
   */
  async setSink(id: string): Promise<void> {
    this.sinkId = id;
    await Promise.all([...this.els.values()].map((entry) => this.sink(entry)));
  }

  /** Runs `op` after the element's earlier sink ops; a failure does not stop the next one. */
  private queue(entry: Entry<E>, op: () => Promise<void>): Promise<void> {
    const run = entry.ops.then(op);
    entry.ops = run.catch(() => undefined);
    return entry.ops;
  }

  /** The current sink (read when the op runs, so a queued older switch never lands last). */
  private sink(entry: Entry<E>): Promise<void> {
    return this.queue(entry, () => this.setSinkNow(entry));
  }

  private async setSinkNow(entry: Entry<E>): Promise<void> {
    // No setSinkId: the element keeps the OS-selected output; the playback state is still re-asserted.
    // A gone device rejects: the element stays where it is (the caller routes a gone choice to
    // the default itself, lib/media/outputRoute).
    if (typeof entry.el.setSinkId === 'function') await entry.el.setSinkId(this.sinkId).catch(() => undefined);
    if (this.els.get(entry.sid) === entry) this.apply(entry, true);
  }

  /**
   * applyAudioState: the one writer of `muted` / `volume`. `force` re-pushes the state to the
   * media player even when the attributes already hold it (after a sink switch the renderer may
   * be new; assigning an unchanged `muted` is a no-op in Chromium, a volume change is not): the
   * volume is nudged and set back — inaudible, and silent anyway while muted.
   */
  private apply(entry: Entry<E>, force: boolean): void {
    const s = this.state();
    const a = remoteAudio({ ...s, stream: entry.stream, userId: entry.userId });
    const { el } = entry;
    if (el.muted !== a.muted) el.muted = a.muted;
    if (Math.abs(el.volume - a.volume) > EPS) el.volume = a.volume;
    else if (force) {
      el.volume = a.volume >= 0.5 ? a.volume - 0.01 : a.volume + 0.01;
      el.volume = a.volume;
    }
  }
}
