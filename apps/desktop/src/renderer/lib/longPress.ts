import { useRef, type MouseEvent, type PointerEvent } from 'react';
import { SWIPE_SLOP_PX } from './swipeGestures';

/** Radix ContextMenu's touch long press: rows with a «…» dropdown open it after the same hold. */
export const LONG_PRESS_MS = 700;

export interface LongPressHandlers {
  onPointerDown?: (e: PointerEvent) => void;
  onPointerMove?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;
  onPointerCancel?: (e: PointerEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
}

/**
 * Phone (docs/08 «Свайпы и долгое нажатие»): a finger held still on a row whose menu is a «…»
 * dropdown (not a Radix ContextMenu) opens that same menu — `onLongPress` sets it open. A move past
 * the slop (a scroll, a swipe) or a release cancels; Android's own long press (`contextmenu`)
 * opens it at once. A timer exists only while a finger is down. Touch and pen only: a mouse keeps
 * its click / right click. Disabled: no handlers.
 */
export function useLongPress(enabled: boolean, onLongPress: () => void): LongPressHandlers {
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  if (!enabled) return {};
  const cancel = (): void => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    onPointerDown: (e) => {
      cancel();
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          onLongPress();
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SWIPE_SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => {
      e.preventDefault();
      cancel();
      onLongPress();
    },
  };
}
