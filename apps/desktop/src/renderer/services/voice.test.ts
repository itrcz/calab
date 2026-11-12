import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { VoiceDisconnectReason } from '@calaba/protocol';
import type { HostCallAudioCapability, HostAudioConnect, HostAudioState } from '../../shared/hostCallAudio';
import type { HostRoomAudioCapability, HostRoomAudioConnect, HostRoomAudioCue, HostRoomAudioState, HostRoomAudioStatus } from '../../shared/hostRoomAudio';

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
/** One fake BroadcastChannel per engine (#40): Node's real one would cross-talk between the engines of resetModules. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown): void {
    this.sent.push(data);
  }
}
vi.stubGlobal('BroadcastChannel', FakeChannel);
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
  /** The RTCRtpSender once published (the voice tier is applied to it live). */
  sender = {};
  stopped = false;
  replaced: FakeTrack[] = [];
  /** Pending mute/unmute resolvers (tests settle them to simulate LiveKit's async lock). */
  static lockMs = 0;
  /** The next N mute/unmute calls reject (a signalling failure during Reconnecting). */
  static failOps = 0;
  /** The next N mute/unmute calls never settle (a lock held across a dead link). */
  static hangOps = 0;
  static ops = 0;
  constructor(public mediaStreamTrack: FakeTrack) {
    // LiveKit's constructor syncs `enabled` with its (unmuted) state.
    mediaStreamTrack.enabled = true;
  }
  private async op(): Promise<void> {
    FakeLocalAudioTrack.ops++;
    if (FakeLocalAudioTrack.hangOps > 0) {
      FakeLocalAudioTrack.hangOps--;
      await new Promise(() => undefined);
    }
    await new Promise((r) => setTimeout(r, FakeLocalAudioTrack.lockMs));
    if (FakeLocalAudioTrack.failOps > 0) {
      FakeLocalAudioTrack.failOps--;
      throw new Error('signal not connected');
    }
  }
  async mute(): Promise<void> {
    await this.op();
    this.isMuted = true;
    this.mediaStreamTrack.enabled = false;
  }
  async unmute(): Promise<void> {
    await this.op();
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
    // As LiveKit's setMediaStreamTrack: the new track's `enabled` follows the LiveKit mute only,
    // whatever the caller set before (the VAD / PTT gate is ours to re-apply).
    t.enabled = !this.isMuted;
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
  /** Autoplay allowed (Room.canPlaybackAudio); startAudio() is the tap's unlock. */
  canPlaybackAudio = true;
  startAudio = vi.fn(() => {
    this.canPlaybackAudio = true;
    return Promise.resolve();
  });
  localParticipant = {
    identity: 'u1:mine',
    permissions: undefined as undefined | { canPublish: boolean; canPublishSources: number[] },
    publishTrack: vi.fn((t: FakeLocalAudioTrack, _opts?: unknown) => {
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
  /** RoomOptions as given (audioOutput: what LiveKit applies to new remote tracks). */
  options: { audioOutput?: { deviceId?: string } };
  /** LiveKit's active devices (localParticipant.activeDeviceMap). */
  active = new Map<string, string>([['audiooutput', 'default']]);
  switches: [string, string][] = [];
  getActiveDevice(kind: string): string | undefined {
    return this.active.get(kind);
  }
  /** As livekit-client: options + active device, then ActiveDeviceChanged (its setSinkId is ours: same id). */
  switchActiveDevice(kind: string, id: string): Promise<boolean> {
    this.switches.push([kind, id]);
    this.options.audioOutput = { deviceId: id };
    this.active.set(kind, id);
    this.emit('ActiveDeviceChanged', kind, id);
    return Promise.resolve(true);
  }
  constructor(opts?: { audioOutput?: { deviceId?: string } }) {
    this.options = { ...opts };
    FakeRoom.all.push(this);
    // Local publications (a parked room unpublishes them, ADR-0133).
    Object.defineProperty(this.localParticipant, 'trackPublications', { get: () => new Map(this.published.map((t, i) => [`L${i}`, { track: t }])) });
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
    if (!FakeRoom.onConnect) return Promise.resolve();
    // As livekit-client: a failed connect emits Disconnected (the state was Connecting) before it rejects.
    return FakeRoom.onConnect(token).catch((e: unknown) => {
      this.state = 'Disconnected';
      this.emit('Disconnected', 'UNKNOWN_REASON');
      throw e;
    });
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
  Track: { Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' }, Kind: { Audio: 'audio', Video: 'video' } },
  VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
}));

// ---------------------------------------------------------------- app mocks

const joinVoice = vi.fn((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } }));
const updateSelf = vi.fn((_b: { muted?: boolean; deafened?: boolean; musician?: boolean; ptt?: boolean }) => Promise.resolve());
const leaveVoice = vi.fn((_roomId: string) => Promise.resolve());
/** PUT /api/me/voice-mute (ADR-0168): answers with the server's time. */
const setVoiceMute = vi.fn((b: { muted: boolean; deafened: boolean }) => Promise.resolve({ ...b, updatedAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 1), nanos: 0 } }));
const requestStream = vi.fn((_roomId: string, preset: number) => Promise.resolve({ preset, fps: 0 }));
/** POST /rooms/{id}/voice/companion (ADR-0149 §3). */
const companionToken = vi.fn((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `companion-${roomId}`, identity: 'u:s:web' }));
vi.mock('../lib/api/endpoints', () => ({
  api: {
    voice: {
      join: (id: string) => joinVoice(id),
      leave: (id: string) => leaveVoice(id),
      updateSelf: (b: { muted?: boolean; deafened?: boolean; musician?: boolean; ptt?: boolean }) => updateSelf(b),
      requestStream: (id: string, preset: number) => requestStream(id, preset),
      companion: (id: string) => companionToken(id),
    },
    me: { update: () => Promise.resolve({}), setVoiceMute: (b: { muted: boolean; deafened: boolean }) => setVoiceMute(b) },
  },
}));

