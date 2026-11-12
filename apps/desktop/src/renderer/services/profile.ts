import { create } from '@bufbuild/protobuf';
import { MicMode, UserSettingsSchema, type UserSettings } from '@calaba/protocol';
import type { PttBinding } from '../../shared/ipc';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { prefs, usePrefs } from '../stores/prefs';
import { platform } from '../platform';
import { useSession } from '../stores/session';
import { applyServerVoiceMute } from './voiceMute';

/**
 * UserSettings (synced across the user's devices, USER_UPDATE on change) ↔ local prefs.
 * The server fills defaults for new users (RNNoise off since migration 00025, VAD). push_to_talk_key is
 * client-defined: we store the uiohook binding as JSON.
 */
let applying = false;

/**
 * push_to_talk_key holds one binding per platform: `{"desktop": …, "web": …}` — a desktop
 * uiohook keycode means nothing in a browser and vice versa. A bare binding (older client)
 * is read as the desktop one.
 */
type SyncedBindings = { desktop?: PttBinding; web?: PttBinding };
let synced: SyncedBindings = {};
const mine = (): keyof SyncedBindings => (platform.kind === 'web' ? 'web' : 'desktop');

export function parseBindings(raw: string): SyncedBindings {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as SyncedBindings | PttBinding;
    if ('kind' in v) return { desktop: v };
    return v;
  } catch {
    return {};
  }
}

/** Same key, kind, mode and remap (the label is derived from the code). */
export function sameBinding(a: PttBinding | null | undefined, b: PttBinding | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const remap = (x: PttBinding): string => (x.kind === 'key' ? (x.remap ?? '') : '');
  return a.kind === b.kind && a.code === b.code && (a.mode ?? 'hold') === (b.mode ?? 'hold') && remap(a) === remap(b);
}

export function applyUserSettings(s: UserSettings): void {
  applying = true;
  synced = parseBindings(s.pushToTalkKey);
  const own = synced[mine()];
  const fits = own && (platform.kind === 'web' ? own.kind === 'dom' : own.kind !== 'dom');
  const current = prefs().pttBinding;
  // Every READY / USER_UPDATE (incl. the echo of our own PATCH) parses a new object: keep the
  // current one when nothing changed, else PTT is re-bound and cut mid-speech (review M5).
  const binding: PttBinding | null = fits && !sameBinding(own, current) ? own : current;
  usePrefs.getState().setPrefs({
    rnnoise: s.noiseSuppression,
    red: s.unstableNetworkRed,
    ...micModeFromServer(prefs(), s.micMode),
    pttBinding: binding,
    personalBitrateKbps: s.audioBitrateKbps ?? null,
  });
  applying = false;
  // ADR-0168: the stored mic / sound choice (only outside voice on this device; services/voiceMute).
  applyServerVoiceMute(s.voiceMute);
}

/**
 * Push-to-talk vs voice activation is per device (owner, CBF-180: one device in PTT, another not).
 * The server's mic_mode — the mode last chosen on any device — seeds only a device without its
 * own (a new install; an older client's copy, which was synced, on its first READY after the
 * update); after that the device keeps its mode and the server's never overrides it.
 */
export function micModeFromServer(p: { micMode: 'voice' | 'ptt'; micModeLocal: boolean }, server: MicMode): { micMode?: 'voice' | 'ptt'; micModeLocal?: true } {
  if (p.micModeLocal) return {};
  return { micMode: server === MicMode.PUSH_TO_TALK ? 'ptt' : 'voice', micModeLocal: true };
}

function snapshot(): UserSettings {
  const p = prefs();
  return create(UserSettingsSchema, {
    noiseSuppression: p.rnnoise,
    unstableNetworkRed: p.red,
    micMode: p.micMode === 'ptt' ? MicMode.PUSH_TO_TALK : MicMode.VAD,
    pushToTalkKey: JSON.stringify({ ...synced, [mine()]: p.pttBinding ?? undefined }),
    ...(p.personalBitrateKbps !== null ? { audioBitrateKbps: p.personalBitrateKbps } : {}),
  });
}

let timer: number | null = null;

function pushNow(): void {
  void api.me.update({ settings: snapshot() }).then(
    (r) => {
      if (r.me) useSession.getState().set({ me: r.me });
    },
    (e: unknown) => log.warn('settings sync failed', e),
  );
}

/** Debounced PATCH /api/me {settings} whenever a synced pref changes locally. */
export function watchSyncedPrefs(): void {
  usePrefs.subscribe((s, p) => {
    if (applying) return;
    if (
      s.rnnoise === p.rnnoise &&
      s.red === p.red &&
      s.micMode === p.micMode &&
      s.pttBinding === p.pttBinding &&
      s.personalBitrateKbps === p.personalBitrateKbps
    ) {
      return;
    }
    if (useSession.getState().status !== 'authed') return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      pushNow();
    }, 800);
  });
}
