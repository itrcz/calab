import type { MessageKey } from '../i18n/types';
import type { Timers } from './speaking';

/**
 * «Выключать микрофон, если я молчу» (docs/02-media.md, «Автовыключение микрофона»): for those who
 * forget the mic on. After N seconds of my own silence — the local VAD gate that lights my ring,
 * no extra analyser — the mic is muted exactly like the mute button. Pure logic, no React / LiveKit:
 * one timeout, (re)started on the speech → silence edge and on arming; no polling, no store state.
 */

/** The choices, seconds; 0 = off (the default). */
export const AUTO_MUTE_OPTIONS = [0, 30, 60, 300, 600] as const;
export type AutoMuteSec = (typeof AUTO_MUTE_OPTIONS)[number];
export const AUTO_MUTE_DEFAULT: AutoMuteSec = 0;

/** A stored value → one of the options (anything else is off). */
export function normalizeAutoMute(v: unknown): AutoMuteSec {
  return AUTO_MUTE_OPTIONS.find((o) => o === v) ?? AUTO_MUTE_DEFAULT;
}

/** Short option label (menu / settings). */
export const AUTO_MUTE_LABEL: Record<AutoMuteSec, MessageKey> = {
  0: 'autoMute.off',
  30: 'autoMute.s30',
  60: 'autoMute.m1',
  300: 'autoMute.m5',
  600: 'autoMute.m10',
};

/** The toast after it fired («…: вы молчали 5 минут»). */
export const AUTO_MUTE_TOAST: Record<Exclude<AutoMuteSec, 0>, MessageKey> = {
  30: 'autoMute.toast30',
  60: 'autoMute.toast60',
  300: 'autoMute.toast300',
  600: 'autoMute.toast600',
};

export interface AutoMuteArmInput {
  /** In a voice room / call with my mic published here (not the native call audio: no local VAD there). */
  live: boolean;
  /** The mic mode in force: PTT is off unless the key is held — nothing to forget. */
  mode: 'voice' | 'ptt';
  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  canSpeak: boolean;
}

/** The timer may run: a live, open mic in voice activation. */
export function autoMuteArmed(i: AutoMuteArmInput): boolean {
  return i.live && i.mode === 'voice' && !i.muted && !i.deafened && !i.serverMuted && i.canSpeak;
}

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/**
 * The silence timer. `update` is called on every input change (gate edge, mute, mode, setting):
 * it runs only while armed, enabled and silent; speech clears it, and the next silence starts it
 * from the full period. A change of the period restarts it. It fires once, then waits for the
 * caller to disarm it (muting does).
 */
export class AutoMuteTimer {
  private timer: number | null = null;
  private sec: number = 0;

  constructor(
    private readonly onExpire: (sec: Exclude<AutoMuteSec, 0>) => void,
    private readonly timers: Timers = windowTimers,
  ) {}

  update(armed: boolean, speaking: boolean, sec: AutoMuteSec): void {
    if (!armed || speaking || sec === 0) {
      this.cancel();
      return;
    }
    if (this.timer !== null && this.sec === sec) return; // silence goes on: keep counting
    this.cancel();
    this.sec = sec;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.onExpire(sec);
    }, sec * 1000);
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
