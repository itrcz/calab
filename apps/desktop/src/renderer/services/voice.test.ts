import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VoiceEngine with LiveKit, the API and the mic pipeline mocked (review test gaps: H1 room
 * switch, M1 leave during mic test, M2 concurrent restartMic, M4 SPEAK granted mid-call,
 * rejoin abort, L2 mute race).
 */

// ---------------------------------------------------------------- DOM stubs (node env)

const el = (): Record<string, unknown> => ({ hidden: false, id: '', appendChild: () => undefined, remove: () => undefined });
/** document listeners by event (the CSP violation handler is fired from tests). */
const docListeners = new Map<string, ((ev: unknown) => void)[]>();
vi.stubGlobal('document', {
  createElement: el,
  body: { appendChild: () => undefined },
  addEventListener: (ev: string, fn: (e: unknown) => void) => void docListeners.set(ev, [...(docListeners.get(ev) ?? []), fn]),
  visibilityState: 'visible',
  hasFocus: () => true,
});
vi.stubGlobal('window', globalThis);
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
/** The audio devices `enumerateDevices()` reports; `devicechange` handlers are kept to fire them. */
let deviceList: { deviceId: string; groupId: string; kind: string; label: string }[] = [];
const deviceChange: (() => void)[] = [];
vi.stubGlobal('navigator', {
  userAgent: 'test',
  mediaDevices: {
    addEventListener: (ev: string, fn: () => void) => {
      if (ev === 'devicechange') deviceChange.push(fn);
    },
    enumerateDevices: () => Promise.resolve(deviceList),
  },
});

// ---------------------------------------------------------------- livekit-client mock

type Handler = (...a: unknown[]) => void;

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  stop(): void {
    this.readyState = 'ended';
  }
}

class FakeLocalAudioTrack {
  isMuted = false;
  stopped = false;
  replaced: FakeTrack[] = [];
  /** Pending mute/unmute resolvers (tests settle them to simulate LiveKit's async lock). */
  static lockMs = 0;
  constructor(public mediaStreamTrack: FakeTrack) {}
  async mute(): Promise<void> {
    await new Promise((r) => setTimeout(r, FakeLocalAudioTrack.lockMs));
    this.isMuted = true;
  }
  async unmute(): Promise<void> {
    await new Promise((r) => setTimeout(r, FakeLocalAudioTrack.lockMs));
    this.isMuted = false;
    this.mediaStreamTrack.enabled = true;
  }
  stop(): void {
    this.stopped = true;
    this.mediaStreamTrack.stop();
  }
  /** When set, the next replaceTrack rejects (RTCRtpSender.replaceTrack failure). */
  static failReplace = false;
  replaceTrack(t: FakeTrack): Promise<void> {
    if (FakeLocalAudioTrack.failReplace) {
      FakeLocalAudioTrack.failReplace = false;
      return Promise.reject(new Error('replaceTrack failed'));
    }
    this.replaced.push(t);
    this.mediaStreamTrack = t;
    return Promise.resolve();
  }
  getRTCStatsReport(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

class FakeRoom {
  static all: FakeRoom[] = [];
  handlers = new Map<string, Handler[]>();
  disconnects: boolean[] = [];
  published: FakeLocalAudioTrack[] = [];
  remoteParticipants = new Map();
  name = '';
  /** ConnectionState (names proxy: the enum key). */
  state = 'Connected';
  engine = {};
  localParticipant = {
    identity: 'u1:mine',
    permissions: undefined as undefined | { canPublish: boolean; canPublishSources: number[] },
    publishTrack: vi.fn((t: FakeLocalAudioTrack) => {
      this.published.push(t);
      return Promise.resolve();
    }),
    unpublishTrack: vi.fn((t: FakeLocalAudioTrack) => {
      this.published = this.published.filter((x) => x !== t);
      return Promise.resolve();
    }),
    getTrackPublication: (source: string) => (source === 'microphone' && this.published.length ? {} : undefined),
    publishData: () => Promise.resolve(),
    on: vi.fn(),
    off: vi.fn(),
  };
  constructor() {
    FakeRoom.all.push(this);
  }
  on(ev: string, fn: Handler): this {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  off(): this {
    return this;
  }
  emit(ev: string, ...a: unknown[]): void {
    for (const h of this.handlers.get(ev) ?? []) h(...a);
  }
  connectedWith: [string, string] | null = null;
  /** When set, decides the outcome of connect() (a rejected promise = LiveKit refused it). */
  static onConnect: ((token: string) => Promise<void>) | null = null;
  connect(url: string, token: string): Promise<void> {
    this.connectedWith = [url, token];
    return FakeRoom.onConnect ? FakeRoom.onConnect(token) : Promise.resolve();
  }
  /** When set, disconnect() waits for it (a slow network disconnect). */
  static disconnectGate: Promise<void> | null = null;
  async disconnect(stopTracks = true): Promise<void> {
    this.disconnects.push(stopTracks);
    if (FakeRoom.disconnectGate) await FakeRoom.disconnectGate;
    if (stopTracks) for (const t of this.published) t.stop();
    this.published = [];
  }
}

const names = new Proxy({}, { get: (_t, k) => String(k) });
vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  LocalAudioTrack: FakeLocalAudioTrack,
  RoomEvent: names,
  ParticipantEvent: names,
  ConnectionState: names,
  DisconnectReason: names,
  Track: { Source: { Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' }, Kind: { Audio: 'audio', Video: 'video' } },
  VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
}));

// ---------------------------------------------------------------- app mocks

const joinVoice = vi.fn((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } }));
const updateSelf = vi.fn((_b: { muted?: boolean; deafened?: boolean }) => Promise.resolve());
const leaveVoice = vi.fn((_roomId: string) => Promise.resolve());
const requestStream = vi.fn((_roomId: string, preset: number) => Promise.resolve({ preset, fps: 0 }));
vi.mock('../lib/api/endpoints', () => ({
  api: {
    voice: {
      join: (id: string) => joinVoice(id),
      leave: (id: string) => leaveVoice(id),
      updateSelf: (b: { muted?: boolean; deafened?: boolean }) => updateSelf(b),
      requestStream: (id: string, preset: number) => requestStream(id, preset),
    },
    me: { update: () => Promise.resolve({}) },
  },
}));

