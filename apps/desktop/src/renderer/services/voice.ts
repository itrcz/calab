import { useCall } from '../stores/call';
import { HostCallAudioSession } from '../lib/media/hostCallAudio';
import { audioUUID, type HostAudioControls } from '../../shared/hostCallAudio';
import { SCREEN_SHARE_PRESETS, type ConcreteScreenSharePreset, type ScreenShareContentHint, type VoiceDisconnected, type VoiceMoved, VoiceDisconnectReason } from '@calaba/protocol';
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
  type RoomEventCallbacks,
  type TrackPublishOptions,
  type DataChannelKind,
} from 'livekit-client';
import { dtmfPacket } from '../lib/media/dtmf';
import type { PttEvent } from '../../shared/ipc';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { isPersonalRoom, isPhoneRoom, phoneCallId, takePhoneJoin } from '../lib/sipInbound';
import { log } from '../lib/log';
import { isLapsed } from '../lib/billing/model';
import { restrictedPerms, roomPerms, voiceCaps } from '../lib/permissions';
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
import { hasOddH264Layer } from '../lib/media/h264';
import { installH264ProfileHook } from '../lib/media/h264Publish';
import { micTier, musicTier, type OpusTier } from '../lib/media/opusTier';
import { applyMicTier, installOpusTierHook } from '../lib/media/opusTierPublish';
import { ECHO, EchoRiskDetector, RemoteActivity, duckWanted, duckable } from '../lib/media/echo';
import { RateTracker, audioSourceEcho, candidatePair, inboundAudio, inboundVideo, outboundAudio, outboundVideo, transportBytes } from '../lib/media/stats';
import { VoiceGate, rmsToDb } from '../lib/media/vad';
import { denoiseMode, wakeDbFor } from '../lib/media/denoiseSleep';
import { rnnoiseSupported } from '../lib/media/rnnoiseSupport';
import { isMobileNow } from '../lib/mobile';
import { playSound } from '../lib/sounds';
import { SeatCues, joinLeaveCue, joinLeaveSoundMax, type SeatVerdict } from '../lib/media/joinLeaveSound';
import { PttRelease } from '../lib/pttRelease';
import { SpeakingDebouncer, speakingUserIds } from '../lib/speaking';
import { AUTO_MUTE_TOAST, AutoMuteTimer, autoMuteArmed, type AutoMuteSec } from '../lib/autoMute';
import { REMOTE_LEVEL, RemoteLevelSpeaking, readLevel, type LevelSample } from '../lib/remoteSpeaking';
import { audioDevices, deviceName, deviceSwitches, type AudioDevice } from '../lib/deviceSwitch';
import { answerCallSelf, canSpeakFrom, isDeviceGone, meterUpdate, micModeFor, mySeat, pttAllowed, pttCue, qualityOf, remoteAudio, toggleDeafen, toggleMute, transmitDecision, withUserMuted, withUserVolume } from '../lib/voiceLogic';
import { RemoteAudioOut } from '../lib/media/remoteAudioOut';
import { captureOnOutputHeadset, livekitOutputStale, outputSink, outputsChanged } from '../lib/media/outputRoute';
import { useMessages } from '../stores/messages';
import { useRooms } from '../stores/rooms';
import { isTempRoom } from '../lib/tempRooms';
import { roomClosedToast } from './roomClosed';
import { prefs, usePrefs, type Prefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { memberName, rolesOf, useWorkspaces } from '../stores/workspaces';
import { setVoice, useVoice, type RemoteCamera, type RemoteStream, type StreamQuality, type VoiceLink, type VoicePhase } from '../stores/voice';
import { platform } from '../platform';
import { VOICE_TABS_CHANNEL, parseClaim, yieldsTo, type VoiceClaim } from '../lib/voiceTabs';
import { cameraWanted } from '../lib/media/cameraLogic';
import { CameraShown, type ShownQuality } from '../lib/media/cameraShown';
import { followVoiceChat, useUi } from '../stores/ui';
import { pipCamera } from '../features/voice/tileLayout';
import { ActiveSpeaker } from '../lib/activeSpeaker';
import { lastSpoke, speakingStarts } from '../lib/lastSpoke';
import { cspBlockedHost, describeConnectError, describeDisconnect, hostOfUrl } from '../lib/voiceLink';
import { seatAction, seatRefused, type SeatView } from '../lib/voiceSeat';
import {
  AUDIO_SETTLE_MS,
  MIC_SETTLE_MS,
  PLAYBACK_PROMPT_MS,
  RESUBSCRIBE_GAP_MS,
  RESUBSCRIBE_TRIES,
  VISIBLE_SETTLE_MS,
  afterVisible,
  audioFixes,
  captureWaitsForVisible,
  micFix,
  seatGraceMs,
  type MicPubView,
} from '../lib/voiceRecovery';
import { SELF_SYNC_LAG_MS, SelfStateSync, type SelfFlags } from '../lib/selfStateSync';
import { CONNECT_STUCK_MS, ConnectWatchdog, DISCONNECT_WAIT_MS, RECONNECT_STUCK_MS, STOP_STREAM_WAIT_MS, TEARDOWN_WAIT_MS, reconnectVerdict, rejectAfter, settleWithin, type ConnectStage, type StuckKind } from '../lib/voiceWatchdog';
import { annot } from './annot';
import { ANNOT_TOPIC } from '../lib/annot/codec';
import { CameraController, cameraGrantMissing } from './camera';
import { announceDeviceSwitch } from './deviceToast';
import { musicianAllowed, musicianLockedToast } from './musician';
import { humanMediaError, reportMediaError } from './mediaErrors';
import { reportPlanError } from './plan';
import { capAudioKbps, capFps } from '../lib/plan';
import { sameBinding } from './profile';

/** A room's voice tier lowered to the workspace plan's cap (`audio_tier_max_kbps`; the server caps /join the same way). */
function planAudio(workspaceId: string, kbps: number): number {
  return capAudioKbps(kbps, useWorkspaces.getState().byId[workspaceId]?.ws.plan?.limits?.audioTierMaxKbps);
}

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

/** livekit-client's reliable data channel (DataChannelKind.RELIABLE; the enum is exported as a type only). */
const RELIABLE = 0 as DataChannelKind.RELIABLE;
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
/**
 * LiveKit removed me (PARTICIPANT_REMOVED): the server's VOICE_DISCONNECTED, sent before the
 * removal, may still be on its way — it is waited for this long before the removal is taken for
 * a moderator's (docs/05 «Несколько устройств»).
 */
const REMOVED_GRACE_MS = 500;
/**
 * Rejoin backoff (#255): 1, 2, 4, 8 s, then at most 15 s apart; at least 5 attempts and 90 s — the
 * server's default seat hold after a drop (VOICE_LOST_GRACE 60 s, removed by the next 30 s
 * reconcile, ADR-0150) — before «Не удалось вернуться в голосовую комнату».
 */
const REJOIN_MIN_ATTEMPTS = 5;
const REJOIN_MAX_BACKOFF_MS = 15_000;
const REJOIN_GIVE_UP_MS = 90_000;
/** `devicechange` comes in bursts while the OS switches the output: re-bind the elements once it settles (#255). */
const REBIND_SETTLE_MS = 400;
/**
 * The capture opened on the headset the voices play to (CBF-108): macOS moves a Bluetooth headset
 * to the HFP profile, which takes about a second and fires no `devicechange` — re-bind after it.
 */
const HEADSET_ROUTE_SETTLE_MS = 1500;
/**
 * Mic track mute / unmute (ADR-0134): an op unsettled after this counts as failed (a lock held
 * across a dead link), and a failed one is retried after MUTE_RETRY_MS (by attempt, capped) —
 * never at once, so a link that refuses it cannot spin the renderer.
 */
const MUTE_OP_TIMEOUT_MS = 3000;
const MUTE_RETRY_MS = [500, 1000, 2000, 4000, 5000] as const;

/** One connect() attempt in flight (docs/09 #131): where it is and since when (the watchdog's reason). */
interface ConnectAttempt {
  stage: ConnectStage;
  since: number;
}

/** Room.on whose listeners run only while that room is the engine's current one (VoiceEngine.wire). */
interface GuardedRoom {
  on<E extends keyof RoomEventCallbacks>(ev: E, fn: RoomEventCallbacks[E]): GuardedRoom;
}

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): the «tap to turn the sound on» prompt / my mic trouble, without a real interruption. */
    __calabaVoiceRecovery?: (what: 'playback' | 'recovering' | 'unheard') => void;
  }
}

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


/** «Тариф не активен» (ADR-0086 amendment): audio only — no stream / camera buttons (the server drops the grants too). */
function lapsedPerms(workspaceId: string, perms: bigint): bigint {
  return restrictedPerms(perms, isLapsed(useWorkspaces.getState().byId[workspaceId]?.ws.billing));
}

