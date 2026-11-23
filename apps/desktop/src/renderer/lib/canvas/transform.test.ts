import { describe, expect, it } from 'vitest';
import { CanvasDoc } from './doc';
import {
  angleToward, handlePointRot, hitHandleRot, normRot, resizeCursorAt, resizeRotated, rotateHandlePoint, rotatePoint, rotatedBounds,
  rotatedCorners, rotatedRectHitsRect, snapAngle, toLocal,
} from './geometry';
import { anchorOf, routeConnector, sideDirOf } from './route';
import { Scene } from './scene';
import { pair, REMOTE, makeDoc } from './testing';
import { TextLayouter } from './textLayout';
import { aabb, isBox, type BoxRec } from './types';

const near = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
};
const sceneOf = (d: CanvasDoc): Scene => new Scene(d, new TextLayouter((t, s) => t.length * s * 0.5));

describe('rotation geometry', () => {
  it('normalizes angles into [0, 360) without float dust', () => {
    expect(normRot(0)).toBe(0);
    expect(normRot(360)).toBe(0);
    expect(normRot(-90)).toBe(270);
    expect(normRot(725)).toBe(5);
    expect(normRot(359.999)).toBe(0);
    expect(normRot(NaN)).toBe(0);
  });
  it('rotates a point clockwise about a center (y down)', () => {
    near(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
    near(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 180), { x: -10, y: 0 });
    near(toLocal({ x: 0, y: 0, w: 20, h: 20 }, 90, rotatePoint({ x: 3, y: 4 }, { x: 10, y: 10 }, 90)), { x: 3, y: 4 });
  });
  it('the circumscribed rect of a 100×50 box turned 90° is 50×100 about the same center; at 45° it is (w+h)/√2 square', () => {
    const r = { x: 0, y: 0, w: 100, h: 50 };
    const b = rotatedBounds(r, 90);
    expect(b.w).toBeCloseTo(50);
    expect(b.h).toBeCloseTo(100);
    expect(b.x + b.w / 2).toBeCloseTo(50);
    expect(b.y + b.h / 2).toBeCloseTo(25);
    const d = rotatedBounds(r, 45);
    expect(d.w).toBeCloseTo((100 + 50) / Math.SQRT2);
    expect(d.h).toBeCloseTo((100 + 50) / Math.SQRT2);
    expect(rotatedBounds(r, 0)).toBe(r);
    const c = rotatedCorners(r, 90);
    near(c[0], { x: 75, y: -25 });
  });
  it('a rotated rect meets a rect only where it really is (not in the corner of its circumscribed box)', () => {
    const r = { x: 0, y: 0, w: 100, h: 20 };
    // At 45° the diagonal strip leaves the corners of its bounding box empty.
    const bb = rotatedBounds(r, 45);
    const corner = { x: bb.x, y: bb.y, w: 5, h: 5 };
    expect(rotatedRectHitsRect(r, 0, corner)).toBe(false);
    expect(rotatedRectHitsRect(r, 45, corner)).toBe(false);
    expect(rotatedRectHitsRect(r, 45, { x: 45, y: 5, w: 10, h: 10 })).toBe(true);
    // 90°: the strip stands upright, it now covers a tall column.
    expect(rotatedRectHitsRect(r, 90, { x: 45, y: -45, w: 10, h: 5 })).toBe(true);
    expect(rotatedRectHitsRect(r, 90, { x: 90, y: 5, w: 5, h: 5 })).toBe(false);
  });
  it('the rotation handle hangs above the top side in the frame\'s own direction', () => {
    const r = { x: 0, y: 0, w: 100, h: 50 };
    near(rotateHandlePoint(r, 0, 30), { x: 50, y: -30 });
    near(rotateHandlePoint(r, 90, 30), { x: 105, y: 25 }); // top turned to the right
    near(rotateHandlePoint(r, 180, 30), { x: 50, y: 80 });
  });
  it('turns the pointer into an angle (top = 0°) and Shift snaps to 15°', () => {
    const c = { x: 0, y: 0 };
    expect(angleToward(c, { x: 0, y: -10 })).toBe(0);
    expect(angleToward(c, { x: 10, y: 0 })).toBe(90);
    expect(angleToward(c, { x: 0, y: 10 })).toBe(180);
    expect(angleToward(c, { x: -10, y: 0 })).toBe(270);
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(snapAngle(52.4)).toBe(45);
    expect(snapAngle(-20)).toBe(-15);
  });
  it('hit-tests handles in the local frame of a rotated box', () => {
    const r = { x: 0, y: 0, w: 100, h: 50 };
    const p = handlePointRot(r, 90, 'e');
    near(p, { x: 50, y: 75 }); // east side of a 90°-turned box points down
    expect(hitHandleRot(r, 90, p, 4)).toBe('e');
    expect(hitHandleRot(r, 90, { x: 100, y: 25 }, 4)).toBeNull(); // where 'e' sits unrotated: nothing
    expect(hitHandleRot(r, 0, { x: 100, y: 25 }, 4)).toBe('e');
  });
  it('resize cursors turn with the frame', () => {
    expect(resizeCursorAt('e', 0)).toBe('ew-resize');
    expect(resizeCursorAt('e', 90)).toBe('ns-resize');
    expect(resizeCursorAt('se', 90)).toBe('nesw-resize');
    expect(resizeCursorAt('e', 45)).toBe('nwse-resize');
  });
});

