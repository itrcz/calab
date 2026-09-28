/**
 * Voice seat recovery after a connection loss (docs/05 «Восстановление голоса после разрыва»,
 * docs/09 #71, issue #15). The server's record of this device (its voice state) and the LiveKit
 * connection must agree; the server is the source of truth, reached through the same idempotent
 * calls a join / leave uses. Pure decision logic here; services/voice.ts carries it out.
 */

/** What this device holds right now. */
export interface SeatView {
  /** A room in the voice store (connected, reconnecting or connecting). */
  seatRoom: string | null;
  /** A join / switch / leave is in progress: it settles the server itself, check after it. */
  busy: boolean;
  /** The LiveKit room of the seat: connected, reconnecting by itself (SDK), or none. */
  livekit: 'connected' | 'reconnecting' | 'none';
  /** Our own reconnect cycle is waiting out a backoff (services/voice.ts rejoin). */
  rejoining: boolean;
  /** Rooms a /join of this device may have recorded on the server that it no longer sits in. */
  strays: readonly string[];
}

export type SeatAction =
  /** Busy: look again when the current join / leave has settled. */
  | { kind: 'wait' }
  /** Nothing to fix. */
  | { kind: 'none' }
  /**
   * In the room in LiveKit: re-assert the seat — /voice/leave the strays, then /join the seat
   * (idempotent; records the device again if the server lost it). Refused → leave with a toast.
   */
  | { kind: 'reassert'; roomId: string; strays: string[] }
  /** The seat's LiveKit connection is gone: rejoin now with a fresh token, no backoff. */
  | { kind: 'rejoin' }
  /** LiveKit is reconnecting on its own: give it a moment, then rejoin with a fresh token. */
  | { kind: 'watch' }
  /** Not in voice: take the device out of the rooms the server may still hold it in. */
  | { kind: 'leave'; strays: string[] };

export function seatAction(v: SeatView): SeatAction {
  if (v.busy) return { kind: 'wait' };
  if (v.seatRoom) {
    if (v.livekit === 'connected') return { kind: 'reassert', roomId: v.seatRoom, strays: v.strays.filter((r) => r !== v.seatRoom) };
    if (v.livekit === 'reconnecting') return { kind: 'watch' };
    return v.rejoining ? { kind: 'rejoin' } : { kind: 'none' };
  }
  return v.strays.length ? { kind: 'leave', strays: [...v.strays] } : { kind: 'none' };
}

/**
 * /join answers that mean the server will not seat the device (no access, the room is gone or
 * full): an unrecoverable desync — leave, never keep a ghost. Anything else (network, 5xx) is
 * transient: the next reconnect tries again.
 */
export function seatRefused(status: number | undefined): boolean {
  return status === 403 || status === 404 || status === 409;
}
