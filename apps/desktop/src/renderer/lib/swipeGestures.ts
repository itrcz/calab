/**
 * Phone swipes (docs/08 «Свайпы и долгое нажатие»), the pure part: which axis a touch took, the
 * message «reply» swipe and the calendar's day swipe. The hooks (lib/rowSwipe.ts,
 * features/chat/replySwipe.ts, calendar/DayView.tsx) feed touch points in.
 */

/** Movement before a gesture is judged: a scroll (vertical) or a swipe (horizontal). */
export const SWIPE_SLOP_PX = 10;

export interface AxisGesture {
  x: number;
  y: number;
  /** Decided once per gesture: 'y' a scroll, 'x' a swipe; null / undefined while within the slop. */
  axis?: 'x' | 'y' | null;
}

/**
 * The gesture's axis, decided once: past the slop vertically (and at least as far as
 * horizontally) it is a scroll, past it horizontally a swipe; vertical wins ties.
 */
export function lockAxis(g: AxisGesture, x: number, y: number): 'x' | 'y' | null {
  if (g.axis) return g.axis;
  const dx = Math.abs(x - g.x);
  const dy = Math.abs(y - g.y);
  if (dy > SWIPE_SLOP_PX && dy >= dx) g.axis = 'y';
  else if (dx >= SWIPE_SLOP_PX) g.axis = 'x';
  return g.axis ?? null;
}

// ---------------------------------------------------------------- message → reply (Telegram iOS)

/** How far a bubble follows the finger to the left. */
export const REPLY_MAX_PX = 64;
/** Past this the release replies (the icon «snaps», one haptic). */
export const REPLY_TRIGGER_PX = 48;

/**
 * The bubble's offset (≤ 0) for a finger `dx` from the start: 1:1 up to the trigger, then with
 * resistance up to REPLY_MAX_PX. A move to the right is not the bubble's (0).
 */
export function replyOffset(dx: number): number {
  const d = -dx;
  if (d <= 0) return 0;
  if (d <= REPLY_TRIGGER_PX) return -d;
  return -Math.min(REPLY_MAX_PX, REPLY_TRIGGER_PX + (d - REPLY_TRIGGER_PX) * 0.4);
}

export interface ReplyGesture extends AxisGesture {
  /** Past the trigger at the last move. */
  armed: boolean;
}

export interface ReplyStep {
  /** The bubble's offset, or 'scroll' (the feed's: let go), or null (undecided / a right swipe). */
  offset: number | 'scroll' | null;
  /** The move crossed into the trigger zone (the haptic, the icon's snap): true once per entry. */
  armedNow: boolean;
}

/** One touch move of a reply swipe. */
export function replyMove(g: ReplyGesture, x: number, y: number): ReplyStep {
  const axis = lockAxis(g, x, y);
  if (axis === 'y') return { offset: 'scroll', armedNow: false };
  if (axis === null) return { offset: null, armedNow: false };
  const offset = replyOffset(x - g.x);
  const armed = offset <= -REPLY_TRIGGER_PX;
  const armedNow = armed && !g.armed;
  g.armed = armed;
  return { offset, armedNow };
}

// ---------------------------------------------------------------- calendar day

/** A horizontal swipe at least this long flips the day. */
export const DAY_SWIPE_PX = 60;

/**
 * The day a released swipe goes to: +1 (a swipe to the left: the next day), −1 (to the right: the
 * previous one) or 0 (a scroll, too short, still undecided).
 */
export function daySwipeStep(g: AxisGesture, x: number, y: number): -1 | 0 | 1 {
  if (lockAxis(g, x, y) !== 'x') return 0;
  const dx = x - g.x;
  if (Math.abs(dx) < DAY_SWIPE_PX) return 0;
  return dx < 0 ? 1 : -1;
}
