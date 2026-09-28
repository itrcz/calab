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

/** What an output element must look like (a real HTMLMediaElement; a fake in unit tests). */
export type AudioOutElement = Pick<HTMLMediaElement, 'muted' | 'volume' | 'setSinkId' | 'addEventListener' | 'removeEventListener'>;

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
}

/** `volume` values closer than this are equal (the element stores a double as given). */
const EPS = 1e-6;

export class RemoteAudioOut<E extends AudioOutElement = HTMLMediaElement> {
  private readonly els = new Map<string, Entry<E>>();
  private sinkId = '';

  constructor(private readonly state: () => AudioOutState) {}

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
    const entry: Entry<E> = { sid, el, userId, stream, guard: () => this.apply(entry, false) };
    this.els.set(sid, entry);
    // Someone else (LiveKit) wrote muted / volume: put ours back (a no-op when it already matches).
    el.addEventListener('volumechange', entry.guard);
    this.apply(entry, false);
    if (this.sinkId) void this.sink(entry, this.sinkId);
  }

  /** The track went away: forget its element (the caller removes it from the DOM). */
  remove(sid: string): E | undefined {
    const entry = this.els.get(sid);
    if (!entry) return undefined;
    entry.el.removeEventListener('volumechange', entry.guard);
    this.els.delete(sid);
    return entry.el;
  }

  /** Leave: every element is forgotten; returns them for DOM removal. */
  clear(): E[] {
    return [...this.els.keys()].map((sid) => this.remove(sid)).filter((el): el is E => el !== undefined);
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
    await Promise.all([...this.els.values()].map((entry) => this.sink(entry, id)));
  }

  private async sink(entry: Entry<E>, id: string): Promise<void> {
    // A gone device rejects: the element stays on what it plays to now (Chromium falls back to the default).
    await entry.el.setSinkId(id).catch(() => undefined);
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
