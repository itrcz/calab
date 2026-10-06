import { isWeb } from '../platform';
import { MOBILE_QUERY } from './phone';
import { useMediaQuery } from './useMediaQuery';

/**
 * Mobile web layout (ADR-0021, stage A): the web client at ≤ 768 px (lib/phone.ts). Electron never
 * gets it (its minimum window is 960 px, and the check is web-only anyway). CSS uses the same
 * condition through the `mobile:` variant (app/styles.css: `:root.web` + the media query).
 */
export { MOBILE_MAX, MOBILE_QUERY, autoFocusAllowed } from './phone';

/** True on the web client in the one-column phone layout. */
export function useMobile(): boolean {
  const narrow = useMediaQuery(MOBILE_QUERY);
  return isWeb && narrow;
}

/** Same as useMobile, outside React (event handlers, services). */
export function isMobileNow(): boolean {
  return isWeb && typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
}

/** The on-screen keyboard is taken as open when the visual viewport is this much shorter than the layout one. */
const KEYBOARD_MIN_PX = 120;
/** iOS animates the keyboard away and may report the final viewport late (or not at all): re-check then. */
const KEYBOARD_SETTLE_MS = [120, 400];
/**
 * iOS home-screen web app: at most this much shorter than the screen is taken as WebKit's
 * standalone viewport bug (the status bar and / or home-indicator inset subtracted), not a real
 * window (an iPad Stage Manager window is narrower anyway).
 */
const STANDALONE_MAX_SHORTFALL_PX = 100;
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image']);

/** A text field — the only thing that raises the on-screen keyboard — has the focus. */
function editableFocused(): boolean {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement)) return false;
  if (a.isContentEditable || a instanceof HTMLTextAreaElement) return true;
  return a instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(a.type);
}

/**
 * Opened from the home screen (an installed PWA / iOS «На экран Домой»): no browser toolbars, so
 * nothing below the app but the home indicator (env(safe-area-inset-bottom)).
 */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * The full screen height (CSS px) of an iOS home-screen web app when WebKit reports a shorter
 * viewport, else null. Standalone with `viewport-fit=cover` + the black-translucent status bar the
 * page covers the whole screen, but WebKit may size the viewport (100dvh, innerHeight) short by
 * the status bar / home-indicator inset, which leaves an empty band at the bottom of the screen.
 * iOS only (`navigator.standalone`); only for a full-width window; screen.* are portrait on iOS.
 */
function standaloneFullHeight(): number | null {
  if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return null;
  const { width, height } = window.screen;
  const portrait = window.innerWidth < window.innerHeight;
  const w = portrait ? Math.min(width, height) : Math.max(width, height);
  const h = portrait ? Math.max(width, height) : Math.min(width, height);
  if (Math.abs(window.innerWidth - w) > 1) return null;
  const short = h - window.innerHeight;
  return short > 0 && short <= STANDALONE_MAX_SHORTFALL_PX ? h : null;
}

/**
 * Keeps the app inside the visible screen on phones (web only), iOS Safari included:
 *  - without the keyboard the shell is `100dvh` tall (app/styles.css): the browser's dynamic
 *    viewport, which follows Safari's toolbars. visualViewport is not used then — on iOS it can
 *    stay stale after the keyboard closes and leave an empty band at the bottom of the screen;
 *  - while the keyboard is up (a text field focused *and* the visual viewport shorter than the
 *    layout one) <html> gets `kb-open` and `--app-height` = visualViewport.height, so the
 *    composer sits right above the keyboard, and `--kb-inset` = the part of the layout viewport
 *    the keyboard covers, which keeps the centred cards (position: fixed) above it; the voice
 *    strip hides and the bottom safe-area inset drops to 0 (the keyboard covers the home bar);
 *  - iOS scrolls the whole document to reveal a focused field even when nothing overflows, and
 *    leaves it scrolled after the keyboard closes (content shifted up, a gap under it): the
 *    document is always scrolled back to the top — the shell fits the screen, only the feed scrolls;
 *  - standalone (home screen, <html> gets `pwa-standalone`) there are no toolbars: the shell stays
 *    `100dvh`, unless iOS reports a viewport shorter than the screen (standaloneFullHeight) — then
 *    `--app-height` = the screen height, so no empty band is left under the composer / voice strip.
 * Chrome on Android resizes the layout viewport itself (`interactive-widget=resizes-content`), so
 * the keyboard branch never triggers there. Returns the uninstall function.
 */
