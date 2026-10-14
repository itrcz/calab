import { usePrefs } from '../stores/prefs';
import { MOBILE_QUERY } from './phone';

/**
 * Haptic feedback on phones (docs/08 «Мобильный веб» → «Тактильный отклик»), by intent rather than
 * by duration:
 *  - `tap`    — a light tick: a tab switch, a press;
 *  - `select` — a choice in a list / segmented control;
 *  - `impact` — a threshold: a swipe crossing its settle point, a menu opened by a long press;
 *  - `toggle` — a switch, the mic / headphones, push-to-talk (on is a little firmer than off).
 * Where it comes from, first available wins:
 *  1. the native shell's bridge (`window.CalabHostActivity.haptic`, apps/mobile, ADR-0067) — an
 *     extension point: no shell implements it yet;
 *  2. the Vibration API (`navigator.vibrate`: Android Chrome / WebView);
 *  3. iOS 17.4+ Safari / WKWebView has no Vibration API, but toggling an `<input type="checkbox"
 *     switch>` plays the system haptic, also when its label is clicked from script inside a user
 *     gesture: one hidden, off-screen switch is kept for that.
 * Everything is best effort (feature-detected, try/catch) and a no-op off the phone layout (the
 * desktop, unit tests) and when «Виброотклик» is off (`prefs.haptics`).
 * No lib/mobile import: components/ui.tsx calls this and is loaded by Node unit tests.
 */

export type HapticIntent = 'tap' | 'select' | 'impact' | 'toggleOn' | 'toggleOff';

/** Vibration API patterns, ms. Short: anything longer reads as a notification buzz, not a tick. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticIntent, number>> = {
  tap: 10,
  select: 8,
  impact: 18,
  toggleOn: 12,
  toggleOff: 6,
};

/** Two requests closer than this are one (a control and its row reacting to the same tap). */
export const HAPTIC_DEDUPE_MS = 40;

export interface HapticEnv {
  /** The phone layout is on (web client, ≤ 768 px). */
  mobile(): boolean;
  /** «Виброотклик» is on. */
  enabled(): boolean;
  now(): number;
  /** Native shell bridge; true = handled. */
  native?(intent: HapticIntent): boolean;
  /** Vibration API; undefined = unsupported. */
  vibrate?(ms: number): void;
  /** iOS switch trick; false = unsupported. */
  iosSwitch?(): boolean;
}

export interface Haptics {
  tap(): void;
  select(): void;
  impact(): void;
  toggle(on: boolean): void;
}

export function createHaptics(env: HapticEnv): Haptics {
  let last = -Infinity;
  const play = (intent: HapticIntent): void => {
    try {
      if (!env.mobile() || !env.enabled()) return;
      const now = env.now();
      if (now - last < HAPTIC_DEDUPE_MS) return;
      last = now;
      if (env.native?.(intent)) return;
      if (env.vibrate) {
        env.vibrate(HAPTIC_PATTERNS[intent]);
        return;
      }
      env.iosSwitch?.();
    } catch {
      // Best effort: a browser may throw (no user activation, a policy); nothing to recover.
    }
  };
  return {
    tap: () => play('tap'),
    select: () => play('select'),
    impact: () => play('impact'),
    toggle: (on) => play(on ? 'toggleOn' : 'toggleOff'),
  };
}

// ---------------------------------------------------------------- the browser environment

type NativeHaptic = { haptic?: (intent: string) => unknown };

/** The hidden switch (created on first use); null = this WebKit has no `switch` checkbox. */
let switchLabel: HTMLLabelElement | null | undefined;

function iosSwitch(): boolean {
  if (switchLabel === undefined) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    if (!('switch' in input)) {
      switchLabel = null;
      return false;
    }
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.setAttribute('data-haptics', '');
    // Rendered (WebKit plays nothing for display:none) but off-screen, invisible and untouchable.
    const hide = 'position:fixed;left:-100px;top:0;width:1px;height:1px;margin:0;overflow:hidden;opacity:0;pointer-events:none;';
    label.style.cssText = hide;
    input.style.cssText = hide;
    label.append(input);
    document.body.append(label);
    switchLabel = label;
  }
  if (!switchLabel) return false;
  const input = switchLabel.firstElementChild;
  const before = document.activeElement;
  // A label click focuses its control (WebKit): the focus moves are hidden from the app, and the
  // focus is given back — an open menu (Radix dismisses a layer on a focus outside it) stays open.
  const hideFocus = (e: FocusEvent): void => {
    if (e.target === input || e.relatedTarget === input) e.stopImmediatePropagation();
  };
  window.addEventListener('focusin', hideFocus, true);
  window.addEventListener('focusout', hideFocus, true);
  try {
    switchLabel.click();
    if (document.activeElement === input && before instanceof HTMLElement) before.focus({ preventScroll: true });
  } finally {
    window.removeEventListener('focusin', hideFocus, true);
    window.removeEventListener('focusout', hideFocus, true);
  }
  return true;
}

function browserEnv(): HapticEnv {
  const vibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  return {
    mobile: () => document.documentElement.classList.contains('web') && window.matchMedia(MOBILE_QUERY).matches,
    enabled: () => usePrefs.getState().haptics,
    now: () => performance.now(),
    native: (intent) => {
      const bridge = window.CalabHostActivity as NativeHaptic | undefined;
      if (typeof bridge?.haptic !== 'function') return false;
      bridge.haptic(intent);
      return true;
    },
    ...(vibrate
      ? {
          vibrate: (ms: number) => {
            // Chrome logs an intervention for a vibrate before any user gesture: skip it then.
            // Older WebViews have no userActivation: then just try.
            if ('userActivation' in navigator && !navigator.userActivation.hasBeenActive) return;
            navigator.vibrate(ms);
          },
        }
      : {}),
    iosSwitch,
  };
}

const NOOP: Haptics = { tap: () => undefined, select: () => undefined, impact: () => undefined, toggle: () => undefined };

/** The app's haptics (a no-op without a DOM). */
export const haptics: Haptics = typeof window === 'undefined' || typeof document === 'undefined' ? NOOP : createHaptics(browserEnv());
