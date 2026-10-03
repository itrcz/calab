import { describe, expect, it } from 'vitest';
import { FIT, MAX_ZOOM, centerOn, clampView, levelText, panBy, pinch, toggleAt, viewFrac, wheelFactor, wheelPixels, zoomAt } from './zoomMath';

const W = 800;
const H = 600;

describe('zoom math', () => {
  it('keeps the point under the cursor fixed', () => {
    const v = zoomAt(FIT, 2, 400, 300, W, H);
    expect(v).toEqual({ s: 2, x: -400, y: -300 });
    // the stage point under (400, 300) is still (400, 300)
    expect((400 - v.x) / v.s).toBe(400);
    const v2 = zoomAt(FIT, 2, 100, 50, W, H);
    expect((100 - v2.x) / v2.s).toBeCloseTo(100);
    expect((50 - v2.y) / v2.s).toBeCloseTo(50);
  });
  it('clamps scale to 1..4 and snaps to the fit', () => {
    expect(zoomAt(FIT, 10, 0, 0, W, H).s).toBe(MAX_ZOOM);
    expect(zoomAt({ s: 2, x: -100, y: -100 }, 0.3, 50, 50, W, H)).toEqual(FIT);
    expect(clampView({ s: NaN, x: 5, y: 5 }, W, H)).toEqual(FIT);
  });
  it('never lets the image leave the viewport', () => {
    expect(clampView({ s: 2, x: 50, y: 50 }, W, H)).toEqual({ s: 2, x: 0, y: 0 });
    expect(clampView({ s: 2, x: -5000, y: -5000 }, W, H)).toEqual({ s: 2, x: -800, y: -600 });
    expect(panBy({ s: 2, x: -10, y: -10 }, -2000, 2000, W, H)).toEqual({ s: 2, x: -800, y: 0 });
    // zooming at a corner stays inside
    const v = zoomAt(FIT, 4, W, H, W, H);
    expect(v).toEqual({ s: 4, x: -2400, y: -1800 });
  });
  it('double click toggles fit and 2x at the point', () => {
    const z = toggleAt(FIT, 200, 100, W, H);
    expect(z.s).toBe(2);
    expect(toggleAt(z, 10, 10, W, H)).toEqual(FIT);
  });
  it('maps the viewport to minimap fractions and back', () => {
    expect(viewFrac(FIT, W, H)).toEqual({ l: 0, t: 0, w: 1, h: 1 });
    const v = zoomAt(FIT, 2, 400, 300, W, H);
    expect(viewFrac(v, W, H)).toEqual({ l: 0.25, t: 0.25, w: 0.5, h: 0.5 });
    expect(centerOn(2, 0.5, 0.5, W, H)).toEqual(v);
    expect(centerOn(2, 0, 0, W, H)).toEqual({ s: 2, x: 0, y: 0 });
    expect(centerOn(2, 1.5, -1, W, H)).toEqual({ s: 2, x: -800, y: 0 });
    const f = viewFrac(centerOn(4, 0.3, 0.7, W, H), W, H);
    expect(f.l + f.w / 2).toBeCloseTo(0.3);
    expect(f.t + f.h / 2).toBeCloseTo(0.7);
  });
  it('normalizes wheel deltas', () => {
    expect(wheelPixels(3, 1, 600)).toBe(48);
    expect(wheelPixels(1, 2, 600)).toBe(600);
    expect(wheelPixels(7, 0, 600)).toBe(7);
    expect(wheelFactor(-100)).toBeGreaterThan(1.2);
    expect(wheelFactor(-100)).toBeLessThan(1.25);
    expect(wheelFactor(100)).toBeCloseTo(1 / wheelFactor(-100));
    expect(wheelFactor(-4)).toBeGreaterThan(1);
    expect(wheelFactor(-4)).toBeLessThan(1.05);
    expect(wheelFactor(-100000)).toBe(wheelFactor(-150));
  });
  it('pinches around the midpoint', () => {
    const v = pinch(FIT, 100, [400, 300], 200, [400, 300], W, H);
    expect(v).toEqual({ s: 2, x: -400, y: -300 });
    // fingers moving together pans
    const p = pinch(v, 200, [400, 300], 200, [500, 350], W, H);
    expect(p).toEqual({ s: 2, x: -300, y: -250 });
    expect(pinch(FIT, 0, [0, 0], 10, [0, 0], W, H)).toEqual(FIT);
  });
  it('formats the level', () => {
    expect(levelText(2.5)).toBe('250 %');
  });
});
