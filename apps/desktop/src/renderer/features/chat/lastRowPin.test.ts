import { describe, expect, it } from 'vitest';
import { createBottomPin, type FeedGeometry } from './lastRowPin';

/** A feed of `content` px in a scroller of `view` px, scrolled to `top`. */
const g = (content: number, view: number, top: number): FeedGeometry => ({ scrollHeight: content, clientHeight: view, scrollTop: top });
/** The same feed scrolled to its bottom. */
const atEnd = (content: number, view: number): FeedGeometry => g(content, view, content - view);

function stuckAtBottom(): ReturnType<typeof createBottomPin> {
  const pin = createBottomPin();
  pin.scrolled(atEnd(2000, 600));
  return pin;
}

describe('createBottomPin (docs/09 #149)', () => {
  it('pins when a reaction row grows the last message', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2028, 600, 1400))).toBe(true);
  });

  it('pins when an attachment grows far past the at-bottom threshold (upload → preview, image load)', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2320, 600, 1400))).toBe(true);
    // A second change before our scroll landed (the preview's real aspect) still pins.
    expect(pin.resized(g(2360, 600, 1400))).toBe(true);
  });

  it('pins when the composer grows and the scroller shrinks', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2000, 520, 1400))).toBe(true);
  });

  it('our own pin scroll keeps it stuck for the next growth', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2100, 600, 1400))).toBe(true);
    pin.scrolled(atEnd(2100, 600));
    expect(pin.resized(g(2150, 600, 1500))).toBe(true);
  });

  it('does not jump when the reader has scrolled up', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2000, 600, 1100));
    expect(pin.resized(g(2028, 600, 1100))).toBe(false); // a reaction on the last message
    expect(pin.resized(g(2028, 480, 1100))).toBe(false); // the composer grows
  });

  it('a small wheel nudge within the threshold stays stuck', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2000, 600, 1395));
    expect(pin.resized(g(2028, 600, 1395))).toBe(true);
  });

  it('a smooth scroll down still on its way keeps the pin', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2080, 600, 1420)); // a new message, followOutput animating down
    expect(pin.resized(g(2300, 600, 1440))).toBe(true); // its image loads mid-animation
  });

  it('nothing to do when already at the bottom (the observer’s initial report)', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(atEnd(2000, 600))).toBe(false);
  });

  it('never pins before the reader has been at the bottom (opened at the first unread)', () => {
    const pin = createBottomPin();
    pin.scrolled(g(5000, 600, 2000));
    expect(pin.resized(g(5040, 600, 2000))).toBe(false);
  });

  it('a short feed that is at its bottom on the first report sticks', () => {
    const pin = createBottomPin();
    expect(pin.resized(g(400, 600, 0))).toBe(false);
    expect(pin.resized(g(700, 600, 0))).toBe(true);
  });

  it('does not pin while newer history is not loaded', () => {
    const pin = stuckAtBottom();
    pin.setLive(false);
    expect(pin.resized(g(2400, 600, 1400))).toBe(false);
    pin.setLive(true);
    expect(pin.resized(g(2450, 600, 1400))).toBe(false); // left the bottom meanwhile
  });
});
