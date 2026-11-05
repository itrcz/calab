import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostRoomAudioSession, HostRoomAudioUnavailable, ROOM_AUDIO_SETTLE_MS, ROOM_CONTROL_GAP_MS, ROOM_CONTROL_RETRY_MS, roomAudioControls, roomLevelDb } from './hostRoomAudio';
import { parseRoomAudioControls, type HostRoomAudioCapability, type HostRoomAudioState, type HostRoomAudioStatus } from '../../../shared/hostRoomAudio';

const connectionId = '22222222-2222-4222-8222-222222222222';
const other = '44444444-4444-4444-8444-444444444444';
const user = '55555555-5555-4555-8555-555555555555';
const base = { muted: false, deafened: false, outputVolume: 1, users: [], bitrateKbps: 32, mode: 'voice' as const, thresholdDb: -50, pttOpen: false, levels: false };
const controls = roomAudioControls(base);
const input = { connectionId, roomId: '33333333-3333-4333-8333-333333333333', url: 'wss://rtc.example.test', token: 'a.b.c', relayOnly: false, red: true, canSpeak: true, controls };
const state = (s: Partial<HostRoomAudioState> = {}): HostRoomAudioState => ({ connectionId, phase: 'connected', microphoneReady: true, muted: false, canSpeak: true, speaking: false, speakers: [], route: 'speaker', phoneCall: false, ...s });