interface FakePipeline {
  track: FakeTrack;
  stop: ReturnType<typeof vi.fn>;
  deviceId: string | null;
  deviceLabel: string;
  rnnoise: boolean;
  /** Musician-mode capture (ADR-0052) and the published channels. */
  musician: boolean;
  channels: number;
  /** MicPipeline.duckable: a gain stage exists (RNNoise on or a speakerphone mode). */
  duckable: boolean;
  isDucked: boolean;
  setDuck: ReturnType<typeof vi.fn>;
  setDenoise: ReturnType<typeof vi.fn>;
  /** Capture health: tests flip `ctx` / `muted` and fire onMute / onContextState. */
  ctx: string;
  muted: boolean;
  reportAt: number | null;
  health: () => { ctx: string; ended: boolean; muted: boolean; reportAgeMs: number | null };
  resumeContext: ReturnType<typeof vi.fn>;
  onMute?: (muted: boolean) => void;
  onContextState?: (state: string) => void;
  onEnded?: () => void;
  /** The worklet's 20 ms level / VAD reports (tests feed speech and silence through it). */
  onReport?: (r: { rms: number; vad: number }) => void;
}
/** Device ids that are unplugged (getUserMedia with {exact} fails). */
const gone = new Set<string>();
const pipelines: FakePipeline[] = [];
let gate: Promise<void> | null = null; // when set, MicPipeline.start waits for it
/** MicPipeline.start calls, and an error the next one throws (the system holds the device). */
const micStarts = vi.hoisted(() => ({ n: 0, failNext: null as Error | null }));
vi.mock('../lib/media/micPipeline', () => ({
  MicPipeline: {
    start: vi.fn(async (opts: { deviceId: string | null; rnnoise: boolean; musician?: boolean; duckable?: boolean; onEnded?: () => void; onReport?: (r: { rms: number; vad: number }) => void; onMute?: (muted: boolean) => void; onContextState?: (state: string) => void }) => {
      micStarts.n++;
      if (gate) await gate;
      if (micStarts.failNext) {
        const e = micStarts.failNext;
        micStarts.failNext = null;
        throw e;
      }
      if (opts.deviceId && gone.has(opts.deviceId)) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      const track = new FakeTrack();
      const p: FakePipeline = {
        track,
        deviceId: opts.deviceId,
        deviceLabel: opts.deviceId ?? 'Default - Built-in Mic',
        rnnoise: opts.rnnoise && opts.musician !== true,
        musician: opts.musician === true,
        channels: 1,
        duckable: opts.rnnoise || opts.duckable === true,
        isDucked: false,
        setDuck: vi.fn(),
        setDenoise: vi.fn(),
        ctx: 'running',
        muted: false,
        reportAt: null,
        health: () => ({ ctx: p.ctx, ended: track.readyState === 'ended', muted: p.muted, reportAgeMs: p.reportAt === null ? null : Date.now() - p.reportAt }),
        resumeContext: vi.fn(() => {
          if (p.ctx !== 'closed') p.ctx = 'running';
          return Promise.resolve(p.ctx === 'running');
        }),
        stop: vi.fn(() => track.stop()),
        ...(opts.onMute ? { onMute: opts.onMute } : {}),
        ...(opts.onContextState ? { onContextState: opts.onContextState } : {}),
        ...(opts.onEnded ? { onEnded: opts.onEnded } : {}),
        ...(opts.onReport ? { onReport: opts.onReport } : {}),
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
/** The voice tier re-applied to the published mic (lib/media/opusTierPublish.ts). */
const applyMicTier = vi.fn((_room: unknown, _sender: unknown, _tier: { kbps: number; dtx?: boolean; stereo?: boolean }) => Promise.resolve());
vi.mock('../lib/media/opusTierPublish', () => ({
  installOpusTierHook: () => () => undefined,
  applyMicTier: (r: unknown, s: unknown, t: { kbps: number; dtx?: boolean; stereo?: boolean }) => applyMicTier(r, s, t),
}));
const playSound = vi.fn((_name: string) => undefined);
const phone = vi.hoisted(() => ({ on: false }));
vi.mock('../lib/mobile', () => ({ isMobileNow: () => phone.on }));
/** The cue route a native-audio room installs (lib/sounds routeCues). */
const cues = vi.hoisted(() => ({ route: null as ((cue: string, volume: number) => void) | null }));
vi.mock('../lib/sounds', () => ({
  playSound: (name: string) => (cues.route ? cues.route(name, 1) : playSound(name)),
  routeCues: (route: ((cue: string, volume: number) => void) | null) => { cues.route = route; },
}));
/** The toast store stand-in: what is on screen (ids), so «raised once while shown» can be told. */
const shown = vi.hoisted(() => ({ ids: [] as number[], next: 1 }));
const pushToast = vi.hoisted(() =>
  vi.fn((..._a: unknown[]) => {
    const id = shown.next++;
    shown.ids.push(id);
    return id;
  }),
);
const dismissToast = vi.hoisted(() =>
  vi.fn((id: number) => {
    shown.ids = shown.ids.filter((x) => x !== id);
  }),
);
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() }, useToasts: { getState: () => ({ items: shown.ids.map((id) => ({ id })), push: pushToast, dismiss: dismissToast }) } }));
const announce = vi.fn();
vi.mock('./deviceToast', () => ({ announceDeviceSwitch: (...a: unknown[]) => void announce(...a) }));
const reportMediaError = vi.fn(() => ({ text: 'err', action: null }));
vi.mock('./mediaErrors', () => ({
  humanMediaError: () => ({ text: 'err', action: null }),
  reportMediaError: () => reportMediaError(),
}));
/** platform.ptt.setBinding: the binding the engine asks main for (null = unbound). */
const setBinding = vi.fn((_b: unknown) => Promise.resolve({}));
const nativeHost = vi.hoisted(() => ({ audio: undefined as HostCallAudioCapability | undefined, room: undefined as HostRoomAudioCapability | undefined }));
vi.mock('../platform', () => ({
  platform: {
    kind: 'web',
    get incomingCalls() { return { audio: nativeHost.audio }; },
    get roomAudio() { return nativeHost.room; },
    ptt: { onEvent: () => () => undefined, setBinding: (b: unknown) => setBinding(b) },
    tray: { setState: () => undefined },
    system: { metrics: () => Promise.resolve({ rendererCpu: null }) },
    app: { log: () => undefined },
  },
}));

type Engine = (typeof import('./voice'))['voice'];
let voice: Engine;
let useVoice: (typeof import('../stores/voice'))['useVoice'];
let usePrefs: (typeof import('../stores/prefs'))['usePrefs'];

/** The rejoin backoff carries ±25 % jitter (rejoinDelay); the timings asserted below are its middle. */
let randomSpy: MockInstance<() => number> | null = null;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeRoom.all = [];
  FakeChannel.all = [];
  FakeLocalAudioTrack.lockMs = 0;
  FakeLocalAudioTrack.failOps = 0;
  FakeLocalAudioTrack.hangOps = 0;
  FakeLocalAudioTrack.ops = 0;
  FakeLocalAudioTrack.failReplace = false;
  FakeRoom.disconnectGate = null;
  FakeRoom.onConnect = null;
  nativeHost.audio = undefined;
  nativeHost.room = undefined;
  cues.route = null;
  pipelines.length = 0;
  gate = null;
  micStarts.n = 0;
  micStarts.failNext = null;
  gone.clear();
  joinVoice.mockClear();
  setVoiceMute.mockClear();
  mem.delete('calab-voice-mute'); // ADR-0168: no stored choice leaks between tests
  companionToken.mockClear();
  leaveVoice.mockReset();
  leaveVoice.mockImplementation(() => Promise.resolve());
  updateSelf.mockReset();
  updateSelf.mockImplementation(() => Promise.resolve());
  reportMediaError.mockClear();
  deviceChange.length = 0;
  deviceList = [];
  announce.mockClear();
  playSound.mockClear();
  shown.ids = [];
  pushToast.mockClear();
  dismissToast.mockClear();
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
  randomSpy?.mockRestore();
  randomSpy = null;
});

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('native incoming call transport', () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  function host() {
    let input: HostAudioConnect;
    let listener: (s: HostAudioState) => void = () => undefined;
    const connected = (): HostAudioState => ({ eventId, connectionId: input.connectionId, phase: 'connected', microphoneReady: true, muted: false, canSpeak: true, speakers: [] });
    const disconnect = vi.fn(), control = vi.fn();
    const capability: HostCallAudioCapability = {
      connect: value => { input = value; return Promise.resolve(connected()); }, control, disconnect,
      subscribe: fn => { listener = fn; return () => { listener = () => undefined; }; },
    };
    nativeHost.audio = capability;
    return { capability, disconnect, control, input: () => input, emit: (s: Partial<HostAudioState>) => listener({ ...connected(), ...s }) };
  }
  it('uses one native room and preserves normal output volume without starting WebKit capture', async () => {
    const h = host();
    usePrefs.setState({ outputVolume: 0.75 });
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    expect(useVoice.getState()).toMatchObject({ roomId: 'dm', phase: 'connected', canVideo: false, canStream: false });
    expect(h.input().controls.volume).toBe(0.75);
    expect(FakeRoom.all).toHaveLength(0); expect(pipelines).toHaveLength(0);
    await voice.leave();
    expect(h.disconnect).toHaveBeenCalledWith(eventId, h.input().connectionId);
    expect(useVoice.getState().phase).toBe('idle');
  });
  it('does not create a second WebKit microphone from settings during a native call', async () => {
    host();
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    await voice.startMicTest();
    expect(pipelines).toHaveLength(0);
  });
  it('keeps an already connected native call settled when join is requested again', async () => {
    host();
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', joining: null });
    expect(joinVoice).toHaveBeenCalledOnce();
  });
  it('keeps ordinary rooms and calls without a native event on the existing web engine', async () => {
    const h = host();
    await voice.join('A', 'ws');
    await voice.join('dm', '', { call: true });
    expect(FakeRoom.all).toHaveLength(2);
    expect(h.input()).toBeUndefined();
  });
  it('sends shared mute/deafen settings to native audio and cannot lift moderator mute', async () => {
    const h = host();
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    voice.toggleMute();
    expect(h.control.mock.lastCall?.[2]).toMatchObject({ muted: true, deafened: false });
    voice.toggleDeafen();
    expect(h.control.mock.lastCall?.[2]).toMatchObject({ muted: true, deafened: true });
    useVoice.setState({ muted: true, serverMuted: true, deafened: false });
    expect(voice.setMuted(false)).toBe(false);
    expect(useVoice.getState().muted).toBe(true);
  });
  it('rejoins a lost native call with a fresh connection without starting a second retry after success', async () => {
    const h = host();
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    const first = h.input().connectionId;
    h.emit({ phase: 'failed', error: 'network' });
    await vi.advanceTimersByTimeAsync(1001);
    expect(useVoice.getState().phase).toBe('connected');
    expect(h.input().connectionId).not.toBe(first);
    expect(FakeRoom.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(joinVoice).toHaveBeenCalledTimes(2);
  });
  it('lets the server takeover event win before treating native participant removal as a hangup', async () => {
    const h = host();
    const { useSession } = await import('../stores/session');
    useSession.setState({ sessionId: 'mine' });
    await voice.join('dm', '', { call: true, nativeCallEvent: eventId });
    h.emit({ phase: 'failed', error: 'removed' });
    await settle();
    expect(useVoice.getState().roomId).toBe('dm');
    expect(voice.onServerDisconnect({ roomId: 'dm', sessionId: 'mine', reason: VoiceDisconnectReason.OTHER_DEVICE })).toBe(true);
    await settle();
    expect(voice.takenOverRoom).toBe('dm'); expect(useVoice.getState().phase).toBe('idle');
  });
});

describe('native room audio (ADR-0149)', () => {
  const doc = document as unknown as { hidden?: boolean };
  const setHidden = (hidden: boolean): void => {
    doc.hidden = hidden;
    for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
  };
  afterEach(() => {
    doc.hidden = false;
  });
  function host() {
    const inputs: HostRoomAudioConnect[] = [];
    const listeners = new Set<(s: HostRoomAudioState) => void>();
    const control = vi.fn((_id: string, _c: HostRoomAudioConnect['controls']) => Promise.resolve(true));
    const cue = vi.fn((_id: string, _cue: HostRoomAudioCue, _v: number) => undefined);
    const disconnect = vi.fn((_id: string) => undefined);
    const state = (s: Partial<HostRoomAudioState> = {}): HostRoomAudioState => ({
      connectionId: inputs.at(-1)?.connectionId ?? '', phase: 'connected', microphoneReady: true, muted: false, canSpeak: true,
      speaking: false, speakers: [], route: 'speaker', phoneCall: false, ...s,
    });
    let reply: (input: HostRoomAudioConnect) => HostRoomAudioStatus = () => ({ supported: true, media: state() });
    const capability: HostRoomAudioCapability = {
      connect: (input) => { inputs.push(input); return Promise.resolve(reply(input)); },
      status: () => Promise.resolve({ supported: true }),
      control, cue, disconnect,
      subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    };
    nativeHost.room = capability;
    return {
      inputs, control, cue, disconnect, state,
      emit: (s: Partial<HostRoomAudioState>) => { for (const fn of [...listeners]) fn(state(s)); },
      replyWith: (fn: (input: HostRoomAudioConnect) => HostRoomAudioStatus) => { reply = fn; },
      lastControls: () => control.mock.lastCall?.[1],
    };
  }

  it('one owner per join: native audio, no WebKit capture, no LiveKit Room, no video', async () => {
    const h = host();
    await voice.join('A', 'ws');
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatchObject({ roomId: 'A', url: 'wss://lk', canSpeak: true });
    expect(FakeRoom.all).toHaveLength(0);
    expect(pipelines).toHaveLength(0);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected', audioOnly: true, canVideo: false, canStream: false });
    await voice.startMicTest();
    expect(pipelines).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lastControls()?.levels).toBe(true);
    await voice.leave();
    expect(h.disconnect).toHaveBeenCalledWith(h.inputs[0]?.connectionId);
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', audioOnly: false });
    expect(cues.route).toBeNull();
    // No web cue after it: a WebKit <audio> would take the session native is releasing.
    expect(playSound).not.toHaveBeenCalled();
  });

  it('keeps calls and rooms without the capability on their own engines', async () => {
    const h = host();
    await voice.join('dm', '', { call: true });
    expect(FakeRoom.all).toHaveLength(1);
    expect(h.inputs).toHaveLength(0);
  });

  it('phone lines stay on the web path while the host reports roomAudioVersion 1 (ADR-0149 §1)', async () => {
    const { setPhoneJoin } = await import('../lib/sipInbound');
    const h = host();
    // A workspace id and no call flag: only the phone room itself keeps native out. Then as the app joins them (a call).
    for (const [roomId, call] of [['sipin:c1', false], ['sipout:c2', false], ['sipin:c3', true], ['sipout:c4', true]] as const) {
      setPhoneJoin(roomId, { url: 'wss://lk', token: 'tok', identity: 'me', canSpeak: true } as never);
      await voice.join(roomId, 'ws', call ? { call: true } : {});
      expect(FakeRoom.all.at(-1)?.connectedWith, roomId).not.toBeNull();
      expect(useVoice.getState(), roomId).toMatchObject({ roomId, audioOnly: false });
      await voice.leave();
    }
    expect(FakeRoom.all).toHaveLength(4);
    expect(h.inputs).toHaveLength(0);
    // A one-to-one call with a workspace id too: callMode alone keeps native out.
    await voice.join('dm', 'ws', { call: true });
    expect(FakeRoom.all).toHaveLength(5);
    expect(h.inputs).toHaveLength(0);
    await voice.leave();
    // The same host still takes an ordinary workspace room.
    await voice.join('A', 'ws');
    expect(h.inputs).toHaveLength(1);
  });

  it('controls follow the store: mute, deafen, PTT, volumes clamped to 1', async () => {
    const h = host();
    const peer = '55555555-5555-4555-8555-555555555555';
    usePrefs.setState({ userVolumes: { [peer]: 1.8 }, outputVolume: 0.5 });
    await voice.join('A', 'ws');
    expect(h.inputs[0]?.controls).toMatchObject({ volume: 0.5, userVolumes: { [peer]: 0.9 } });
    voice.toggleMute();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lastControls()).toMatchObject({ muted: true, deafened: false });
    voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lastControls()).toMatchObject({ deafened: true });
    usePrefs.setState({ userVolumes: { [peer]: 2 }, outputVolume: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lastControls()).toMatchObject({ volume: 1, userVolumes: {} });
    // UI cues went to native by name, never to an <audio>.
    expect(h.cue.mock.calls.map((c) => c[1])).toEqual(['join', 'mute', 'deafen']);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('maps native state into the store: reconnecting, the system holding the mic, speakers, a phone call, a kept mute', async () => {
    const h = host();
    const { useSession } = await import('../stores/session');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
    await voice.join('A', 'ws');
    h.emit({ phase: 'reconnecting' });
    expect(useVoice.getState().phase).toBe('reconnecting');
    h.emit({ phase: 'interrupted', microphoneReady: false, muted: true, muteOrigin: 'system', phoneCall: true });
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', micTrouble: 'recovering', muted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateSelf).toHaveBeenCalledWith(expect.objectContaining({ onPhone: true }));
    h.emit({ muted: true, muteOrigin: 'system', speakers: ['66666666-6666-4666-8666-666666666666'] });
    expect(useVoice.getState()).toMatchObject({ micTrouble: null, muted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateSelf).toHaveBeenCalledWith(expect.objectContaining({ onPhone: false }));
    await vi.advanceTimersByTimeAsync(200);
    expect(useVoice.getState().speaking).toMatchObject({ '66666666-6666-4666-8666-666666666666': true });
    expect(h.lastControls()?.muted).toBe(true);
  });

  it('keeps meter levels coming past native’s 30 s and shows silence when native sends none', async () => {
    const h = host();
    await voice.join('A', 'ws');
    await voice.startMicTest();
    await vi.advanceTimersByTimeAsync(200);
    h.control.mockClear();
    await vi.advanceTimersByTimeAsync(25_000 + 200);
    expect(h.control.mock.calls.map((c) => c[1].levels)).toEqual([false, true]);
    h.emit({ level: 10, speaking: true });
    expect(useVoice.getState()).toMatchObject({ levelDb: -40, gateOpen: true });
    h.emit({ muted: true, muteOrigin: 'web' });
    expect(useVoice.getState()).toMatchObject({ levelDb: -80, gateOpen: false });
    voice.stopMicTest();
    h.control.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.control.mock.calls.every((c) => !c[1].levels)).toBe(true);
  });

  it('already muted when a phone call ends: the controls go again so native lets its hold go', async () => {
    const h = host();
    await voice.join('A', 'ws');
    voice.toggleMute();
    await vi.advanceTimersByTimeAsync(200);
    const sent = h.control.mock.calls.length;
    h.emit({ phase: 'interrupted', microphoneReady: false, muted: true, muteOrigin: 'system', phoneCall: true });
    h.emit({ muted: true, muteOrigin: 'system' });
    h.emit({ muted: true, muteOrigin: 'system', speakers: ['66666666-6666-4666-8666-666666666666'] });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.control.mock.calls.length).toBe(sent + 1);
    expect(h.lastControls()).toMatchObject({ muted: true });
    expect(useVoice.getState().muted).toBe(true);
  });

  it('falls back to the web path once, before capture, after a drained native end', async () => {
    const h = host();
    h.replyWith((input) => ({ supported: true, media: h.state({ connectionId: input.connectionId, phase: 'failed', microphoneReady: false, error: 'connection' }) }));
    await voice.join('A', 'ws');
    expect(h.inputs).toHaveLength(1);
    expect(FakeRoom.all).toHaveLength(1);
    expect(pipelines).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', audioOnly: false });
    expect(joinVoice).toHaveBeenCalledOnce();
  });

  it('never falls back after a denied microphone or while the page is hidden', async () => {
    const h = host();
    h.replyWith((input) => ({ supported: true, media: h.state({ connectionId: input.connectionId, phase: 'failed', microphoneReady: false, error: 'permission' }) }));
    await voice.join('A', 'ws');
    expect(FakeRoom.all).toHaveLength(0);
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', error: 'err' });
    h.replyWith((input) => ({ supported: true, media: h.state({ connectionId: input.connectionId, phase: 'failed', microphoneReady: false, error: 'connection' }) }));
    doc.hidden = true;
    await voice.join('A', 'ws');
    expect(FakeRoom.all).toHaveLength(0);
  });

  it('a lost connection rejoins through REST with a fresh connect in foreground', async () => {
    const h = host();
    await voice.join('A', 'ws');
    const first = h.inputs[0]?.connectionId;
    h.emit({ phase: 'lost', error: 'network', microphoneReady: false });
    expect(useVoice.getState().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(0);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(h.inputs).toHaveLength(2);
    expect(h.inputs[1]?.connectionId).not.toBe(first);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    expect(FakeRoom.all).toHaveLength(0);
    expect(h.cue.mock.calls.map((c) => c[1])).toEqual(['join', 'reconnect']);
  });

  it('a lost connection while hidden waits for the page, then rejoins', async () => {
    const h = host();
    await voice.join('A', 'ws');
    setHidden(true);
    h.emit({ phase: 'lost', error: 'network', microphoneReady: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledOnce();
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'reconnecting' });
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(useVoice.getState().phase).toBe('connected');
  });

  it('a page back long after the seat ended leaves instead of rejoining', async () => {
    const h = host();
    await voice.join('A', 'ws');
    setHidden(true);
    h.emit({ phase: 'lost', error: 'network', microphoneReady: false });
    await vi.advanceTimersByTimeAsync(16 * 60_000); // past the 15 min rejoin bound (ADR-0166)
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(joinVoice).toHaveBeenCalledOnce();
    expect(leaveVoice).toHaveBeenCalledWith('A');
    expect(useVoice.getState().phase).toBe('idle');
  });

  it('skips the web recovery paths (#260): no rejoin under native reconnect, no seat-check rejoin, no page-back rejoin', async () => {
    const h = host();
    await voice.join('A', 'ws');
    setHidden(true);
    await vi.advanceTimersByTimeAsync(30_000);
    setHidden(false);
    h.emit({ phase: 'reconnecting' });
    voice.checkSeat();
    voice.onPageShow(true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(joinVoice).toHaveBeenCalledOnce();
    expect(FakeRoom.all).toHaveLength(0);
    expect(pipelines).toHaveLength(0);
    expect(pushToast).not.toHaveBeenCalled();
    h.emit({ phase: 'connected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(joinVoice).toHaveBeenCalledTimes(2); // the deferred seat check re-asserts the seat (idempotent /join)
    expect(h.inputs).toHaveLength(1);
  });

  it('musician mode stays off on a native join, with the reason', async () => {
    host();
    const { toast } = await import('../stores/toasts');
    await voice.join('A', 'ws');
    usePrefs.getState().setPrefs({ musicianMode: true });
    expect(usePrefs.getState().musicianMode).toBe(false);
    expect(toast.info).toHaveBeenCalled();
  });

  describe('companion video (ADR-0149 §3)', () => {
    const ME = '44444444-4444-4444-8444-444444444444';
    const PEER = '55555555-5555-4555-8555-555555555555';
    type VPub = { source: string; trackSid: string; kind: string; isMuted: boolean; isSubscribed: boolean; setSubscribed: ReturnType<typeof vi.fn>; setVideoQuality: ReturnType<typeof vi.fn>; setEnabled: () => void };
    const vpub = (source: string, trackSid: string, kind = 'video'): VPub => ({ source, trackSid, kind, isMuted: false, isSubscribed: false, setSubscribed: vi.fn(), setVideoQuality: vi.fn(), setEnabled: () => undefined });
    const participant = (identity: string, pubs: VPub[]) => ({
      identity,
      trackPublications: new Map(pubs.map((p) => [p.trackSid, p])),
      getTrackPublication: (source: string) => pubs.find((p) => p.source === source),
      getTrackPublicationBySid: (sid: string) => pubs.find((p) => p.trackSid === sid),
    });
    const publish = (room: FakeRoom, identity: string, pubs: VPub[]): void => {
      room.remoteParticipants.set(identity, participant(identity, pubs));
      for (const pub of pubs) room.emit('TrackPublished', pub, room.remoteParticipants.get(identity));
    };
    async function seats(states: Record<string, { camera?: boolean; streaming?: boolean }>): Promise<void> {
      const { useWorkspaces } = await import('../stores/workspaces');
      const voiceStates = Object.fromEntries(Object.entries(states).map(([id, v]) => [id, { userId: id, roomId: 'A', camera: false, streaming: false, ...v }]));
      useWorkspaces.setState({ byId: { ws: { ws: {}, voice: voiceStates } } as never });
      await settle();
    }
    async function joined(): Promise<ReturnType<typeof host>> {
      const h = host();
      usePrefs.setState({ userVolumes: {}, mutedUsers: {}, deafUsers: {}, outputVolume: 1 });
      const { useSession } = await import('../stores/session');
      useSession.setState({ me: { user: { id: ME } } } as never);
      await seats({ [ME]: {} });
      await voice.join('A', 'ws');
      return h;
    }
    const companionRoom = (): FakeRoom => {
      const r = FakeRoom.all.at(-1);
      if (!r) throw new Error('no companion');
      return r;
    };

    it('connects only while someone has a camera or a screen on; cameras show, my native identity is me', async () => {
      await joined();
      expect(FakeRoom.all).toHaveLength(0);
      expect(companionToken).not.toHaveBeenCalled();
      await seats({ [ME]: {}, [PEER]: { camera: true } });
      expect(companionToken).toHaveBeenCalledExactlyOnceWith('A');
      const room = companionRoom();
      expect(room.connectedWith).toEqual(['wss://lk', 'companion-A']);
      // My native device is in the companion's room too (and a camera of another device of mine): never a tile.
      publish(room, `${ME}:native`, [vpub('camera', 'TR_my_cam')]);
      const cam = vpub('camera', 'TR_peer_cam');
      publish(room, `${PEER}:dev`, [cam]);
      room.remoteParticipants.set(`${PEER}:dev:web`, participant(`${PEER}:dev:web`, []));
      expect(useVoice.getState().cameras.map((c) => c.userId)).toEqual([PEER]);
      expect(useVoice.getState()).toMatchObject({ audioOnly: true, videoDown: false, canVideo: false });
      voice.showCamera(PEER, 'high');
      await settle();
      expect(cam.setSubscribed).toHaveBeenLastCalledWith(true);
      // Leaving the room closes it with the join, without a call of its own.
      await voice.leave();
      expect(room.disconnects.length).toBeGreaterThan(0);
      expect(companionToken).toHaveBeenCalledOnce();
    });

    it('the watched screen share: video through the companion, its audio native with the stream volume, unwatched → gone', async () => {
      const h = await joined();
      await seats({ [ME]: {}, [PEER]: { streaming: true } });
      const room = companionRoom();
      const screen = vpub('screen_share', 'TR_screen');
      const screenAudio = vpub('screen_share_audio', 'TR_screen_audio', 'audio');
      const mic = vpub('microphone', 'TR_mic', 'audio');
      publish(room, `${PEER}:dev`, [screen, screenAudio, mic]);
      expect(useVoice.getState().watching).toBe('TR_screen');
      expect(screen.setSubscribed).toHaveBeenLastCalledWith(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({ [PEER]: 1 });
      voice.setStreamVolume(PEER, 0.4);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({ [PEER]: 0.4 });
      voice.watch(null);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({});
      expect(screen.setSubscribed).toHaveBeenLastCalledWith(false);
      // Never an audio kind on the companion: the WebView stays silent.
      expect(screenAudio.setSubscribed).not.toHaveBeenCalledWith(true);
      expect(mic.setSubscribed).not.toHaveBeenCalledWith(true);
    });

    it('background closes it at once, native keeps the watched stream’s audio; foreground brings the video back to it', async () => {
      const h = await joined();
      await seats({ [ME]: {}, [PEER]: { streaming: true } });
      publish(companionRoom(), `${PEER}:dev`, [vpub('screen_share', 'TR_screen')]);
      setHidden(true);
      expect(companionRoom().disconnects).toHaveLength(1);
      expect(useVoice.getState()).toMatchObject({ streams: [], watching: null });
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({ [PEER]: 1 });
      FakeRoom.onConnect = () => {
        const r = companionRoom();
        // Another stream comes first now: the held one is still the one watched.
        r.remoteParticipants.set('66666666-6666-4666-8666-666666666666:dev', participant('66666666-6666-4666-8666-666666666666:dev', [vpub('screen_share', 'TR_other')]));
        r.remoteParticipants.set(`${PEER}:dev`, participant(`${PEER}:dev`, [vpub('screen_share', 'TR_screen')]));
        return Promise.resolve();
      };
      setHidden(false);
      await settle();
      expect(FakeRoom.all).toHaveLength(2);
      expect(useVoice.getState().watching).toBe('TR_screen');
      // The stream ends while the page is away again: native lets its audio go.
      setHidden(true);
      await seats({ [ME]: {}, [PEER]: { streaming: false } });
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({});
    });

    it('a stream the user stopped watching stays unwatched after the page was away', async () => {
      const h = await joined();
      await seats({ [ME]: {}, [PEER]: { streaming: true } });
      publish(companionRoom(), `${PEER}:dev`, [vpub('screen_share', 'TR_screen')]);
      expect(useVoice.getState().watching).toBe('TR_screen');
      voice.watch(null);
      setHidden(true);
      FakeRoom.onConnect = () => {
        companionRoom().remoteParticipants.set(`${PEER}:dev`, participant(`${PEER}:dev`, [vpub('screen_share', 'TR_screen')]));
        return Promise.resolve();
      };
      setHidden(false);
      await settle();
      expect(FakeRoom.all).toHaveLength(2);
      expect(useVoice.getState()).toMatchObject({ watching: null, streams: [{ trackSid: 'TR_screen' }] });
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({});
    });

    it('held stream audio goes when the companion is not back 10 s after foreground, or is superseded', async () => {
      const h = await joined();
      await seats({ [ME]: {}, [PEER]: { streaming: true } });
      publish(companionRoom(), `${PEER}:dev`, [vpub('screen_share', 'TR_screen')]);
      setHidden(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({ [PEER]: 1 });
      companionToken.mockImplementationOnce(() => new Promise(() => undefined));
      setHidden(false);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.lastControls()?.watched).toEqual({ [PEER]: 1 });
      await vi.advanceTimersByTimeAsync(1_200);
      expect(h.lastControls()?.watched).toEqual({});
    });

    it('a companion that gives up lets the held stream audio go at once', async () => {
      const h = await joined();
      await seats({ [ME]: {}, [PEER]: { streaming: true } });
      publish(companionRoom(), `${PEER}:dev`, [vpub('screen_share', 'TR_screen')]);
      setHidden(true);
      const { ApiError } = await import('../lib/api/client');
      companionToken.mockImplementationOnce(() => Promise.reject(new ApiError('FORBIDDEN', 'no', 403)));
      setHidden(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(useVoice.getState().videoDown).toBe(true);
      expect(h.lastControls()?.watched).toEqual({});
    });

    it('a superseded companion lets the held stream audio go at once', async () => {
      const h = await joined();
      await seats({ [ME]: {}, [PEER]: { streaming: true } });
      publish(companionRoom(), `${PEER}:dev`, [vpub('screen_share', 'TR_screen')]);
      setHidden(true);
      FakeRoom.onConnect = () => {
        companionRoom().emit('Disconnected', 'DUPLICATE_IDENTITY');
        return Promise.reject(new Error('superseded'));
      };
      setHidden(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.lastControls()?.watched).toEqual({});
    });

    it('a companion that gave up says why; cameras and screens otherwise need no reason', async () => {
      const { ApiError } = await import('../lib/api/client');
      companionToken.mockImplementationOnce(() => Promise.reject(new ApiError('NOT_FOUND', 'no', 404)));
      await joined();
      await seats({ [ME]: {}, [PEER]: { camera: true } });
      expect(useVoice.getState().videoDown).toBe(true);
      await voice.leave();
      expect(useVoice.getState().videoDown).toBe(false);
    });
  });
});

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

  it('a user join opens the room chat (issue #127); a resumed join and a DM call do not', async () => {
    const { useUi } = await import('../stores/ui');
    useUi.getState().openRoom('ws', 'chat');
    await voice.join('A', 'ws', { resumed: true });
    expect(useUi.getState().lastRoom['ws']).toBe('chat');
    await voice.join('A', 'ws');
    expect(useUi.getState().lastRoom['ws']).toBe('A');
    await voice.join('dm', '', { call: true });
    expect(useUi.getState().lastRoom['ws']).toBe('A');
  });

  it('a join with the boards open keeps them and only remembers the room (issue #127)', async () => {
    const { useUi } = await import('../stores/ui');
    const { useBoardsUi } = await import('../stores/boardsUi');
    useUi.getState().openRoom('ws', 'chat');
    useBoardsUi.getState().setActive(true);
    await voice.join('A', 'ws');
    expect(useBoardsUi.getState().active).toBe(true);
    expect(useUi.getState().lastRoom['ws']).toBe('A');
    useBoardsUi.getState().setActive(false);
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
      expect(updateSelf).toHaveBeenCalledWith({ muted: true, deafened: false, musician: false, ptt: false });
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
    expect(updateSelf).toHaveBeenNthCalledWith(1, { muted: true, deafened: false, musician: false, ptt: false });
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

  it('a database stall: /join answers 503 for minutes, the rejoin goes on and gets back in still muted (ADR-0166)', async () => {
    const { ApiError } = await import('../lib/api/client');
    await voice.join('A', 'ws');
    voice.toggleMute();
    await vi.advanceTimersByTimeAsync(100);
    let down = true;
    joinVoice.mockImplementation((roomId: string) =>
      down
        ? Promise.reject(new ApiError('ERROR_CODE_UNAVAILABLE', 'service unavailable', 503))
        : Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } }),
    );
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await vi.advanceTimersByTimeAsync(5 * 60_000); // the stall: 5 min of 503
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'reconnecting', muted: true });
    const tried = joinVoice.mock.calls.length;
    expect(tried).toBeGreaterThan(10);
    down = false;
    await vi.advanceTimersByTimeAsync(16_000); // the next attempt (backoff ≤ 15 s)
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected', muted: true }); // never unmuted
    expect(FakeRoom.all.at(-1)?.published[0]?.isMuted).toBe(true);
    joinVoice.mockReset();
    joinVoice.mockImplementation((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } }));
  });

  it('a refusal (no access / the room is gone) ends the rejoin at once', async () => {
    const { ApiError } = await import('../lib/api/client');
    await voice.join('A', 'ws');
    joinVoice.mockRejectedValueOnce(new ApiError('ERROR_CODE_NOT_FOUND', 'room not found', 404));
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledTimes(2); // no more attempts
    expect(useVoice.getState().roomId).toBeNull();
  });

  it('a rejoin whose room drops right as connect() resolves is not counted as back: the cycle goes on', async () => {
    await voice.join('A', 'ws');
    // The first rejoin attempt: LiveKit connects, then the room is gone before our connect() returns.
    FakeRoom.onConnect = () => {
      FakeRoom.onConnect = null;
      const room = FakeRoom.all.at(-1);
      return Promise.resolve().then(() => {
        if (!room) return;
        room.state = 'Disconnected';
        room.emit('Disconnected', 'SIGNAL_CLOSE');
      });
    };
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(useVoice.getState().phase).toBe('reconnecting');
    // Next attempt (2 s later) gets in for real.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(joinVoice).toHaveBeenCalledTimes(3);
    expect(FakeRoom.all.at(-1)?.state).toBe('Connected');
    expect(useVoice.getState().phase).toBe('connected');
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

  it('the rejoin backoff is jittered ±25 % (a whole room dropped at once must not retry in lockstep, ADR-0166)', async () => {
    const { rejoinDelay } = await import('./voice');
    expect([0, 1, 2, 3, 4, 9].map((a) => rejoinDelay(a, 0.5))).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000]);
    expect(rejoinDelay(9, 0)).toBe(11_250);
    expect(rejoinDelay(9, 1)).toBe(18_750);
  });

  it('a connect that keeps failing backs off 1/2/4/8 s, then 15 s, for 15 min, ends with the «lost» toast and frees the seat (#255, ADR-0166)', async () => {
    await voice.join('A', 'ws');
    const { toast } = await import('../stores/toasts');
    vi.mocked(toast.error).mockClear();
    FakeRoom.onConnect = () => Promise.reject(Object.assign(new Error('could not establish signal connection'), { name: 'ConnectionError' }));
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    // Rejoin attempts so far (the first /join was the user's).
    const attempts = (): number => joinVoice.mock.calls.length - 1;
    // Attempts at 1, 3, 7, 15 s, then every 15 s up to 15 min (a database stall, ADR-0166); then
    // the cycle gives up: 4 + 59 = 63 attempts.
    const steps: [number, number][] = [[999, 0], [1, 1], [1_999, 1], [1, 2], [3_999, 2], [1, 3], [7_999, 3], [1, 4], [14_999, 4], [1, 5], [14_999, 5], [1, 6]];
    for (const [ms, n] of steps) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(attempts()).toBe(n);
    }
    await vi.advanceTimersByTimeAsync(900_000 - 45_000 - 1);
    expect(attempts()).toBe(62);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(useVoice.getState()).toMatchObject({ phase: 'reconnecting', roomId: 'A' });
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(63);
    expect(vi.mocked(toast.error).mock.calls.map((c) => c[0])).toEqual(['Не удалось вернуться в голосовую комнату']);
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', roomId: null });
    expect(leaveVoice).toHaveBeenCalledWith('A');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts()).toBe(63);
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

  it('system mute is idempotent, closes capture immediately and cannot lift moderator mute', async () => {
    await voice.join('A', 'ws');
    expect(voice.setMuted(true)).toBe(true);
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack.enabled).toBe(false);
    expect(voice.setMuted(true)).toBe(true);
    expect(useVoice.getState().muted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(voice.setMuted(false)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
    voice.reconcileSelfState({ roomId:'A', muted:true, deafened:false, serverMuted:true });
    expect(voice.setMuted(false)).toBe(false);
    expect(useVoice.getState().muted).toBe(true);
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
    expect(updateSelf).toHaveBeenLastCalledWith({ muted, deafened: false, musician: false, ptt: false });
  });

  it('undeafen cannot lift a moderator mute applied while deafened', async () => {
    await voice.join('A', 'ws');
    voice.toggleDeafen();
    voice.reconcileSelfState({ roomId: 'A', muted: true, deafened: true, serverMuted: true });
    voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(100);
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false, serverMuted: true });
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false, musician: false, ptt: false });
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
    expect(updateSelf).toHaveBeenLastCalledWith({ muted, deafened: false, musician: false, ptt: false });
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

  describe('cameras in the call view (ADR-0066)', () => {
    type CamPub = { source: string; trackSid: string; kind: string; isMuted: boolean; setSubscribed: ReturnType<typeof vi.fn>; setVideoQuality: ReturnType<typeof vi.fn>; setEnabled: () => void };
    const camPub = (trackSid: string): CamPub => ({ source: 'camera', trackSid, kind: 'video', isMuted: false, setSubscribed: vi.fn(), setVideoQuality: vi.fn(), setEnabled: () => undefined });
    const participant = (identity: string, pubs: CamPub[]) => ({
      identity,
      trackPublications: new Map(pubs.map((p) => [p.trackSid, p])),
      getTrackPublication: (source: string) => pubs.find((p) => p.source === source),
      getTrackPublicationBySid: (sid: string) => pubs.find((p) => p.trackSid === sid),
    });
    const last = (p: CamPub): unknown => p.setSubscribed.mock.calls.at(-1)?.[0];
    const publish = (room: FakeRoom | undefined, identity: string, pub: CamPub): void => {
      room?.remoteParticipants.set(identity, participant(identity, [pub]));
      room?.emit('TrackPublished', pub, room.remoteParticipants.get(identity));
    };

    it('subscribes only cameras on screen; a tile gone unsubscribes after 3 s; a 16+ page caps at 360p', async () => {
      await voice.join('A', 'ws');
      useVoice.setState({ stage: 'expanded' });
      const room = FakeRoom.all.at(-1);
      const camB = camPub('TR_cam_b');
      const camC = camPub('TR_cam_c');
      publish(room, 'u2:b', camB);
      publish(room, 'u3:c', camC);
      expect(useVoice.getState().cameras.map((c) => c.userId)).toEqual(['u2', 'u3']);
      expect(camB.setSubscribed).not.toHaveBeenCalledWith(true);
      const release = voice.showCamera('u2', 'medium');
      await settle();
      expect(last(camB)).toBe(true);
      expect(camB.setVideoQuality.mock.calls.at(-1)?.[0]).toBe(1); // MEDIUM
      expect(camC.setSubscribed).not.toHaveBeenCalledWith(true);
      const big = voice.showCamera('u2', 'high');
      await settle();
      expect(camB.setVideoQuality.mock.calls.at(-1)?.[0]).toBe(2); // HIGH
      big();
      release();
      await vi.advanceTimersByTimeAsync(2999);
      expect(last(camB)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(last(camB)).toBe(false);
    });

    it('the first remote camera opens the call view when the chat is (nearly) empty', async () => {
      await voice.join('A', 'ws');
      expect(useVoice.getState().stage).toBe('pip');
      publish(FakeRoom.all.at(-1), 'u2:b', camPub('TR_cam_b'));
      expect(useVoice.getState().stage).toBe('expanded');
      expect(pushToast).not.toHaveBeenCalled();
    });

    it('in a busy chat the first camera is a toast «… · Смотреть» instead', async () => {
      const { useRooms } = await import('../stores/rooms');
      useRooms.setState({ lastMessage: { A: 'm1' } });
      pushToast.mockClear();
      await voice.join('A', 'ws');
      publish(FakeRoom.all.at(-1), 'u2:b', camPub('TR_cam_b'));
      expect(useVoice.getState().stage).toBe('pip');
      expect(pushToast).toHaveBeenCalledTimes(1);
      const action = pushToast.mock.calls[0]?.[2] as { run: () => void };
      action.run();
      expect(useVoice.getState().stage).toBe('expanded');
      useRooms.setState({ lastMessage: {} });
    });

    it('cameras already on at join are not «turned on»; «Войти и смотреть» opens the call view', async () => {
      FakeRoom.onConnect = () => {
        publish(FakeRoom.all.at(-1), 'u2:b', camPub('TR_cam_b'));
        return Promise.resolve();
      };
      pushToast.mockClear();
      await voice.join('A', 'ws');
      expect(useVoice.getState().cameras).toHaveLength(1);
      expect(useVoice.getState().stage).toBe('pip');
      expect(pushToast).not.toHaveBeenCalled();
      await voice.leave();
      await voice.join('B', 'ws', { video: true });
      expect(useVoice.getState().stage).toBe('expanded');
    });

    it('pinTile opens the call view on page 1 with that person pinned', async () => {
      await voice.join('A', 'ws');
      useVoice.setState({ galleryPage: 2 });
      voice.pinTile('u2');
      expect(useVoice.getState()).toMatchObject({ focusedTile: 'u2', stage: 'expanded', galleryPage: 0 });
    });
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

  it('the active speaker for video switches only after 800 ms of continuous speech (review M2, ADR-0066)', async () => {
    await voice.join('A', 'ws');
    const room = FakeRoom.all[0];
    const p = (id: string) => ({ identity: `${id}:s` });
    room?.emit('ActiveSpeakersChanged', [p('b')]);
    await vi.advanceTimersByTimeAsync(500);
    expect(useVoice.getState().speaking['b']).toBe(true);
    expect(useVoice.getState().activeSpeaker).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(useVoice.getState().activeSpeaker).toBe('b');
    // A short interjection by c does not take the picture.
    await vi.advanceTimersByTimeAsync(2000);
    room?.emit('ActiveSpeakersChanged', [p('c')]);
    await vi.advanceTimersByTimeAsync(400);
    room?.emit('ActiveSpeakersChanged', []);
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().activeSpeaker).toBe('b');
  });

  it('records «last spoke» on speaking starts only, for the call grid (ADR-0066 §2)', async () => {
    await voice.join('A', 'ws');
    const room = FakeRoom.all[0];
    const p = (id: string) => ({ identity: `${id}:s` });
    const { lastSpoke } = await import('../lib/lastSpoke');
    let calls = 0;
    const off = lastSpoke.subscribe(() => calls++);
    room?.emit('ActiveSpeakersChanged', [p('b')]);
    await vi.advanceTimersByTimeAsync(100);
    const first = lastSpoke.get('b');
    expect(first).toBeGreaterThan(0);
    // Still speaking: no new mark, no listener call.
    room?.emit('ActiveSpeakersChanged', [p('b'), p('c')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(lastSpoke.get('b')).toBe(first);
    expect(lastSpoke.get('c')).toBeGreaterThan(0);
    expect(calls).toBe(2);
    off();
    await voice.leave();
    expect(lastSpoke.get('b')).toBe(0);
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
    /** The element's stream; `binds` counts re-assignments (RemoteAudioOut.rebind). */
    private src: unknown = {};
    binds = 0;
    get srcObject(): unknown {
      return this.src;
    }
    set srcObject(v: unknown) {
      this.src = v;
      if (v) this.binds++;
    }
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

  describe('output device routing (CBF-108)', () => {
    const out = (deviceId: string, label: string, groupId = deviceId) => ({ deviceId, groupId, kind: 'audiooutput', label });
    const inp = (deviceId: string, label: string, groupId = deviceId) => ({ deviceId, groupId, kind: 'audioinput', label });
    const fire = async (list: (typeof deviceList)[number][]): Promise<void> => {
      deviceList = list;
      for (const fn of deviceChange) fn();
      await settle();
    };
    const spk = out('spk', 'MacBook Speakers', 'g-mbp');
    const air = out('air', 'AirPods Pro', 'g-air');
    const dflt = (label: string, groupId: string) => out('default', `Default - ${label}`, groupId);

    it('LiveKit follows a mid-call switch: a late participant plays on the new choice, not the join-time one', async () => {
      await fire([dflt('MacBook Speakers', 'g-mbp'), spk, air]);
      usePrefs.getState().setPrefs({ outputDeviceId: 'spk' });
      await settle();
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      expect(room?.options.audioOutput?.deviceId).toBe('spk');
      const a = subscribe(room, 'u2:phone', 'TR_a');
      await settle();
      usePrefs.getState().setPrefs({ outputDeviceId: 'air' });
      await settle();
      // LiveKit re-applies its own id to every new remote track: it has ours now.
      expect([a.sinkId, room?.options.audioOutput?.deviceId, room?.getActiveDevice('audiooutput')]).toEqual(['air', 'air', 'air']);
      // Back to «system default»: the alias, for LiveKit too (no stale 'air' for the next track).
      usePrefs.getState().setPrefs({ outputDeviceId: null });
      await settle();
      const late = subscribe(room, 'u3:desk', 'TR_late');
      await settle();
      expect([a.sinkId, late.sinkId, room?.options.audioOutput?.deviceId]).toEqual(['default', 'default', 'default']);
      // In sync: ActiveDeviceChanged came back without another switch.
      expect(room?.switches).toEqual([['audiooutput', 'air'], ['audiooutput', 'default']]);
    });

    it('the chosen AirPods go away → default; they come back → AirPods again', async () => {
      await fire([dflt('AirPods Pro', 'g-air'), spk, air]);
      usePrefs.getState().setPrefs({ outputDeviceId: 'air' });
      await settle();
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      const a = subscribe(room, 'u2:phone', 'TR_a');
      await settle();
      expect(a.sinkId).toBe('air');
      await fire([dflt('MacBook Speakers', 'g-mbp'), spk]);
      expect([a.sinkId, room?.getActiveDevice('audiooutput')]).toEqual(['default', 'default']);
      await fire([dflt('AirPods Pro', 'g-air'), spk, air]);
      expect([a.sinkId, room?.getActiveDevice('audiooutput')]).toEqual(['air', 'air']);
      // The choice itself was never touched.
      expect(usePrefs.getState().outputDeviceId).toBe('air');
    });

    it('joining with a stale stored device plays on the default from the first track', async () => {
      await fire([dflt('MacBook Speakers', 'g-mbp'), spk]);
      usePrefs.getState().setPrefs({ outputDeviceId: 'air' });
      await settle();
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      expect(room?.options.audioOutput?.deviceId).toBe('default');
      const a = subscribe(room, 'u2:phone', 'TR_a');
      await settle();
      expect(a.sinkId).toBe('default');
    });

    it('the mic opening on the headset the voices play to re-binds them once the route settled', async () => {
      await fire([dflt('AirPods Pro', 'g-air'), spk, air, inp('default', 'Default - AirPods Pro', 'g-air'), inp('mic-air', 'AirPods Pro', 'g-air')]);
      usePrefs.getState().setPrefs({ outputDeviceId: null, micDeviceId: 'AirPods Pro' });
      await settle();
      await vi.advanceTimersByTimeAsync(500); // the devicechange re-bind (#255) is past
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      const a = subscribe(room, 'u2:phone', 'TR_a');
      await settle();
      const before = a.binds;
      await vi.advanceTimersByTimeAsync(1600);
      expect(a.binds).toBe(before + 1);
      usePrefs.getState().setPrefs({ micDeviceId: null });
    });

    it('devicechange re-binds only when the outputs changed, not on a mic / camera change', async () => {
      const list = [dflt('MacBook Speakers', 'g-mbp'), spk, inp('mbp-mic', 'MacBook Mic', 'g-mbp')];
      await fire(list);
      await voice.join('A', 'ws');
      const a = subscribe(FakeRoom.all.at(-1), 'u2:phone', 'TR_a');
      await vi.advanceTimersByTimeAsync(2000);
      const before = a.binds;
      await fire([...list, inp('usb-mic', 'USB Mic', 'g-usb')]);
      await vi.advanceTimersByTimeAsync(500);
      expect(a.binds).toBe(before);
      await fire([dflt('AirPods Pro', 'g-air'), spk, air, inp('mbp-mic', 'MacBook Mic', 'g-mbp')]);
      await vi.advanceTimersByTimeAsync(500);
      expect(a.binds).toBe(before + 1);
    });

    it('a mic on another device does not re-bind', async () => {
      await fire([dflt('AirPods Pro', 'g-air'), spk, air, inp('mbp-mic', 'MacBook Mic', 'g-mbp')]);
      usePrefs.getState().setPrefs({ outputDeviceId: null, micDeviceId: 'MacBook Mic' });
      await settle();
      await vi.advanceTimersByTimeAsync(500); // the devicechange re-bind (#255) is past
      await voice.join('A', 'ws');
      const a = subscribe(FakeRoom.all.at(-1), 'u2:phone', 'TR_a');
      await settle();
      const before = a.binds;
      await vi.advanceTimersByTimeAsync(1600);
      expect(a.binds).toBe(before);
      usePrefs.getState().setPrefs({ micDeviceId: null });
    });
  });

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
      usePrefs.getState().setPrefs({ micMode: 'voice' }); // an earlier PTT test may leave the pref; the body carries it (ADR-0130)
      await voice.join('A', 'ws');
      voice.toggleMute();
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false, musician: false, ptt: false });
      voice.toggleMute(); // mic on
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false, musician: false, ptt: false });
      voice.toggleMute(); // remember a manual mute for this deafen cycle
      voice.toggleDeafen();
      voice.toggleMute(); // the mic button while deafened: both off (Discord)
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false, musician: false, ptt: false });
      voice.toggleDeafen();
      voice.toggleDeafen();
      await vi.advanceTimersByTimeAsync(100);
      expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
      expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
      expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false, musician: false, ptt: false });
    });

    /**
     * Chromium mixes every remote WebRTC audio receiver into one output; muting an element only
     * zeroes the receivers that element plays, and a receiver no element plays yet is at full gain
     * (LiveKit defers / drops its TrackSubscribed: Reconnecting, publication not found). So
     * deafened = nothing received: no mic or stream-audio subscription at all.
     */
    it('deafen → no remote audio is received: mics and stream audio unsubscribed, back on undeafen', async () => {
      type Pub = { source: string; trackSid: string; kind: string; isMuted: boolean; isSubscribed: boolean; setSubscribed: ReturnType<typeof vi.fn>; setEnabled: () => void };
      const pub = (source: string, trackSid: string): Pub => ({ source, trackSid, kind: source === 'screen_share' ? 'video' : 'audio', isMuted: false, isSubscribed: false, setSubscribed: vi.fn(), setEnabled: () => undefined });
      const participant = (identity: string, pubs: Pub[]) => ({
        identity,
        trackPublications: new Map(pubs.map((p) => [p.trackSid, p])),
        getTrackPublication: (source: string) => pubs.find((p) => p.source === source),
        getTrackPublicationBySid: (sid: string) => pubs.find((p) => p.trackSid === sid),
      });
      const last = (p: Pub): unknown => p.setSubscribed.mock.calls.at(-1)?.[0];
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      const micB = pub('microphone', 'TR_mic_b');
      const screen = pub('screen_share', 'TR_scr_c');
      const screenAudio = pub('screen_share_audio', 'TR_sa_c');
      const micC = pub('microphone', 'TR_mic_c');
      room?.remoteParticipants.set('u2:b', participant('u2:b', [micB]));
      room?.remoteParticipants.set('u3:c', participant('u3:c', [micC, screen, screenAudio]));
      for (const p of [micB, micC, screen, screenAudio]) room?.emit('TrackPublished', p, room.remoteParticipants.get(p === micB ? 'u2:b' : 'u3:c'));
      expect(useVoice.getState().watching).toBe('TR_scr_c'); // a new stream shows in the PiP
      expect([last(micB), last(micC), last(screenAudio)]).toEqual([true, true, true]);

      voice.toggleDeafen();
      expect([last(micB), last(micC), last(screenAudio)]).toEqual([false, false, false]);
      expect(last(screen)).toBe(true); // the picture stays

      // Someone joins while I am deafened: their mic is not subscribed either.
      const micD = pub('microphone', 'TR_mic_d');
      room?.remoteParticipants.set('u4:d', participant('u4:d', [micD]));
      room?.emit('TrackPublished', micD, room.remoteParticipants.get('u4:d'));
      expect(micD.setSubscribed).not.toHaveBeenCalledWith(true);

      voice.toggleDeafen();
      expect([last(micB), last(micC), last(micD), last(screenAudio)]).toEqual([true, true, true, true]);
    });

    it('detached remote audio leaves the DOM (LiveKit detaches before TrackUnsubscribed)', async () => {
      await voice.join('A', 'ws');
      const room = FakeRoom.all.at(-1);
      const el = new FakeAudioEl();
      const removed = vi.spyOn(el, 'remove');
      const track = { kind: 'audio', sid: 'TR_a', attach: () => el, detach: () => [] as FakeAudioEl[] };
      room?.emit('TrackSubscribed', track, { source: 'microphone' }, { identity: 'u2:phone' });
      room?.emit('TrackUnsubscribed', track, { source: 'microphone' });
      expect(removed).toHaveBeenCalled();
    });

    it('no PTT cue on the phone, whatever the setting', async () => {
      usePrefs.getState().setPrefs({ micMode: 'ptt', pttReleaseMs: 0, pttBinding: { kind: 'key', code: 66, label: 'F8', mode: 'hold' } });
      await voice.join('A', 'ws');
      await settle();
      const hold = (down: boolean): void => (voice as unknown as { onPtt(ev: { down: boolean }): void }).onPtt({ down });
      phone.on = true;
      playSound.mockClear();
      hold(true);
      hold(false);
      phone.on = false;
      expect(playSound).not.toHaveBeenCalled();
      usePrefs.getState().setPrefs({ micMode: 'voice' });
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

  it('a one-to-one call is voice activation only: PTT unbound and ignored, the choice back after (ADR-0034)', async () => {
    const binding = { kind: 'key' as const, code: 66, label: 'F8', mode: 'hold' as const };
    usePrefs.getState().setPrefs({ micMode: 'ptt', pttReleaseMs: 0, pttBinding: binding });
    await settle();
    expect(setBinding).toHaveBeenLastCalledWith(binding);
    await voice.join('dm-1', '', { call: true });
    await settle();
    expect(useVoice.getState()).toMatchObject({ call: true, workspaceId: '', phase: 'connected' });
    expect(setBinding).toHaveBeenLastCalledWith(null);
    expect(usePrefs.getState().micMode).toBe('ptt'); // the user's choice is untouched
    // The key does nothing; the VAD gate decides (closed here: nothing on air yet).
    const hold = (down: boolean): void => (voice as unknown as { onPtt(ev: { down: boolean }): void }).onPtt({ down });
    hold(true);
    await settle();
    expect(useVoice.getState().pttDown).toBe(false);
    // The VAD gate decides, not a key.
    expect((voice as unknown as { micMode(): string }).micMode()).toBe('voice');
    await voice.leave();
    await settle();
    expect(useVoice.getState().call).toBe(false);
    expect(setBinding).toHaveBeenLastCalledWith(binding);
    usePrefs.getState().setPrefs({ micMode: 'voice', pttBinding: null });
  });

  it('a room join after a call restores the chosen mic mode; a call reconnect keeps voice only', async () => {
    usePrefs.getState().setPrefs({ micMode: 'ptt', pttBinding: { kind: 'key', code: 66, label: 'F8', mode: 'hold' } });
    await voice.join('dm-1', '', { call: true });
    await settle();
    expect(useVoice.getState().call).toBe(true);
    await voice.join('A', 'ws');
    await settle();
    expect(useVoice.getState()).toMatchObject({ call: false, roomId: 'A' });
    usePrefs.getState().setPrefs({ micMode: 'voice', pttBinding: null });
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
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false, musician: false, ptt: false });
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
    useWorkspaces.setState({ byId: { ws: { ws: {} as never, role: WorkspaceRole.MEMBER, members: { u1: me }, roles: legacyRoles('ws'), badges: {}, backgrounds: {}, voice: {} } } });
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

describe('voice tier (docs/02 «Битрейт»)', () => {
  it('a room / personal tier change is applied to the published mic live, without a republish', async () => {
    const { create } = await import('@bufbuild/protobuf');
    const { RoomSchema, WorkspaceMemberSchema, WorkspaceRole, UserSchema } = await import('@calaba/protocol');
    const { useSession } = await import('../stores/session');
    const { useRooms } = await import('../stores/rooms');
    const { useWorkspaces } = await import('../stores/workspaces');
    const { legacyRoles } = await import('../lib/roles');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
    const me = create(WorkspaceMemberSchema, { workspaceId: 'ws', role: WorkspaceRole.MEMBER, roleIds: ['member'], user: create(UserSchema, { id: 'u1' }) });
    useWorkspaces.setState({ byId: { ws: { ws: {} as never, role: WorkspaceRole.MEMBER, members: { u1: me }, roles: legacyRoles('ws'), badges: {}, backgrounds: {}, voice: {} } } });
    const room = (kbps: number) => create(RoomSchema, { id: 'A', workspaceId: 'ws', media: { audioBitrateKbps: kbps } });
    useRooms.setState({ byId: { A: room(32) } });
    await voice.join('A', 'ws');
    const r = FakeRoom.all.at(-1);
    await vi.waitFor(() => expect(r?.published.length).toBe(1));
    const publishes = r?.localParticipant.publishTrack.mock.calls.length;
    applyMicTier.mockClear();
    voice.refreshRights(); // the same tier: nothing to do
    // ROOM_UPDATE: the room goes «Низкое».
    useRooms.setState({ byId: { A: room(8) } });
    voice.refreshRights();
    await vi.waitFor(() => expect(applyMicTier).toHaveBeenCalledTimes(1));
    expect(applyMicTier.mock.calls[0]?.[2]).toMatchObject({ kbps: 8, maxPlaybackRate: 8000 });
    // Back to «Отличное», my personal cap «Не выше: Нормальное» wins.
    useRooms.setState({ byId: { A: room(64) } });
    usePrefs.setState({ personalBitrateKbps: 16 });
    voice.refreshRights();
    await vi.waitFor(() => expect(applyMicTier.mock.calls.at(-1)?.[2]).toMatchObject({ kbps: 16 }));
    // A legacy row (48) is the nearest tier, a tie going up.
    usePrefs.setState({ personalBitrateKbps: null });
    useRooms.setState({ byId: { A: room(48) } });
    voice.refreshRights();
    await vi.waitFor(() => expect(applyMicTier.mock.calls.at(-1)?.[2]).toMatchObject({ kbps: 64 }));
    expect(r?.localParticipant.publishTrack.mock.calls.length).toBe(publishes); // no republish
    await voice.leave();
  });
});

describe('musician mode (ADR-0052)', () => {
  it('toggled in a call: raw capture swapped in place, music profile, open mic, flag to the server — and back', async () => {
    await voice.join('A', 'ws');
    const r = FakeRoom.all.at(-1);
    await vi.waitFor(() => expect(r?.published.length).toBe(1));
    const pub = r?.published[0];
    const first = pipelines.at(-1);
    expect(first?.musician).toBe(false);
    expect(pub?.mediaStreamTrack.enabled).toBe(false); // the VAD gate is closed in silence
    const publishes = r?.localParticipant.publishTrack.mock.calls.length;
    applyMicTier.mockClear();
    updateSelf.mockClear();

    usePrefs.getState().setPrefs({ musicianMode: true });
    await vi.waitFor(() => expect(pipelines.at(-1)?.musician).toBe(true));
    const music = pipelines.at(-1);
    await vi.waitFor(() => expect(pub?.mediaStreamTrack).toBe(music?.track)); // replaceTrack, same publication
    expect(first?.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(applyMicTier.mock.calls.at(-1)?.[2]).toMatchObject({ kbps: 128, dtx: false, stereo: true, fec: true, maxPlaybackRate: 48000 }));
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false, musician: true, ptt: false });
    expect(pub?.mediaStreamTrack.enabled).toBe(true); // no VAD gating: the mic stays open in silence
    expect(useVoice.getState().transmitting).toBe(true);
    expect(r?.localParticipant.publishTrack.mock.calls.length).toBe(publishes); // no republish

    usePrefs.getState().setPrefs({ musicianMode: false });
    await vi.waitFor(() => expect(pipelines.at(-1)?.musician).toBe(false));
    await vi.waitFor(() => expect(pub?.mediaStreamTrack).toBe(pipelines.at(-1)?.track));
    await vi.waitFor(() => expect(applyMicTier.mock.calls.at(-1)?.[2]).toMatchObject({ kbps: 32, dtx: true, stereo: false }));
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: false, deafened: false, musician: false, ptt: false });
    expect(pub?.mediaStreamTrack.enabled).toBe(false); // gated again
    await voice.leave();
  });

  it('plan gate: locked on Free (plan toast), off when the call ends or lands in a Free room', async () => {
    const { create } = await import('@bufbuild/protobuf');
    const { Plan, PlanLimitsSchema, WorkspacePlanSchema } = await import('@calaba/protocol');
    const { useWorkspaces } = await import('../stores/workspaces');
    const { setMusicianMode } = await import('./musician');
    const plan = (free: boolean) => create(WorkspacePlanSchema, { plan: free ? Plan.FREE : Plan.TEAM, limits: create(PlanLimitsSchema, { musicianDisabled: free }) });
    useWorkspaces.setState({ byId: { free: { ws: { plan: plan(true) }, voice: {} }, team: { ws: { plan: plan(false) }, voice: {} } } as never });
    const locked = 'Доступно на тарифе Team и выше';
    await voice.join('A', 'free');
    pushToast.mockClear();
    setMusicianMode(true);
    expect(usePrefs.getState().musicianMode).toBe(false);
    expect(pushToast).toHaveBeenCalledWith('info', locked, undefined);
    // A Team room: on; leaving voice turns it off.
    await voice.join('B', 'team');
    setMusicianMode(true);
    expect(usePrefs.getState().musicianMode).toBe(true);
    await voice.leave();
    expect(usePrefs.getState().musicianMode).toBe(false);
    // On in a Team room, then into a Free workspace's room: off, with the plan toast.
    await voice.join('B', 'team');
    setMusicianMode(true);
    pushToast.mockClear();
    await voice.join('A', 'free'); // a switch passes «no room» while joining: not a leave
    expect(usePrefs.getState().musicianMode).toBe(false);
    expect(pushToast).toHaveBeenCalledWith('info', locked, undefined);
    await voice.leave();
  });

  it('joining in musician mode publishes without DTX; off = no new work (the speech path as before)', async () => {
    usePrefs.getState().setPrefs({ musicianMode: true });
    await voice.join('A', 'ws');
    const r = FakeRoom.all.at(-1);
    await vi.waitFor(() => expect(r?.published.length).toBe(1));
    expect(pipelines.at(-1)?.musician).toBe(true);
    expect(r?.localParticipant.publishTrack.mock.calls.at(-1)?.[1]).toMatchObject({ dtx: false, audioPreset: { maxBitrate: 128_000 } });
    await voice.leave();
    usePrefs.getState().setPrefs({ musicianMode: false });
    await voice.join('B', 'ws');
    const r2 = FakeRoom.all.at(-1);
    await vi.waitFor(() => expect(r2?.published.length).toBe(1));
    expect(pipelines.at(-1)?.musician).toBe(false);
    expect(r2?.localParticipant.publishTrack.mock.calls.at(-1)?.[1]).toMatchObject({ dtx: true, audioPreset: { maxBitrate: 32_000 } });
    await voice.leave();
  });
});

