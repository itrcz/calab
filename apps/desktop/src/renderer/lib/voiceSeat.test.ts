import { describe, expect, it } from 'vitest';
import { seatAction, seatRefused, type SeatView } from './voiceSeat';

const view = (p: Partial<SeatView>): SeatView => ({ seatRoom: null, busy: false, livekit: 'none', rejoining: false, strays: [], ...p });

describe('seatAction (docs/09 #71)', () => {
  it('waits while a join / switch / leave is in progress', () => {
    expect(seatAction(view({ busy: true, seatRoom: 'a', livekit: 'connected' }))).toEqual({ kind: 'wait' });
  });

  it('connected in LiveKit: re-asserts the seat, leaving the stray rooms first', () => {
    expect(seatAction(view({ seatRoom: 'b', livekit: 'connected', strays: ['a', 'b'] }))).toEqual({ kind: 'reassert', roomId: 'b', strays: ['a'] });
    expect(seatAction(view({ seatRoom: 'b', livekit: 'connected' }))).toEqual({ kind: 'reassert', roomId: 'b', strays: [] });
  });

  it('seat without LiveKit: wakes a waiting reconnect cycle, watches a LiveKit resume', () => {
    expect(seatAction(view({ seatRoom: 'a', rejoining: true }))).toEqual({ kind: 'rejoin' });
    expect(seatAction(view({ seatRoom: 'a', livekit: 'reconnecting' }))).toEqual({ kind: 'watch' });
    expect(seatAction(view({ seatRoom: 'a' }))).toEqual({ kind: 'none' });
  });

  it('not in voice: takes the device out of the stray rooms', () => {
    expect(seatAction(view({ strays: ['a'] }))).toEqual({ kind: 'leave', strays: ['a'] });
    expect(seatAction(view({}))).toEqual({ kind: 'none' });
  });

  it('only a refusal (no access, gone, full) is unrecoverable', () => {
    expect([403, 404, 409].every(seatRefused)).toBe(true);
    expect([0, 401, 429, 500, 503, undefined].some(seatRefused)).toBe(false);
  });
});
