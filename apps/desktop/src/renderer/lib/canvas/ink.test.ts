import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { parse, serialize, toInits } from './clipboard';
import { CanvasDoc } from './doc';
import { INK_MAX_POINTS, fitErase, fitInk, inkDistance, inkErase, inkFromStroke, inSwath, isDot, simplify, swathsCover, swathToStored, tailRect, traceInk } from './ink';
import { Scene, visualBounds } from './scene';
import { ids, makeDoc } from './testing';
import { TextLayouter } from './textLayout';
import type { InkRec } from './types';

const sceneOf = (d: CanvasDoc): Scene => new Scene(d, new TextLayouter((t, s) => t.length * s * 0.5));
const ink = (s: Scene, id: string): InkRec => {
  const o = s.get(id);
  if (o?.kind !== 'ink') throw new Error(`${id} is not a stroke`);
  return o;
};

describe('eraser swaths', () => {
  it('inSwath: under a capsule or not', () => {
    const e = [50, -20, 50, 20, 8];
    expect(inSwath({ x: 50, y: 0 }, e)).toBe(true);
    expect(inSwath({ x: 57, y: 0 }, e)).toBe(true);
    expect(inSwath({ x: 59, y: 0 }, e)).toBe(false);
    expect(inSwath({ x: 50, y: 0 }, undefined)).toBe(false);
  });
  it('swathsCover: only when the whole width of the line is under them', () => {
    expect(swathsCover([0, 0, 10, 0], 4, [-10, 0, 20, 0, 8])).toBe(true);
    expect(swathsCover([0, 0, 100, 0], 4, [-10, 0, 20, 0, 8])).toBe(false);
    // A swath narrower than the marker leaves its edges.
    expect(swathsCover([0, 0, 10, 0], 32, [-10, 0, 20, 0, 8])).toBe(false);
  });
  it('fitErase stretches the swaths with the frame; swathToStored maps back', () => {
    const raw = [0, 0, 100, 50];
    const e = [50, 25, 60, 25, 4];
    const fit = fitErase(raw, e, 200, 200);
    expect(fit).toEqual([100, 100, 120, 100, 4 * Math.sqrt(8)]);
    expect(fitErase(raw, e, 200, 200)).toBe(fit);
    expect(swathToStored(raw, 200, 200, 100, 100, 120, 100, 4 * Math.sqrt(8))).toEqual(e);
  });
  it('inkErase accepts whole swaths with a positive radius only', () => {
    expect(inkErase([0, 0, 1, 1, 2])).toEqual([0, 0, 1, 1, 2]);
    expect(inkErase([0, 0, 1, 1])).toBeNull();
    expect(inkErase([0, 0, 1, 1, 0])).toBeNull();
    expect(inkErase([0, 0, 1, Number.NaN, 2])).toBeNull();
  });
});

