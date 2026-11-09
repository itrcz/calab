import { DisconnectReason, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';

/**
 * The companion connection (ADR-0149 §3): on an iPhone whose room audio is native, the page keeps a
 * second, subscribe-only LiveKit connection `<user>:<session>:web` for the cameras, the screen
 * shares and the data topics (stream watch, annotations). It never subscribes an audio kind — the
 * WebView stays silent (docs/02, echo rules): the watched stream's own audio is native's.
 *
 * Lazy: connected only in foreground while someone in the room has a camera or a screen share on
 * (the data topics only serve a screen share), closed 30 s after none and at once in background.
 * It belongs to the device's seat and never is one: no seat is created, changed or left here — a
 * 409 (no seat in that room, e.g. right after a move) is asked again, the seat ending is voice's.
 */

/** LiveKit data topic for "who watches my stream" (docs/05: data channels only for in-call ephemera). */
export const WATCH_TOPIC = 'calaba.watch';

/** The companion closes this long after the last camera or screen share in the room went. */
export const COMPANION_IDLE_MS = 30_000;
/** Waits before asking again after a failure (409 no seat yet, 503, a lost link), last one repeats. */
export const COMPANION_RETRY_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000];
/** Failures in a row before the companion gives up for this join (video unavailable, said in the UI). */
export const COMPANION_MAX_FAILURES = 6;
/** A link that stayed up this long clears the failure count (one removed right after its join does not). */
export const COMPANION_STABLE_MS = 30_000;

/** A web companion identity `<user>:<session>:web` (server voice.CompanionIdentity): never a person of its own. */
export function isCompanionIdentity(identity: string): boolean {
  return identity.endsWith(':web');
}

/**
 * Whether `identity` is its person's only connection among `present` (identities in the room):
 * false for a companion and for a second device of a user who is already there, so «join» and
 * «leave» follow the person, not each connection.
 */
export function isSoleConnection(identity: string, present: Iterable<string>): boolean {
  if (isCompanionIdentity(identity)) return false;
  const user = identity.split(':')[0];
  for (const other of present) {
    if (other !== identity && !isCompanionIdentity(other) && other.split(':')[0] === user) return false;
  }
  return true;
}

/** The device identity `<user>:<session>` a companion belongs to, or null for any other identity. */
export function companionDevice(identity: string): string | null {
  return isCompanionIdentity(identity) ? identity.slice(0, -':web'.length) : null;
}

/** What voice wants from the companion now. */
export interface CompanionWant {
  /** The native-audio join (a new one starts over: tries, a superseded or given-up state); null = none. */
  join: string | null;
  /** The voice room of that join (it changes on a move: a new companion for the new room). */
  roomId: string | null;
  /** Someone in the room has a camera or a screen share on. */
  needed: boolean;
  /** The page is in foreground. */
  visible: boolean;
}

export type CompanionPhase = 'off' | 'connecting' | 'connected' | 'superseded' | 'down';

/** Why an attached Room went: `hidden` = the page went to background (it comes back in foreground). */
export type CompanionDetach = 'hidden' | 'idle' | 'gone';

export interface CompanionHooks {
  /** The Room is connected and ours: voice wires its video and data events and shows what it has. */
  attach(room: Room): void;
  /** The attached Room went: voice drops what it showed from it. */
  detach(room: Room, why: CompanionDetach): void;
  /** Video is unavailable for this join (true) or may come again (false). */
  down(on: boolean): void;
  /** A newer companion of this session took over: nothing comes from this one any more. */
  superseded(): void;
}

export interface CompanionDeps {
  token(roomId: string): Promise<{ url: string; token: string }>;
  makeRoom(): Room;
}

const defaultDeps: CompanionDeps = {
  token: (roomId) => api.voice.companion(roomId),
  makeRoom: () =>
    new Room({
      adaptiveStream: true,
      dynacast: false, // publishes nothing
      webAudioMix: false, // echo rule 1; there is no remote audio here anyway
      disconnectOnPageLeave: true,
    }),
};

/** 403 (rights, a denied session), 404 (a one-to-one call), 422 (not a voice room): asking again changes nothing. */
const final = (e: unknown): boolean => e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 422);

export class VoiceCompanion {
  private want: CompanionWant = { join: null, roomId: null, needed: false, visible: false };
  /** The connected Room handed to voice (attach), or null. */
  private live: Room | null = null;
  /** A Room still connecting. */
  private pending: Room | null = null;
  /** Bumped by every start and close: an older start's awaits find it changed and stop. */
  private gen = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The live link has stayed up COMPANION_STABLE_MS when this fires: the failures are forgiven then. */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** A start() is asking for its token (before a Room exists): no second one meanwhile. */
  private starting = false;
  private failures = 0;
  /** A newer companion of this session took the identity (DUPLICATE_IDENTITY): off until a new join. */
  private superseded = false;
  /** Given up for this join (a final refusal, or too many failures). */
  private gaveUp = false;

  constructor(
    private readonly hooks: CompanionHooks,
    private readonly deps: CompanionDeps = defaultDeps,
  ) {}

  /** The connected companion Room, or null. */
  get room(): Room | null {
    return this.live;
  }

  get phase(): CompanionPhase {
    if (this.live) return 'connected';
    if (this.starting || this.pending || this.retryTimer) return 'connecting';
    if (this.superseded) return 'superseded';
    if (this.gaveUp) return 'down';
    return 'off';
  }

