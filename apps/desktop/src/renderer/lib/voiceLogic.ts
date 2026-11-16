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
 * Answering a call (phone, ADR-0117, or one-to-one) is an explicit wish to talk: a muted mic is
 * switched on and a deafened user is undeafened (a call you cannot hear makes no sense). A moderator
 * mute (`serverMuted`) is the server's: left as it is, deafen still lifts. Push-to-talk needs no
 * special case: a call is voice activation only (ADR-0034), `muted: false` just means "not hard-muted".
 * Returns null when nothing changes.
 */
export function answerCallSelf(s: SelfState & { serverMuted?: boolean }): Required<SelfState> | null {
  const muted = s.serverMuted === true ? s.muted : false;
  if (muted === s.muted && !s.deafened) return null;
  return { muted, deafened: false, mutedBeforeDeafen: false };
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

/**
 * The mic mode in force (ADR-0034): a one-to-one call is voice activation only, whatever the
 * user chose — no PTT binding, no PTT hint; their choice comes back after the call.
 */
export function micModeFor(pref: 'voice' | 'ptt', call: boolean): 'voice' | 'ptt' {
  return call ? 'voice' : pref;
}

/**
 * Which mic glyph a user shows (CBF-71): `muted` — a crossed mic; `ptt-idle` — the mic is on but
 * waits for the push-to-talk key (a pale crossed mic, no transmission); `live` — the mic carries
 * sound (voice activation, or the PTT key is held).
 */
export type MicGlyph = 'muted' | 'ptt-idle' | 'live';

export function micGlyph(i: { muted: boolean; deafened: boolean; ptt: boolean; talking: boolean }): MicGlyph {
  if (i.muted || i.deafened) return 'muted';
  return i.ptt && !i.talking ? 'ptt-idle' : 'live';
}

/** My server voice state as the workspaces store keeps it (VoiceState, aggregated per user). */
export interface SeatState {
  roomId: string;
  muted: boolean;
  deafened: boolean;
  serverMuted?: boolean;
  ptt?: boolean;
}

/**
 * Where a device of mine holds the voice seat by the server (docs/05 «Несколько устройств»: one
 * device in voice): my VoiceState in any workspace with a room, else null.
 */
export function mySeat(byId: Readonly<Record<string, { voice: Readonly<Record<string, SeatState>> } | undefined>>, me: string): SeatState | null {
  if (!me) return null;
  for (const id in byId) {
    const v = byId[id]?.voice[me];
    if (v?.roomId) return v;
  }
  return null;
}

/** My mic as every indicator draws it (#96): the self panel, my participant row, the island dot. */
export interface SelfMic {
  /** This device holds the call: the flags are its intent (ADR-0134: the track and the server follow). */
  here: boolean;
  /** Another device of mine (or a session the server still keeps) holds it: the flags are the server's. */
  elsewhere: boolean;
  /** Crossed mic: off, deafened (deafen implies mute) or muted by a moderator. */
  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  /** Push-to-talk mode in force (a one-to-one call is voice activation only, ADR-0034). */
  ptt: boolean;
}

/**
 * One source of truth for my own mic (#96). The panel used to draw this device's intent while my
 * row drew the server's copy, so they disagreed whenever the two differed: another device of mine
 * in the call (this one idle, the panel showing its pre-join intent), or the server echo lagging
 * the intent (ADR-0134). Now: this device in voice → its intent everywhere; else my server state
 * when a device of mine holds a seat; else the pre-join intent.
 */
export function selfMic(local: { inVoice: boolean; muted: boolean; deafened: boolean; serverMuted: boolean; ptt: boolean }, seat: SeatState | null): SelfMic {
  if (local.inVoice || !seat) {
    return { here: local.inVoice, elsewhere: false, muted: local.muted || local.deafened || local.serverMuted, deafened: local.deafened, serverMuted: local.serverMuted, ptt: local.ptt };
  }
  const serverMuted = seat.serverMuted === true;
  return { here: false, elsewhere: true, muted: seat.muted || seat.deafened || serverMuted, deafened: seat.deafened, serverMuted, ptt: seat.ptt === true };
}

/**
 * The glyph of my mic (CBF-71) from the one view: `talking` (the PTT key held) is known only where
 * this device holds the call; elsewhere a PTT mode is shown waiting.
 */
export function selfMicGlyph(m: SelfMic, pttDown: boolean): MicGlyph {
  return micGlyph({ muted: m.muted, deafened: m.deafened, ptt: m.ptt, talking: m.here && pttDown });
}

export interface TransmitInput extends SelfState {
  canSpeak: boolean;
  mode: 'voice' | 'ptt';
  gateOpen: boolean;
  pttDown: boolean;
  /** Musician mode (ADR-0052): voice activation does not gate the mic (quiet notes, tails). */
  musician?: boolean;
}

export interface TransmitDecision {
  /** LiveKit `track.mute()` — visible to others as "muted". */
  livekitMuted: boolean;
  /** `mediaStreamTrack.enabled` — silence without signalling. */
  audioEnabled: boolean;
  /** UI "on air" indicator. */
  transmitting: boolean;
  /** My «speaking» ring: on air and loud enough (the gate still judges the level in musician mode). */
  speaking: boolean;
}

export function transmitDecision(i: TransmitInput): TransmitDecision {
  const livekitMuted = i.muted || i.deafened || !i.canSpeak;
  const gate = i.mode === 'voice' ? i.gateOpen : i.pttDown;
  // Musician + voice activation: an open mic; the gate only drives the ring. PTT stays PTT.
  const open = i.musician === true && i.mode === 'voice' ? true : gate;
  return { livekitMuted, audioEnabled: open, transmitting: !livekitMuted && open, speaking: !livekitMuted && gate };
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

/**
 * getUserMedia failed because the chosen device is gone (unplugged / id changed) or does not
 * start (NotReadableError; AbortError — Chromium's «Timeout starting audio source», issue #322):
 * the default device is worth a try.
 */
export function isDeviceGone(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : null;
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError' || name === 'AbortError';
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