class VoiceEngine {
  /** My flags → PATCH /api/voice/self, converging on the latest intent (ADR-0134). */
  private readonly selfSync = new SelfStateSync({
    send: (flags) => api.voice.updateSelf(flags),
    retriable: (e, flags) => this.selfSyncRetriable(e, flags),
    onLag: (on) => {
      this.serverLag = on;
      this.syncLag();
    },
    onError: (e) => log.warn('voice/self failed', e),
  });
  private serverLag = false;
  /** The mic track's mute differs from the intent for over SELF_SYNC_LAG_MS (a failing / hung op). */
  private trackLag = false;
  private trackLagTimer: number | null = null;
  private muteRetryTimer: number | null = null;
  /** scheduleRebind: the settle timer after an output device change. */
  private rebindTimer: number | null = null;
  /** performance.now() the pending re-bind is due at: a later request never brings it forward. */
  private rebindDue = 0;
  private muteFails = 0;
  private room: Room | null = null;
  private nativeAudio: HostCallAudioSession | null = null;
  private nativeCallEvent: string | undefined;
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
  /** «Выключать микрофон, если я молчу» (lib/autoMute.ts): one timeout off my VAD edges, nothing while not in voice. */
  private readonly autoMute = new AutoMuteTimer((sec) => this.onAutoMute(sec));
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
  /**
   * A one-to-one call's voice session (ADR-0034): voice activation only — PTT unbound and
   * ignored until the call's session ends (stores/voice `call` mirrors it for the UI).
   */
  private callMode = false;
  /** The seat of the last failed user join: a CSP report arriving after its teardown re-seats it as 'blocked'. */
  private failedSeat: { roomId: string; workspaceId: string; at: number } | null = null;
  /** The current user join brings me back after a window reload / update restart: its cue is «reconnect», not «join». */
  private resumedJoin = false;
  /** «Войти и смотреть» (ADR-0066 §3): the room whose join opens the call view. */
  private videoOnJoin: string | null = null;
  /** The cameras present at connect are known: a camera after that «turned on» (ADR-0066 §3). */
  private camerasPrimed = false;
  /** Remote cameras on screen (ADR-0066 §4): only these are subscribed. */
  private readonly shownCams = new CameraShown(() => this.applyCameras());
  /** The connect() attempt in flight (the latest one; a superseded attempt never clears it). */
  private attempt: ConnectAttempt | null = null;
  /** Watchdog retries spent on the current intent (docs/09 #131): one fresh Room + token, then out with a toast. */
  private stuckRetries = 0;
  /** «Подключение…» / «Переподключение…» that nobody finishes (docs/09 #131). */
  private readonly watchdog = new ConnectWatchdog((kind, ms) => this.onStuck(kind, ms));

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
    document.addEventListener('visibilitychange', () => {
      this.applyWatching();
      this.onVisibility();
    });
    // My camera was the last video on the call view: back to the chat.
    useVoice.subscribe((s, p) => {
      if (s.camera === 'off' && p.camera !== 'off' && s.stage === 'expanded' && !s.watching && s.cameras.length === 0) setVoice({ stage: 'pip' });
      // Primitives only: this runs on every store change (meters, speaking).
      const kind: StuckKind | null = s.joining !== null || s.phase === 'connecting' ? 'connecting' : s.phase === 'reconnecting' ? 'reconnecting' : null;
      this.watchdog.update(kind, s.joining?.roomId ?? s.roomId);
      if (s.phase === 'connected' && s.joining === null) this.stuckRetries = 0;
      if (s.phase !== p.phase) this.onPhaseChange(s.phase, p.phase);
      // Deafen, from wherever it is written: the elements at once, then the subscriptions.
      if (s.deafened !== p.deafened) {
        this.applyVolumes();
        this.applyAudioSubscriptions();
        if (!s.deafened) this.scheduleAudioCheck('undeafened');
      }
      // A moderator mute / lost SPEAK lands here without applyTransmit: the auto-mute stops too.
      if (s.muted !== p.muted || s.deafened !== p.deafened || s.serverMuted !== p.serverMuted || s.canSpeak !== p.canSpeak) this.syncAutoMute();
    });
  }

  init(): void {
    platform.ptt.onEvent((ev) => this.onPtt(ev));
    // mediaDevices is missing on insecure origins (web over plain http).
    (navigator.mediaDevices as MediaDevices | undefined)?.addEventListener('devicechange', () => {
      this.snapshotDevices(true);
      void this.onDevicesChanged();
      // macOS moves the default output (charger, dock, headphones): re-assert our sink and the
      // playback state (deafen!) on every remote element; the snapshot re-binds them once the
      // switch has settled — only when the outputs changed (snapshotDevices).
      void this.applyOutputDevice();
    });
    this.snapshotDevices(false);
    void this.applyOutputDevice(); // the chosen output for every remote element from the first one on
    // Our CSP refusing the LiveKit host (docs/09 P0 #1): retries cannot help — say so.
    document.addEventListener('securitypolicyviolation', (ev) => this.onCspViolation(ev));
    this.gate.configure({ thresholdDb: prefs().thresholdDb });
    usePrefs.subscribe((s, p) => this.onPrefs(s, p));
    // Web: the tabs of this browser share the auth session and its voice seat (#40, lib/voiceTabs).
    if (platform.kind === 'web' && typeof BroadcastChannel !== 'undefined') {
      this.tabChannel = new BroadcastChannel(VOICE_TABS_CHANNEL);
      this.tabChannel.onmessage = (ev: MessageEvent) => this.onOtherTabJoin(ev.data);
    }
    // Musician mode (ADR-0052) ends with the call and cannot stay on in a room whose plan lacks it.
    // A room switch passes «no room» with `joining` set: only no room and no join is a leave.
    useVoice.subscribe((s, p) => {
      if (s.roomId === p.roomId && s.workspaceId === p.workspaceId && s.joining === p.joining) return;
      this.guardMusician(s.roomId === null && s.joining === null);
      // A phone call's session ended with nothing joined after it (hang-up, the caller hung up,
      // the transfer went through, a failed connect): back into the parked room (ADR-0133).
      if (this.parked && s.roomId === null && s.joining === null && isPhoneRoom(p.roomId)) void this.resumeParked();
    });
    useWorkspaces.subscribe((s, p) => {
      if (s.byId !== p.byId) this.guardMusician(false);
    });
    void this.syncPttBinding();
    if (useSession.getState().appInfo?.visualTest) {
      window.__calabaVoiceRecovery = (what) => {
        if (what === 'playback') this.offerPlayback();
        else this.setMicTrouble(what);
      };
    }
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
      if (s.micMode !== p.micMode) this.pushSelfState();
    }
    if (s.outputDeviceId !== p.outputDeviceId) void this.applyOutputDevice();
    // Another speaker or mic: the acoustic path changed, judge the echo afresh.
    if (s.outputDeviceId !== p.outputDeviceId || s.micDeviceId !== p.micDeviceId) this.resetEcho();
    // Without RNNoise the pipeline has a gain stage only in the speakerphone modes: rebuild when that flips.
    const gainFlips = s.echoMode !== p.echoMode && this.mic !== null && this.mic.duckable !== (this.mic.rnnoise || duckable(s.echoMode));
    // The synced RNNoise pref flipped on another device changes nothing where RNNoise can't run.
    const denoiseFlips = s.rnnoise !== p.rnnoise && rnnoiseSupported();
    if ((denoiseFlips || s.micDeviceId !== p.micDeviceId || gainFlips) && this.mic) void this.restartMic();
    if (s.echoMode !== p.echoMode) this.applyDuck();
    if (s.red !== p.red && this.micTrack && this.room) void this.republishMic();
    if (s.personalBitrateKbps !== p.personalBitrateKbps) this.applyMicTier();
    if (s.autoMuteSec !== p.autoMuteSec) this.syncAutoMute();
    if (s.musicianMode !== p.musicianMode) this.onMusicianMode(s.musicianMode);
    if (s.userVolumes !== p.userVolumes || s.mutedUsers !== p.mutedUsers || s.deafUsers !== p.deafUsers || s.outputVolume !== p.outputVolume) this.applyVolumes();
    if (s.hiddenVideo !== p.hiddenVideo || s.saveTraffic !== p.saveTraffic) this.applyCameras();
    if (s.cameraDeviceId !== p.cameraDeviceId) void this.camera.setDevice(s.cameraDeviceId);
    if (s.cameraBackground !== p.cameraBackground || s.cameraEffects !== p.cameraEffects || s.cameraBgFps !== p.cameraBgFps) void this.camera.setBackground(s.cameraBackground, s.cameraEffects);
  }

  private async syncPttBinding(): Promise<void> {
    const s = prefs();
    try {
      await platform.ptt.setBinding(this.micMode() === 'ptt' ? s.pttBinding : null);
    } catch (e) {
      log.warn('ptt binding failed', e);
    }
  }

  /** The mic mode in force: the user's choice, voice activation during a call (ADR-0034). */
  private micMode(): 'voice' | 'ptt' {
    return micModeFor(prefs().micMode, this.callMode);
  }

  /** Enters / leaves a call's voice-only mic mode: the PTT binding and the transmit gate follow. */
  private setCallMode(on: boolean): void {
    if (this.callMode === on) return;
    this.callMode = on;
    if (this.ptt.pending) this.ptt.stop();
    if (useVoice.getState().pttDown) setVoice({ pttDown: false });
    setVoice({ call: on });
    void this.syncPttBinding();
    this.applyTransmit();
    this.pushSelfState(); // a call is voice activation only: the PTT flag follows
  }

  // ------------------------------------------------------------ join / leave

  get currentRoomId(): string | null {
    return this.roomId;
  }

  /**
   * User intent: connect to a voice room (switches rooms; cancels a pending rejoin). `call`: the
   * voice session of a one-to-one call (ADR-0034) — a DM room, `workspaceId` '' — with the mic on
   * voice activation only. `resumed`: back into the seat left by a reload / update restart
   * (services/resumeVoice.ts) — the «reconnect» cue instead of «join».
   */
  async join(roomId: string, workspaceId: string, opts: { call?: boolean; resumed?: boolean; video?: boolean; nativeCallEvent?: string } = {}): Promise<void> {
    // A suspended workspace has no calls (docs/09 #32): say so instead of a 403 toast.
    if (useWorkspaces.getState().byId[workspaceId]?.ws.suspension) {
      toast.info(t('suspended.voice'));
      return;
    }
    // A room parked by a phone call (ADR-0133): another room while the call goes on is entered
    // after it (the parked one is left now); a one-to-one call takes over like from a room.
    if (this.parked && !isPhoneRoom(roomId)) {
      if (!opts.call && this.onPhoneCall()) {
        this.parkInstead(roomId, workspaceId);
        return;
      }
      this.dropParked(true);
    }
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.failedSeat = null;
    this.takenOverRoom = null;
    this.stuckRetries = 0;
    this.resumedJoin = opts.resumed === true;
    this.linkDownAt = null; // a new room: not the old one's outage clock
    // «Войти и смотреть» (ADR-0066 §3): the call view opens as soon as the cameras are known.
    this.videoOnJoin = opts.video === true ? roomId : null;
    // The chat follows the voice (issue #127): a user join shows the room's own chat, so a message
    // is not sent to the previously open room by mistake; an open task / mail / DM is not taken
    // away (lib/chatFollow.ts). A click on another room still opens it.
    followVoiceChat({ kind: 'join', workspaceId, roomId, resumed: opts.resumed, call: opts.call });
    this.announceJoin();
    setLink({ attempts: 0, lastError: null, blockedHost: null });
    // Optimistic join (docs/05): I am in the room's list from the click on, also while the old
    // call is still being torn down; connect() takes over with phase 'connecting'.
    if (!(this.roomId === roomId && (this.room || this.nativeAudio))) setVoice({ joining: { roomId, workspaceId } });
    await this.connect(roomId, workspaceId, false, undefined, undefined, opts.call === true, opts.nativeCallEvent);
  }

  /**
   * «Повторить» on the reconnect notice: a blocked seat joins again; a running reconnect cycle
   * restarts now (the failed-attempt count goes on until a connect succeeds).
   */
  retry(): void {
    const { roomId, workspaceId, phase, call } = useVoice.getState();
    // A call's session has workspace '' (ADR-0034).
    if (!roomId || workspaceId === null) return;
    if (phase === 'blocked') {
      void this.join(roomId, workspaceId, { call });
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
      v.roomId && v.workspaceId !== null
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
  private async connect(roomId: string, workspaceId: string, quiet: boolean, moved?: MoveCreds, keepServerMuted?: boolean, call?: boolean, nativeCallEvent?: string): Promise<void> {
    if (this.roomId === roomId && this.roomAlive()) return;
    const attempt: ConnectAttempt = { stage: 'teardown', since: Date.now() };
    this.attempt = attempt;
    try {
      await this.connectOnce(attempt, roomId, workspaceId, quiet, moved, keepServerMuted, call, nativeCallEvent);
    } finally {
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  /**
   * The current Room is worth keeping for a join of the same room: connected, resuming by itself,
   * or a connect younger than the watchdog's limit. A dead or stuck one is never reused (docs/09 #131).
   */
  private roomAlive(): boolean {
    const room = this.room;
    if (this.nativeAudio) return this.nativeAudio.alive;
    if (!room) return false;
    if (room.state === ConnectionState.Connected || room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting) return true;
    return this.attempt !== null && Date.now() - this.attempt.since < CONNECT_STUCK_MS;
  }

  private async connectOnce(
    attempt: ConnectAttempt,
    roomId: string,
    workspaceId: string,
    quiet: boolean,
    moved?: MoveCreds,
    keepServerMuted?: boolean,
    call?: boolean,
    nativeCallEvent?: string,
  ): Promise<void> {
    // The intent token is taken *before* the teardown (which awaits a network disconnect):
    // a leave() or a newer join during that window bumps it, and this call bails out, so the
    // last click wins (review N1). The join sequence is taken after the teardown, because
    // teardown bumps it too (review H1).
    const intent = ++this.intentSeq;
    // A teardown still finishing (a leave or another switch) goes first: its tail resets the
    // voice store and would wipe this connect's state.
    // Bounded (docs/09 #131): a teardown that never settles must not become a barrier for every
    // later join (teardown bounds its own awaits; this is the belt to those braces).
    while (this.teardownRun) {
      const run = this.teardownRun;
      if (!(await settleWithin(run, TEARDOWN_WAIT_MS))) {
        log.warn(`voice: a teardown did not settle in ${TEARDOWN_WAIT_MS} ms, going on without it`);
        if (this.teardownRun === run) this.teardownRun = null;
      }
      if (intent !== this.intentSeq) return;
    }
    if (this.room || this.nativeAudio) await this.teardown(false, quiet);
    if (intent !== this.intentSeq) return;
    // A fresh join decides the mic mode (a call: voice only); a reconnect / move keeps it.
    if (call !== undefined) { this.setCallMode(call); this.nativeCallEvent = call ? nativeCallEvent : undefined; }
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
      galleryPage: 0,
      ...(carried !== undefined ? { serverMuted: carried } : {}),
    });
    this.camerasPrimed = false;
    try {
      attempt.stage = 'join';
      // A move (ADR-0019) comes with a token for the target room: no /join round trip.
      const res = moved ? this.movedJoin(roomId, workspaceId, moved) : await this.requestJoin(roomId, seq);
      if (seq !== this.joinSeq || !res) return;
      // The server recorded this device as pending with default flags: tell it my mute /
      // deafen now, so the others' pending row is right before LiveKit connects.
      if ('pending' in res && res.pending) {
        const flags = this.selfFlags();
        if (flags.muted || flags.deafened || flags.musician || flags.ptt) this.selfSync.push(flags);
      }
      this.lastJoin = { url: res.url, token: res.token };
      setLink({ rtcHost: hostOfUrl(res.url) });
      this.audioBitrateKbps = res.media?.audioBitrateKbps || 32;
      const nativeCapability = platform.incomingCalls?.audio;
      if (this.callMode && this.nativeCallEvent && nativeCapability) {
        attempt.stage = 'signal';
        const session = new HostCallAudioSession(nativeCapability, {
          eventId: this.nativeCallEvent, connectionId: crypto.randomUUID(), roomId,
          url: res.url, token: res.token, relayOnly: useSession.getState().appInfo?.forceRelay === true,
          bitrate: Math.min(64, Math.max(8, this.micTier().kbps)) * 1000,
          canSpeak: res.canSpeak, controls: this.nativeControls(),
        }, state => {
          if (seq !== this.joinSeq || this.nativeAudio !== session) return;
          if (state.phase === 'failed' || state.phase === 'ended') {
            // Reuse the web engine's seat ownership rules: an SFU removal can precede
            // the gateway takeover event. Never hang up the call on the new device.
            if (state.error === 'removed') {
              this.clearRemoved();
              this.removed = { roomId, timer: window.setTimeout(() => {
                this.removed = null;
                if (this.nativeAudio === session) void this.leave(false);
              }, REMOVED_GRACE_MS) };
            } else if (state.error === 'duplicate') {
              this.takenOverRoom = roomId;
              void this.leave(false, false);
            } else if (state.error === 'network') {
              void this.rejoin();
            } else void this.leave(false);
            return;
          }
          if (state.phase === 'connected' || state.phase === 'reconnecting') {
            setVoice({ phase: state.phase, canSpeak: state.canSpeak,
              speaking: Object.fromEntries(state.speakers.map(id => [id, true])) });
          }
        });
        this.nativeAudio = session;
        // Settings may have left a mic test running before the system answer.
        this.micTesting = false;
        this.stopMicPipeline();
        // The local audio proof has no native video transport; never start a second web room.
        setVoice({ canSpeak: res.canSpeak, canStream: false, canVideo: false });
        await session.start();
        if (seq !== this.joinSeq || this.nativeAudio !== session) { session.stop(); return; }
        setLink({ attempts: 0, lastError: null, blockedHost: null });
        session.control(this.nativeControls());
        this.pushSelfState(); this.syncTray();
        return;
      }
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: false, // echo rule 1
        disconnectOnPageLeave: true,
        // LiveKit applies its output id to every new remote track: it must be ours (lib/media/outputRoute).
        ...(this.outputSinkNow() ? { audioOutput: { deviceId: this.outputSinkNow() } } : {}),
      });
      this.room = room;
      // H.264 «Авто» = High on the wire (hardware on macOS): codec preferences set between
      // addTransceiver and the offer (lib/media/h264.ts, docs/02 «Кодек»). Lives as long as the Room.
      installH264ProfileHook(room.localParticipant, () => room.engine.pcManager?.publisher.getTransceivers());
      // Voice tier on the wire: the mic's Opus bandwidth / bitrate / FEC in every answer (docs/02 «Битрейт»).
      installOpusTierHook(room, () => this.micTier());
      annot.attach(room);
      this.wire(room);
      const relayOnly = useSession.getState().appInfo?.forceRelay === true;
      // livekit-client prepares the publisher PC and its offer before the signalling socket and
      // its timeout exist (RTCEngine.join): not bounded by LiveKit — the watchdog covers it.
      attempt.stage = 'signal';
      await room.connect(res.url, res.token, {
        autoSubscribe: false,
        ...(relayOnly ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {}),
      });
      this.reachedConnected.add(room);
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
      // A seat kept with «on the phone» (ADR-0133: a reload during the call, or a lost parked
      // connection joined anew — the idempotent /join keeps the flag): I am back, clear it.
      const sv = useWorkspaces.getState().byId[workspaceId]?.voice[this.myId()];
      this.pushSelfState(sv?.roomId === roomId && sv.onPhone ? { onPhone: false } : {});
      this.refreshStreams();
      this.refreshCameras();
      this.camerasPrimed = true;
      if (this.videoOnJoin === roomId) {
        this.videoOnJoin = null;
        if (this.anyCamera() && !useVoice.getState().watching) setVoice({ stage: 'expanded', videoPip: true });
      }
      // Back in after a lost connection (the rejoin cycle) or a reload: «reconnect», else «join».
      const cue = quiet || this.resumedJoin ? 'reconnect' : 'join';
      if (cue === 'join' || !this.cuesQuiet()) playSound(cue);
      this.resumedJoin = false;
      this.syncTray();
      this.afterLinkBack(quiet ? 'rejoined' : 'connected');
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
      ...voiceCaps(lapsedPerms(workspaceId, roomPerms(role, me, room)), room),
      media: { audioBitrateKbps: planAudio(workspaceId, room?.media?.audioBitrateKbps || this.audioBitrateKbps) },
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
    if (!room) return;
    // The room's voice tier (ROOM_UPDATE, or a workspace default change re-sent as one): live,
    // capped by the plan as the server caps /join (ADR-0024, owner 28.09).
    const kbps = room.media?.audioBitrateKbps ? planAudio(workspaceId, room.media.audioBitrateKbps) : 0;
    if (kbps && kbps !== this.audioBitrateKbps) {
      this.audioBitrateKbps = kbps;
      this.applyMicTier();
    }
    if (roles.length === 0) return;
    const next = voiceCaps(lapsedPerms(workspaceId, roomPerms(roles, me, room)), room);
    if (next.canStream !== canStream || next.canVideo !== canVideo) setVoice(next);
  }

  /** Bumped by every user join/leave: a running rejoin loop stops when it changes. */
  private rejoinGen = 0;

  /** Rooms whose room.connect() succeeded: only their Disconnected starts a rejoin cycle (#255). */
  private readonly reachedConnected = new WeakSet<Room>();

  /** Bumped by every connect() and leave(): a connect still tearing down the old room bails out. */
  private intentSeq = 0;

  /**
   * Rejoin after an unexpected disconnect: 1 s, 2 s, 4 s, 8 s, then every 15 s (`now`: the first one
   * at once), for at least 5 attempts and REJOIN_GIVE_UP_MS — as long as the server holds a dropped
   * seat (ADR-0150), so a metro tunnel or a Wi-Fi ↔ LTE switch does not end the call while the
   * others still see «Нет связи». The network coming back wakes the next attempt at once. The seat
   * (room id, phase 'reconnecting') stays in the store for the whole cycle: the voice panel keeps
   * its state and open menus instead of remounting on every attempt.
   */
  private async rejoin(seatRoom?: string, seatWs?: string, now = false): Promise<void> {
    const roomId = seatRoom ?? this.roomId;
    const wsId = seatWs ?? useVoice.getState().workspaceId;
    // A call's session has workspace '' (ADR-0034): it reconnects like a room.
    if (!roomId || wsId === null) return;
    const gen = ++this.rejoinGen;
    const stream = useVoice.getState().myStream;
    // The moderator mute outlives the reconnect: the server grants no SPEAK again, and until
    // that grant arrives the UI must not show «not muted». Reset only by a grant or a leave.
    const serverMuted = useVoice.getState().serverMuted;
    const camera = useVoice.getState().camera === 'on';
    this.rejoinRoomId = roomId;
    try {
      await this.teardown(false, true);
      const started = Date.now();
      for (let attempt = 0; attempt < REJOIN_MIN_ATTEMPTS || Date.now() - started < REJOIN_GIVE_UP_MS; attempt++) {
        if (gen !== this.rejoinGen) return; // the user left or switched meanwhile
        setVoice({ roomId, workspaceId: wsId, phase: 'reconnecting', serverMuted });
        // The backoff ends early when the gateway is back (the network is): checkSeat wakes it.
        await new Promise<void>((r) => {
          // `now`: the page is back after a long hide — the first attempt without the 1 s wait.
          const timer = setTimeout(r, now && attempt === 0 ? 0 : Math.min(1000 * 2 ** attempt, REJOIN_MAX_BACKOFF_MS));
          this.rejoinWake = () => {
            clearTimeout(timer);
            r();
          };
        });
        this.rejoinWake = null;
        if (gen !== this.rejoinGen) return;
        await this.connect(roomId, wsId, true, undefined, serverMuted);
        if (gen !== this.rejoinGen) return;
        // A Disconnected between room.connect() resolving and here is ignored by its handler
        // (a rejoin is running): a room that is not Connected now is not back — drop it, go on.
        if (this.room && this.room.state !== ConnectionState.Connected && !this.nativeAudio?.connected) {
          log.info(`voice: rejoin attempt ${attempt + 1} got a room that is ${this.room.state} already`);
          await this.teardown(false, true);
          if (gen !== this.rejoinGen) return;
          continue;
        }
        if (this.room || this.nativeAudio?.connected) {
          if (stream) toast.info(t('mediaErr.stream.restart'));
          // The camera comes back by itself (a new capture, no preview); start() explains a failure.
          if (camera) void this.camera.start();
          return;
        }
      }
      toast.error(t('mediaErr.voice.lost'));
      // Gave up: release the held seat now (best effort, offline it just expires on the server),
      // so the others do not keep seeing «Нет связи» for someone who is out. A call ends by itself.
      if (wsId !== '') this.sendLeave(roomId);
      await this.teardown(false);
    } finally {
      if (this.rejoinGen === gen) this.rejoinRoomId = null;
    }
  }

  // ------------------------------------------------------------ watchdog (docs/09 #131)

  /**
   * «Подключение…» or «Переподключение…» that nobody finishes (ConnectWatchdog). Connecting: the
   * whole connection state is reset and one retry runs with a fresh Room and a fresh /join token;
   * stuck again → out of voice with a toast and the reason in main.log. Reconnecting: see
   * onReconnectStuck.
   */
  private onStuck(kind: StuckKind, ms: number): void {
    if (useSession.getState().appInfo?.visualTest) return; // screenshots set phases by hand
    if (kind === 'reconnecting') {
      this.onReconnectStuck(ms);
      return;
    }
    const v = useVoice.getState();
    const target = v.joining ?? (v.roomId && v.workspaceId !== null ? { roomId: v.roomId, workspaceId: v.workspaceId } : null);
    if (!target) return;
    // The store missed LiveKit's Connected (nothing is connecting): just say so.
    if (!this.attempt && !v.joining && this.roomId === target.roomId && this.room?.state === ConnectionState.Connected) {
      log.warn('voice: phase «connecting» with a connected room and no attempt in flight, fixed');
      setVoice({ phase: 'connected' });
      return;
    }
    const stage = this.attempt?.stage ?? 'none';
    const reason = t(`voice.stuck.${stage}`);
    const secs = Math.round(ms / 1000);
    if (this.stuckRetries === 0) {
      this.stuckRetries = 1;
      log.warn(`voice: stuck connecting to ${target.roomId} for ${secs} s (stage ${stage}), resetting and retrying with a fresh Room and token`);
      setLink({ lastError: t('voice.stuck.retry', { reason, s: secs }) });
      this.watchdog.rearm();
      void this.restartConnect(target.roomId, target.workspaceId);
      return;
    }
    this.failStuck(target.roomId, `stuck connecting for ${secs} s (stage ${stage})`, reason);
  }

  /** Out of voice after the watchdog's retry did not help: a toast with the reason, main.log with the stage. */
  private failStuck(roomId: string, why: string, reason: string): void {
    log.error(`voice: could not connect to ${roomId}: ${why}, leaving voice`);
    toast.error(t('voice.connectFailed', { reason }));
    this.resetConnection();
    void this.leave(false).then(() => setLink({ lastError: reason }));
  }

  /**
   * Forgets every in-flight connection operation (docs/09 #131): whatever a stuck attempt, rejoin
   * loop, move or teardown still awaits is abandoned — the generation counters move on (it bails
   * out wherever it resumes) and no barrier it holds (teardownRun, /join, /voice/leave in flight)
   * blocks the next connect. The Room itself is dropped by the next (bounded) teardown, never reused.
   */
  private resetConnection(): void {
    this.intentSeq++;
    this.joinSeq++;
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.rejoinWake?.();
    this.rejoinWake = null;
    this.moveIntent = null;
    this.clearMoveTimer();
    this.clearRemoved();
    this.teardownRun = null;
    this.joinReq = null;
    this.leaveReq = null;
    this.attempt = null;
  }

  /** The watchdog's retry: a full reset, the stuck Room dropped (bounded), then an ordinary connect with a fresh Room and /join token. */
  private async restartConnect(roomId: string, workspaceId: string): Promise<void> {
    const call = this.callMode;
    const serverMuted = useVoice.getState().serverMuted;
    this.resetConnection();
    const intent = this.intentSeq;
    await this.teardown(false, true);
    if (intent !== this.intentSeq) return; // the user left or clicked elsewhere meanwhile
    await this.connect(roomId, workspaceId, false, undefined, serverMuted, call, this.nativeCallEvent);
  }

  /**
   * «Переподключение…» for RECONNECT_STUCK_MS: our rejoin cycle at work (its attempts are bounded)
   * or LiveKit still inside its own resume policy → wait; the store behind a connected room → fix
   * it; otherwise a reset and one rejoin with a fresh token, and if that is stuck too, out of voice.
   */
  private onReconnectStuck(ms: number): void {
    const v = useVoice.getState();
    const st = this.seatView().livekit;
    const attempt = this.attempt;
    const verdict = reconnectVerdict({
      loop: this.rejoinRoomId !== null && (attempt === null || Date.now() - attempt.since < RECONNECT_STUCK_MS),
      livekit: st,
      ms,
    });
    if (verdict === 'wait') {
      this.watchdog.rearm();
      return;
    }
    if (verdict === 'connected') {
      log.warn('voice: phase «reconnecting» with a connected room, fixed');
      setVoice({ phase: 'connected' });
      return;
    }
    if (!v.roomId || v.workspaceId === null) return;
    const secs = Math.round(ms / 1000);
    const reason = t('voice.stuck.reconnect');
    if (this.stuckRetries === 0) {
      this.stuckRetries = 1;
      log.warn(`voice: reconnecting to ${v.roomId} for ${secs} s without progress (LiveKit ${st}, stage ${attempt?.stage ?? 'none'}), resetting and rejoining with a fresh token`);
      setLink({ lastError: t('voice.stuck.retry', { reason, s: secs }) });
      this.watchdog.rearm();
      this.resetConnection();
      void this.rejoin(v.roomId, v.workspaceId);
      return;
    }
    this.failStuck(v.roomId, `reconnecting for ${secs} s without progress`, reason);
  }

  /**
   * Settings → Соединение (docs/09 #131): the voice connection as it is — the phase, how long a
   * connect / reconnect has lasted, LiveKit's signalling RTT, the stage a connect is at.
   */
  linkProbe(): { phase: VoicePhase; stuckMs: number | null; rttMs: number | null; stage: ConnectStage | null } {
    const v = useVoice.getState();
    const e = this.watchdog.elapsed();
    const client = (this.room?.engine as { client?: { rtt?: number } } | undefined)?.client;
    const connected = v.phase === 'connected' && this.room?.state === ConnectionState.Connected;
    const rttMs = connected ? client?.rtt || v.rttMs : null;
    return { phase: v.phase, stuckMs: e ? e.ms : null, rttMs: rttMs ?? null, stage: this.attempt?.stage ?? null };
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
    const st = this.nativeAudio?.state?.phase === 'connected' ? ConnectionState.Connected : this.nativeAudio?.state?.phase === 'reconnecting' ? ConnectionState.Reconnecting : room && this.roomId === v.roomId ? room.state : null;
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
        // LiveKit is resuming by itself: a moment for it, then a fresh token instead. Visible, its
        // resume gets up to VISIBLE_RESUME_MS in all (a rejoin starts a new session).
        const room = this.room;
        const native = this.nativeAudio;
        const now = Date.now();
        const grace = seatGraceMs({
          visible: !document.hidden,
          reconnectingVisibleMs: now - Math.max(this.lkReconnectingSince ?? now, this.visibleAt),
          hiddenGraceMs: SEAT_RECONNECT_GRACE_MS,
        });
        await new Promise((r) => setTimeout(r, grace));
        if (((room && this.room === room && room.state !== ConnectionState.Connected) ||
          (native && this.nativeAudio === native && !native.connected)) && !this.rejoinRoomId) {
          log.info(`voice: LiveKit still reconnecting ${Math.round(grace / 1000)} s after the gateway is back, rejoining`);
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
    // A phone call's session (ADR-0117) is not a seat of the server's voice state.
    if (isPhoneRoom(roomId)) {
      this.strayRooms.delete(roomId);
      return;
    }
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
    const room = this.room; const native = this.nativeAudio;
    const same = (): boolean => this.room === room && this.nativeAudio === native && this.roomId === roomId;
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
    const flags = this.selfFlags();
    if (flags.muted || flags.deafened || flags.musician || flags.ptt) this.selfSync.push(flags);
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
      // A call's session (ADR-0034) is not in any workspace's voice list: nothing to compare.
      if (!v.workspaceId) return;
      const me = useSession.getState().me?.user?.id ?? '';
      const shown = useWorkspaces.getState().byId[v.workspaceId]?.voice[me]?.roomId;
      if (v.roomId && shown !== v.roomId && this.room?.state === ConnectionState.Connected) this.checkSeat();
    }, SEAT_SELF_GRACE_MS);
  }

  /**
   * User intent: leave voice (also stops a pending rejoin). `tellServer` false: another tab of
   * this auth session took the voice seat over (#40) — the seat is its now, a /voice/leave
   * would take that tab out.
   */
  async leave(sound = true, tellServer = true): Promise<void> {
    this.clearRemoved();
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
    if (seat && tellServer) this.sendLeave(seat);
  }

  // ------------------------------------------------------------ phone call parks the room (ADR-0133)

  /**
   * The room parked by a phone call: its Room still connected (my seat for the others) with
   * nothing published or subscribed, or only the room to enter after the call (`room` null: its
   * connection was lost, or another room was picked during the call). My mic state before the
   * call comes back with it.
   */
  private parked: {
    room: Room | null;
    roomId: string;
    workspaceId: string;
    joinedAt: number | null;
    muted: boolean;
    deafened: boolean;
    mutedBeforeDeafen: boolean;
    serverMuted: boolean;
  } | null = null;
  /** Rooms whose parked-time listeners are installed (a room may be parked more than once). */
  private readonly parkWatched = new WeakSet<Room>();

  /** The voice session is an inbound phone call's (ADR-0117), also while it is being joined. */
  private onPhoneCall(): boolean {
    const v = useVoice.getState();
    return isPhoneRoom(this.roomId) || isPhoneRoom(v.roomId) || isPhoneRoom(v.joining?.roomId);
  }

  /** The parked Room (read through a call: it changes across awaits). */
  private parkedRoom(): Room | null {
    return this.parked?.room ?? null;
  }

  /** A room is parked (or waits for the end of the phone call). */
  get hasParked(): boolean {
    return this.parked !== null;
  }

  /**
   * «Принять» on a phone call (ADR-0133): the workspace room I am connected to is parked instead
   * of left. Only a web Room of a workspace room that is connected; anything else (a one-to-one
   * call, the native call audio, a connect or reconnect under way, a phone call) returns false
   * and the caller leaves it as before.
   */
  async park(): Promise<boolean> {
    const room = this.room;
    const roomId = this.roomId;
    const v = useVoice.getState();
    if (!room || !roomId || this.nativeAudio || this.callMode || isPhoneRoom(roomId) || !v.workspaceId || v.joining) return false;
    if (v.phase !== 'connected' || room.state !== ConnectionState.Connected || this.teardownRun || this.parked) return false;
    this.clearRemoved();
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.moveIntent = null;
    this.intentSeq++;
    const workspaceId = v.workspaceId;
    this.parked = {
      room,
      roomId,
      workspaceId,
      joinedAt: v.joinedAt,
      muted: v.muted,
      deafened: v.deafened,
      mutedBeforeDeafen: v.mutedBeforeDeafen,
      serverMuted: v.serverMuted,
    };
    this.watchParked(room);
    await this.teardown(false, false, true);
    if (this.parkedRoom() !== room) return true; // dropped meanwhile (removed, room closed)
    setVoice({ parked: { roomId, workspaceId } });
    // The others see me «on the phone» (VoiceState.on_phone): the session is still connected there.
    void api.voice.updateSelf({ onPhone: true }).catch((e: unknown) => log.warn('voice/self failed', e));
    return true;
  }

  /**
   * Nothing sent, nothing received in the parked room (docs/02 «Воспроизведение»: Chromium mixes
   * every subscribed receiver, an element's mute is not enough): every local track unpublished,
   * every remote subscription dropped. Bounded like the rest of the teardown.
   */
  private async silenceParked(room: Room): Promise<void> {
    const lp = room.localParticipant;
    const mine = [...lp.trackPublications.values()].flatMap((pub) => (pub.track ? [pub.track] : []));
    const unpublished = Promise.all(mine.map((tr) => lp.unpublishTrack(tr, false))).then(() => undefined);
    if (!(await settleWithin(unpublished, DISCONNECT_WAIT_MS))) log.warn('voice: unpublishing in the parked room did not settle, going on');
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) if ((pub.subscriptionStatus as string) !== 'unsubscribed') pub.setSubscribed(false);
    }
  }

  /**
   * The parked Room's own events (its wire() handlers are silent while it is not the current
   * room): a moderator removal, a closed room, another tab — out of it, no resume; a network loss
   * LiveKit could not resume — the room is entered again after the call.
   */
  private watchParked(room: Room): void {
    if (this.parkWatched.has(room)) return;
    this.parkWatched.add(room);
    room.on(RoomEvent.Disconnected, (reason) => {
      const p = this.parked;
      if (!p || p.room !== room || reason === DisconnectReason.CLIENT_INITIATED) return;
      log.info('voice: the parked room disconnected, reason', reason ?? 'none');
      const gone =
        reason === DisconnectReason.PARTICIPANT_REMOVED ||
        reason === DisconnectReason.ROOM_DELETED ||
        reason === DisconnectReason.ROOM_CLOSED ||
        reason === DisconnectReason.DUPLICATE_IDENTITY;
      if (gone) this.dropParked(false);
      else p.room = null;
    });
  }

  /** The parked room was moved by a moderator: parked in the target from now on. */
  private parkedMoved(toRoomId: string, workspaceId: string, newConnection: boolean): void {
    const p = this.parked;
    if (!p) return;
    log.info('voice: the parked room was moved', toRoomId);
    if (newConnection && p.room) {
      const old = p.room;
      p.room = null;
      void settleWithin(old.disconnect(), DISCONNECT_WAIT_MS);
    }
    p.roomId = toRoomId;
    p.workspaceId = workspaceId;
    setVoice({ parked: { roomId: toRoomId, workspaceId } });
  }

  /** Another room picked during the phone call: the parked one is left, the new one entered after the call. */
  private parkInstead(roomId: string, workspaceId: string): void {
    const p = this.parked;
    if (!p) return;
    if (p.roomId !== roomId) {
      this.dropParked(true);
      this.parked = { ...p, room: null, roomId, workspaceId, joinedAt: null };
      setVoice({ parked: { roomId, workspaceId } });
    }
    toast.info(t('call.sipParkedAfter'));
  }

  /** Out of the parked room (its connection and its seat); the phone call goes on. */
  leaveParked(): void {
    this.dropParked(true);
  }

  private dropParked(tellServer: boolean): void {
    const p = this.parked;
    if (!p) return;
    this.parked = null;
    setVoice({ parked: null });
    if (!p.room) return;
    void settleWithin(p.room.disconnect(), DISCONNECT_WAIT_MS);
    if (tellServer) this.sendLeave(p.roomId);
  }

  /**
   * The phone call ended (ADR-0133): the parked Room becomes the current one again — the
   * subscriptions follow the usual rules, the mic is published with my state from before the
   * call; no reconnect. A lost connection (or a room picked during the call) is joined anew.
   */
  async resumeParked(): Promise<void> {
    const p = this.parked;
    if (!p) return;
    this.parked = null;
    setVoice({ parked: null });
    // The phone session's teardown resets the store: it goes first.
    while (this.teardownRun) {
      const run = this.teardownRun;
      if (!(await settleWithin(run, TEARDOWN_WAIT_MS)) && this.teardownRun === run) this.teardownRun = null;
    }
    const v = useVoice.getState();
    const room = p.room;
    // Something else started meanwhile (a join, a call): the parked room goes.
    if (this.room || this.nativeAudio || v.joining || v.roomId) {
      if (room) {
        void settleWithin(room.disconnect(), DISCONNECT_WAIT_MS);
        this.sendLeave(p.roomId);
      }
      return;
    }
    setVoice({ muted: p.muted, deafened: p.deafened, mutedBeforeDeafen: p.mutedBeforeDeafen });
    const live = room !== null && (room.state === ConnectionState.Connected || room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting);
    if (!room || !live) {
      if (room) await settleWithin(room.disconnect(), DISCONNECT_WAIT_MS);
      await this.join(p.roomId, p.workspaceId, { resumed: true });
      return;
    }
    this.intentSeq++;
    const seq = ++this.joinSeq;
    this.room = room;
    this.roomId = p.roomId;
    this.setCallMode(false);
    this.echoToasted = false;
    const sv = useWorkspaces.getState().byId[p.workspaceId]?.voice[this.myId()];
    const perm = room.localParticipant.permissions;
    const canSpeak = perm ? canSpeakFrom(perm) : true;
    setVoice({
      roomId: p.roomId,
      workspaceId: p.workspaceId,
      joinedAt: p.joinedAt ?? Date.now(),
      joining: null,
      phase: room.state === ConnectionState.Connected ? 'connected' : 'reconnecting',
      error: null,
      canSpeak,
      serverMuted: sv?.serverMuted ?? p.serverMuted,
    });
    this.refreshRights();
    for (const rp of room.remoteParticipants.values()) for (const pub of rp.trackPublications.values()) this.onPublished(pub);
    if (canSpeak) {
      await this.ensureMic();
      if (seq !== this.joinSeq || this.room !== room) return;
      await this.publishMic();
      if (seq !== this.joinSeq || this.room !== room) return;
    }
    this.startStats();
    this.pushSelfState({ onPhone: false });
    this.refreshStreams();
    this.refreshCameras();
    this.camerasPrimed = true;
    playSound('reconnect');
    this.syncTray();
  }

  // ------------------------------------------------------------ tabs of one browser (#40)

  private tabChannel: BroadcastChannel | null = null;
  /** This tab's last join intent, broadcast to the other tabs (lib/voiceTabs). */
  private tabClaim: VoiceClaim | null = null;

  private announceJoin(): void {
    const ch = this.tabChannel;
    const session = useSession.getState().sessionId;
    if (!ch || !session) return;
    this.tabClaim = { session, at: Date.now(), nonce: Math.random().toString(36).slice(2) };
    try {
      ch.postMessage(this.tabClaim);
    } catch (e) {
      log.warn('voice: tab claim not sent', e);
    }
  }

  /** Another tab of this auth session joined voice: let go here without telling the server. */
  private onOtherTabJoin(data: unknown): void {
    const other = parseClaim(data);
    if (!other || !yieldsTo(useSession.getState().sessionId, this.tabClaim, other)) return;
    const v = useVoice.getState();
    const room = this.roomId ?? v.roomId ?? v.joining?.roomId ?? this.rejoinRoomId;
    if (!room && !this.room) return;
    log.info('voice: another tab of this session joined voice, leaving here');
    this.tabClaim = null;
    // The seat is the other tab's now (same LiveKit identity): a parked room must not come
    // back here when the phone session below ends (ADR-0133).
    this.dropParked(false);
    this.takenOverRoom = room; // a one-to-one call goes on in the other tab (services/call.ts)
    toast.info(t('mediaErr.voice.duplicate'));
    void this.leave(false, false);
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
    // An inbound phone call's session (ADR-0117): the accept's token once, then a fresh one
    // for each reconnect — never the room /join.
    // A personal call (ADR-0137 §3) has only the token its POST gave (kept for the call's life).
    const pre = isPhoneRoom(roomId) ? takePhoneJoin(roomId) : undefined;
    const req = isPhoneRoom(roomId)
      ? pre
        ? Promise.resolve(pre)
        : isPersonalRoom(roomId)
          ? Promise.reject(new ApiError('ERROR_CODE_NOT_FOUND', 'the personal call is over', 404))
          : api.sip.joinInbound(phoneCallId(roomId))
      : api.voice.join(roomId);
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
    if (isPhoneRoom(roomId)) return; // the phone call hangs up by services/sipInbound.ts
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

  /**
   * `keepSeat`: a reconnect — the store keeps room, workspace, phase and the moderator mute.
   * `park`: a phone call parks the room (ADR-0133) — the Room stays connected with nothing
   * published or subscribed instead of being disconnected.
   */
  private teardown(sound: boolean, keepSeat = false, park = false): Promise<void> {
    const run = this.doTeardown(sound, keepSeat, park);
    this.teardownRun = run;
    const done = (): void => {
      if (this.teardownRun === run) this.teardownRun = null;
    };
    run.then(done, done);
    return run;
  }

  private async doTeardown(sound: boolean, keepSeat: boolean, park = false): Promise<void> {
    this.joinSeq++;
    this.nativeAudio?.stop(); this.nativeAudio = null;
    this.endPttTail();
    this.resetSpeaking();
    this.active.reset();
    lastSpoke.clear();
    this.clearMoveTimer();
    this.stopStats();
    this.resetEcho();
    // Bounded (docs/09 #131): unpublishing over a dead link must not hold up the next connect.
    if (!(await settleWithin(this.stopStream(false), STOP_STREAM_WAIT_MS))) log.warn(`voice: stopping the stream took over ${STOP_STREAM_WAIT_MS} ms, going on`);
    const room = this.room;
    const micTrack = this.micTrack;
    this.room = null;
    this.roomId = null;
    this.micTrack = null;
    this.autoMute.cancel(); // left: no timer outside voice
    this.clearMuteRetry();
    this.setTrackLag(false);
    if (!keepSeat && !park) this.selfSync.stop(); // out of voice: nothing to converge
    // disconnect(false): unpublish without stopping. disconnect(true) would stop the pipeline's
    // publish track, and a running mic test keeps that pipeline for the next call → a dead
    // mic there (review M1). The pipeline is stopped below when nobody needs it.
    // Bounded (docs/09 #131): a half-open signalling socket may never let disconnect() settle;
    // the room's events are already ignored (this.room !== room, see wire()).
    if (room && park) await this.silenceParked(room);
    else if (room && !(await settleWithin(room.disconnect(false), DISCONNECT_WAIT_MS))) log.warn(`voice: room.disconnect() did not settle in ${DISCONNECT_WAIT_MS} ms, dropped`);
    this.camera.onLeave();
    if (!this.micTesting) {
      micTrack?.stop();
      this.stopMicPipeline();
    }
    for (const el of this.audioOut.clear()) el.remove();
    this.resetRecovery(keepSeat || park);
    this.viewers.clear();
    this.wanted.clear();
    this.announced = null;
    annot.detach();
    if (!keepSeat) this.setCallMode(false);
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
      galleryPage: 0,
      quality: 'unknown',
      rttMs: null,
      lossPct: null,
      stats: null,
    });
    // My own leave / hang-up: the heavier «disconnect» cue (others leaving play «leave»).
    if (sound && room && !this.cuesQuiet()) playSound('disconnect');
    this.syncTray();
  }

  private wire(room: Room): void {
    // Every event of a room that is no longer ours (switched, left, torn down) is dropped here
    // (docs/09 #131): a late Disconnected / ConnectionStateChanged / TrackUnsubscribed of the old
    // room must never write into the new room's state.
    const guarded: GuardedRoom = {
      on: (ev, fn) => {
        room.on(ev, (...a: unknown[]) => {
          if (this.room === room) (fn as (...x: unknown[]) => void)(...a);
        });
        return guarded;
      },
    };
    guarded
      .on(RoomEvent.ConnectionStateChanged, (st) => {
        if (this.room !== room) return;
        const was = useVoice.getState().phase;
        if (st === ConnectionState.Reconnecting || st === ConnectionState.SignalReconnecting) {
          this.lkReconnectingSince ??= Date.now();
          if (was === 'connected' && !this.cuesQuiet()) playSound('disconnect');
          setVoice({ phase: 'reconnecting' });
        } else if (st === ConnectionState.Connected) {
          this.lkReconnectingSince = null;
          if (was === 'reconnecting' && !this.cuesQuiet()) playSound('reconnect');
          setVoice({ phase: 'connected' });
          setLink({ attempts: 0, blockedHost: null });
        }
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.room !== room) return;
        log.info('voice disconnected, reason', reason ?? 'none');
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
          // A moderator, or the user joined voice on another device: then VOICE_DISCONNECTED
          // (sent before the removal) decides the toast and keeps a call going — wait for it.
          const ws = useVoice.getState().workspaceId;
          const text = ws && useWorkspaces.getState().byId[ws]?.ws.suspension ? t('suspended.kicked') : t('mediaErr.voice.kicked');
          this.clearRemoved();
          this.removed = {
            roomId: this.roomId,
            timer: window.setTimeout(() => {
              this.removed = null;
              if (this.room !== room) return; // a newer join / leave took over meanwhile
              toast.info(text);
              void this.leave();
            }, REMOVED_GRACE_MS),
          };
          return;
        }
        else if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
          // Another tab / window of this auth session connected with the same identity (#40):
          // the seat is its now — leave locally, a /voice/leave would take that one out.
          toast.info(t('mediaErr.voice.duplicate'));
          this.takenOverRoom = this.roomId;
          void this.leave(true, false);
          return;
        }
        else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) {
          // A temporary room closed (ADR-0044): the same «Комната закрыта» as its ROOM_DELETE, once.
          if (this.roomId && isTempRoom(useRooms.getState().byId[this.roomId])) roomClosedToast(this.roomId);
          else toast.info(t('mediaErr.voice.closed'));
        }
        else if (reason !== DisconnectReason.CLIENT_INITIATED) {
          setLink({ lastError: describeDisconnect(reason === undefined ? undefined : DisconnectReason[reason]) });
          // A connect that never got in: livekit-client emits Disconnected right before
          // room.connect() rejects, and connect()'s own failure path handles it (a rejoin attempt
          // counts it and backs off; a user join reports it). A new cycle from here restarted the
          // backoff at 1 s on every failure: /join every ~1.2 s for minutes, never the «lost» exit (#255).
          if (!this.reachedConnected.has(room) || this.rejoinRoomId !== null) return;
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
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        // A participant leaving unpublishes after LiveKit dropped them from the room: «leave» covers it.
        if (pub.source === Track.Source.ScreenShare && room.remoteParticipants.has(p.identity)) playSound('streamEnd');
        this.refreshStreams();
        this.refreshCameras();
      })
      // Full reconnect (a new LiveKit session): bring the camera back (services/camera.ts restore).
      // The mic and my flags are re-asserted too (ADR-0134): a toggle made while the link was
      // down may not have reached LiveKit or the server.
      .on(RoomEvent.Reconnected, () => {
        if (this.room !== room) return;
        void this.camera.restore();
        this.clearMuteRetry();
        this.applyTransmit();
        this.pushSelfState();
        this.afterLinkBack('reconnected');
      })
      // Autoplay refused the remote audio (no gesture yet: a reload, the iOS shell, a page back
      // from the background): «Вы не слышите собеседников» until a tap runs room.startAudio().
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.onPlaybackStatus(room))
      .on(RoomEvent.TrackSubscriptionFailed, (sid) => {
        log.info(`voice: subscription to ${sid} failed`);
        this.scheduleAudioCheck('subscription failed');
      })
      // LiveKit switched the remote audio output itself (a device appeared / went away): its
      // setSinkId hit our elements — put our sink and the playback state (deafen) back.
      .on(RoomEvent.ActiveDeviceChanged, (kind) => {
        if (this.room === room && kind === 'audiooutput') void this.applyOutputDevice();
      })
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (p !== room.localParticipant && pub.source === Track.Source.Camera) this.refreshCameras();
      })
      // A full reconnect republishes my stream under a new track sid (issue #102): viewers,
      // annotations and my stream's entry follow it. The first publish is not this: `this.screen`
      // is set only after it.
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (this.room === room && pub.source === Track.Source.ScreenShare && this.screen && pub.track === this.screen.video) this.screenRepublished(pub.trackSid);
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
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.peerCue(room, userIdOf(p.identity), true);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        const gone = userIdOf(p.identity);
        const still = [...room.remoteParticipants.values()].some((o) => userIdOf(o.identity) === gone);
        if (!still) this.active.drop(gone);
        if (!still) this.peerCue(room, gone, false);
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
        lastSpoke.clear();
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
    // Deafened: not even subscribed (applyAudioSubscriptions); undeafen subscribes it.
    if (pub.source === Track.Source.Microphone) {
      if (!useVoice.getState().deafened) pub.setSubscribed(true);
    } else if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) this.applyWatching();
    else if (pub.source === Track.Source.Camera) this.applyCameras();
  }

  /**
   * Deafened = no remote audio is received at all (docs/02 «Deafen»): every mic and stream-audio
   * subscription is dropped; undeafen takes them back (one signalling round trip). Muting the
   * elements (RemoteAudioOut) stays the instant layer, but it is not enough on its own: Chromium
   * mixes every remote WebRTC audio receiver into one output (WebRtcAudioRenderer) and an
   * element's mute zeroes only the receivers that element plays — a receiver no element has
   * played yet is at full gain, and LiveKit has paths where a subscribed track gets no element
   * (TrackSubscribed deferred while Reconnecting, publication not found → TrackSubscriptionFailed).
   * Unsubscribed, the SFU sends nothing: nothing to leak, and no Opus decode or traffic either.
   */
  private applyAudioSubscriptions(): void {
    const room = this.room;
    if (!room) return;
    const on = !useVoice.getState().deafened;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) if (pub.source === Track.Source.Microphone) pub.setSubscribed(on);
    }
    this.applyWatching(); // the watched stream's own audio
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
      if (audio) this.subscribe(audio, on && !useVoice.getState().deafened);
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

  /** Speaking rings now; the active speaker for video only after 800 ms of speech (lib/activeSpeaker.ts). */
  private syncSpeaking(): void {
    const local = this.room?.localParticipant.identity ?? null;
    const me = this.myId() || null;
    // PTT: my ring is the gate itself (the release tail already applied) — off at once, without
    // the speaking hold. VAD keeps the hold: the gate flaps between words.
    const instantOff = me && this.micMode() === 'ptt' && !this.selfSpeaking ? new Set([me]) : undefined;
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

  /**
   * The auto-mute timer follows my mic (lib/autoMute.ts): armed while a published mic is open in
   * voice activation; my local VAD (`selfSpeaking`, the ring's own signal) resets it. The native
   * call audio has no local VAD here — never armed there.
   */
  private syncAutoMute(): void {
    this.autoMute.update(this.autoMuteArmed(), this.selfSpeaking, prefs().autoMuteSec);
  }

  private autoMuteArmed(): boolean {
    const v = useVoice.getState();
    const live = this.room !== null && this.micTrack !== null && this.nativeAudio === null;
    return autoMuteArmed({ live, mode: this.micMode(), muted: v.muted, deafened: v.deafened, serverMuted: v.serverMuted, canSpeak: v.canSpeak });
  }

  /** Silent for the whole period: mute like the button (sound, voice-state), say why, offer to undo. */
  private onAutoMute(sec: Exclude<AutoMuteSec, 0>): void {
    if (this.selfSpeaking || !this.autoMuteArmed()) return;
    log.info(`voice: auto-mute after ${sec} s of silence`);
    this.toggleMute();
    const room = this.room;
    useToasts.getState().push('info', t(AUTO_MUTE_TOAST[sec]), {
      label: t('autoMute.unmute'),
      run: () => {
        // Still in that call and still muted by us (not deafened since): turn the mic back on.
        const s = useVoice.getState();
        if (this.room === room && s.muted && !s.deafened && !s.serverMuted) this.toggleMute();
      },
    });
  }

  private resetSpeaking(): void {
    this.remoteSpeakers = [];
    this.stopLevelSpeaking();
    this.levelSpeakers.reset();
    this.selfSpeaking = false;
    this.speakers.reset();
  }

  private onSpeaking(speaking: Record<string, boolean>): void {
    // «Last spoke at» for the call grid (ADR-0066 §2): speaking starts only, outside the store.
    const starts = speakingStarts(useVoice.getState().speaking, speaking);
    setVoice({ speaking });
    lastSpoke.mark(starts, performance.now());
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
    // The first remote camera of the call turned on (not the ones already on when I joined).
    const first = cameras[0];
    if (this.camerasPrimed && st.cameras.length === 0 && first && st.stage === 'pip' && !st.watching) this.firstCamera(first.userId);
    this.applyCameras();
  }

  /**
   * ADR-0066 §3: the first remote camera turned on while the call view is closed. A (nearly) empty
   * chat — the same rule as a new stream (defaultStage) — opens the view; a busy one gets a toast
   * «Анна: включена камера · Смотреть».
   */
  private firstCamera(userId: string): void {
    const { roomId, workspaceId } = useVoice.getState();
    if (!roomId) return;
    if (defaultStage(roomId) === 'expanded') {
      setVoice({ stage: 'expanded', videoPip: true });
      this.applyWatching();
      return;
    }
    const name = memberName(workspaceId, userId);
    useToasts.getState().push('info', t('video.cameraOnToast', { name }), {
      label: t('video.watchAction'),
      run: () => {
        if (useVoice.getState().roomId !== roomId) return;
        if (workspaceId) useUi.getState().openRoom(workspaceId, roomId);
        this.showVideo();
      },
    });
  }

  /** Others' join/leave cue: only while the room with that person has ≤ join_leave_sound_max people. */
  private joinLeaveCue(room: Room, who: string): boolean {
    const max = joinLeaveSoundMax(this.roomId ? useRooms.getState().byId[this.roomId]?.media : undefined);
    if (max <= 0) return false;
    const others = Array.from(room.remoteParticipants.values(), (o) => userIdOf(o.identity));
    return joinLeaveCue(others, who, userIdOf(room.localParticipant.identity), max);
  }

  /** Whose LiveKit connection went while the server keeps their seat (ADR-0150), per room. */
  private seatCues = new SeatCues();
  private seatCuesRoom: Room | null = null;
  private seatCuesOff: (() => void) | null = null;

  /**
   * Someone's (last) LiveKit connection in my room appeared or went: the cue follows the server's
   * seat (ADR-0150, SeatCues) — no «leave» while the seat is kept after a lost connection, no
   * «join» when they come back to it, «leave» when the server removes it.
   */
  private peerCue(room: Room, who: string, joined: boolean): void {
    if (this.seatCuesRoom !== room) this.resetSeatCues(room);
    const seat = this.seatOf(who);
    const due = joined ? this.seatCues.connected(who, seat) : this.seatCues.disconnected(who, seat);
    if (due && this.joinLeaveCue(room, who)) playSound(joined ? 'join' : 'leave');
    this.watchSeats();
  }

  /** The server's seat of `who` in my voice room (a DM call has no per-user seats here: gone). */
  private seatOf(who: string): SeatVerdict {
    const { workspaceId, roomId } = useVoice.getState();
    const v = workspaceId && roomId ? useWorkspaces.getState().byId[workspaceId]?.voice[who] : undefined;
    if (!v || v.roomId !== roomId) return 'gone';
    return v.connectionLost ? 'lost' : 'present';
  }

  /** Follows the voice states only while someone's seat awaits the server's word: no timer. */
  private watchSeats(): void {
    if (this.seatCues.size === 0) {
      this.seatCuesOff?.();
      this.seatCuesOff = null;
      return;
    }
    if (this.seatCuesOff) return;
    this.seatCuesOff = useWorkspaces.subscribe((s, prev) => {
      const ws = useVoice.getState().workspaceId;
      if (!ws || s.byId[ws]?.voice === prev.byId[ws]?.voice) return;
      const room = this.seatCuesRoom;
      if (!room || room !== this.room) {
        this.resetSeatCues(null);
        return;
      }
      for (const who of this.seatCues.settle((id) => this.seatOf(id))) {
        if (this.joinLeaveCue(room, who)) playSound('leave');
      }
      if (this.seatCues.size === 0) this.watchSeats();
    });
  }

  private resetSeatCues(room: Room | null): void {
    this.seatCues.clear();
    this.seatCuesRoom = room;
    this.seatCuesOff?.();
    this.seatCuesOff = null;
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
    const shown = this.shownCams.ids();
    const wanted = cameraWanted(useVoice.getState().cameras.map((c) => c.userId), { hidden: p.hiddenVideo, saveTraffic: p.saveTraffic, primary: this.primaryCamera(), me: this.myId(), shown });
    for (const rp of room.remoteParticipants.values()) {
      const pub = rp.getTrackPublication(Track.Source.Camera);
      if (!pub) continue;
      const userId = userIdOf(rp.identity);
      const on = wanted.has(userId) && !pub.isMuted;
      this.subscribe(pub, on);
      // A 16+ gallery page asks for 360p at most (ADR-0066 §4); adaptive stream picks below the cap.
      if (on) pub.setVideoQuality(p.saveTraffic || this.shownCams.quality(userId) === 'medium' ? VideoQuality.MEDIUM : VideoQuality.HIGH);
    }
  }

  /**
   * A camera <video> of `userId` is on screen (lib/media/cameraShown.ts): subscribe to it at most
   * at `quality`. Call the returned function when the element goes; the subscription lingers 3 s.
   */
  showCamera(userId: string, quality: ShownQuality): () => void {
    return this.shownCams.claim(userId, quality);
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
    this.pinTile(focusedTile);
  }

  /**
   * Pin `userId` (no toggle) and open the call view: large in «Спикер», first on page 1 in the
   * gallery (ADR-0066 §1). Also the sidebar's camera icon (§3).
   */
  pinTile(userId: string | null): void {
    setVoice({ focusedTile: userId, watching: null, stage: 'expanded', ...(userId !== null ? { galleryPage: 0, videoPip: true } : {}) });
    this.applyWatching();
    this.applyCameras();
  }

  /** Gallery page flip (clamped by the view; subscriptions follow the tiles with a 3 s linger). */
  setGalleryPage(page: number): void {
    if (useVoice.getState().galleryPage !== page) setVoice({ galleryPage: Math.max(0, page) });
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
    // LiveKit detaches the track before TrackUnsubscribed (RemoteTrackPublication.setTrack), so
    // track.detach() is usually empty here: our element is the one registered for the sid.
    if (track.sid) this.audioOut.remove(track.sid)?.remove();
    for (const el of track.detach()) el.remove();
  }

  private nativeControls(): HostAudioControls {
    const v = useVoice.getState(); const p = prefs();
    const call = useCall.getState().call;
    const ids = call ? [call.callerId, call.calleeId] : [];
    const userVolumes = Object.fromEntries(ids.filter(audioUUID).map(id => {
      const audio = remoteAudio({ ...p, deafened: v.deafened, userId: id, stream: false, streamVolume: {} });
      return [id, audio.muted ? 0 : audio.volume];
    }));
    return { muted: v.muted || v.serverMuted, deafened: v.deafened, volume: Math.max(0,Math.min(1,p.outputVolume)), userVolumes };
  }

  private applyVolumes(): void {
    this.nativeAudio?.control(this.nativeControls());
    this.audioOut.applyAll();
  }

  /** Remote output routes run one at a time, each after the device snapshot queued before it. */
  private outputOps: Promise<void> = Promise.resolve();

  /** The sink remote voices use now: the chosen device while present, else the default (CBF-108). */
  private outputSinkNow(): string {
    return outputSink(this.devices, prefs().outputDeviceId);
  }

  /**
   * Echo rule 2: switch output with setSinkId on the same <audio> elements (and re-apply deafen).
   * LiveKit is told the same id: it re-applies its own to every new remote track, and in
   * Chromium one element's setSinkId moves all remote voices (lib/media/outputRoute).
   */
  private applyOutputDevice(): Promise<void> {
    const run = this.outputOps.then(() => this.devicesOps).then(async () => {
      const sink = this.outputSinkNow();
      await this.audioOut.setSink(sink);
      const room = this.room;
      // WebKit without element setSinkId: LiveKit refuses the switch (the OS picks the output there).
      if (typeof HTMLMediaElement !== 'undefined' && !('setSinkId' in HTMLMediaElement.prototype)) return;
      if (!room || !livekitOutputStale(sink, room.options.audioOutput?.deviceId, room.getActiveDevice('audiooutput'))) return;
      // Its setSinkId on our elements is a no-op now (same id); ActiveDeviceChanged comes back here, in sync.
      await room.switchActiveDevice('audiooutput', sink).catch((e: unknown) => log.warn('voice: LiveKit output switch failed', e));
    });
    this.outputOps = run.catch(() => undefined);
    return this.outputOps;
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
    if (this.nativeAudio) return; // Native CallKit audio is the sole capture owner.
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
    mic.setDenoise(denoiseMode({ onAir: d.audioEnabled, meter: this.meterShown(), micMode: this.micMode(), muted: d.livekitMuted }), wakeDbFor(p.thresholdDb));
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
      // An input / camera change leaves the remote renderers alone (CBF-108).
      if (announce && outputsChanged(prev, next)) this.scheduleRebind();
      if (!announce || !prev || !this.roomId) return;
      const p = prefs();
      for (const sw of deviceSwitches(prev, next, { micDeviceId: p.micDeviceId, outputDeviceId: p.outputDeviceId })) announceDeviceSwitch(sw);
    });
  }

  private queueMic<T>(op: () => Promise<T>): Promise<T> {
    const run = this.micOps.then(op);
    this.micOps = run.then(
      () => undefined,
      () => undefined,
    );
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
      musician: p.musicianMode,
      duckable: duckable(p.echoMode),
      onReport: (r: MicReport) => this.onMicReport(r),
      // Capture ended by the OS (device unplugged): rebuild, falling back to the default device.
      onEnded: () => {
        if (built !== null && built === this.mic) this.onMicLost();
      },
      // Another app / an interruption holds the mic, the system suspended the context.
      onMute: (muted: boolean) => {
        if (built !== null && built === this.mic) this.onMicMute(muted);
      },
      onContextState: (state: string) => {
        if (built !== null && built === this.mic) this.onMicContext(state);
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
    // The capture opened on the headset the voices play to: re-bind them once its route settled.
    if (this.room && captureOnOutputHeadset(this.devices, built.deviceLabel, this.outputSinkNow())) this.scheduleRebind(HEADSET_ROUTE_SETTLE_MS);
    // Capture permission reveals device labels: the list the next change is diffed against needs them.
    this.snapshotDevices(false, true);
    this.gate.reset();
    setVoice({ micError: null, micErrorAction: null });
    return built;
  }

  private onMicLost(): void {
    this.micLost = true;
    if (!this.canCapture()) {
      // WebKit would queue the capture until the page is visible: the visible check restarts it.
      log.info('mic capture ended while the page is hidden, restarting it when visible');
      return;
    }
    log.warn('mic capture ended (device lost?), restarting');
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

  /**
   * Device or RNNoise changed / device lost / the capture broken: rebuild capture, swap
   * the published track in place. 'skipped': nothing to restart, or left / replaced meanwhile.
   */
  /** `quiet`: the automatic mic check, whose failure the panel header reports («Вас не слышно»), not the error line. */
  private restartMic(quiet = false): Promise<'ok' | 'failed' | 'skipped'> {
    return this.queueMic(async () => {
      const old = this.mic;
      if (!old) return 'skipped';
      let next: MicPipeline | null = null;
      try {
        next = await this.buildMic();
        // Stopped (left the call / test) or replaced meanwhile: never keep an orphan capture.
        if (this.mic !== old || !this.micWanted()) {
          next.stop();
          return 'skipped';
        }
        const t = this.micTrack;
        if (t) {
          next.track.enabled = !t.isMuted && this.gateWantsAudio();
          await t.replaceTrack(next.track, { userProvidedTrack: true });
          // LiveKit's replaceTrack re-syncs `enabled` with its own mute only (`!isMuted`), so with
          // the PTT key up / the VAD gate closed the new capture went on air (musician-mode leak,
          // 4.3.0). Re-close it at once, in the same task; applyTransmit below settles the rest.
          next.track.enabled = !t.isMuted && this.gateWantsAudio();
          if (this.mic !== old || !this.micWanted()) {
            next.stop(); // torn down while the track was being swapped
            return 'skipped';
          }
        }
        // Only now is `next` the live capture: a failed swap keeps `old` (still published)
        // and drops `next`, so neither capture leaks (review N4).
        this.mic = next;
        old.stop();
        // Invariant: every capture swap ends with the transmit decision applied to the live
        // track (gate, PTT, explicit mute; ADR-0134 convergence) — and denoise with it.
        this.applyTransmit();
        log.info('[mic] capture restarted');
        return 'ok';
      } catch (err) {
        if (next && this.mic !== next) next.stop();
        log.warn('[mic] capture restart failed', err);
        if (!quiet) {
          const h = humanMediaError(err, 'mic');
          setVoice({ micError: h.text, micErrorAction: h.action });
        }
        return 'failed';
      }
    });
  }

  /** The tier the mic publishes at: the room's, capped by the personal limit (UserSettings.audio_bitrate_kbps). */
  private micTier(): OpusTier {
    if (prefs().musicianMode) {
      const ws = useVoice.getState().workspaceId;
      const planMax = ws ? useWorkspaces.getState().byId[ws]?.ws.plan?.limits?.audioTierMaxKbps : undefined;
      return musicTier(this.mic?.channels ?? 1, planMax);
    }
    return micTier(this.audioBitrateKbps, prefs().personalBitrateKbps);
  }

  /**
   * Musician mode off when the call ends (`left`) or the voice room's plan does not include it
   * (joined / moved into a Free workspace's room, the plan changed). Free when the mode is off.
   */
  private guardMusician(left: boolean): void {
    if (!prefs().musicianMode) return;
    if (left) {
      usePrefs.getState().setPrefs({ musicianMode: false });
      return;
    }
    if (!useVoice.getState().roomId || musicianAllowed()) return;
    usePrefs.getState().setPrefs({ musicianMode: false });
    musicianLockedToast();
  }

  /**
   * Musician mode flipped (ADR-0052), live: the capture is rebuilt without / with speech
   * processing and swapped in place (restartMic → replaceTrack), then the Opus profile follows
   * (applyMicTier: bitrate, and DTX / stereo / bandwidth through a renegotiation) — both queued in
   * this order, so the profile reads the new capture's channels. The gate, the others' indicator
   * and the echo judgement follow at once.
   */
  private onMusicianMode(on: boolean): void {
    if (this.mic) void this.restartMic();
    this.applyMicTier();
    this.resetEcho(); // no AEC now (or again): the acoustic path changed
    if (on) this.echoToasted = false; // echo without AEC deserves its own warning
    this.applyTransmit();
    this.pushSelfState();
  }

  /**
   * The room tier or the personal cap changed: re-apply to the published mic in place (bitrate via
   * setParameters, bandwidth / FEC via a renegotiation, lib/media/opusTierPublish.ts). Not
   * published (listen-only, muted before the first publish): the next publish reads the tier.
   */
  private applyMicTier(): void {
    void this.queueMic(async () => {
      const room = this.room;
      const sender = this.micTrack?.sender;
      if (!room || !sender) return;
      try {
        await applyMicTier(room, sender, this.micTier());
      } catch (e) {
        log.warn('voice tier: live apply failed', e);
      }
    });
  }

  private micPublishOptions(): TrackPublishOptions {
    return {
      source: Track.Source.Microphone,
      // AUDIO_PUBLISH_DEFAULTS.dtx for voice; musician mode publishes without DTX (the answer's
      // `usedtx` follows the tier too, opusTier.ts).
      dtx: this.micTier().dtx,
      red: prefs().red,
      forceStereo: false,
      // The tier's bitrate; its bandwidth / FEC come with the answer (installOpusTierHook).
      audioPreset: { maxBitrate: this.micTier().kbps * 1000 },
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

  /** RED is negotiated at publish time → republish the same track. */
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
    if (open !== wasOpen && this.micMode() === 'voice') this.applyTransmit();
  }

  private decision(): ReturnType<typeof transmitDecision> {
    const v = useVoice.getState();
    return transmitDecision({
      muted: v.muted,
      deafened: v.deafened,
      canSpeak: v.canSpeak,
      mode: this.micMode(),
      gateOpen: this.gate.open,
      pttDown: v.pttDown,
      musician: prefs().musicianMode,
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
    if (this.nativeAudio) { this.autoMute.cancel(); this.nativeAudio.control(this.nativeControls()); return; }
    const t = this.micTrack;
    const d = this.decision();
    // Closing is the latency-critical edge (PTT key-up): silence the sender first, synchronously —
    // before the store / ring / duck updates and regardless of an in-flight LiveKit mute op
    // (a finishing unmute() re-enables the track, then `finally` re-applies this decision).
    if (t && !d.audioEnabled) t.mediaStreamTrack.enabled = false;
    this.applyDenoise(d);
    this.applyDuck(); // PTT pressed / deafen: the duck follows at once, not at the next level tick
    setVoice({ transmitting: d.transmitting && t !== null });
    this.setSelfSpeaking(d.speaking && t !== null);
    this.syncAutoMute();
    if (!t) return;
    // `isMuted` flips only after LiveKit's async mute lock: while a mute/unmute is in flight,
    // wait for it and re-evaluate, so mute→unmute in quick succession ends in the state the
    // UI shows (review L2).
    if (this.muteOp) return;
    if (d.livekitMuted !== t.isMuted) {
      // A failed op is retried by its timer (ADR-0134), not by every gate / key event.
      if (this.muteRetryTimer !== null) return;
      if (d.livekitMuted) this.selfMuting = true;
      this.armTrackLag();
      let failed = false;
      this.muteOp = rejectAfter(d.livekitMuted ? t.mute() : t.unmute(), MUTE_OP_TIMEOUT_MS)
        .then(
          () => {
            this.muteFails = 0;
          },
          (e: unknown) => {
            failed = true;
            this.muteFails++;
            log.warn('mic mute/unmute failed', e);
          },
        )
        .finally(() => {
          this.muteOp = null;
          this.selfMuting = false;
          if (this.micTrack !== t) return;
          if (!failed) {
            this.applyTransmit();
            return;
          }
          const delay = MUTE_RETRY_MS[Math.min(this.muteFails - 1, MUTE_RETRY_MS.length - 1)];
          this.muteRetryTimer = window.setTimeout(() => {
            this.muteRetryTimer = null;
            if (this.micTrack === t) this.applyTransmit();
          }, delay);
        });
      return;
    }
    // Converged: the track carries the intent.
    this.clearMuteRetry();
    this.muteFails = 0;
    this.setTrackLag(false);
    if (!t.isMuted) t.mediaStreamTrack.enabled = d.audioEnabled;
  }

  private clearMuteRetry(): void {
    if (this.muteRetryTimer !== null) window.clearTimeout(this.muteRetryTimer);
    this.muteRetryTimer = null;
  }

  private armTrackLag(): void {
    if (this.trackLag || this.trackLagTimer !== null) return;
    this.trackLagTimer = window.setTimeout(() => {
      this.trackLagTimer = null;
      const t = this.micTrack;
      if (t && this.decision().livekitMuted !== t.isMuted) this.setTrackLag(true);
    }, SELF_SYNC_LAG_MS);
  }

  private setTrackLag(on: boolean): void {
    if (!on && this.trackLagTimer !== null) {
      window.clearTimeout(this.trackLagTimer);
      this.trackLagTimer = null;
    }
    if (this.trackLag === on) return;
    this.trackLag = on;
    this.syncLag();
  }

  /** One flag for the UI (ADR-0134): the track or the server still lags my intent. */
  private syncLag(): void {
    const lag = this.trackLag || this.serverLag;
    if (useVoice.getState().micSyncLag !== lag) setVoice({ micSyncLag: lag });
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
    // A call is voice activation only (ADR-0034): the key (still bound a moment) does nothing.
    if (this.callMode) return;
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
    // Never on the phone: the hold button gives a haptic, and the cue is a separate device-local setting.
    if (cue && !isMobileNow()) playSound(cue);
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
   * The room this device was taken out of for another device of the user (VOICE_DISCONNECTED),
   * until the next join: services/call.ts lets go of a call there without hanging it up.
   */
  takenOverRoom: string | null = null;

  /** LiveKit removed this device; the moderator toast and leave wait REMOVED_GRACE_MS. */
  private removed: { roomId: string | null; timer: number } | null = null;

  private clearRemoved(): void {
    if (this.removed) window.clearTimeout(this.removed.timer);
    this.removed = null;
  }

  /**
   * Gateway VOICE_DISCONNECTED (docs/05 «Несколько устройств»): the server took this device out
   * of voice — the user joined from another device. Out of voice at once, without a reconnect
   * attempt (a rejoin would take the other device out in turn), the island back to idle, a toast
   * says why. Other devices of the user ignore it (session_id). Returns true when acted upon.
   */
  onServerDisconnect(ev: Pick<VoiceDisconnected, 'roomId' | 'sessionId' | 'reason'>): boolean {
    const mySession = useSession.getState().sessionId;
    if (!mySession || ev.sessionId !== mySession) return false;
    // The parked room (ADR-0133): out of it, the phone call goes on.
    if (this.parked?.roomId === ev.roomId) {
      log.info('voice: the server took the parked room away');
      if (ev.reason === VoiceDisconnectReason.OTHER_DEVICE) toast.info(t('mediaErr.voice.otherDevice'));
      this.dropParked(false);
      return true;
    }
    const v = useVoice.getState();
    const removedHere = this.removed !== null && this.removed.roomId === ev.roomId;
    // Connected, connecting, reconnecting (the rejoin loop) or just removed by LiveKit there.
    const here = removedHere || this.roomId === ev.roomId || v.roomId === ev.roomId || v.joining?.roomId === ev.roomId || this.rejoinRoomId === ev.roomId;
    if (!here) return false; // already elsewhere by my own newer intent
    this.clearRemoved();
    log.info('voice: taken out by the server, the user joined from another device');
    this.takenOverRoom = ev.roomId;
    if (ev.reason === VoiceDisconnectReason.OTHER_DEVICE) toast.info(t('mediaErr.voice.otherDevice'));
    void this.leave();
    return true;
  }

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
    // The parked room was moved (ADR-0133): its connection goes, the target is entered after the call.
    if (this.parked && this.parked.roomId === ev.fromRoomId && ev.fromRoomId !== ev.toRoomId) {
      this.parkedMoved(ev.toRoomId, ev.workspaceId, true);
      return false;
    }
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
    // The SFU moved the parked connection itself (ADR-0133): it stays parked, in the target.
    if (this.parked && this.parked.roomId === fromRoomId && fromRoomId !== toRoomId) {
      this.parkedMoved(toRoomId, workspaceId, false);
      return;
    }
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

  /** Idempotent system controls reuse the same moderator/deafen/capture rules as the UI. */
  setMuted(muted: boolean): boolean {
    const v = useVoice.getState();
    if ((v.muted || v.deafened || v.serverMuted) !== muted) this.toggleMute();
    const next = useVoice.getState();
    return (next.muted || next.deafened || next.serverMuted) === muted;
  }

  /**
   * The user answered a call (explicit accept): mic on, undeafened (lib/voiceLogic.answerCallSelf).
   * Called before the call's join, which reads the store for the capture and the first voice state.
   */
  unmuteForAnswer(): void {
    const next = answerCallSelf(useVoice.getState());
    if (!next) return;
    setVoice(next);
    if (this.room) this.afterSelfChange();
  }

  /**
   * A tone key to one phone line of my connected room (ADR-0137 §3.7, ADR-0046 addendum): a
   * SipDTMF data packet addressed to `line` only (lib/media/dtmf; livekit/sip sends it to the
   * provider as RFC 2833); a line that is not in the room gets nothing (livekit-server drops a
   * packet for an absent identity — never a broadcast). Data, not sound: the echo rules (docs/02)
   * are untouched. Who may press is the caller's check (the line answered, the server's state).
   */
  publishDtmf(key: string, line: string): boolean {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return false;
    const packet = dtmfPacket(key, line);
    if (!packet) return false;
    room.engine.sendDataPacket(packet, RELIABLE).catch((err: unknown) => log.warn('voice: dtmf failed', err));
    return true;
  }

  /**
   * Another device of mine holds the voice seat (#96): the mic / headphones buttons show that
   * device's state, so a click here cannot quietly change a pre-join intent nobody sees — it says
   * where to switch instead.
   */
  private seatElsewhere(): boolean {
    if (useVoice.getState().roomId !== null || !mySeat(useWorkspaces.getState().byId, this.myId())) return false;
    toast.info(t('voiceUi.seatElsewhere'));
    return true;
  }

  toggleMute(): void {
    if (this.seatElsewhere()) return;
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
    if (this.seatElsewhere()) return;
    setVoice(toggleDeafen(useVoice.getState()));
    playSound(useVoice.getState().deafened ? 'deafen' : 'undeafen');
    this.afterSelfChange();
  }

  private afterSelfChange(): void {
    const v = useVoice.getState();
    // Muted / deafened: PTT off now, held key included (no cue — pttCue); a new press is ignored.
    if (v.muted || v.deafened) this.ptt.stop();
    // Playback and subscriptions follow `deafened` in the store subscriber (constructor).
    this.applyTransmit();
    this.pushSelfState();
    this.syncTray();
  }

  /** Optimistic voice state for everyone (docs/05: PATCH /api/voice/self). */
  private pushSelfState(extra: { onPhone?: boolean } = {}): void {
    if (!this.room && !this.nativeAudio) return;
    if (isPhoneRoom(this.roomId)) return; // a phone call's session is in no voice list (ADR-0117)
    // Serialized and retried until the server has it (ADR-0134): latest intent wins.
    this.selfSync.push({ ...this.selfFlags(), ...extra });
  }

  /** My flags as the server keeps them. Push-to-talk is a mode, not a key press (ADR-0130). */
  private selfFlags(): SelfFlags {
    const v = useVoice.getState();
    return { muted: v.muted, deafened: v.deafened, musician: prefs().musicianMode, ptt: this.micMode() === 'ptt' };
  }

  /**
   * A PATCH refusal worth retrying: the network, 5xx, 408 / 429, and 409 «not in voice yet»
   * (the join / rejoin settles it). Others (403 moderator mute, 400) would be refused again.
   */
  private selfSyncRetriable(e: unknown, flags: SelfFlags): boolean {
    if (!(e instanceof ApiError)) return true;
    // The plan does not include musician mode (ADR-0052, 409 PLAN_LIMIT): back to the processed mic.
    if (e.reason === 'PLAN_LIMIT') {
      if (flags.musician && prefs().musicianMode) {
        usePrefs.getState().setPrefs({ musicianMode: false });
        musicianLockedToast();
      }
      return false;
    }
    if (e.status < 400 || e.status >= 500) return true;
    return e.status === 408 || e.status === 409 || e.status === 429;
  }

  /**
   * The gateway is back (READY / RESUMED, ADR-0134): an unconfirmed PATCH goes again at once,
   * and my flags are compared with the server's copy READY brought — a toggle made while the
   * link was down is pushed even if no VOICE_STATE_UPDATE of mine ever arrives.
   */
  onGatewayBack(): void {
    this.selfSync.kick();
    const v = useVoice.getState();
    if (!v.roomId || !v.workspaceId || (!this.room && !this.nativeAudio)) return;
    const sv = useWorkspaces.getState().byId[v.workspaceId]?.voice[this.myId()];
    if (sv?.roomId) this.reconcileSelfState(sv);
  }

  /** Server view of our voice state differs from local (e.g. PATCH raced the join) → push again. */
  reconcileSelfState(s: { roomId: string; muted: boolean; deafened: boolean; serverMuted?: boolean; musician?: boolean; onPhone?: boolean }): void {
    const v = useVoice.getState();
    // The parked room (ADR-0133): the server lost the flag (a seat repaired by the LiveKit sync).
    const parked = this.parked;
    if (parked?.room && s.roomId === parked.roomId) {
      if (s.onPhone === false) void api.voice.updateSelf({ onPhone: true }).catch((e: unknown) => log.warn('voice/self failed', e));
      return;
    }
    // Back from a phone call: the flag must go (the PATCH of the resume may have been lost).
    if (s.onPhone && this.room && s.roomId === this.roomId) {
      this.pushSelfState({ onPhone: false });
      return;
    }
    if ((!this.room && !this.nativeAudio) || s.roomId !== this.roomId) {
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
    if (s.muted !== v.muted || s.deafened !== v.deafened || (s.musician ?? false) !== prefs().musicianMode) this.pushSelfState();
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
      // Switching the source: the old stream goes without the «stream ended» cue.
      await this.stopStream(false);
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
            // Ended outside the app (the OS «Stop sharing», the window closed).
            this.screen = null;
            annot.presenting(null);
            setVoice({ myStream: null });
            this.refreshStreams();
            playSound('streamEnd');
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
      // Whole screen: the annotation overlay may cover it (ADR-0028); a window: preview only. An
      // empty display id (Windows, issue #102) still goes: main resolves a single display itself.
      const src = opts.source;
      annot.presenting(share.video.sid ?? null, src.id.startsWith('screen:') ? { sourceId: src.id, displayId: src.displayId ?? '' } : null);
      const audio = share.audioProblem
        ? reportMediaError(share.audioProblem.raw, 'streamAudio', share.audioProblem.code === 'no-loopback' ? 'no-loopback' : undefined)
        : null;
      setVoice({
        myStream: { sourceName: share.sourceName, preset, hasAudio: share.audio !== null, audioError: audio?.text ?? null, viewers: 0 },
      });
      this.refreshStreams();
      playSound('streamStart');
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

  /** My stream got a new track sid (republished after a full reconnect): re-key what hangs on it. */
  private screenRepublished(sid: string): void {
    // One entry (my one stream); its viewers stay, so their re-announcements play no cue.
    const seen = new Set<string>();
    for (const set of this.viewers.values()) for (const id of set) seen.add(id);
    this.viewers.clear();
    this.viewers.set(sid, seen);
    log.info('voice: my stream was republished', { sid });
    annot.republished(sid);
    this.refreshStreams();
    this.publishViewers();
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

  /** `sound`: the «stream ended» cue (not for a leave or a source switch). */
  async stopStream(sound = true): Promise<void> {
    const s = this.screen;
    this.screen = null;
    if (s) this.viewers.delete(s.video.sid ?? '');
    if (s) annot.presenting(null);
    setVoice({ myStream: null });
    if (s) this.refreshStreams();
    if (s && sound) playSound('streamEnd');
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
      // A viewer of my stream came / went (a repeated message changes nothing and stays silent).
      if (m.on && !set.has(from.identity)) {
        set.add(from.identity);
        playSound('watchStart');
      } else if (!m.on && set.delete(from.identity)) playSound('watchStop');
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

  // ------------------------------------------------------------ the page away and back
  //
  // An iPhone screen lock, another app's audio (music, a video note), Safari's background tab: the
  // link may come back while the remote <audio> stays paused, a subscribed mic has no element, or
  // the capture is muted / its AudioContext suspended. Decisions in lib/voiceRecovery.ts; here only
  // events (visibility, pageshow, Reconnected, a rejoin, a capture interruption) and one-shot
  // timers armed by them — no new continuous timer in a call (docs/14-energy.md).

  /** Date.now() when the page went hidden (null = visible) and when it last became visible. */
  private hiddenAt: number | null = document.hidden ? Date.now() : null;
  private visibleAt = Date.now();
  /** Date.now() when the LiveKit room went Reconnecting; null while it is not. */
  private lkReconnectingSince: number | null = null;
  /** Date.now() when my link went down (phase connected → reconnecting): logged on its return. */
  private linkDownAt: number | null = null;
  private settleTimer: number | null = null;
  private audioCheckTimer: number | null = null;
  private micCheckTimer: number | null = null;
  /** Resubscriptions spent per remote mic publication on this connection (bounded). */
  private readonly resubscribes = new Map<string, number>();
  /** The mic check's episode: muted since, resumes / rebuilds spent (reset when healthy or the page is back). */
  private micMutedAt: number | null = null;
  private micResumes = 0;
  private micRestarts = 0;
  /** «Ждём микрофон» / «Вас не слышно» in the voice panel header and the phone strip status. */
  private micTrouble: 'recovering' | 'unheard' | null = null;
  /** WebKit queues a hidden page's getUserMedia: the capture is never restarted there while hidden. */
  private readonly captureNeedsVisible = captureWaitsForVisible(platform.kind === 'web', typeof navigator === 'undefined' ? '' : navigator.userAgent);

  /** A hidden web page: my own «disconnect» / «reconnect» cues stay quiet (the phone in a pocket, another app playing). */
  private cuesQuiet(): boolean {
    return platform.kind === 'web' && document.hidden;
  }

  private canCapture(): boolean {
    return !(this.captureNeedsVisible && document.hidden);
  }

  /** I hold a voice seat: connected, reconnecting, or between the attempts of a rejoin. */
  private hasSeat(): boolean {
    const v = useVoice.getState();
    return v.roomId !== null && v.joining === null && (v.phase === 'connected' || v.phase === 'reconnecting');
  }

  private onVisibility(): void {
    const now = Date.now();
    if (document.hidden) {
      if (this.hiddenAt !== null) return;
      this.hiddenAt = now;
      if (this.hasSeat()) log.info('voice: page hidden');
      return;
    }
    if (this.hiddenAt === null) return; // not a transition
    const hiddenMs = now - this.hiddenAt;
    this.hiddenAt = null;
    this.visibleAt = now;
    if (!this.hasSeat()) return;
    log.info(`voice: page visible after ${Math.round(hiddenMs / 1000)} s hidden`);
    // A new mic episode: whatever held the mic may have let it go.
    this.micResumes = 0;
    this.micRestarts = 0;
    this.recoverLink(hiddenMs, false);
    this.afterLinkBack('visible');
  }

  /**
   * The page is back while I hold a seat (lib/voiceRecovery.afterVisible): after a long hide a
   * LiveKit that is not connected is not waited for (rejoin now, not after the 5 s / 30 s timers);
   * a short hide gives its resume the visible grace (the seat check); a rejoin backoff is cut short.
   */
  private recoverLink(hiddenMs: number, settled: boolean): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (!this.hasSeat()) return;
    const livekit = this.seatView().livekit;
    switch (afterVisible({ hiddenMs, livekit, loop: this.rejoinRoomId !== null, waiting: this.rejoinWake !== null, settled })) {
      case 'ok':
        return;
      case 'wake':
        log.info('voice: page back, the rejoin goes on without its backoff');
        this.rejoinWake?.();
        return;
      case 'rejoin': {
        const v = useVoice.getState();
        log.info(`voice: page back after ${Math.round(hiddenMs / 1000)} s hidden, LiveKit ${livekit}: rejoining now`);
        void this.rejoin(v.roomId ?? undefined, v.workspaceId ?? undefined, true);
        return;
      }
      case 'watch':
        this.checkSeat();
        return;
      case 'settle':
        this.settleTimer = window.setTimeout(() => {
          this.settleTimer = null;
          if (!document.hidden) this.recoverLink(hiddenMs, true);
        }, VISIBLE_SETTLE_MS);
    }
  }

  /** The link or the page is back: remote audio plays, every mic has its element, the capture is healthy. */
  private afterLinkBack(why: string): void {
    if (!this.room) return;
    this.replayAudio(why);
    this.scheduleAudioCheck(why);
    this.scheduleMicCheck(why);
  }

  /** `pageshow` (services/resumeVoice.ts): a page back from the back/forward cache plays its audio again. */
  onPageShow(persisted: boolean): void {
    if (persisted) log.info('voice: page restored from the back/forward cache');
    this.afterLinkBack('pageshow');
  }

  /** The voice link's outage (connected → reconnecting → connected) is logged once it is back; no toast (#255). */
  private onPhaseChange(phase: VoicePhase, was: VoicePhase): void {
    if (phase === 'reconnecting' && was === 'connected') {
      this.linkDownAt ??= Date.now();
      return;
    }
    if (phase === 'connected' && this.linkDownAt !== null) {
      const ms = Date.now() - this.linkDownAt;
      this.linkDownAt = null;
      log.info(`voice: link back after ${Math.round(ms / 1000)} s`);
      return;
    }
    if (phase === 'idle' || phase === 'blocked') this.linkDownAt = null;
  }

  /** Room-bound recovery state; `keepSeat` (a rejoin, a park) keeps the outage clock and the prompt. */
  private resetRecovery(keepSeat: boolean): void {
    this.lkReconnectingSince = null;
    for (const id of [this.audioCheckTimer, this.micCheckTimer]) if (id !== null) window.clearTimeout(id);
    this.audioCheckTimer = null;
    this.micCheckTimer = null;
    this.resubscribes.clear();
    this.micMutedAt = null;
    this.micResumes = 0;
    this.micRestarts = 0;
    this.setMicTrouble(null);
    if (keepSeat) return;
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.closePlaybackPrompt();
  }

  /**
   * Headphones switched (#255): the elements opened before the switch could stay silent — re-bind
   * them once the burst of `devicechange` events has settled (one timeout, no polling).
   */
  private scheduleRebind(ms = REBIND_SETTLE_MS): void {
    const now = performance.now();
    if (this.rebindTimer !== null) {
      window.clearTimeout(this.rebindTimer);
      ms = Math.max(ms, this.rebindDue - now);
    }
    this.rebindDue = now + ms;
    this.rebindTimer = window.setTimeout(() => {
      this.rebindTimer = null;
      const room = this.room;
      if (!room || this.audioOut.size === 0) return;
      void this.audioOut.rebind().then((r) => {
        if (this.room !== room) return;
        log.info(`voice: output devices changed, ${r.rebound} remote audio element(s) re-bound`);
        if (r.blocked > 0 && !document.hidden) this.offerPlayback();
      });
    }, ms);
  }

  /** One pass of «play what the system paused» (RemoteAudioOut.replayPaused); a refusal offers the tap. */
  private replayAudio(why: string): void {
    const room = this.room;
    if (!room || document.hidden) return; // the page coming back runs a pass
    if (!room.canPlaybackAudio) this.offerPlayback();
    if (this.audioOut.size === 0) return;
    void this.audioOut.replayPaused().then((r) => {
      if (this.room !== room) return;
      if (r.resumed > 0) log.info(`voice: ${r.resumed} paused remote audio element(s) playing again (${why})`);
      if (r.blocked > 0) {
        log.info(`voice: ${r.blocked} remote audio element(s) refused to play without a tap (${why})`);
        this.offerPlayback();
      }
    });
  }

  private onPlaybackStatus(room: Room): void {
    if (room.canPlaybackAudio) {
      this.closePlaybackPrompt();
      return;
    }
    log.info('voice: canPlaybackAudio=false, the others are silent until a tap');
    if (!document.hidden) this.offerPlayback(); // hidden: offered when the page is back (replayAudio)
  }

  /** «Вы не слышите собеседников» — a plain toast, raised once while it is on screen, never held back by another toast. */
  private playbackToast: number | null = null;

  private offerPlayback(): void {
    const { items, push } = useToasts.getState();
    if (this.playbackToast !== null && items.some((x) => x.id === this.playbackToast)) return;
    this.playbackToast = push('info', t('voice.audioBlocked'), { label: t('voice.audioBlockedAction'), run: () => this.enablePlayback() }, PLAYBACK_PROMPT_MS);
  }

  private closePlaybackPrompt(): void {
    if (this.playbackToast !== null) useToasts.getState().dismiss(this.playbackToast);
    this.playbackToast = null;
  }

  /**
   * The tap on «Включить звук» — a user gesture: LiveKit's startAudio() plays every remote element
   * inside it (its play() calls run before its first await); the capture's context resumes with it.
   */
  private enablePlayback(): void {
    void this.mic?.resumeContext();
    const room = this.room;
    if (!room) return;
    room.startAudio().then(
      () => {
        log.info('voice: remote audio enabled by a tap');
        this.replayAudio('tap');
      },
      (e: unknown) => {
        log.warn('voice: startAudio failed', e);
        if (this.room === room) this.offerPlayback();
      },
    );
  }

  private scheduleAudioCheck(why: string): void {
    if (!this.room) return;
    if (this.audioCheckTimer !== null) window.clearTimeout(this.audioCheckTimer);
    this.audioCheckTimer = window.setTimeout(() => {
      this.audioCheckTimer = null;
      this.checkAudio(why);
    }, AUDIO_SETTLE_MS);
  }

  /**
   * Every subscribed remote mic has its <audio> (lib/voiceRecovery.audioFixes): a missing element is
   * attached, a publication without a track is resubscribed (bounded), never a rejoin for it.
   */
  private checkAudio(why: string): void {
    const room = this.room;
    if (!room || document.hidden) return; // the page coming back checks again
    const pubs = new Map<string, { pub: RemoteTrackPublication; p: RemoteParticipant }>();
    const views: MicPubView[] = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.source !== Track.Source.Microphone || !pub.trackSid) continue;
        const trackSid = pub.track?.sid;
        const element = trackSid !== undefined && this.audioOut.has(trackSid);
        if (element) this.resubscribes.delete(pub.trackSid); // healthy again: fresh tries next time
        pubs.set(pub.trackSid, { pub, p });
        views.push({ sid: pub.trackSid, desired: pub.isDesired, track: pub.track !== undefined, element, tries: this.resubscribes.get(pub.trackSid) ?? 0 });
      }
    }
    let again = false;
    for (const fix of audioFixes(views, { deafened: useVoice.getState().deafened, maxTries: RESUBSCRIBE_TRIES })) {
      const hit = pubs.get(fix.sid);
      if (!hit) continue;
      const { pub, p } = hit;
      if (fix.kind === 'attach') {
        if (!pub.track) continue;
        log.info(`voice: mic ${fix.sid} of ${p.identity} subscribed without an <audio>, attaching (${why})`);
        this.attachAudio(pub.track, p, false);
      } else if (fix.kind === 'subscribe') {
        log.info(`voice: mic ${fix.sid} of ${p.identity} not subscribed, subscribing (${why})`);
        pub.setSubscribed(true);
        again = true;
      } else {
        const n = (this.resubscribes.get(fix.sid) ?? 0) + 1;
        this.resubscribes.set(fix.sid, n);
        log.info(`voice: mic ${fix.sid} of ${p.identity} subscribed without a track, resubscribing (${n}/${RESUBSCRIBE_TRIES}, ${why})`);
        pub.setSubscribed(false);
        window.setTimeout(() => {
          if (this.room === room && !useVoice.getState().deafened) pub.setSubscribed(true);
        }, RESUBSCRIBE_GAP_MS);
        again = true;
      }
    }
    if (again) this.scheduleAudioCheck(why); // verify: bounded by the tries
  }

  private scheduleMicCheck(why: string, ms: number = MIC_SETTLE_MS): void {
    if (!this.room || !this.mic) return;
    if (this.micCheckTimer !== null) window.clearTimeout(this.micCheckTimer);
    this.micCheckTimer = window.setTimeout(() => {
      this.micCheckTimer = null;
      this.checkMic(why);
    }, ms);
  }

  /**
   * The capture works (lib/voiceRecovery.micFix): the context runs, the raw track is live and not
   * muted, the worklet reports. Muted by the system (lock, another app, an interruption) → «Ждём
   * микрофон», not a reconnect; still muted after ~2 s visible, or ended → one rebuild; that failing → «Вас не слышно».
   * Never a new capture while a WebKit page is hidden (it would queue until visible).
   */
  private checkMic(why: string): void {
    const mic = this.mic;
    if (!mic || !this.room || this.nativeAudio) return;
    const h = mic.health();
    const now = Date.now();
    if (!h.muted) this.micMutedAt = null;
    else this.micMutedAt ??= now;
    const mutedMs = this.micMutedAt === null ? 0 : now - Math.max(this.micMutedAt, this.visibleAt);
    const fix = micFix({ canCapture: this.canCapture(), ctx: h.ctx, ended: h.ended, muted: h.muted, mutedMs, reportAgeMs: h.reportAgeMs, resumes: this.micResumes, restarts: this.micRestarts });
    switch (fix.kind) {
      case 'ok':
        this.micResumes = 0;
        this.micRestarts = 0;
        this.setMicTrouble(null);
        return;
      case 'wait':
        return;
      case 'muted':
        this.setMicTrouble('recovering');
        this.scheduleMicCheck('still muted', fix.recheckMs);
        return;
      case 'resume':
        this.micResumes++;
        void mic.resumeContext().then((running) => {
          log.info(`voice: mic AudioContext resumed (${why}): ${running ? 'running' : mic.health().ctx}`);
          if (this.mic !== mic) return;
          this.applyTransmit();
          this.scheduleMicCheck('after resume');
        });
        return;
      case 'restart':
        this.micRestarts++;
        log.info(`voice: restarting the mic capture (${fix.reason}, ${why})`);
        void this.restartMic(true).then((r) => {
          if (r === 'failed') this.setMicTrouble('unheard');
          else if (r === 'ok') {
            this.micMutedAt = null;
            this.scheduleMicCheck('after restart');
          }
        });
        return;
      case 'give-up':
        log.warn(`voice: the mic capture is still broken after a restart (${why})`);
        this.setMicTrouble('unheard');
    }
  }

  /** The raw capture muted / unmuted by the system (another app, an interruption, a hidden WebKit page). */
  private onMicMute(muted: boolean): void {
    log.info(`voice: mic capture ${muted ? 'muted' : 'unmuted'} by the system${document.hidden ? ' (page hidden)' : ''}`);
    if (muted) {
      this.micMutedAt ??= Date.now();
      this.closeGate(); // silence now: the gate must not stay open on its last report
    } else {
      this.micMutedAt = null;
      this.interruptionEnded('mic unmuted');
    }
    this.scheduleMicCheck(muted ? 'mic muted' : 'mic unmuted');
  }

  private onMicContext(state: string): void {
    log.info(`voice: mic AudioContext ${state}`);
    if (state === 'running') this.interruptionEnded('audio context running');
    // No reports while suspended / interrupted: the voice gate would freeze as it was.
    else if (state !== 'closed') this.closeGate();
    this.scheduleMicCheck(`audio context ${state}`);
  }

  /** An interruption ended (the capture unmuted, its context running): resume, re-evaluate the gate, play again. */
  private interruptionEnded(why: string): void {
    void this.mic?.resumeContext();
    this.applyTransmit();
    this.replayAudio(why);
  }

  private closeGate(): void {
    this.gate.reset();
    if (useVoice.getState().gateOpen) setVoice({ gateOpen: false });
    this.applyTransmit();
  }

  /**
   * «Ждём микрофон» / «Вас не слышно» in place of «Голос подключён» (the panel header and the
   * phone strip status), or neither. The cause is not known (the browser only says «muted»): it goes
   * to the log, not on screen. Never micError: that line is for device and permission errors.
   */
  private setMicTrouble(kind: 'recovering' | 'unheard' | null): void {
    if (kind === this.micTrouble) return;
    this.micTrouble = kind;
    setVoice({ micTrouble: kind });
    if (kind) log.info(`voice: mic trouble shown: ${kind}`);
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
      duckWanted({ mode: p.echoMode, echoRisk: this.echo.risk, remoteActive: this.remoteTalk.active, micMode: this.micMode(), pttDown: v.pttDown, deafened: v.deafened });
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
    if (prefs().musicianMode) {
      // No AEC by choice (ADR-0052): headphones, or back to the processed mic.
      useToasts.getState().push('info', t('music.echoRisk'), { label: t('music.turnOff'), run: () => usePrefs.getState().setPrefs({ musicianMode: false }) }, 12_000);
    } else if (mode === 'headphones') {
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
    // A capture that changed size after publishing left an H.264 layer odd → OpenH264 (docs/14).
    if (hasOddH264Layer(screenOut)) {
      const was = screenOut.map((l) => `${l.width}x${l.height}`);
      void this.screen?.realign().then((ok) => {
        if (ok) log.info('stream: odd H.264 layer, rescaled the thumb', { was });
      });
    }
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
      stats: { totalOutKbps: out, totalInKbps: inn, pair, micKbps, micTierKbps: this.micTrack ? this.micTier().kbps : null, screenOut, cameraOut, watching, rendererCpu, echo: { ...aec, corr: this.echo.lastCorr } },
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