interface FakePipeline {
  track: FakeTrack;
  stop: ReturnType<typeof vi.fn>;
  deviceId: string | null;
  deviceLabel: string;
  rnnoise: boolean;
  /** MicPipeline.duckable: a gain stage exists (RNNoise on or a speakerphone mode). */
  duckable: boolean;
  isDucked: boolean;
  setDuck: ReturnType<typeof vi.fn>;
  setDenoise: ReturnType<typeof vi.fn>;
  onEnded?: () => void;
}
/** Device ids that are unplugged (getUserMedia with {exact} fails). */
const gone = new Set<string>();
const pipelines: FakePipeline[] = [];
let gate: Promise<void> | null = null; // when set, MicPipeline.start waits for it
vi.mock('../lib/media/micPipeline', () => ({
  MicPipeline: {
    start: vi.fn(async (opts: { deviceId: string | null; rnnoise: boolean; duckable?: boolean; onEnded?: () => void }) => {
      if (gate) await gate;
      if (opts.deviceId && gone.has(opts.deviceId)) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      const track = new FakeTrack();
      const p: FakePipeline = {
        track,
        deviceId: opts.deviceId,
        deviceLabel: opts.deviceId ?? 'Default - Built-in Mic',
        rnnoise: opts.rnnoise,
        duckable: opts.rnnoise || opts.duckable === true,
        isDucked: false,
        setDuck: vi.fn(),
        setDenoise: vi.fn(),
        stop: vi.fn(() => track.stop()),
        ...(opts.onEnded ? { onEnded: opts.onEnded } : {}),
      };
      pipelines.push(p);
      return p;
    }),
  },
}));
const startScreenShare = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ video: { sid: 'TR_screen', mediaStreamTrack: {} }, audio: null, audioProblem: null, sourceName: 'Screen', stop: () => Promise.resolve() }),
);
vi.mock('../lib/media/screenShare', () => ({
  applyPreset: vi.fn(),
  captureScreen: vi.fn(() => Promise.resolve({ stream: { getTracks: () => [] }, audioProblem: null })),
  startScreenShare: (...a: unknown[]) => startScreenShare(...a),
}));
/** ADR-0032: the codec comes from pickPublishCodec(kind, «Кодек стрима»). */
const pickPublishCodec = vi.fn((_kind: string, pref: string) => Promise.resolve({ codec: pref === 'auto' ? 'h264' : pref, hw: false }));
vi.mock('../lib/media/codecSelect', () => ({ pickPublishCodec: (k: string, p: string) => pickPublishCodec(k, p) }));
const playSound = vi.fn((_name: string) => undefined);
vi.mock('../lib/sounds', () => ({ playSound: (name: string) => playSound(name) }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
const announce = vi.fn();
vi.mock('./deviceToast', () => ({ announceDeviceSwitch: (...a: unknown[]) => void announce(...a) }));
const reportMediaError = vi.fn(() => ({ text: 'err', action: null }));
vi.mock('./mediaErrors', () => ({
  humanMediaError: () => ({ text: 'err', action: null }),
  reportMediaError: () => reportMediaError(),
}));
vi.mock('../platform', () => ({
  platform: {
    kind: 'web',
    ptt: { onEvent: () => () => undefined, setBinding: () => Promise.resolve({}) },
    tray: { setState: () => undefined },
    system: { metrics: () => Promise.resolve({ rendererCpu: null }) },
    app: { log: () => undefined },
  },
}));

type Engine = (typeof import('./voice'))['voice'];
let voice: Engine;
let useVoice: (typeof import('../stores/voice'))['useVoice'];
let usePrefs: (typeof import('../stores/prefs'))['usePrefs'];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeRoom.all = [];
  FakeLocalAudioTrack.lockMs = 0;
  FakeLocalAudioTrack.failReplace = false;
  FakeRoom.disconnectGate = null;
  FakeRoom.onConnect = null;
  pipelines.length = 0;
  gate = null;
  gone.clear();
  joinVoice.mockClear();
  leaveVoice.mockReset();
  leaveVoice.mockImplementation(() => Promise.resolve());
  updateSelf.mockClear();
  reportMediaError.mockClear();
  deviceChange.length = 0;
  deviceList = [];
  announce.mockClear();
  playSound.mockClear();
  docListeners.clear();
  ({ voice } = await import('./voice'));
  ({ useVoice } = await import('../stores/voice'));
  ({ usePrefs } = await import('../stores/prefs'));
  const { toast } = await import('../stores/toasts');
  vi.mocked(toast.info).mockClear();
  voice.init();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('VoiceEngine', () => {
  it('join A → join B connects to B (review H1)', async () => {
    await voice.join('A', 'ws');
    expect(useVoice.getState().phase).toBe('connected');
    await voice.join('B', 'ws');
    expect(useVoice.getState().phase).toBe('connected');
    expect(useVoice.getState().roomId).toBe('B');
    expect(voice.currentRoomId).toBe('B');
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(FakeRoom.all[0]?.disconnects).toHaveLength(1);
    expect(FakeRoom.all[1]?.published).toHaveLength(1);
  });

  it('optimistic join: the clicked room is my seat at once, also while the old call is torn down', async () => {
    await voice.join('X', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    const toB = voice.join('B', 'ws');
    expect(useVoice.getState().joining).toEqual({ roomId: 'B', workspaceId: 'ws' }); // synchronously, no /join yet
    await settle();
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['X']);
    FakeRoom.disconnectGate = null;
    release();
    await toB;
    expect(useVoice.getState()).toMatchObject({ joining: null, roomId: 'B', phase: 'connected' });
  });

  it('optimistic join rolled back: a failed /join takes me out of the room with a toast', async () => {
    joinVoice.mockRejectedValueOnce(new Error('503'));
    const p = voice.join('A', 'ws');
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connecting' }); // not in a call: the seat at once
    await p;
    await settle();
    expect(useVoice.getState()).toMatchObject({ joining: null, roomId: null, phase: 'idle' });
    expect(reportMediaError).toHaveBeenCalledTimes(1);
  });

  it('«Отключиться» before the connect drops the optimistic seat', async () => {
    await voice.join('X', 'ws');
    FakeRoom.disconnectGate = new Promise<void>(() => undefined); // the old call hangs
    void voice.join('B', 'ws');
    void voice.leave();
    expect(useVoice.getState().joining).toBeNull();
  });

  it('«Отключиться» tells the server after room.disconnect() without waiting for it (/voice/leave)', async () => {
    await voice.join('A', 'ws');
    let answer!: () => void;
    leaveVoice.mockImplementationOnce(() => new Promise<void>((r) => (answer = r)));
    await voice.leave(); // done without the server's answer
    expect(FakeRoom.all[0]?.disconnects).toHaveLength(1);
    expect(leaveVoice.mock.calls).toEqual([['A']]);
    expect(useVoice.getState()).toMatchObject({ roomId: null, phase: 'idle' });
    answer();
  });

  it('join cancelled while /join is in flight: /voice/leave follows its answer, nothing connects', async () => {
    let answer!: (v: unknown) => void;
    joinVoice.mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    const p = voice.join('A', 'ws');
    await settle();
    expect(joinVoice).toHaveBeenCalledTimes(1);
    await voice.leave();
    await settle();
    expect(leaveVoice).not.toHaveBeenCalled(); // would overtake the /join and leave its pending state
    answer({ url: 'wss://lk', token: 't', canSpeak: true, canStream: true, pending: true, media: { audioBitrateKbps: 32 } });
    await p;
    await settle();
    expect(leaveVoice.mock.calls).toEqual([['A']]);
    expect(FakeRoom.all).toHaveLength(0);
    expect(useVoice.getState()).toMatchObject({ roomId: null, phase: 'idle', joining: null });
  });

  it('a /join right after «Отключиться» waits for the /voice/leave (no overtaking)', async () => {
    await voice.join('A', 'ws');
    let answer!: () => void;
    leaveVoice.mockImplementationOnce(() => new Promise<void>((r) => (answer = r)));
    await voice.leave();
    const back = voice.join('A', 'ws');
    await settle();
    expect(joinVoice).toHaveBeenCalledTimes(1);
    answer();
    await back;
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
  });

  it('a failed /voice/leave only logs', async () => {
    await voice.join('A', 'ws');
    leaveVoice.mockRejectedValueOnce(new Error('offline'));
    await voice.leave();
    await settle();
    await voice.join('B', 'ws');
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected' });
  });

  // docs/09 #71 (issue #15): the server's record of this device follows the LiveKit connection.
  describe('seat check', () => {
    const res = { url: 'wss://lk', token: 't', canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } };

    it('a superseded /join that lands late: the seat is re-asserted with a /join of the room I am in', async () => {
      let answerA!: (v: unknown) => void;
      joinVoice.mockImplementationOnce(() => new Promise((r) => (answerA = r)) as never);
      const a = voice.join('A', 'ws');
      await settle();
      const b = voice.join('B', 'ws');
      await vi.advanceTimersByTimeAsync(3000); // B waits (bounded) for the /join still in flight
      await b;
      expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected' });
      expect(joinVoice.mock.calls).toEqual([['A'], ['B']]);
      answerA({ ...res, pending: true }); // the server now holds me in A
      await a;
      await settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(leaveVoice.mock.calls).toEqual([['A']]);
      expect(joinVoice.mock.calls).toEqual([['A'], ['B'], ['B']]);
      expect(FakeRoom.all.filter((r) => r.disconnects.length === 0)).toHaveLength(1);
    });

    it('after a reconnect: the server lost me (pending /join) → re-seated with my mute state', async () => {
      await voice.join('A', 'ws');
      useVoice.setState({ muted: true });
      updateSelf.mockClear();
      joinVoice.mockResolvedValueOnce({ ...res, pending: true } as never);
      voice.checkSeat();
      await settle();
      expect(joinVoice.mock.calls.at(-1)).toEqual(['A']);
      expect(updateSelf).toHaveBeenCalledWith({ muted: true, deafened: false });
      expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    });

    it('after a reconnect: the server refuses the seat → out of voice with a toast', async () => {
      const { ApiError } = await import('../lib/api/client');
      const { toast } = await import('../stores/toasts');
      await voice.join('A', 'ws');
      joinVoice.mockRejectedValueOnce(new ApiError('ERROR_CODE_FORBIDDEN', 'no', 403));
      voice.checkSeat();
      await settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(useVoice.getState()).toMatchObject({ roomId: null, phase: 'idle' });
      expect(leaveVoice).toHaveBeenCalledWith('A');
      expect(toast.error).toHaveBeenCalledWith('Соединение с голосом потеряно');
    });

    it('a network error keeps the call (retried on the next reconnect)', async () => {
      await voice.join('A', 'ws');
      joinVoice.mockRejectedValueOnce(new Error('offline'));
      voice.checkSeat();
      await settle();
      expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    });

    it('a /voice/leave lost in the network is sent again by the next seat check', async () => {
      await voice.join('A', 'ws');
      leaveVoice.mockRejectedValueOnce(new Error('offline'));
      await voice.leave();
      await settle();
      expect(leaveVoice).toHaveBeenCalledTimes(1);
      voice.checkSeat();
      await settle();
      expect(leaveVoice.mock.calls).toEqual([['A'], ['A']]);
      voice.checkSeat(); // delivered: nothing left to send
      await settle();
      expect(leaveVoice).toHaveBeenCalledTimes(2);
    });
  });

  it('a pending /join sends my mute / deafen before LiveKit connects', async () => {
    const res = { url: 'wss://lk', token: 't', canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } };
    useVoice.setState({ muted: true });
    joinVoice.mockResolvedValueOnce({ ...res, pending: false } as never);
    const a = voice.join('A', 'ws');
    await vi.advanceTimersByTimeAsync(50); // the muted mic track's mute lock
    await a;
    expect(updateSelf).toHaveBeenCalledTimes(1); // after the connect only
    await voice.leave();
    updateSelf.mockClear();
    joinVoice.mockResolvedValueOnce({ ...res, pending: true } as never);
    const b = voice.join('B', 'ws');
    await vi.advanceTimersByTimeAsync(50);
    await b;
    expect(updateSelf).toHaveBeenCalledTimes(2); // right after /join, and after the connect
    expect(updateSelf).toHaveBeenNthCalledWith(1, { muted: true, deafened: false });
  });

  it('a newer join wins over one still waiting for /join', async () => {
    const first = voice.join('A', 'ws');
    const second = voice.join('B', 'ws');
    await Promise.all([first, second]);
    expect(voice.currentRoomId).toBe('B');
    expect(useVoice.getState().phase).toBe('connected');
  });

  it('leave() while the old room is still disconnecting wins over the pending switch (review N1)', async () => {
    await voice.join('A', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    const switching = voice.join('B', 'ws');
    await settle();
    const leaving = voice.leave();
    FakeRoom.disconnectGate = null;
    release();
    await Promise.all([switching, leaving]);
    await settle();
    expect(useVoice.getState().phase).toBe('idle');
    expect(voice.currentRoomId).toBeNull();
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A']); // never connected to B
    expect(FakeRoom.all).toHaveLength(1);
  });

  it('a fast B → A switch ends in A, the last click (review N1)', async () => {
    await voice.join('X', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    const toB = voice.join('B', 'ws');
    await settle();
    const toA = voice.join('A', 'ws');
    FakeRoom.disconnectGate = null;
    release();
    await Promise.all([toB, toA]);
    await settle();
    expect(voice.currentRoomId).toBe('A');
    expect(useVoice.getState().roomId).toBe('A');
    expect(useVoice.getState().phase).toBe('connected');
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['X', 'A']);
  });

  it('a failed replaceTrack keeps the published capture and stops the new one (review N4)', async () => {
    await voice.join('A', 'ws');
    const old = pipelines[0];
    FakeLocalAudioTrack.failReplace = true;
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    await settle();
    await settle();
    expect(pipelines).toHaveLength(2);
    expect(pipelines[1]?.track.readyState).toBe('ended'); // the new capture does not leak
    expect(old?.track.readyState).toBe('live'); // still the published one
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack).toBe(old?.track);
    await voice.leave();
    expect(pipelines.every((p) => p.track.readyState === 'ended')).toBe(true);
  });

  it('leaving during the mic test keeps a live mic for the next call (review M1)', async () => {
    await voice.startMicTest();
    await voice.join('A', 'ws');
    const pipe = pipelines[0];
    expect(pipelines).toHaveLength(1);
    await voice.leave();
    expect(FakeRoom.all[0]?.disconnects).toEqual([false]); // unpublish without stopping
    expect(pipe?.track.readyState).toBe('live');
    expect(pipe?.stop).not.toHaveBeenCalled();
    await voice.join('B', 'ws');
    const published = FakeRoom.all[1]?.published[0];
    expect(published?.mediaStreamTrack.readyState).toBe('live');
    voice.stopMicTest();
    await voice.leave();
    expect(pipe?.stop).toHaveBeenCalled();
  });

  it('an ended pipeline track is rebuilt instead of being published dead', async () => {
    await voice.startMicTest();
    pipelines[0]?.track.stop(); // e.g. LiveKit stopped it on a server unpublish
    await voice.join('A', 'ws');
    expect(pipelines).toHaveLength(2);
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack).toBe(pipelines[1]?.track);
  });

  it('concurrent restartMic never leaks a pipeline (review M2)', async () => {
    await voice.join('A', 'ws');
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    usePrefs.getState().setPrefs({ micDeviceId: 'd2' });
    gate = null;
    open();
    await settle();
    await settle();
    const live = pipelines.filter((p) => p.track.readyState === 'live');
    expect(live).toHaveLength(1);
    expect(live[0]?.deviceId).toBe('d2');
    const track = FakeRoom.all[0]?.published[0];
    expect(track?.mediaStreamTrack).toBe(live[0]?.track);
  });

  it('echo mode without RNNoise: a speakerphone mode rebuilds the capture with a gain stage, in place', async () => {
    usePrefs.getState().setPrefs({ rnnoise: false, echoMode: 'headphones' });
    await voice.join('A', 'ws');
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.duckable).toBe(false);
    usePrefs.getState().setPrefs({ echoMode: 'speakers' });
    await settle();
    expect(pipelines).toHaveLength(2);
    expect(pipelines[1]?.duckable).toBe(true);
    expect(pipelines[0]?.track.readyState).toBe('ended');
    // Swapped with replaceTrack, not republished.
    const room = FakeRoom.all[0];
    expect(room?.published).toHaveLength(1);
    expect(room?.published[0]?.mediaStreamTrack).toBe(pipelines[1]?.track);
    // speakers → auto: the gain stage is already there.
    usePrefs.getState().setPrefs({ echoMode: 'auto' });
    await settle();
    expect(pipelines).toHaveLength(2);
  });

  it('echo mode with RNNoise: the graph already has the gain stage, no rebuild', async () => {
    usePrefs.getState().setPrefs({ rnnoise: true, echoMode: 'headphones' });
    await voice.join('A', 'ws');
    usePrefs.getState().setPrefs({ echoMode: 'speakers' });
    await settle();
    expect(pipelines).toHaveLength(1);
    // Nobody else talks: no duck.
    vi.advanceTimersByTime(500);
    expect(pipelines[0]?.setDuck).not.toHaveBeenCalledWith(true);
    expect(useVoice.getState().ducking).toBe(false);
  });

  it('leaving while a restart is building stops the new capture too', async () => {
    await voice.join('A', 'ws');
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    usePrefs.getState().setPrefs({ rnnoise: !usePrefs.getState().rnnoise });
    await voice.leave();
    gate = null;
    open();
    await settle();
    expect(pipelines.every((p) => p.track.readyState === 'ended')).toBe(true);
  });

  it('SPEAK granted mid-call publishes the mic; revoked → muted (review M4)', async () => {
    joinVoice.mockImplementationOnce((roomId: string) =>
      Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: false, canStream: false, media: { audioBitrateKbps: 32 } }),
    );
    await voice.join('A', 'ws');
    const room = FakeRoom.all[0];
    expect(room?.published).toHaveLength(0);
    // Stream-only grant is not SPEAK.
    if (room) room.localParticipant.permissions = { canPublish: true, canPublishSources: [3, 4] };
    room?.emit('ParticipantPermissionsChanged', undefined, room.localParticipant);
    await settle();
    expect(room?.published).toHaveLength(0);
    if (room) room.localParticipant.permissions = { canPublish: true, canPublishSources: [2] };
    room?.emit('ParticipantPermissionsChanged', undefined, room.localParticipant);
    await settle();
    expect(useVoice.getState().canSpeak).toBe(true);
    expect(room?.published).toHaveLength(1);
    if (room) room.localParticipant.permissions = { canPublish: false, canPublishSources: [] };
    room?.emit('ParticipantPermissionsChanged', undefined, room.localParticipant);
    await settle();
    expect(room?.published[0]?.isMuted).toBe(true);
  });

  it('the rejoin loop stops when the user leaves', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    expect(useVoice.getState().phase).toBe('reconnecting');
    await voice.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().phase).toBe('idle');
    expect(useVoice.getState().roomId).toBeNull();
  });

  it('a failing reconnect cycle keeps the seat: no unmount of the voice panel, one stable phase (0.2.1)', async () => {
    await voice.join('A', 'ws');
    const seen: { roomId: string | null; phase: string }[] = [];
    const unsub = useVoice.subscribe((s) => seen.push({ roomId: s.roomId, phase: s.phase }));
    FakeRoom.onConnect = () => Promise.reject(Object.assign(new Error('could not establish signal connection'), { name: 'ConnectionError', reasonName: 'ServerUnreachable' }));
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    // Three failed attempts (1 s + 2 s + 4 s).
    await vi.advanceTimersByTimeAsync(7_500);
    unsub();
    expect(joinVoice).toHaveBeenCalledTimes(4);
    // VoiceBar renders only with a roomId: it (and its Radix menus) must never see null mid-cycle.
    expect(seen.every((s) => s.roomId === 'A')).toBe(true);
    const phases = [...new Set(seen.map((s) => s.phase))];
    expect(phases).toEqual(['connected', 'reconnecting']);
    expect(useVoice.getState().link.attempts).toBe(3);
    expect(useVoice.getState().link.lastError).toBe('ConnectionError / ServerUnreachable: could not establish signal connection');
    // A successful attempt resets the count.
    FakeRoom.onConnect = null;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(useVoice.getState().phase).toBe('connected');
    expect(useVoice.getState().link.attempts).toBe(0);
  });

  it('the CSP blocking the LiveKit host: phase «blocked», the cycle stops, «Повторить» joins again', async () => {
    await voice.join('A', 'ws');
    FakeRoom.onConnect = () => Promise.reject(new Error('signal failed'));
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await vi.advanceTimersByTimeAsync(1_000);
    for (const fn of docListeners.get('securitypolicyviolation') ?? []) fn({ effectiveDirective: 'connect-src', blockedURI: 'wss://lk/rtc?access_token=x' });
    await settle();
    expect(useVoice.getState().phase).toBe('blocked');
    expect(useVoice.getState().roomId).toBe('A');
    expect(useVoice.getState().link.blockedHost).toBe('lk');
    const calls = joinVoice.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice.mock.calls.length).toBe(calls);
    expect(useVoice.getState().phase).toBe('blocked');
    FakeRoom.onConnect = null;
    voice.retry();
    await settle();
    expect(useVoice.getState().phase).toBe('connected');
    expect(useVoice.getState().link.blockedHost).toBeNull();
  });

  it('a CSP report for another host is ignored', async () => {
    await voice.join('A', 'ws');
    for (const fn of docListeners.get('securitypolicyviolation') ?? []) fn({ effectiveDirective: 'connect-src', blockedURI: 'wss://elsewhere.example' });
    expect(useVoice.getState().phase).toBe('connected');
  });

  it('a rejoin keeps the moderator mute through its teardown until the server says otherwise', async () => {
    await voice.join('A', 'ws');
    useVoice.setState({ muted: true, serverMuted: true });
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    expect(useVoice.getState().phase).toBe('reconnecting');
    expect(useVoice.getState().serverMuted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(FakeRoom.all).toHaveLength(2);
    expect(useVoice.getState().phase).toBe('connected');
    expect(useVoice.getState().serverMuted).toBe(true);
    expect(useVoice.getState().muted).toBe(true);
    await voice.leave();
    expect(useVoice.getState().serverMuted).toBe(false);
  });

  it('mute → unmute in quick succession ends unmuted, as the UI shows (review L2)', async () => {
    await voice.join('A', 'ws');
    FakeLocalAudioTrack.lockMs = 50;
    voice.toggleMute();
    voice.toggleMute();
    await vi.advanceTimersByTimeAsync(500);
    expect(useVoice.getState().muted).toBe(false);
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
  });

  it.each([true, false])('rapid deafen cycles preserve the prior mic mute (%s)', async (muted) => {
    await voice.join('A', 'ws');
    FakeLocalAudioTrack.lockMs = 50;
    if (muted) voice.toggleMute();
    for (let i = 0; i < 4; i++) voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(500);
    expect(useVoice.getState()).toMatchObject({ muted, deafened: false });
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(muted);
    expect(updateSelf).toHaveBeenLastCalledWith({ muted, deafened: false });
  });

  it('undeafen cannot lift a moderator mute applied while deafened', async () => {
    await voice.join('A', 'ws');
    voice.toggleDeafen();
    voice.reconcileSelfState({ roomId: 'A', muted: true, deafened: true, serverMuted: true });
    voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(100);
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false, serverMuted: true });
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false });
  });

  it.each([true, false])('rejoin while deafened preserves the prior mic mute (%s)', async (muted) => {
    await voice.join('A', 'ws');
    if (muted) voice.toggleMute();
    voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(100);
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(useVoice.getState().phase).toBe('connected');
    expect(FakeRoom.all).toHaveLength(2);

    voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(100);
    expect(useVoice.getState()).toMatchObject({ muted, deafened: false });
    expect(FakeRoom.all[1]?.published[0]?.isMuted).toBe(muted);
    expect(updateSelf).toHaveBeenLastCalledWith({ muted, deafened: false });
  });

  it('the chosen mic unplugged mid-call → default device, published in place (review M3)', async () => {
    usePrefs.getState().setPrefs({ micDeviceId: 'usb' });
    await voice.join('A', 'ws');
    const first = pipelines[0];
    expect(first?.deviceId).toBe('usb');
    gone.add('usb');
    first?.track.stop();
    first?.onEnded?.(); // the OS ended the capture
    await settle();
    await settle();
    const now = pipelines.at(-1);
    expect(now?.deviceId).toBeNull();
    expect(now?.track.readyState).toBe('live');
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack).toBe(now?.track);
    // In a call the device-switch toast names the device now in use (docs/09 #49).
    expect(announce).toHaveBeenCalledWith({ kind: 'input', label: 'Built-in Mic' });
    const { toast } = await import('../stores/toasts');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('the OS switching the default device is announced in a call only (docs/09 #49)', async () => {
    const mbp = { deviceId: 'default', groupId: 'g1', kind: 'audioinput', label: 'Default - MacBook Mic' };
    const air = { deviceId: 'default', groupId: 'g2', kind: 'audioinput', label: 'Default - AirPods' };
    const fire = async (list: (typeof deviceList)[number][]): Promise<void> => {
      deviceList = list;
      for (const fn of deviceChange) fn();
      await settle();
    };
    await fire([mbp]); // baseline, not in a call
    await fire([air]);
    expect(announce).not.toHaveBeenCalled();
    await voice.join('A', 'ws');
    await fire([mbp]);
    expect(announce).toHaveBeenCalledWith({ kind: 'input', label: 'MacBook Mic' });
  });

  describe('push-to-talk release', () => {
    const track = () => FakeRoom.all[0]?.published[0]?.mediaStreamTrack;
    const ring = () => useVoice.getState().speaking['u1'] === true;
    const inPtt = async (releaseMs: number, mode: 'hold' | 'toggle' = 'hold'): Promise<void> => {
      const { useSession } = await import('../stores/session');
      useSession.setState({ me: { user: { id: 'u1' } } } as never);
      usePrefs.getState().setPrefs({ micMode: 'ptt', pttReleaseMs: releaseMs, pttBinding: { kind: 'key', code: 66, label: 'F8', mode } });
      await voice.join('A', 'ws');
      await settle();
    };
    const hold = (down: boolean, immediate?: boolean) => (voice as unknown as { onPtt(ev: { down: boolean; immediate?: boolean }): void }).onPtt({ down, ...(immediate ? { immediate } : {}) });

    it('key-up gates the sender synchronously with 0 ms, the ring goes off at once', async () => {
      await inPtt(0);
      hold(true);
      expect(track()?.enabled).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(ring()).toBe(true);
      hold(false);
      // Synchronous: no timer, no await — the fake track is silenced in the same tick.
      expect(track()?.enabled).toBe(false);
      expect(useVoice.getState().transmitting).toBe(false);
      expect(ring()).toBe(false);
    });

    it.each([20, 2000])('key-up keeps the mic on for %i ms, then gate and ring off together', async (ms) => {
      await inPtt(ms);
      hold(true);
      await vi.advanceTimersByTimeAsync(100);
      hold(false);
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(track()?.enabled).toBe(true);
      expect(ring()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(track()?.enabled).toBe(false);
      expect(ring()).toBe(false); // not the 300 ms speaking hold on top
    });

    it('a press inside the tail keeps transmitting without a gap', async () => {
      await inPtt(500);
      hold(true);
      hold(false);
      await vi.advanceTimersByTimeAsync(200);
      hold(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(track()?.enabled).toBe(true);
      expect(useVoice.getState().pttDown).toBe(true);
    });

    it('toggle-off (immediate) ignores the delay', async () => {
      await inPtt(2000, 'toggle');
      hold(true);
      hold(false, true);
      expect(track()?.enabled).toBe(false);
      expect(useVoice.getState().pttDown).toBe(false);
    });

    it('RNNoise follows the air: on from key-down through the tail, off after (docs/14)', async () => {
      await inPtt(200);
      const denoise = () => pipelines.at(-1)?.setDenoise.mock.calls.at(-1)?.[0] as string | undefined;
      expect(denoise()).toBe('off');
      hold(true);
      expect(denoise()).toBe('on'); // synchronously with the key, before the first word
      hold(false);
      expect(denoise()).toBe('on'); // the release tail is still on air
      await vi.advanceTimersByTimeAsync(200);
      expect(denoise()).toBe('off');
    });

    it('mute during the tail ends it at once', async () => {
      await inPtt(2000);
      hold(true);
      hold(false);
      voice.toggleMute();
      expect(useVoice.getState().pttDown).toBe(false);
      expect(useVoice.getState().transmitting).toBe(false);
    });
  });

  it('resetPtt clears a stuck key (review M6)', async () => {
    await voice.join('A', 'ws');
    useVoice.setState({ pttDown: true });
    voice.resetPtt();
    expect(useVoice.getState().pttDown).toBe(false);
  });

  it('primaryCamera never picks a hidden camera: PiP, grid and «Экономить трафик» agree (review M1)', () => {
    const cam = (userId: string) => ({ trackSid: `TR_${userId}`, identity: `${userId}:s`, userId });
    useVoice.setState({ cameras: [cam('a'), cam('b')], activeSpeaker: 'a' });
    expect(voice.primaryCamera()).toBe('a');
    usePrefs.getState().setPrefs({ hiddenVideo: { a: true } });
    expect(voice.primaryCamera()).toBe('b');
    usePrefs.getState().setPrefs({ hiddenVideo: { a: true, b: true } });
    expect(voice.primaryCamera()).toBeNull();
    usePrefs.getState().setPrefs({ hiddenVideo: {} });
  });

  it('the active speaker for video switches only after 2 s of continuous speech (review M2)', async () => {
    await voice.join('A', 'ws');
    const room = FakeRoom.all[0];
    const p = (id: string) => ({ identity: `${id}:s` });
    room?.emit('ActiveSpeakersChanged', [p('b')]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(useVoice.getState().speaking['b']).toBe(true);
    expect(useVoice.getState().activeSpeaker).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVoice.getState().activeSpeaker).toBe('b');
    // A short interjection by c does not take the picture.
    room?.emit('ActiveSpeakersChanged', [p('c')]);
    await vi.advanceTimersByTimeAsync(800);
    room?.emit('ActiveSpeakersChanged', []);
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().activeSpeaker).toBe('b');
  });
});

