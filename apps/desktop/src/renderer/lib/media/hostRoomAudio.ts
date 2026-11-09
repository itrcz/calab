import { audioUUID } from '../../../shared/hostCallAudio';
import {
  ROOM_AUDIO_MAX_LEVEL,
  ROOM_AUDIO_MAX_USERS,
  ROOM_AUDIO_MAX_WATCHED,
  ROOM_AUDIO_MIN_THRESHOLD_DB,
  type HostRoomAudioCapability,
  type HostRoomAudioConnect,
  type HostRoomAudioControls,
  type HostRoomAudioCue,
  type HostRoomAudioState,
  type HostRoomAudioStatus,
} from '../../../shared/hostRoomAudio';

/**
 * One native-audio room join (ADR-0149 §1), like HostCallAudioSession for calls: a connection id,
 * its states only, its controls. A late native callback can never adopt a newer join.
 */

/** Native's own connect deadline is 15 s (CalabRoomAudio.swift): its outcome is waited for this long. */
export const ROOM_AUDIO_SETTLE_MS = 20_000;
/** Controls go out at most this often (native allows 10 operations a second, cues included); the latest always goes. */
export const ROOM_CONTROL_GAP_MS = 150;
/** A refused control (the rate limit) is sent again after this, if nothing newer went meanwhile. */
export const ROOM_CONTROL_RETRY_MS = 500;
/** Native turns meter levels off 30 s after they were turned on (CalabRoomAudio.swift): a shown meter asks again before that. */
export const ROOM_LEVELS_REFRESH_MS = 25_000;
/** The terminal phases: native reports them only once nothing holds audio any more (drained). */
const TERMINAL: readonly string[] = ['ended', 'failed', 'lost'];
/** Native could not, the web path may: only these let a join fall back (before capture, drained). */
const FALLBACK_ERRORS: readonly string[] = ['connection', 'audio'];

const terminal = (s: HostRoomAudioState): boolean => TERMINAL.includes(s.phase);
/** In the room: connected with the microphone published (a speaker), or held by the system (a call, Siri). */
const ready = (s: HostRoomAudioState): boolean => s.phase === 'interrupted' || (s.phase === 'connected' && (!s.canSpeak || s.microphoneReady));

/**
 * The join could not start natively. `fallback`: native reported a drained end (or never began),
 * never had the microphone and failed for a reason the web path may not share — the caller may
 * take the join over on the web path, once and in foreground (ADR-0149 §1).
 */
export class HostRoomAudioUnavailable extends Error {
  constructor(
    readonly reason: NonNullable<HostRoomAudioState['error']> | 'unknown',
    readonly fallback: boolean,
  ) {
    super(`Native room audio unavailable: ${reason}`);
    this.name = reason === 'permission' ? 'NotAllowedError' : 'HostRoomAudioUnavailable';
  }
}

