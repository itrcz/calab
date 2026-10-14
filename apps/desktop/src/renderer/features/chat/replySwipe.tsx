import { Reply } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject, type TouchEvent } from 'react';
import { haptics } from '../../lib/haptics';
import { REPLY_TRIGGER_PX, replyMove, type ReplyGesture } from '../../lib/swipeGestures';

/** A swipe never starts on a control that drags sideways itself (a player's seek bar, a code block's scroll). */
const OWN_DRAG = '[role=slider], pre, input, textarea, [data-no-swipe]';

export interface ReplySwipe {
  /** A swipe is under way or settling (the icon is rendered). */
  active: boolean;
  /** The element that moves (the message row's content). */
  ref: RefObject<HTMLDivElement | null>;
  icon: RefObject<HTMLSpanElement | null>;
  handlers: { onTouchStart?: (e: TouchEvent) => void; onTouchMove?: (e: TouchEvent) => void; onTouchEnd?: (e: TouchEvent) => void; onTouchCancel?: (e: TouchEvent) => void };
}

/**
 * Phone (docs/08 «Свайпы и долгое нажатие», Telegram iOS): a message swiped left follows the
 * finger (≤ 64 px); past 48 px the «reply» icon snaps (one haptic) and the release replies — the
 * same path as the menu's «Ответить» (`onReply`). A vertical gesture is the feed's scroll. The
 * offset is written to the element's style straight from the touch events: no React render per
 * move, only one when the swipe starts (the icon mounts) and one when it has settled. A move also
 * cancels Radix's long-press menu (its trigger drops the timer on any pointer move).
 */
export function useReplySwipe(enabled: boolean, onReply: () => void): ReplySwipe {
  const ref = useRef<HTMLDivElement | null>(null);
  const icon = useRef<HTMLSpanElement | null>(null);
  const gesture = useRef<ReplyGesture | null>(null);
  const [active, setActive] = useState(false);
  if (!enabled) return { active: false, ref, icon, handlers: {} };

  const paint = (offset: number, armed: boolean): void => {
    const el = ref.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = offset ? `translateX(${offset}px)` : '';
    }
    const i = icon.current;
    if (i) {
      const p = Math.min(1, -offset / REPLY_TRIGGER_PX);
      i.style.opacity = String(p);
      i.style.transform = `translateY(-50%) scale(${armed ? 1 : 0.5 + 0.4 * p})`;
      i.toggleAttribute('data-armed', armed);
    }
  };

  const end = (e: TouchEvent): void => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.axis !== 'x') return;
    e.stopPropagation();
    const el = ref.current;
    const moved = !!el?.style.transform;
    if (icon.current) icon.current.style.opacity = '0';
    const settled = (): void => {
      if (el) el.style.transition = '';
      setActive(false);
    };
    if (el && moved) {
      el.style.transition = 'transform 150ms var(--ease, ease-out)';
      el.style.transform = '';
      // Reduced motion / screenshot tests zero every transition: no transitionend comes then.
      if (parseFloat(getComputedStyle(el).transitionDuration) > 0) el.addEventListener('transitionend', settled, { once: true });
      else settled();
    } else settled();
    if (g.armed && e.type === 'touchend') onReply();
  };

  return {
    active,
    ref,
    icon,
    handlers: {
      onTouchStart: (e) => {
        const p = e.touches[0];
        const own = e.target instanceof Element && e.target.closest(OWN_DRAG);
        gesture.current = p && e.touches.length === 1 && !own ? { x: p.clientX, y: p.clientY, axis: null, armed: false } : null;
      },
      onTouchMove: (e) => {
        const g = gesture.current;
        const p = e.touches[0];
        if (!g || !p) return;
        const step = replyMove(g, p.clientX, p.clientY);
        if (step.offset === 'scroll') {
          gesture.current = null;
          return;
        }
        if (step.offset === null) return;
        e.stopPropagation();
        if (!active) setActive(true);
        if (step.armedNow) haptics.impact();
        paint(step.offset, g.armed);
      },
      onTouchEnd: end,
      onTouchCancel: end,
    },
  };
}

/** The «reply» disc beside the moving message (rendered only while a swipe is under way). */
export function ReplySwipeIcon({ icon }: { icon: RefObject<HTMLSpanElement | null> }): ReactNode {
  return (
    <span
      ref={icon}
      aria-hidden
      data-testid="reply-swipe-icon"
      className="pointer-events-none absolute left-[calc(100%+12px)] top-1/2 grid size-8 place-items-center rounded-full bg-[var(--color-fill)] text-muted opacity-0 transition-[background-color,color] duration-[var(--motion-fast)] data-[armed]:bg-accent-strong data-[armed]:text-accent-fg"
      style={{ transform: 'translateY(-50%) scale(0.5)' }}
    >
      <Reply className="size-4" strokeWidth={2.25} />
    </span>
  );
}