describe('a restarted capture never transmits past the gate or the mute (musician mode, device, RNNoise)', () => {
  const ptt = { micMode: 'ptt' as const, pttReleaseMs: 0, pttBinding: { kind: 'key' as const, code: 66, label: 'F8', mode: 'hold' as const } };
  const join = async (): Promise<FakeLocalAudioTrack | undefined> => {
    await voice.join('A', 'ws');
    const r = FakeRoom.all.at(-1);
    await vi.waitFor(() => expect(r?.published.length).toBe(1));
    await settle();
    return r?.published[0];
  };
  const swapped = async (pub: FakeLocalAudioTrack | undefined, n: number): Promise<void> => {
    await vi.waitFor(() => expect(pipelines.length).toBe(n));
    await vi.waitFor(() => expect(pub?.mediaStreamTrack).toBe(pipelines.at(-1)?.track));
    await settle();
  };
  afterEach(() => {
    usePrefs.getState().setPrefs({ micMode: 'voice', musicianMode: false, micDeviceId: null });
  });

  it('PTT key not held: musician mode on / off keeps the mic silent', async () => {
    usePrefs.getState().setPrefs(ptt);
    const pub = await join();
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    usePrefs.getState().setPrefs({ musicianMode: true });
    await swapped(pub, 2);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    expect(useVoice.getState().transmitting).toBe(false);
    usePrefs.getState().setPrefs({ musicianMode: false });
    await swapped(pub, 3);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    // The key still opens the new capture.
    (voice as unknown as { onPtt(ev: { down: boolean }): void }).onPtt({ down: true });
    expect(pub?.mediaStreamTrack.enabled).toBe(true);
    (voice as unknown as { onPtt(ev: { down: boolean }): void }).onPtt({ down: false });
    await settle();
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    await voice.leave();
  });

  it('PTT key not held: a device switch and an RNNoise flip keep the mic silent', async () => {
    usePrefs.getState().setPrefs(ptt);
    const pub = await join();
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    await swapped(pub, 2);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    usePrefs.getState().setPrefs({ rnnoise: !usePrefs.getState().rnnoise });
    await swapped(pub, 3);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    await voice.leave();
  });

  it('VAD with the gate closed: a device switch keeps the mic silent', async () => {
    const pub = await join();
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    await swapped(pub, 2);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    expect(useVoice.getState().transmitting).toBe(false);
    await voice.leave();
  });

  it.each(['voice', 'ptt'] as const)('muted (%s): musician mode on / off keeps the track muted and silent', async (mode) => {
    usePrefs.getState().setPrefs(mode === 'ptt' ? ptt : { micMode: 'voice' });
    const pub = await join();
    voice.toggleMute();
    await settle();
    expect(pub?.isMuted).toBe(true);
    usePrefs.getState().setPrefs({ musicianMode: true });
    await swapped(pub, 2);
    expect(pub?.isMuted).toBe(true);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    expect(useVoice.getState().transmitting).toBe(false);
    usePrefs.getState().setPrefs({ musicianMode: false });
    await swapped(pub, 3);
    expect(pub?.isMuted).toBe(true);
    expect(pub?.mediaStreamTrack.enabled).toBe(false);
    await voice.leave();
  });

  it('listen-only (no SPEAK): musician mode captures and publishes nothing', async () => {
    joinVoice.mockImplementationOnce((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: false, canStream: false, media: { audioBitrateKbps: 32 } }));
    await voice.join('A', 'ws');
    await settle();
    usePrefs.getState().setPrefs({ musicianMode: true });
    await settle();
    expect(pipelines).toHaveLength(0);
    expect(FakeRoom.all.at(-1)?.published).toHaveLength(0);
    await voice.leave();
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

  it('cues: viewers coming / going, my stream ending, my own leave (1.3.1 sounds)', async () => {
    await voice.join('A', 'ws');
    await settle();
    const engine = voice as unknown as { screen: unknown; viewers: Map<string, Set<string>> };
    engine.screen = { video: { sid: 'TR_mine', mediaStreamTrack: {} }, audio: null, stop: () => Promise.resolve() };
    engine.viewers.set('TR_mine', new Set());
    const room = FakeRoom.all.at(-1);
    const watch = (on: boolean): void => room?.emit('DataReceived', new TextEncoder().encode(JSON.stringify({ sid: 'TR_mine', on })), { identity: 'u2:d' }, 0, 'calaba.watch');
    playSound.mockClear();
    watch(true);
    watch(true); // repeated: no second cue
    watch(false);
    watch(false);
    expect(playSound.mock.calls.map((c) => c[0])).toEqual(['watchStart', 'watchStop']);
    playSound.mockClear();
    await voice.stopStream();
    expect(playSound.mock.calls.map((c) => c[0])).toEqual(['streamEnd']);
    playSound.mockClear();
    await voice.leave();
    expect(playSound.mock.calls.map((c) => c[0])).toEqual(['disconnect']);
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

describe('VOICE_DISCONNECTED (docs/05 «Несколько устройств»)', () => {
  const ev = (over: Partial<Parameters<Engine['onServerDisconnect']>[0]> = {}): Parameters<Engine['onServerDisconnect']>[0] => ({
    roomId: 'A',
    sessionId: 'mine',
    reason: VoiceDisconnectReason.OTHER_DEVICE,
    ...over,
  });
  beforeEach(async () => {
    const { useSession } = await import('../stores/session');
    useSession.setState({ sessionId: 'mine' });
  });
  const toasts = async (): Promise<string[]> => {
    const { toast } = await import('../stores/toasts');
    return vi.mocked(toast.info).mock.calls.map((c) => c[0]);
  };

  it('my device: out of voice at once, the island idle, a toast, no reconnect attempt', async () => {
    await voice.join('A', 'ws');
    expect(voice.onServerDisconnect(ev())).toBe(true);
    await settle();
    const v = useVoice.getState();
    expect(v.phase).toBe('idle');
    expect(v.roomId).toBeNull();
    expect(voice.currentRoomId).toBeNull();
    expect(voice.takenOverRoom).toBe('A');
    expect(await toasts()).toEqual(['Вы подключились с другого устройства']);
    // LiveKit dropping the (already torn down) room afterwards changes nothing.
    FakeRoom.all[0]?.emit('Disconnected', 'PARTICIPANT_REMOVED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().phase).toBe('idle');
    expect(await toasts()).toEqual(['Вы подключились с другого устройства']);
    // The next own join clears the mark.
    await voice.join('B', 'ws');
    expect(voice.takenOverRoom).toBeNull();
  });

  it('another device of mine, or a room I already left: ignored', async () => {
    await voice.join('A', 'ws');
    expect(voice.onServerDisconnect(ev({ sessionId: 'other' }))).toBe(false);
    expect(voice.onServerDisconnect(ev({ roomId: 'B' }))).toBe(false);
    await settle();
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', roomId: 'A' });
    expect(voice.takenOverRoom).toBeNull();
  });

  it('LiveKit removal first: the event within the grace decides — no moderator toast, no rejoin', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'PARTICIPANT_REMOVED');
    await vi.advanceTimersByTimeAsync(200);
    expect(voice.onServerDisconnect(ev())).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useVoice.getState().phase).toBe('idle');
    expect(await toasts()).toEqual(['Вы подключились с другого устройства']);
    expect(joinVoice).toHaveBeenCalledTimes(1);
  });

  it('LiveKit removal while the server is out of reach: no verdict — no toast, back into the room by itself (ADR-0166)', async () => {
    const { useSession } = await import('../stores/session');
    await voice.join('A', 'ws');
    voice.toggleMute();
    await settle();
    // The gateway session was closed past the identity grace and IDENTIFY fails while the database stalls.
    useSession.setState({ gateway: 'reconnecting' });
    FakeRoom.all[0]?.emit('Disconnected', 'PARTICIPANT_REMOVED');
    await vi.advanceTimersByTimeAsync(500);
    expect(await toasts()).toEqual([]);
    expect(useVoice.getState()).toMatchObject({ phase: 'reconnecting', roomId: 'A', muted: true });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', roomId: 'A', muted: true });
    expect(voice.takenOverRoom).toBeNull();
    // The API answering with outages is the same signal with the gateway up.
    useSession.setState({ gateway: 'ready', serverDegraded: true });
    FakeRoom.all.at(-1)?.emit('Disconnected', 'PARTICIPANT_REMOVED');
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await toasts()).toEqual([]);
    expect(joinVoice).toHaveBeenCalledTimes(3);
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', roomId: 'A' });
  });

  it('VOICE_DISCONNECTED with ACCESS_UNDECIDED (the sweep failed closed): rejoin, no toast, not a takeover', async () => {
    await voice.join('A', 'ws');
    expect(voice.onServerDisconnect(ev({ reason: VoiceDisconnectReason.ACCESS_UNDECIDED }))).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', roomId: 'A' });
    expect(voice.takenOverRoom).toBeNull();
    expect(await toasts()).toEqual([]);
    // Told twice (the event, then LiveKit's removal of the old room): one cycle.
    expect(voice.onServerDisconnect(ev({ reason: VoiceDisconnectReason.ACCESS_UNDECIDED }))).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(joinVoice).toHaveBeenCalledTimes(3);
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', roomId: 'A' });
  });

  it('LiveKit removal without the event: a moderator — the toast and the leave after the grace', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'PARTICIPANT_REMOVED');
    await settle();
    expect(await toasts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(useVoice.getState().phase).toBe('idle');
    expect(await toasts()).toEqual(['Модератор отключил вас от голосовой комнаты']);
    expect(voice.takenOverRoom).toBeNull();
  });

  it('during a reconnect cycle: the cycle stops, nothing rejoins', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    expect(useVoice.getState().phase).toBe('reconnecting');
    expect(voice.onServerDisconnect(ev())).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', roomId: null });
  });
});

