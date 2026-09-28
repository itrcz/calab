/**
 * Pure voice-state rules (unit-tested). docs/02-media.md, "Режимы микрофона":
 * explicit mute is signalled to LiveKit; the VAD gate / PTT only toggle audio flow.
 */
export interface SelfState {
  muted: boolean;
  deafened: boolean;
  /**
   * The mic as it was when deafen went on (issue #11): undeafen returns to it instead of turning
   * the mic on. Meaningful only while `deafened`.
   */
  mutedBeforeDeafen?: boolean;
}

/**
 * Mic button (Discord behaviour, docs/08 «Кнопки голоса»): toggles the mic; while deafened the
 * mic cannot be turned on alone — the click lifts deafen AND turns the mic on (the user asked to
 * talk, talking without hearing makes no sense).
 */
export function toggleMute(s: SelfState): Required<SelfState> {
  if (s.deafened) return { muted: false, deafened: false, mutedBeforeDeafen: false };
  return { muted: !s.muted, deafened: false, mutedBeforeDeafen: false };
}

/**
 * Deafen = mute + silence all remote audio; the mic state before it is remembered. Undeafen
 * restores that mic state (#11: a mic that was off stays off) — and under a moderator mute
 * (VoiceState.server_muted), which only the server lifts, the mic stays muted (review pass 3 M1).
 */
export function toggleDeafen(s: SelfState & { serverMuted?: boolean }): Required<SelfState> {
  if (!s.deafened) return { muted: true, deafened: true, mutedBeforeDeafen: s.muted };
  return { muted: s.mutedBeforeDeafen === true || s.serverMuted === true, deafened: false, mutedBeforeDeafen: false };
}

/**
 * Push-to-talk key / button down (#12): only an unmuted, undeafened mic can go on air — muted or
 * deafened, the press is ignored: no gate, no transmission, no activation cue.
 */
export function pttAllowed(s: SelfState): boolean {
  return !s.muted && !s.deafened;
}

/** The PTT on / off cue: in a connected call, and only while the key really drives the mic. */
export function pttCue(on: boolean, s: SelfState, inCall: boolean): 'pttOn' | 'pttOff' | null {
  if (!inCall || !pttAllowed(s)) return null;
  return on ? 'pttOn' : 'pttOff';
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

/** Highest per-user volume in the member menu (docs/09 #20: 0–200 %). */
export const USER_VOLUME_MAX = 2;

/**
 * Playback of one remote <audio> element (docs/02 echo rule 1: element.volume / .muted only,
 * never WebAudio). Voice: per-user volume × the headphones ▾ volume, «Заглушить для меня»
 * (prefs userVolumes / mutedUsers); a stream's own audio: its stream volume × the per-user
 * volume (the person is as loud for me everywhere). Deafen silences all.
 *
 * The per-user volume goes up to 200 %, but `element.volume` stops at 1.0: above 100 % it only
 * compensates a lower headphones ▾ volume (50 % × 200 % = 100 %). `capped` = the wanted level
 * is above what the element can play (the menu says so).
 */
export function remoteAudio(i: {
  deafened: boolean;
  stream: boolean;
  userId: string;
  userVolumes: Readonly<Record<string, number>>;
  mutedUsers: Readonly<Record<string, true>>;
  /** «Не слышать»: nothing from them — voice and stream audio. */
  deafUsers?: Readonly<Record<string, true>>;
  streamVolume: Readonly<Record<string, number>>;
  /** Everyone's voice (headphones ▾ «Громкость участников»), multiplies the per-user volume. */
  outputVolume?: number;
}): { muted: boolean; volume: number; capped: boolean } {
  const master = i.stream ? 1 : Math.max(0, Math.min(1, i.outputVolume ?? 1));
  const user = Math.max(0, Math.min(USER_VOLUME_MAX, i.userVolumes[i.userId] ?? 1));
  const v = (i.stream ? Math.max(0, Math.min(1, i.streamVolume[i.userId] ?? 1)) : 1) * user * master;
  const ok = Number.isFinite(v);
  return {
    muted: i.deafened || i.deafUsers?.[i.userId] === true || (!i.stream && i.mutedUsers[i.userId] === true),
    volume: ok ? Math.max(0, Math.min(1, v)) : 1,
    capped: ok && v > 1,
  };
}

/** The member menu's «выше 100 % недоступно» hint: their voice would need more than element.volume = 1. */
export function userVolumeCapped(volume: number, outputVolume: number): boolean {
  return volume > 1 && volume * Math.max(0, Math.min(1, outputVolume)) > 1;
}

/** Next userVolumes map: clamped to 0..USER_VOLUME_MAX; 100 % is the default and is not stored. */
export function withUserVolume(map: Readonly<Record<string, number>>, userId: string, volume: number): Record<string, number> {
  const v = Number.isFinite(volume) ? Math.max(0, Math.min(USER_VOLUME_MAX, volume)) : 1;
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

/**
 * What one mic level report writes to the voice store (docs/14 «Ререндеры в звонке»). The level
 * and VAD are read only by a mic meter on screen (Settings → Голос, onboarding): with one shown
 * they go at most every `intervalMs` (and on a gate edge); without it only the gate edge is
 * written. Every write wakes every useVoice selector, so an unseen 20/s level is pure cost.
 */
export function meterUpdate(a: { open: boolean; wasOpen: boolean; meter: boolean; now: number; last: number; intervalMs: number }): 'none' | 'gate' | 'level' {
  const edge = a.open !== a.wasOpen;
  if (a.meter && (edge || a.now - a.last >= a.intervalMs)) return 'level';
  return edge ? 'gate' : 'none';
}
