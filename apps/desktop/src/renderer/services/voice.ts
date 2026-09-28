import { AUDIO_PUBLISH_DEFAULTS, SCREEN_SHARE_PRESETS, type ConcreteScreenSharePreset, type ScreenShareContentHint, type VoiceMoved } from '@calaba/protocol';
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TrackPublishOptions,
} from 'livekit-client';
import type { PttEvent } from '../../shared/ipc';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { roomPerms, voiceCaps } from '../lib/permissions';
import { MicPipeline } from '../lib/media/micPipeline';
import type { MicReport } from '../lib/media/micReport';
import {
  applyPreset,
  captureScreen,
  startScreenShare,
  type ActiveScreenShare,
  type CapturedScreen,
  type DesktopSource,
} from '../lib/media/screenShare';
import { pickPublishCodec } from '../lib/media/codecSelect';
import { installH264ProfileHook } from '../lib/media/h264Publish';
import { ECHO, EchoRiskDetector, RemoteActivity, duckWanted, duckable } from '../lib/media/echo';
import { RateTracker, audioSourceEcho, candidatePair, inboundAudio, inboundVideo, outboundAudio, outboundVideo, transportBytes } from '../lib/media/stats';
import { VoiceGate, rmsToDb } from '../lib/media/vad';
import { denoiseMode, wakeDbFor } from '../lib/media/denoiseSleep';
import { playSound } from '../lib/sounds';
import { PttRelease } from '../lib/pttRelease';
import { SpeakingDebouncer, speakingUserIds } from '../lib/speaking';
import { REMOTE_LEVEL, RemoteLevelSpeaking, readLevel, type LevelSample } from '../lib/remoteSpeaking';
import { audioDevices, deviceName, deviceSwitches, type AudioDevice } from '../lib/deviceSwitch';
import { canSpeakFrom, isDeviceGone, meterUpdate, pttAllowed, pttCue, qualityOf, toggleDeafen, toggleMute, transmitDecision, withUserMuted, withUserVolume } from '../lib/voiceLogic';
import { RemoteAudioOut } from '../lib/media/remoteAudioOut';
import { useMessages } from '../stores/messages';
import { useRooms } from '../stores/rooms';
import { prefs, usePrefs, type Prefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { memberName, rolesOf, useWorkspaces } from '../stores/workspaces';
import { setVoice, useVoice, type RemoteCamera, type RemoteStream, type StreamQuality, type VoiceLink } from '../stores/voice';
import { platform } from '../platform';
import { cameraWanted } from '../lib/media/cameraLogic';
import { pipCamera } from '../features/voice/tileLayout';
import { ActiveSpeaker } from '../lib/activeSpeaker';
import { cspBlockedHost, describeConnectError, describeDisconnect, hostOfUrl } from '../lib/voiceLink';
import { seatAction, seatRefused, type SeatView } from '../lib/voiceSeat';
import { annot } from './annot';
import { ANNOT_TOPIC } from '../lib/annot/codec';
import { CameraController, cameraGrantMissing } from './camera';
import { announceDeviceSwitch } from './deviceToast';
import { humanMediaError, reportMediaError } from './mediaErrors';
import { reportPlanError } from './plan';
import { capFps } from '../lib/plan';
import { sameBinding } from './profile';

/**
 * One voice connection (LiveKit room) of this device. Rules that must not be
 * broken here (docs/02-media.md, ADR-0004):
 *  1. remote audio only through <audio> elements (`webAudioMix: false`), no WebAudio on output;
 *  2. output device switched with setSinkId on the same elements;
 *  3. RNNoise (and the speakerphone duck) after AEC3, built-in NS off while RNNoise is on;
 *  4. never unpublish to go quiet. Explicit mute (self-mute, deafen, moderator, no SPEAK) =
 *     LiveKit `track.mute()`; closed VAD gate / released PTT = `mediaStreamTrack.enabled =
 *     false` only — the sender emits silence (Opus DTX), no signalling (ADR-0014, lib/voiceLogic.ts).
 */

const METER_UI_INTERVAL_MS = 50;
const STATS_INTERVAL_MS = ECHO.statsMs;
/** Remote SSRC levels are fresh when played out within this window (DTX sends ~every 400 ms). */
const LEVEL_FRESH_MS = 500;
/** LiveKit data topic for "who watches my stream" (docs/05: data channels only for in-call ephemera). */
const WATCH_TOPIC = 'calaba.watch';
/** A /join waits at most this long for a /voice/leave still in flight. */
const LEAVE_WAIT_MS = 3000;
/** Seat check (docs/09 #71): a join / leave in progress is waited out this often, this many times. */
const SEAT_BUSY_POLL_MS = 500;
const SEAT_BUSY_POLLS = 40;
/** LiveKit still resuming by itself this long after the gateway is back → rejoin with a fresh token. */
const SEAT_RECONNECT_GRACE_MS = 5000;
/** A VOICE_STATE_UPDATE that does not show me where I am: checked after this (a move settles). */
const SEAT_SELF_GRACE_MS = 3000;

/** LiveKit identity is `<user_id>:<session_id>` (rtc.proto). */
export const userIdOf = (identity: string): string => identity.split(':')[0] ?? identity;

const LK_QUALITY: Record<Exclude<StreamQuality, 'auto'>, VideoQuality> = {
  high: VideoQuality.HIGH,
  medium: VideoQuality.MEDIUM,
  low: VideoQuality.LOW,
};

/** One simulcast layer of a remote stream, as published (for the viewer's quality menu). */
export interface StreamLayer {
  quality: Exclude<StreamQuality, 'auto'>;
  width: number;
  height: number;
}

/**
 * Join credentials handed over by the server for an app-level move (ADR-0019): connect with them
 * instead of calling /join; `serverMuted` carries the moderator mute over the teardown.
 */
interface MoveCreds {
  url: string;
  token: string;
  serverMuted: boolean;
}

export interface StreamOptions {
  source: DesktopSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  systemAudio: boolean;
}

/** Fewer messages than this in the voice room's chat → a new stream opens expanded (docs/09 #56). */
const SHORT_CHAT = 3;

/**
 * Layout for a stream the user starts watching: the room's remembered choice, else the expanded
 * stage when the room's chat is (nearly) empty — nothing to read beside a small PiP.
 */
export function defaultStage(roomId: string | null): 'pip' | 'expanded' {
  if (!roomId) return 'pip';
  const saved = usePrefs.getState().streamStage[roomId];
  if (saved) return saved;
  const m = useMessages.getState().rooms[roomId];
  const count = m?.loaded ? m.items.length + (m.hasMoreBefore ? SHORT_CHAT : 0) : useRooms.getState().lastMessage[roomId] ? SHORT_CHAT : 0;
  return count < SHORT_CHAT ? 'expanded' : 'pip';
}

const setLink = (p: Partial<VoiceLink>): void => setVoice({ link: { ...useVoice.getState().link, ...p } });

class VoiceEngine {
  private room: Room | null = null;
  private roomId: string | null = null;
  private joinSeq = 0;
  private mic: MicPipeline | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private readonly gate = new VoiceGate();
  /** PTT on air incl. the release tail (lib/pttRelease.ts); mirrors into the store's `pttDown`. */
  private readonly ptt = new PttRelease((on) => this.onPttTalking(on));
  /** performance.now() of the last PTT key-up and main's timestamp of it (debug latency log). */
  private pttUp: { t: number; at: number | undefined } | null = null;
  private lastMeterPush = 0;
  private audioBitrateKbps = 32;
  private screen: ActiveScreenShare | null = null;
  /**
   * Remote audio: one <audio> per track (echo rule 1), the only writer of their muted / volume /
   * sink (deafen, per-user volumes survive device switches and LiveKit's own writes; docs/02 «Deafen»).
   */
  private readonly audioOut = new RemoteAudioOut(() => {
    const v = useVoice.getState();
    const p = prefs();
    return { deafened: v.deafened, userVolumes: p.userVolumes, mutedUsers: p.mutedUsers, deafUsers: p.deafUsers, streamVolume: v.streamVolume, outputVolume: p.outputVolume };
  });
  /** Stream subscriptions we requested (setSubscribed signals on every call, so dedupe). */
  private readonly wanted = new Map<string, boolean>();
  /** Whose stream we told «I'm watching» (calaba.watch), to send the matching «stopped». */
  private announced: { owner: string; sid: string } | null = null;
  private readonly audioSink: HTMLDivElement;
  private readonly viewers = new Map<string, Set<string>>(); // my trackSid → viewer identities
  private readonly rates = new RateTracker();
  private statsTimer: number | null = null;
  /** 50 ms level sampling: remote voices (SSRC audio levels) + my mic → echo detector and duck. */
  private levelTimer: number | null = null;
  private readonly echo = new EchoRiskDetector();
  private readonly remoteTalk = new RemoteActivity();
  /** Post-AEC mic level of the last worklet report (dBFS). */
  private lastMicDb = -80;
  /** The «собеседник слышит себя» toast was shown in this call (once per call). */
  private echoToasted = false;
  /** Set while we mute the mic ourselves, to tell a moderator mute apart. */
  private selfMuting = false;
  private micTesting = false;
  /** Speaking rings: at once on, 200 ms hold off, batched store updates (lib/speaking.ts). */
  private readonly speakers = new SpeakingDebouncer((speaking) => this.onSpeaking(speaking));
  /**
   * Raw speaking sources: remote — LiveKit active-speaker identities OR the local level of their
   * incoming audio (lib/remoteSpeaking.ts); me — my own transmit state.
   */
  private remoteSpeakers: string[] = [];
  private readonly levelSpeakers = new RemoteLevelSpeaking();
  /** The remote-level speaking sampler runs (on every 2nd echo tick: one timer, docs/14-energy.md). */
  private levelSpeakOn = false;
  private levelTick = 0;
  private selfSpeaking = false;
  private readonly active = new ActiveSpeaker((id) => this.onActiveSpeaker(id));
  /** My webcam (services/camera.ts). */
  readonly camera: CameraController;
  /** Gateway VOICE_MOVED seen, waiting for LiveKit RoomEvent.Moved (else: rejoin). */
  private moveTimer: number | null = null;
  /** The last /join result (Settings → Соединение → «Проверить» probes this LiveKit host). */
  private lastJoin: { url: string; token: string } | null = null;
  /** The /join request in flight (settled either way): a /voice/leave waits for it. */
  private joinReq: Promise<void> | null = null;
  /** The /voice/leave request in flight (never rejects): the next /join waits for it. */
  private leaveReq: Promise<void> | null = null;
  /** ICE servers LiveKit handed out at the last successful connect (TURN probe). */
  private iceServers: RTCIceServer[] = [];
  /** The seat of the last failed user join: a CSP report arriving after its teardown re-seats it as 'blocked'. */
  private failedSeat: { roomId: string; workspaceId: string; at: number } | null = null;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the controller reads the live room
    const self = this;
    this.camera = new CameraController({
      get room() {
        return self.room;
      },
      get roomId() {
        return self.roomId;
      },
    });
    this.audioSink = document.createElement('div');
    this.audioSink.id = 'remote-audio-sink';
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);
    document.addEventListener('visibilitychange', () => this.applyWatching());
    // My camera was the last video on the call view: back to the chat.
    useVoice.subscribe((s, p) => {
      if (s.camera === 'off' && p.camera !== 'off' && s.stage === 'expanded' && !s.watching && s.cameras.length === 0) setVoice({ stage: 'pip' });
    });
  }

  init(): void {
    platform.ptt.onEvent((ev) => this.onPtt(ev));
    // mediaDevices is missing on insecure origins (web over plain http).
    (navigator.mediaDevices as MediaDevices | undefined)?.addEventListener('devicechange', () => {
      this.snapshotDevices(true);
      void this.onDevicesChanged();
      // macOS moves the default output (charger, dock, headphones): re-assert our sink and the
      // playback state (deafen!) on every remote element once the switch has settled.
      void this.applyOutputDevice();
    });
    this.snapshotDevices(false);
    void this.applyOutputDevice(); // the chosen output for every remote element from the first one on
    // Our CSP refusing the LiveKit host (docs/09 P0 #1): retries cannot help — say so.
    document.addEventListener('securitypolicyviolation', (ev) => this.onCspViolation(ev));
    this.gate.configure({ thresholdDb: prefs().thresholdDb });
    usePrefs.subscribe((s, p) => this.onPrefs(s, p));
    void this.syncPttBinding();
  }

  // ------------------------------------------------------------ prefs

  private onPrefs(s: Prefs, p: Prefs): void {
    if (s.thresholdDb !== p.thresholdDb) {
      this.gate.configure({ thresholdDb: s.thresholdDb });
      this.applyDenoise();
    }
    if (s.micMode !== p.micMode || !sameBinding(s.pttBinding, p.pttBinding)) {
      // A pending release tail belongs to the old binding / mode: off now.
      if (this.ptt.pending) this.ptt.stop();
      void this.syncPttBinding();
      this.applyTransmit();
    }
    if (s.outputDeviceId !== p.outputDeviceId) void this.applyOutputDevice();
    // Another speaker or mic: the acoustic path changed, judge the echo afresh.
    if (s.outputDeviceId !== p.outputDeviceId || s.micDeviceId !== p.micDeviceId) this.resetEcho();
    // Without RNNoise the pipeline has a gain stage only in the speakerphone modes: rebuild when that flips.
    const gainFlips = s.echoMode !== p.echoMode && this.mic !== null && this.mic.duckable !== (this.mic.rnnoise || duckable(s.echoMode));
    if ((s.rnnoise !== p.rnnoise || s.micDeviceId !== p.micDeviceId || gainFlips) && this.mic) void this.restartMic();
    if (s.echoMode !== p.echoMode) this.applyDuck();
    if ((s.red !== p.red || s.personalBitrateKbps !== p.personalBitrateKbps) && this.micTrack && this.room) void this.republishMic();
    if (s.userVolumes !== p.userVolumes || s.mutedUsers !== p.mutedUsers || s.deafUsers !== p.deafUsers || s.outputVolume !== p.outputVolume) this.applyVolumes();
    if (s.hiddenVideo !== p.hiddenVideo || s.saveTraffic !== p.saveTraffic) this.applyCameras();
    if (s.cameraDeviceId !== p.cameraDeviceId) void this.camera.setDevice(s.cameraDeviceId);
  }

  private async syncPttBinding(): Promise<void> {
    const s = prefs();
    try {
      await platform.ptt.setBinding(s.micMode === 'ptt' ? s.pttBinding : null);
    } catch (e) {
      log.warn('ptt binding failed', e);
    }
  }

  // ------------------------------------------------------------ join / leave

  get currentRoomId(): string | null {
    return this.roomId;
  }

  /** User intent: connect to a voice room (switches rooms; cancels a pending rejoin). */
  async join(roomId: string, workspaceId: string): Promise<void> {
    // A suspended workspace has no calls (docs/09 #32): say so instead of a 403 toast.
    if (useWorkspaces.getState().byId[workspaceId]?.ws.suspension) {
      toast.info(t('suspended.voice'));
      return;
    }
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.failedSeat = null;
    setLink({ attempts: 0, lastError: null, blockedHost: null });
    // Optimistic join (docs/05): I am in the room's list from the click on, also while the old
    // call is still being torn down; connect() takes over with phase 'connecting'.
    if (!(this.roomId === roomId && this.room)) setVoice({ joining: { roomId, workspaceId } });
    await this.connect(roomId, workspaceId, false);
  }

  /**
   * «Повторить» on the reconnect notice: a blocked seat joins again; a running reconnect cycle
   * restarts now (the failed-attempt count goes on until a connect succeeds).
   */
  retry(): void {
    const { roomId, workspaceId, phase } = useVoice.getState();
    if (!roomId || !workspaceId) return;
    if (phase === 'blocked') {
      void this.join(roomId, workspaceId);
      return;
    }
    if (phase === 'reconnecting') void this.rejoin(roomId, workspaceId);
  }

  /** LiveKit endpoint of the last join and the ICE servers it gave (connection check). */
  linkInfo(): { url: string | null; token: string | null; iceServers: RTCIceServer[] } {
    return { url: this.lastJoin?.url ?? null, token: this.lastJoin?.token ?? null, iceServers: this.iceServers };
  }

  private onCspViolation(ev: SecurityPolicyViolationEvent): void {
    const host = cspBlockedHost(ev);
    if (!host) return;
    platform.app.log('error', `[csp] blocked ${ev.effectiveDirective || ev.violatedDirective}: ${ev.blockedURI}`);
    const rtcHost = hostOfUrl(this.lastJoin?.url);
    if (!rtcHost || rtcHost !== host) return;
    const v = useVoice.getState();
    const seat =
      v.roomId && v.workspaceId
        ? { roomId: v.roomId, workspaceId: v.workspaceId }
        : this.failedSeat && Date.now() - this.failedSeat.at < 10_000
          ? this.failedSeat
          : null;
    if (!seat) return;
    log.error('voice: LiveKit host blocked by the app CSP', host);
    // Stop the reconnect cycle: it would only fail the same way.
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.failedSeat = null;
    if (this.room || this.roomId) void this.teardown(false, true);
    setVoice({
      roomId: seat.roomId,
      workspaceId: seat.workspaceId,
      phase: 'blocked',
      link: { ...useVoice.getState().link, blockedHost: host, lastError: `CSP connect-src: ${ev.blockedURI}` },
    });
  }

  /**
   * `keepServerMuted`: the moderator mute to carry over the teardown (a rejoin or a move's /join
   * fallback); teardown resets it, and until the new grant arrives the UI would show «not muted».
   */
  private async connect(roomId: string, workspaceId: string, quiet: boolean, moved?: MoveCreds, keepServerMuted?: boolean): Promise<void> {
    if (this.roomId === roomId && this.room) return;
    // The intent token is taken *before* the teardown (which awaits a network disconnect):
    // a leave() or a newer join during that window bumps it, and this call bails out, so the
    // last click wins (review N1). The join sequence is taken after the teardown, because
    // teardown bumps it too (review H1).
    const intent = ++this.intentSeq;
    // A teardown still finishing (a leave or another switch) goes first: its tail resets the
    // voice store and would wipe this connect's state.
    while (this.teardownRun) {
      await this.teardownRun;
      if (intent !== this.intentSeq) return;
    }
    if (this.room) await this.teardown(false, quiet);
    if (intent !== this.intentSeq) return;
    const seq = ++this.joinSeq;
    this.roomId = roomId;
    // A new call (not a reconnect of this one) may warn about echo again.
    if (!quiet) this.echoToasted = false;
    const carried = moved?.serverMuted ?? keepServerMuted;
    setVoice({
      roomId,
      workspaceId,
      joining: null,
      // A reconnect cycle (quiet) keeps my original joinedAt: only a fresh join or a move to
      // another room restarts the invite row's 30 s window (docs/09 #10).
      ...(quiet ? {} : { joinedAt: Date.now() }),
      // A reconnect cycle keeps one stable «Переподключение…» through all its attempts.
      phase: quiet ? 'reconnecting' : 'connecting',
      error: null,
      streams: [],
      watching: null,
      speaking: {},
      myStream: null,
      cameras: [],
      activeSpeaker: null,
      focusedTile: null,
      videoPip: true,
      ...(carried !== undefined ? { serverMuted: carried } : {}),
    });
    try {
      // A move (ADR-0019) comes with a token for the target room: no /join round trip.
      const res = moved ? this.movedJoin(roomId, workspaceId, moved) : await this.requestJoin(roomId, seq);
      if (seq !== this.joinSeq || !res) return;
      // The server recorded this device as pending with default flags: tell it my mute /
      // deafen now, so the others' pending row is right before LiveKit connects.
      if ('pending' in res && res.pending) {
        const { muted, deafened } = useVoice.getState();
        if (muted || deafened) void api.voice.updateSelf({ muted, deafened }).catch((e: unknown) => log.warn('voice/self failed', e));
      }
      this.lastJoin = { url: res.url, token: res.token };
      setLink({ rtcHost: hostOfUrl(res.url) });
      this.audioBitrateKbps = res.media?.audioBitrateKbps || 32;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: false, // echo rule 1
        disconnectOnPageLeave: true,
        // LiveKit re-selects the output on `devicechange` unless it knows ours (RoomEvent.ActiveDeviceChanged below).
        ...(prefs().outputDeviceId ? { audioOutput: { deviceId: prefs().outputDeviceId ?? '' } } : {}),
      });
      this.room = room;
      // H.264 «Авто» = High on the wire (hardware on macOS): codec preferences set between
      // addTransceiver and the offer (lib/media/h264.ts, docs/02 «Кодек»). Lives as long as the Room.
      installH264ProfileHook(room.localParticipant, () => room.engine.pcManager?.publisher.getTransceivers());
      annot.attach(room);
      this.wire(room);
      const relayOnly = useSession.getState().appInfo?.forceRelay === true;
      await room.connect(res.url, res.token, {
        autoSubscribe: false,
        ...(relayOnly ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {}),
      });
      if (seq !== this.joinSeq) {
        if (this.room === room) this.room = null;
        await room.disconnect(false);
        return;
      }
      // Moved: SPEAK comes from the token's grant (it repeats the server's rights in the target).
      const perm = room.localParticipant.permissions;
      const canSpeak = moved ? (perm ? canSpeakFrom(perm) : true) : res.canSpeak;
      setVoice({ canSpeak, canStream: res.canStream, canVideo: res.canVideo, phase: 'connected' });
      setLink({ attempts: 0, lastError: null, blockedHost: null });
      // After the join LiveKit's rtcConfig carries the TURN servers of the join response.
      this.iceServers = (room.engine as { rtcConfig?: RTCConfiguration } | undefined)?.rtcConfig?.iceServers ?? [];
      // Subscribe to audio of everyone already here; video only when watched.
      for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.onPublished(pub);
      if (canSpeak) {
        await this.ensureMic();
        await this.publishMic();
      }
      this.startStats();
      this.pushSelfState();
      this.refreshStreams();
      this.refreshCameras();
      playSound('join');
      this.syncTray();
    } catch (err) {
      if (seq !== this.joinSeq) return;
      if (moved) {
        // The move's token did not get us in (expired, LiveKit hiccup): one ordinary /join into
        // the target (mute / deafen / PTT live in the store; the moderator mute is carried).
        // Only if that fails too: the usual error and out of voice (the server rolls the move
        // back after 15 s). Exactly one fallback per VOICE_MOVED: the /join path has no `moved`.
        log.warn('voice: connect with the move token failed, falling back to /join', err);
        await this.teardown(false);
        // A leave / join / newer move meanwhile bumped the intent token: it wins, no fallback.
        if (intent !== this.intentSeq) return;
        const fallback = this.connect(roomId, workspaceId, quiet, undefined, moved.serverMuted);
        // connect() took its intent token synchronously: keep a chained move recognisable.
        if (this.moveIntent?.seq === intent) this.moveIntent = { seq: this.intentSeq, to: roomId };
        await fallback;
        return;
      }
      log.error('voice join failed', err);
      const line = describeConnectError(err);
      setLink({ attempts: useVoice.getState().link.attempts + 1, lastError: line });
      // Rejoin attempts (quiet) only log: the reconnect notice already tells the user, and the
      // seat stays (the voice panel and its menus are not unmounted between attempts).
      // A plan limit (409 ROOM_FULL reason PLAN_LIMIT, ADR-0024): its own toast with «Связаться».
      const planHit = !quiet && reportPlanError(err, workspaceId);
      const h = quiet || planHit ? humanMediaError(err, 'voice') : reportMediaError(err, 'voice');
      if (!quiet) this.failedSeat = { roomId, workspaceId, at: Date.now() };
      await this.teardown(false, quiet);
      setVoice({ error: h.text });
    }
  }

  /**
   * What /join would have said, for a move with server-issued credentials: the target's media
   * settings from the room store; STREAM from the client-side permissions (UI only — the stream
   * slot is still checked by /stream/request).
   */
  private movedJoin(
    roomId: string,
    workspaceId: string,
    moved: MoveCreds,
  ): { url: string; token: string; canSpeak: boolean; canStream: boolean; canVideo: boolean; media: { audioBitrateKbps: number } } {
    const room = useRooms.getState().byId[roomId];
    const me = useSession.getState().me?.user?.id ?? '';
    const role = rolesOf(useWorkspaces.getState().byId[workspaceId], me);
    return {
      url: moved.url,
      token: moved.token,
      canSpeak: true,
      // The camera needs /camera/request in the target anyway (the server re-checks VIDEO + limit).
      ...voiceCaps(roomPerms(role, me, room), room),
      media: { audioBitrateKbps: room?.media?.audioBitrateKbps || this.audioBitrateKbps },
    };
  }

  /**
   * My roles or the room's overrides / media changed during a call (ROLE_*, my
   * WORKSPACE_MEMBER_UPDATE, ROOM_PERMISSIONS_UPDATE, ROOM_UPDATE): the stream / camera buttons
   * follow at once instead of keeping the /join answer until a rejoin. SPEAK follows LiveKit's
   * grant (ParticipantPermissionsChanged), which the server pushes on the same changes.
   */
  refreshRights(): void {
    const { roomId, workspaceId, phase, canStream, canVideo } = useVoice.getState();
    if (!roomId || !workspaceId || phase !== 'connected') return;
    const room = useRooms.getState().byId[roomId];
    const me = useSession.getState().me?.user?.id ?? '';
    const roles = rolesOf(useWorkspaces.getState().byId[workspaceId], me);
    // Unknown room / member (a READY is being applied): keep what /join said.
    if (!room || roles.length === 0) return;
    const next = voiceCaps(roomPerms(roles, me, room), room);
    if (next.canStream !== canStream || next.canVideo !== canVideo) setVoice(next);
  }

  /** Bumped by every user join/leave: a running rejoin loop stops when it changes. */
  private rejoinGen = 0;

  /** Bumped by every connect() and leave(): a connect still tearing down the old room bails out. */
  private intentSeq = 0;

  /**
   * Rejoin after an unexpected disconnect: 1 s, 2 s, 4 s … up to 5 attempts. The seat (room id,
   * phase 'reconnecting') stays in the store for the whole cycle: the voice panel keeps its
   * state and open menus instead of remounting on every attempt.
   */
  private async rejoin(seatRoom?: string, seatWs?: string): Promise<void> {
    const roomId = seatRoom ?? this.roomId;
    const wsId = seatWs ?? useVoice.getState().workspaceId;
    if (!roomId || !wsId) return;
    const gen = ++this.rejoinGen;
    const stream = useVoice.getState().myStream;
    // The moderator mute outlives the reconnect: the server grants no SPEAK again, and until
    // that grant arrives the UI must not show «not muted». Reset only by a grant or a leave.
    const serverMuted = useVoice.getState().serverMuted;
    const camera = useVoice.getState().camera === 'on';
    this.rejoinRoomId = roomId;
    try {
      await this.teardown(false, true);
      for (let attempt = 0; attempt < 5; attempt++) {
        if (gen !== this.rejoinGen) return; // the user left or switched meanwhile
        setVoice({ roomId, workspaceId: wsId, phase: 'reconnecting', serverMuted });
        // The backoff ends early when the gateway is back (the network is): checkSeat wakes it.
        await new Promise<void>((r) => {
          const timer = setTimeout(r, 1000 * 2 ** attempt);
          this.rejoinWake = () => {
            clearTimeout(timer);
            r();
          };
        });
        this.rejoinWake = null;
        if (gen !== this.rejoinGen) return;
        await this.connect(roomId, wsId, true, undefined, serverMuted);
        if (gen !== this.rejoinGen) return;
        if (this.room) {
          if (stream) toast.info(t('mediaErr.stream.restart'));
          // The camera comes back by itself (a new capture, no preview); start() explains a failure.
          if (camera) void this.camera.start();
          return;
        }
      }
      toast.error(t('mediaErr.voice.lost'));
      await this.teardown(false);
    } finally {
      if (this.rejoinGen === gen) this.rejoinRoomId = null;
    }
  }

  /** The room a running rejoin loop is trying to get back into (a move may redirect it). */
  private rejoinRoomId: string | null = null;
  /** Ends the rejoin loop's current backoff wait (set only while it waits). */
  private rejoinWake: (() => void) | null = null;

  // ------------------------------------------------------------ seat check (docs/09 #71)

  /**
   * Rooms the server may still hold this device in although it sits elsewhere or nowhere: a
   * superseded /join that reached the server late, a /voice/leave lost in the network.
   */
  private readonly strayRooms = new Set<string>();
  /** Rooms with a /voice/leave queued or in flight (sendLeave): not strays. */
  private readonly leavingRooms = new Set<string>();
  private seatRun: Promise<void> | null = null;
  private seatAgain = false;
  private selfCheckTimer: number | null = null;

  /**
   * Make the server's record of this device agree with the LiveKit connection (docs/05
   * «Восстановление голоса после разрыва»): after the gateway's READY / RESUMED, a superseded
   * /join landing late, or a VOICE_STATE_UPDATE that does not show me where I am. Single
   * flight; a request during a run runs it once more.
   */
  checkSeat(): void {
    if (this.seatRun) {
      this.seatAgain = true;
      return;
    }
    const run = (async (): Promise<void> => {
      do {
        this.seatAgain = false;
        await this.checkSeatOnce();
      } while (this.seatRerun());
    })()
      .catch((e: unknown) => log.warn('voice: seat check failed', e))
      .finally(() => {
        if (this.seatRun === run) this.seatRun = null;
      });
    this.seatRun = run;
  }

  /** Asked again while the check ran (read through a call: the flag changes across awaits). */
  private seatRerun(): boolean {
    return this.seatAgain;
  }

  private seatView(): SeatView {
    const v = useVoice.getState();
    const room = this.room;
    const st = room && this.roomId === v.roomId ? room.state : null;
    return {
      seatRoom: v.roomId,
      // A join / switch / leave / move in progress settles the server by itself.
      busy: v.joining !== null || v.phase === 'connecting' || this.teardownRun !== null || this.moveTimer !== null,
      livekit: st === ConnectionState.Connected ? 'connected' : st === ConnectionState.Reconnecting || st === ConnectionState.SignalReconnecting ? 'reconnecting' : 'none',
      rejoining: this.rejoinWake !== null,
      strays: [...this.strayRooms],
    };
  }

  private async checkSeatOnce(): Promise<void> {
    let action = seatAction(this.seatView());
    for (let i = 0; action.kind === 'wait'; i++) {
      if (i >= SEAT_BUSY_POLLS) return; // still busy: that join / leave settles the server itself
      await new Promise((r) => setTimeout(r, SEAT_BUSY_POLL_MS));
      action = seatAction(this.seatView());
    }
    switch (action.kind) {
      case 'none':
        return;
      case 'rejoin':
        log.info('voice: connection back, rejoining without the backoff');
        this.rejoinWake?.();
        return;
      case 'watch': {
        // LiveKit is resuming by itself: a moment for it, then a fresh token instead.
        const room = this.room;
        await new Promise((r) => setTimeout(r, SEAT_RECONNECT_GRACE_MS));
        if (room && this.room === room && room.state !== ConnectionState.Connected && !this.rejoinRoomId) {
          log.info('voice: LiveKit still reconnecting after the gateway is back, rejoining');
          void this.rejoin();
          return;
        }
        this.seatAgain = true; // reconnected: re-assert the seat
        return;
      }
      case 'leave':
        for (const roomId of action.strays) await this.leaveStray(roomId);
        return;
      case 'reassert':
        await this.reassertSeat(action.roomId, action.strays);
        return;
    }
  }

  private async leaveStray(roomId: string): Promise<void> {
    try {
      await api.voice.leave(roomId);
      this.strayRooms.delete(roomId);
    } catch (err) {
      log.warn('voice: stray /voice/leave failed', err);
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) this.strayRooms.delete(roomId);
    }
  }

  /**
   * In the room in LiveKit: /join it again — idempotent for a device the server has there, and
   * records it again if the server lost it (it is confirmed pending → connected against
   * LiveKit). Refused (no access, the room is gone or full): out of voice with a toast.
   */
  private async reassertSeat(roomId: string, strays: string[]): Promise<void> {
    for (const r of strays) await this.leaveStray(r);
    const room = this.room;
    const same = (): boolean => this.room === room && this.roomId === roomId;
    await this.settleSeatRequests();
    if (!same()) return;
    let res: Awaited<ReturnType<typeof api.voice.join>>;
    try {
      res = await this.sendJoin(roomId);
    } catch (err) {
      if (!same()) return;
      if (err instanceof ApiError && seatRefused(err.status)) {
        log.warn('voice: the server refuses the seat after a reconnect, leaving', err.code);
        toast.error(t('mediaErr.voice.desync'));
        await this.leave(false);
        return;
      }
      log.warn('voice: seat re-assert failed (retried on the next reconnect)', err);
      return;
    }
    if (!same() || !res.pending) return;
    // The server had lost this device: recorded again with default flags — my mute / deafen.
    log.info('voice: the server had lost this device, seat restored');
    const { muted, deafened } = useVoice.getState();
    if (muted || deafened) void api.voice.updateSelf({ muted, deafened }).catch((e: unknown) => log.warn('voice/self failed', e));
  }

  /**
   * My VOICE_STATE_UPDATE does not show me in the room I am connected to: after a short grace
   * (a move / switch in flight settles), the seat check.
   */
  private scheduleSelfCheck(): void {
    if (this.selfCheckTimer !== null) return;
    this.selfCheckTimer = window.setTimeout(() => {
      this.selfCheckTimer = null;
      const v = useVoice.getState();
      const me = useSession.getState().me?.user?.id ?? '';
      const shown = v.workspaceId ? useWorkspaces.getState().byId[v.workspaceId]?.voice[me]?.roomId : undefined;
      if (v.roomId && shown !== v.roomId && this.room?.state === ConnectionState.Connected) this.checkSeat();
    }, SEAT_SELF_GRACE_MS);
  }

  /** User intent: leave voice (also stops a pending rejoin). */
  async leave(sound = true): Promise<void> {
    this.rejoinGen++;
    // A stopped rejoin loop only clears this when it is still the current one: a user intent
    // must forget it at once, or a later VOICE_MOVED would pull the user back into voice.
    this.rejoinRoomId = null;
    this.moveIntent = null;
    this.intentSeq++;
    // The room the server may hold this device in: the seat (also while connecting, when
    // /join already recorded it as pending), or the old call while a switch tears it down.
    const v = useVoice.getState();
    const seat = v.roomId ?? this.roomId ?? v.joining?.roomId ?? null;
    setVoice({ joining: null });
    await this.teardown(sound);
    // After room.disconnect(): tell the server at once (a pending /join would otherwise stay
    // for everyone up to 15 s; for a connected device it is a safety net). Not awaited.
    if (seat) this.sendLeave(seat);
  }

  /**
   * /join, after a /voice/leave still in flight (an overtaking leave would undo this join on
   * the server). Null when a newer intent took over meanwhile.
   */
  private async requestJoin(roomId: string, seq: number): Promise<Awaited<ReturnType<typeof api.voice.join>> | null> {
    await this.settleSeatRequests();
    if (seq !== this.joinSeq) return null;
    const req = this.sendJoin(roomId);
    // Superseded while in flight (a newer join or a leave took over, docs/09 #71): the server
    // may have recorded the device in `roomId` *after* the newer request — the seat check puts
    // it back where this device really is.
    void req.then(
      () => {
        if (seq === this.joinSeq || useVoice.getState().roomId === roomId || this.leavingRooms.has(roomId)) return;
        this.strayRooms.add(roomId);
        this.checkSeat();
      },
      () => undefined,
    );
    return req;
  }

  /**
   * Seat requests reach the server in order: a /join waits (bounded) for a /voice/leave and an
   * earlier /join still in flight — an overtaken request would undo the newer one there.
   */
  private async settleSeatRequests(): Promise<void> {
    const bounded = (p: Promise<void>): Promise<unknown> => Promise.race([p, new Promise((r) => setTimeout(r, LEAVE_WAIT_MS))]);
    if (this.leaveReq) await bounded(this.leaveReq);
    if (this.joinReq) await bounded(this.joinReq);
  }

  /** POST /join, remembered as the /join in flight. */
  private sendJoin(roomId: string): ReturnType<typeof api.voice.join> {
    const req = api.voice.join(roomId);
    const settled = req.then(
      () => undefined,
      () => undefined,
    );
    this.joinReq = settled;
    void settled.then(() => {
      if (this.joinReq === settled) this.joinReq = null;
    });
    return req;
  }

  /** POST /voice/leave in the background, after a /join still in flight (never rejects). */
  private sendLeave(roomId: string): void {
    const joining = this.joinReq;
    this.leavingRooms.add(roomId);
    const run = (async (): Promise<void> => {
      try {
        if (joining) await joining;
        await api.voice.leave(roomId);
        this.strayRooms.delete(roomId);
      } catch (err) {
        log.warn('voice/leave failed', err);
        // Lost in the network: the others would keep seeing me there. Retried by the seat
        // check after the gateway reconnects (docs/09 #71).
        if (!(err instanceof ApiError && err.status >= 400 && err.status < 500)) this.strayRooms.add(roomId);
      }
    })();
    this.leaveReq = run;
    void run.then(() => {
      this.leavingRooms.delete(roomId);
      if (this.leaveReq === run) this.leaveReq = null;
    });
  }

  /** The teardown in progress (connect() waits for it). */
  private teardownRun: Promise<void> | null = null;

  /** `keepSeat`: a reconnect — the store keeps room, workspace, phase and the moderator mute. */
  private teardown(sound: boolean, keepSeat = false): Promise<void> {
    const run = this.doTeardown(sound, keepSeat);
    this.teardownRun = run;
    const done = (): void => {
      if (this.teardownRun === run) this.teardownRun = null;
    };
    run.then(done, done);
    return run;
  }

  private async doTeardown(sound: boolean, keepSeat: boolean): Promise<void> {
    this.joinSeq++;
    this.endPttTail();
    this.resetSpeaking();
    this.active.reset();
    this.clearMoveTimer();
    this.stopStats();
    this.resetEcho();
    await this.stopStream();
    const room = this.room;
    const micTrack = this.micTrack;
    this.room = null;
    this.roomId = null;
    this.micTrack = null;
    // disconnect(false): unpublish without stopping. disconnect(true) would stop the pipeline's
    // publish track, and a running mic test keeps that pipeline for the next call → a dead
    // mic there (review M1). The pipeline is stopped below when nobody needs it.
    if (room) await room.disconnect(false).catch(() => undefined);
    this.camera.onLeave();
    if (!this.micTesting) {
      micTrack?.stop();
      this.stopMicPipeline();
    }
    for (const el of this.audioOut.clear()) el.remove();
    this.viewers.clear();
    this.wanted.clear();
    this.announced = null;
    annot.detach();
    setVoice({
      ...(keepSeat ? {} : { roomId: null, workspaceId: null, joinedAt: null, phase: 'idle' as const, serverMuted: false, recording: null, link: { ...useVoice.getState().link, attempts: 0, blockedHost: null } }),
      transmitting: false,
      speaking: {},
      streams: [],
      watching: null,
      stage: 'pip',
      streamQuality: {},
      myStream: null,
      canVideo: false,
      cameras: [],
      activeSpeaker: null,
      focusedTile: null,
      quality: 'unknown',
      rttMs: null,
      lossPct: null,
      stats: null,
    });
    if (sound && room) playSound('leave');
    this.syncTray();
  }

  private wire(room: Room): void {
    room
      .on(RoomEvent.ConnectionStateChanged, (st) => {
        if (this.room !== room) return;
        const was = useVoice.getState().phase;
        if (st === ConnectionState.Reconnecting || st === ConnectionState.SignalReconnecting) {
          if (was === 'connected') playSound('disconnect');
          setVoice({ phase: 'reconnecting' });
        } else if (st === ConnectionState.Connected) {
          if (was === 'reconnecting') playSound('reconnect');
          setVoice({ phase: 'connected' });
          setLink({ attempts: 0, blockedHost: null });
        }
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.room !== room) return;
        log.info('voice disconnected, reason', reason ?? 'none');
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
          const ws = useVoice.getState().workspaceId;
          toast.info(ws && useWorkspaces.getState().byId[ws]?.ws.suspension ? t('suspended.kicked') : t('mediaErr.voice.kicked'));
        }
        else if (reason === DisconnectReason.DUPLICATE_IDENTITY) toast.info(t('mediaErr.voice.duplicate'));
        else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) toast.info(t('mediaErr.voice.closed'));
        else if (reason !== DisconnectReason.CLIENT_INITIATED) {
          setLink({ lastError: describeDisconnect(reason === undefined ? undefined : DisconnectReason[reason]) });
          // Network-type loss that LiveKit could not resume itself (sleep, long freeze,
          // server restart): rejoin with a fresh token instead of dropping the user.
          void this.rejoin();
          return;
        }
        void this.leave();
      })
      .on(RoomEvent.TrackPublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) playSound('streamStart');
        this.onPublished(pub);
        this.refreshStreams();
        this.refreshCameras();
      })
      .on(RoomEvent.TrackUnpublished, () => {
        this.refreshStreams();
        this.refreshCameras();
      })
      // Full reconnect (a new LiveKit session): bring the camera back (services/camera.ts restore).
      .on(RoomEvent.Reconnected, () => {
        if (this.room === room) void this.camera.restore();
      })
      // LiveKit switched the remote audio output itself (a device appeared / went away): its
      // setSinkId hit our elements — put our sink and the playback state (deafen) back.
      .on(RoomEvent.ActiveDeviceChanged, (kind) => {
        if (this.room === room && kind === 'audiooutput') void this.applyOutputDevice();
      })
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (p !== room.localParticipant && pub.source === Track.Source.Camera) this.refreshCameras();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        // Unpublished by the server (camera grant withdrawn) rather than by us.
        if (pub.source === Track.Source.Camera && pub.track === this.camera.localTrack) this.camera.onGrantLost();
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        if (track.kind === Track.Kind.Audio) this.attachAudio(track, p, pub.source === Track.Source.ScreenShareAudio);
        if (pub.source === Track.Source.Microphone) this.startLevelSpeaking();
        if (pub.source === Track.Source.ScreenShare) {
          this.applyQuality(pub);
          this.syncAnnounce();
          setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
        }
        if (pub.source === Track.Source.Camera) {
          this.applyCameras();
          setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => {
        if (track.kind === Track.Kind.Audio) this.detachAudio(track);
        if (pub.source === Track.Source.ScreenShare) this.syncAnnounce();
        if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.Camera) setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
      })
      .on(RoomEvent.ParticipantConnected, () => playSound('join'))
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        const gone = userIdOf(p.identity);
        if (![...room.remoteParticipants.values()].some((o) => userIdOf(o.identity) === gone)) this.active.drop(gone);
        playSound('leave');
        for (const set of this.viewers.values()) set.delete(p.identity);
        annot.participantLeft(p.identity);
        this.publishViewers();
        this.refreshStreams();
        this.refreshCameras();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        // Remote only: my own ring follows the local VAD / PTT (setSelfSpeaking), not the server.
        this.remoteSpeakers = speakers.map((s) => s.identity);
        this.syncSpeaking();
      })
      .on(RoomEvent.Moved, () => {
        // A moderator moved us (LiveKit MoveParticipant): same connection, new room.
        if (this.room !== room) return;
        log.info('voice: moved by the server');
        this.clearMoveTimer();
        this.resetSpeaking();
        this.setSelfSpeaking(useVoice.getState().transmitting); // the mic stays on air across the move
        this.startLevelSpeaking(); // stops itself on the first tick if no mic track is left
        this.active.reset();
        for (const set of this.viewers.values()) set.clear();
        for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.onPublished(pub);
        this.refreshStreams();
        this.refreshCameras();
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        // A camera muted by the server (over the limit) is off for everyone.
        if (p !== room.localParticipant && pub.source === Track.Source.Camera) this.refreshCameras();
        // A moderator mute arrives as a mute of our mic that we did not initiate.
        if (p === room.localParticipant && pub.source === Track.Source.Microphone && !this.selfMuting && !useVoice.getState().muted) {
          setVoice({ muted: true, serverMuted: true });
          toast.info(t('mediaErr.voice.modMuted'));
          this.pushSelfState();
          this.syncTray();
        }
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p !== room.localParticipant || this.room !== room) return;
        const perm = p.permissions;
        if (perm) this.onSpeakPermission(canSpeakFrom(perm));
        if (useVoice.getState().camera === 'on' && cameraGrantMissing(perm)) this.camera.onGrantLost();
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (!participant || this.room !== room) return;
        if (topic === WATCH_TOPIC) this.onWatchMessage(payload, participant);
        else if (topic === ANNOT_TOPIC) annot.onData(payload, participant);
      })
      // Device changes are watched globally (navigator devicechange, init) — mic tests too.
      .on(RoomEvent.MediaDevicesChanged, () => undefined);
  }

  /**
   * SPEAK granted or revoked mid-call (review M4). Granted: capture + publish the mic (LiveKit
   * may have unpublished — and stopped — it on revoke). Revoked: explicit mute via applyTransmit.
   */
  private onSpeakPermission(canSpeak: boolean): void {
    const was = useVoice.getState().canSpeak;
    setVoice({ canSpeak });
    const room = this.room;
    if (canSpeak && !was && room) {
      void this.ensureMic().then(async () => {
        if (this.room !== room || !useVoice.getState().canSpeak) return;
        if (!room.localParticipant.getTrackPublication(Track.Source.Microphone)) await this.publishMic();
        else this.applyTransmit();
      }).catch((e: unknown) => log.warn('mic publish after SPEAK grant failed', e));
      return;
    }
    this.applyTransmit();
  }

  /**
   * Subscription policy (docs/02, «Подписки»): all mics; a stream's video + audio only when
   * watched. While the stage is expanded, the other streams' *video* is subscribed too, for the
   * preview strip — its 160×90 tiles make adaptive stream pick the low simulcast layer.
   */
  private onPublished(pub: RemoteTrackPublication): void {
    if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
    else if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) this.applyWatching();
    else if (pub.source === Track.Source.Camera) this.applyCameras();
  }

  private subscribe(pub: RemoteTrackPublication, on: boolean): void {
    const sid = pub.trackSid;
    if (this.wanted.get(sid) === on) return;
    this.wanted.set(sid, on);
    pub.setSubscribed(on);
  }

  private refreshStreams(): void {
    const room = this.room;
    if (!room) return;
    const streams: RemoteStream[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.trackSid) {
        const hasAudio = p.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined;
        streams.push({ trackSid: pub.trackSid, identity: p.identity, userId: userIdOf(p.identity), hasAudio });
      }
    }
    // My own stream, like the others' (docs/09 #18a): shown from the local track, first in the list.
    const mine = this.screen?.video.sid;
    if (mine) {
      const me = room.localParticipant.identity;
      streams.unshift({ trackSid: mine, identity: me, userId: userIdOf(me), hasAudio: false, local: true });
    }
    const st = useVoice.getState();
    let watching = st.watching;
    if (watching && !streams.some((s) => s.trackSid === watching)) watching = null;
    // A new stream appears: show it in the PiP tile unless the user already watches another one.
    const fresh = streams.find((s) => !st.streams.some((o) => o.trackSid === s.trackSid));
    if (!watching && fresh) watching = fresh.trackSid;
    // Starting to watch (nothing watched before): the room's remembered layout, else expanded when
    // the chat is (nearly) empty — a lone PiP over an empty room looks lost (docs/09 #56). The
    // watched stream ended: back to the chat, unless cameras keep the video stage busy.
    const stage = !watching ? (st.stage !== 'pip' && this.anyCamera() ? 'expanded' : 'pip') : st.watching ? st.stage : defaultStage(st.roomId);
    setVoice({ streams, ...(watching !== st.watching ? { watching, stage } : {}) });
    annot.syncStreams(streams);
    this.applyWatching();
  }

  /** Watched stream: video + audio; expanded stage: the others' video for previews; rest off. */
  private applyWatching(): void {
    const room = this.room;
    if (!room) return;
    const { watching, stage } = useVoice.getState();
    const previews = watching !== null && stage === 'expanded';
    for (const p of room.remoteParticipants.values()) {
      const video = p.getTrackPublication(Track.Source.ScreenShare);
      const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      const on = !!video && video.trackSid === watching;
      if (video) this.subscribe(video, on || previews);
      if (audio) this.subscribe(audio, on);
      // Adaptive stream pauses video while the main window is hidden (docs/02, «Перекрытое окно»);
      // a pop-out lives in another window, so the popped-out stream is forced on (review M7).
      // The rest follows the main window's visibility, as adaptive stream would do itself.
      if (video && (on || previews)) video.setEnabled((on && stage === 'popout') || document.visibilityState === 'visible');
    }
    this.syncAnnounce();
  }

  watch(trackSid: string | null): void {
    setVoice({ watching: trackSid, ...(trackSid ? {} : { stage: 'pip' }) });
    this.applyWatching();
  }

  /** PiP ↔ expanded ↔ pop-out (the preview strip exists only while expanded). */
  setStage(stage: 'pip' | 'expanded' | 'popout'): void {
    const roomId = useVoice.getState().roomId;
    // The user's choice is remembered per room (the pop-out is a transient window, not a layout).
    if (roomId && stage !== 'popout') usePrefs.getState().setPrefs({ streamStage: { ...usePrefs.getState().streamStage, [roomId]: stage } });
    setVoice({ stage });
    this.applyWatching();
  }

  /** Viewer's layer cap; 'auto' leaves the choice to adaptive stream (element size + bandwidth). */
  setStreamQuality(trackSid: string, q: StreamQuality): void {
    setVoice({ streamQuality: { ...useVoice.getState().streamQuality, [trackSid]: q } });
    const pub = this.remotePub(trackSid);
    if (pub) this.applyQuality(pub);
  }

  private applyQuality(pub: RemoteTrackPublication): void {
    const q = useVoice.getState().streamQuality[pub.trackSid] ?? 'auto';
    // HIGH = no cap: adaptive stream still picks by element size (docs/02, «Эффективность доставки»).
    pub.setVideoQuality(q === 'auto' ? VideoQuality.HIGH : LK_QUALITY[q]);
  }

  /** Published simulcast layers of a stream, largest first (empty = unknown / single layer). */
  streamLayers(trackSid: string): StreamLayer[] {
    const info = this.remotePub(trackSid)?.trackInfo;
    // Protocol VideoQuality: 0 LOW, 1 MEDIUM, 2 HIGH (same numbering as livekit-client's enum).
    const names: ReadonlyArray<StreamLayer['quality']> = ['low', 'medium', 'high']; // 3 = OFF
    const out: StreamLayer[] = [];
    for (const l of info?.codecs.flatMap((c) => c.layers) ?? []) {
      const quality = names[l.quality];
      if (quality && l.width > 0 && l.height > 0 && !out.some((o) => o.quality === quality)) out.push({ quality, width: l.width, height: l.height });
    }
    return out.sort((a, b) => b.height - a.height);
  }

  /** Volume of a stream's own audio (system sound), via its <audio> element — no WebAudio. */
  setStreamVolume(userId: string, volume: number): void {
    setVoice({ streamVolume: { ...useVoice.getState().streamVolume, [userId]: Math.max(0, Math.min(1, volume)) } });
    this.applyVolumes();
  }

  private remotePub(trackSid: string): RemoteTrackPublication | undefined {
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      const pub = p.getTrackPublicationBySid(trackSid);
      if (pub) return pub;
    }
    return undefined;
  }

  /** The video of a stream in my room: my own local track (docs/09 #18a, no subscription) or a remote one. */
  streamVideo(trackSid: string): RemoteVideoTrack | ActiveScreenShare['video'] | null {
    const mine = this.screen?.video;
    if (mine && mine.sid === trackSid) return mine;
    return this.remoteVideo(trackSid);
  }

  remoteVideo(trackSid: string): RemoteVideoTrack | null {
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      const t = p.getTrackPublicationBySid(trackSid)?.track;
      if (t && t.kind === Track.Kind.Video) return t as RemoteVideoTrack;
    }
    return null;
  }

  // ------------------------------------------------------------ cameras

  /** Speaking rings now; the active speaker for video only after 2 s of speech (lib/activeSpeaker.ts). */
  private syncSpeaking(): void {
    const local = this.room?.localParticipant.identity ?? null;
    const me = this.myId() || null;
    // PTT: my ring is the gate itself (the release tail already applied) — off at once, without
    // the speaking hold. VAD keeps the hold: the gate flaps between words.
    const instantOff = me && prefs().micMode === 'ptt' && !this.selfSpeaking ? new Set([me]) : undefined;
    const remote = [...this.remoteSpeakers, ...this.levelSpeakers.identities()];
    this.speakers.update(speakingUserIds(remote, local, { userId: me, on: this.selfSpeaking && this.room !== null }), instantOff);
  }

  private startLevelSpeaking(): void {
    this.levelSpeakOn = true;
  }

  private stopLevelSpeaking(): void {
    this.levelSpeakOn = false;
  }

  /**
   * Every 100 ms (every 2nd echo tick, `sampleLevels`): the RFC 6464 level of each remote mic track (receiver synchronization sources —
   * no WebAudio, echo rule 1). No track with the API (none subscribed, or Firefox/Safari web) →
   * the sampler stops and the ring follows the server alone; the next mic subscription restarts it.
   */
  private sampleLevelSpeaking(): void {
    const room = this.room;
    const samples: LevelSample[] = [];
    const mono = performance.now();
    if (room) {
      const epoch = performance.timeOrigin + mono;
      for (const rp of room.remoteParticipants.values()) {
        const track = rp.getTrackPublication(Track.Source.Microphone)?.track;
        if (!track?.sid) continue;
        const level = readLevel(track.receiver, epoch, mono);
        if (level !== undefined) samples.push({ key: track.sid, identity: rp.identity, level });
      }
    }
    if (samples.length === 0) this.stopLevelSpeaking();
    if (this.levelSpeakers.push(samples, mono)) this.syncSpeaking();
  }

  /** My ring: the mic is actually on air (VAD gate open / PTT held, not muted). */
  private setSelfSpeaking(on: boolean): void {
    if (on === this.selfSpeaking) return;
    this.selfSpeaking = on;
    this.syncSpeaking();
  }

  private resetSpeaking(): void {
    this.remoteSpeakers = [];
    this.stopLevelSpeaking();
    this.levelSpeakers.reset();
    this.selfSpeaking = false;
    this.speakers.reset();
  }

  private onSpeaking(speaking: Record<string, boolean>): void {
    setVoice({ speaking });
    this.active.update(speaking);
  }

  /** The held active speaker changed: the large tile / PiP follow; «Экономить трафик» resubscribes. */
  private onActiveSpeaker(activeSpeaker: string | null): void {
    setVoice({ activeSpeaker });
    this.applyCameras();
  }

  private anyCamera(): boolean {
    return useVoice.getState().cameras.length > 0 || useVoice.getState().camera === 'on';
  }

  /** Remote webcams of the room (a camera muted by the server counts as off). */
  private refreshCameras(): void {
    const room = this.room;
    if (!room) return;
    const cameras: RemoteCamera[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.Camera);
      const userId = userIdOf(p.identity);
      // My own camera from another device (web + desktop) is not a tile here (review L9).
      if (userId === this.myId()) continue;
      if (pub?.trackSid && !pub.isMuted && !cameras.some((c) => c.userId === userId)) cameras.push({ trackSid: pub.trackSid, identity: p.identity, userId });
    }
    const st = useVoice.getState();
    const same = cameras.length === st.cameras.length && cameras.every((c, i) => c.trackSid === st.cameras[i]?.trackSid);
    const focusGone = st.focusedTile !== null && !this.inRoom(st.focusedTile);
    if (!same || focusGone) setVoice({ ...(same ? {} : { cameras }), ...(focusGone ? { focusedTile: null } : {}) });
    // Last camera gone and no stream on the stage: back to the chat.
    if (!this.anyCamera() && st.stage === 'expanded' && !st.watching) setVoice({ stage: 'pip' });
    this.applyCameras();
  }

  private inRoom(userId: string): boolean {
    if (userId === useSession.getState().me?.user?.id) return true;
    for (const p of this.room?.remoteParticipants.values() ?? []) if (userIdOf(p.identity) === userId) return true;
    return false;
  }

  private myId(): string {
    return useSession.getState().me?.user?.id ?? '';
  }

  /**
   * The camera shown large / in the PiP: the clicked tile, else the active speaker's, else the
   * first remote one. Hidden cameras («Не показывать видео») never qualify, so the PiP, the grid
   * and the «Экономить трафик» subscription agree (review M1).
   */
  primaryCamera(): string | null {
    const st = useVoice.getState();
    const hidden = prefs().hiddenVideo;
    const ids = st.cameras.map((c) => c.userId).filter((id) => !hidden[id]);
    if (st.focusedTile && ids.includes(st.focusedTile)) return st.focusedTile;
    return pipCamera(ids, this.myId(), st.activeSpeaker);
  }

  /**
   * Camera subscriptions (docs/02 «Камера»): everyone's camera except «Не показывать видео»; with
   * «Экономить трафик» only the primary camera, capped at 360p. Adaptive stream matches the layer
   * to the tile size and pauses cameras that are not on screen.
   */
  private applyCameras(): void {
    const room = this.room;
    if (!room) return;
    const p = prefs();
    const wanted = cameraWanted(useVoice.getState().cameras.map((c) => c.userId), { hidden: p.hiddenVideo, saveTraffic: p.saveTraffic, primary: this.primaryCamera(), me: this.myId() });
    for (const rp of room.remoteParticipants.values()) {
      const pub = rp.getTrackPublication(Track.Source.Camera);
      if (!pub) continue;
      const on = wanted.has(userIdOf(rp.identity)) && !pub.isMuted;
      this.subscribe(pub, on);
      if (on) pub.setVideoQuality(p.saveTraffic ? VideoQuality.MEDIUM : VideoQuality.HIGH);
    }
  }

  /** Remote camera track of a user in my room (subscribed), for a tile. */
  cameraTrack(userId: string): RemoteVideoTrack | null {
    const sid = useVoice.getState().cameras.find((c) => c.userId === userId)?.trackSid;
    return sid ? this.remoteVideo(sid) : null;
  }

  /** Click on a tile: show it large (again: back to the grid). Opens the video stage. */
  focusTile(userId: string | null): void {
    const st = useVoice.getState();
    const focusedTile = userId !== null && st.focusedTile === userId ? null : userId;
    setVoice({ focusedTile, watching: null, stage: 'expanded' });
    this.applyWatching();
    this.applyCameras();
  }

  /** Opens the camera grid (the stream, if one is watched, stays the main picture). */
  showVideo(): void {
    setVoice({ stage: 'expanded', videoPip: true });
    this.applyWatching();
  }

  /** Moderator: turn a member's camera off (MUTE_MEMBERS; the server sends VOICE_CAMERA_STOP). */
  async stopMemberCamera(roomId: string, userId: string): Promise<void> {
    await api.voice.stopMemberCamera(roomId, userId);
  }

  // ------------------------------------------------------------ audio out

  private attachAudio(track: RemoteTrack, p: Participant, stream: boolean): void {
    const sid = track.sid;
    if (!sid || this.audioOut.has(sid)) return;
    const el = track.attach(); // plain <audio>, WebRTC renders it (AEC reference)
    this.audioSink.appendChild(el);
    // Deafen / volumes / sink applied here, before the first sample plays (lib/media/remoteAudioOut).
    this.audioOut.add(sid, el, userIdOf(p.identity), stream);
  }

  private detachAudio(track: RemoteTrack): void {
    if (track.sid) this.audioOut.remove(track.sid);
    for (const el of track.detach()) el.remove();
  }

  private applyVolumes(): void {
    this.audioOut.applyAll();
  }

  /** Echo rule 2: switch output with setSinkId on the same <audio> elements (and re-apply deafen). */
  private async applyOutputDevice(): Promise<void> {
    await this.audioOut.setSink(prefs().outputDeviceId ?? '');
  }

  /** Mute someone for me only (CHAT-SHELL, member menu); persisted per device like volumes. */
  setUserMuted(userId: string, muted: boolean): void {
    usePrefs.getState().setPrefs({ mutedUsers: withUserMuted(prefs().mutedUsers, userId, muted) });
  }

  /** «Не слышать» for me only: their voice and stream audio muted (persisted per device). */
  setUserDeaf(userId: string, deaf: boolean): void {
    usePrefs.getState().setPrefs({ deafUsers: withUserMuted(prefs().deafUsers, userId, deaf) });
  }

  setUserVolume(userId: string, volume: number): void {
    usePrefs.getState().setPrefs({ userVolumes: withUserVolume(prefs().userVolumes, userId, volume) });
  }

  // ------------------------------------------------------------ mic

  /** Mic test in settings (works outside a call too). */
  async startMicTest(): Promise<void> {
    this.micTesting = true;
    await this.ensureMic();
    this.applyDenoise();
  }

  stopMicTest(): void {
    this.micTesting = false;
    if (!this.room) this.stopMicPipeline();
    this.applyDenoise();
  }

  private meters = 0;

  /** A live mic meter is on screen (Settings → Голос): keep the level denoised and at full rate. */
  meterVisible(on: boolean): void {
    this.meters = Math.max(0, this.meters + (on ? 1 : -1));
    // The store carries the level only while a meter shows it (onMicReport): start from now.
    if (on) setVoice({ levelDb: this.lastMicDb, gateOpen: this.gate.open });
    this.applyDenoise();
  }

  /** A mic meter is on screen, or the mic test runs (its VAD readout). */
  private meterShown(): boolean {
    return this.meters > 0 || this.micTesting;
  }

  /**
   * RNNoise on demand (lib/media/denoiseSleep.ts, docs/14-energy.md): always on while the mic is on
   * air or a meter is shown; in VAD mode with the gate closed it sleeps after 2 s of quiet; PTT
   * released / muted — off. The capture itself never stops (AEC3 keeps converging).
   */
  private applyDenoise(d = this.decision()): void {
    const mic = this.mic;
    if (!mic) return;
    const p = prefs();
    mic.setDenoise(denoiseMode({ onAir: d.audioEnabled, meter: this.meterShown(), micMode: p.micMode, muted: d.livekitMuted }), wakeDbFor(p.thresholdDb));
  }

  /** Pipeline builds / swaps run one at a time: concurrent builds leaked a capture (review M2). */
  private micOps: Promise<void> = Promise.resolve();
  /** Capturing the default device because the chosen one is gone (review M3). */
  private micFallback = false;
  /** The capture ended because the device went away: the device-switch toast tells the user. */
  private micLost = false;
  /** Last audio device list (docs/09 #49): diffed on `devicechange` to tell OS switches apart. */
  private devices: AudioDevice[] | null = null;
  private devicesOps: Promise<void> = Promise.resolve();

  /**
   * Re-reads the audio device list; with `announce`, toasts what the OS switched in a call
   * («Микрофон: AirPods»). Snapshots run in order, each diffed against the one before.
   */
  private snapshotDevices(announce: boolean, onlyUnlabelled = false): void {
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) return;
    this.devicesOps = this.devicesOps.then(async () => {
      // Label refresh only: a full re-read here could swallow a switch the pending
      // `devicechange` is about to announce.
      if (onlyUnlabelled && this.devices?.every((d) => d.label)) return;
      let next: AudioDevice[];
      try {
        next = audioDevices(await md.enumerateDevices());
      } catch {
        return;
      }
      const prev = this.devices;
      this.devices = next;
      if (!announce || !prev || !this.roomId) return;
      const p = prefs();
      for (const sw of deviceSwitches(prev, next, { micDeviceId: p.micDeviceId, outputDeviceId: p.outputDeviceId })) announceDeviceSwitch(sw);
    });
  }

  private queueMic(op: () => Promise<void>): Promise<void> {
    const run = this.micOps.then(op);
    this.micOps = run.catch(() => undefined);
    return run;
  }

  /** Someone needs the capture: a call or the mic test. */
  private micWanted(): boolean {
    return this.micTesting || this.room !== null;
  }

  private ensureMic(): Promise<void> {
    return this.queueMic(async () => {
      // A pipeline whose publish track ended (LiveKit stopped it on a server unpublish) is rebuilt.
      if (this.mic && this.mic.track.readyState !== 'ended') return;
      if (this.mic) this.stopMicPipeline();
      if (!this.micWanted()) return;
      try {
        const next = await this.buildMic();
        if (!this.micWanted() || this.mic) {
          next.stop(); // the call / test ended while capture was starting
          return;
        }
        this.mic = next;
        this.applyDenoise();
      } catch (err) {
        log.error('mic start failed', err);
        const h = reportMediaError(err, 'mic');
        setVoice({ micError: h.text, micErrorAction: h.action });
      }
    });
  }

  private async buildMic(): Promise<MicPipeline> {
    const p = prefs();
    let built: MicPipeline | null = null;
    const opts = {
      rnnoise: p.rnnoise,
      duckable: duckable(p.echoMode),
      onReport: (r: MicReport) => this.onMicReport(r),
      // Capture ended by the OS (device unplugged): rebuild, falling back to the default device.
      onEnded: () => {
        if (built !== null && built === this.mic) this.onMicLost();
      },
    };
    try {
      built = await MicPipeline.start({ ...opts, deviceId: p.micDeviceId });
      this.micFallback = false;
    } catch (err) {
      if (!p.micDeviceId || !isDeviceGone(err)) throw err;
      log.warn('chosen mic unavailable, using the default device', err);
      built = await MicPipeline.start({ ...opts, deviceId: null });
      // Unplugged during a call: «Микрофон: <default device>» (docs/09 #49; the `devicechange`
      // diff raises the same toast, deduplicated); otherwise the generic notice.
      const label = deviceName(built.deviceLabel);
      if (this.micLost && this.roomId && label) announceDeviceSwitch({ kind: 'input', label });
      else if (!this.micFallback) toast.info(t('core.mic.fallback'));
      this.micFallback = true;
    }
    this.micLost = false;
    // Capture permission reveals device labels: the list the next change is diffed against needs them.
    this.snapshotDevices(false, true);
    this.gate.reset();
    setVoice({ micError: null, micErrorAction: null });
    return built;
  }

  private onMicLost(): void {
    log.warn('mic capture ended (device lost?), restarting');
    this.micLost = true;
    void this.restartMic();
  }

  /** The chosen mic came back while we used the default one → switch back to it. */
  private async onDevicesChanged(): Promise<void> {
    const want = prefs().micDeviceId;
    if (!this.mic || !this.micFallback || !want) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'audioinput' && d.deviceId === want)) return;
    } catch {
      return;
    }
    await this.restartMic();
    // In a call the device-switch toast («Микрофон: <chosen>») announces it.
    if (!this.usingFallback() && !this.roomId) toast.info(t('core.mic.back'));
  }

  private usingFallback(): boolean {
    return this.micFallback;
  }

  private stopMicPipeline(): void {
    this.mic?.stop();
    this.mic = null;
    this.gate.reset();
    setVoice({ levelDb: -80, vad: null, gateOpen: false, transmitting: false });
    this.setSelfSpeaking(false);
  }

  /** Device or RNNoise changed / device lost: rebuild capture, swap the published track in place. */
  private restartMic(): Promise<void> {
    return this.queueMic(async () => {
      const old = this.mic;
      if (!old) return;
      let next: MicPipeline | null = null;
      try {
        next = await this.buildMic();
        // Stopped (left the call / test) or replaced meanwhile: never keep an orphan capture.
        if (this.mic !== old || !this.micWanted()) {
          next.stop();
          return;
        }
        if (this.micTrack) {
          next.track.enabled = !this.micTrack.isMuted && this.gateWantsAudio();
          await this.micTrack.replaceTrack(next.track, { userProvidedTrack: true });
          if (this.mic !== old || !this.micWanted()) {
            next.stop(); // torn down while the track was being swapped
            return;
          }
        }
        // Only now is `next` the live capture: a failed swap keeps `old` (still published)
        // and drops `next`, so neither capture leaks (review N4).
        this.mic = next;
        this.applyDenoise();
        old.stop();
      } catch (err) {
        if (next && this.mic !== next) next.stop();
        const h = humanMediaError(err, 'mic');
        setVoice({ micError: h.text, micErrorAction: h.action });
      }
    });
  }

  private micPublishOptions(): TrackPublishOptions {
    return {
      source: Track.Source.Microphone,
      dtx: AUDIO_PUBLISH_DEFAULTS.dtx,
      red: prefs().red,
      forceStereo: false,
      // Room setting, optionally capped by the user's personal limit (UserSettings.audio_bitrate_kbps).
      audioPreset: { maxBitrate: Math.min(this.audioBitrateKbps, prefs().personalBitrateKbps ?? Infinity) * 1000 },
    };
  }

  private async publishMic(): Promise<void> {
    const room = this.room;
    if (!room || !this.mic) return;
    const track = new LocalAudioTrack(this.mic.track, undefined, true);
    this.micTrack = track;
    if (this.explicitlyMuted()) {
      this.selfMuting = true;
      await track.mute();
      this.selfMuting = false;
    } else {
      track.mediaStreamTrack.enabled = this.gateWantsAudio();
    }
    await room.localParticipant.publishTrack(track, this.micPublishOptions());
    this.applyTransmit();
  }

  /** RED and bitrate are negotiated at publish time → republish the same track. */
  private async republishMic(): Promise<void> {
    const room = this.room;
    const track = this.micTrack;
    if (!room || !track) return;
    await room.localParticipant.unpublishTrack(track, false);
    await room.localParticipant.publishTrack(track, this.micPublishOptions());
    this.applyTransmit();
  }

  private onMicReport(r: MicReport): void {
    const db = rmsToDb(r.rms);
    this.lastMicDb = db;
    const vad = r.vad < 0 ? null : r.vad;
    const wasOpen = this.gate.open;
    const open = this.gate.push({ db, vad });
    const now = performance.now();
    const update = meterUpdate({ open, wasOpen, meter: this.meterShown(), now, last: this.lastMeterPush, intervalMs: METER_UI_INTERVAL_MS });
    if (update === 'level') {
      this.lastMeterPush = now;
      setVoice({ levelDb: db, vad, gateOpen: open });
    } else if (update === 'gate') {
      setVoice({ gateOpen: open });
    }
    if (open !== wasOpen && prefs().micMode === 'voice') this.applyTransmit();
  }

  private decision(): ReturnType<typeof transmitDecision> {
    const v = useVoice.getState();
    return transmitDecision({
      muted: v.muted,
      deafened: v.deafened,
      canSpeak: v.canSpeak,
      mode: prefs().micMode,
      gateOpen: this.gate.open,
      pttDown: v.pttDown,
    });
  }

  private explicitlyMuted(): boolean {
    return this.decision().livekitMuted;
  }

  private gateWantsAudio(): boolean {
    return this.decision().audioEnabled;
  }

  /**
   * Two layers (docs/02-media.md, "Режимы микрофона", lib/voiceLogic.ts):
   *  - explicit mute → LiveKit `track.mute()` (signalled; the server derives voice-state
   *    `muted` from the mic track mute via webhooks);
   *  - VAD gate / PTT → `mediaStreamTrack.enabled = false` only: the sender emits silence
   *    (Opus DTX ≈ 0), no signalling, no webhook/VOICE_STATE_UPDATE storm on every pause.
   *    The track stays published, so opening is instant.
   */
  private applyTransmit(): void {
    const t = this.micTrack;
    const d = this.decision();
    // Closing is the latency-critical edge (PTT key-up): silence the sender first, synchronously —
    // before the store / ring / duck updates and regardless of an in-flight LiveKit mute op
    // (a finishing unmute() re-enables the track, then `finally` re-applies this decision).
    if (t && !d.audioEnabled) t.mediaStreamTrack.enabled = false;
    this.applyDenoise(d);
    this.applyDuck(); // PTT pressed / deafen: the duck follows at once, not at the next level tick
    setVoice({ transmitting: d.transmitting && t !== null });
    this.setSelfSpeaking(d.transmitting && t !== null);
    if (!t) return;
    // `isMuted` flips only after LiveKit's async mute lock: while a mute/unmute is in flight,
    // wait for it and re-evaluate, so mute→unmute in quick succession ends in the state the
    // UI shows (review L2).
    if (this.muteOp) return;
    if (d.livekitMuted !== t.isMuted) {
      if (d.livekitMuted) this.selfMuting = true;
      const op = d.livekitMuted ? t.mute() : t.unmute();
      this.muteOp = op
        .then(
          () => undefined,
          (e: unknown) => log.warn('mic mute/unmute failed', e),
        )
        .finally(() => {
          this.muteOp = null;
          this.selfMuting = false;
          if (this.micTrack === t) this.applyTransmit();
        });
      return;
    }
    if (!t.isMuted) t.mediaStreamTrack.enabled = d.audioEnabled;
  }

  private muteOp: Promise<void> | null = null;

  /** Power events (sleep / lock): a key-up lost meanwhile must not leave PTT on (review M6). */
  resetPtt(): void {
    this.ptt.stop();
    if (!useVoice.getState().pttDown) return;
    setVoice({ pttDown: false });
    this.applyTransmit();
  }

  /**
   * On-screen push-to-talk (phone layout, ADR-0021): the button held (down) / released. The same
   * path as a key: the release tail (prefs.pttReleaseMs), the PTT sounds; only matters in the PTT mic mode.
   */
  pttHold(down: boolean): void {
    this.onPtt({ down });
  }

  private onPtt(ev: PttEvent): void {
    // Muted / deafened: the key does nothing — no gate, no activation cue (#12).
    if (ev.down && !pttAllowed(useVoice.getState())) return;
    if (ev.down) {
      this.pttUp = null;
      this.ptt.press();
    } else if (ev.immediate) {
      // Toggle-off / gate reset: no release tail.
      this.pttUp = { t: performance.now(), at: ev.at };
      this.ptt.stop();
    } else {
      this.pttUp = { t: performance.now(), at: ev.at };
      this.ptt.release(prefs().pttReleaseMs);
    }
  }

  /** The PTT gate really opened / closed (after the release tail). */
  private onPttTalking(on: boolean): void {
    const inCall = this.room !== null && useVoice.getState().phase === 'connected';
    setVoice({ pttDown: on });
    this.applyTransmit();
    const cue = pttCue(on, useVoice.getState(), inCall);
    if (cue) playSound(cue);
    const up = this.pttUp;
    if (!on && up) {
      this.pttUp = null;
      log.debug('[ptt] key-up → gate closed', {
        ipcMs: up.at !== undefined ? Date.now() - up.at : null,
        gateMs: Math.round(performance.now() - up.t),
        releaseMs: prefs().pttReleaseMs,
      });
    }
  }

  /** Mute / deafen / leave end a pending release tail at once (the key is already up). */
  private endPttTail(): void {
    if (this.ptt.pending) this.ptt.stop();
  }

  // ------------------------------------------------------------ mute / deafen

  /**
   * Gateway VOICE_MOVED for this user (ADR-0019). With a token (open-source LiveKit, app-level
   * move) this device reconnects to the target room with it; returns true when it does (the UI
   * then follows to the target). Without a token the SFU moved us (see onSfuMoved).
   */
  onMoved(ev: Pick<VoiceMoved, 'workspaceId' | 'fromRoomId' | 'toRoomId' | 'byUserId' | 'url' | 'token' | 'sessionId' | 'identity'>): boolean {
    if (!ev.token || !ev.url) {
      this.onSfuMoved(ev.fromRoomId, ev.toRoomId, ev.workspaceId);
      return false;
    }
    // One event per moved device: the others of this user ignore it. session_id is the auth
    // session (the LiveKit identity is `<user_id>:<session_id>`); the identity double-checks it.
    const mySession = useSession.getState().sessionId;
    if (ev.sessionId && mySession && ev.sessionId !== mySession) return false;
    const myIdentity = this.room?.localParticipant.identity;
    if (ev.identity && myIdentity && ev.identity !== myIdentity) return false;
    if (ev.fromRoomId === ev.toRoomId || ev.token === this.lastMoveToken) return false; // duplicate
    // Already connected to the target (a duplicate after the reconnect, or an SFU move): nothing to do.
    if (this.room?.name && this.room.name.endsWith(ev.toRoomId) && this.roomId === ev.toRoomId) return false;
    // A live rejoin loop for the source room (user intents clear rejoinRoomId), possibly still
    // tearing the dropped room down.
    const rejoining = this.rejoinRoomId === ev.fromRoomId && (this.roomId === null || this.roomId === ev.fromRoomId);
    // A previous move to our source room is still under way (its teardown of the old room may
    // take a network round trip) and no user intent came after it: the newer move wins.
    const chained = this.moveIntent !== null && this.moveIntent.seq === this.intentSeq && this.moveIntent.to === ev.fromRoomId;
    // In the source room (connected or still connecting), or the SFU-path event came first and
    // optimistically switched our room id to the target.
    const inSource = this.roomId === ev.fromRoomId || (this.moveTimer !== null && this.roomId === ev.toRoomId);
    if (!inSource && !rejoining && !chained) return false;
    // A teardown in flight is a user's leave or switch (newer intent than the move): it wins.
    if (this.teardownRun && !rejoining && !chained) return false;
    this.lastMoveToken = ev.token;
    const wasStreaming = useVoice.getState().myStream !== null;
    // App-level move: the camera ends with the old connection and is not turned on again by
    // itself in the target room (its camera_limit / VIDEO apply; review L6) — the toast says so.
    const wasCamera = useVoice.getState().camera === 'on';
    const serverMuted = useVoice.getState().serverMuted;
    log.info('voice: moved by a moderator, reconnecting to the target room');
    playSound('moved');
    this.announceMove(ev, wasStreaming, wasCamera);
    // Like a join: the latest intent, stops a pending rejoin. mute / deafen / PTT stay in the
    // voice store (teardown keeps them) and are applied to the new mic; the stream is not
    // restored (docs/05: requested again by the user).
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.clearMoveTimer();
    if (this.roomId === ev.toRoomId) this.roomId = ev.fromRoomId; // let connect() see a change
    void this.connect(ev.toRoomId, ev.workspaceId, false, { url: ev.url, token: ev.token, serverMuted });
    // connect() took its intent token synchronously: a later join/leave bumps it.
    this.moveIntent = { seq: this.intentSeq, to: ev.toRoomId };
    return true;
  }

  /** The app-level move in progress (its connect's intent token and target room). */
  private moveIntent: { seq: number; to: string } | null = null;

  /** Token of the last app-level move acted upon (duplicate events are ignored). */
  private lastMoveToken = '';

  private announceMove(ev: Pick<VoiceMoved, 'workspaceId' | 'toRoomId' | 'byUserId'>, wasStreaming: boolean, wasCamera = false): void {
    const room = useRooms.getState().byId[ev.toRoomId]?.name ?? '';
    const me = useSession.getState().me?.user?.id ?? '';
    const ws = useWorkspaces.getState();
    const known = ev.byUserId !== '' && ev.byUserId !== me && (ws.byId[ev.workspaceId]?.members[ev.byUserId] !== undefined || ws.users[ev.byUserId] !== undefined);
    const by = known ? memberName(ev.workspaceId, ev.byUserId) : '';
    const text = by ? t('mediaErr.voice.movedBy', { name: by, room }) : t('mediaErr.voice.moved', { room });
    const withStream = wasStreaming ? t('mediaErr.voice.movedStream', { text }) : text;
    toast.info(wasCamera ? t('video.movedOff', { text: withStream }) : withStream);
  }

  /**
   * SFU move (LiveKit Cloud MoveParticipant): LiveKit keeps the connection (RoomEvent.Moved); we
   * only switch our room id. If this device is not the one LiveKit moved (or Moved never comes),
   * rejoin the target room cleanly after a grace period.
   */
  private onSfuMoved(fromRoomId: string, toRoomId: string, workspaceId: string): void {
    if (!this.room || this.roomId !== fromRoomId || fromRoomId === toRoomId) return;
    this.roomId = toRoomId;
    setVoice({ roomId: toRoomId, workspaceId });
    playSound('moved');
    this.syncTray();
    this.clearMoveTimer();
    const room = this.room;
    this.moveTimer = window.setTimeout(() => {
      this.moveTimer = null;
      // Still connected to the old LiveKit room name → the server move did not reach us.
      if (this.room === room && room.name && !room.name.endsWith(toRoomId)) {
        log.warn('voice: no RoomEvent.Moved, rejoining', room.name);
        this.roomId = fromRoomId; // let connect() see a change
        void this.connect(toRoomId, workspaceId, true);
      }
    }, 4000);
  }

  private clearMoveTimer(): void {
    if (this.moveTimer !== null) window.clearTimeout(this.moveTimer);
    this.moveTimer = null;
  }

  toggleMute(): void {
    const v = useVoice.getState();
    // A moderator mute (VoiceState.server_muted) can't be lifted by the user: the server removed
    // the microphone from our grant and PATCH /api/voice/self {muted:false} would be 403.
    if (v.serverMuted && v.muted) {
      toast.info(t('voiceUi.serverMuted'));
      // Deafened on top: the click still lifts deafen (Discord), the mic stays with the moderator.
      if (v.deafened) this.toggleDeafen();
      return;
    }
    setVoice(toggleMute(v));
    playSound(useVoice.getState().muted ? 'mute' : v.deafened ? 'undeafen' : 'unmute');
    this.afterSelfChange();
  }

  toggleDeafen(): void {
    setVoice(toggleDeafen(useVoice.getState()));
    playSound(useVoice.getState().deafened ? 'deafen' : 'undeafen');
    this.afterSelfChange();
  }

  private afterSelfChange(): void {
    const v = useVoice.getState();
    // Muted / deafened: PTT off now, held key included (no cue — pttCue); a new press is ignored.
    if (v.muted || v.deafened) this.ptt.stop();
    this.applyVolumes();
    this.applyTransmit();
    this.pushSelfState();
    this.syncTray();
  }

  /** Optimistic voice state for everyone (docs/05: PATCH /api/voice/self). */
  private pushSelfState(): void {
    if (!this.room) return;
    const v = useVoice.getState();
    void api.voice.updateSelf({ muted: v.muted, deafened: v.deafened }).catch((e: unknown) => log.warn('voice/self failed', e));
  }

  /** Server view of our voice state differs from local (e.g. PATCH raced the join) → push again. */
  reconcileSelfState(s: { roomId: string; muted: boolean; deafened: boolean; serverMuted?: boolean }): void {
    const v = useVoice.getState();
    if (!this.room || s.roomId !== this.roomId) {
      // Not where I am connected (docs/09 #71): the server may have lost this device.
      if (this.room && this.roomId) this.scheduleSelfCheck();
      return;
    }
    // The server's moderator-mute flag is the source of truth (VoiceState.server_muted).
    if (s.serverMuted !== undefined && s.serverMuted !== v.serverMuted) {
      if (s.serverMuted) {
        setVoice({ serverMuted: true, muted: true });
        toast.info(t('mediaErr.voice.modMuted'));
      } else {
        setVoice({ serverMuted: false }); // stays muted until the user turns the mic on
        toast.info(t('voiceUi.serverUnmuted'));
      }
      this.applyTransmit();
      this.syncTray();
      return;
    }
    if (s.muted !== v.muted || s.deafened !== v.deafened) this.pushSelfState();
  }

  /** e2e / visual tests (docs/09 #71): what LiveKit is really connected to, to compare with the stores. */
  linkTruth(): { state: string | null; room: string | null; identity: string | null } {
    const r = this.room;
    return { state: r ? r.state : null, room: r ? r.name : null, identity: r ? r.localParticipant.identity : null };
  }

  /** e2e tests: an unexpected LiveKit loss — the network branch of RoomEvent.Disconnected. */
  simulateLinkLoss(): void {
    if (this.room) void this.rejoin();
  }

  syncTray(): void {
    const v = useVoice.getState();
    platform.tray.setState({ inVoice: v.roomId !== null, muted: v.muted, deafened: v.deafened });
  }

  // ------------------------------------------------------------ moderation

  async serverMute(userId: string): Promise<void> {
    if (!this.roomId) return;
    await api.voice.muteMember(this.roomId, userId);
  }

  async serverDisconnect(roomId: string, userId: string): Promise<void> {
    await api.voice.disconnectMember(roomId, userId);
  }

  // ------------------------------------------------------------ screen share

  async startStream(opts: StreamOptions): Promise<void> {
    const room = this.room;
    const roomId = this.roomId;
    if (!room || !roomId) return;
    setVoice({ streamBusy: true });
    let captured: CapturedScreen | null = null;
    let step: 'screen' | 'stream' = 'screen';
    // Codec by hardware (ADR-0032) or the «Кодек стрима» setting; probed while capture / grant run.
    const codec = pickPublishCodec('screen', usePrefs.getState().streamCodec);
    // Left / switched rooms during one of the awaits below: stop; `finally` releases the capture
    // (review N9).
    const stale = (): boolean => this.room !== room;
    try {
      await this.stopStream();
      if (stale()) return;
      // 1) capture first (browsers need the click's transient activation for the picker);
      captured = await captureScreen(opts);
      if (stale()) return;
      step = 'stream';
      // 2) reserve a slot + get the screen_share grant (409 when max_streams is reached);
      const granted = await api.voice.requestStream(roomId, opts.preset);
      if (stale()) return;
      // The server may lower both (room / plan limits, ADR-0024): publish exactly what it granted.
      const preset = (granted.preset || opts.preset);
      const fps = granted.fps || undefined;
      if (preset !== opts.preset || capFps(SCREEN_SHARE_PRESETS[preset].fps, fps) < SCREEN_SHARE_PRESETS[opts.preset].fps) await applyPreset(captured, preset, fps);
      await this.waitForScreenGrant(room);
      if (stale()) return;
      // 3) publish.
      const share = await startScreenShare(
        room.localParticipant,
        { ...opts, preset, codec: (await codec).codec, h264Profile: (await codec).profile, ...(fps ? { fps } : {}) },
        () => {
          if (this.screen === share) {
            this.screen = null;
            annot.presenting(null);
            setVoice({ myStream: null });
            this.refreshStreams();
          }
        },
        captured,
      );
      captured = null;
      if (stale()) {
        await share.stop();
        return;
      }
      this.screen = share;
      this.viewers.set(share.video.sid ?? '', new Set());
      // Whole screen: the annotation overlay may cover it (ADR-0028); a window: preview only.
      const src = opts.source;
      annot.presenting(share.video.sid ?? null, src.id.startsWith('screen:') && src.displayId ? { sourceId: src.id, displayId: src.displayId } : null);
      const audio = share.audioProblem
        ? reportMediaError(share.audioProblem.raw, 'streamAudio', share.audioProblem.code === 'no-loopback' ? 'no-loopback' : undefined)
        : null;
      setVoice({
        myStream: { sourceName: share.sourceName, preset, hasAudio: share.audio !== null, audioError: audio?.text ?? null, viewers: 0 },
      });
      this.refreshStreams();
      if (preset !== opts.preset) toast.info(t('mediaErr.stream.limited'));
    } catch (err) {
      log.error('stream start failed', err);
      reportMediaError(err, step);
    } finally {
      // Captured but never published (409, grant timeout…): release the screen.
      captured?.stream.getTracks().forEach((t) => t.stop());
      setVoice({ streamBusy: false });
    }
  }

  /** The server updates our LiveKit grant after /stream/request; wait until it arrives. */
  private async waitForScreenGrant(room: Room): Promise<void> {
    const ok = (): boolean => {
      const sources = room.localParticipant.permissions?.canPublishSources ?? [];
      return sources.length === 0 || sources.includes(3 /* SCREEN_SHARE */);
    };
    if (ok()) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        room.off(RoomEvent.ParticipantPermissionsChanged, check);
        window.clearTimeout(timer);
        resolve();
      };
      const check = (): void => {
        if (ok()) done();
      };
      const timer = window.setTimeout(done, 4000);
      room.on(RoomEvent.ParticipantPermissionsChanged, check);
    });
  }

  async stopStream(): Promise<void> {
    const s = this.screen;
    this.screen = null;
    if (s) this.viewers.delete(s.video.sid ?? '');
    if (s) annot.presenting(null);
    setVoice({ myStream: null });
    if (s) this.refreshStreams();
    if (s) await s.stop();
  }

  localStreamTrack(): ActiveScreenShare['video'] | null {
    return this.screen?.video ?? null;
  }

  // ---- viewers count over LiveKit data (ephemeral, in-call only) ----

  /**
   * «I watch your stream» goes to the streamer only for the stream on my stage (PiP, expanded or
   * pop-out) once its video is subscribed — preview tiles in the strip don't count as watching.
   */
  private syncAnnounce(): void {
    const room = this.room;
    if (!room) return;
    const watching = useVoice.getState().watching;
    let next: { owner: string; sid: string } | null = null;
    if (watching) {
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublicationBySid(watching);
        if (pub?.isSubscribed) next = { owner: p.identity, sid: watching };
      }
    }
    const prev = this.announced;
    if (prev?.sid === next?.sid && prev?.owner === next?.owner) return;
    this.announced = next;
    if (prev) this.announceWatch(prev.owner, prev.sid, false);
    if (next) this.announceWatch(next.owner, next.sid, true);
  }

  private announceWatch(owner: string, trackSid: string, on: boolean): void {
    const room = this.room;
    if (!room) return;
    const data = new TextEncoder().encode(JSON.stringify({ sid: trackSid, on }));
    void room.localParticipant.publishData(data, { reliable: true, topic: WATCH_TOPIC, destinationIdentities: [owner] }).catch(() => undefined);
  }

  private onWatchMessage(payload: Uint8Array, from: RemoteParticipant): void {
    try {
      const m = JSON.parse(new TextDecoder().decode(payload)) as { sid?: string; on?: boolean };
      const set = m.sid ? this.viewers.get(m.sid) : undefined;
      if (!set) return;
      if (m.on) set.add(from.identity);
      else set.delete(from.identity);
      if (m.on && m.sid) annot.viewerJoined(from.identity, m.sid);
      this.publishViewers();
    } catch {
      // ignore malformed
    }
  }

  private publishViewers(): void {
    const my = useVoice.getState().myStream;
    const sid = this.screen?.video.sid;
    if (!my || !sid) return;
    setVoice({ myStream: { ...my, viewers: this.viewers.get(sid)?.size ?? 0 } });
  }

  // ------------------------------------------------------------ stats / quality

  private statsBusy = false;

  private startStats(): void {
    this.stopStats();
    this.levelTimer = window.setInterval(() => this.sampleLevels(), ECHO.frameMs);
    this.statsTimer = window.setInterval(() => {
      // getStats can take longer than the interval on a loaded machine: never overlap (review L8).
      if (this.statsBusy) return;
      this.statsBusy = true;
      void this.collectStats()
        .catch((e: unknown) => log.warn('stats failed', e))
        .finally(() => {
          this.statsBusy = false;
        });
    }, STATS_INTERVAL_MS);
  }

  private stopStats(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer);
    this.levelTimer = null;
  }

  // ------------------------------------------------------------ echo (docs/02 «Эхо: колонки»)

  /**
   * Every 50 ms: the loudest remote voice as it is played (RFC 6464 level from the receiver's
   * synchronization sources × the element volume — no WebAudio on remote audio, echo rule 1)
   * and my mic level as sent → the echo detector; then the speakerphone duck.
   */
  private sampleLevels(): void {
    const room = this.room;
    if (!room) return;
    // One 50 ms timer for both level consumers: the speaking rings sample at half its rate.
    const every = Math.round(REMOTE_LEVEL.sampleMs / ECHO.frameMs);
    if (this.levelSpeakOn && ++this.levelTick % every === 0) this.sampleLevelSpeaking();
    // Spec time base: performance.timeOrigin + performance.now(); tolerate a page-relative one too.
    const mono = performance.now();
    const epoch = performance.timeOrigin + mono;
    let remote = 0;
    for (const rp of room.remoteParticipants.values()) {
      const track = rp.getTrackPublication(Track.Source.Microphone)?.track;
      const rx = track?.receiver;
      const el = track?.sid ? this.audioOut.element(track.sid) : undefined;
      if (!rx || !el || el.muted || el.volume === 0) continue;
      for (const src of rx.getSynchronizationSources()) {
        if (Math.min(Math.abs(epoch - src.timestamp), Math.abs(mono - src.timestamp)) > LEVEL_FRESH_MS) continue;
        remote = Math.max(remote, (src.audioLevel ?? 0) * el.volume);
      }
    }
    const t = mono;
    const remoteActive = this.remoteTalk.push(remote, t);
    const ducked = this.mic?.isDucked ?? false;
    this.echo.pushFrame({ t, remote, remoteActive, micDb: this.lastMicDb + (ducked ? ECHO.duckDb : 0), sending: useVoice.getState().transmitting });
    this.applyDuck();
  }

  /** Speakerphone duck on the capture path (lib/media/echo.ts duckWanted). */
  private applyDuck(): void {
    const v = useVoice.getState();
    const p = prefs();
    const on =
      this.room !== null &&
      this.mic !== null &&
      duckWanted({ mode: p.echoMode, echoRisk: this.echo.risk, remoteActive: this.remoteTalk.active, micMode: p.micMode, pttDown: v.pttDown, deafened: v.deafened });
    this.mic?.setDuck(on);
    if (on !== v.ducking) setVoice({ ducking: on });
  }

  private onEchoRisk(): void {
    log.warn('voice: echo reaches the others', { reason: this.echo.reason, corr: this.echo.lastCorr });
    setVoice({ echoRisk: true });
    this.applyDuck();
    if (this.echoToasted) return;
    this.echoToasted = true;
    const mode = prefs().echoMode;
    if (mode === 'headphones') {
      useToasts.getState().push('info', t('echo.risk'), { label: t('echo.riskAction'), run: () => usePrefs.getState().setPrefs({ echoMode: 'speakers' }) }, 12_000);
    } else {
      toast.info(t(mode === 'auto' ? 'echo.riskAuto' : 'echo.riskSpeakers'));
    }
  }

  private resetEcho(): void {
    this.echo.reset();
    this.remoteTalk.reset();
    this.mic?.setDuck(false);
    const v = useVoice.getState();
    if (v.echoRisk || v.ducking) setVoice({ echoRisk: false, ducking: false });
  }

  private async collectStats(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const transports = new Map<string, { ts: number; sent: number; received: number }>();
    const note = (r: RTCStatsReport): void => {
      const t = transportBytes(r);
      if (t) transports.set(t.id, t);
    };
    let pair = null;
    let micKbps: number | null = null;
    let aec: { erl: number | null; erle: number | null } = { erl: null, erle: null };
    const losses: number[] = [];

    const micReport = await this.micTrack?.getRTCStatsReport();
    if (micReport) {
      note(micReport);
      const o = outboundAudio(micReport, this.rates, 'mic');
      micKbps = o?.kbps ?? null;
      pair = candidatePair(micReport);
      aec = audioSourceEcho(micReport);
      if (o?.fractionLost !== null && o?.fractionLost !== undefined) losses.push(o.fractionLost * 100);
    }
    const cameraReport = await this.camera.localTrack?.getRTCStatsReport();
    const cameraOut = cameraReport ? outboundVideo(cameraReport, this.rates, 'camera') : [];
    if (cameraReport) {
      note(cameraReport);
      pair ??= candidatePair(cameraReport);
    }
    this.camera.onStats(cameraOut);
    const screenReport = await this.screen?.video.getRTCStatsReport();
    const screenOut = screenReport ? outboundVideo(screenReport, this.rates, 'screen') : [];
    if (screenReport) {
      note(screenReport);
      pair ??= candidatePair(screenReport);
    }
    let watching = null;
    const watchedSid = useVoice.getState().watching;
    // One getStats() on the subscriber connection for every remote track instead of one per
    // track (30 mics = 30 calls every 2 s, review L8); split by inbound-rtp entry.
    // NOTE: `engine.pcManager` is livekit-client internals (the version is pinned exactly in
    // package.json for this reason). If it disappears (e.g. single-PC mode), inbound stats are
    // just skipped; re-check this on every livekit-client upgrade (review N9).
    const inbound = await room.engine.pcManager?.subscriber?.getStats();
    if (inbound) {
      note(inbound);
      pair ??= candidatePair(inbound);
      for (const entry of inboundRtp(inbound, 'audio')) {
        const a = inboundAudio(withOnly(inbound, entry), this.rates, entry.id);
        if (a?.lossPct !== null && a?.lossPct !== undefined) losses.push(a.lossPct);
      }
      const watchedTrack = watchedSid ? this.remotePub(watchedSid)?.track?.mediaStreamTrack.id : undefined;
      const v = watchedTrack ? inboundRtp(inbound, 'video').find((e) => e['trackIdentifier'] === watchedTrack) : undefined;
      if (v && watchedSid) watching = inboundVideo(withOnly(inbound, v), this.rates, watchedSid);
    }
    const rtt = pair?.rttMs ?? null;
    let out = 0;
    let inn = 0;
    for (const [id, t] of transports) {
      out += this.rates.kbps(`t-out:${id}`, t.ts, t.sent);
      inn += this.rates.kbps(`t-in:${id}`, t.ts, t.received);
    }
    this.rates.sweep();
    const loss = losses.length ? Math.max(...losses) : null;
    let rendererCpu: number | null = null;
    if (prefs().devStats) {
      try {
        rendererCpu = (await platform.system.metrics()).rendererCpu;
      } catch {
        rendererCpu = null;
      }
    }
    if (this.room !== room) return;
    if (this.echo.evaluate(performance.now(), aec)) this.onEchoRisk();
    setVoice({
      rttMs: rtt,
      lossPct: loss,
      quality: qualityOf(rtt, loss),
      stats: { totalOutKbps: out, totalInKbps: inn, pair, micKbps, screenOut, cameraOut, watching, rendererCpu, echo: { ...aec, corr: this.echo.lastCorr } },
    });
  }

  /** Current ICE path for "Проверить соединение". */
  connectionPath(): string | null {
    const p = useVoice.getState().stats?.pair;
    if (!p) return null;
    const relay = p.localType === 'relay' ? ` ${t('conn.viaTurn', { proto: p.relayProtocol ?? '?' })}` : '';
    return `${p.localType} → ${p.remoteType}, ${p.protocol.toUpperCase()}${relay}`;
  }
}

type StatsEntry = Record<string, unknown> & { id: string; type: string };

function inboundRtp(report: RTCStatsReport, kind: 'audio' | 'video'): StatsEntry[] {
  const out: StatsEntry[] = [];
  report.forEach((e: StatsEntry) => {
    if (e.type === 'inbound-rtp' && e['kind'] === kind) out.push(e);
  });
  return out;
}

/** The report with `keep` as its only inbound-rtp (codecs, transport, candidates stay). */
function withOnly(report: RTCStatsReport, keep: StatsEntry): RTCStatsReport {
  const m = new Map<string, StatsEntry>();
  report.forEach((e: StatsEntry) => {
    if (e.type !== 'inbound-rtp' || e.id === keep.id) m.set(e.id, e);
  });
  return m;
}

export const voice = new VoiceEngine();