export class HostRoomAudioSession {
  private closed = false;
  private started = false;
  private readonly unsubscribe: () => void;
  private input: HostRoomAudioConnect | null;
  readonly connectionId: string;
  state: HostRoomAudioState | null = null;
  /** Native had the microphone of this join at least once: no fallback from then on. */
  private hadMic = false;
  private settle: ((state: HostRoomAudioState) => void) | null = null;
  private latest: HostRoomAudioControls;
  private sent = '';
  private lastSend = -Infinity;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly capability: HostRoomAudioCapability,
    input: HostRoomAudioConnect,
    private readonly changed: (state: HostRoomAudioState) => void,
  ) {
    this.input = input;
    this.connectionId = input.connectionId;
    this.latest = input.controls;
    this.sent = JSON.stringify(input.controls);
    this.unsubscribe = capability.subscribe((state) => this.receive(state));
  }

  /** In the room (a system interruption keeps the seat and the link). */
  get connected(): boolean {
    return !this.closed && this.started && this.state !== null && (this.state.phase === 'connected' || this.state.phase === 'interrupted');
  }

  get alive(): boolean {
    return !this.closed && !(this.state && terminal(this.state));
  }

  /** Native gave the connection up (ADR-0149 §7): the page rejoins in foreground. */
  get lost(): boolean {
    return !this.closed && this.state?.phase === 'lost';
  }

  /** Read through a call: `closed` changes across the awaits of start(). */
  private stopped(): boolean {
    return this.closed;
  }

  private receive(state: HostRoomAudioState): void {
    if (this.closed || state.connectionId !== this.connectionId) return;
    if (state.microphoneReady) this.hadMic = true;
    this.state = state;
    if (this.started) this.changed(state);
    else this.settle?.(state);
  }

  /** Resolves once native is in the room; throws HostRoomAudioUnavailable otherwise (and holds nothing then). */
  async start(): Promise<void> {
    const input = this.input;
    this.input = null;
    if (!input || this.closed) throw new HostRoomAudioUnavailable('superseded', false);
    let resolve!: (state: HostRoomAudioState | null) => void;
    const outcome = new Promise<HostRoomAudioState | null>((r) => (resolve = r));
    this.settle = (s) => {
      if (ready(s) || terminal(s)) resolve(s);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The bridge bounds the reply itself; the settle wait starts after it (a microphone prompt can take a while).
      const reply = await this.capability.connect(input).catch((): HostRoomAudioStatus => ({ supported: true, failed: true }));
      timer = setTimeout(() => resolve(null), ROOM_AUDIO_SETTLE_MS);
      if (this.stopped()) throw new HostRoomAudioUnavailable('superseded', false);
      // No module behind the capability: nothing was started, nothing is held.
      if (!reply.supported) throw new HostRoomAudioUnavailable('connection', true);
      if (reply.media) this.receive(reply.media);
      if (reply.failed && !(this.state && (ready(this.state) || terminal(this.state)))) {
        // Native state unknown (ADR-0149 §2): ask once. Another connection's end, or none, means
        // this one never began there (a refused host, the rate limit).
        const now = await this.capability.status().catch((): HostRoomAudioStatus => ({ supported: true, failed: true }));
        if (this.stopped()) throw new HostRoomAudioUnavailable('superseded', false);
        if (now.media) this.receive(now.media);
        const began = now.media?.connectionId === this.connectionId;
        if (!now.failed && now.supported && !began && (!now.media || terminal(now.media))) throw new HostRoomAudioUnavailable('connection', true);
      }
      const end = await outcome;
      if (this.stopped()) throw new HostRoomAudioUnavailable('superseded', false);
      if (!end) throw new HostRoomAudioUnavailable('unknown', false);
      if (terminal(end)) {
        const reason = end.error ?? 'connection';
        throw new HostRoomAudioUnavailable(reason, end.phase !== 'lost' && !this.hadMic && FALLBACK_ERRORS.includes(reason));
      }
      this.started = true;
      this.settle = null;
      this.schedule();
    } catch (e) {
      this.stop();
      throw e;
    } finally {
      clearTimeout(timer);
      this.settle = null;
    }
  }

  /** The complete controls (never a patch): coalesced, deduplicated, the latest always reaches native. */
  control(controls: HostRoomAudioControls): void {
    if (this.closed) return;
    this.latest = controls;
    this.schedule();
  }

  /**
   * The latest controls again even when unchanged: native acts on receipt (a microphone held muted
   * after a phone call is released by a control with `muted: true`, CalabRoomAudio.swift), not on a change.
   */
  resend(): void {
    if (this.closed) return;
    this.sent = '';
    this.schedule();
  }

  /**
   * Native turns levels off by itself 30 s after they were turned on, and only an off→on edge turns
   * them on again (CalabRoomAudio.swift): levels off now, the latest (levels on) right after.
   */
  refreshLevels(): void {
    if (this.closed || !this.started || !this.latest.levels) return;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.send({ ...this.latest, levels: false });
    this.schedule();
  }

  private schedule(): void {
    if (!this.started || this.flushTimer !== null) return;
    const wait = this.lastSend + ROOM_CONTROL_GAP_MS - performance.now();
    if (wait > 0) this.flushTimer = setTimeout(() => this.flush(), wait);
    else this.flush();
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.closed || JSON.stringify(this.latest) === this.sent) return;
    this.send(this.latest);
  }

  private send(controls: HostRoomAudioControls): void {
    const body = JSON.stringify(controls);
    this.sent = body;
    this.lastSend = performance.now();
    void this.capability.control(this.connectionId, controls).then((ok) => {
      if (ok || this.closed) return;
      // Refused: native may still hold an older state, so the next flush must not skip this one.
      if (this.sent === body) this.sent = '';
      this.flushTimer ??= setTimeout(() => this.flush(), ROOM_CONTROL_RETRY_MS);
    });
  }

  cue(cue: HostRoomAudioCue, volume: number): void {
    if (this.connected) this.capability.cue(this.connectionId, cue, Math.max(0, Math.min(1, volume)));
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.input = null;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.unsubscribe();
    this.capability.disconnect(this.connectionId);
  }
}