/** The path traceInk draws, sampled: every cubic piece at 16 steps. */
function sampled(pts: readonly number[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  traceInk({
    moveTo: (x, y) => { px = x; py = y; out.push(x, y); },
    lineTo: (x, y) => { px = x; py = y; out.push(x, y); },
    bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => {
      for (let k = 1; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        out.push(u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
      }
      px = x;
      py = y;
    },
  }, pts, 0, 0);
  return out;
}

describe('a released stroke', () => {
  it('draws where its preview drew: the stored path stays within a pixel of the live one, corners included', () => {
    // A marker scribble: a zigzag with sharp turns, sampled every 2 px like coalesced pointer events.
    const raw: number[] = [];
    for (let k = 0; k < 12; k++) {
      const x0 = k * 30;
      for (let s = 0; s <= 60; s++) raw.push(x0 + s * 0.5, k % 2 ? 120 - s * 2 : s * 2);
    }
    const shape = inkFromStroke(raw, 0.75);
    if (!shape) throw new Error('no stroke');
    const live = sampled(raw);
    const stored = sampled(fitInk(shape.points, shape.w, shape.h)).map((v, i) => v + (i % 2 ? shape.y : shape.x));
    let worst = 0;
    for (let i = 0; i + 1 < stored.length; i += 2) {
      worst = Math.max(worst, inkDistance({ x: stored[i] ?? 0, y: stored[i + 1] ?? 0 }, live));
    }
    for (let i = 0; i + 1 < live.length; i += 2) {
      worst = Math.max(worst, inkDistance({ x: live[i] ?? 0, y: live[i + 1] ?? 0 }, stored));
    }
    expect(worst).toBeLessThan(1.25);
  });
});

describe('simplify (Ramer–Douglas–Peucker)', () => {
  it('drops points on a straight run and keeps the corners', () => {
    const line = [0, 0, 10, 0, 20, 0, 30, 0, 30, 10, 30, 20];
    expect(simplify(line, 0.5)).toEqual([0, 0, 30, 0, 30, 20]);
  });
  it('keeps a bump bigger than the tolerance, drops a smaller one', () => {
    expect(simplify([0, 0, 10, 3, 20, 0], 1)).toEqual([0, 0, 10, 3, 20, 0]);
    expect(simplify([0, 0, 10, 0.4, 20, 0], 1)).toEqual([0, 0, 20, 0]);
  });
  it('handles one and two points, and a long stroke without recursion', () => {
    expect(simplify([5, 5], 1)).toEqual([5, 5]);
    expect(simplify([1, 2, 3, 4], 1)).toEqual([1, 2, 3, 4]);
    const zig: number[] = [];
    for (let i = 0; i < 100_000; i++) zig.push(i, i % 2 ? 5 : 0);
    expect(simplify(zig, 1).length).toBe(zig.length);
  });
});

describe('inkFromStroke', () => {
  it('moves the points to the frame corner and rounds them to 0.5', () => {
    const s = inkFromStroke([100.3, 50.2, 140.71, 50.2, 140.71, 90.9], 0.5);
    expect(s).toEqual({ x: 100.5, y: 50, w: 40, h: 41, points: [0, 0, 40, 0, 40, 41] });
  });
  it('a click without a drag is a dot of two equal points', () => {
    const s = inkFromStroke([10, 20], 0.5);
    expect(s?.points).toEqual([0, 0, 0, 0]);
    expect(s && isDot(s.points)).toBe(true);
    expect(inkFromStroke([], 0.5)).toBeNull();
  });
  it('a stroke too detailed for the cap is simplified harder until it fits', () => {
    const pts: number[] = [];
    for (let i = 0; i < 8000; i++) pts.push(i * 0.7, Math.sin(i) * 40);
    const s = inkFromStroke(pts, 0.1);
    expect(s).not.toBeNull();
    expect((s?.points.length ?? 0) / 2).toBeLessThanOrEqual(INK_MAX_POINTS);
    expect(s?.points.length).toBeGreaterThan(100);
  });
});

describe('stroke geometry', () => {
  it('fitInk stretches the points with the frame and keeps the array while the size is the same', () => {
    const raw = [0, 0, 10, 20];
    expect(fitInk(raw, 10, 20)).toBe(raw);
    const big = fitInk(raw, 30, 40);
    expect(big).toEqual([0, 0, 30, 40]);
    expect(fitInk(raw, 30, 40)).toBe(big);
    // A straight line does not span the other axis: it stays in the middle of the frame.
    expect(fitInk([0, 0, 50, 0], 100, 24)).toEqual([0, 12, 100, 12]);
  });
  it('inkDistance measures to the line, a dot to its point', () => {
    expect(inkDistance({ x: 5, y: 3 }, [0, 0, 10, 0])).toBe(3);
    expect(inkDistance({ x: 3, y: 4 }, [0, 0])).toBe(5);
  });
  it('traceInk: cubic pieces through every point (the stored corners stay), a line for two points', () => {
    const ends: number[][] = [];
    const sink = {
      moveTo: (x: number, y: number) => ends.push([x, y]),
      lineTo: (x: number, y: number) => ends.push([x, y]),
      bezierCurveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => ends.push([x, y]),
    };
    traceInk(sink, [0, 0, 10, 0, 10, 10, 20, 10], 100, 0);
    expect(ends).toEqual([[100, 0], [110, 0], [110, 10], [120, 10]]);
    ends.length = 0;
    traceInk(sink, [0, 0, 10, 0], 0, 0);
    expect(ends).toEqual([[0, 0], [10, 0]]);
  });
  it('traceInk: a straight run stays straight (controls on the line)', () => {
    const ctrl: number[] = [];
    traceInk({ moveTo: () => {}, lineTo: () => {}, bezierCurveTo: (_a, b, _c, d) => ctrl.push(b, d) }, [0, 0, 10, 0, 50, 0, 60, 0], 0, 0);
    expect(ctrl.every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });
  it('tailRect covers the last points with the pad', () => {
    expect(tailRect([0, 0, 100, 100, 110, 100, 120, 90], 3, 2)).toEqual({ x: 98, y: 88, w: 24, h: 14 });
  });
});

describe('ink in the document', () => {
  const stroke = { kind: 'ink' as const, x: 10, y: 20, w: 100, h: 50, points: [0, 0, 50, 50, 100, 0], stroke: 'blue', strokeWidth: 4 };

  it('create is one undo step; undo removes the stroke, redo brings it back', () => {
    const d = makeDoc();
    const id = d.create(stroke) ?? '';
    expect(d.snapshot(id)).toMatchObject({ kind: 'ink', x: 10, y: 20, w: 100, h: 50, points: [0, 0, 50, 50, 100, 0], stroke: 'blue', strokeWidth: 4 });
    expect(d.undo.undoStack.length).toBe(1);
    d.undo.undo();
    expect(d.count).toBe(0);
    d.undo.redo();
    expect(d.count).toBe(1);
  });
  it('refuses a stroke without sane points and clamps its fields', () => {
    const d = makeDoc();
    expect(d.create({ ...stroke, points: [] })).toBeNull();
    expect(d.create({ ...stroke, points: [1, 2, 3] })).toBeNull();
    expect(d.create({ ...stroke, points: [0, Number.NaN] })).toBeNull();
    expect(d.create({ ...stroke, points: new Array(2 * INK_MAX_POINTS + 2).fill(0) })).toBeNull();
    const id = d.create({ ...stroke, strokeWidth: 500, marker: true }) ?? '';
    expect(d.snapshot(id)).toMatchObject({ strokeWidth: 64, marker: true });
    d.patch(id, { w: 0.2, h: 3, strokeWidth: 0 });
    expect(d.snapshot(id)).toMatchObject({ w: 1, h: 3, strokeWidth: 1 });
    // No text on a stroke.
    d.setText(id, 'hello');
    expect(d.objects.get(id)?.get('text')).toBeUndefined();
  });
  it('the scene fits the stored points to a resized frame and picks the stroke by its line', () => {
    const d = makeDoc();
    const id = d.create(stroke) ?? '';
    const s = sceneOf(d);
    const o = ink(s, id);
    expect(o.points).toEqual([0, 0, 50, 50, 100, 0]);
    // On the line (with half its width as slack) — yes; in the empty corner of its frame — no.
    expect(s.hit({ x: 60, y: 70 }, 0)?.id).toBe(id);
    expect(s.hit({ x: 60, y: 73 }, 1)?.id).toBe(id);
    expect(s.hit({ x: 12, y: 65 }, 2)).toBeNull();
    expect(visualBounds(o)).toEqual({ x: 7, y: 17, w: 106, h: 56 });
    d.patch(id, { w: 200 });
    expect(ink(s, id).points).toEqual([0, 0, 100, 50, 200, 0]);
    // The marquee takes it only whole, by its points.
    expect(s.inRect({ x: 50, y: 40, w: 20, h: 10 })).toEqual([]);
    expect(s.inRect({ x: 5, y: 15, w: 215, h: 60 }).map((r) => r.id)).toEqual([id]);
  });
  it('a rotated stroke is hit in its own frame', () => {
    const d = makeDoc();
    const id = d.create({ ...stroke, points: [0, 0, 100, 0], w: 100, h: 1, rot: 90 }) ?? '';
    const s = sceneOf(d);
    // Turned 90° about the center (60, 20.5): the line runs vertically through x = 60.
    expect(s.hit({ x: 60, y: -20 }, 1)?.id).toBe(id);
    expect(s.hit({ x: 20, y: 20.5 }, 1)).toBeNull();
  });
  it('copy and paste keep the stroke whole', () => {
    const d = makeDoc({ makeId: ids('a') });
    const id = d.create({ ...stroke, marker: true }) ?? '';
    const s = sceneOf(d);
    const text = serialize(s, d, [id]);
    const payload = text ? parse(text) : null;
    expect(payload).not.toBeNull();
    if (!payload) return;
    const [copy] = toInits(payload, 5, 5, ids('b'));
    expect(copy?.init).toMatchObject({ kind: 'ink', x: 15, y: 25, w: 100, h: 50, points: [0, 0, 50, 50, 100, 0], stroke: 'blue', strokeWidth: 4, marker: true });
    // A pasted stroke with broken points is dropped.
    const bad = { ...payload, objects: payload.objects.map((o) => ({ ...o, points: 'x' })) };
    expect(toInits(bad, 0, 0)).toEqual([]);
  });
});

describe('a kind this build does not know (what a build before strokes does with `ink`)', () => {
  /** Writes an object the way a newer build would, with a kind outside this build's list. */
  const future = (d: CanvasDoc, id: string, kind: string): void => {
    d.ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      d.objects.set(id, m);
      m.set('kind', kind);
      m.set('z', 'a5');
      m.set('x', 0);
      m.set('y', 0);
      m.set('points', [0, 0, 10, 10]);
    });
  };

  it('is skipped by the scene, the snapshot, the clipboard and the patches, and nothing breaks', () => {
    const d = makeDoc();
    const keep = d.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    future(d, 'zz', 'hologram');
    const s = sceneOf(d);
    expect(s.size).toBe(1);
    expect(s.get('zz')).toBeUndefined();
    expect(s.hit({ x: 5, y: 5 }, 4)?.id).toBe(keep);
    expect(d.snapshot('zz')).toBeNull();
    expect(serialize(s, d, ['zz'])).toBeNull();
    d.patch('zz', { x: 50 });
    expect(d.objects.get('zz')?.get('x')).toBe(0);
    // Arriving later (a co-author's write) it is skipped the same way.
    future(d, 'zy', 'hologram');
    expect(s.size).toBe(1);
    // The document keeps it untouched for the builds that know it.
    expect(d.objects.get('zz')?.get('kind')).toBe('hologram');
  });
  it('a stroke with broken points is skipped by the scene, not drawn as garbage', () => {
    const d = makeDoc();
    future(d, 'zz', 'ink');
    d.objects.get('zz')?.set('points', [0, 'x']);
    expect(sceneOf(d).size).toBe(0);
  });
});
