import { parseResumeVoice, type ResumeVoice, type ResumeVoiceSeat } from '../../shared/resumeVoice';

/**
 * The web client's side of «back into the same room after an update» (docs/09 #126) and of
 * «the mic / deafen state survives a reload». A browser has no main process to keep the seat
 * across a restart, so it lives in this tab's sessionStorage: it survives the reload of the same
 * tab, dies with the tab, and is never shared with another tab or device. Pure: the storage is
 * passed in (platform/web.ts and services/resumeVoice.ts hand `sessionStorage`), every access is
 * guarded (private mode, blocked site data, a full quota) — a failure means «nothing stored».
 */

/** One-shot seat written right before the update reload («Обновить страницу»). */
export const WEB_RESUME_KEY = 'calab-resume-voice';
/** The mic / deafen state written when the page goes away (any reload). */
export const WEB_SELF_KEY = 'calab-voice-self';
/** The web reload is instant: a seat older than this is stale (a crashed / restored tab) — no join. */
export const WEB_RESUME_WINDOW_MS = 2 * 60_000;

/** The part of Storage this module uses (sessionStorage; a fake in unit tests). */
export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function read(store: KV | null, key: string): unknown {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    store.removeItem(key);
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function write(store: KV | null, key: string, value: unknown): void {
  if (!store) return;
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable / full: nothing kept, the reload starts clean
  }
}

/** Keeps the seat for the reload that follows (null clears it). */
export function saveWebResume(store: KV | null, seat: ResumeVoiceSeat | null, serverUrl: string, now: number): void {
  const rec: ResumeVoice | null = seat ? { ...seat, serverUrl, at: now } : null;
  write(store, WEB_RESUME_KEY, rec);
}

/** The seat left by the update reload, once (removed on read); null when absent, malformed or stale. */
export function takeWebResume(store: KV | null, now: number): ResumeVoice | null {
  const rec = parseResumeVoice(read(store, WEB_RESUME_KEY));
  if (!rec) return null;
  // The shared decideResume allows 5 min (an installer's restart); a reload takes seconds.
  if (now - rec.at > WEB_RESUME_WINDOW_MS) return null;
  return rec;
}

/** My mic / deafen state, kept across a reload of this tab. */
export interface VoiceSelf {
  userId: string;
  muted: boolean;
  deafened: boolean;
  mutedBeforeDeafen: boolean;
}

/** Stores the state when it is not the default (muted or deafened); the default clears it. */
export function saveVoiceSelf(store: KV | null, s: VoiceSelf): void {
  write(store, WEB_SELF_KEY, s.userId && (s.muted || s.deafened) ? s : null);
}

/** The state stored for this user, once; null for another user or a malformed record. */
export function takeVoiceSelf(store: KV | null, userId: string): VoiceSelf | null {
  const v = read(store, WEB_SELF_KEY);
  if (!userId || typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r['userId'] !== userId) return null;
  const deafened = r['deafened'] === true;
  return { userId, muted: r['muted'] === true || deafened, deafened, mutedBeforeDeafen: deafened && r['mutedBeforeDeafen'] === true };
}

/** The session's tab storage, or null where the accessor throws (blocked site data). */
export function tabStorage(): KV | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** A few samples of silence: the autoplay probe's source (an <audio>, never WebAudio — docs/02). */
const SILENT_WAV = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';
const PROBE_TIMEOUT_MS = 1000;

/**
 * May this page play sound without a click? After a reload there is no user gesture: Chromium
 * carries the activation over a same-origin reload, Safari / Firefox may not — then the rejoined
 * room would be silent (LiveKit's <audio> play() is refused) with no sign of it. An audible
 * (unmuted, volume 1) element of silence answers it: play() is refused with NotAllowedError when
 * blocked. Any other outcome (no codec, no answer in 1 s) counts as allowed — the probe only
 * guards against the policy refusal.
 */
export function canAutoplayAudio(make: () => HTMLAudioElement = () => new Audio()): Promise<boolean> {
  let el: HTMLAudioElement;
  try {
    el = make();
    el.src = SILENT_WAV;
  } catch {
    return Promise.resolve(true);
  }
  const done = (ok: boolean): boolean => {
    try {
      el.pause();
      el.removeAttribute('src');
    } catch {
      // ignore
    }
    return ok;
  };
  let played: Promise<boolean>;
  try {
    played = Promise.resolve(el.play()).then(
      () => true,
      (e: unknown) => (e as { name?: unknown } | null)?.name !== 'NotAllowedError',
    );
  } catch {
    return Promise.resolve(done(true));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), PROBE_TIMEOUT_MS);
  });
  return Promise.race([played, timeout]).then((ok) => {
    clearTimeout(timer);
    return done(ok);
  });
}
