// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCALE } from '../../../lib/canvas/camera';
import { anchorPoint } from '../../../lib/canvas/route';
import { isBox, isConnector } from '../../../lib/canvas/types';
import { defaultPalette } from './palette';
import { destroyRigs, rig, type Rig } from './testRig';

const sticky = (x: number, y: number, extra: object = {}) => ({ init: { kind: 'sticky' as const, x, y, ...extra } });
const objs = (r: Rig) => r.engine.doc;
const macrotask = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('creation tools', () => {
  it('a click with the sticky tool places a sticky, selects it and opens the text editor', () => {
    const r = rig();
    r.engine.setTool('sticky');
    r.click(300, 300);
    expect(objs(r).count).toBe(1);
    const s = r.engine.getState();
    expect(s.tool).toBe('select');
    expect(s.selectionCount).toBe(1);
    expect(s.editing).toBe(true);
    expect(objs(r).snapshot(s.selectedId ?? '')).toMatchObject({ kind: 'sticky', x: 220, y: 220, w: 160, h: 160 });
    const ta = r.host.querySelector('textarea');
    expect(ta).not.toBeNull();
    if (!ta) return;
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input'));
    r.engine.editor.commit();
    expect(objs(r).getText(s.selectedId ?? '')).toBe('hello');
    expect(r.engine.getState().editing).toBe(false);
  });
  it('dragging with the shape tool sizes the shape and uses the chosen kind', () => {
    const r = rig();
    r.engine.setShapeKind('diamond');
    r.engine.setTool('shape');
    r.drag([100, 100], [300, 250]);
    const id = r.engine.getState().selectedId ?? '';
    expect(objs(r).snapshot(id)).toMatchObject({ kind: 'shape', shape: 'diamond', x: 100, y: 100, w: 200, h: 150 });
  });
  it('an empty text object is dropped when editing ends without text', () => {
    const r = rig();
    r.engine.setTool('text');
    r.click(200, 200);
    expect(objs(r).count).toBe(1);
    r.engine.editor.commit();
    expect(objs(r).count).toBe(0);
  });
  it('double-click on empty canvas creates a text object; on an object it edits it', () => {
    const r = rig();
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 50, clientY: 60 }));
    expect(objs(r).count).toBe(1);
    expect(r.engine.getState().editing).toBe(true);
    r.engine.editor.commit();
    const [id] = r.make(sticky(400, 400, { text: 'abc' }));
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 450, clientY: 450 }));
    expect(r.engine.getState().selectedId).toBe(id);
    expect(r.host.querySelector('textarea')?.value).toBe('abc');
  });
  it('snaps new objects to the grid unless ⌘/Ctrl is held', () => {
    const r = rig({ gridSize: 8 });
    r.engine.setTool('shape');
    r.drag([101, 99], [203, 197]);
    const id = r.engine.getState().selectedId ?? '';
    expect(objs(r).snapshot(id)).toMatchObject({ x: 104, y: 96, w: 96, h: 104 });
  });
  it('refuses to create beyond 5000 objects', () => {
    const r = rig();
    r.engine.doc.ydoc.transact(() => {
      for (let i = 0; i < 5000; i++) r.engine.doc.objects.set(`f${i}`, new Y.Map());
    });
    r.engine.setTool('sticky');
    r.click(10, 10);
    expect(objs(r).count).toBe(5000);
    expect(r.engine.getState().editing).toBe(false);
  });
});