describe('resizing a rotated frame', () => {
  const start = { x: 100, y: 100, w: 120, h: 60 };
  for (const rot of [30, 90, 135, 250]) {
    for (const handle of ['e', 'w', 's', 'n', 'se', 'nw', 'ne', 'sw'] as const) {
      it(`keeps the opposite side fixed in the world (rot ${rot}, handle ${handle})`, () => {
        const opp = { e: 'w', w: 'e', s: 'n', n: 's', se: 'nw', nw: 'se', ne: 'sw', sw: 'ne' } as const;
        const before = handlePointRot(start, rot, opp[handle]);
        // Drag the handle a bit outwards along the box's own axes.
        const grab = handlePointRot(start, rot, handle);
        const out = rotatePoint({ x: grab.x + 30, y: grab.y + 10 }, grab, 0);
        const next = resizeRotated(start, rot, handle, out, { minW: 10, minH: 10 });
        near(handlePointRot(next, rot, opp[handle]), before);
        expect(next.w).toBeGreaterThanOrEqual(10);
        expect(next.h).toBeGreaterThanOrEqual(10);
      });
    }
  }
  it('a drag along the local x axis changes only the width; the frame turns with the object', () => {
    // 90°: the local x axis points down the screen.
    const grab = handlePointRot(start, 90, 'e');
    const next = resizeRotated(start, 90, 'e', { x: grab.x, y: grab.y + 40 }, { minW: 10, minH: 10 });
    expect(next.w).toBeCloseTo(160);
    expect(next.h).toBeCloseTo(60);
    // The west side (the top of the screen at 90°) did not move: the center slid by half the growth, down the screen.
    near({ x: next.x + next.w / 2, y: next.y + next.h / 2 }, { x: 160, y: 150 });
  });
  it('at rotation 0 it is exactly resizeRect', () => {
    const next = resizeRotated(start, 0, 'se', { x: 300, y: 250 });
    expect(next).toEqual({ x: 100, y: 100, w: 200, h: 150 });
  });
  it('never flips below the minimum size', () => {
    const next = resizeRotated(start, 60, 'e', handlePointRot(start, 60, 'w'), { minW: 24, minH: 24 });
    expect(next.w).toBe(24);
  });
});

