import { describe, expect, it } from 'vitest';
import { SWIPE_ACTION_PX, swipeCrossed, swipeMove, swipeSettle, type SwipeGesture } from './rowSwipe';

const start = (base = 0): SwipeGesture => ({ x: 200, y: 100, base, claimed: false });

describe('row swipe (docs/09 #51)', () => {
  it('a left swipe drags the row open up to the action width and settles open past half', () => {
    const g = start();
    expect(swipeMove(g, 195, 101)).toBeNull(); // within the slop: undecided
    expect(swipeMove(g, 160, 102)).toBe(-40);
    expect(g.claimed).toBe(true);
    expect(swipeMove(g, 0, 102)).toBe(-SWIPE_ACTION_PX); // clamped
    expect(swipeSettle(-SWIPE_ACTION_PX / 2 - 1)).toBe(-SWIPE_ACTION_PX);
    expect(swipeSettle(-SWIPE_ACTION_PX / 2 + 1)).toBe(0);
  });

  it('a vertical move is a scroll; a right swipe on a closed row is not the row’s; an open row swipes shut', () => {
    expect(swipeMove(start(), 195, 130)).toBe('scroll');
    expect(swipeMove(start(), 260, 100)).toBeNull(); // the drawer may use it
    const open = start(-SWIPE_ACTION_PX);
    expect(swipeMove(open, 300, 100)).toBe(0);
  });
});

describe('row swipe: the settle threshold (haptic)', () => {
  it('reports each crossing of half the action width once, in both directions', () => {
    const g = start();
    const half = SWIPE_ACTION_PX / 2;
    expect(swipeCrossed(g, -10)).toBe(false);
    expect(swipeCrossed(g, -half + 1)).toBe(false);
    expect(swipeCrossed(g, -half - 1)).toBe(true); // past half: would open
    expect(swipeCrossed(g, -half - 10)).toBe(false); // still past: no repeat
    expect(swipeCrossed(g, -SWIPE_ACTION_PX)).toBe(false);
    expect(swipeCrossed(g, -half + 5)).toBe(true); // back: would close
    expect(swipeCrossed(g, 0)).toBe(false);
  });

  it('an open row crosses when dragged shut past half', () => {
    const g = start(-SWIPE_ACTION_PX);
    expect(swipeCrossed(g, -SWIPE_ACTION_PX + 10)).toBe(false);
    expect(swipeCrossed(g, -SWIPE_ACTION_PX / 2 + 1)).toBe(true);
  });
});

describe('row swipe: several actions (a room row: «Прочитано» · «Тихо»)', () => {
  const two = (base = 0): SwipeGesture => ({ x: 300, y: 100, base, width: 2 * SWIPE_ACTION_PX, claimed: false });

  it('drags open up to n × the action width and settles open past half of it', () => {
    const g = two();
    expect(swipeMove(g, 200, 101)).toBe(-100);
    expect(swipeMove(g, 0, 101)).toBe(-2 * SWIPE_ACTION_PX); // clamped at both actions
    expect(swipeSettle(-SWIPE_ACTION_PX - 1, 2 * SWIPE_ACTION_PX)).toBe(-2 * SWIPE_ACTION_PX);
    expect(swipeSettle(-SWIPE_ACTION_PX + 1, 2 * SWIPE_ACTION_PX)).toBe(0);
    // one action's half is not enough for two
    expect(swipeSettle(-SWIPE_ACTION_PX / 2 - 1, 2 * SWIPE_ACTION_PX)).toBe(0);
  });

  it('the haptic threshold is half the total width', () => {
    const g = two();
    expect(swipeCrossed(g, -SWIPE_ACTION_PX / 2 - 1)).toBe(false);
    expect(swipeCrossed(g, -SWIPE_ACTION_PX - 1)).toBe(true);
    expect(swipeCrossed(g, -SWIPE_ACTION_PX - 20)).toBe(false);
  });

  it('an open row swipes shut to the right; a right swipe on a closed row stays undecided, then may scroll', () => {
    expect(swipeMove(two(-2 * SWIPE_ACTION_PX), 400, 100)).toBe(-2 * SWIPE_ACTION_PX + 100);
    const g = two();
    expect(swipeMove(g, 340, 100)).toBeNull();
    expect(g.claimed).toBe(false);
    expect(swipeMove(g, 345, 160)).toBe('scroll');
  });
});