describe('selection, move, resize', () => {
  it('clicking selects the topmost, empty canvas clears, Shift toggles', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(100, 100));
    r.click(120, 120);
    expect(r.engine.getState().selectedId).toBe(b);
    r.click(10, 10);
    expect(r.engine.getState().selectedId).toBe(a);
    r.click(600, 600);
    expect(r.engine.getState().selectionCount).toBe(0);
    r.click(10, 10);
    r.click(120, 120, { shiftKey: true });
    expect(r.engine.getState().selectionCount).toBe(2);
    expect(r.engine.getState().selectedId).toBeNull();
    r.click(120, 120, { shiftKey: true });
    expect(r.engine.getState().selectedId).toBe(a);
  });
  it('a marquee selects what it takes whole', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(0, 0), sticky(300, 0), sticky(700, 500));
    r.drag([-20, -20], [350, 200]);
    expect([...r.engine.selection]).toEqual([a]); // b is only crossed
    r.drag([-20, -20], [480, 180]);
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
    expect(r.engine.selection.has(c ?? '')).toBe(false);
    r.drag([-30, 900], [-10, 910]);
    expect(r.engine.getState().selectionCount).toBe(0);
  });
  it('drags a selection and writes one undo step', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.engine.doc.undo.stopCapturing();
    r.drag([150, 150], [210, 190]);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 160, y: 140 });
    expect(r.engine.getState().canUndo).toBe(true);
    r.key('z', { metaKey: true });
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 100, y: 100 });
    r.key('z', { metaKey: true, shiftKey: true });
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 160, y: 140 });
  });
  it('a click without moving writes nothing', () => {
    const r = rig();
    r.make(sticky(100, 100));
    r.engine.doc.undo.stopCapturing();
    const before = r.engine.doc.undo.undoStack.length;
    r.click(150, 150);
    expect(r.engine.doc.undo.undoStack.length).toBe(before);
  });
  it('Shift constrains the drag to one axis', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.drag([150, 150], [250, 170], { shiftKey: true });
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 200, y: 100 });
  });
  it('Alt-drag duplicates and moves the copy', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100, { text: 'orig' }));
    r.drag([150, 150], [450, 150], { altKey: true });
    expect(objs(r).count).toBe(2);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 100 });
    const copy = r.engine.getState().selectedId ?? '';
    expect(copy).not.toBe(a);
    expect(objs(r).snapshot(copy)).toMatchObject({ x: 400, y: 100, text: 'orig' });
  });
  it('snaps to a neighbour\'s edge and shows the guide while dragging', () => {
    const r = rig();
    r.make(sticky(0, 0), sticky(400, 300));
    r.down(480, 380);
    r.move(500, 360);
    r.move(0 + 160 + 4 + 80, 100);
    // the dragged sticky's left edge would sit at 164 → attracted to the first one's right edge (160)
    const second = [...r.engine.selection][0] ?? '';
    expect(r.engine.scene.get(second)?.x).toBe(160);
    expect(r.engine['overlay'].guides.length).toBeGreaterThan(0);
    r.up(244, 100);
    expect(objs(r).snapshot(second)?.x).toBe(160);
    expect(r.engine['overlay'].guides).toEqual([]);
  });
  it('snaps to the grid, and ⌘/Ctrl turns snapping off', () => {
    const r = rig({ gridSize: 8 });
    const [a] = r.make(sticky(100, 100));
    r.drag([150, 150], [163, 157]);
    expect(objs(r).snapshot(a ?? '')?.x ?? 0).toBe(112);
    r.drag([170, 170], [183, 177], { ctrlKey: true });
    expect(objs(r).snapshot(a ?? '')?.x).toBe(125);
  });
  it('resizes from the 8 handles, Shift keeps the aspect ratio', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100, { w: 200, h: 100 }));
    r.click(150, 150);
    r.drag([300, 200], [400, 260]); // se handle
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 100, y: 100, w: 300, h: 160 });
    r.drag([100, 100], [150, 120]); // nw handle
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 150, y: 120, w: 250, h: 140 });
    r.drag([275, 120], [275, 60]); // n handle
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ y: 60, h: 200 });
    r.drag([400, 160], [500, 160], { shiftKey: true }); // e handle ignores the ratio
    expect(objs(r).snapshot(a ?? '')?.w).toBe(350);
    const before = objs(r).snapshot(a ?? '');
    r.drag([500, 260], [600, 260], { shiftKey: true }); // se corner with Shift
    const after = objs(r).snapshot(a ?? '');
    expect(Number(after?.w) / Number(after?.h)).toBeCloseTo(Number(before?.w) / Number(before?.h), 1);
  });
  it('resizing a text box changes its width only', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'text', x: 100, y: 100, w: 200, text: 'hello' } });
    r.click(150, 110);
    expect(r.engine.getState().selectedId).toBe(a);
    const h = r.engine.scene.get(a ?? '')?.h ?? 0;
    r.drag([300, 100 + h / 2], [400, 100 + h / 2]);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ w: 300, x: 100 });
    r.drag([300, 100], [350, 400]); // a corner of a text box: width/height not both free
    expect(objs(r).snapshot(a ?? '')).not.toHaveProperty('h');
  });
  it('resizes a multi-selection as a group', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0, { w: 100, h: 100 }), sticky(100, 0, { w: 100, h: 100 }));
    r.engine.selectAll();
    r.drag([200, 100], [400, 100]);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 0, w: 200 });
    expect(objs(r).snapshot(b ?? '')).toMatchObject({ x: 200, w: 200 });
  });
  it('a text in a multi-selection moves with the group when the top handle is dragged', () => {
    const r = rig();
    const [box, txt] = r.make(sticky(100, 100, { w: 100, h: 100 }), { init: { kind: 'text' as const, x: 100, y: 300, w: 200, text: 'hi' } });
    r.engine.selectAll();
    const f = r.engine.selectionFrame();
    if (!f) throw new Error('no frame');
    const g = f.rect;
    r.drag([g.x + g.w / 2, g.y], [g.x + g.w / 2, g.y - 100]);
    expect(objs(r).snapshot(box ?? '')).toMatchObject({ y: 0 });
    // The group's top went up by 100 and it grew by as much: the text keeps its relative place.
    const y = (g.y - 100) + ((300 - g.y) * (g.h + 100)) / g.h;
    expect(objs(r).snapshot(txt ?? '')?.y).toBeCloseTo(y, 6);
  });
  it('Escape during a drag restores the position', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.down(150, 150);
    r.move(250, 250);
    // Shown where the pointer is; the document is written on release only.
    expect(r.engine.scene.get(a ?? '')?.x).toBe(200);
    expect(objs(r).snapshot(a ?? '')?.x).toBe(100);
    r.key('Escape');
    expect(r.engine.scene.get(a ?? '')).toMatchObject({ x: 100, y: 100 });
    r.up(250, 250);
    expect(objs(r).snapshot(a ?? '')?.x).toBe(100);
    expect(r.engine.getState().canUndo).toBe(true); // the creation, untouched
  });
  it('arrow keys nudge, Shift by 10', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.click(150, 150);
    r.key('ArrowRight');
    r.key('ArrowDown', { shiftKey: true });
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 101, y: 110 });
  });
});

describe('a lock protects from deletion', () => {
  it('Delete and Backspace leave the locked objects of a mixed selection, and an all-locked one adds no undo step', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100), sticky(400, 100, { locked: true }));
    objs(r).checkpoint();
    r.engine.setSelection([a ?? '', b ?? '']);
    r.key('Delete');
    expect(objs(r).objects.has(a ?? '')).toBe(false);
    expect(objs(r).objects.has(b ?? '')).toBe(true);
    const steps = objs(r).undo.undoStack.length;
    r.engine.setSelection([b ?? '']);
    r.key('Backspace');
    r.engine.deleteSelection();
    expect(objs(r).objects.has(b ?? '')).toBe(true);
    expect(objs(r).undo.undoStack).toHaveLength(steps);
  });
  it('cut on a locked object is a plain copy', async () => {
    const r = rig();
    const [b] = r.make(sticky(400, 100, { locked: true, text: 'keep' }));
    r.engine.setSelection([b ?? '']);
    await r.engine.cut();
    expect(r.clip.text.startsWith('calaba-canvas:')).toBe(true);
    expect(objs(r).snapshot(b ?? '')).toMatchObject({ text: 'keep', locked: true });
  });
  it('deleting a group leaves a member locked on its own', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(100, 100, { group: 'g1' }), sticky(300, 100, { group: 'g1' }), sticky(500, 100, { group: 'g1', locked: true }));
    r.engine.setSelection([a ?? '', b ?? '', c ?? '']);
    r.engine.deleteSelection();
    expect(objs(r).count).toBe(1);
    expect(objs(r).snapshot(c ?? '')).toMatchObject({ locked: true });
  });
});