describe('stuck «Подключение…» (docs/09 #131)', () => {
  /** A promise that never settles (a LiveKit call / network request that hangs). */
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  const errors = async (): Promise<string[]> => {
    const { toast } = await import('../stores/toasts');
    return vi.mocked(toast.error).mock.calls.map((c) => c[0]);
  };
  beforeEach(async () => {
    const { toast } = await import('../stores/toasts');
    vi.mocked(toast.error).mockClear();
  });

  it('switch A → B while A is still connecting: B connected, A dropped, A settling late changes nothing', async () => {
    let finishA!: () => void;
    FakeRoom.onConnect = (token) => (token === 't-A' ? new Promise<void>((r) => (finishA = r)) : Promise.resolve());
    const toA = voice.join('A', 'ws');
    await settle();
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connecting' });
    await voice.join('B', 'ws');
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected', joining: null });
    expect(FakeRoom.all[0]?.disconnects).toHaveLength(1);
    finishA();
    await toA;
    await settle();
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected' });
    expect(voice.linkTruth().room).toBe(FakeRoom.all[1]?.name);
  });

  it('switch while the room is reconnecting (LiveKit resuming, then our rejoin cycle): the new room connects', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (a) a.state = 'Reconnecting';
    a?.emit('ConnectionStateChanged', 'Reconnecting');
    expect(useVoice.getState().phase).toBe('reconnecting');
    await voice.join('B', 'ws');
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected' });
    // Our own cycle: B lost for good, the loop in its backoff when the user clicks C.
    FakeRoom.all[1]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    expect(useVoice.getState().phase).toBe('reconnecting');
    await voice.join('C', 'ws');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(useVoice.getState()).toMatchObject({ roomId: 'C', phase: 'connected' });
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B', 'C']);
  });

  it('the old room’s disconnect() never settles: the switch still connects B (bounded), leave works too', async () => {
    await voice.join('A', 'ws');
    FakeRoom.disconnectGate = never();
    const toB = voice.join('B', 'ws');
    await vi.advanceTimersByTimeAsync(3_000);
    await toB;
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected' });
    const leaving = voice.leave();
    await vi.advanceTimersByTimeAsync(3_000);
    await leaving;
    expect(useVoice.getState()).toMatchObject({ roomId: null, phase: 'idle' });
  });

  it('events of the old room after the switch never touch the new room’s state', async () => {
    await voice.join('A', 'ws');
    await voice.join('B', 'ws');
    playSound.mockClear();
    const old = FakeRoom.all[0];
    old?.emit('ConnectionStateChanged', 'Reconnecting');
    old?.emit('Disconnected', 'SIGNAL_CLOSE');
    old?.emit('ParticipantDisconnected', { identity: 'u2:s' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected' });
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']); // no rejoin of A
    expect(playSound).not.toHaveBeenCalled();
  });

  it('watchdog: a connect that never settles is retried once with a fresh Room and token after 15 s', async () => {
    let calls = 0;
    FakeRoom.onConnect = () => (++calls === 1 ? never() : Promise.resolve());
    void voice.join('A', 'ws');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(useVoice.getState().phase).toBe('connecting');
    expect(voice.linkProbe()).toMatchObject({ phase: 'connecting', stage: 'signal' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    expect(FakeRoom.all).toHaveLength(2); // the stuck Room is not reused
    expect(FakeRoom.all[0]?.disconnects).toHaveLength(1);
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'A']); // a fresh token
    expect(await errors()).toEqual([]);
  });

  it('watchdog: stuck again after the retry → out of voice with the reason, nothing left spinning', async () => {
    FakeRoom.onConnect = () => never();
    void voice.join('A', 'ws');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(useVoice.getState().phase).toBe('connecting');
    expect(useVoice.getState().link.lastError).toBe('голосовой сервер не ответил за 15 с — повторяю');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(useVoice.getState()).toMatchObject({ roomId: null, phase: 'idle', joining: null });
    expect(await errors()).toEqual(['Не удалось подключиться к голосу: голосовой сервер не ответил']);
    expect(useVoice.getState().link.lastError).toBe('голосовой сервер не ответил');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledTimes(2);
  });

  it('watchdog: a /join that never answers is abandoned; the retry’s /join connects', async () => {
    joinVoice.mockImplementationOnce(() => never());
    void voice.join('A', 'ws');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(voice.linkProbe().stage).toBe('join');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    expect(joinVoice).toHaveBeenCalledTimes(2);
  });

  it('a switch that hangs (connect and disconnect) does not poison the controller: the next join connects without a restart', async () => {
    await voice.join('A', 'ws');
    FakeRoom.onConnect = (token) => (token === 't-B' ? never() : Promise.resolve());
    void voice.join('B', 'ws');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connecting' });
    // B's Room will never let go either.
    FakeRoom.disconnectGate = never();
    const toC = voice.join('C', 'ws');
    await vi.advanceTimersByTimeAsync(4_000);
    await toC;
    expect(useVoice.getState()).toMatchObject({ roomId: 'C', phase: 'connected', joining: null });
    // And after a full watchdog failure, too.
    FakeRoom.disconnectGate = null;
    FakeRoom.onConnect = (token) => (token === 't-D' ? never() : Promise.resolve());
    void voice.join('D', 'ws');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(useVoice.getState()).toMatchObject({ roomId: null, phase: 'idle' });
    await voice.join('E', 'ws');
    expect(useVoice.getState()).toMatchObject({ roomId: 'E', phase: 'connected' });
  });

  it('a click on the room I am stuck connecting to starts afresh instead of reusing the dead Room', async () => {
    FakeRoom.onConnect = () => (FakeRoom.all.length === 1 ? never() : Promise.resolve());
    void voice.join('A', 'ws');
    await settle();
    const stuck = FakeRoom.all[0];
    if (stuck) stuck.state = 'Connecting';
    await vi.advanceTimersByTimeAsync(5_000);
    await voice.join('A', 'ws'); // within the limit: the attempt in flight is kept
    expect(FakeRoom.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_000); // the watchdog (15 s) replaces it
    expect(FakeRoom.all).toHaveLength(2);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
  });

  it('«Переподключение…» with nobody working on it: a fresh rejoin after 30 s', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (a) a.state = 'Disconnected';
    useVoice.setState({ phase: 'reconnecting' }); // an orphaned phase: no LiveKit resume, no cycle
    await vi.advanceTimersByTimeAsync(33_000);
    expect(joinVoice).toHaveBeenCalledTimes(2);
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
  });

  it('«Переподключение…» while LiveKit is connected (a missed event): the phase is fixed', async () => {
    await voice.join('A', 'ws');
    useVoice.setState({ phase: 'reconnecting' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(useVoice.getState().phase).toBe('connected');
    expect(joinVoice).toHaveBeenCalledTimes(1);
  });
});

describe('tabs of one browser share the voice seat (#40)', () => {
  const session = async (id: string): Promise<void> => {
    const { useSession } = await import('../stores/session');
    useSession.setState({ sessionId: id });
  };
  const channel = (): FakeChannel => {
    const ch = FakeChannel.all.at(-1);
    if (!ch) throw new Error('no voice tab channel');
    return ch;
  };

  it('a join announces itself; a newer join of another tab takes this one out locally, without /voice/leave', async () => {
    await session('s1');
    await voice.join('A', 'ws');
    const mine = channel().sent[0] as { session: string; at: number };
    expect(mine.session).toBe('s1');
    channel().onmessage?.({ data: { session: 's1', at: mine.at + 1, nonce: 'x' } });
    await settle();
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', roomId: null });
    expect(leaveVoice).not.toHaveBeenCalled();
    expect(voice.takenOverRoom).toBe('A');
  });

  it('an older claim or another auth session changes nothing', async () => {
    await session('s1');
    await voice.join('A', 'ws');
    const mine = channel().sent[0] as { at: number };
    channel().onmessage?.({ data: { session: 's1', at: mine.at - 1, nonce: 'x' } });
    channel().onmessage?.({ data: { session: 's2', at: mine.at + 1, nonce: 'x' } });
    await settle();
    expect(useVoice.getState()).toMatchObject({ phase: 'connected', roomId: 'A' });
  });

  it('DUPLICATE_IDENTITY (the other tab connected to the same room): out without /voice/leave', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'DUPLICATE_IDENTITY');
    await settle();
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', roomId: null });
    expect(leaveVoice).not.toHaveBeenCalled();
    expect(joinVoice).toHaveBeenCalledTimes(1);
  });
});

