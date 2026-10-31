import { audioUUID, parseAudioControls, type HostAudioControls } from './hostCallAudio';

/**
 * Optional iOS room audio transport (ADR-0149). Authentication, seats and UI stay in the shared
 * renderer. Mirrored by CalabRoomAudioWire.swift: a rule changed here changes there, and both run
 * hostRoomAudio.fixtures.ts.
 */
export const ROOM_AUDIO_MAX_URL = 1024;
export const ROOM_AUDIO_MAX_TOKEN = 4096;
export const ROOM_AUDIO_MAX_USERS = 64;
export const ROOM_AUDIO_MAX_WATCHED = 4;
export const ROOM_AUDIO_MAX_LEVEL = 20;
/** The renderer's meter floor (vad.ts METER_MIN_DB): the gate slider cannot leave this range. */
export const ROOM_AUDIO_MIN_THRESHOLD_DB = -80;

/** UI cues (lib/sounds.ts) and built-in soundboard clips (assets/sounds), bundled natively by name. */
export const ROOM_AUDIO_CUES = [
  'join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'pttOn', 'pttOff', 'mention', 'message',
  'streamStart', 'streamEnd', 'watchStart', 'watchStop', 'moved', 'disconnect', 'reconnect', 'recStart', 'recStop',
  'builtin:air_horn', 'builtin:ba_dum_tss', 'builtin:cricket', 'builtin:golf_clap', 'builtin:quack', 'builtin:sad_horn',
] as const;
export type HostRoomAudioCue = (typeof ROOM_AUDIO_CUES)[number];

export const ROOM_AUDIO_PHASES = ['connecting', 'connected', 'reconnecting', 'lost', 'interrupted', 'ended', 'failed'] as const;
/** `native` is a mute made on the device, without the page. */
export const ROOM_AUDIO_MUTE_ORIGINS = ['web', 'system', 'server', 'native'] as const;
export const ROOM_AUDIO_ROUTES = ['speaker', 'receiver', 'wired', 'bluetooth', 'other'] as const;
export const ROOM_AUDIO_ERRORS = ['permission', 'connection', 'audio', 'superseded', 'removed', 'duplicate', 'closed', 'network'] as const;

export interface HostRoomAudioGate {
  mode: 'voice' | 'ptt' | 'open';
  thresholdDb: number;
  pttOpen: boolean;
}
/** Always the complete state, never a patch: a late message cannot leave a mix of two states. */
export interface HostRoomAudioControls extends HostAudioControls {
  /** Live: the room's voice tier can change during a session. */
  bitrate: number;
  gate: HostRoomAudioGate;
  /** Watched stream publishers by user id, each with the volume of its screen-share audio. */
  watched: Record<string, number>;
  levels: boolean;
}
export interface HostRoomAudioConnect {
  connectionId: string;
  roomId: string;
  url: string;
  token: string;
  relayOnly: boolean;
  red: boolean;
  canSpeak: boolean;
  controls: HostRoomAudioControls;
}
export type HostRoomAudioOperation =
  | { operation: 'status' }
  | ({ operation: 'connect' } & HostRoomAudioConnect)
  | { operation: 'control'; connectionId: string; controls: HostRoomAudioControls }
  | { operation: 'cue'; connectionId: string; cue: HostRoomAudioCue; volume: number }
  | { operation: 'disconnect'; connectionId: string };
export interface HostRoomAudioState {
  connectionId: string;
  phase: (typeof ROOM_AUDIO_PHASES)[number];
  microphoneReady: boolean;
  muted: boolean;
  /** Present exactly while muted. */
  muteOrigin?: (typeof ROOM_AUDIO_MUTE_ORIGINS)[number];
  canSpeak: boolean;
  speaking: boolean;
  speakers: string[];
  route: (typeof ROOM_AUDIO_ROUTES)[number];
  phoneCall: boolean;
  error?: (typeof ROOM_AUDIO_ERRORS)[number];
  /** Microphone level in 21 steps, only while controls ask for levels. */
  level?: number;
}
/** `supported: false` means no native module. Any native failure keeps `supported` and sets `failed`. */
export interface HostRoomAudioStatus {
  supported: boolean;
  media?: HostRoomAudioState;
  /** An operation failed or the snapshot is unreadable: native state is unknown, so the page must not fall back yet. */
  failed?: true;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join(',') === expected;
const oneOf = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);

const volume = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

// One expression, mirrored in Swift, so TS and Swift accept exactly the same URLs. Host, port and a
// plain path only: no credentials, query, fragment, escapes or dot segments.
const ROOM_URL = /^wss:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::([0-9]{1,5}))?(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]*)*$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
function roomUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > ROOM_AUDIO_MAX_URL) return false;
  const match = ROOM_URL.exec(v);
  if (!match) return false;
  const port = match[1] === undefined ? 1 : Number(match[1]);
  return port >= 1 && port <= 65535;
}

