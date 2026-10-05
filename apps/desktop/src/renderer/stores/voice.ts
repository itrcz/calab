import type { ConcreteScreenSharePreset } from '@calaba/protocol';
import { create } from 'zustand';
import type { MediaErrorAction } from '../lib/media/errors';
import type { CameraFacing, CameraPhase } from '../lib/media/cameraLogic';
import type { CandidatePairInfo, InboundVideoStats, OutboundVideoLayer } from '../lib/media/stats';

/** `blocked`: the app's CSP refused the LiveKit host — retrying cannot help, an update can. */
export type VoicePhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked';

/** Voice connection diagnostics (the reconnect notice, Settings → Соединение). */
export interface VoiceLink {
  /** LiveKit host from the last /join (`rtc.calab.io`). */
  rtcHost: string | null;
  /** Failed connect attempts in a row (reset when connected, on join and leave). */
  attempts: number;
  /** The last connect / disconnect error, human-readable (lib/voiceLink.describeConnectError). */
  lastError: string | null;
  /** Host the CSP blocked (phase 'blocked'). */
  blockedHost: string | null;
}
export type { LinkQuality } from '../lib/voiceLogic';
import type { LinkQuality } from '../lib/voiceLogic';
export type StageMode = 'pip' | 'expanded' | 'popout';
/** Viewer's cap on a stream's simulcast layer ('auto' = adaptive stream decides). */
export type StreamQuality = 'auto' | 'high' | 'medium' | 'low';

/** A stream in my room: a remote one, or my own (`local`, docs/09 #18a). */
export interface RemoteStream {
  trackSid: string;
  userId: string;
  identity: string;
  /** The streamer also publishes system audio (never true for mine: I don't play my own sound). */
  hasAudio: boolean;
  /**
   * My own stream: shown from the local LocalTrackPublication (no subscription), badge «Вы
   * стримите», no quality / volume controls.
   */
  local?: boolean;
}

/** A remote webcam in my room (LiveKit camera publication). */
export interface RemoteCamera {
  trackSid: string;
  userId: string;
  identity: string;
}

export interface MyStream {
  sourceName: string;
  preset: ConcreteScreenSharePreset;
  hasAudio: boolean;
  audioError: string | null;
  viewers: number;
}

export interface VoiceStats {
  totalOutKbps: number;
  totalInKbps: number;
  pair: CandidatePairInfo | null;
  micKbps: number | null;
  /** The tier the mic publishes at (lib/media/opusTier.ts); null = no mic published. Absent in old fixtures. */
  micTierKbps?: number | null;
  screenOut: OutboundVideoLayer[];
  cameraOut: OutboundVideoLayer[];
  watching: InboundVideoStats | null;
  rendererCpu: number | null;
  /** AEC metrics of the sent mic + the echo detector (lib/media/echo.ts); absent in old fixtures. */
  echo?: EchoDiag;
}

export interface EchoDiag {
  erl: number | null;
  erle: number | null;
  /** Best far-end → sent correlation of the last 5 s window. */
  corr: number | null;
}

/**
 * A meeting recording in my voice room (docs/09 #30, ADR-0025): who switched it on and when (ms).
 * Mirrors the server's state for my room (stores/recordings via services/recording.ts).
 */
export interface VoiceRecording {
  byUserId: string;
  since: number;
}