describe('mic / sound choice across sessions and devices (ADR-0168, CBF-180)', () => {
  const ts = (sec: number): { seconds: bigint; nanos: number } => ({ seconds: BigInt(sec), nanos: 0 });
  const joinAnswer = (selfMute?: { muted: boolean; deafened: boolean; updatedAt: { seconds: bigint; nanos: number } }) =>
    joinVoice.mockImplementationOnce((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: true, canStream: true, pending: true, media: { audioBitrateKbps: 32 }, ...(selfMute ? { selfMute } : {}) }));
  /** The mic as LiveKit got it at publishTrack: the first thing the others could hear. */
  const atPublish: { isMuted: boolean; enabled: boolean }[] = [];
  const watchPublish = (): void => {
    atPublish.length = 0;
    FakeRoom.onConnect = () => {
      const r = FakeRoom.all.at(-1);
      r?.localParticipant.publishTrack.mockImplementation((t: FakeLocalAudioTrack) => {
        atPublish.push({ isMuted: t.isMuted, enabled: t.mediaStreamTrack.enabled });
        r.published.push(t);
        return Promise.resolve();
      });
      return Promise.resolve();
    };
  };
  /** A muted publish waits for LiveKit's mute lock (a timer): drive the clock through the join. */
  const joinA = async (): Promise<void> => {
    const p = voice.join('A', 'ws');
    await vi.advanceTimersByTimeAsync(50);
    await p;
  };
  beforeEach(async () => {
    const { useSession } = await import('../stores/session');
    useSession.setState({ me: { user: { id: 'u1' } }, status: 'authed' } as never);
  });

  it('joins with the stored mic off: published muted, never a moment of an open mic', async () => {
    watchPublish();
    joinAnswer({ muted: true, deafened: false, updatedAt: ts(1000) });
    expect(useVoice.getState().muted).toBe(false); // this device's last state: open
    await joinA();
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false, phase: 'connected' });
    expect(atPublish).toEqual([{ isMuted: true, enabled: false }]);
    // The pending row is right before LiveKit connects, and the server's value is not sent back.
    expect(updateSelf.mock.calls[0]?.[0]).toMatchObject({ muted: true, deafened: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(setVoiceMute).not.toHaveBeenCalled();
  });

  it('joins deafened from another device; undeafen returns to the stored mic (open)', async () => {
    joinAnswer({ muted: false, deafened: true, updatedAt: ts(1000) });
    await joinA();
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: true, mutedBeforeDeafen: false });
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(true);
    voice.toggleDeafen();
    expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
  });

  it('a stored open mic opens a muted device at join (the choice follows the user)', async () => {
    useVoice.setState({ muted: true });
    joinAnswer({ muted: false, deafened: false, updatedAt: ts(1000) });
    await joinA();
    await vi.advanceTimersByTimeAsync(100);
    expect(useVoice.getState().muted).toBe(false);
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
  });

  it('no server value (an older server): the local copy of the last session stands in', async () => {
    mem.set('calab-voice-mute', JSON.stringify({ userId: 'u1', muted: true, deafened: false, dirty: false, at: 5 }));
    watchPublish();
    await joinA();
    expect(useVoice.getState().muted).toBe(true);
    expect(atPublish).toEqual([{ isMuted: true, enabled: false }]);
  });

  it('a click not yet stored on the server wins over its older value and is sent', async () => {
    mem.set('calab-voice-mute', JSON.stringify({ userId: 'u1', muted: false, deafened: true, dirty: true, at: 5 }));
    joinAnswer({ muted: false, deafened: false, updatedAt: ts(1) });
    await joinA();
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: true });
    await settle();
    expect(setVoiceMute.mock.calls).toEqual([[{ muted: false, deafened: true }]]);
  });

  it('my clicks are stored once per burst; the auto-mute and a moderator mute are not my choice', async () => {
    usePrefs.getState().setPrefs({ autoMuteSec: 30 });
    await joinA();
    voice.toggleMute();
    voice.toggleMute();
    voice.toggleMute();
    expect(setVoiceMute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(setVoiceMute.mock.calls).toEqual([[{ muted: true, deafened: false }]]);
    voice.toggleMute(); // open again (auto-mute armed)
    await vi.advanceTimersByTimeAsync(600);
    expect(setVoiceMute.mock.calls.at(-1)).toEqual([{ muted: false, deafened: false }]);
    setVoiceMute.mockClear();
    await vi.advanceTimersByTimeAsync(30_000); // the auto-mute
    expect(useVoice.getState().muted).toBe(true);
    voice.toggleMute(); // «Включить»: back to the stored choice, nothing to send
    // A moderator mute: still not my choice; deafen on top is, with the mic as I had chosen it.
    voice.reconcileSelfState({ roomId: 'A', muted: true, deafened: false, serverMuted: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(setVoiceMute).not.toHaveBeenCalled();
    voice.toggleDeafen();
    await vi.advanceTimersByTimeAsync(600);
    expect(setVoiceMute.mock.calls).toEqual([[{ muted: false, deafened: true }]]);
    usePrefs.getState().setPrefs({ autoMuteSec: 0 });
  });

  it('push-to-talk stays per device: the stored choice never touches the mode, a reconnect keeps my state', async () => {
    usePrefs.getState().setPrefs({ micMode: 'ptt', micModeLocal: true });
    joinAnswer({ muted: false, deafened: false, updatedAt: ts(1000) });
    await joinA();
    expect(usePrefs.getState().micMode).toBe('ptt');
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack.enabled).toBe(false); // PTT gate closed, not muted
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
    const { micModeFromServer } = await import('./profile');
    const { MicMode } = await import('@calaba/protocol');
    expect(micModeFromServer({ micMode: 'ptt', micModeLocal: true }, MicMode.VAD)).toEqual({});
    expect(micModeFromServer({ micMode: 'voice', micModeLocal: false }, MicMode.PUSH_TO_TALK)).toEqual({ micMode: 'ptt', micModeLocal: true });
    usePrefs.getState().setPrefs({ micMode: 'voice', micModeLocal: false });
  });

  it('READY / USER_UPDATE apply the stored choice only outside voice; a late echo of an older write is ignored', async () => {
    const { applyServerVoiceMute } = await import('./voiceMute');
    const { create } = await import('@bufbuild/protobuf');
    const { VoiceMuteSchema } = await import('@calaba/protocol');
    const vm = (muted: boolean, deafened: boolean, sec: number) => create(VoiceMuteSchema, { muted, deafened, updatedAt: ts(sec) });
    applyServerVoiceMute(vm(true, false, 100));
    expect(useVoice.getState().muted).toBe(true);
    applyServerVoiceMute(vm(false, false, 50)); // older than what this device has seen
    expect(useVoice.getState().muted).toBe(true);
    await joinA();
    applyServerVoiceMute(vm(false, true, 200)); // another device, while this one is in voice
    expect(useVoice.getState()).toMatchObject({ muted: true, deafened: false });
  });
});

