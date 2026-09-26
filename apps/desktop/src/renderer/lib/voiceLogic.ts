/**
 * Pure voice-state rules (unit-tested). docs/02-media.md, "Режимы микрофона":
 * explicit mute is signalled to LiveKit; the VAD gate / PTT only toggle audio flow.
 */
export interface SelfState {
  muted: boolean;
  deafened: boolean;
}

/** Mic button: unmuting while deafened also undeafens (Discord behaviour). */
export function toggleMute(s: SelfState): SelfState {
  if (s.muted || s.deafened) return { muted: false, deafened: false };
  return { muted: true, deafened: false };
}

/**
 * Deafen = mute + silence all remote audio. Undeafen restores the mic — except under a moderator
 * mute (VoiceState.server_muted), which only the server lifts: the mic stays muted (review pass 3 M1).
 */
export function toggleDeafen(s: SelfState & { serverMuted?: boolean }): SelfState {
  if (!s.deafened) return { muted: true, deafened: true };
  return { muted: s.serverMuted === true, deafened: false };
}

export interface TransmitInput extends SelfState {
  canSpeak: boolean;
  mode: 'voice' | 'ptt';
  gateOpen: boolean;
  pttDown: boolean;
}

export interface TransmitDecision {
  /** LiveKit `track.mute()` — visible to others as "muted". */
  livekitMuted: boolean;
  /** `mediaStreamTrack.enabled` — silence without signalling. */
  audioEnabled: boolean;
  /** UI "on air" indicator. */
  transmitting: boolean;
}

export function transmitDecision(i: TransmitInput): TransmitDecision {
  const livekitMuted = i.muted || i.deafened || !i.canSpeak;
  const gate = i.mode === 'voice' ? i.gateOpen : i.pttDown;
  return { livekitMuted, audioEnabled: gate, transmitting: !livekitMuted && gate };
}

export type LinkQuality = 'good' | 'fair' | 'poor' | 'unknown';

/** Connection quality dot from RTT (ms) and packet loss (%). */
export function qualityOf(rttMs: number | null, lossPct: number | null): LinkQuality {
  if (rttMs === null && lossPct === null) return 'unknown';
  const r = rttMs ?? 0;
  const l = lossPct ?? 0;
  if (r < 150 && l < 2) return 'good';
  if (r < 300 && l < 8) return 'fair';
  return 'poor';
}

/** LiveKit protocol TrackSource.MICROPHONE. */
const LK_SOURCE_MICROPHONE = 2;

/**
 * SPEAK from our LiveKit grant: the server lists the allowed sources (rtc/grant.go), so a
 * stream-only grant (`canPublish` with screen sources) must not count as SPEAK.
 */
export function canSpeakFrom(p: { canPublish: boolean; canPublishSources: readonly number[] }): boolean {
  return p.canPublish && (p.canPublishSources.length === 0 || p.canPublishSources.includes(LK_SOURCE_MICROPHONE));
}

/** getUserMedia failed because the chosen device is gone (unplugged / id changed). */
export function isDeviceGone(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : null;
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError';
}

/**
 * Playback of one remote <audio> element (docs/02 echo rule 1: element.volume / .muted only,
 * never WebAudio — so no boost above 100 %). Voice: per-user volume and «Заглушить для меня»
 * (prefs userVolumes / mutedUsers); a stream's own audio: its stream volume. Deafen silences all.
 */
export function remoteAudio(i: {
  deafened: boolean;
  stream: boolean;
  userId: string;
  userVolumes: Readonly<Record<string, number>>;
  mutedUsers: Readonly<Record<string, true>>;
  streamVolume: Readonly<Record<string, number>>;
}): { muted: boolean; volume: number } {
  const v = i.stream ? (i.streamVolume[i.userId] ?? 1) : (i.userVolumes[i.userId] ?? 1);
  return {
    muted: i.deafened || (!i.stream && i.mutedUsers[i.userId] === true),
    volume: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1,
  };
}

/** Next userVolumes map: clamped to 0..1; 100 % is the default and is not stored. */
export function withUserVolume(map: Readonly<Record<string, number>>, userId: string, volume: number): Record<string, number> {
  const v = Math.max(0, Math.min(1, volume));
  const next = { ...map, [userId]: v };
  if (v === 1) delete next[userId];
  return next;
}

/** Next mutedUsers map («Заглушить для меня» on / off). */
export function withUserMuted(map: Readonly<Record<string, true>>, userId: string, muted: boolean): Record<string, true> {
  const next = { ...map };
  if (muted) next[userId] = true;
  else delete next[userId];
  return next;
}