  /** Voice's wish changed (cameras, screens, visibility, the room, the join): connect, wait or close. */
  sync(want: CompanionWant): void {
    const prev = this.want;
    this.want = want;
    if (want.join !== prev.join || want.roomId !== prev.roomId) {
      // Another join or room: whatever was there belonged to the old one.
      this.close('gone');
      this.failures = 0;
      this.superseded = false;
      if (this.gaveUp) {
        this.gaveUp = false;
        this.hooks.down(false);
      }
    }
    if (!want.join || !want.roomId) return;
    if (!want.visible) {
      this.close('hidden');
      return;
    }
    if (!want.needed) {
      this.cancelRetry();
      if ((this.live || this.pending) && this.idleTimer === null) this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.close('idle');
      }, COMPANION_IDLE_MS);
      return;
    }
    this.cancelIdle();
    if (this.live || this.starting || this.pending || this.retryTimer || this.superseded || this.gaveUp) return;
    void this.start();
  }

  /** Off now (the join ended): nothing is left connected or scheduled. */
  stop(): void {
    this.sync({ join: null, roomId: null, needed: false, visible: false });
  }

  private wanted(): boolean {
    const w = this.want;
    return !!w.join && !!w.roomId && w.visible && w.needed && !this.superseded && !this.gaveUp;
  }

  private async start(): Promise<void> {
    const gen = ++this.gen;
    const roomId = this.want.roomId;
    if (!roomId) return;
    let grant: { url: string; token: string };
    this.starting = true;
    try {
      // A fresh token for every connect: it lives 10 min, LiveKit refreshes it once connected.
      grant = await this.deps.token(roomId);
    } catch (e) {
      if (gen === this.gen) this.starting = false;
      if (gen !== this.gen) return;
      if (final(e)) {
        log.info(`voice companion: refused (${(e as ApiError).status}), no video in this room`);
        this.giveUp();
        return;
      }
      // 409: no seat of this device in that room (yet, or any more); 503 or the network: later.
      log.info(`voice companion: token failed${e instanceof ApiError ? ` (${e.status})` : ''}, retrying`);
      this.retry();
      return;
    }
    if (gen !== this.gen) return;
    this.starting = false;
    const room = this.deps.makeRoom();
    this.pending = room;
    this.guard(room);
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.onDisconnected(room, reason));
    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
    } catch (e) {
      if (this.pending !== room) return;
      this.pending = null;
      log.info('voice companion: connect failed', e);
      void room.disconnect();
      this.retry();
      return;
    }
    if (gen !== this.gen || this.pending !== room) {
      void room.disconnect();
      return;
    }
    this.pending = null;
    this.live = room;
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.failures = 0;
    }, COMPANION_STABLE_MS);
    this.hooks.attach(room);
    // The wish may have changed meanwhile without a close (no camera any more): the idle wait starts now.
    if (!this.want.needed) this.sync(this.want);
  }

  /**
   * Never an audio kind (ADR-0149 §3): nothing is auto-subscribed, voice subscribes video only, and
   * an audio subscription that appears anyway is dropped at once.
   */
  private guard(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
      if (track.kind !== Track.Kind.Audio) return;
      log.warn(`voice companion: an audio track (${pub.source}) got subscribed, dropping it`);
      pub.setSubscribed(false);
    });
  }

  private onDisconnected(room: Room, reason?: DisconnectReason): void {
    if (room !== this.live && room !== this.pending) return;
    const wasLive = room === this.live;
    this.live = null;
    this.pending = null;
    this.gen++;
    this.cancelIdle();
    this.cancelStable();
    if (wasLive) this.hooks.detach(room, 'gone');
    if (reason === DisconnectReason.CLIENT_INITIATED) return;
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
      // A newer companion of this session (a reloaded page): it is the one now, not a takeover of the seat.
      log.info('voice companion: superseded by a newer one');
      this.superseded = true;
      this.hooks.superseded();
      return;
    }
    // Removed (the seat moved or went), the room closed, the link lost: ask again while still wanted —
    // a seat that went for good ends the join, and the join's end stops this.
    log.info(`voice companion: disconnected (${reason === undefined ? 'unknown' : DisconnectReason[reason]})`);
    this.retry();
  }

  private retry(): void {
    this.failures++;
    if (this.failures >= COMPANION_MAX_FAILURES) {
      log.warn(`voice companion: ${this.failures} failures in a row, no video in this room`);
      this.giveUp();
      return;
    }
    if (!this.wanted() || this.retryTimer !== null) return;
    const ms = COMPANION_RETRY_MS[Math.min(this.failures, COMPANION_RETRY_MS.length) - 1] ?? 1_000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted() && !this.live && !this.starting && !this.pending) void this.start();
    }, ms);
  }

  private giveUp(): void {
    this.cancelRetry();
    if (this.gaveUp) return;
    this.gaveUp = true;
    this.hooks.down(true);
  }

  private close(why: CompanionDetach): void {
    this.gen++;
    this.starting = false;
    this.cancelIdle();
    this.cancelRetry();
    this.cancelStable();
    const live = this.live;
    const pending = this.pending;
    this.live = null;
    this.pending = null;
    if (live) {
      this.hooks.detach(live, why);
      void live.disconnect();
    }
    if (pending) void pending.disconnect();
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private cancelStable(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
