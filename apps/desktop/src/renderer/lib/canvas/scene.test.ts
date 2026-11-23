import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { CanvasDoc } from './doc';
import { Scene, visualBounds, type SceneChange } from './scene';
import { REMOTE, ids, makeDoc, pair, seededRng } from './testing';
import { TextLayouter } from './textLayout';
import { isConnector } from './types';

const sceneOf = (d: CanvasDoc): Scene => new Scene(d, new TextLayouter((t, s) => t.length * s * 0.5));

describe('Scene assembly from a Y.Doc', () => {
  it('builds immutable records for every kind', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 10, y: 20, text: 'note' } },
      { init: { kind: 'text', x: 0, y: 0, w: 100, size: 20, text: 'hello' } },
      { init: { kind: 'shape', shape: 'ellipse', x: 5, y: 5, w: 50, h: 40 } },
    ]);
    const s = sceneOf(d);
    expect(s.size).toBe(3);
    expect(s.get('o1')).toMatchObject({ kind: 'sticky', x: 10, y: 20, w: 160, h: 160, text: 'note' });
    expect(s.get('o2')).toMatchObject({ kind: 'text', w: 100, size: 20 });
    expect(s.get('o3')).toMatchObject({ kind: 'shape', shape: 'ellipse', w: 50, h: 40 });
    expect(Object.isFrozen(s.get('o1'))).toBe(false); // plain data, replaced rather than mutated
  });
  it('text objects get their height from the layout', () => {
    const d = makeDoc();
    d.create({ kind: 'text', x: 0, y: 0, w: 108, size: 20, text: 'aaaa bbbb cccc dddd' });
    const s = sceneOf(d);
    const t = s.get('o1');
    // content width 100 → 10 chars per line → 2 lines of 26 px + 2×4 padding
    expect(t?.h).toBeCloseTo(2 * 26 + 8);
  });
  it('replaces the record (and keeps untouched ones identical) on change', () => {
    const d = makeDoc();
    d.createMany([{ init: { kind: 'sticky', x: 0, y: 0 } }, { init: { kind: 'sticky', x: 300, y: 0 } }]);
    const s = sceneOf(d);
    const a0 = s.get('o1');
    const b0 = s.get('o2');
    d.patch('o1', { x: 50 });
    expect(s.get('o1')).not.toBe(a0);
    expect(s.get('o1')?.x).toBe(50);
    expect(a0?.x).toBe(0);
    expect(s.get('o2')).toBe(b0);
  });
  it('reports what changed, with old and new bounds as dirty rects', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    const s = sceneOf(d);
    const seen: SceneChange[] = [];
    s.subscribe((c) => seen.push(c));
    d.patch('o1', { x: 1000 });
    expect(seen).toHaveLength(1);
    expect([...(seen[0]?.ids ?? [])]).toEqual(['o1']);
    expect(seen[0]?.dirty.some((r) => r.x < 10)).toBe(true);
    expect(seen[0]?.dirty.some((r) => r.x > 900)).toBe(true);
    expect(seen[0]?.order).toBe(false);
    expect(seen[0]?.full).toBe(false);
  });
  it('batches a whole transaction into one notification', () => {
    const d = makeDoc();
    const s = sceneOf(d);
    const fn = vi.fn();
    s.subscribe(fn);
    d.createMany(Array.from({ length: 50 }, (_, i) => ({ init: { kind: 'sticky' as const, x: i, y: 0 } })));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.size).toBe(50);
  });
  it('picks up Y.Text edits', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'a' });
    const s = sceneOf(d);
    d.setText('o1', 'abc');
    expect(s.get('o1')).toMatchObject({ text: 'abc' });
  });
  it('removes deleted objects from the index', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    const s = sceneOf(d);
    d.remove(['o1']);
    expect(s.has('o1')).toBe(false);
    expect(s.query({ x: -10, y: -10, w: 500, h: 500 })).toEqual([]);
    expect(s.orderedIds()).toEqual([]);
  });
  it('applies a remote update the same way', () => {
    const { a, b } = pair();
    const s = sceneOf(b);
    a.create({ kind: 'shape', x: 40, y: 40 });
    expect(s.get('a1')).toMatchObject({ kind: 'shape', x: 40 });
    a.setText('a1', 'remote');
    expect(s.get('a1')).toMatchObject({ text: 'remote' });
  });
  it('ignores unknown kinds and sanitizes bad fields from other versions', () => {
    const y = new Y.Doc();
    const d = new CanvasDoc(y);
    y.transact(() => {
      const m = new Y.Map<unknown>();
      d.objects.set('weird', m);
      m.set('kind', 'hologram');
      const n = new Y.Map<unknown>();
      d.objects.set('bad', n);
      n.set('kind', 'sticky');
      n.set('x', 'NaN');
      n.set('w', -9);
      n.set('z', 5);
    }, REMOTE);
    const s = sceneOf(d);
    expect(s.has('weird')).toBe(false);
    expect(s.get('bad')).toMatchObject({ x: 0, w: 24, z: '' });
  });
  it('orders by z, then id', () => {
    const d = makeDoc();
    d.createMany([1, 2, 3].map(() => ({ init: { kind: 'sticky' as const, x: 0, y: 0 } })));
    const s = sceneOf(d);
    d.bringToFront(['o1']);
    expect(s.orderedIds()).toEqual(['o2', 'o3', 'o1']);
    expect(s.rankOf('o1')).toBe(2);
    expect(s.all().map((o) => o.id)).toEqual(['o2', 'o3', 'o1']);
  });
  it('stops listening after destroy', () => {
    const d = makeDoc();
    const s = sceneOf(d);
    s.destroy();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    expect(s.size).toBe(0);
  });
});