describe('Escape on a gesture that changed nothing undoes nothing', () => {
  /** The user's last action is a creation; a cancelled no-op gesture must leave it (and its undo step) alone. */
  const expectUntouched = (r: Rig, steps: number, count: number): void => {
    expect(objs(r).undo.undoStack).toHaveLength(steps);
    expect(objs(r).count).toBe(count);
  };
  it('a Shift-rotation by less than half a snap step', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { w: 100, h: 100 }));
    r.click(450, 350);
    r.down(450, 300 - 26);
    r.move(456, 300 - 26, { shiftKey: true });
    expect(r.engine.activeGesture?.kind).toBe('rotate');
    r.key('Escape');
    expectUntouched(r, 1, 1);
    expect(objs(r).snapshot(a ?? '')?.rot).toBeUndefined();
  });
  it('a resize of a box already at the minimum size, inward', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { w: 24, h: 24 }));
    r.click(412, 312);
    r.down(424, 324);
    r.move(418, 318);
    r.move(410, 310);
    expect(r.engine.activeGesture?.kind).toBe('resize');
    r.key('Escape');
    expectUntouched(r, 1, 1);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 400, y: 300, w: 24, h: 24 });
  });
  it('a connector end left on the same object and side', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100), sticky(400, 100));
    objs(r).checkpoint();
    const conn = objs(r).create({ kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' } }) ?? '';
    objs(r).checkpoint();
    r.engine.setSelection([conn]);
    const c = r.engine.scene.get(conn);
    if (!c || !isConnector(c)) throw new Error('no connector');
    const [ex = 0, ey = 0] = c.points.slice(-2);
    r.down(ex, ey);
    r.move(ex + 2, ey + 1);
    expect(r.engine.activeGesture?.kind).toBe('endpoint');
    r.key('Escape');
    expectUntouched(r, 2, 3);
    expect(objs(r).snapshot(conn)?.to).toEqual({ id: b, side: 'left' });
  });
  it('a move with Alt takes back its copies, and only them', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.down(150, 150, { altKey: true });
    r.move(250, 250, { altKey: true });
    expect(objs(r).count).toBe(2);
    r.key('Escape');
    expectUntouched(r, 1, 1);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 100, y: 100 });
  });
});

describe('connectors', () => {
  const two = (r: Rig): [string, string] => {
    const [a, b] = r.make(sticky(0, 0), sticky(500, 0));
    return [a ?? '', b ?? ''];
  };
  it('the connector tool glues both ends and goes back to select', () => {
    const r = rig();
    const [a, b] = two(r);
    r.engine.setTool('connector');
    r.drag([80, 80], [580, 80]);
    const id = r.engine.getState().selectedId ?? '';
    const c = r.engine.scene.get(id);
    expect(c && isConnector(c)).toBe(true);
    expect(objs(r).snapshot(id)).toMatchObject({ from: { id: a, side: 'auto' }, to: { id: b, side: 'auto' }, arrow: 'end', route: 'straight' });
    expect(r.engine.getState().tool).toBe('select');
  });
  it('dropping on empty canvas leaves a free end; dropping on an anchor picks that side', () => {
    const r = rig();
    const [a] = two(r);
    r.engine.setTool('connector');
    r.drag([80, 80], [300, 300]);
    expect(objs(r).snapshot(r.engine.getState().selectedId ?? '')).toMatchObject({ from: { id: a }, to: { x: 300, y: 300 } });
    r.engine.setTool('connector');
    r.drag([300, 400], [500, 80]); // left anchor of the second sticky
    expect(objs(r).snapshot(r.engine.getState().selectedId ?? '')).toMatchObject({ from: { x: 300, y: 400 }, to: { side: 'left' } });
  });
  it('uses the chosen route for new connectors', () => {
    const r = rig();
    two(r);
    r.engine.setConnectorRoute('elbow');
    r.engine.setTool('connector');
    r.drag([80, 80], [580, 80]);
    expect(objs(r).snapshot(r.engine.getState().selectedId ?? '')).toMatchObject({ route: 'elbow' });
  });
  it('follows its objects when they move or resize', () => {
    const r = rig();
    const [, b] = two(r);
    r.engine.setTool('connector');
    r.drag([80, 80], [580, 80]);
    const id = r.engine.getState().selectedId ?? '';
    r.click(580, 120);
    r.drag([580, 120], [580, 400]);
    const c = r.engine.scene.get(id);
    expect(objs(r).snapshot(b)?.y).toBe(280);
    expect(c && isConnector(c) ? c.points.slice(-2) : null).toEqual([500, 360]);
  });
  it('retargets by dragging an end handle', () => {
    const r = rig();
    const [a, b] = two(r);
    const [c3] = r.make(sticky(0, 600));
    r.engine.setTool('connector');
    r.drag([80, 80], [580, 80]);
    const id = r.engine.getState().selectedId ?? '';
    // drag the "to" end (left side of b, at 500,80) onto the third sticky
    r.drag([500, 80], [80, 680]);
    expect(objs(r).snapshot(id)).toMatchObject({ from: { id: a }, to: { id: c3 } });
    expect(objs(r).snapshot(id)?.to).not.toMatchObject({ id: b });
  });
  it('is detached, not deleted, when its target is deleted', () => {
    const r = rig();
    const [, b] = two(r);
    r.engine.setTool('connector');
    r.drag([80, 80], [580, 80]);
    const id = r.engine.getState().selectedId ?? '';
    r.engine.setSelection([b]);
    r.key('Delete');
    expect(objs(r).count).toBe(2);
    expect(objs(r).snapshot(id)?.to).toEqual({ x: 500, y: 80 });
    r.key('z', { metaKey: true });
    expect(objs(r).count).toBe(3);
  });
});