const unit = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

export interface RoomControlsInput {
  muted: boolean;
  deafened: boolean;
  /** Everyone's voice (the master volume), 0–1. */
  outputVolume: number;
  /** Final per-user voice volumes (master applied, 0 for a muted person): only the ones that differ from the master go. */
  users: readonly { id: string; volume: number }[];
  bitrateKbps: number;
  mode: 'voice' | 'ptt';
  thresholdDb: number;
  pttOpen: boolean;
  levels: boolean;
  /** The watched streams' publishers (user ids) with the final volume of their screen-share audio (ADR-0149 §3). */
  watched?: readonly { id: string; volume: number }[];
}

/**
 * Controls the bridge accepts (shared/hostRoomAudio.ts): every volume clamped to 0–1 as
 * nativeControls() does for calls — one value above 1 would drop the whole control — at most 64
 * users, bitrate 8–64 kbps, the gate threshold inside the meter range, at most 4 watched
 * publishers (native subscribes their screen-share audio, ADR-0149 §3).
 */
export function roomAudioControls(i: RoomControlsInput): HostRoomAudioControls {
  const volume = unit(i.outputVolume);
  const userVolumes: Record<string, number> = {};
  let n = 0;
  for (const u of i.users) {
    if (n >= ROOM_AUDIO_MAX_USERS) break;
    const id = u.id.toLowerCase();
    if (!audioUUID(id) || id in userVolumes) continue;
    const v = unit(u.volume);
    if (v === volume) continue;
    userVolumes[id] = v;
    n++;
  }
  const watched: Record<string, number> = {};
  for (const w of i.watched ?? []) {
    if (Object.keys(watched).length >= ROOM_AUDIO_MAX_WATCHED) break;
    const id = w.id.toLowerCase();
    if (audioUUID(id) && !(id in watched)) watched[id] = unit(w.volume);
  }
  const kbps = Number.isFinite(i.bitrateKbps) ? Math.round(Math.max(8, Math.min(64, i.bitrateKbps))) : 32;
  const thresholdDb = Number.isFinite(i.thresholdDb) ? Math.max(ROOM_AUDIO_MIN_THRESHOLD_DB, Math.min(0, i.thresholdDb)) : -50;
  return {
    muted: i.muted,
    deafened: i.deafened,
    volume,
    userVolumes,
    bitrate: kbps * 1000,
    gate: { mode: i.mode, thresholdDb, pttOpen: i.pttOpen },
    watched,
    levels: i.levels,
  };
}

/** Native's 21-step meter (CalabVoiceGate.level) back to dBFS on the renderer's -80…0 scale. */
export function roomLevelDb(level: number): number {
  return ROOM_AUDIO_MIN_THRESHOLD_DB + (Math.max(0, Math.min(ROOM_AUDIO_MAX_LEVEL, level)) * -ROOM_AUDIO_MIN_THRESHOLD_DB) / ROOM_AUDIO_MAX_LEVEL;
}
