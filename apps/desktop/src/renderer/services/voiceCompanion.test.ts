import { DisconnectReason, RoomEvent, Track, type Room } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform', () => ({ isWeb: true, platform: { kind: 'web' } }));
// The module's default token source; the tests hand it their own (no seat API exists in here).
vi.mock('../lib/api/endpoints', () => ({ api: { voice: {} } }));

const { ApiError } = await import('../lib/api/client');

const { COMPANION_IDLE_MS, COMPANION_MAX_FAILURES, COMPANION_STABLE_MS, VoiceCompanion, companionDevice, isCompanionIdentity, isSoleConnection } = await import('./voiceCompanion');

type Handler = (...a: unknown[]) => void;

class FakeRoom {
  static all: FakeRoom[] = [];
  handlers = new Map<string, Handler[]>();
  connects: [string, string, unknown][] = [];
  disconnects = 0;
  /** When set, decides connect(): a rejection is LiveKit refusing it. */
  static onConnect: (() => Promise<void>) | null = null;
  constructor() {
    FakeRoom.all.push(this);
  }
  on(ev: string, fn: Handler): this {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  emit(ev: string, ...a: unknown[]): void {
    for (const h of this.handlers.get(ev) ?? []) h(...a);
  }
  connect(url: string, token: string, opts: unknown): Promise<void> {
    this.connects.push([url, token, opts]);
    return FakeRoom.onConnect ? FakeRoom.onConnect() : Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.disconnects++;
    return Promise.resolve();
  }
}

const conflict = (): InstanceType<typeof ApiError> => new ApiError('CONFLICT', 'join the voice room first', 409);

let tokens: ReturnType<typeof vi.fn<(roomId: string) => Promise<{ url: string; token: string }>>>;
let hooks: { attach: ReturnType<typeof vi.fn<(r: Room) => void>>; detach: ReturnType<typeof vi.fn<(r: Room, why: string) => void>>; down: ReturnType<typeof vi.fn<(on: boolean) => void>>; superseded: ReturnType<typeof vi.fn<() => void>> };
let companion: InstanceType<typeof VoiceCompanion>;

const want = (w: Partial<{ join: string | null; roomId: string | null; needed: boolean; visible: boolean }> = {}) => ({ join: 'j1', roomId: 'A', needed: true, visible: true, ...w });
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const last = (): FakeRoom => {
  const r = FakeRoom.all.at(-1);
  if (!r) throw new Error('no room');
  return r;
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeRoom.all = [];
  FakeRoom.onConnect = null;
  let n = 0;
  tokens = vi.fn((_roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t${++n}` }));
  hooks = { attach: vi.fn<(r: Room) => void>(), detach: vi.fn<(r: Room, why: string) => void>(), down: vi.fn<(on: boolean) => void>(), superseded: vi.fn<() => void>() };
  companion = new VoiceCompanion(
    { attach: (r) => hooks.attach(r), detach: (r, why) => hooks.detach(r, why), down: (on) => hooks.down(on), superseded: () => hooks.superseded() },
    { token: (id) => tokens(id), makeRoom: () => new FakeRoom() as unknown as Room },
  );
});
afterEach(() => {
  companion.stop();
  vi.useRealTimers();
});

describe('companion identities', () => {
  it('tells a companion from a device and names its device', () => {
    expect(isCompanionIdentity('u:s:web')).toBe(true);
    expect(isCompanionIdentity('u:s')).toBe(false);
    expect(companionDevice('u:s:web')).toBe('u:s');
    expect(companionDevice('u:s')).toBeNull();
  });

  it('cues a person once: not for a companion, not for a second device of someone already there', () => {
    expect(isSoleConnection('u:s', ['u:s'])).toBe(true);
    expect(isSoleConnection('u:s', ['u:s', 'v:t'])).toBe(true);
    expect(isSoleConnection('u:s:web', ['u:s', 'u:s:web'])).toBe(false);
    expect(isSoleConnection('u:s', ['u:s', 'u:s:web'])).toBe(true);
    expect(isSoleConnection('u:s2', ['u:s', 'u:s2'])).toBe(false);
    // On leave the gone device is already out of the room.
    expect(isSoleConnection('u:s2', ['u:s'])).toBe(false);
    expect(isSoleConnection('u:s', ['u:s:web'])).toBe(true);
  });
});

describe('VoiceCompanion (ADR-0149 §3)', () => {
  it('never subscribes an audio kind: nothing automatic, and a stray audio subscription is dropped', async () => {
    companion.sync(want());
    await settle();
    const room = last();
    expect(room.connects[0]?.[2]).toEqual({ autoSubscribe: false });
    const pub = (source: string) => ({ source, setSubscribed: vi.fn() });
    for (const source of [Track.Source.Microphone, Track.Source.ScreenShareAudio]) {
      const p = pub(source);
      room.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Audio }, p);
      expect(p.setSubscribed).toHaveBeenCalledExactlyOnceWith(false);
    }
    const video = pub(Track.Source.ScreenShare);
    room.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video }, video);
    expect(video.setSubscribed).not.toHaveBeenCalled();
  });

  it('is lazy: connects only in foreground while a camera or screen is on, closes 30 s after none', async () => {
    companion.sync(want({ needed: false }));
    companion.sync(want({ needed: true, visible: false }));
    await settle();
    expect(tokens).not.toHaveBeenCalled();
    companion.sync(want());
    await settle();
    expect(tokens).toHaveBeenCalledExactlyOnceWith('A');
    expect(hooks.attach).toHaveBeenCalledOnce();
    expect(companion.phase).toBe('connected');
    // None any more, then one again inside the wait: it stays.
    companion.sync(want({ needed: false }));
    await vi.advanceTimersByTimeAsync(COMPANION_IDLE_MS - 1);
    companion.sync(want());
    await vi.advanceTimersByTimeAsync(COMPANION_IDLE_MS);
    expect(last().disconnects).toBe(0);
    companion.sync(want({ needed: false }));
    await vi.advanceTimersByTimeAsync(COMPANION_IDLE_MS - 1);
    expect(companion.room).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(companion.room).toBeNull();
    expect(hooks.detach).toHaveBeenCalledExactlyOnceWith(last(), 'idle');
    expect(last().disconnects).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes at once in background and comes back with a fresh token in foreground', async () => {
    companion.sync(want());
    await settle();
    const first = last();
    companion.sync(want({ visible: false }));
    expect(hooks.detach).toHaveBeenCalledExactlyOnceWith(first, 'hidden');
    expect(first.disconnects).toBe(1);
    companion.sync(want());
    await settle();
    expect(FakeRoom.all).toHaveLength(2);
    expect(last().connects[0]?.[1]).toBe('t2');
  });

  it('superseded by a newer companion of the session: off, not a takeover, until a new join', async () => {
    companion.sync(want());
    await settle();
    const room = last();
    room.emit(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY);
    expect(hooks.detach).toHaveBeenCalledExactlyOnceWith(room, 'gone');
    expect(companion.phase).toBe('superseded');
    expect(hooks.superseded).toHaveBeenCalledOnce();
    companion.sync(want({ needed: false }));
    companion.sync(want());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tokens).toHaveBeenCalledOnce();
    expect(hooks.down).not.toHaveBeenCalled();
    companion.sync(want({ join: 'j2' }));
    await settle();
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(companion.phase).toBe('connected');
  });

  it('409 (no seat in that room yet) is asked again; a move asks for the new room at once', async () => {
    tokens.mockImplementationOnce(() => Promise.reject(conflict()));
    companion.sync(want());
    await settle();
    expect(FakeRoom.all).toHaveLength(0);
    expect(companion.phase).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(companion.phase).toBe('connected');
    // Moved: the server removed the companion from A; voice names room B.
    tokens.mockImplementationOnce(() => Promise.reject(conflict()));
    last().emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    companion.sync(want({ roomId: 'B' }));
    await settle();
    expect(tokens.mock.calls.map((c) => c[0])).toEqual(['A', 'A', 'B']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tokens.mock.calls.map((c) => c[0])).toEqual(['A', 'A', 'B', 'B']);
    expect(companion.phase).toBe('connected');
  });

  it('a lost link reconnects with a fresh token; a final refusal gives video up for the join', async () => {
    companion.sync(want());
    await settle();
    last().emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeRoom.all).toHaveLength(2);
    expect(last().connects[0]?.[1]).toBe('t2');
    for (const status of [403, 404, 422]) {
      companion.sync(want({ join: `refused-${status}` }));
      tokens.mockImplementationOnce(() => Promise.reject(new ApiError('X', 'no', status)));
      companion.sync(want({ join: `refused-${status}`, roomId: 'C' }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(companion.phase).toBe('down');
    }
    expect(tokens.mock.calls.filter((c) => c[0] === 'C')).toHaveLength(3);
    expect(hooks.down.mock.calls.map((c) => c[0])).toEqual([true, false, true, false, true]);
  });

  it('gives up after repeated failures and says so once', async () => {
    tokens.mockImplementation(() => Promise.reject(new ApiError('UNAVAILABLE', 'later', 503)));
    companion.sync(want());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tokens).toHaveBeenCalledTimes(COMPANION_MAX_FAILURES);
    expect(companion.phase).toBe('down');
    expect(hooks.down).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('assumes no seat: a refused connect retries, the join’s end stops everything, nothing else is called', async () => {
    FakeRoom.onConnect = () => Promise.reject(new Error('could not establish signal connection'));
    companion.sync(want());
    await settle();
    expect(hooks.attach).not.toHaveBeenCalled();
    FakeRoom.onConnect = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hooks.attach).toHaveBeenCalledOnce();
    companion.stop();
    expect(hooks.detach).toHaveBeenCalledExactlyOnceWith(last(), 'gone');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('one token request for a burst of wishes while it is on its way', async () => {
    let answer!: (v: { url: string; token: string }) => void;
    tokens.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    for (let i = 0; i < 5; i++) companion.sync(want());
    companion.sync(want({ needed: false }));
    companion.sync(want());
    expect(companion.phase).toBe('connecting');
    answer({ url: 'wss://lk', token: 'late' });
    await settle();
    companion.sync(want());
    await settle();
    expect(tokens).toHaveBeenCalledOnce();
    expect(FakeRoom.all).toHaveLength(1);
    expect(companion.phase).toBe('connected');
  });

  it('a companion removed right after each join gives up instead of looping; a link that stayed up forgives', async () => {
    companion.sync(want());
    await settle();
    // Up for 30 s: the failures so far are forgiven.
    last().emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(COMPANION_STABLE_MS);
    // Then removed right after every join: the retries back off and end.
    const down = (): boolean => companion.phase === 'down';
    for (let i = 0; i < 20 && !down(); i++) {
      last().emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
      for (let ms = 0; ms < 60_000 && !companion.room && !down(); ms += 500) await vi.advanceTimersByTimeAsync(500);
    }
    expect(companion.phase).toBe('down');
    // 1 first join + 1 after the forgiven removal + MAX_FAILURES - 1 retries before giving up.
    expect(tokens).toHaveBeenCalledTimes(2 + COMPANION_MAX_FAILURES - 1);
  });
});