function parseWatched(v: unknown): boolean {
  if (!record(v)) return false;
  const publishers = Object.entries(v);
  return publishers.length <= ROOM_AUDIO_MAX_WATCHED && publishers.every(([id, level]) => audioUUID(id) && volume(level));
}
function parseGate(v: unknown): HostRoomAudioGate | null {
  if (!record(v) || !keys(v, 'mode,pttOpen,thresholdDb') || !oneOf(v.mode, ['voice', 'ptt', 'open']) || typeof v.pttOpen !== 'boolean' ||
      typeof v.thresholdDb !== 'number' || !Number.isFinite(v.thresholdDb) || v.thresholdDb < ROOM_AUDIO_MIN_THRESHOLD_DB || v.thresholdDb > 0) return null;
  return v as unknown as HostRoomAudioGate;
}
export function parseRoomAudioControls(v: unknown): HostRoomAudioControls | null {
  if (!record(v) || !keys(v, 'bitrate,deafened,gate,levels,muted,userVolumes,volume,watched')) return null;
  const { bitrate, gate, levels, watched, ...common } = v;
  if (!parseAudioControls(common) || !Number.isInteger(bitrate) || Number(bitrate) < 8000 || Number(bitrate) > 64000 ||
      !parseGate(gate) || typeof levels !== 'boolean' || !parseWatched(watched)) return null;
  return v as unknown as HostRoomAudioControls;
}
export function parseRoomAudioOperation(v: Record<string, unknown>): HostRoomAudioOperation | null {
  if (v.operation === 'status') return keys(v, 'operation') ? v as unknown as HostRoomAudioOperation : null;
  if (!audioUUID(v.connectionId)) return null;
  if (v.operation === 'disconnect' && keys(v, 'connectionId,operation')) return v as unknown as HostRoomAudioOperation;
  if (v.operation === 'cue' && keys(v, 'connectionId,cue,operation,volume') && oneOf(v.cue, ROOM_AUDIO_CUES) && volume(v.volume)) return v as unknown as HostRoomAudioOperation;
  if (v.operation === 'control' && keys(v, 'connectionId,controls,operation') && parseRoomAudioControls(v.controls)) return v as unknown as HostRoomAudioOperation;
  if (v.operation !== 'connect' || !keys(v, 'canSpeak,connectionId,controls,operation,red,relayOnly,roomId,token,url') || !audioUUID(v.roomId) ||
      !roomUrl(v.url) || typeof v.token !== 'string' || v.token.length > ROOM_AUDIO_MAX_TOKEN || !JWT.test(v.token) ||
      typeof v.relayOnly !== 'boolean' || typeof v.red !== 'boolean' || typeof v.canSpeak !== 'boolean' ||
      !parseRoomAudioControls(v.controls)) return null;
  return v as unknown as HostRoomAudioOperation;
}

const STATE_FIELDS = ['connectionId', 'phase', 'microphoneReady', 'muted', 'muteOrigin', 'canSpeak', 'speaking', 'speakers', 'route', 'phoneCall', 'error', 'level'];
export function parseRoomAudioState(v: unknown): HostRoomAudioState | null {
  if (!record(v) || Object.keys(v).some(k => !STATE_FIELDS.includes(k)) || !audioUUID(v.connectionId) ||
      !oneOf(v.phase, ROOM_AUDIO_PHASES) ||
      typeof v.microphoneReady !== 'boolean' || typeof v.muted !== 'boolean' || typeof v.canSpeak !== 'boolean' ||
      typeof v.speaking !== 'boolean' || typeof v.phoneCall !== 'boolean' || !oneOf(v.route, ROOM_AUDIO_ROUTES) ||
      !Array.isArray(v.speakers) || v.speakers.length > ROOM_AUDIO_MAX_USERS || !v.speakers.every(audioUUID)) return null;
  if (v.muted ? !oneOf(v.muteOrigin, ROOM_AUDIO_MUTE_ORIGINS) : v.muteOrigin !== undefined) return null;
  if (v.error !== undefined && !oneOf(v.error, ROOM_AUDIO_ERRORS)) return null;
  if (v.level !== undefined && (!Number.isInteger(v.level) || Number(v.level) < 0 || Number(v.level) > ROOM_AUDIO_MAX_LEVEL)) return null;
  return v as unknown as HostRoomAudioState;
}
export function parseRoomAudioStatus(v: unknown): HostRoomAudioStatus | null {
  if (!record(v) || typeof v.supported !== 'boolean') return null;
  if (!v.supported) return keys(v, 'supported') ? { supported: false } : null;
  if (Object.keys(v).some(k => !['supported', 'media', 'failed'].includes(k))) return null;
  if (v.failed !== undefined && v.failed !== true) return null;
  if (v.media !== undefined && !parseRoomAudioState(v.media)) return null;
  return v as unknown as HostRoomAudioStatus;
}
