import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { VoiceMute } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { choiceOf, loadMuteRecord, resolveMute, sameChoice, saveMuteRecord, stateOf, type MuteChoice, type MuteKV, type ServerMute } from '../lib/voiceMuteMemory';
import { myUserId, useSession } from '../stores/session';
import { setVoice, useVoice } from '../stores/voice';

/**
 * The user's mic / sound choice survives the session and follows them to another device
 * (ADR-0168, CBF-180). Written only by the user's own clicks (services/voice toggleMute /
 * toggleDeafen) — never by a moderator mute, the auto-mute or answering a call — to a local copy
 * at once and to the server (PUT /api/me/voice-mute) after a short pause, one request in flight.
 * Read back at READY / USER_UPDATE while this device is out of voice, and from the /join answer of
 * a fresh room join before the mic is published (services/voice connectOnce), so a device never
 * starts with an open mic the user had closed. Push-to-talk is not part of it (per device).
 * No timers while idle; no store write unless the state really changes.
 */

/** A burst of clicks becomes one request. */
const PUSH_DELAY_MS = 600;

let timer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;

function storage(): MuteKV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function serverMute(vm: VoiceMute | undefined): ServerMute | null {
  if (!vm?.updatedAt) return null;
  return { muted: vm.muted, deafened: vm.deafened, at: timestampMs(vm.updatedAt) };
}

/** The user's own click changed the mic or the sound: remember it here and send it. */
export function rememberVoiceMute(): void {
  const userId = myUserId();
  if (!userId) return;
  const store = storage();
  const prev = loadMuteRecord(store, userId);
  const choice = choiceOf(useVoice.getState(), prev);
  if (prev && !prev.dirty && sameChoice(prev, choice)) return;
  saveMuteRecord(store, { userId, ...choice, dirty: true, at: prev?.at ?? 0 });
  schedulePush(PUSH_DELAY_MS);
}

function schedulePush(ms: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void push();
  }, ms);
}

async function push(): Promise<void> {
  if (pushing) return; // the one in flight sends the newer value after it
  const userId = myUserId();
  const store = storage();
  const rec = loadMuteRecord(store, userId);
  if (!rec?.dirty || useSession.getState().status !== 'authed') return;
  pushing = true;
  let ok = false;
  try {
    const res = await api.me.setVoiceMute({ muted: rec.muted, deafened: rec.deafened });
    ok = true;
    const now = loadMuteRecord(store, userId);
    if (now) {
      const at = res.updatedAt ? timestampMs(res.updatedAt) : 0;
      saveMuteRecord(store, { ...now, dirty: now.dirty && !sameChoice(now, rec), at: Math.max(now.at, at) });
    }
  } catch (e) {
    // Stays dirty: the next READY (connection back) or click sends it.
    log.warn('voice mute: store failed', e);
  } finally {
    pushing = false;
  }
  if (ok && loadMuteRecord(store, userId)?.dirty) schedulePush(0);
}

/** Resolves the server's value against the local copy; keeps the result and sends a pending click. */
function resolve(vm: VoiceMute | undefined): MuteChoice | null {
  const userId = myUserId();
  if (!userId) return null;
  const store = storage();
  const d = resolveMute(loadMuteRecord(store, userId), serverMute(vm), userId);
  if (d.record) saveMuteRecord(store, d.record);
  if (d.push) schedulePush(0);
  return d.apply;
}

function apply(c: MuteChoice | null): void {
  if (!c) return;
  const v = useVoice.getState();
  const next = stateOf(c, v.serverMuted);
  if (v.muted === next.muted && v.deafened === next.deafened && v.mutedBeforeDeafen === next.mutedBeforeDeafen) return;
  setVoice(next);
}

/**
 * READY / USER_UPDATE {me}: the stored choice. Applied only while this device is out of voice —
 * in voice this device is the active one and its own state stands (one device in voice, docs/05).
 */
export function applyServerVoiceMute(vm: VoiceMute | undefined): void {
  const c = resolve(vm);
  const v = useVoice.getState();
  if (v.roomId !== null || v.joining !== null) return;
  apply(c);
}

/**
 * The /join answer of a fresh room join (JoinVoiceResponse.self_mute), before the mic is
 * published: the first state the others see is already the stored one. Without a server value
 * (an older server) the local copy stands in.
 */
export function voiceMuteAtJoin(vm: VoiceMute | undefined): void {
  apply(resolve(vm));
}