describe('connectors on shapes without a fill', () => {
  const shape = (kind: 'rect' | 'ellipse' | 'diamond' | 'triangle', x: number, y: number, w = 200, h = 150) => ({
    init: { kind: 'shape' as const, shape: kind, x, y, w, h },
  });
  const wire = (r: Rig, from: [number, number], to: [number, number]): string => {
    r.engine.setTool('connector');
    r.drag(from, to);
    return r.engine.getState().selectedId ?? '';
  };
  const lastPoint = (r: Rig, id: string): number[] => {
    const c = r.engine.scene.get(id);
    return c && isConnector(c) ? c.points.slice(-2) : [];
  };

  it.each(['rect', 'ellipse', 'diamond', 'triangle'] as const)('a %s released inside its empty area glues to it (auto side)', (kind) => {
    const r = rig();
    const [a] = r.make(sticky(0, 0));
    const [s] = r.make(shape(kind, 400, 300));
    // The middle of the area: well inside every outline, far from the border.
    const id = wire(r, [80, 80], [500, 380]);
    expect(objs(r).snapshot(id)).toMatchObject({ from: { id: a, side: 'auto' }, to: { id: s, side: 'auto' } });
    // Resolved to the side nearest to the other end (the sticky up-left): the left anchor.
    const rec = r.engine.scene.get(s ?? '');
    expect(rec && isBox(rec) ? lastPoint(r, id) : null).toEqual(rec && isBox(rec) ? Object.values(anchorPoint(rec, kind, 'left')) : null);
  });
  it('released 14px below the top border of an empty rectangle still glues', () => {
    const r = rig();
    const [s] = r.make(shape('rect', 400, 300));
    r.make(sticky(440, 0)); // above the frame: the nearest side is the top one
    const id = wire(r, [500, 80], [520, 314]);
    expect(objs(r).snapshot(id)).toMatchObject({ to: { id: s, side: 'auto' } });
    expect(lastPoint(r, id)).toEqual([500, 300]);
  });
  it('released in the corner of the bounds outside a diamond / triangle / ellipse stays a free point', () => {
    const r = rig();
    r.make(sticky(0, 0), shape('diamond', 400, 300), shape('triangle', 400, 600), shape('ellipse', 400, 900));
    for (const [x, y] of [[410, 310], [410, 610], [410, 910]] as const) {
      const id = wire(r, [80, 80], [x, y]);
      expect(objs(r).snapshot(id)).toMatchObject({ to: { x, y } });
    }
  });
  it('released outside every object stays a free point', () => {
    const r = rig();
    r.make(sticky(0, 0), shape('rect', 400, 300));
    const id = wire(r, [80, 80], [700, 600]);
    expect(objs(r).snapshot(id)).toMatchObject({ to: { x: 700, y: 600 } });
  });
  it('the topmost of overlapping empty shapes wins', () => {
    const r = rig();
    const [, , top] = r.make(sticky(0, 0), shape('rect', 400, 300, 300, 300), shape('rect', 450, 350, 100, 100));
    const id = wire(r, [80, 80], [500, 400]);
    expect(objs(r).snapshot(id)).toMatchObject({ to: { id: top } });
  });
  it('the start of the wire inside an empty shape glues too', () => {
    const r = rig();
    const [s, b] = r.make(shape('rect', 0, 0, 300, 300), sticky(600, 0));
    const id = wire(r, [150, 150], [680, 80]);
    expect(objs(r).snapshot(id)).toMatchObject({ from: { id: s, side: 'auto' }, to: { id: b } });
  });
  it('follows the shape when it moves and resizes', () => {
    const r = rig();
    r.make(sticky(440, 0));
    const [s] = r.make(shape('rect', 400, 300));
    const id = wire(r, [500, 80], [520, 314]);
    expect(lastPoint(r, id)).toEqual([500, 300]);
    objs(r).patch(s ?? '', { x: 600, y: 500 });
    expect(lastPoint(r, id)).toEqual([700, 500]);
    objs(r).patch(s ?? '', { w: 400, h: 250 });
    expect(lastPoint(r, id)).toEqual([800, 500]);
    expect(objs(r).snapshot(id)).toMatchObject({ to: { id: s } });
  });
  it('a click inside an empty shape still does not select it (the marquee must start there)', () => {
    const r = rig();
    r.make(shape('rect', 400, 300, 600, 400));
    r.click(700, 500);
    expect(r.engine.getState().selectedId).toBeNull();
    r.click(700, 300); // the border does
    expect(r.engine.getState().selectedId).not.toBeNull();
  });
});

describe('keyboard', () => {
  it('tool hotkeys', () => {
    const r = rig();
    for (const [k, tool] of [['s', 'sticky'], ['t', 'text'], ['r', 'shape'], ['c', 'connector'], ['v', 'select']] as const) {
      r.key(k);
      expect(r.engine.getState().tool).toBe(tool);
    }
  });
  it('Delete, select all, Escape and Tab', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(0, 0), sticky(300, 0), sticky(600, 0));
    r.key('a', { metaKey: true });
    expect(r.engine.getState().selectionCount).toBe(3);
    r.key('Escape');
    expect(r.engine.getState().selectionCount).toBe(0);
    r.key('Tab');
    expect(r.engine.getState().selectedId).toBe(a);
    r.key('Tab');
    expect(r.engine.getState().selectedId).toBe(b);
    r.key('Tab', { shiftKey: true });
    expect(r.engine.getState().selectedId).toBe(a);
    r.key('Delete');
    expect(objs(r).count).toBe(2);
    expect(objs(r).objects.has(c ?? '')).toBe(true);
    expect(r.engine.getState().selectionCount).toBe(0);
  });
  it('layer order with ⌘] / ⌘[ (Shift: all the way)', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(0, 0), sticky(0, 0), sticky(0, 0));
    r.engine.setSelection([a ?? '']);
    r.key(']', { metaKey: true, code: 'BracketRight' });
    expect(objs(r).orderedIds()).toEqual([b, a, c]);
    r.key(']', { metaKey: true, code: 'BracketRight', shiftKey: true });
    expect(objs(r).orderedIds()).toEqual([b, c, a]);
    r.key('[', { metaKey: true, code: 'BracketLeft', shiftKey: true });
    expect(objs(r).orderedIds()).toEqual([a, b, c]);
  });
  it('copy, paste and cut through the text clipboard, ⌘D duplicates', async () => {
    const r = rig();
    r.make(sticky(0, 0, { text: 'copy me' }), { init: { kind: 'shape', x: 300, y: 0 } });
    r.engine.selectAll();
    r.key('c', { metaKey: true });
    await flush();
    expect(r.clip.text.startsWith('calaba-canvas:')).toBe(true);
    r.key('v', { metaKey: true });
    await macrotask(); // ⌘V's fallback read runs when no `paste` event came
    await flush();
    expect(objs(r).count).toBe(4);
    expect(r.engine.getState().selectionCount).toBe(2);
    r.key('d', { metaKey: true });
    expect(objs(r).count).toBe(6);
    r.key('x', { metaKey: true });
    await flush();
    expect(objs(r).count).toBe(4);
  });
  it('a paste refused whole says why: the state limit, the object limit', () => {
    const why: string[] = [];
    const r = rig({ onRefused: (w) => why.push(w) });
    const payload = (n: number, text: string) =>
      'calaba-canvas:' + JSON.stringify({ v: 1, objects: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, kind: 'sticky', x: i, y: 0, text })) });
    expect(r.engine.pasteText(payload(1000, 'q'.repeat(4900)))).toEqual([]);
    expect(why).toEqual(['size']);
    expect(objs(r).count).toBe(0);
    expect(r.engine.pasteText(payload(3, 'ok'))).toHaveLength(3);
    expect(why).toEqual(['size']);
    r.ydoc.transact(() => {
      for (let i = 0; i < 4995; i++) objs(r).objects.set(`f${i}`, new Y.Map<unknown>());
    });
    expect(r.engine.pasteText(payload(3, 'ok'))).toEqual([]);
    expect(why).toEqual(['size', 'objects']);
  });
  it('⌘D puts the copy to the right of the selection, on the same line', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(300, 40));
    const box = (id: string | undefined) => r.engine.scene.get(id ?? '') as unknown as { x: number; y: number; w: number };
    r.engine.setSelection([a ?? '']);
    r.key('d', { metaKey: true });
    const copy = [...r.engine.selection][0];
    expect(copy).not.toBe(a);
    expect(box(copy)).toMatchObject({ x: box(a).w + 24, y: 0 });
    r.engine.setSelection([a ?? '', b ?? '']);
    r.key('d', { metaKey: true });
    const copies = [...r.engine.selection].map(box);
    // Joint bounds end at 300 + w: the pair moves as one, keeping its arrangement.
    expect(Math.min(...copies.map((c) => c.x))).toBeGreaterThanOrEqual(300 + box(b).w + 24);
    expect(copies.map((c) => c.y).sort((p, q) => p - q)).toEqual([0, 40]);
  });
  it('pasting plain text makes a text object', async () => {
    const r = rig();
    r.clip.text = 'just words';
    r.key('v', { metaKey: true });
    await macrotask(); // ⌘V's fallback read runs when no `paste` event came
    await flush();
    const id = r.engine.getState().selectedId ?? '';
    expect(objs(r).snapshot(id)).toMatchObject({ kind: 'text', text: 'just words' });
  });
  it('pasted objects land in view even if copied far away', async () => {
    const r = rig();
    r.make(sticky(90000, 90000));
    r.engine.selectAll();
    r.key('c', { metaKey: true });
    await flush();
    r.key('v', { metaKey: true });
    await macrotask(); // ⌘V's fallback read runs when no `paste` event came
    await flush();
    const id = r.engine.getState().selectedId ?? '';
    const o = r.engine.scene.get(id);
    expect(o?.x).toBeLessThan(1000);
  });
  it('ignores keys while the text editor owns focus', () => {
    const r = rig();
    r.make(sticky(0, 0));
    r.click(50, 50);
    r.key('Enter');
    const ta = r.host.querySelector('textarea');
    expect(ta).not.toBeNull();
    ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(objs(r).count).toBe(1);
    ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(r.engine.getState().editing).toBe(false);
  });
});