describe('Scene with rotated objects', () => {
  it('hit-tests a sticky in its own frame', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, w: 200, h: 40, rot: 90 });
    const s = sceneOf(d);
    // Turned upright about (100, 20): it covers x 80..120, y -80..120.
    expect(s.hit({ x: 100, y: -70 }, 0)?.id).toBe('o1');
    expect(s.hit({ x: 100, y: 110 }, 0)?.id).toBe('o1');
    expect(s.hit({ x: 10, y: 20 }, 0)).toBeNull(); // where the unrotated frame was
    expect(s.hit({ x: 150, y: 20 }, 0)).toBeNull();
  });
  it('hit-tests every shape in its own frame', () => {
    const d = makeDoc();
    const at = (shape: 'rect' | 'ellipse' | 'diamond' | 'triangle' | 'rounded', y: number, rot: number) =>
      d.create({ kind: 'shape', shape, x: 0, y, w: 200, h: 100, fill: 'blue', rot });
    at('rect', 0, 90);
    at('ellipse', 400, 90);
    at('diamond', 800, 45);
    at('triangle', 1200, 180);
    const s = sceneOf(d);
    // rect 200×100 at 90° about (100, 50): x 50..150, y -50..150
    expect(s.hit({ x: 100, y: -40 }, 0)?.id).toBe('o1');
    expect(s.hit({ x: 10, y: 50 }, 0)).toBeNull();
    // ellipse at 90° about (100, 450): the long axis is vertical
    expect(s.hit({ x: 100, y: 360 }, 0)?.id).toBe('o2');
    expect(s.hit({ x: 190, y: 450 }, 0)).toBeNull();
    // diamond turned 45° is a square rotated a further quarter: its tip points up-right; the center is inside, the far corner of the frame is not
    expect(s.hit({ x: 100, y: 850 }, 0)?.id).toBe('o3');
    expect(s.hit({ x: 2, y: 802 }, 0)).toBeNull();
    // triangle at 180°: apex at the bottom; narrow near the bottom middle, wide at the top
    expect(s.hit({ x: 100, y: 1290 }, 0)?.id).toBe('o4');
    expect(s.hit({ x: 30, y: 1290 }, 0)).toBeNull();
    expect(s.hit({ x: 30, y: 1210 }, 0)?.id).toBe('o4');
  });
  it('indexes a rotated object by its circumscribed rect (the grid and culling see the whole of it)', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, w: 400, h: 40, rot: 90 });
    const s = sceneOf(d);
    // Upright it spans y -180..220 about (200, 20); the unrotated frame would not reach y = 200.
    expect(s.query({ x: 190, y: 200, w: 20, h: 10 }).map((o) => o.id)).toEqual(['o1']);
    expect(s.query({ x: 0, y: -100, w: 100, h: 50 })).toEqual([]);
    const b = aabb(s.get('o1') ?? ({} as never));
    expect(b.h).toBeCloseTo(400);
    expect(s.bounds()?.h).toBeCloseTo(400);
  });
  it('the marquee picks a rotated box only with all its corners', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, w: 200, h: 40, rot: 45 });
    const s = sceneOf(d);
    const bb = s.bounds();
    expect(bb).not.toBeNull();
    if (!bb) return;
    expect(s.inRect({ x: bb.x, y: bb.y, w: 10, h: 10 })).toEqual([]);
    expect(s.inRect({ x: 90, y: 10, w: 20, h: 20 })).toEqual([]);
    expect(s.inRect({ x: bb.x - 1, y: bb.y - 1, w: bb.w + 2, h: bb.h + 2 }).map((o) => o.id)).toEqual(['o1']);
  });
  it('a document without the new fields builds the same records as before (no rot / locked / group keys)', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'shape', x: 0, y: 0 } },
      { init: { kind: 'connector', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } } },
    ]);
    const s = sceneOf(d);
    for (const o of s.all()) {
      expect('rot' in o).toBe(false);
      expect('locked' in o).toBe(false);
      expect('group' in o).toBe(false);
    }
    expect(aabb(s.get('o1') ?? ({} as never))).toMatchObject({ x: 0, y: 0, w: 160, h: 160 });
  });
  it('ignores a connector\'s rot and hostile values', () => {
    const d = makeDoc();
    d.create({ kind: 'connector', from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, rot: 90 });
    d.create({ kind: 'sticky', x: 0, y: 0 });
    d.objects.get('o2')?.set('rot', 'nope');
    const s = sceneOf(d);
    expect('rot' in (s.get('o1') ?? {})).toBe(false);
    expect(s.get('o2')?.rot).toBeUndefined();
  });
});