describe('connectors in the scene', () => {
  const setup = () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'sticky', x: 500, y: 0 } },
      { init: { kind: 'connector', from: { id: 'o1', side: 'auto' }, to: { id: 'o2', side: 'auto' }, route: 'elbow' } },
    ]);
    return { d, s: sceneOf(d) };
  };
  const conn = (s: Scene) => {
    const c = s.get('o3');
    if (!c || !isConnector(c)) throw new Error('no connector');
    return c;
  };
  it('routes between the glued objects', () => {
    const { s } = setup();
    expect(conn(s).points.slice(0, 2)).toEqual([160, 80]);
    expect(conn(s).points.slice(-2)).toEqual([500, 80]);
  });
  it('follows a moved target', () => {
    const { d, s } = setup();
    const before = conn(s);
    d.patch('o2', { x: 800, y: 300 });
    const after = conn(s);
    expect(after).not.toBe(before);
    expect(after.points.slice(-2)).toEqual([800, 380]);
  });
  it('follows a resized target', () => {
    const { d, s } = setup();
    d.patch('o1', { w: 400, h: 400 });
    expect(conn(s).points.slice(0, 2)).toEqual([400, 200]);
  });
  it('notifies the connector as changed when its target moves', () => {
    const { d, s } = setup();
    const seen: SceneChange[] = [];
    s.subscribe((c) => seen.push(c));
    d.patch('o2', { y: 100 });
    expect(seen[0]?.ids.has('o3')).toBe(true);
    expect(s.connectorsOf('o2').has('o3')).toBe(true);
  });
  it('is detached by the doc when its target is deleted: the end stays put', () => {
    const { d, s } = setup();
    d.remove(['o2'], (c, e) => s.pointOf(c, e));
    const c = conn(s);
    expect(c.to).toEqual({ x: 500, y: 80 });
    expect(c.points.slice(-2)).toEqual([500, 80]);
    expect(s.connectorsOf('o2').size).toBe(0);
  });
  it('survives a remote delete of its target by staying where it was', () => {
    const { a, b } = pair();
    a.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'sticky', x: 500, y: 0 } },
      { init: { kind: 'connector', from: { id: 'a1', side: 'auto' }, to: { id: 'a2', side: 'auto' } } },
    ]);
    const s = sceneOf(b);
    const c0 = s.get('a3');
    a.objects.delete('a2'); // a raw delete (no detach), as a concurrent client could produce
    const c = s.get('a3');
    expect(c).not.toBe(c0);
    expect(c && isConnector(c) ? c.points.slice(-2) : null).toEqual([500, 80]);
  });
  it('re-attaches when the target comes back (undo of the delete)', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'sticky', x: 500, y: 0 } },
      { init: { kind: 'connector', from: { id: 'o1', side: 'auto' }, to: { id: 'o2', side: 'auto' } } },
    ]);
    const s = sceneOf(d);
    d.undo.stopCapturing();
    d.transact(() => d.objects.delete('o2'));
    d.undo.stopCapturing();
    d.undo.undo();
    expect(s.has('o2')).toBe(true);
    expect(s.connectorsOf('o2').has('o3')).toBe(true);
  });
  it('a connector with a label has a larger visual box', () => {
    const { d, s } = setup();
    d.patch('o3', { to: { x: 200, y: 80 }, label: 'yes' });
    const labelled = visualBounds(conn(s));
    // 40 px of line, but the label plate (180 × 28) is centered on its middle
    expect(labelled.w).toBeGreaterThanOrEqual(180);
    expect(labelled.x).toBeLessThanOrEqual(180 - 90);
  });
  it('elbow routes are cached across rebuilds with the same geometry', () => {
    const { d, s } = setup();
    const hits = s.routes.hits;
    d.patch('o3', { stroke: 'red' });
    expect(s.routes.hits).toBe(hits + 1);
  });
});