describe('camera', () => {
  it('Ctrl+wheel zooms around the pointer, plain wheel pans, limits hold', () => {
    const r = rig();
    const before = r.engine.toWorld({ x: 500, y: 400 });
    r.wheel(-100, { ctrlKey: true });
    r.raf.flush();
    expect(r.engine.camera.scale).toBeCloseTo(1.15);
    const after = r.engine.toWorld({ x: 500, y: 400 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    r.wheel(30, { deltaX: 12 });
    r.raf.flush();
    expect(r.engine.camera.tx).toBeLessThan(0);
    for (let i = 0; i < 60; i++) r.wheel(-100, { ctrlKey: true });
    r.raf.flush();
    expect(r.engine.camera.scale).toBe(4);
    for (let i = 0; i < 120; i++) r.wheel(100, { ctrlKey: true });
    r.raf.flush();
    expect(r.engine.camera.scale).toBeCloseTo(0.1);
    expect(r.engine.getState().zoomPct).toBe(10);
  });
  it('trackpad pinch (small ctrl+wheel deltas) zooms smoothly', () => {
    const r = rig();
    r.wheel(-5, { ctrlKey: true });
    r.raf.flush();
    expect(r.engine.camera.scale).toBeCloseTo(Math.exp(0.05));
  });
  it('a burst of wheel events is applied once, with the frame — and a still canvas asks for no frame', () => {
    const r = rig();
    r.raf.flush();
    const fn = vi.fn();
    r.engine.subscribeView(fn);
    const frames = r.engine.stats.frames;
    for (let i = 0; i < 40; i++) r.wheel(-3, { ctrlKey: true });
    for (let i = 0; i < 40; i++) r.wheel(2, { deltaX: 1 });
    expect(fn).not.toHaveBeenCalled();
    expect(r.engine.camera.scale).toBe(1);
    expect(r.raf.pending).toBe(1);
    r.raf.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.engine.stats.frames).toBe(frames + 1);
    expect(r.engine.camera.scale).toBeCloseTo(Math.exp(0.03 * 40));
    // The state of a gesture builds on the queued camera, not on the stale one: no event is lost.
    expect(r.engine.camera.tx).toBeLessThan(-30);
    expect(r.raf.pending).toBe(0);
    expect(r.raf.flush()).toBe(0);
  });
  it('a pinch keeps the world point under the cursor across the whole burst', () => {
    const r = rig();
    const before = r.engine.toWorld({ x: 300, y: 200 });
    for (let i = 0; i < 25; i++) r.wheel(-4, { ctrlKey: true, clientX: 300, clientY: 200 });
    // Still queued: the conversion already sees the new camera.
    const mid = r.engine.toWorld({ x: 300, y: 200 });
    expect(mid.x).toBeCloseTo(before.x);
    r.raf.flush();
    const after = r.engine.toWorld({ x: 300, y: 200 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(r.engine.camera.scale).toBeCloseTo(Math.exp(1));
  });
  it('a mouse wheel notch zooms to the cursor, a trackpad scroll pans, a line-mode wheel zooms', () => {
    const r = rig();
    r.wheel(-100, { clientX: 200, clientY: 100 });
    r.raf.flush();
    expect(r.engine.camera.scale).toBeCloseTo(1.15);
    expect(r.engine.camera.tx).toBeCloseTo(200 - 200 * 1.15);
    const c = r.engine.camera;
    r.wheel(-3, { deltaMode: 1, clientX: 200, clientY: 100 });
    r.raf.flush();
    expect(r.engine.camera.scale).toBeCloseTo(c.scale * 1.15);
    const z = r.engine.camera;
    r.wheel(7.5, { deltaX: -3 });
    r.raf.flush();
    expect(r.engine.camera).toMatchObject({ scale: z.scale, tx: z.tx + 3, ty: z.ty - 7.5 });
  });
  it('Safari trackpad pinch: gesture events zoom to the fingers, the page never zooms, a wheel in between adds nothing', () => {
    const r = rig();
    const gesture = (type: string, scale: number, x: number, y: number): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { scale, clientX: x, clientY: y });
      r.canvas.dispatchEvent(e);
      return e;
    };
    const anchor = r.engine.toWorld({ x: 400, y: 300 });
    expect(gesture('gesturestart', 1, 400, 300).defaultPrevented).toBe(true);
    gesture('gesturechange', 1.5, 400, 300);
    const w = new WheelEvent('wheel', { deltaY: -4, ctrlKey: true, bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
    r.canvas.dispatchEvent(w);
    expect(w.defaultPrevented).toBe(true);
    gesture('gesturechange', 2, 420, 310);
    r.raf.flush();
    expect(r.engine.camera.scale).toBeCloseTo(2);
    // The point that was under the fingers at the start follows them (zoom and pan in one gesture).
    const under = r.engine.toWorld({ x: 420, y: 310 });
    expect(under.x).toBeCloseTo(anchor.x);
    expect(under.y).toBeCloseTo(anchor.y);
    expect(gesture('gestureend', 2, 420, 310).defaultPrevented).toBe(true);
    // A new gesture starts from the new scale; the limits hold.
    gesture('gesturestart', 1, 400, 300);
    gesture('gesturechange', 50, 400, 300);
    r.raf.flush();
    expect(r.engine.camera.scale).toBe(MAX_SCALE);
    gesture('gestureend', 50, 400, 300);
    // After the gesture a ctrl+wheel is a pinch again.
    r.wheel(5, { ctrlKey: true });
    r.raf.flush();
    expect(r.engine.camera.scale).toBeLessThan(MAX_SCALE);
    expect(r.raf.pending).toBe(0);
  });
  it('prevents the default page scroll/zoom on wheel', () => {
    const r = rig();
    const e = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
    r.canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
  it('Space+drag and the middle button pan', () => {
    const r = rig();
    r.make(sticky(0, 0));
    r.key(' ');
    r.drag([300, 300], [350, 340]);
    expect(r.engine.camera.tx).toBe(50);
    expect(r.engine.camera.ty).toBe(40);
    expect(r.engine.getState().selectionCount).toBe(0);
    r.canvas.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    r.drag([300, 300], [310, 300], { button: 1 });
    expect(r.engine.camera.tx).toBe(60);
  });
  it('+/− step through presets, ⌘0 resets to 100 %', () => {
    const r = rig();
    r.key('+');
    expect(r.engine.getState().zoomPct).toBe(125);
    r.key('-');
    r.key('-');
    expect(r.engine.getState().zoomPct).toBe(75);
    r.key('0', { metaKey: true });
    expect(r.engine.getState().zoomPct).toBe(100);
  });
  it('Shift+1 fits everything, Shift+2 the selection', () => {
    const r = rig();
    const [, b] = r.make(sticky(0, 0), sticky(3000, 2000));
    r.key('!', { shiftKey: true, code: 'Digit1' });
    const all = r.engine.visibleWorld();
    expect(all.x).toBeLessThan(0);
    expect(all.x + all.w).toBeGreaterThan(3160);
    expect(all.y + all.h).toBeGreaterThan(2160);
    r.engine.setSelection([b ?? '']);
    r.key('@', { shiftKey: true, code: 'Digit2' });
    expect(r.engine.camera.scale).toBe(1);
    const sel = r.engine.visibleWorld();
    expect(sel.x).toBeLessThan(3000);
    expect(sel.x + sel.w).toBeGreaterThan(3160);
  });
  it('fit on an empty canvas centers the origin; it animates unless reduced motion is on', () => {
    const r = rig({ reducedMotion: false });
    r.engine.fitAll();
    expect(r.raf.pending).toBeGreaterThan(0);
    r.clock.t += 400;
    for (let i = 0; i < 5; i++) r.raf.flush();
    expect(r.engine.camera).toMatchObject({ tx: 500, ty: 400, scale: 1 });
    const jump = rig({ reducedMotion: true });
    jump.make(sticky(2000, 2000));
    jump.engine.fitAll();
    expect(jump.engine.camera.tx).not.toBe(0);
  });
  it('animated camera moves stop when the user takes over', () => {
    const r = rig({ reducedMotion: false });
    r.make(sticky(4000, 0));
    r.engine.fitAll();
    r.clock.t += 50;
    r.raf.flush();
    const mid = r.engine.camera.tx;
    r.wheel(0, { deltaX: 40 });
    r.raf.flush();
    const after = r.engine.camera.tx;
    r.clock.t += 400;
    r.raf.flush();
    expect(r.engine.camera.tx).toBe(after);
    expect(after).not.toBe(mid + 0.0001);
  });
  it('centerOn and zoomTo', () => {
    const r = rig();
    r.engine.zoomTo(200);
    expect(r.engine.camera.scale).toBe(2);
    r.engine.centerOn({ x: 100, y: 100 });
    const c = r.engine.visibleWorld();
    expect(c.x + c.w / 2).toBeCloseTo(100);
  });
});

describe('read-only', () => {
  it('pans on drag, blocks every edit, still copies', async () => {
    const r = rig({ readOnly: true });
    const [a] = r.make(sticky(100, 100, { text: 'ro' }));
    expect(r.engine.getState().readOnly).toBe(true);
    r.drag([150, 150], [250, 250]);
    expect(objs(r).snapshot(a ?? '')).toMatchObject({ x: 100, y: 100 });
    expect(r.engine.camera.tx).toBe(100);
    r.engine.setTool('sticky');
    r.engine.setSelection([a ?? '']);
    r.key('Delete');
    r.key('d', { metaKey: true });
    r.key('Enter');
    expect(objs(r).count).toBe(1);
    expect(r.engine.startTextEdit(a)).toBe(false);
    r.key('c', { metaKey: true });
    await flush();
    expect(r.clip.text.startsWith('calaba-canvas:')).toBe(true);
    expect(r.engine['overlay'].group).toBeNull();
  });
  it('a document with a newer schema opens read-only', () => {
    const r = rig();
    expect(r.engine.getState().readOnly).toBe(false);
    r.engine.doc.meta.set('schema', 2);
    expect(r.engine.getState().readOnly).toBe(true);
    r.engine.setTool('sticky');
    r.click(100, 100);
    expect(objs(r).count).toBe(0);
  });
  it('can be switched at runtime and closes an open editor', () => {
    const r = rig();
    r.make(sticky(0, 0));
    r.engine.startTextEdit(r.engine.scene.orderedIds()[0]);
    expect(r.engine.getState().editing).toBe(true);
    r.engine.setReadOnly(true);
    expect(r.engine.getState().editing).toBe(false);
  });
});

describe('state for React: primitives only', () => {
  it('notifies only when a primitive changes', () => {
    const r = rig();
    const [a] = r.make(sticky(0, 0));
    const fn = vi.fn();
    r.engine.subscribe(fn);
    const s0 = r.engine.getState();
    r.engine.doc.patch(a ?? '', { x: 50 }); // someone else's / any content edit
    r.engine.doc.setText(a ?? '', 'typing');
    expect(fn).not.toHaveBeenCalled();
    expect(r.engine.getState()).toBe(s0);
    r.engine.setSelection([a ?? '']);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.engine.getState().selectedId).toBe(a);
    r.engine.setSelection([a ?? '']);
    expect(fn).toHaveBeenCalledTimes(1);
    r.engine.setCamera({ ...r.engine.camera, tx: 20 }); // pan: zoom label unchanged
    expect(fn).toHaveBeenCalledTimes(1);
    r.engine.zoomAtPoint(1.004, { x: 0, y: 0 }); // rounds to the same percent
    expect(fn).toHaveBeenCalledTimes(1);
    r.engine.zoomAtPoint(1.5, { x: 0, y: 0 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.engine.getState().zoomPct).toBe(151);
  });
  it('tracks undo/redo availability and the editing flag', () => {
    const r = rig();
    expect(r.engine.getState()).toMatchObject({ canUndo: false, canRedo: false });
    r.make(sticky(0, 0));
    expect(r.engine.getState().canUndo).toBe(true);
    r.engine.undo();
    expect(r.engine.getState()).toMatchObject({ canUndo: false, canRedo: true });
  });
  it('subscribeSelection delivers selected records on selection and on their change only', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(400, 0));
    const seen: number[] = [];
    r.engine.subscribeSelection((o) => seen.push(o.length));
    r.engine.setSelection([a ?? '']);
    expect(seen).toEqual([1]);
    r.engine.doc.patch(b ?? '', { x: 5 }); // another object: no event
    expect(seen).toEqual([1]);
    r.engine.doc.patch(a ?? '', { color: 'blue' });
    expect(seen).toEqual([1, 1]);
    r.engine.updateSelected({ color: 'pink' });
    expect(objs(r).snapshot(a ?? '')?.color).toBe('pink');
  });
  it('updateSelected with kinds patches only those kinds', () => {
    const r = rig();
    const [a, t] = r.make(sticky(0, 0), { init: { kind: 'text' as const, x: 400, y: 0, text: 'x' } });
    r.engine.setSelection([a ?? '', t ?? '']);
    r.engine.updateSelected({ color: 'pink' }, ['sticky']);
    expect(objs(r).snapshot(a ?? '')?.color).toBe('pink');
    expect(objs(r).snapshot(t ?? '')?.color).not.toBe('pink');
  });
  it('drops deleted objects from the selection', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(400, 0));
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.doc.remove([a ?? '']);
    expect([...r.engine.selection]).toEqual([b]);
  });
  it('a remote edit of a selected object refreshes the selection decoration', () => {
    const r = rig();
    const [a] = r.make(sticky(0, 0));
    r.engine.setSelection([a ?? '']);
    expect(r.engine['overlay'].group?.rect).toMatchObject({ x: 0 });
    r.ydoc.transact(() => r.engine.doc.objects.get(a ?? '')?.set('x', 77), 'remote');
    expect(r.engine['overlay'].group?.rect).toMatchObject({ x: 77 });
  });
});

describe('idle behaviour', () => {
  it('after a burst of work, no frame stays scheduled and no timer exists', () => {
    vi.useFakeTimers();
    const r = rig();
    r.make(sticky(0, 0), sticky(300, 0));
    r.drag([50, 50], [150, 120]);
    r.wheel(-100, { ctrlKey: true });
    r.engine.setSelection([...r.engine.scene.orderedIds()]);
    for (let i = 0; i < 4; i++) r.raf.flush();
    vi.runOnlyPendingTimers(); // jsdom's own focus bookkeeping, not ours
    expect(r.raf.pending).toBe(0);
    expect(r.engine.renderer.frameScheduled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const frames = r.engine.stats.frames;
    r.clock.t += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(r.engine.stats.frames).toBe(frames);
  });
  it('a hidden document does not render', () => {
    const r = rig();
    r.raf.flush();
    const frames = r.engine.stats.frames;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    r.make(sticky(0, 0));
    r.engine.setCamera({ tx: 30, ty: 30, scale: 1 });
    expect(r.raf.pending).toBe(0);
    r.raf.flush();
    expect(r.engine.stats.frames).toBe(frames);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(r.raf.pending).toBe(1);
  });
  it('destroy detaches input and stops everything', () => {
    const r = rig();
    r.make(sticky(0, 0));
    r.engine.destroy();
    r.engine.destroy();
    r.engine.setTool('select');
    r.wheel(-100, { ctrlKey: true });
    r.click(10, 10);
    expect(r.engine.camera.scale).toBe(1);
    expect(r.raf.pending).toBe(0);
  });
});

describe('remote awareness', () => {
  it('draws peers, and fades cursors in steps with one timer, never a loop', () => {
    vi.useFakeTimers();
    const r = rig();
    r.engine.setPeers([{ id: 'p1', name: 'Анна', color: '#e11', cursor: { x: 10, y: 10 }, selection: [] }]);
    expect(vi.getTimerCount()).toBe(1);
    r.raf.flush();
    expect(r.raf.pending).toBe(0);
    r.clock.t += 2600;
    vi.advanceTimersByTime(2600);
    expect(r.raf.pending).toBe(1); // dim step → one frame
    r.raf.flush();
    expect(vi.getTimerCount()).toBe(1);
    r.clock.t += 4000;
    vi.advanceTimersByTime(4000);
    r.raf.flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(r.raf.pending).toBe(0);
  });
  it('a moving cursor keeps one timer instead of re-arming it on every awareness frame', () => {
    vi.useFakeTimers();
    const r = rig();
    const set = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 100; i++) {
      r.engine.setPeers([{ id: 'p1', name: 'Анна', color: '#e11', cursor: { x: 10 + i, y: 10 } }]);
      r.clock.t += 20;
      vi.advanceTimersByTime(20);
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(set.mock.calls.length).toBeLessThanOrEqual(2); // armed once; the 2 s of motion never fires it
    set.mockRestore();
    // the cursor stops: the armed timer still ends in the dim step and then nothing is left
    r.clock.t += 2600;
    vi.advanceTimersByTime(2600);
    r.raf.flush();
    r.clock.t += 4000;
    vi.advanceTimersByTime(4000);
    r.raf.flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('hidden: no cursor-fade timer, no frame; shown again: the timer and a frame come back', () => {
    vi.useFakeTimers();
    const r = rig();
    r.raf.flush();
    r.engine.setActive(false);
    r.engine.setPeers([{ id: 'p1', name: 'Анна', color: '#e11', cursor: { x: 10, y: 10 } }]);
    r.engine.setPeers([{ id: 'p1', name: 'Анна', color: '#e11', cursor: { x: 20, y: 10 } }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(r.raf.pending).toBe(0);
    r.engine.setActive(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(r.raf.pending).toBe(1);
  });
  it('with a remote layer, peers repaint it alone; the main canvas gets no frame', () => {
    vi.useFakeTimers();
    const remoteCanvas = document.createElement('canvas');
    const r = rig({ remoteCanvas });
    r.raf.flush();
    const { frames } = r.engine.stats;
    for (let i = 0; i < 20; i++) {
      r.engine.setPeers([{ id: 'p1', name: 'Анна', color: '#e11', cursor: { x: 10 + i, y: 10 } }]);
      r.raf.flush();
    }
    expect(r.engine.stats.frames).toBe(frames);
    expect(r.engine.stats.remote).toBe(20 + 1);
    expect(r.raf.pending).toBe(0);
    // the fade timer asks for a remote frame too, never a main one
    r.clock.t += 2600;
    vi.advanceTimersByTime(2600);
    r.raf.flush();
    expect(r.engine.stats.frames).toBe(frames);
    expect(r.engine.stats.remote).toBe(20 + 2);
    // size follows the main canvas
    expect(remoteCanvas.width).toBe(r.canvas.width);
    expect(remoteCanvas.height).toBe(r.canvas.height);
  });
  it('an identical peer snapshot costs no frame', () => {
    const r = rig();
    r.raf.flush();
    const p = [{ id: 'p1', name: 'B', color: '#00f', cursor: { x: 1, y: 1 } }];
    r.engine.setPeers(p);
    r.raf.flush();
    r.engine.setPeers(p.map((x) => ({ ...x })));
    expect(r.raf.pending).toBe(0);
  });
  it('reports the local cursor and selection at most 20 times a second', () => {
    vi.useFakeTimers();
    const r = rig();
    const got: unknown[] = [];
    r.engine.onLocalAwareness((a) => got.push(a));
    for (let i = 0; i < 30; i++) {
      r.move(10 + i, 10);
      r.clock.t += 5;
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(100);
    // 150 ms of movement → at most ~4 messages including the trailing one
    expect(got.length).toBeGreaterThan(1);
    expect(got.length).toBeLessThanOrEqual(5);
    expect((got.at(-1) as { cursor: { x: number } }).cursor.x).toBe(39);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('export and options', () => {
  it('exports the scene into a canvas, or null when empty', () => {
    const r = rig();
    expect(r.engine.exportToCanvas()).toBeNull();
    r.make(sticky(0, 0, { text: 'x' }));
    const c = r.engine.exportToCanvas({ pxPerUnit: 2 });
    expect(c?.width).toBe(Math.ceil((160 + 48) * 2));
  });
  it('exports an explicit world rect with its own padding', () => {
    const r = rig();
    r.make(sticky(0, 0, { text: 'x' }));
    const c = r.engine.exportToCanvas({ rect: { x: 0, y: 0, w: 400, h: 300 }, pad: 0, pxPerUnit: 1 });
    expect([c?.width, c?.height]).toEqual([400, 300]);
  });
  it('subscribeView fires on camera moves and when a gesture starts or ends, not otherwise', () => {
    const r = rig();
    const fn = vi.fn();
    const off = r.engine.subscribeView(fn);
    r.engine.panByScreen(10, 0);
    expect(fn).toHaveBeenCalledTimes(1);
    r.engine.panByScreen(0, 0);
    expect(fn).toHaveBeenCalledTimes(1);
    r.down(300, 300);
    r.up(300, 300);
    expect(fn).toHaveBeenCalledTimes(3); // marquee gesture began and ended
    off();
    r.engine.panByScreen(5, 0);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('palette changes repaint everything', () => {
    const r = rig();
    r.make(sticky(0, 0));
    r.raf.flush();
    const full = r.engine.stats.full;
    r.engine.setPalette(defaultPalette('dark'));
    r.raf.flush();
    expect(r.engine.stats.full).toBe(full + 1);
  });
  it('low-power mode renders at DPR 1', () => {
    const r = rig();
    r.engine.setLowPower(true);
    expect(r.engine.renderer.devicePixelRatio).toBe(1);
  });
});

describe('edge pan of a drag (frame, move, resize)', () => {
  /** n frames of `ms` each on the rig's clock. */
  const frames = (r: Rig, n: number, ms = 16): void => {
    for (let i = 0; i < n; i++) {
      r.clock.t += ms;
      r.raf.flush();
    }
  };
  it('a frame dragged to the edge pans the view and takes what comes into it; the release stops it', () => {
    const r = rig();
    const [a, b] = r.make(sticky(600, 300), sticky(1600, 300));
    r.down(500, 280);
    r.move(800, 500);
    r.move(995, 500); // 5 px from the right edge of a 1000 px view
    frames(r, 60);
    expect(r.engine.camera.tx).toBeLessThan(-600);
    expect(r.engine.selection.has(b ?? '')).toBe(true); // without a pointer move
    r.up(995, 500);
    const tx = r.engine.camera.tx;
    frames(r, 10);
    expect(r.engine.camera.tx).toBe(tx);
    expect(r.raf.pending).toBe(0);
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
  });
  it('a press near the edge, or a drag that starts there and goes away from it, does not pan', () => {
    const r = rig();
    r.down(990, 400);
    frames(r, 10);
    r.move(991, 401); // within the slop
    frames(r, 10);
    expect(r.engine.camera).toMatchObject({ tx: 0, ty: 0 });
    r.move(900, 400); // out of the zone
    frames(r, 10);
    expect(r.engine.camera.tx).toBe(0);
    r.move(995, 400); // back in: now it pans
    frames(r, 10);
    expect(r.engine.camera.tx).toBeLessThan(0);
    r.up(995, 400);
  });
  it('a moved object follows the pointer while the view pans and lands under it', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.down(150, 150);
    r.move(600, 150);
    r.move(996, 150);
    frames(r, 30);
    const tx = r.engine.camera.tx;
    expect(tx).toBeLessThan(-200);
    r.up(996, 150);
    // The pointer keeps the point it grabbed, 50 px into the sticky, in the world it panned to.
    expect(Math.abs(Number(objs(r).snapshot(a ?? '')?.x) - (996 - tx - 50))).toBeLessThanOrEqual(1);
  });
  it('a resize at the bottom edge pans down and keeps growing the box', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100, { w: 200, h: 100 }));
    r.click(150, 150);
    r.down(300, 200); // se handle
    r.move(300, 500);
    r.move(300, 797);
    frames(r, 30);
    const ty = r.engine.camera.ty;
    expect(ty).toBeLessThan(-200);
    r.up(300, 797);
    expect(Math.abs(Number(objs(r).snapshot(a ?? '')?.h) - (797 - ty - 100))).toBeLessThanOrEqual(1);
  });
  it('a frame follows its pointer when the camera moves under it (the wheel), with no pointer move', () => {
    const r = rig();
    const [b] = r.make(sticky(600, 120));
    r.down(100, 100);
    r.move(300, 300);
    expect(r.engine.selection.has(b ?? '')).toBe(false);
    r.engine.steerPan(-500, 0);
    frames(r, 1);
    expect(r.engine.selection.has(b ?? '')).toBe(true);
    r.up(300, 300);
  });
});