describe('auto-mute after silence («Выключать микрофон, если я молчу»)', () => {
  /** 20 ms worklet frames: speech opens the VAD gate (2 frames), silence closes it after the 400 ms hangover. */
  const speak = (): void => {
    for (let i = 0; i < 3; i++) pipelines.at(-1)?.onReport?.({ rms: 0.5, vad: -1 });
  };
  const hush = (): void => {
    for (let i = 0; i < 25; i++) pipelines.at(-1)?.onReport?.({ rms: 0, vad: -1 });
  };
  const running = (): boolean => (voice as unknown as { autoMute: { running: boolean } }).autoMute.running;
  const join = async (): Promise<void> => {
    await voice.join('A', 'ws');
    await vi.waitFor(() => expect(FakeRoom.all.at(-1)?.published.length).toBe(1));
  };

  it('off by default: no timer in voice', async () => {
    await join();
    expect(running()).toBe(false);
    await voice.leave();
  });

  it('mutes like the button after the period of silence, once, with an undo toast', async () => {
    usePrefs.getState().setPrefs({ autoMuteSec: 30 });
    await join();
    expect(running()).toBe(true);
    updateSelf.mockClear();
    playSound.mockClear();
    pushToast.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(useVoice.getState().muted).toBe(true);
    expect(playSound).toHaveBeenCalledWith('mute');
    expect(updateSelf).toHaveBeenLastCalledWith({ muted: true, deafened: false, musician: false, ptt: false });
    expect(running()).toBe(false);
    const [kind, text, action] = pushToast.mock.calls.at(-1) as [string, string, { run: () => void }];
    expect(kind).toBe('info');
    expect(text).toBe('Микрофон выключен: вы молчали 30 секунд');
    // Speech does not turn the mic back on; «Включить» does.
    speak();
    expect(useVoice.getState().muted).toBe(true);
    action.run();
    expect(useVoice.getState().muted).toBe(false);
    expect(running()).toBe(false); // the gate is still open from that speech: on air
    hush();
    expect(running()).toBe(true); // armed again for the next silence
    await voice.leave();
  });

  it('speech resets the countdown; silence starts it from the full period', async () => {
    usePrefs.getState().setPrefs({ autoMuteSec: 30 });
    await join();
    await vi.advanceTimersByTimeAsync(25_000);
    speak();
    expect(running()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000); // a long talk: never muted
    hush();
    expect(running()).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(useVoice.getState().muted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useVoice.getState().muted).toBe(true);
    await voice.leave();
  });

  it('not armed in push-to-talk, while muted or deafened; cancelled on leave and when turned off', async () => {
    usePrefs.getState().setPrefs({ autoMuteSec: 30, micMode: 'ptt' });
    await join();
    expect(running()).toBe(false);
    usePrefs.getState().setPrefs({ micMode: 'voice' });
    expect(running()).toBe(true);
    voice.toggleMute();
    expect(running()).toBe(false);
    voice.toggleMute();
    expect(running()).toBe(true);
    voice.toggleDeafen();
    expect(running()).toBe(false);
    voice.toggleDeafen();
    expect(running()).toBe(true);
    usePrefs.getState().setPrefs({ autoMuteSec: 0 });
    expect(running()).toBe(false);
    usePrefs.getState().setPrefs({ autoMuteSec: 60 });
    expect(running()).toBe(true);
    await voice.leave();
    expect(running()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(useVoice.getState().muted).toBe(false);
  });

  it('a VAD edge touches only the speaking / on-air keys: no prefs change, no new voice keys', async () => {
    usePrefs.getState().setPrefs({ autoMuteSec: 300 });
    await join();
    const changed = new Set<string>();
    const unsubVoice = useVoice.subscribe((s, p) => {
      for (const k of Object.keys(s) as (keyof typeof s)[]) if (s[k] !== p[k]) changed.add(k);
    });
    let prefsChanges = 0;
    const unsubPrefs = usePrefs.subscribe(() => {
      prefsChanges++;
    });
    speak();
    hush();
    speak();
    hush();
    await vi.advanceTimersByTimeAsync(100); // the speaking ring's hold + batch
    unsubVoice();
    unsubPrefs();
    expect(prefsChanges).toBe(0);
    expect([...changed].every((k) => ['transmitting', 'speaking', 'gateOpen'].includes(k))).toBe(true);
    await voice.leave();
  });
});

describe('a phone call parks the room (ADR-0133)', () => {
  type Pub = { source: string; trackSid: string; kind: string; isMuted: boolean; subscriptionStatus: string; setSubscribed: ReturnType<typeof vi.fn>; setEnabled: () => void };
  const pub = (source: string, trackSid: string): Pub => ({ source, trackSid, kind: 'audio', isMuted: false, subscriptionStatus: 'desired', setSubscribed: vi.fn(), setEnabled: () => undefined });
  const participant = (identity: string, pubs: Pub[]) => ({
    identity,
    trackPublications: new Map(pubs.map((p) => [p.trackSid, p])),
    getTrackPublication: (source: string) => pubs.find((p) => p.source === source),
    getTrackPublicationBySid: (sid: string) => pubs.find((p) => p.trackSid === sid),
  });
  const last = (p: Pub): unknown => p.setSubscribed.mock.calls.at(-1)?.[0];
  /** In room A with Борис's mic; local tracks are visible to the parking as publications. */
  async function inRoom(): Promise<{ room: FakeRoom; mic: Pub }> {
    await voice.join('A', 'ws');
    const room = FakeRoom.all.at(-1) as FakeRoom;
    const mic = pub('microphone', 'TR_mic_b');
    room.remoteParticipants.set('u2:b', participant('u2:b', [mic]));
    room.emit('TrackPublished', mic, room.remoteParticipants.get('u2:b'));
    return { room, mic };
  }
  async function answer(callId = 'c1'): Promise<boolean> {
    const { setPhoneJoin } = await import('../lib/sipInbound');
    const parked = await voice.park();
    setPhoneJoin(`sipin:${callId}`, { url: 'wss://lk', token: `t-${callId}`, identity: 'answer', canSpeak: true } as never);
    voice.unmuteForAnswer(); // as services/sipInbound.ts acceptInbound
    await voice.join(`sipin:${callId}`, '', { call: true });
    return parked;
  }

  it('«Принять»: the room stays connected with nothing sent or received; hang-up brings it back without a reconnect', async () => {
    const { room, mic } = await inRoom();
    voice.toggleMute(); // muted before the call
    await settle();
    updateSelf.mockClear();
    expect(await answer()).toBe(true);
    expect(room.disconnects).toHaveLength(0);
    expect(room.published).toHaveLength(0);
    expect(last(mic)).toBe(false);
    expect(updateSelf).toHaveBeenCalledWith({ onPhone: true });
    expect(useVoice.getState()).toMatchObject({ roomId: 'sipin:c1', parked: { roomId: 'A', workspaceId: 'ws' } });
    const phoneRoom = FakeRoom.all.at(-1) as FakeRoom;
    expect(phoneRoom).not.toBe(room);
    // A mic published in the parked room meanwhile is not subscribed (its handlers are silent).
    const late = pub('microphone', 'TR_mic_c');
    room.remoteParticipants.set('u3:c', participant('u3:c', [late]));
    room.emit('TrackPublished', late, room.remoteParticipants.get('u3:c'));
    expect(late.setSubscribed).not.toHaveBeenCalled();
    await voice.leave(); // hang up
    await settle();
    await settle();
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', workspaceId: 'ws', phase: 'connected', parked: null, muted: true });
    expect(voice.currentRoomId).toBe('A');
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A']); // no new /join
    expect(room.disconnects).toHaveLength(0);
    expect(room.published).toHaveLength(1);
    expect([last(mic), last(late)]).toEqual([true, true]);
    expect(updateSelf).toHaveBeenLastCalledWith(expect.objectContaining({ muted: true, onPhone: false }));
  });

  it('«Выйти» from the parked room leaves it and keeps the phone call', async () => {
    const { room } = await inRoom();
    await answer();
    voice.leaveParked();
    await settle();
    expect(room.disconnects).toHaveLength(1);
    expect(leaveVoice).toHaveBeenCalledWith('A');
    expect(useVoice.getState()).toMatchObject({ roomId: 'sipin:c1', phase: 'connected', parked: null });
    await voice.leave();
    await settle();
    expect(useVoice.getState().roomId).toBeNull(); // nothing to come back to
  });

  it('another room picked during the call is entered after it; a one-to-one call drops the parked room', async () => {
    const { room } = await inRoom();
    await answer();
    await voice.join('B', 'ws');
    await settle();
    expect(room.disconnects).toHaveLength(1);
    expect(leaveVoice).toHaveBeenCalledWith('A');
    expect(useVoice.getState()).toMatchObject({ roomId: 'sipin:c1', parked: { roomId: 'B', workspaceId: 'ws' } });
    await voice.leave();
    await settle();
    expect(useVoice.getState()).toMatchObject({ roomId: 'B', phase: 'connected', parked: null });
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);

    await answer('c2');
    expect(useVoice.getState().parked).toMatchObject({ roomId: 'B' });
    await voice.join('dm', '', { call: true });
    await settle();
    expect(useVoice.getState()).toMatchObject({ roomId: 'dm', parked: null });
    expect(leaveVoice).toHaveBeenCalledWith('B');
  });

  it('a moderator removal of the parked room: no resume after the call', async () => {
    const { room } = await inRoom();
    await answer();
    room.emit('Disconnected', 'PARTICIPANT_REMOVED');
    expect(useVoice.getState().parked).toBeNull();
    await voice.leave();
    await settle();
    expect(useVoice.getState().roomId).toBeNull();
    expect(joinVoice).toHaveBeenCalledTimes(1);
  });

  it('a parked connection lost meanwhile: the room is joined again after the call', async () => {
    const { room } = await inRoom();
    await answer();
    room.state = 'Disconnected';
    room.emit('Disconnected', 'SIGNAL_CLOSE');
    expect(useVoice.getState().parked).toMatchObject({ roomId: 'A' });
    await voice.leave();
    await settle();
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'A']);
  });

  it('a seat kept «on the phone» (reload during the call, idempotent /join): the connect clears the flag', async () => {
    const { useWorkspaces } = await import('../stores/workspaces');
    const { useSession } = await import('../stores/session');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
    useWorkspaces.setState({ byId: { ws: { ws: {}, voice: { u1: { userId: 'u1', roomId: 'A', onPhone: true } } } } as never });
    await voice.join('A', 'ws', { resumed: true });
    await settle();
    expect(updateSelf).toHaveBeenLastCalledWith(expect.objectContaining({ onPhone: false }));
    await voice.leave();
    useWorkspaces.setState({ byId: {} });
  });

  it('nothing to park in a one-to-one call: the caller leaves it as before', async () => {
    await voice.join('dm', '', { call: true });
    expect(await voice.park()).toBe(false);
    expect(useVoice.getState().parked).toBeNull();
  });
});

