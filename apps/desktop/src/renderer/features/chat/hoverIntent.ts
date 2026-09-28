import { QUICK_REACTIONS } from './emoji';

/**
 * Pure logic of the message hover bar (docs/09 #47): the hover-intent timer and the quick
 * reactions it offers. Kept out of the component so it can be unit-tested.
 */

/** The bar appears this long after the pointer settles on a message (not on a fly-over). */
export const HOVER_DELAY_MS = 150;

/** …and stays this long after the pointer leaves, so it can travel to the bar (docs/09 #74). */
export const HIDE_DELAY_MS = 200;

/** While the feed scrolls no bar shows; it may appear this long after the last scroll. */
export const SCROLL_QUIET_MS = 150;

/** Quick reactions in the bar. */
export const BAR_REACTIONS = 4;

/** Recently used emoji first (Discord's «frequently used»), topped up with the defaults. */
export function quickReactions(recent: readonly string[], n = BAR_REACTIONS, defaults: readonly string[] = QUICK_REACTIONS): string[] {
  const out: string[] = [];
  for (const e of [...recent, ...defaults]) {
    if (out.length >= n) break;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export interface Timers {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export interface HoverIntent {
  /** Pointer entered the message (the bubble, the bar or the bridge between them). */
  enter(): void;
  /** Pointer left: hide after the hide delay unless it comes back or a popover holds the bar. */
  leave(): void;
  /** Primary button pressed on the message: a text selection may start, keep out of the way. */
  press(): void;
  /** Button released: show again (after the delay) if the pointer is still there. */
  release(): void;
  /** A popover of the bar (emoji picker, «…» menu) opened / closed: an open one keeps the bar. */
  hold(key: string, on: boolean): void;
  /** The feed scrolled: hide now; show again only after SCROLL_QUIET_MS without scrolling. */
  scroll(): void;
  /** Pointer inside or bar shown: the owner needs to hear about scrolls. */
  active(): boolean;
  dispose(): void;
}

export interface HoverDelays {
  show: number;
  hide: number;
  quiet: number;
}

const DELAYS: HoverDelays = { show: HOVER_DELAY_MS, hide: HIDE_DELAY_MS, quiet: SCROLL_QUIET_MS };

/**
 * Hover intent: `onChange(true)` after the pointer has stayed `show` ms on the message, no
 * button is held (a selection drag in progress hides the bar) and the feed has not scrolled for
 * `quiet` ms; `onChange(false)` `hide` ms after the pointer leaves (a return cancels it), at once
 * on a press or a scroll — but never while a popover of the bar is open. Only real changes are
 * reported.
 */
export function createHoverIntent(onChange: (visible: boolean) => void, delays: Partial<HoverDelays> = {}, timers: Timers = windowTimers): HoverIntent {
  const d = { ...DELAYS, ...delays };
  let inside = false;
  let pressed = false;
  let visible = false;
  let scrolling = false;
  const held = new Set<string>();
  let showTimer: number | null = null;
  let hideTimer: number | null = null;
  let quietTimer: number | null = null;

  const clear = (id: number | null): null => {
    if (id !== null) timers.clear(id);
    return null;
  };
  const set = (v: boolean): void => {
    if (v === visible) return;
    visible = v;
    onChange(v);
  };
  const scheduleShow = (): void => {
    showTimer = clear(showTimer);
    if (!inside || pressed || scrolling || visible) return;
    showTimer = timers.set(() => {
      showTimer = null;
      if (inside && !pressed && !scrolling) set(true);
    }, d.show);
  };
  const scheduleHide = (): void => {
    hideTimer = clear(hideTimer);
    if (!visible || held.size) return;
    hideTimer = timers.set(() => {
      hideTimer = null;
      if (!inside && !held.size) set(false);
    }, d.hide);
  };
  const hideNow = (): void => {
    showTimer = clear(showTimer);
    hideTimer = clear(hideTimer);
    if (!held.size) set(false);
  };

  return {
    enter() {
      inside = true;
      hideTimer = clear(hideTimer);
      scheduleShow();
    },
    leave() {
      inside = false;
      showTimer = clear(showTimer);
      scheduleHide();
    },
    press() {
      pressed = true;
      hideNow();
    },
    release() {
      pressed = false;
      scheduleShow();
    },
    hold(key, on) {
      if (on) {
        held.add(key);
        hideTimer = clear(hideTimer);
        return;
      }
      if (!held.delete(key) || held.size) return;
      if (pressed) hideNow();
      else if (!inside) scheduleHide();
    },
    scroll() {
      scrolling = true;
      hideNow();
      quietTimer = clear(quietTimer);
      quietTimer = timers.set(() => {
        quietTimer = null;
        scrolling = false;
        if (inside && !pressed) set(true);
      }, d.quiet);
    },
    active() {
      return inside || visible || quietTimer !== null;
    },
    dispose() {
      showTimer = clear(showTimer);
      hideTimer = clear(hideTimer);
      quietTimer = clear(quietTimer);
    },
  };
}

/** Distance kept from the feed's edges, and the gap between the bubble and the bar beside it. */
export const BAR_EDGE = 8;
export const BAR_GAP = 6;

interface Box {
  left: number;
  right: number;
}

/**
 * Where the action bar goes (docs/09 #74). `beside`: next to the bubble on the free side of the
 * row (right of others' messages, left of mine), level with its top — when that fits in the feed
 * with BAR_EDGE to spare. Otherwise (a wide bubble, a narrow window) `corner`: over the bubble's
 * top edge, right-aligned with it and clamped into the feed; `left` / `top` are relative to the
 * bubble's box.
 */
export function placeActionBar(
  bubble: Box,
  lane: Box,
  bar: { width: number; height: number },
  own: boolean,
): { mode: 'beside' } | { mode: 'corner'; left: number; top: number } {
  const fits = own ? bubble.left - BAR_GAP - bar.width >= lane.left + BAR_EDGE : bubble.right + BAR_GAP + bar.width <= lane.right - BAR_EDGE;
  if (fits) return { mode: 'beside' };
  const right = Math.min(bubble.right, lane.right - BAR_EDGE);
  const left = Math.max(lane.left + BAR_EDGE, right - bar.width);
  return { mode: 'corner', left: Math.round(left - bubble.left), top: -Math.round(bar.height / 2) };
}