describe('per-user volume and local mute (docs/09 #20)', () => {
  /**
   * A fake remote <audio>: muted / volume, `volumechange` listeners, `setSinkId` — which can
   * drop the element back to audible like a renderer rebuilt on a device switch (`resetOnSink`).
   */
  class FakeAudioEl {
    volume = 1;
    muted = false;
    sinkId = '';
    resetOnSink = false;
    setSinkId(id: string): Promise<void> {
      this.sinkId = id;
      if (this.resetOnSink) {
        this.muted = false;
        this.volume = 1;
      }
      return Promise.resolve();
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    remove(): void {}
  }
  /** A remote audio track of `identity`; attach() returns a fake <audio>. */
  const subscribe = (room: FakeRoom | undefined, identity: string, sid: string, source = 'microphone'): FakeAudioEl => {
    const el = new FakeAudioEl();
    const track = { kind: 'audio', sid, attach: () => el, detach: () => [el] };
    room?.emit('TrackSubscribed', track, { source }, { identity });
    return el;
  };

  describe('deafen holds on every path (docs/09 #70)', () => {
    it('deafen → output device switch (prefs, OS devicechange, LiveKit) → every element muted', async () => {
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      const a = subscribe(room, 'u2:phone', 'TR_a');
      const b = subscribe(room, 'u3:desk', 'TR_b', 'screen_share_audio');
      voice.toggleDeafen();
      expect([a.muted, b.muted]).toEqual([true, true]);
      a.resetOnSink = true;
      b.resetOnSink = true;
      // The chosen output changes in Settings.
      usePrefs.getState().setPrefs({ outputDeviceId: 'usb' });
      await settle();
      expect([a.sinkId, b.sinkId, a.muted, b.muted]).toEqual(['usb', 'usb', true, true]);
      // macOS moves the default output (charger / dock): devicechange.
      a.muted = false;
      for (const fn of deviceChange) fn();
      await settle();
      expect([a.muted, b.muted]).toEqual([true, true]);
      // LiveKit re-selected the output itself and hit our elements.
      b.muted = false;
      room?.emit('ActiveDeviceChanged', 'audiooutput', 'default');
      await settle();
      expect([a.sinkId, b.sinkId, a.muted, b.muted]).toEqual(['usb', 'usb', true, true]);
      usePrefs.getState().setPrefs({ outputDeviceId: null });
    });

    it('deafen → a new participant joins → muted from the start', async () => {
      await voice.join('A', 'ws');
      voice.toggleDeafen();
      const late = subscribe(FakeRoom.all.at(-1), 'u4:laptop', 'TR_late');
      expect(late.muted).toBe(true);
      await settle();
      expect(late.muted).toBe(true);
    });

    it('undeafen brings the per-user volumes and «mute for me» back', async () => {
      usePrefs.getState().setPrefs({ userVolumes: { u2: 0.5 }, mutedUsers: { u3: true }, outputVolume: 1 });
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      const a = subscribe(room, 'u2:phone', 'TR_a');
      const b = subscribe(room, 'u3:desk', 'TR_b');
      voice.toggleDeafen();
      expect([a.muted, b.muted]).toEqual([true, true]);
      voice.toggleDeafen();
      expect([a.muted, a.volume, b.muted]).toEqual([false, 0.5, true]);
      usePrefs.getState().setPrefs({ userVolumes: {}, mutedUsers: {} });
    });

    it('a mic muted before deafen stays muted after it (#11); the mic button lifts both', async () => {
      await voice.join('A', 'ws');
      voice.toggleMute();
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false });
      voice.toggleMute(); // mic on
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false });
      voice.toggleMute(); // remember a manual mute for this deafen cycle
      voice.toggleDeafen();
      voice.toggleMute(); // the mic button while deafened: both off (Discord)
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false });
      voice.toggleDeafen();
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false });
    });

    it('PTT while deafened: nothing on air, no activation sound (#12)', async () => {
      usePrefs.getState().setPrefs({ micMode: 'ptt', pttReleaseMs: 0, pttBinding: { kind: 'key', code: 66, label: 'F8', mode: 'hold' } });
      await voice.join('A', 'ws');
      await settle();
      const hold = (down: boolean): void => (voice as unknown as { onPtt(ev: { down: boolean }): void }).onPtt({ down });
      voice.toggleDeafen();
      playSound.mockClear();
      hold(true);
      await settle();
      expect(useVoice.getState()).toMatchObject({ pttDown: false, transmitting: false });
      expect(FakeRoom.all.at(-1)?.published[0]?.mediaStreamTrack.enabled).toBe(false);
      hold(false);
      expect(playSound).not.toHaveBeenCalled();
      // Held when deafen goes on: off at once, without the «mic off» cue.
      voice.toggleDeafen();
      hold(true);
      expect(playSound).toHaveBeenLastCalledWith('pttOn');
      playSound.mockClear();
      voice.toggleDeafen();
      expect(useVoice.getState().pttDown).toBe(false);
      expect(playSound.mock.calls.map((c) => c[0])).toEqual(['deafen']);
      usePrefs.getState().setPrefs({ micMode: 'voice' });
    });
  });

  it('applies to every audio element of the person: on subscribe, on change, after a reconnect', async () => {
    usePrefs.getState().setPrefs({ userVolumes: { u2: 0.5 }, outputVolume: 1 });
    await voice.join('A', 'ws');
    const mic = subscribe(FakeRoom.all.at(-1), 'u2:phone', 'TR_mic');
    const other = subscribe(FakeRoom.all.at(-1), 'u3:desk', 'TR_other');
    expect(mic.volume).toBe(0.5);
    expect(other.volume).toBe(1);

    // 200 %: element.volume stops at 1 — it only offsets the headphones ▾ volume (no WebAudio).
    voice.setUserVolume('u2', 2);
    expect(mic.volume).toBe(1);
    usePrefs.getState().setPrefs({ outputVolume: 0.25 });
    expect(mic.volume).toBe(0.5);
    expect(other.volume).toBe(0.25);

    // Their stream's sound follows their volume too, not the headphones ▾ one.
    voice.setUserVolume('u2', 0.5);
    voice.setStreamVolume('u2', 0.8);
    const screen = subscribe(FakeRoom.all.at(-1), 'u2:phone', 'TR_screen', 'screen_share_audio');
    expect(screen.volume).toBeCloseTo(0.4);

    // «Заглушить»: their voice only, applied at once; «Не слышать» silences the stream too.
    voice.setUserMuted('u2', true);
    expect(mic.muted).toBe(true);
    expect(screen.muted).toBe(false);
    expect(other.muted).toBe(false);

    // A new call (or a rejoin) attaches new elements: the stored choice applies to them.
    await voice.join('B', 'ws');
    const again = subscribe(FakeRoom.all.at(-1), 'u2:phone', 'TR_mic2');
    expect(again.muted).toBe(true);
    expect(again.volume).toBeCloseTo(0.125);
    voice.setUserMuted('u2', false);
    expect(again.muted).toBe(false);
    expect(usePrefs.getState().mutedUsers).toEqual({});
  });
});