export interface VoiceStore {
  roomId: string | null;
  workspaceId: string | null;
  /** Date.now() of the current room join (docs/09 #10: the invite row is visible for 30 s after
   * it). A reconnect keeps it; only a fresh join or a move to another room resets it. */
  joinedAt: number | null;
  phase: VoicePhase;
  /**
   * The room I clicked, from the click until connect() takes the seat (phase 'connecting'):
   * switching rooms first tears the old call down, and the optimistic join (stores/voicePending)
   * shows me in the new room during that too.
   */
  joining: { roomId: string; workspaceId: string } | null;
  /**
   * The session is a one-to-one call's (ADR-0034): a DM room, `workspaceId` ''; the mic is voice
   * activation only (no PTT button / hint), the panel names the peer instead of a room.
   */
  call: boolean;
  error: string | null;
  canSpeak: boolean;
  canStream: boolean;
  /** JoinVoiceResponse.can_video: VIDEO and the room allows cameras. */
  canVideo: boolean;
  /** My webcam (lib/media/cameraLogic.ts state machine). */
  camera: CameraPhase;
  /** The camera encoder was CPU-bound: capture dropped to 360p for this session. */
  cameraCpuLimited: boolean;
  /** Phone camera side picked with «Переключить камеру» (null = the device's default, mirrored). Reset on leave. */
  cameraFacing: CameraFacing | null;
  /** Remote webcams of my room, in publication order. */
  cameras: RemoteCamera[];
  /** Active speaker for video: spoke ≥ 2 s continuously, stays until someone else does (lib/activeSpeaker.ts). */
  activeSpeaker: string | null;
  /** Tile the viewer clicked in the video grid (large until clicked again). */
  focusedTile: string | null;
  /** The camera PiP over the chat (closed with ×, back from «Ещё → Показать видео»). */
  videoPip: boolean;
  muted: boolean;
  deafened: boolean;
  /** The mic before deafen went on: undeafen returns to it (lib/voiceLogic toggleDeafen, #11). */
  mutedBeforeDeafen: boolean;
  transmitting: boolean;
  levelDb: number;
  vad: number | null;
  gateOpen: boolean;
  pttDown: boolean;
  /** Residual echo reaches the others (lib/media/echo.ts): sticky for the call, reset by a device change. */
  echoRisk: boolean;
  /** The speakerphone duck is lowering my mic right now. */
  ducking: boolean;
  /** Human text (lib/media/errors.ts), never a raw error. */
  micError: string | null;
  micErrorAction: MediaErrorAction | null;
  /** A moderator muted my mic (not me): shown as a red crossed mic, distinct from self-mute. */
  serverMuted: boolean;
  /**
   * userId → speaking, for the rings and bright names (lib/speaking.ts): remote LiveKit active
   * speakers of our room (any of a user's devices) + me from the local VAD / PTT; on at once,
   * off 300 ms after the speech, batched. Subscribe per user (`s.speaking[id]`), never the map.
   */
  speaking: Record<string, boolean>;
  quality: LinkQuality;
  rttMs: number | null;
  lossPct: number | null;
  streams: RemoteStream[];
  watching: string | null;
  stage: StageMode;
  /** trackSid → layer cap chosen in the stream's control bar. */
  streamQuality: Record<string, StreamQuality>;
  /** streamer userId → volume 0…1 of the stream's audio element (element.volume, no WebAudio). */
  streamVolume: Record<string, number>;
  myStream: MyStream | null;
  streamBusy: boolean;
  stats: VoiceStats | null;
  /** Bumped when a video track (stream or camera, remote or mine) changes, so video elements re-attach. */
  trackEpoch: number;
  link: VoiceLink;
  /** Recording of my room, if any (REC on the room card, the voice panel, the phone strip). */
  recording: VoiceRecording | null;
  set: (p: Partial<VoiceStore>) => void;
}

export const useVoice = create<VoiceStore>()((set) => ({
  roomId: null,
  workspaceId: null,
  joinedAt: null,
  phase: 'idle',
  joining: null,
  call: false,
  error: null,
  canSpeak: false,
  canStream: false,
  canVideo: false,
  camera: 'off',
  cameraCpuLimited: false,
  cameraFacing: null,
  cameras: [],
  activeSpeaker: null,
  focusedTile: null,
  videoPip: true,
  muted: false,
  deafened: false,
  mutedBeforeDeafen: false,
  transmitting: false,
  levelDb: -80,
  vad: null,
  gateOpen: false,
  pttDown: false,
  echoRisk: false,
  ducking: false,
  micError: null,
  micErrorAction: null,
  serverMuted: false,
  speaking: {},
  quality: 'unknown',
  rttMs: null,
  lossPct: null,
  streams: [],
  watching: null,
  stage: 'pip',
  streamQuality: {},
  streamVolume: {},
  myStream: null,
  streamBusy: false,
  stats: null,
  trackEpoch: 0,
  link: { rtcHost: null, attempts: 0, lastError: null, blockedHost: null },
  recording: null,
  set: (p) => set(p),
}));

export const setVoice = (p: Partial<VoiceStore>): void => useVoice.getState().set(p);

/**
 * The stream viewer hides the room's feed (docs/09 #18): any non-PiP stage — expanded or the
 * pop-out's placeholder — covers the message list, as does stream full screen (`fullscreen`
 * is the layout flag, independent of `stage`). The PiP leaves the chat open. While covered
 * the chat is not on screen: a new message counts as unread and the read marker must not move
 * (issue #35).
 */
export function streamCoversChat(s: Pick<VoiceStore, 'roomId' | 'stage' | 'streams' | 'watching'>, roomId: string, fullscreen = false): boolean {
  if (s.roomId !== roomId) return false;
  if (!s.streams.some((x) => x.trackSid === s.watching)) return false;
  return s.stage !== 'pip' || fullscreen;
}
