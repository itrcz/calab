import { describe, expect, it } from 'vitest';
import { DAY_SWIPE_PX, REPLY_MAX_PX, REPLY_TRIGGER_PX, daySwipeStep, lockAxis, replyMove, replyOffset, type AxisGesture, type ReplyGesture } from './swipeGestures';

describe('lockAxis', () => {
  it('decides once: a vertical move past the slop is a scroll, a horizontal one a swipe; vertical wins ties', () => {
    const g: AxisGesture = { x: 100, y: 100 };
    expect(lockAxis(g, 105, 104)).toBeNull(); // within the slop
    expect(lockAxis(g, 112, 100)).toBe('x');
    expect(lockAxis(g, 112, 200)).toBe('x'); // decided: stays a swipe
    expect(lockAxis({ x: 0, y: 0 }, 11, 11)).toBe('y');
    expect(lockAxis({ x: 0, y: 0 }, 4, 11)).toBe('y');
  });
});

describe('message swipe → reply (Telegram iOS)', () => {
  const start = (): ReplyGesture => ({ x: 300, y: 400, armed: false });

  it('follows the finger 1:1 up to the trigger, then with resistance up to the max; never to the right', () => {
    expect(replyOffset(20)).toBe(0);
    expect(replyOffset(-30)).toBe(-30);
    expect(replyOffset(-REPLY_TRIGGER_PX)).toBe(-REPLY_TRIGGER_PX);
    expect(replyOffset(-REPLY_TRIGGER_PX - 10)).toBe(-REPLY_TRIGGER_PX - 4);
    expect(replyOffset(-400)).toBe(-REPLY_MAX_PX);
  });

  it('arms once per entry into the trigger zone (one haptic) and disarms on the way back', () => {
    const g = start();
    expect(replyMove(g, 296, 401)).toEqual({ offset: null, armedNow: false }); // slop
    expect(replyMove(g, 270, 402)).toEqual({ offset: -30, armedNow: false });
    expect(replyMove(g, 250, 402)).toEqual({ offset: -REPLY_TRIGGER_PX - 0.8, armedNow: true });
    expect(replyMove(g, 200, 402).armedNow).toBe(false); // still armed: no repeat
    expect(g.armed).toBe(true);
    expect(replyMove(g, 280, 402)).toEqual({ offset: -20, armedNow: false });
    expect(g.armed).toBe(false);
    expect(replyMove(g, 240, 402).armedNow).toBe(true);
  });

  it('a vertical gesture is the feed’s scroll; a right swipe moves nothing', () => {
    expect(replyMove(start(), 302, 430).offset).toBe('scroll');
    const g = start();
    expect(replyMove(g, 340, 400)).toEqual({ offset: 0, armedNow: false });
  });
});

describe('calendar day swipe', () => {
  it('a left swipe of ≥ 60 px is the next day, a right one the previous; shorter or vertical — none', () => {
    expect(daySwipeStep({ x: 200, y: 300 }, 200 - DAY_SWIPE_PX, 305)).toBe(1);
    expect(daySwipeStep({ x: 200, y: 300 }, 200 + DAY_SWIPE_PX + 5, 300)).toBe(-1);
    expect(daySwipeStep({ x: 200, y: 300 }, 200 - DAY_SWIPE_PX + 1, 300)).toBe(0);
    expect(daySwipeStep({ x: 200, y: 300 }, 120, 420)).toBe(0); // a scroll
  });

  it('the axis locked during the moves decides: a scroll that drifts sideways never flips the day', () => {
    const g: AxisGesture = { x: 200, y: 300 };
    expect(lockAxis(g, 202, 330)).toBe('y');
    expect(daySwipeStep(g, 100, 335)).toBe(0);
  });
});