describe('VOICE_MOVED (ADR-0019)', () => {
  const move = (over: Partial<Parameters<Engine['onMoved']>[0]> = {}): Parameters<Engine['onMoved']>[0] => ({
    workspaceId: 'ws',
    fromRoomId: 'A',
    toRoomId: 'B',
    byUserId: '',
    url: 'wss://lk-move',
    token: 'tok-B',
    sessionId: '',
    identity: '',
    ...over,
  });
  const roomNamed = async (id: string, name: string): Promise<void> => {
    const { useRooms } = await import('../stores/rooms');
    useRooms.setState({ byId: { ...useRooms.getState().byId, [id]: { id, name } as never } });
  };

  it('with a token: old room dropped, target connected with it, no /join, mute + deafen kept, stream stopped', async () => {
    await roomNamed('B', 'Кухня');
    await voice.join('A', 'ws');
    voice.toggleMute();
    voice.toggleDeafen();
    await settle();
    useVoice.setState({ myStream: { sourceName: 'Screen', preset: 0 as never, hasAudio: false, audioError: null, viewers: 0 } });
    expect(voice.onMoved(move())).toBe(true);
    await settle();
    await settle();
    expect(FakeRoom.all[0]?.disconnects).toEqual([false]);
    expect(FakeRoom.all[1]?.connectedWith).toEqual(['wss://lk-move', 'tok-B']);
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A']); // no /join for the target
    const v = useVoice.getState();
    expect(v.roomId).toBe('B');
    expect(voice.currentRoomId).toBe('B');
    expect(v.phase).toBe('connected');
    expect(v.muted).toBe(true);
    expect(v.deafened).toBe(true);
    expect(v.myStream).toBeNull();
    expect(FakeRoom.all[1]?.published).toHaveLength(1);
    expect(FakeRoom.all[1]?.published[0]?.isMuted).toBe(true); // re-published, explicitly muted
    const { toast } = await import('../stores/toasts');
    expect(toast.info).toHaveBeenCalledWith('Вас переместили в «Кухня»; стрим остановлен');
    voice.toggleDeafen();
    await settle();
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false });
    expect(FakeRoom.all[1]?.published[0]?.isMuted).toBe(true);
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false });
  });

  it('with a token, not streaming: short toast, the server mute survives the reconnect', async () => {
    await roomNamed('B', 'Кухня');
    await voice.join('A', 'ws');
    useVoice.setState({ muted: true, serverMuted: true });
    expect(voice.onMoved(move())).toBe(true);
    await settle();
    await settle();
    expect(useVoice.getState().serverMuted).toBe(true);
    expect(useVoice.getState().muted).toBe(true);
    const { toast } = await import('../stores/toasts');
    expect(toast.info).toHaveBeenCalledWith('Вас переместили в «Кухня»');
  });

  it('without a token (SFU move): the old path — room id switched, /join rejoin after 4 s if LiveKit did not move us', async () => {
    await voice.join('A', 'ws');
    const room = FakeRoom.all[0];
    if (room) room.name = 'ws:A';
    expect(voice.onMoved(move({ url: '', token: '' }))).toBe(false);
    expect(useVoice.getState().roomId).toBe('B');
    expect(FakeRoom.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    await settle();
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(voice.currentRoomId).toBe('B');
  });

  it('a leave in progress wins: a move arriving meanwhile is ignored', async () => {
    await voice.join('A', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    const leaving = voice.leave();
    expect(voice.onMoved(move())).toBe(false);
    FakeRoom.disconnectGate = null;
    release();
    await leaving;
    await settle();
    expect(useVoice.getState().phase).toBe('idle');
    expect(voice.currentRoomId).toBeNull();
    expect(FakeRoom.all).toHaveLength(1);
  });

  it('a leave right after the move wins over the reconnect', async () => {
    await voice.join('A', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    expect(voice.onMoved(move())).toBe(true);
    await settle();
    const leaving = voice.leave();
    FakeRoom.disconnectGate = null;
    release();
    await leaving;
    await settle();
    expect(useVoice.getState().phase).toBe('idle');
    expect(voice.currentRoomId).toBeNull();
    expect(FakeRoom.all).toHaveLength(1); // never connected to the target
  });

  it('the move token is refused: one /join fallback into the target, mute / deafen / server mute kept', async () => {
    await voice.join('A', 'ws');
    voice.toggleDeafen();
    useVoice.setState({ muted: true, serverMuted: true });
    await settle();
    FakeRoom.onConnect = (token) => (token === 'tok-B' ? Promise.reject(new Error('token expired')) : Promise.resolve());
    expect(voice.onMoved(move())).toBe(true);
    await settle();
    await settle();
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(FakeRoom.all.map((r) => r.connectedWith?.[1])).toEqual(['t-A', 'tok-B', 't-B']);
    const v = useVoice.getState();
    expect(voice.currentRoomId).toBe('B');
    expect(v.phase).toBe('connected');
    expect(v.error).toBeNull();
    expect(v.muted).toBe(true);
    expect(v.deafened).toBe(true);
    expect(v.serverMuted).toBe(true);
  });

  it('the move token and the /join fallback both fail: exactly one fallback, then out of voice', async () => {
    await voice.join('A', 'ws');
    FakeRoom.onConnect = (token) => (token === 't-A' ? Promise.resolve() : Promise.reject(new Error('lk down')));
    expect(voice.onMoved(move())).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(FakeRoom.all).toHaveLength(3);
    expect(voice.currentRoomId).toBeNull();
    expect(useVoice.getState().phase).toBe('idle');
    expect(useVoice.getState().error).toBe('err');
  });

  it('«Отключиться» while the refused move is being cleaned up: no /join fallback', async () => {
    await voice.join('A', 'ws');
    let release!: () => void;
    FakeRoom.onConnect = (token) => {
      if (token !== 'tok-B') return Promise.resolve();
      FakeRoom.disconnectGate = new Promise<void>((r) => (release = r)); // slow teardown of the failed room
      return Promise.reject(new Error('token expired'));
    };
    expect(voice.onMoved(move())).toBe(true);
    await settle();
    const leaving = voice.leave();
    FakeRoom.disconnectGate = null;
    release();
    await leaving;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A']);
    expect(FakeRoom.all).toHaveLength(2);
    expect(voice.currentRoomId).toBeNull();
    expect(useVoice.getState().phase).toBe('idle');
  });

  it('«Отключиться» during a rejoin: a later move does not bring the user back into voice', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    expect(useVoice.getState().phase).toBe('reconnecting');
    await voice.leave();
    expect(voice.onMoved(move())).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(FakeRoom.all).toHaveLength(1);
    expect(voice.currentRoomId).toBeNull();
    expect(useVoice.getState().phase).toBe('idle');
  });

  it('a second move while the first one is still leaving the source room follows the second', async () => {
    await voice.join('A', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    expect(voice.onMoved(move())).toBe(true);
    await settle();
    expect(voice.onMoved(move({ fromRoomId: 'B', toRoomId: 'C', token: 'tok-C' }))).toBe(true);
    FakeRoom.disconnectGate = null;
    release();
    await settle();
    await settle();
    expect(voice.currentRoomId).toBe('C');
    expect(FakeRoom.all).toHaveLength(2); // never connected to B
    expect(FakeRoom.all[1]?.connectedWith).toEqual(['wss://lk-move', 'tok-C']);
    expect(useVoice.getState().phase).toBe('connected');
  });

  it('duplicates, other devices and moves to the current room are ignored', async () => {
    const { useSession } = await import('../stores/session');
    useSession.setState({ sessionId: 'mine' });
    await voice.join('A', 'ws');
    expect(voice.onMoved(move({ sessionId: 'other' }))).toBe(false);
    expect(voice.onMoved(move({ identity: 'u1:other' }))).toBe(false);
    expect(voice.onMoved(move({ toRoomId: 'A' }))).toBe(false);
    expect(voice.onMoved(move({ sessionId: 'mine', identity: 'u1:mine' }))).toBe(true);
    expect(voice.onMoved(move({ sessionId: 'mine' }))).toBe(false); // same event again
    await settle();
    await settle();
    expect(FakeRoom.all).toHaveLength(2);
    expect(voice.currentRoomId).toBe('B');
    expect(voice.onMoved(move({ token: 'tok-2' }))).toBe(false); // no longer in A
  });
});

describe('rights change during a call (docs/16)', () => {
  it('refreshRights: the stream / camera buttons follow my roles and the room without a rejoin', async () => {
    const { create } = await import('@bufbuild/protobuf');
    const { PERMISSION_BITS, PermissionTargetType, RoomPermissionOverrideSchema, RoomSchema, WorkspaceMemberSchema, WorkspaceRole, UserSchema } = await import('@calaba/protocol');
    const { useSession } = await import('../stores/session');
    const { useRooms } = await import('../stores/rooms');
    const { useWorkspaces } = await import('../stores/workspaces');
    const { legacyRoles } = await import('../lib/roles');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
    const me = create(WorkspaceMemberSchema, { workspaceId: 'ws', role: WorkspaceRole.MEMBER, roleIds: ['member'], user: create(UserSchema, { id: 'u1' }) });
    useWorkspaces.setState({ byId: { ws: { ws: {} as never, role: WorkspaceRole.MEMBER, members: { u1: me }, roles: legacyRoles('ws'), voice: {} } } });
    const room = (deny: bigint) =>
      create(RoomSchema, {
        id: 'A',
        workspaceId: 'ws',
        media: { cameraLimit: 2 },
        permissionOverrides: [create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', deny })],
      });
    useRooms.setState({ byId: { A: room(0n) } });
    await voice.join('A', 'ws');
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', canStream: true });
    // ROOM_PERMISSIONS_UPDATE: the member role loses STREAM and VIDEO here.
    useRooms.setState({ byId: { A: room(PERMISSION_BITS.STREAM | PERMISSION_BITS.VIDEO) } });
    voice.refreshRights();
    expect(useVoice.getState()).toMatchObject({ canStream: false, canVideo: false });
    // Promoted to admin (WORKSPACE_MEMBER_UPDATE): ADMINISTRATOR ignores the deny.
    const entry = useWorkspaces.getState().byId.ws;
    if (!entry) throw new Error('no workspace');
    useWorkspaces.setState({ byId: { ws: { ...entry, members: { u1: { ...me, role: WorkspaceRole.ADMIN, roleIds: ['admin', 'member'] } } } } });
    voice.refreshRights();
    expect(useVoice.getState()).toMatchObject({ canStream: true, canVideo: true });
    // Not in a call: nothing to refresh.
    await voice.leave();
    useVoice.setState({ canStream: false });
    voice.refreshRights();
    expect(useVoice.getState().canStream).toBe(false);
  });
});

describe('defaultStage (docs/09 #56)', () => {
  it('expands a new stream over a (nearly) empty chat, remembers the per-room choice', async () => {
    const { defaultStage } = await import('./voice');
    const { useMessages } = await import('../stores/messages');
    const { usePrefs: prefs } = await import('../stores/prefs');
    const { useRooms } = await import('../stores/rooms');
    prefs.setState({ streamStage: {} });
    expect(defaultStage(null)).toBe('pip');
    // Not loaded yet: no last message → empty → expanded; a last message → treat as a chat.
    useRooms.setState({ lastMessage: {} });
    expect(defaultStage('r1')).toBe('expanded');
    useRooms.setState({ lastMessage: { r1: 'm9' } });
    expect(defaultStage('r1')).toBe('pip');
    const msg = (id: string) => ({ id }) as never;
    const base = { hasMoreAfter: false, loading: false, loaded: true, error: null };
    useMessages.setState({ rooms: { r1: { ...base, items: [msg('a'), msg('b')], hasMoreBefore: false } } } as never);
    expect(defaultStage('r1')).toBe('expanded');
    useMessages.setState({ rooms: { r1: { ...base, items: [msg('a'), msg('b'), msg('c')], hasMoreBefore: false } } } as never);
    expect(defaultStage('r1')).toBe('pip');
    prefs.setState({ streamStage: { r1: 'expanded' } });
    expect(defaultStage('r1')).toBe('expanded');
  });
});

describe('own stream (docs/09 #18a)', () => {
  it('is listed from the local track (no subscription), watched like the others, gone after stop', async () => {
    await voice.join('A', 'ws');
    await settle();
    usePrefs.setState({ streamStage: { A: 'pip' } });
    const video = { sid: 'TR_mine', mediaStreamTrack: {} };
    const stop = vi.fn(() => Promise.resolve());
    const engine = voice as unknown as { screen: unknown; refreshStreams(): void };
    engine.screen = { video, audio: null, stop };
    engine.refreshStreams();
    let v = useVoice.getState();
    expect(v.streams).toEqual([{ trackSid: 'TR_mine', identity: 'u1:mine', userId: 'u1', hasAudio: false, local: true }]);
    expect(v.watching).toBe('TR_mine');
    expect(v.stage).toBe('pip');
    expect(voice.streamVideo('TR_mine')).toBe(video);
    await voice.stopStream();
    v = useVoice.getState();
    expect(stop).toHaveBeenCalled();
    expect(v.streams).toEqual([]);
    expect(v.watching).toBeNull();
    expect(voice.streamVideo('TR_mine')).toBeNull();
  });
});

describe('stream codec (ADR-0032)', () => {
  it('publishes with the codec pickPublishCodec chose for the «Кодек стрима» setting', async () => {
    await voice.join('A', 'ws');
    await settle();
    const source = { id: 'screen:1', name: 'Screen' };
    for (const [pref, codec] of [['auto', 'h264'], ['av1', 'av1'], ['h264', 'h264']] as const) {
      usePrefs.setState({ streamCodec: pref });
      startScreenShare.mockClear();
      pickPublishCodec.mockClear();
      await voice.startStream({ source, preset: 2, contentHint: 'detail', systemAudio: false });
      expect(pickPublishCodec).toHaveBeenCalledWith('screen', pref);
      expect(startScreenShare).toHaveBeenCalledTimes(1);
      expect(startScreenShare.mock.calls[0]?.[1]).toMatchObject({ codec, preset: 2, contentHint: 'detail' });
    }
  });
});
