import { AUTO_MUTE_OPTIONS } from '../../lib/autoMute';
import { usePrefs, type MicMode } from '../../stores/prefs';

/** Radix radio values of the mic ▾ «Режим» section (docs/09 #28). */
export const MIC_MODES: readonly MicMode[] = ['voice', 'ptt'];

/**
 * Mic ▾ / mobile «Ещё» → «Режим»: the same pref as Settings → «Голос и устройства»; the profile
 * sync (services/profile.ts) pushes it and voice re-binds the PTT key. Unknown values are ignored.
 */
export function selectMicMode(value: string): void {
  const mode = MIC_MODES.find((m) => m === value);
  if (!mode || usePrefs.getState().micMode === mode) return;
  usePrefs.getState().setPrefs({ micMode: mode });
}

/**
 * Mic ▾ «Выключать, если я молчу» submenu / Settings → «Голос и устройства» (lib/autoMute.ts): the
 * radio value is the period in seconds as a string; unknown values are ignored.
 */
export function selectAutoMute(value: string): void {
  const sec = AUTO_MUTE_OPTIONS.find((o) => String(o) === value);
  if (sec === undefined || usePrefs.getState().autoMuteSec === sec) return;
  usePrefs.getState().setPrefs({ autoMuteSec: sec });
}

/**
 * Keys typed while a capture is armed belong to the capture, not to the menu: no typeahead, no
 * Enter/Space selecting the highlighted item. Also for a short tail after it ends — main's
 * answer can overtake the DOM keydown of the very key that was bound.
 */
export const CAPTURE_KEY_TAIL_MS = 300;

export function swallowMenuKey(capturing: boolean, endedAt: number, now: number): boolean {
  return capturing || now - endedAt < CAPTURE_KEY_TAIL_MS;
}