describe('connectors on rotated objects', () => {
  const sticky = (rot = 0): BoxRec => ({ kind: 'sticky', id: 'a', z: 'a', x: 0, y: 0, w: 100, h: 60, color: 'yellow', text: '', ...(rot ? { rot } : {}) });
  it('the glued anchor turns with the object, side by side', () => {
    const a = sticky(90);
    // center (50, 30); the unrotated right anchor (100, 30) turns to (50, 80)
    near(anchorOf(a, 'right'), { x: 50, y: 80 });
    near(anchorOf(a, 'top'), { x: 80, y: 30 });
    near(anchorOf(a, 'left'), { x: 50, y: -20 });
    near(anchorOf(sticky(), 'right'), { x: 100, y: 30 });
  });
  it('the outward direction of a turned side is the nearest axis (orthogonal routes stay orthogonal)', () => {
    expect(sideDirOf(sticky(90), 'right')).toEqual({ x: 0, y: 1 });
    expect(sideDirOf(sticky(180), 'top')).toEqual({ x: 0, y: 1 });
    expect(sideDirOf(sticky(30), 'right')).toEqual({ x: 1, y: 0 });
    expect(sideDirOf(sticky(60), 'right')).toEqual({ x: 0, y: 1 });
  });
  it('an auto side picks the side that faces the other end after the turn', () => {
    const a = sticky(90);
    const other: BoxRec = { kind: 'sticky', id: 'b', z: 'b', x: 40, y: 300, w: 20, h: 20, color: 'yellow', text: '' };
    const lookup = (id: string): BoxRec | undefined => (id === 'a' ? a : id === 'b' ? other : undefined);
    const r = routeConnector({ id: 'a', side: 'auto' }, { id: 'b', side: 'auto' }, 'straight', lookup);
    // The object's right side now points down, toward b.
    expect(r.from.side).toBe('right');
    near({ x: r.points[0] ?? 0, y: r.points[1] ?? 0 }, { x: 50, y: 80 });
  });
  it('an elbow route out of a box turned by an odd angle stays orthogonal from the anchor on', () => {
    const a = sticky(30);
    const b: BoxRec = { kind: 'sticky', id: 'b', z: 'b', x: 400, y: 200, w: 100, h: 60, color: 'yellow', text: '' };
    const lookup = (id: string): BoxRec | undefined => (id === 'a' ? a : id === 'b' ? b : undefined);
    const r = routeConnector({ id: 'a', side: 'right' }, { id: 'b', side: 'left' }, 'elbow', lookup);
    const p = r.points;
    near({ x: p[0] ?? 0, y: p[1] ?? 0 }, anchorOf(a, 'right'));
    for (let i = 2; i + 1 < p.length; i += 2) expect(p[i] === p[i - 2] || p[i + 1] === p[i - 1]).toBe(true);
  });
  it('follows a rotation in the scene: the end moves with the turned side and re-routes', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0, w: 100, h: 60 } },
      { init: { kind: 'connector', from: { id: 'o1', side: 'right' }, to: { x: 300, y: 30 } } },
    ]);
    const s = sceneOf(d);
    expect(s.pointOf('o2', 'from')).toEqual({ x: 100, y: 30 });
    d.patch('o1', { rot: 90 });
    const p = s.pointOf('o2', 'from');
    near(p ?? { x: 0, y: 0 }, { x: 50, y: 80 });
    d.patch('o1', { rot: 0 });
    expect(s.pointOf('o2', 'from')).toEqual({ x: 100, y: 30 });
  });
  it('glues to an unfilled turned frame released inside it (hitArea turns the point back too)', () => {
    const d = makeDoc();
    d.create({ kind: 'shape', x: 0, y: 0, w: 400, h: 40, rot: 90 });
    const s = sceneOf(d);
    // Upright: x 180..220, y -180..220.
    expect(s.hitArea({ x: 200, y: 150 }, 2)?.id).toBe('o1');
    expect(s.hitArea({ x: 50, y: 20 }, 2)).toBeNull();
  });
});

describe('rot in the document', () => {
  it('stores an angle normalized, removes the key at 0, and keeps the rest of the object', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 5, y: 6, text: 'x' });
    d.patch('o1', { rot: 395 });
    expect(d.objects.get('o1')?.get('rot')).toBe(35);
    d.patch('o1', { rot: -10 });
    expect(d.objects.get('o1')?.get('rot')).toBe(350);
    d.patch('o1', { rot: 360 });
    expect(d.objects.get('o1')?.has('rot')).toBe(false);
    expect(d.snapshot('o1')).toMatchObject({ x: 5, y: 6, text: 'x' });
  });
  it('rejects junk and does not rotate connectors', () => {
    const d = makeDoc();
    d.createMany([{ init: { kind: 'sticky', x: 0, y: 0 } }, { init: { kind: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } }]);
    d.patch('o1', { rot: Number.NaN });
    d.patch('o2', { rot: 45 });
    expect(d.objects.get('o1')?.has('rot')).toBe(false);
    expect(d.objects.get('o2')?.has('rot')).toBe(false);
  });
  it('creation inits carry rot, and a plain copy keeps it', () => {
    const d = makeDoc();
    d.create({ kind: 'shape', x: 0, y: 0, rot: 30 });
    expect(d.snapshot('o1')).toMatchObject({ rot: 30 });
    expect(isBox(sceneOf(d).get('o1') ?? ({} as never))).toBe(true);
  });
  it('converges: concurrent rotation and move of the same object merge field by field; the old client\'s keys survive', () => {
    const { a, b, net } = pair();
    a.create({ kind: 'sticky', x: 0, y: 0 }, 'k');
    net.pause();
    a.patch('k', { rot: 40 });
    b.patch('k', { x: 99 });
    net.flush();
    for (const d of [a, b]) {
      expect(d.objects.get('k')?.get('rot')).toBe(40);
      expect(d.objects.get('k')?.get('x')).toBe(99);
    }
    // A client that knows nothing of `rot` edits its own fields and does not erase it.
    const old = b.objects.get('k');
    b.ydoc.transact(() => old?.set('y', 7), REMOTE);
    expect(b.objects.get('k')?.get('rot')).toBe(40);
  });
});
