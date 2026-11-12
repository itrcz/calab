import type { SelfState } from './voiceLogic';

/**
 * The user's own mic / sound choice carried to the next voice session (ADR-0168, CBF-180). Pure:
 * services/voiceMute.ts wires it to the store, the server and localStorage.
 *
 * On the wire (VoiceMute) `muted` is the user's mic choice — while deafened, the mic as it was
 * before deafen — and `deafened` always means the mic is off too (lib/voiceLogic toggleDeafen).
 */
export interface MuteChoice {
  muted: boolean;
  deafened: boolean;
}

/** The copy kept on this device for one user (works offline and at startup). */
export interface MuteRecord extends MuteChoice {
  userId: string;
  /** A click on this device the server has not acknowledged yet: it wins over the server's value and is sent. */
  dirty: boolean;
  /** Server time (ms) of the newest stored value this device has seen; 0 = none. */
  at: number;
}

/** The stored value as the server has it (UserSettings.voice_mute / JoinVoiceResponse.self_mute). */
export interface ServerMute extends MuteChoice {
  at: number;
}

export const VOICE_MUTE_KEY = 'calab-voice-mute';

/** The part of Storage used here (localStorage; a fake in unit tests). */
export type MuteKV = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The user's choice after their own click. A moderator mute is not a choice (ADR-0168): while it
 * holds, the mic part stays what the user had chosen before, only deafen follows the click.
 */
export function choiceOf(s: SelfState & { serverMuted?: boolean }, prev: MuteChoice | null): MuteChoice {
  if (s.serverMuted === true) return { muted: prev?.muted ?? false, deafened: s.deafened };
  return { muted: s.deafened ? s.mutedBeforeDeafen === true : s.muted, deafened: s.deafened };
}

/**
 * The store's mic / deafen for a stored choice (Discord semantics: deafen ⇒ the mic off, undeafen
 * returns to the mic as it was). A moderator mute still in force keeps the mic off.
 */
export function stateOf(c: MuteChoice, serverMuted = false): Required<SelfState> {
  return { muted: c.muted || c.deafened || serverMuted, deafened: c.deafened, mutedBeforeDeafen: c.deafened && c.muted };
}

export function sameChoice(a: MuteChoice, b: MuteChoice): boolean {
  return a.muted === b.muted && a.deafened === b.deafened;
}

export interface MuteResolution {
  /** The choice the store should hold (null = leave the store as it is). */
  apply: MuteChoice | null;
  /** The new local record to keep (null = unchanged). */
  record: MuteRecord | null;
  /** The local click still has to reach the server. */
  push: boolean;
}

/**
 * Local copy vs the server's value — last writer wins by the server's clock, without comparing
 * device clocks:
 *  - a click here the server has not acknowledged (dirty) is the newest thing this device knows:
 *    it stays and is sent;
 *  - otherwise the server's value wins unless it is older than one this device has already seen
 *    (a late echo of an earlier write);
 *  - no server value (never chosen, an older server, offline): the local copy.
 */
export function resolveMute(local: MuteRecord | null, server: ServerMute | null, userId: string): MuteResolution {
  if (local?.dirty) return { apply: { muted: local.muted, deafened: local.deafened }, record: null, push: true };
  if (server && (!local || server.at >= local.at)) {
    const record: MuteRecord = { userId, muted: server.muted, deafened: server.deafened, dirty: false, at: server.at };
    const changed = !local || !sameChoice(local, server) || local.at !== server.at;
    return { apply: { muted: server.muted, deafened: server.deafened }, record: changed ? record : null, push: false };
  }
  return { apply: local ? { muted: local.muted, deafened: local.deafened } : null, record: null, push: false };
}

/** This user's record, or null (none, another user's, malformed, storage blocked). */
export function loadMuteRecord(store: MuteKV | null, userId: string): MuteRecord | null {
  if (!store || !userId) return null;
  try {
    const raw = store.getItem(VOICE_MUTE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    if (r['userId'] !== userId) return null;
    const at = typeof r['at'] === 'number' && Number.isFinite(r['at']) ? r['at'] : 0;
    return { userId, muted: r['muted'] === true, deafened: r['deafened'] === true, dirty: r['dirty'] === true, at };
  } catch {
    return null;
  }
}

export function saveMuteRecord(store: MuteKV | null, rec: MuteRecord): void {
  if (!store) return;
  try {
    store.setItem(VOICE_MUTE_KEY, JSON.stringify(rec));
  } catch {
    // storage unavailable / full: the server copy still carries the choice
  }
}