describe('mic state convergence on a flaky link (ADR-0134)', () => {
  const offline = (): Promise<void> => Promise.reject(new Error('Failed to fetch'));

  it('a failed PATCH /voice/self is retried until it lands, the UI flags the lag meanwhile', async () => {
    await voice.join('A', 'ws');
    updateSelf.mockClear();
    updateSelf.mockImplementationOnce(offline).mockImplementationOnce(offline);
    voice.toggleMute();
    await settle();
    expect(updateSelf).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateSelf).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(useVoice.getState().micSyncLag).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateSelf).toHaveBeenCalledTimes(3);
    expect(updateSelf).toHaveBeenLastCalledWith(expect.objectContaining({ muted: true }));
    expect(useVoice.getState().micSyncLag).toBe(false);
  });

  it('an older PATCH never lands after a newer one: one in flight, the latest intent last', async () => {
    await voice.join('A', 'ws');
    await settle();
    updateSelf.mockClear();
    let release!: () => void;
    updateSelf.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    voice.toggleMute();
    voice.toggleMute();
    voice.toggleMute();
    expect(updateSelf).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(updateSelf).toHaveBeenCalledTimes(2);
    expect(updateSelf).toHaveBeenLastCalledWith(expect.objectContaining({ muted: true }));
  });

  it('the gateway back: my flags are re-asserted when the server copy differs', async () => {
    const { useSession } = await import('../stores/session');
    const { useWorkspaces } = await import('../stores/workspaces');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
    await voice.join('A', 'ws');
    voice.toggleMute();
    await settle();
    updateSelf.mockClear();
    // The server lost the PATCH meanwhile (READY carries its copy: unmuted).
    useWorkspaces.setState({ byId: { ws: { ws: {}, voice: { u1: { userId: 'u1', roomId: 'A', muted: false, deafened: false } } } } as never });
    voice.onGatewayBack();
    await settle();
    expect(updateSelf).toHaveBeenCalledWith(expect.objectContaining({ muted: true }));
  });

  it('a rejecting unmute during Reconnecting is retried with backoff, not in a tight loop', async () => {
    await voice.join('A', 'ws');
    voice.toggleMute();
    await settle();
    const track = FakeRoom.all[0]?.published[0];
    expect(track?.isMuted).toBe(true);
    FakeLocalAudioTrack.ops = 0;
    FakeLocalAudioTrack.failOps = 3;
    voice.toggleMute();
    await settle();
    expect(FakeLocalAudioTrack.ops).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(useVoice.getState().micSyncLag).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(track?.isMuted).toBe(false);
    expect(FakeLocalAudioTrack.ops).toBe(4);
    expect(useVoice.getState().micSyncLag).toBe(false);
  });

  it('a hung unmute does not block the mic for good: timed out and tried again', async () => {
    await voice.join('A', 'ws');
    voice.toggleMute();
    await settle();
    const track = FakeRoom.all[0]?.published[0];
    FakeLocalAudioTrack.hangOps = 1;
    voice.toggleMute();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(useVoice.getState().muted).toBe(false);
    expect(track?.isMuted).toBe(false);
  });

  it('LiveKit Reconnected re-asserts the mic and my flags', async () => {
    await voice.join('A', 'ws');
    voice.toggleMute();
    await settle();
    updateSelf.mockClear();
    FakeRoom.all[0]?.emit('Reconnected');
    await settle();
    expect(updateSelf).toHaveBeenCalledWith(expect.objectContaining({ muted: true }));
  });

  it('leaving voice stops every retry timer', async () => {
    await voice.join('A', 'ws');
    updateSelf.mockImplementation(offline);
    voice.toggleMute();
    await settle();
    await voice.leave();
    const n = updateSelf.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updateSelf.mock.calls.length).toBe(n);
    expect(useVoice.getState().micSyncLag).toBe(false);
  });
});

