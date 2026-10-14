import { useRef, useState, type TouchEvent } from 'react';
import { haptics } from './haptics';
import { lockAxis, type AxisGesture } from './swipeGestures';

/**
 * Phone list rows (docs/09 #51, docs/08 «Свайпы и долгое нажатие»): a left swipe reveals the
 * row's actions on its right edge — one or more buttons, each this wide (DM «В архив»; a room's
 * «Прочитано» · «Тихо»).
 */
export const SWIPE_ACTION_PX = 88;

export interface SwipeGesture extends AxisGesture {
  /** The row's offset when the gesture started (0 closed, −width open). */
  base: number;
  /** The actions' total width (n × SWIPE_ACTION_PX); SWIPE_ACTION_PX when left out. */
  width?: number;
  claimed: boolean;
  /** Where the row would settle if released now (swipeSettle); undefined = where it started. */
  side?: number;
}

/** The actions' total width of a gesture. */
const widthOf = (g: SwipeGesture): number => g.width ?? SWIPE_ACTION_PX;

/**
 * One touch move of a row swipe: the new offset (−width…0), `null` while undecided, or 'scroll'
 * when the gesture is a vertical scroll (the row lets it go). A right swipe on a closed row is not
 * the row's (the screen's edge swipe «back» may use it).
 */
export function swipeMove(g: SwipeGesture, x: number, y: number): number | null | 'scroll' {
  if (!g.claimed) {
    const axis = lockAxis(g, x, y);
    if (axis === 'y') return 'scroll';
    if (axis === null || (x - g.x > 0 && g.base === 0)) {
      // A right swipe on a closed row stays undecided (and never claims it).
      if (axis === 'x') g.axis = null;
      return null;
    }
    g.claimed = true;
  }
  return Math.max(-widthOf(g), Math.min(0, g.base + (x - g.x)));
}

/** Where a released row settles: open past half the actions' width, else closed. */
export const swipeSettle = (offset: number, width: number = SWIPE_ACTION_PX): number => (offset < -width / 2 ? -width : 0);

/**
 * The drag crossed the settle point (half the actions' width) since the last call, either way:
 * the haptic «impact» fires once per crossing, not on every move.
 */
export function swipeCrossed(g: SwipeGesture, offset: number): boolean {
  const w = widthOf(g);
  const side = swipeSettle(offset, w);
  const crossed = side !== (g.side ?? swipeSettle(g.base, w));
  g.side = side;
  return crossed;
}

export interface RowSwipe {
  offset: number;
  dragging: boolean;
  /** The actions' total width (actions × SWIPE_ACTION_PX). */
  width: number;
  close: () => void;
  handlers: { onTouchStart?: (e: TouchEvent) => void; onTouchMove?: (e: TouchEvent) => void; onTouchEnd?: (e: TouchEvent) => void; onTouchCancel?: (e: TouchEvent) => void };
}

/**
 * Phone: swiping a row left reveals its `actions` buttons, swiping right or tapping the row hides
 * them. A claimed gesture stops at the row (the shell's own swipe does not see it). The offset is
 * the row's own state: a drag re-renders that row only.
 */
export function useRowSwipe(enabled: boolean, actions = 1): RowSwipe {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<SwipeGesture | null>(null);
  const width = actions * SWIPE_ACTION_PX;
  if (!enabled) return { offset: 0, dragging: false, width, close: () => undefined, handlers: {} };
  const end = (e: TouchEvent): void => {
    const g = gesture.current;
    gesture.current = null;
    if (!g?.claimed) return;
    e.stopPropagation();
    setDragging(false);
    setOffset((o) => swipeSettle(o, width));
  };
  return {
    offset,
    dragging,
    width,
    close: () => setOffset(0),
    handlers: {
      onTouchStart: (e) => {
        const p = e.touches[0];
        gesture.current = p && e.touches.length === 1 ? { x: p.clientX, y: p.clientY, axis: null, base: offset, width, claimed: false } : null;
      },
      onTouchMove: (e) => {
        const g = gesture.current;
        const p = e.touches[0];
        if (!g || !p) return;
        const next = swipeMove(g, p.clientX, p.clientY);
        if (next === 'scroll') {
          gesture.current = null;
          return;
        }
        if (next === null) return;
        e.stopPropagation();
        if (swipeCrossed(g, next)) haptics.impact();
        setDragging(true);
        setOffset(next);
      },
      onTouchEnd: end,
      onTouchCancel: end,
    },
  };
}