function fixture() {
  let emit: (s: HostRoomAudioState) => void = () => undefined;
  let reply!: (s: HostRoomAudioStatus) => void;
  let status: HostRoomAudioStatus = { supported: true };
  const control = vi.fn((_id: string, _c: unknown) => Promise.resolve(true));
  const disconnect = vi.fn(), cue = vi.fn(), unsubscribe = vi.fn();
  const capability: HostRoomAudioCapability = {
    connect: () => new Promise((r) => (reply = r)),
    status: () => Promise.resolve(status),
    control, cue, disconnect,
    subscribe: (fn) => { emit = fn; return () => { unsubscribe(); emit = () => undefined; }; },
  };
  const changes: HostRoomAudioState[] = [];
  const session = new HostRoomAudioSession(capability, input, (s) => changes.push(s));
  return {
    session, changes, control, disconnect, cue, unsubscribe,
    reply: (s: HostRoomAudioStatus) => reply(s),
    emit: (s: HostRoomAudioState) => emit(s),
    setStatus: (s: HostRoomAudioStatus) => { status = s; },
  };
}
async function failure(run: Promise<void>): Promise<HostRoomAudioUnavailable> {
  const e = await run.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(HostRoomAudioUnavailable);
  return e as HostRoomAudioUnavailable;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('native room audio: one owner per join', () => {
  it('is in the room only with the microphone published, and only its own connection counts', async () => {
    const x = fixture();
    const run = x.session.start();
    x.emit(state({ connectionId: other }));
    x.reply({ supported: true, media: state({ phase: 'connecting', microphoneReady: false }) });
    await vi.advanceTimersByTimeAsync(0);
    x.emit(state({ microphoneReady: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(x.session.connected).toBe(false);
    x.emit(state());
    await run;
    expect(x.session.connected).toBe(true);
    expect(x.changes).toEqual([]);
    x.emit(state({ speaking: true }));
    expect(x.changes).toEqual([state({ speaking: true })]);
  });
  it('lets a listener in without a microphone and keeps a join held by a phone call', async () => {
    const x = fixture();
    const run = x.session.start();
    x.reply({ supported: true, media: state({ canSpeak: false, microphoneReady: false }) });
    await run;
    const y = fixture();
    const held = y.session.start();
    y.reply({ supported: true, media: state({ phase: 'interrupted', microphoneReady: false, phoneCall: true }) });
    await held;
    expect(y.session.connected).toBe(true);
  });
  it('falls back only after a drained end, before capture, for a reason the web may not share', async () => {
    const x = fixture();
    const run = x.session.start();
    x.reply({ supported: true, media: state({ phase: 'connecting', microphoneReady: false }) });
    await vi.advanceTimersByTimeAsync(0);
    x.emit(state({ phase: 'failed', microphoneReady: false, error: 'connection' }));
    expect((await failure(run)).fallback).toBe(true);
    expect(x.disconnect).toHaveBeenCalledWith(connectionId);
    expect(x.unsubscribe).toHaveBeenCalledOnce();
  });
  it('never falls back for a denied microphone, a takeover or once native had the microphone', async () => {
    for (const [s, reason] of [
      [state({ phase: 'failed', microphoneReady: false, error: 'permission' }), 'permission'],
      [state({ phase: 'ended', microphoneReady: false, error: 'duplicate' }), 'duplicate'],
      [state({ phase: 'failed', microphoneReady: true, error: 'audio' }), 'audio'],
    ] as const) {
      const x = fixture();
      const run = x.session.start();
      x.reply({ supported: true, media: state({ phase: 'connecting', microphoneReady: s.microphoneReady }) });
      await vi.advanceTimersByTimeAsync(0);
      x.emit(s);
      const e = await failure(run);
      expect([e.reason, e.fallback]).toEqual([reason, false]);
    }
  });
  it('waits for the drained end after an unknown reply and never falls back while native may hold audio', async () => {
    const x = fixture();
    const run = x.session.start();
    x.setStatus({ supported: true, failed: true });
    x.reply({ supported: true, failed: true });
    const pending = failure(run);
    await vi.advanceTimersByTimeAsync(ROOM_AUDIO_SETTLE_MS);
    const e = await pending;
    expect([e.reason, e.fallback]).toEqual(['unknown', false]);
  });
  it('falls back when native never began this connection (refused host, rate limit)', async () => {
    const x = fixture();
    const run = x.session.start();
    x.setStatus({ supported: true, media: state({ connectionId: other, phase: 'ended' }) });
    x.reply({ supported: true, failed: true, media: state({ connectionId: other, phase: 'ended' }) });
    expect((await failure(run)).fallback).toBe(true);
  });
  it('cannot be resurrected after stop while connect is pending', async () => {
    const x = fixture();
    const run = x.session.start();
    x.session.stop();
    x.reply({ supported: true, media: state() });
    expect((await failure(run)).fallback).toBe(false);
    x.emit(state());
    expect(x.session.connected).toBe(false);
    expect(x.disconnect).toHaveBeenCalledOnce();
  });
  it('reports a lost connection as such', async () => {
    const x = fixture();
    const run = x.session.start();
    x.reply({ supported: true, media: state() });
    await run;
    x.emit(state({ phase: 'lost', error: 'network', microphoneReady: false }));
    expect([x.session.lost, x.session.alive, x.session.connected]).toEqual([true, false, false]);
  });
});

describe('native room audio controls', () => {
  it('clamps every volume to 1: one value above 1 would drop the whole control', () => {
    const c = roomAudioControls({ ...base, outputVolume: 1.4, users: [{ id: user.toUpperCase(), volume: 1.8 }, { id: other, volume: 0.25 }, { id: 'not-a-user', volume: 0.5 }] });
    expect(c.volume).toBe(1);
    expect(c.userVolumes).toEqual({ [other]: 0.25 });
    expect(parseRoomAudioControls(c)).not.toBeNull();
  });
  it('keeps the bridge bounds: 64 users, 8–64 kbps, the meter range', () => {
    const users = Array.from({ length: 80 }, (_, i) => ({ id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`, volume: 0.5 }));
    const c = roomAudioControls({ ...base, users, bitrateKbps: 128, thresholdDb: -120, mode: 'ptt', pttOpen: true });
    expect(Object.keys(c.userVolumes)).toHaveLength(64);
    expect(c.bitrate).toBe(64000);
    expect(c.gate).toEqual({ mode: 'ptt', thresholdDb: -80, pttOpen: true });
    expect(parseRoomAudioControls(c)).not.toBeNull();
    expect(roomAudioControls({ ...base, bitrateKbps: 4 }).bitrate).toBe(8000);
  });
  it('watched stream publishers: user ids, clamped volumes, at most 4 (ADR-0149 §3)', () => {
    expect(roomAudioControls(base).watched).toEqual({});
    const watched = [{ id: user.toUpperCase(), volume: 1.7 }, { id: 'not-a-user', volume: 0.5 }, { id: user, volume: 0.2 }, ...Array.from({ length: 6 }, (_, i) => ({ id: `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`, volume: 0.5 }))];
    const c = roomAudioControls({ ...base, watched });
    expect(Object.keys(c.watched)).toHaveLength(4);
    expect(c.watched[user]).toBe(1);
    expect(parseRoomAudioControls(c)).not.toBeNull();
  });
  it('maps the native meter back to dBFS', () => {
    expect([roomLevelDb(0), roomLevelDb(10), roomLevelDb(20), roomLevelDb(99)]).toEqual([-80, -40, 0, 0]);
  });
  it('coalesces controls, skips repeats and sends the latest again after a refusal', async () => {
    const x = fixture();
    const run = x.session.start();
    x.reply({ supported: true, media: state() });
    await run;
    x.session.control(controls);
    expect(x.control).not.toHaveBeenCalled();
    const muted = roomAudioControls({ ...base, muted: true });
    x.control.mockResolvedValueOnce(false);
    x.session.control(muted);
    x.session.control(roomAudioControls({ ...base, deafened: true }));
    x.session.control(muted);
    expect(x.control).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ROOM_CONTROL_GAP_MS + ROOM_CONTROL_RETRY_MS);
    expect(x.control.mock.calls.map((c) => c[1])).toEqual([muted, muted]);
  });
  it('sends unchanged controls again on request (native acts on receipt)', async () => {
    const x = fixture();
    const run = x.session.start();
    x.reply({ supported: true, media: state() });
    await run;
    const muted = roomAudioControls({ ...base, muted: true });
    x.session.control(muted);
    await vi.advanceTimersByTimeAsync(ROOM_CONTROL_GAP_MS);
    x.session.control(muted);
    x.session.resend();
    await vi.advanceTimersByTimeAsync(ROOM_CONTROL_GAP_MS);
    expect(x.control.mock.calls.map((c) => c[1])).toEqual([muted, muted]);
  });
  it('asks for levels again with an off-on edge, only while levels are wanted', async () => {
    const x = fixture();
    const run = x.session.start();
    x.reply({ supported: true, media: state() });
    await run;
    x.session.refreshLevels();
    expect(x.control).not.toHaveBeenCalled();
    const levels = roomAudioControls({ ...base, levels: true });
    x.session.control(levels);
    await vi.advanceTimersByTimeAsync(ROOM_CONTROL_GAP_MS);
    x.session.refreshLevels();
    await vi.advanceTimersByTimeAsync(ROOM_CONTROL_GAP_MS);
    expect(x.control.mock.calls.map((c) => (c[1] as { levels: boolean }).levels)).toEqual([true, false, true]);
  });
  it('sends what changed while connecting once in the room', async () => {
    const x = fixture();
    const run = x.session.start();
    const muted = roomAudioControls({ ...base, muted: true });
    x.session.control(muted);
    x.reply({ supported: true, media: state() });
    await run;
    expect(x.control).toHaveBeenCalledWith(connectionId, muted);
  });
});