describe('one mic view for the panel, my row and the island (#96)', () => {
  const ptt = { micMode: 'ptt' as const, pttReleaseMs: 0, pttBinding: { kind: 'key' as const, code: 66, label: 'F8', mode: 'hold' as const } };
  const view = async () => {
    const { selfMicNow } = await import('../features/voice/selfMic');
    const { selfMicGlyph } = await import('../lib/voiceLogic');
    const m = selfMicNow();
    return { ...m, glyph: selfMicGlyph(m, useVoice.getState().pttDown) };
  };
  /** My server copy (VOICE_STATE_UPDATE) as the room list reads it. */
  const seat = async (s: { roomId: string; muted: boolean; deafened?: boolean; serverMuted?: boolean; ptt?: boolean } | null): Promise<void> => {
    const { useWorkspaces } = await import('../stores/workspaces');
    useWorkspaces.setState({ byId: { ws: { ws: {}, voice: s ? { u1: { userId: 'u1', deafened: false, ...s } } : {} } } } as never);
  };
  const track = () => FakeRoom.all.at(-1)?.published[0];
  const hold = (down: boolean) => (voice as unknown as { onPtt(ev: { down: boolean }): void }).onPtt({ down });
  beforeEach(async () => {
    const { useSession } = await import('../stores/session');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
  });
  afterEach(() => {
    usePrefs.getState().setPrefs({ micMode: 'voice', musicianMode: false, micDeviceId: null });
  });

  it('the reported case: this device idle, my seat muted on another device — panel and row both crossed', async () => {
    // Before #96 the panel drew this device's pre-join intent (mic on) and the row the server copy (off).
    await seat({ roomId: 'A', muted: true });
    expect(useVoice.getState().muted).toBe(false);
    expect(await view()).toMatchObject({ elsewhere: true, muted: true, glyph: 'muted' });
    // The other device unmutes / turns PTT on: both follow the server at once.
    await seat({ roomId: 'A', muted: false, ptt: true });
    expect(await view()).toMatchObject({ muted: false, glyph: 'ptt-idle' });
    await seat({ roomId: 'A', muted: false });
    expect(await view()).toMatchObject({ muted: false, glyph: 'live' });
    await seat(null);
    expect(await view()).toMatchObject({ elsewhere: false, here: false, muted: false });
  });

  it('a click / hotkey while another device holds the seat changes nothing and says where to switch', async () => {
    const { toast } = await import('../stores/toasts');
    await seat({ roomId: 'A', muted: true });
    voice.toggleMute();
    voice.toggleDeafen();
    expect(useVoice.getState()).toMatchObject({ muted: false, deafened: false });
    expect(vi.mocked(toast.info).mock.calls.map((c) => c[0])).toEqual([
      'Голос подключён на другом устройстве — переключайте там',
      'Голос подключён на другом устройстве — переключайте там',
    ]);
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('in the call: the intent wins over a lagging server copy, on every click', async () => {
    await voice.join('A', 'ws');
    await settle();
    await seat({ roomId: 'A', muted: false });
    let release!: () => void;
    updateSelf.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    voice.toggleMute(); // the PATCH hangs: the server still says «on»
    expect(await view()).toMatchObject({ here: true, muted: true, glyph: 'muted' });
    await settle();
    expect(track()?.isMuted).toBe(true);
    voice.toggleMute();
    expect(await view()).toMatchObject({ muted: false, glyph: 'live' });
    release();
    await settle();
  });

  it('a moderator mute from the server: crossed everywhere, with the server-mute flag', async () => {
    await voice.join('A', 'ws');
    voice.reconcileSelfState({ roomId: 'A', muted: true, deafened: false, serverMuted: true });
    expect(await view()).toMatchObject({ muted: true, serverMuted: true, glyph: 'muted' });
    voice.reconcileSelfState({ roomId: 'A', muted: true, deafened: false, serverMuted: false });
    expect(await view()).toMatchObject({ muted: true, serverMuted: false });
  });

  it('deafen implies the crossed mic in both places', async () => {
    await voice.join('A', 'ws');
    voice.toggleDeafen();
    expect(await view()).toMatchObject({ muted: true, deafened: true, glyph: 'muted' });
  });

  it('PTT: pale in the list while the key is up, live (green dot) while held, off when muted', async () => {
    usePrefs.getState().setPrefs(ptt);
    await voice.join('A', 'ws');
    await settle();
    expect(await view()).toMatchObject({ ptt: true, muted: false, glyph: 'ptt-idle' });
    hold(true);
    expect(await view()).toMatchObject({ glyph: 'live' });
    hold(false);
    await settle();
    expect(await view()).toMatchObject({ glyph: 'ptt-idle' });
    voice.toggleMute();
    expect(await view()).toMatchObject({ glyph: 'muted' });
  });

  it('a one-to-one call is voice activation only: no PTT wait in the view', async () => {
    usePrefs.getState().setPrefs(ptt);
    await voice.join('A', 'ws');
    useVoice.setState({ call: true });
    expect(await view()).toMatchObject({ ptt: false, glyph: 'live' });
  });

  it('device switch / loss, musician mode and a reconnect keep the view and the track on the intent', async () => {
    usePrefs.getState().setPrefs(ptt);
    await voice.join('A', 'ws');
    await vi.waitFor(() => expect(track()).toBeDefined());
    voice.toggleMute();
    await settle();
    expect(await view()).toMatchObject({ muted: true, glyph: 'muted' });
    // Input device switch: the capture is swapped in place.
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    await vi.waitFor(() => expect(pipelines.length).toBe(2));
    await settle();
    expect(await view()).toMatchObject({ muted: true, glyph: 'muted' });
    expect(track()?.isMuted).toBe(true);
    // Musician mode on.
    usePrefs.getState().setPrefs({ musicianMode: true });
    await vi.waitFor(() => expect(pipelines.length).toBe(3));
    await settle();
    expect(await view()).toMatchObject({ muted: true, glyph: 'muted' });
    expect(track()?.isMuted).toBe(true);
    // The device lost (capture ended by the OS): rebuilt.
    pipelines.at(-1)?.onEnded?.();
    await vi.waitFor(() => expect(pipelines.length).toBe(4));
    await settle();
    expect(await view()).toMatchObject({ muted: true });
    expect(track()?.isMuted).toBe(true);
    // A full reconnect: the new room publishes the mic muted, as the view says.
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await vi.advanceTimersByTimeAsync(1100);
    expect(FakeRoom.all).toHaveLength(2);
    expect(await view()).toMatchObject({ here: true, muted: true, glyph: 'muted' });
    expect(track()?.isMuted).toBe(true);
    // And back on: the view and the track agree again.
    voice.toggleMute();
    await settle();
    expect(await view()).toMatchObject({ muted: false, glyph: 'ptt-idle' });
    expect(track()?.isMuted).toBe(false);
    await voice.leave();
  });
});

describe('the page away and back', () => {
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const doc = document as unknown as { hidden?: boolean };
  const setHidden = (hidden: boolean): void => {
    doc.hidden = hidden;
    for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
  };
  const reconnecting = (room: FakeRoom): void => {
    room.state = 'Reconnecting';
    room.emit('ConnectionStateChanged', 'Reconnecting');
  };
  beforeEach(async () => {
    const { toast } = await import('../stores/toasts');
    vi.mocked(toast.error).mockClear();
    pushToast.mockClear();
  });
  afterEach(() => {
    doc.hidden = false;
    (navigator as unknown as { userAgent: string }).userAgent = 'test';
  });

  it('back after a long hide with LiveKit still reconnecting: rejoins at once; no cue while hidden; no outage toast', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (!a) throw new Error('no room');
    playSound.mockClear();
    setHidden(true);
    reconnecting(a);
    expect(playSound).not.toHaveBeenCalled(); // a hidden web page: no «disconnect»
    await vi.advanceTimersByTimeAsync(25_000);
    joinVoice.mockClear();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(joinVoice.mock.calls).toEqual([['A']]); // not after the 5 s / 30 s timers
    expect(useVoice.getState()).toMatchObject({ roomId: 'A', phase: 'connected' });
    expect(playSound.mock.calls).toEqual([['reconnect']]);
    expect(pushToast).not.toHaveBeenCalled(); // the outage is only logged
  });

  it('a short hide: LiveKit’s own resume gets the visible grace (15 s) before the seat check rejoins', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (!a) throw new Error('no room');
    setHidden(true);
    reconnecting(a);
    await vi.advanceTimersByTimeAsync(3_000);
    joinVoice.mockClear();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(joinVoice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500); // the grace + the cycle's first 1 s
    expect(joinVoice.mock.calls).toEqual([['A']]);
  });

  it('autoplay refused: «Вы не слышите собеседников»; the tap runs room.startAudio()', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (!a) throw new Error('no room');
    a.canPlaybackAudio = false;
    a.emit('AudioPlaybackStatusChanged', false);
    expect(pushToast).toHaveBeenCalledTimes(1);
    const [kind, text, action] = pushToast.mock.calls[0] as [string, string, { label: string; run: () => void }];
    expect([kind, text, action.label]).toEqual(['info', 'Вы не слышите собеседников', 'Включить звук']);
    action.run();
    expect(a.startAudio).toHaveBeenCalledTimes(1);
  });

  it('the sound prompt is raised once while it is on screen, closed when playback is possible, raised again if refused again', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (!a) throw new Error('no room');
    a.canPlaybackAudio = false;
    a.emit('AudioPlaybackStatusChanged', false);
    a.emit('AudioPlaybackStatusChanged', false);
    expect(pushToast).toHaveBeenCalledTimes(1);
    a.canPlaybackAudio = true;
    a.emit('AudioPlaybackStatusChanged', true);
    expect(dismissToast).toHaveBeenCalledTimes(1);
    expect(shown.ids).toEqual([]);
    a.canPlaybackAudio = false;
    a.emit('AudioPlaybackStatusChanged', false);
    expect(pushToast).toHaveBeenCalledTimes(2);
  });

  it('the sound prompt is never held back by other toasts on screen', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (!a) throw new Error('no room');
    shown.ids.push(900, 901, 902); // somebody else’s toasts
    a.canPlaybackAudio = false;
    a.emit('AudioPlaybackStatusChanged', false);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0]?.[1]).toBe('Вы не слышите собеседников');
  });

  it('a subscribed mic without a track is resubscribed (at most twice), never a rejoin', async () => {
    await voice.join('A', 'ws');
    const a = FakeRoom.all[0];
    if (!a) throw new Error('no room');
    const pub = { source: 'microphone', trackSid: 'TR_b', kind: 'audio', isMuted: false, isDesired: true, track: undefined, setSubscribed: vi.fn(), setEnabled: () => undefined };
    a.remoteParticipants.set('u2:b', { identity: 'u2:b', trackPublications: new Map([['TR_b', pub]]), getTrackPublication: (s: string) => (s === 'microphone' ? pub : undefined) });
    joinVoice.mockClear();
    a.emit('Reconnected');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pub.setSubscribed.mock.calls).toEqual([[false]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(pub.setSubscribed.mock.calls).toEqual([[false], [true]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pub.setSubscribed.mock.calls).toEqual([[false], [true], [false], [true]]);
    expect(joinVoice).not.toHaveBeenCalled();
  });

  it('the system holds the mic: «Ждём микрофон», one rebuild after ~2 s visible, «Вас не слышно» when it fails; no toast, no micError', async () => {
    await voice.join('A', 'ws');
    const p = pipelines[0];
    if (!p) throw new Error('no pipeline');
    p.muted = true;
    p.onMute?.(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(useVoice.getState()).toMatchObject({ micTrouble: 'recovering', micError: null, phase: 'connected' });
    micStarts.failNext = Object.assign(new Error('could not start audio source'), { name: 'NotReadableError' });
    await vi.advanceTimersByTimeAsync(600);
    expect(micStarts.n).toBe(2);
    expect(useVoice.getState().micTrouble).toBe('unheard'); // the header / strip status
    expect(useVoice.getState().micError).toBeNull(); // that line is for device and permission errors
    expect(pushToast).not.toHaveBeenCalled(); // the line is enough
    await vi.advanceTimersByTimeAsync(30_000);
    expect(micStarts.n).toBe(2); // one rebuild per episode
  });

  it('the system lets the mic go: the trouble clears, the context resumes, no rebuild', async () => {
    await voice.join('A', 'ws');
    const p = pipelines[0];
    if (!p) throw new Error('no pipeline');
    p.muted = true;
    p.onMute?.(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(useVoice.getState().micTrouble).toBe('recovering');
    p.muted = false;
    p.onMute?.(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(useVoice.getState().micTrouble).toBeNull();
    expect(p.resumeContext).toHaveBeenCalled();
    expect(micStarts.n).toBe(1);
  });

  it('a suspended capture context (an interruption) is resumed, not rebuilt', async () => {
    await voice.join('A', 'ws');
    const p = pipelines[0];
    if (!p) throw new Error('no pipeline');
    p.ctx = 'interrupted';
    p.onContextState?.('interrupted');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(p.resumeContext).toHaveBeenCalled();
    expect(p.ctx).toBe('running');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pipelines).toHaveLength(1);
  });

  it('a hidden iPhone page never restarts the capture: the ended track is rebuilt once visible', async () => {
    (navigator as unknown as { userAgent: string }).userAgent = IPHONE_UA;
    vi.resetModules();
    docListeners.clear();
    ({ voice } = await import('./voice'));
    ({ useVoice } = await import('../stores/voice'));
    voice.init();
    await voice.join('A', 'ws');
    const p = pipelines.at(-1);
    if (!p) throw new Error('no pipeline');
    const starts = micStarts.n;
    setHidden(true);
    p.track.stop();
    p.onEnded?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(micStarts.n).toBe(starts);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(micStarts.n).toBe(starts + 1);
  });
});

describe('a web companion is never a second person (ADR-0149 §3)', () => {
  const p = (identity: string) => ({ identity, trackPublications: new Map(), getTrackPublication: () => undefined, getTrackPublicationBySid: () => undefined });

  it('no «join» for a companion, and its device leaving still plays «leave»', async () => {
    const { useSession } = await import('../stores/session');
    useSession.setState({ me: { user: { id: 'u1' } } } as never);
    await voice.join('A', 'ws');
    const room = FakeRoom.all.at(-1);
    if (!room) throw new Error('no room');
    room.remoteParticipants.set('u2:s', p('u2:s'));
    room.emit('ParticipantConnected', p('u2:s'));
    expect(playSound).toHaveBeenLastCalledWith('join');
    playSound.mockClear();
    room.remoteParticipants.set('u2:s:web', p('u2:s:web'));
    room.emit('ParticipantConnected', p('u2:s:web'));
    expect(playSound).not.toHaveBeenCalled();
    room.remoteParticipants.delete('u2:s');
    room.emit('ParticipantDisconnected', p('u2:s'));
    expect(playSound).toHaveBeenCalledExactlyOnceWith('leave');
    playSound.mockClear();
    room.remoteParticipants.delete('u2:s:web');
    room.emit('ParticipantDisconnected', p('u2:s:web'));
    expect(playSound).not.toHaveBeenCalled();
  });
});