export function installVisualViewport(): () => void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return () => undefined;
  let frame = 0;
  let standalone = false;
  const displayMode = window.matchMedia('(display-mode: standalone)');
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const apply = (): void => {
    frame = 0;
    const mobile = isMobileNow();
    const kb = mobile && editableFocused() && window.innerHeight - vv.height > KEYBOARD_MIN_PX;
    root.classList.toggle('kb-open', kb);
    if (kb) {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--kb-inset', `${Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))}px`);
    } else {
      const full = mobile && standalone ? standaloneFullHeight() : null;
      if (full) root.style.setProperty('--app-height', `${full}px`);
      else root.style.removeProperty('--app-height');
      root.style.removeProperty('--kb-inset');
    }
    if (mobile && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  /** Installed / opened from the home screen while running (display-mode changes). */
  const onDisplayMode = (): void => {
    standalone = isStandalone();
    root.classList.toggle('pwa-standalone', standalone);
    schedule();
  };
  /** A focus move raises / drops the keyboard: re-check now and once it has finished animating. */
  const settle = (): void => {
    schedule();
    for (const ms of KEYBOARD_SETTLE_MS) {
      const id = setTimeout(() => {
        timers.delete(id);
        schedule();
      }, ms);
      timers.add(id);
    }
  };
  standalone = isStandalone();
  root.classList.toggle('pwa-standalone', standalone);
  apply();
  displayMode.addEventListener('change', onDisplayMode);
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('orientationchange', settle);
  document.addEventListener('focusin', settle);
  document.addEventListener('focusout', settle);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    for (const id of timers) clearTimeout(id);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', settle);
    document.removeEventListener('focusin', settle);
    document.removeEventListener('focusout', settle);
    displayMode.removeEventListener('change', onDisplayMode);
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--kb-inset');
    root.classList.remove('kb-open', 'pwa-standalone');
  };
}

const SHEET = '[data-radix-popper-content-wrapper]';

/**
 * Menus open as centred cards on phones (app/styles.css), so a card often appears right under the
 * finger that opened it (📎 at the bottom edge, a long-press). Radix menu items select on a
 * pointer-up that started elsewhere (press–drag–release on desktop) and on click — and a tap's
 * click is hit-tested where the finger was, i.e. on the item that just slid in under it. So on
 * phones the pointer-up / click of a press that began outside any menu or popover is swallowed
 * when it lands inside one: an item is chosen only by its own tap. Keyboard activation (a
 * synthetic click, detail 0) is never touched. Returns the uninstall function.
 */
export function installSheetGuard(): () => void {
  /** The current press began outside every sheet (and when). */
  let outside: { at: number } | null = null;
  const inSheet = (t: EventTarget | null): boolean => t instanceof Element && t.closest(SHEET) !== null;
  const onDown = (e: PointerEvent): void => {
    outside = inSheet(e.target) ? null : { at: e.timeStamp };
  };
  const guard = (e: MouseEvent): void => {
    if (!outside || e.timeStamp - outside.at > GESTURE_MS || !isMobileNow()) return;
    if (e.type === 'click' && e.detail === 0) return;
    // A touch pointer-up keeps the press target (implicit capture); look at what is under it.
    if (!inSheet(e.target) && !inSheet(document.elementFromPoint(e.clientX, e.clientY))) return;
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', guard, true);
  window.addEventListener('click', guard, true);
  return () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', guard, true);
    window.removeEventListener('click', guard, true);
  };
}
/** A tap's pointer-up and click follow its press within this (a long-press opens a menu at 700 ms). */
const GESTURE_MS = 1500;

/** Short haptic tick where the browser has one (Android Chrome; iOS Safari has no Vibration API). */
export function haptic(ms = 10): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    // Some browsers throw without a user activation: haptics are best effort.
  }
}

/**
 * PWA service worker (install-only: no fetch handler, no cache — the app is always fresh from the
 * network). Registered on the production web build only, after load.
 */
export function registerServiceWorker(): void {
  if (!isWeb || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const go = (): void => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