describe('queries', () => {
  const populated = () => {
    const d = new CanvasDoc(new Y.Doc(), { rng: seededRng(3), makeId: ids() });
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'sticky', x: 100, y: 100 } }, // overlaps o1, above it
      { init: { kind: 'shape', shape: 'ellipse', x: 1000, y: 0, w: 200, h: 200, fill: 'blue' } },
      { init: { kind: 'shape', shape: 'rect', x: 2000, y: 0, w: 200, h: 200 } },
      { init: { kind: 'connector', from: { x: 0, y: 500 }, to: { x: 400, y: 500 } } },
    ]);
    return sceneOf(d);
  };
  it('culls by rect and returns bottom → top', () => {
    const s = populated();
    expect(s.query({ x: 120, y: 120, w: 10, h: 10 }).map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(s.query({ x: 995, y: 0, w: 10, h: 5 }).map((o) => o.id)).toEqual(['o3']);
    expect(s.query({ x: 5000, y: 5000, w: 5, h: 5 })).toEqual([]);
  });
  it('hit-tests the topmost object', () => {
    const s = populated();
    expect(s.hit({ x: 120, y: 120 }, 2)?.id).toBe('o2');
    expect(s.hit({ x: 10, y: 10 }, 2)?.id).toBe('o1');
    expect(s.hit({ x: 700, y: 700 }, 2)).toBeNull();
  });
  it('hit-tests real shape outlines: ellipse corners miss, unfilled shapes pick only the border', () => {
    const s = populated();
    expect(s.hit({ x: 1100, y: 100 }, 2)?.id).toBe('o3');
    expect(s.hit({ x: 1005, y: 5 }, 2)).toBeNull();
    expect(s.hit({ x: 2100, y: 100 }, 3)).toBeNull();
    expect(s.hit({ x: 2000, y: 100 }, 3)?.id).toBe('o4');
  });
  it('hitArea picks the whole area of an unfilled shape; hit (selection) still only its border', () => {
    const s = populated();
    expect(s.hit({ x: 2100, y: 100 }, 3)).toBeNull();
    expect(s.hitArea({ x: 2100, y: 100 }, 3)?.id).toBe('o4');
    expect(s.hitArea({ x: 2000, y: 100 }, 3)?.id).toBe('o4');
    expect(s.hitArea({ x: 2250, y: 100 }, 3)).toBeNull();
    expect(s.hitArea({ x: 1005, y: 5 }, 2)).toBeNull(); // outside the ellipse itself
    expect(s.hitArea({ x: 120, y: 120 }, 2)?.id).toBe('o2'); // stickies as before
  });
  it('hit-tests connectors by distance', () => {
    const s = populated();
    expect(s.hit({ x: 200, y: 504 }, 6)?.id).toBe('o5');
    expect(s.hit({ x: 200, y: 520 }, 6)).toBeNull();
  });
  it('honours the accept filter', () => {
    const s = populated();
    expect(s.hit({ x: 120, y: 120 }, 2, (o) => o.id !== 'o2')?.id).toBe('o1');
  });
  it('marquee picks only what it takes whole, connectors by their path', () => {
    const s = populated();
    // Crossing two stickies takes neither (Miro): only what lies wholly inside.
    expect(s.inRect({ x: 90, y: 90, w: 20, h: 20 })).toEqual([]);
    expect(s.inRect({ x: -10, y: -10, w: 180, h: 180 }).map((o) => o.id)).toEqual(['o1']);
    expect(s.inRect({ x: -10, y: -10, w: 300, h: 300 }).map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(s.inRect({ x: 190, y: 490, w: 20, h: 20 })).toEqual([]);
    expect(s.inRect({ x: -10, y: 480, w: 420, h: 40 }).map((o) => o.id)).toEqual(['o5']);
  });
  it('a frame over the stickies of a column leaves the column out', () => {
    const d = new CanvasDoc(new Y.Doc(), { rng: seededRng(3), makeId: ids() });
    d.createMany([
      { init: { kind: 'shape', shape: 'rect', x: 0, y: 0, w: 400, h: 2000, fill: 'green' } },
      { init: { kind: 'sticky', x: 20, y: 20 } },
      { init: { kind: 'sticky', x: 200, y: 400 } },
    ]);
    const s = sceneOf(d);
    expect(s.inRect({ x: -50, y: 10, w: 600, h: 700 }).map((o) => o.id)).toEqual(['o2', 'o3']);
  });
  it('bounds of all or some', () => {
    const s = populated();
    expect(s.bounds(['o1', 'o2'])).toEqual({ x: 0, y: 0, w: 260, h: 260 });
    expect(s.bounds(['nope'])).toBeNull();
    expect(s.bounds()?.w).toBe(2200);
  });
  it('culls 5000 objects to the viewport', () => {
    const d = makeDoc();
    d.createMany(Array.from({ length: 5000 }, (_, i) => ({ init: { kind: 'sticky' as const, x: (i % 100) * 200, y: Math.floor(i / 100) * 200 } })));
    const s = sceneOf(d);
    const vis = s.query({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(vis.length).toBeGreaterThan(20);
    expect(vis.length).toBeLessThan(150);
    expect(s.size).toBe(5000);
  });
});
