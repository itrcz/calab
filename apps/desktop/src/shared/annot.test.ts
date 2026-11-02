import { describe, expect, it } from 'vitest';
import { displayBoundsFor, OVERLAY_RAISE_MS, overlayRaiseDue, overlaySupported, parseOverlayEvent, parseOverlayTarget, resolveScreenDisplays } from './annot';

const ok = { from: 'u:s', name: 'Анна', kind: 'stroke', color: 0xff0000, points: [0.1, 0.2], strokeId: 3, strokeEnd: false, owner: false };

describe('annot overlay IPC', () => {
  it('accepts a well-formed event', () => {
    expect(parseOverlayEvent(ok)).toEqual(ok);
  });

  it('rejects anything off-shape', () => {
    for (const bad of [
      null,
      'x',
      { ...ok, kind: 'policy' },
      { ...ok, points: [0.1] },
      { ...ok, points: [0.1, 2] },
      { ...ok, points: ['0.1', 0.2] },
      { ...ok, points: new Array<number>(122).fill(0.5) },
      { ...ok, color: -1 },
      { ...ok, color: 1.5 },
      { ...ok, name: 'x'.repeat(201) },
      { ...ok, owner: 'yes' },
    ]) {
      expect(() => parseOverlayEvent(bad)).toThrow();
    }
    expect(() => parseOverlayTarget({ sourceId: 'screen:1:0' })).toThrow();
    expect(parseOverlayTarget({ sourceId: 'screen:1:0', displayId: '1' })).toEqual({ sourceId: 'screen:1:0', displayId: '1' });
  });

  it('covers only whole screens, on a display that exists', () => {
    const displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
      { id: 2, bounds: { x: 1512, y: -200, width: 2560, height: 1440 } },
    ];
    expect(displayBoundsFor({ sourceId: 'screen:2:0', displayId: '2' }, displays)).toEqual(displays[1]?.bounds);
    expect(displayBoundsFor({ sourceId: 'window:1234:0', displayId: '' }, displays)).toBeNull();
    expect(displayBoundsFor({ sourceId: 'screen:3:0', displayId: '3' }, displays)).toBeNull();
    expect(displayBoundsFor({ sourceId: 'fake:screen:1', displayId: '1' }, displays)).toBeNull();
  });

  it('an unknown display id still resolves when there is one display (issue #102)', () => {
    const one = [{ id: 2528732444, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
    expect(displayBoundsFor({ sourceId: 'screen:0:0', displayId: '' }, one)).toEqual(one[0]?.bounds);
    expect(displayBoundsFor({ sourceId: 'screen:65537:0', displayId: '123' }, one)).toEqual(one[0]?.bounds);
    expect(displayBoundsFor({ sourceId: 'window:1:0', displayId: '' }, one)).toBeNull();
  });

  it('maps Windows screen sources with empty or foreign display ids, never guessing', () => {
    const hd = { width: 1920, height: 1080 };
    const wide = { width: 3440, height: 1440 };
    const left = { id: 11, bounds: { x: 0, y: 0, ...hd } };
    const displays = [left, { id: 22, bounds: { x: 1920, y: 0, ...wide } }];
    const src = (id: string, displayId: string, size: { width: number; height: number }) => ({ id, displayId, thumbWidth: size.width / 8, thumbHeight: size.height / 8 });
    // macOS / a healthy Windows: ids match and stay.
    expect(resolveScreenDisplays([src('screen:1:0', '11', hd), src('screen:2:0', '22', wide)], displays)).toEqual(new Map([['screen:1:0', '11'], ['screen:2:0', '22']]));
    // DXGI unavailable: empty ids, told apart by the thumbnail's aspect ratio.
    expect(resolveScreenDisplays([src('screen:0:0', '', hd), src('screen:1:0', '', wide)], displays)).toEqual(new Map([['screen:0:0', '11'], ['screen:1:0', '22']]));
    // One matches, the other takes the display that is left.
    expect(resolveScreenDisplays([src('screen:0:0', '11', hd), src('screen:1:0', '999', wide)], displays).get('screen:1:0')).toBe('22');
    // Two equal monitors and no ids: ambiguous → no overlay rather than the wrong monitor.
    const twins = [left, { id: 33, bounds: { x: 1920, y: 0, ...hd } }];
    expect(resolveScreenDisplays([src('screen:0:0', '', hd), src('screen:1:0', '', hd)], twins)).toEqual(new Map([['screen:0:0', ''], ['screen:1:0', '']]));
    // A single screen: that display, whatever its id says.
    expect(resolveScreenDisplays([src('screen:0:0', '', hd)], [left])).toEqual(new Map([['screen:0:0', '11']]));
  });

  it('only where content protection keeps the overlay out of the capture', () => {
    expect(overlaySupported('darwin')).toBe(true);
    expect(overlaySupported('win32')).toBe(true);
    expect(overlaySupported('linux')).toBe(false);
  });
});

describe('overlay re-raise (issue #102)', () => {
  it('only on Windows, at most every OVERLAY_RAISE_MS', () => {
    expect(overlayRaiseDue('win32', 10_000, 0)).toBe(true);
    expect(overlayRaiseDue('win32', 10_000, 10_000 - OVERLAY_RAISE_MS + 1)).toBe(false);
    expect(overlayRaiseDue('win32', 10_000, 10_000 - OVERLAY_RAISE_MS)).toBe(true);
    expect(overlayRaiseDue('darwin', 10_000, 0)).toBe(false);
  });
});
