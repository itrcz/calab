import { describe, expect, it } from 'vitest';
import { BAR_EDGE, createHoverIntent, placeActionBar, quickReactions, type Timers } from './hoverIntent';

/** Manual clock: `tick(ms)` fires what is due. */
function fakeTimers(): Timers & { tick(ms: number): void } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn, ms) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (id) => void due.delete(id),
    tick(ms) {
      now += ms;
      for (const [id, d] of [...due]) {
        if (d.at <= now) {
          due.delete(id);
          d.fn();
        }
      }
    },
  };
}

function setup() {
  const clock = fakeTimers();
  const events: boolean[] = [];
  const h = createHoverIntent((v) => events.push(v), { show: 150, hide: 200, quiet: 150 }, clock);
  return { clock, events, h };
}

describe('hover intent (message action bar)', () => {
  it('shows only after the pointer stays 150 ms, hides 200 ms after it leaves', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(149);
    expect(events).toEqual([]);
    clock.tick(1);
    expect(events).toEqual([true]);
    h.leave();
    clock.tick(199);
    expect(events).toEqual([true]);
    clock.tick(1);
    expect(events).toEqual([true, false]);
    expect(h.active()).toBe(false);
  });

  it('coming back within the hide delay (bubble → gap → bar) keeps it', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(150);
    h.leave();
    clock.tick(120);
    h.enter();
    clock.tick(1000);
    expect(events).toEqual([true]);
  });

  it('an open popover (picker, «…» menu) keeps it; closing it outside hides after the delay', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(150);
    h.hold('picker', true);
    h.leave();
    clock.tick(5000);
    expect(events).toEqual([true]);
    h.hold('menu', true);
    h.hold('picker', false);
    clock.tick(5000);
    expect(events).toEqual([true]);
    h.hold('menu', false);
    clock.tick(200);
    expect(events).toEqual([true, false]);
  });

  it('a scroll hides it at once; it comes back 150 ms after the last scroll', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(150);
    h.scroll();
    expect(events).toEqual([true, false]);
    clock.tick(100);
    h.scroll();
    clock.tick(149);
    expect(events).toEqual([true, false]);
    clock.tick(1);
    expect(events).toEqual([true, false, true]);
  });

  it('entering while the feed scrolls shows nothing until it stops', () => {
    const { clock, events, h } = setup();
    h.scroll();
    h.enter();
    clock.tick(100);
    h.scroll();
    clock.tick(100);
    expect(events).toEqual([]);
    clock.tick(50);
    expect(events).toEqual([true]);
  });

  it('a fly-over (leave before the delay) never shows it', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(100);
    h.leave();
    clock.tick(500);
    expect(events).toEqual([]);
  });

  it('a held button (selection drag) hides it; release shows it again after the delay', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(150);
    h.press();
    clock.tick(1000);
    expect(events).toEqual([true, false]);
    h.release();
    clock.tick(150);
    expect(events).toEqual([true, false, true]);
  });

  it('entering while the button is held (drag from another message) waits for the release', () => {
    const { clock, events, h } = setup();
    h.press();
    h.enter();
    clock.tick(500);
    expect(events).toEqual([]);
    h.leave();
    h.release();
    clock.tick(500);
    expect(events).toEqual([]);
  });

  it('dispose cancels a pending show', () => {
    const { clock, events, h } = setup();
    h.enter();
    h.dispose();
    clock.tick(500);
    expect(events).toEqual([]);
  });
});

describe('action bar placement', () => {
  const lane = { left: 0, right: 600 };
  const bar = { width: 190, height: 28 };
  it('beside the bubble when the free side has room', () => {
    expect(placeActionBar({ left: 64, right: 300 }, lane, bar, false)).toEqual({ mode: 'beside' });
    expect(placeActionBar({ left: 300, right: 576 }, lane, bar, true)).toEqual({ mode: 'beside' });
  });
  it('a wide bubble: over its top edge, right-aligned and inside the feed', () => {
    const p = placeActionBar({ left: 64, right: 460 }, lane, bar, false);
    expect(p).toEqual({ mode: 'corner', left: 460 - 190 - 64, top: -14 });
    const own = placeActionBar({ left: 100, right: 576 }, lane, bar, true);
    expect(own).toEqual({ mode: 'corner', left: 576 - 190 - 100, top: -14 });
  });
  it('never past the feed edge, even when the bubble reaches it', () => {
    const p = placeActionBar({ left: 64, right: 700 }, lane, bar, false);
    expect(p.mode === 'corner' && 64 + p.left + bar.width).toBe(lane.right - BAR_EDGE);
    const narrow = placeActionBar({ left: 20, right: 150 }, { left: 0, right: 160 }, bar, false);
    expect(narrow.mode === 'corner' && 20 + narrow.left).toBe(BAR_EDGE);
  });
});

describe('quick reactions', () => {
  const defaults = ['👍', '❤️', '😂', '🔥', '🎉'];
  it('defaults when nothing was used', () => {
    expect(quickReactions([], 4, defaults)).toEqual(['👍', '❤️', '😂', '🔥']);
  });
  it('recent first, no duplicates, topped up with defaults', () => {
    expect(quickReactions(['🔥', '🙂'], 4, defaults)).toEqual(['🔥', '🙂', '👍', '❤️']);
    expect(quickReactions(['a', 'b', 'c', 'd', 'e'], 4, defaults)).toEqual(['a', 'b', 'c', 'd']);
  });
});
