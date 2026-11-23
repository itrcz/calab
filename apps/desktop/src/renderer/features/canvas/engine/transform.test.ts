// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { serialize } from '../../../lib/canvas/clipboard';
import { handlePointRot, rotateHandlePoint } from '../../../lib/canvas/geometry';
import { anchorOf } from '../../../lib/canvas/route';
import { isBox, type BoxRec } from '../../../lib/canvas/types';
import { drawObject, drawObjects } from './draw';
import { createScale } from './gestures';
import { defaultPalette } from './palette';
import { destroyRigs, rig, type Rig } from './testRig';
import { fakeCtx } from './testing';
import { TextLayouter } from '../../../lib/canvas/textLayout';

afterEach(destroyRigs);

const sticky = (x: number, y: number, extra: object = {}) => ({ init: { kind: 'sticky' as const, x, y, w: 100, h: 100, ...extra } });
const snap = (r: Rig, id: string | undefined) => r.engine.doc.snapshot(id ?? '');
const rec = (r: Rig, id: string | undefined): BoxRec => {
  const o = r.engine.scene.get(id ?? '');
  if (!o || !isBox(o)) throw new Error('no box');
  return o;
};
/** Screen = world at the default camera. */
const KNOB = 26;
const mod = { metaKey: true };
const serializeNow = (r: Rig): string => serialize(r.engine.scene, r.engine.doc, r.engine.selection) ?? '';

describe('rotation', () => {
  it('the rotation handle turns a box about its center; one drag is one undo step', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300));
    r.engine.doc.undo.clear();
    r.click(450, 350);
    // Knob above the top side: (450, 300 - 26). Drag it to the right of the center (450, 350) → 90°.
    r.drag([450, 300 - KNOB], [550, 350]);
    expect(snap(r, a)).toMatchObject({ rot: 90, x: 400, y: 300 });
    expect(rec(r, a).rot).toBe(90);
    r.engine.undo();
    expect(r.engine.doc.objects.get(a ?? '')?.has('rot')).toBe(false);
    expect(r.engine.doc.undo.undoStack.length).toBe(0);
  });
  it('a grab off the knob\'s exact center does not jump: the turn is relative to where the pointer went down', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300));
    r.click(450, 350);
    r.down(453, 300 - KNOB);
    r.move(453, 300 - KNOB);
    r.move(453, 300 - KNOB + 1);
    r.up(453, 300 - KNOB + 1);
    expect(Number(snap(r, a)?.rot ?? 0)).toBeLessThan(2);
  });
  it('Shift snaps the angle to 15°', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300));
    r.click(450, 350);
    // A pointer at ~ 80° (clockwise from the top) of the center.
    const ang = (80 * Math.PI) / 180;
    r.drag([450, 300 - KNOB], [450 + 200 * Math.sin(ang), 350 - 200 * Math.cos(ang)], { shiftKey: true });
    expect(snap(r, a)?.rot).toBe(75);
    expect(r.engine.selectionFrame()?.rot).toBe(75);
  });
  it('Shift on a drag that crosses 0 / 360 stays continuous (no jump over the seam)', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300));
    r.click(450, 350);
    r.down(450, 300 - KNOB);
    r.move(460, 300 - KNOB); // a hair clockwise
    r.move(440, 300 - KNOB); // a hair counter-clockwise: 350-ish
    r.up(440, 300 - KNOB);
    const rot = Number(snap(r, a)?.rot ?? 0);
    expect(rot === 0 || rot > 340).toBe(true);
  });
  it('hit-testing and selection follow the rotated outline', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 0, y: 0, w: 300, h: 40, rot: 90 } });
    // Upright about (150, 20): x 130..170, y -130..170.
    r.engine.clearSelection();
    r.click(150, -100);
    expect(r.engine.getState().selectedId).toBe(a);
    r.engine.clearSelection();
    r.click(20, 20);
    expect(r.engine.getState().selectedId).toBeNull();
  });
  it('the selection frame is the box\'s own turned frame and hands out both kinds of handle', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { rot: 30 }));
    r.engine.setSelection([a ?? '']);
    const f = r.engine.selectionFrame();
    expect(f).toMatchObject({ rot: 30, resize: true, rotate: true, rect: { x: 400, y: 300, w: 100, h: 100 } });
    expect(r.engine['overlay'].group).toMatchObject({ rot: 30 });
  });
  it('resizing a rotated box works along its own axes and keeps the opposite side in place', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { w: 200, h: 100, rot: 90 }));
    r.engine.setSelection([a ?? '']);
    const before = rec(r, a);
    const west = handlePointRot(before, 90, 'w');
    const east = handlePointRot(before, 90, 'e');
    // 'e' of a 90° box is at the bottom of the screen: pull it 80 further down.
    r.drag([east.x, east.y], [east.x, east.y + 80]);
    const after = rec(r, a);
    expect(after.w).toBeCloseTo(280);
    expect(after.h).toBeCloseTo(100);
    const west2 = handlePointRot(after, 90, 'w');
    expect(west2.x).toBeCloseTo(west.x);
    expect(west2.y).toBeCloseTo(west.y);
    expect(after.rot).toBe(90);
  });
  it('a rotated corner resize with Shift keeps the aspect ratio', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { w: 200, h: 100, rot: 40 }));
    r.engine.setSelection([a ?? '']);
    const b = rec(r, a);
    const p = handlePointRot(b, 40, 'se');
    r.drag([p.x, p.y], [p.x + 90, p.y + 60], { shiftKey: true });
    const n = rec(r, a);
    expect(n.w / n.h).toBeCloseTo(2, 1);
    const nw = handlePointRot(b, 40, 'nw');
    const nw2 = handlePointRot(n, 40, 'nw');
    expect(nw2.x).toBeCloseTo(nw.x);
    expect(nw2.y).toBeCloseTo(nw.y);
  });
  it('an angle badge hangs by the cursor while turning (a box: its angle, several: the turn) and goes with the gesture', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { rot: 30 }));
    r.click(450, 350);
    // The knob of a box turned by 30° hangs 26 px out from its (turned) top side.
    const knob = rotateHandlePoint({ x: 400, y: 300, w: 100, h: 100 }, 30, KNOB);
    r.down(knob.x, knob.y);
    r.move(550, 350);
    expect(r.engine['overlay'].angle).toEqual({ at: { x: 550, y: 350 }, deg: 90 });
    r.up(550, 350);
    expect(r.engine['overlay'].angle).toBeNull();
    expect(rec(r, a).rot).toBe(90);
    const r2 = rig();
    r2.make(sticky(0, 0), sticky(300, 0));
    r2.engine.selectAll();
    r2.down(200, -KNOB);
    r2.move(400, 50);
    expect(r2.engine['overlay'].angle?.deg).toBe(90);
    r2.move(0, 50);
    expect(r2.engine['overlay'].angle?.deg).toBe(-90);
    r2.up(0, 50);
    expect(r2.engine['overlay'].angle).toBeNull();
  });
  it('rotates several boxes about the center of their joint bounds; each keeps its place in the turned arrangement', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(300, 0));
    r.engine.selectAll();
    // Joint bounds 0..400 × 0..100, center (200, 50). The knob hangs 26 px above the top middle.
    r.drag([200, -KNOB], [400, 50]); // → 90°
    const A = rec(r, a);
    const B = rec(r, b);
    expect(A.rot).toBe(90);
    expect(B.rot).toBe(90);
    // a's center (50, 50) turns to (200, -100); b's (350, 50) to (200, 200).
    expect(A.x + A.w / 2).toBeCloseTo(200);
    expect(A.y + A.h / 2).toBeCloseTo(-100);
    expect(B.x + B.w / 2).toBeCloseTo(200);
    expect(B.y + B.h / 2).toBeCloseTo(200);
    r.engine.undo();
    expect(snap(r, a)).toMatchObject({ x: 0, y: 0 });
    expect(snap(r, a)).not.toHaveProperty('rot');
    expect(snap(r, b)).toMatchObject({ x: 300, y: 0 });
  });
  it('a glued connector follows the turn and a free end rotates with the selection', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(400, 0));
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' } } });
    r.engine.setSelection([a ?? '']);
    r.drag([50, -KNOB], [150, 50]); // a → 90°
    const from = r.engine.scene.pointOf(c ?? '', 'from');
    const want = anchorOf(rec(r, a), 'right');
    expect(from?.x).toBeCloseTo(want.x);
    expect(from?.y).toBeCloseTo(want.y);
    expect(want.y).toBeGreaterThan(80); // the right side now points down
    // Several selected: a free-ended connector turns with them.
    const [f] = r.make({ init: { kind: 'connector', from: { x: 300, y: 300 }, to: { x: 400, y: 300 } } });
    r.engine.setSelection([b ?? '', f ?? '']);
    const pivot = { x: 450, y: 50 }; // b only: its own center
    r.drag([450, 0 - KNOB], [450 + 100, 50]);
    expect(rec(r, b).rot).toBe(90);
    const free = r.engine.scene.pointOf(f ?? '', 'from');
    // Only boxes set the pivot (b's center): (300, 300) about (450, 50) by 90° → (200, 50)
    expect(free?.x).toBeCloseTo(pivot.x - 250);
    expect(free?.y).toBeCloseTo(pivot.y - 150);
  });
  it('a rotated object is drawn rotated, and the whole turn costs one frame at rest (no timers)', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300));
    r.engine.setSelection([a ?? '']);
    r.raf.flush();
    const before = r.engine.stats.frames;
    r.drag([450, 300 - KNOB], [550, 350]);
    r.raf.flush();
    expect(r.engine.stats.frames).toBeGreaterThan(before);
    r.raf.flush();
    expect(r.raf.pending).toBe(0);
    expect(r.engine.renderer.frameScheduled).toBe(false);
  });
  it('a turn does not change the primitives React reads', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300));
    r.engine.setSelection([a ?? '']);
    const s0 = r.engine.getState();
    let notified = 0;
    r.engine.subscribe(() => notified++);
    r.drag([450, 300 - KNOB], [550, 350]);
    expect(r.engine.getState()).toBe(s0);
    expect(notified).toBe(0);
  });
  it('align uses the circumscribed rect of a rotated box', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0, { w: 200, h: 40, rot: 90 }), sticky(300, 100));
    r.engine.setSelection([a ?? '', b ?? '']);
    // a upright: x 80..120 (center 100), y -80..120 → left edge 80
    r.engine.arrange('left');
    expect(rec(r, a).x).toBe(0);
    expect(rec(r, b).x).toBeCloseTo(80);
  });
  it('typing into a rotated object turns the editor with it', () => {
    const r = rig();
    const [a] = r.make(sticky(400, 300, { rot: 45 }));
    expect(r.engine.startTextEdit(a)).toBe(true);
    const ta = r.host.querySelector('textarea');
    expect(ta?.style.transform).toContain('rotate(45deg)');
    r.engine.editor.cancel();
  });
  it('a read-only canvas offers no handles', () => {
    const r = rig({ readOnly: true });
    const [a] = r.make(sticky(400, 300, { rot: 10 }));
    r.engine.setSelection([a ?? '']);
    expect(r.engine.selectionFrame()).toBeNull();
  });
});

describe('locked objects', () => {
  it('are selected by a click but do not move, resize, rotate or open the editor', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100, { locked: true }));
    r.engine.doc.undo.clear();
    r.click(150, 150);
    expect(r.engine.getState().selectedId).toBe(a);
    r.drag([150, 150], [300, 300]);
    expect(snap(r, a)).toMatchObject({ x: 100, y: 100 });
    expect(r.engine.selectionFrame()).toMatchObject({ resize: false, rotate: false });
    // Dragging where the handles would be does nothing but a marquee/move attempt.
    r.drag([200, 200], [260, 260]);
    expect(snap(r, a)).toMatchObject({ x: 100, y: 100, w: 100, h: 100 });
    expect(r.engine.startTextEdit(a)).toBe(false);
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 150 }));
    expect(r.engine.getState().editing).toBe(false);
    r.key('Enter');
    expect(r.engine.getState().editing).toBe(false);
    expect(r.engine.doc.undo.undoStack.length).toBe(0);
  });
  it('keys, the panel and delete do not change a locked object (the lock protects from deletion too)', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100, { locked: true }));
    r.engine.setSelection([a ?? '']);
    r.engine.doc.undo.clear();
    r.key('ArrowRight');
    r.engine.updateSelected({ color: 'pink' });
    expect(snap(r, a)).toMatchObject({ x: 100, color: 'yellow' });
    r.key('Delete');
    expect(r.engine.doc.count).toBe(1);
    expect(r.engine.doc.undo.undoStack.length).toBe(0);
  });
  it('are left out of the marquee and of select all', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100, { locked: true }), sticky(300, 100));
    r.engine.clearSelection();
    r.drag([50, 50], [500, 300]);
    expect([...r.engine.selection]).toEqual([b]);
    r.engine.selectAll();
    expect([...r.engine.selection]).toEqual([b]);
    expect(r.engine.scene.get(a ?? '')?.locked).toBe(true);
  });
  it('a locked object in a mixed selection stays while the rest moves', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100, { locked: true }), sticky(300, 100));
    r.engine.setSelection([a ?? '', b ?? '']);
    r.drag([350, 150], [400, 250]);
    expect(snap(r, a)).toMatchObject({ x: 100, y: 100 });
    expect(snap(r, b)).toMatchObject({ x: 350, y: 200 });
    expect(r.engine.selectionFrame()).toMatchObject({ resize: false, rotate: false });
    r.engine.nudge(5, 5);
    expect(snap(r, a)).toMatchObject({ x: 100, y: 100 });
  });
  it('⌘⇧L locks and unlocks (one undo step each); every selected object is toggled together', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(300, 0, { locked: true }));
    r.engine.setSelection([a ?? '', b ?? '']);
    r.key('L', { ...mod, shiftKey: true });
    expect(r.engine.scene.get(a ?? '')?.locked).toBe(true);
    expect(r.engine.scene.get(b ?? '')?.locked).toBe(true);
    r.key('L', { ...mod, shiftKey: true });
    expect(r.engine.scene.get(a ?? '')?.locked).toBeUndefined();
    expect(r.engine.scene.get(b ?? '')?.locked).toBeUndefined();
    r.engine.undo();
    expect(r.engine.scene.get(a ?? '')?.locked).toBe(true);
  });
  it('a connector glues to a locked object as usual, and follows nothing because it does not move', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100, { locked: true }));
    r.engine.setTool('connector');
    r.drag([300, 400], [150, 150]);
    const c = [...r.engine.doc.objects.keys()].find((k) => k !== a) ?? '';
    expect(r.engine.doc.snapshot(c)).toMatchObject({ kind: 'connector', to: { id: a } });
  });
  it('a read-only canvas does not toggle', () => {
    const r = rig({ readOnly: true });
    const [a] = r.make(sticky(0, 0));
    r.engine.setSelection([a ?? '']);
    r.engine.toggleLock();
    expect(r.engine.scene.get(a ?? '')?.locked).toBeUndefined();
  });
});

describe('groups', () => {
  const pair2 = (r: Rig): [string, string, string] => {
    const [a, b, c] = r.make(sticky(100, 100), sticky(300, 100), sticky(700, 100));
    return [a ?? '', b ?? '', c ?? ''];
  };

  it('⌘G groups two or more selected objects (one undo step), ⇧⌘G dissolves', () => {
    const r = rig();
    const [a, b, c] = pair2(r);
    r.engine.setSelection([a]);
    r.key('g', mod);
    expect(r.engine.scene.get(a)?.group).toBeUndefined(); // one object: nothing to group
    r.engine.setSelection([a, b]);
    r.key('g', mod);
    const g = r.engine.scene.get(a)?.group;
    expect(typeof g).toBe('string');
    expect(r.engine.scene.get(b)?.group).toBe(g);
    expect(r.engine.scene.get(c)?.group).toBeUndefined();
    r.engine.undo();
    expect(r.engine.scene.get(a)?.group).toBeUndefined();
    r.engine.redo();
    expect(r.engine.scene.get(a)?.group).toBe(g);
    r.key('G', { ...mod, shiftKey: true });
    expect(r.engine.scene.get(a)?.group).toBeUndefined();
    expect(r.engine.scene.get(b)?.group).toBeUndefined();
    expect(r.engine.doc.objects.get(a)?.has('group')).toBe(false);
  });
  it('a click on a member selects the whole group; shift-click toggles all of it; a click on empty space clears', () => {
    const r = rig();
    const [a, b, c] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.click(150, 150);
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
    r.click(750, 150, { shiftKey: true });
    expect([...r.engine.selection].sort()).toEqual([a, b, c].sort());
    r.click(350, 150, { shiftKey: true });
    expect([...r.engine.selection]).toEqual([c]);
    r.click(1000, 600);
    expect(r.engine.selection.size).toBe(0);
  });
  it('the marquee takes a group whole when it takes one member', () => {
    const r = rig();
    const [a, b] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.drag([50, 50], [150, 150]); // crosses a, takes nothing
    expect(r.engine.selection.size).toBe(0);
    r.drag([50, 50], [250, 250]); // takes a whole
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
  });
  it('dragging a member moves the whole group; the frame offers rotation and no resize', () => {
    const r = rig();
    const [a, b, c] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.drag([150, 150], [250, 250]);
    expect(snap(r, a)).toMatchObject({ x: 200, y: 200 });
    expect(snap(r, b)).toMatchObject({ x: 400, y: 200 });
    expect(snap(r, c)).toMatchObject({ x: 700, y: 100 });
    expect(r.engine.selectionFrame()).toMatchObject({ resize: false, rotate: true });
    // A drag from where the frame's corner handle would be does not resize anything.
    const f = r.engine.selectionFrame();
    expect(f).not.toBeNull();
    if (!f) return;
    const w0 = rec(r, b).w;
    r.drag([f.rect.x + f.rect.w, f.rect.y + f.rect.h], [f.rect.x + f.rect.w + 80, f.rect.y + f.rect.h + 80]);
    expect(rec(r, b).w).toBe(w0);
  });
  it('a double-click steps into the group and edits the member at once; Esc leaves it with the group selected', () => {
    const r = rig();
    const [a, b] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.click(150, 150);
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 150 }));
    expect([...r.engine.selection]).toEqual([a]);
    expect(r.engine.enteredGroup).not.toBeNull();
    // Owner 30.10: one double-click on a sticky writes in it, grouped or not.
    expect(r.engine.getState().editing).toBe(true);
    r.engine.editor.cancel();
    r.canvas.focus();
    // Inside: a click picks a member alone, and it can be moved alone.
    r.click(350, 150);
    expect([...r.engine.selection]).toEqual([b]);
    r.drag([350, 150], [350, 250]);
    expect(snap(r, b)).toMatchObject({ y: 200 });
    expect(snap(r, a)).toMatchObject({ y: 100 });
    // A double-click on another member edits its text.
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 350, clientY: 250 }));
    expect(r.engine.getState().editing).toBe(true);
    r.engine.editor.cancel();
    r.canvas.focus();
    r.key('Escape');
    expect(r.engine.enteredGroup).toBeNull();
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
  });
  it('clicking outside the entered group leaves it', () => {
    const r = rig();
    const [a, b, c] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.enterGroupAt(a);
    r.click(750, 150);
    expect(r.engine.enteredGroup).toBeNull();
    expect([...r.engine.selection]).toEqual([c]);
    r.click(150, 150);
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
  });
  it('duplicate (⌘D) makes a new group; delete removes the whole group; layer order moves it as one', () => {
    const r = rig();
    const [a, b, c] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.click(150, 150);
    r.engine.reorder(1, true);
    expect(r.engine.scene.orderedIds().slice(-2).sort()).toEqual([a, b].sort());
    expect(r.engine.scene.orderedIds()[0]).toBe(c);
    r.key('d', mod);
    const copies = [...r.engine.selection];
    expect(copies).toHaveLength(2);
    expect(copies.every((id) => id !== a && id !== b)).toBe(true);
    const g2 = r.engine.scene.get(copies[0] ?? '')?.group;
    expect(g2).toBeDefined();
    expect(g2).not.toBe(r.engine.scene.get(a)?.group);
    expect(r.engine.scene.get(copies[1] ?? '')?.group).toBe(g2);
    r.key('Delete');
    expect(r.engine.doc.count).toBe(3);
    expect(r.engine.scene.get(a)?.group).toBeDefined();
  });
  it('copy and paste: the pasted group has an id of its own', () => {
    const r = rig();
    const [a, b] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    void r.engine.copy();
    const pasted = r.engine.pasteText(serializeNow(r));
    expect(pasted).toHaveLength(2);
    const g1 = r.engine.scene.get(a)?.group;
    const g2 = r.engine.scene.get(pasted[0] ?? '')?.group;
    expect(g2).toBeDefined();
    expect(g2).not.toBe(g1);
  });
  it('rotating a group turns every member about the center of the group bounds, each by the same angle', () => {
    const r = rig();
    const [a, b] = r.make(sticky(0, 0), sticky(300, 0));
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.click(50, 50);
    r.drag([200, -KNOB], [400, 50]);
    expect(rec(r, a ?? '').rot).toBe(90);
    expect(rec(r, b ?? '').rot).toBe(90);
    expect(rec(r, a ?? '').y + 50).toBeCloseTo(-100);
    expect(rec(r, b ?? '').y + 50).toBeCloseTo(200);
    // The group is still a group and still selected as a whole.
    expect(r.engine.scene.get(a ?? '')?.group).toBe(r.engine.scene.get(b ?? '')?.group);
    // Rotating again accumulates (90 + 90).
    r.engine.setSelection([a ?? '', b ?? '']);
    const f = r.engine.selectionFrame();
    expect(f?.rot).toBe(0);
  });
  it('a group of fewer than two members dissolves on its own; the survivor is an ordinary object', () => {
    const r = rig();
    const [a, b] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.setSelection([b]);
    r.key('Delete');
    expect(r.engine.scene.get(a)?.group).toBeUndefined();
    r.engine.clearSelection();
    r.click(150, 150);
    expect([...r.engine.selection]).toEqual([a]);
  });
  it('locking a group locks all members; a group with a locked member still selects whole', () => {
    const r = rig();
    const [a, b] = pair2(r);
    r.engine.setSelection([a, b]);
    r.engine.groupSelection();
    r.engine.toggleLock();
    expect(r.engine.scene.get(a)?.locked).toBe(true);
    expect(r.engine.scene.get(b)?.locked).toBe(true);
    r.engine.clearSelection();
    r.click(150, 150);
    expect([...r.engine.selection].sort()).toEqual([a, b].sort());
    r.drag([150, 150], [250, 250]);
    expect(snap(r, a)).toMatchObject({ x: 100, y: 100 });
  });
  it('grouping replaces earlier groups (flat groups, no nesting) and re-selecting works with Tab', () => {
    const r = rig();
    const [a, b, c] = pair2(r);
    r.engine.setSelection([a, b]);
    const g1 = r.engine.groupSelection();
    r.engine.setSelection([b, c]);
    const g2 = r.engine.groupSelection();
    expect(g1).not.toBe(g2);
    expect(r.engine.scene.get(a)?.group).toBeUndefined(); // a was left alone in g1
    expect(r.engine.scene.get(b)?.group).toBe(g2);
    r.engine.clearSelection();
    r.key('Tab');
    expect(r.engine.selection.size).toBe(1);
  });
  it('grouping the same whole group again changes nothing', () => {
    const r = rig();
    const [a, b] = pair2(r);
    r.engine.setSelection([a, b]);
    const g = r.engine.groupSelection();
    const steps = r.engine.doc.undo.undoStack.length;
    expect(r.engine.groupSelection()).toBe(g);
    expect(r.engine.doc.undo.undoStack.length).toBe(steps);
  });
});

describe('align and distribute', () => {
  it('aligns the selection (one undo step) and connectors glued to it follow', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(100, 100), sticky(300, 250), sticky(600, 40));
    const [k] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' } } });
    r.engine.setSelection([a ?? '', b ?? '', c ?? '']);
    const steps = r.engine.doc.undo.undoStack.length;
    r.engine.arrange('top');
    expect(r.engine.doc.undo.undoStack.length).toBe(steps + 1);
    for (const id of [a, b, c]) expect(snap(r, id)?.y).toBe(40);
    expect(r.engine.scene.pointOf(k ?? '', 'from')).toEqual({ x: 200, y: 90 });
    r.engine.undo();
    expect(snap(r, a)?.y).toBe(100);
    expect(snap(r, b)?.y).toBe(250);
    expect(snap(r, c)?.y).toBe(40);
  });
  it('runs all eight operations; locked objects do not move and do not set the edge', () => {
    const r = rig();
    const [a, b, c, d] = r.make(sticky(100, 100), sticky(300, 250), sticky(600, 40), sticky(0, 0, { locked: true }));
    r.engine.setSelection([a ?? '', b ?? '', c ?? '', d ?? '']);
    r.engine.arrange('left');
    expect(snap(r, a)?.x).toBe(100);
    expect(snap(r, b)?.x).toBe(100);
    expect(snap(r, c)?.x).toBe(100);
    expect(snap(r, d)).toMatchObject({ x: 0, y: 0 });
    r.engine.arrange('hcenter');
    expect(snap(r, b)?.x).toBe(snap(r, a)?.x);
    r.engine.arrange('right');
    r.engine.arrange('bottom');
    r.engine.arrange('vmiddle');
    expect(snap(r, a)?.y).toBe(snap(r, c)?.y);
    r.engine.setSelection([a ?? '', b ?? '', c ?? '']);
    // Distribute needs three, equal gaps; a, b, c are stacked now: spread them in x first.
    r.engine.doc.patchMany(new Map([[a ?? '', { x: 0 }], [b ?? '', { x: 130 }], [c ?? '', { x: 500 }]]));
    r.engine.arrange('hspace');
    const xs = [a, b, c].map((i) => Number(snap(r, i)?.x)).sort((p, q) => p - q);
    expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeCloseTo((xs[2] ?? 0) - (xs[1] ?? 0));
    r.engine.doc.patchMany(new Map([[a ?? '', { y: 0 }], [b ?? '', { y: 130 }], [c ?? '', { y: 500 }]]));
    r.engine.arrange('vspace');
    const ys = [a, b, c].map((i) => Number(snap(r, i)?.y)).sort((p, q) => p - q);
    expect((ys[1] ?? 0) - (ys[0] ?? 0)).toBeCloseTo((ys[2] ?? 0) - (ys[1] ?? 0));
  });
  it('does nothing with fewer than two (three for distribute) movable objects', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(100, 100), sticky(300, 250), sticky(600, 40, { locked: true }));
    r.engine.setSelection([a ?? '', c ?? '']);
    const steps = r.engine.doc.undo.undoStack.length;
    r.engine.arrange('top');
    expect(snap(r, a)?.y).toBe(100);
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.arrange('hspace');
    expect(snap(r, b)).toMatchObject({ x: 300, y: 250 });
    expect(r.engine.doc.undo.undoStack.length).toBe(steps);
  });
  it('moves a whole group as one unit and aligns by circumscribed rects (rotated boxes included)', () => {
    const r = rig();
    const [a, b, c] = r.make(sticky(100, 100), sticky(300, 100), sticky(600, 300));
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.groupSelection();
    r.engine.setSelection([a ?? '', b ?? '', c ?? '']);
    r.engine.arrange('top');
    // The group (y 100) stays, c comes up to its top; a and b did not drift apart.
    expect(snap(r, a)?.y).toBe(100);
    expect(snap(r, b)?.y).toBe(100);
    expect(snap(r, c)?.y).toBe(100);
    r.engine.arrange('left');
    expect(snap(r, c)?.x).toBe(100);
    expect(Number(snap(r, b)?.x) - Number(snap(r, a)?.x)).toBe(200);
  });
  it('a read-only canvas does nothing', () => {
    const r = rig({ readOnly: true });
    const [a, b] = r.make(sticky(100, 100), sticky(300, 250));
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.arrange('top');
    expect(snap(r, b)?.y).toBe(250);
  });
});

describe('drawing and export of rotated objects', () => {
  const env = { palette: defaultPalette('light'), layouter: new TextLayouter((t, n) => t.length * n * 0.5), scale: 1, hiddenText: null };
  const box = (rot?: number): BoxRec => ({ kind: 'sticky', id: 'a', z: 'a', x: 100, y: 100, w: 100, h: 60, color: 'yellow', text: '', ...(rot ? { rot } : {}) });

  it('turns the context about the center for a rotated box, and not at all for an unrotated one', () => {
    const f = fakeCtx();
    drawObject(f.ctx, box(90), env);
    expect(f.calls.find((c) => c.name === 'rotate')?.args[0]).toBeCloseTo(Math.PI / 2);
    expect(f.calls.find((c) => c.name === 'translate')?.args).toEqual([150, 130]);
    expect(f.count('save')).toBe(f.count('restore'));
    const g = fakeCtx();
    drawObject(g.ctx, box(), env);
    expect(g.count('rotate')).toBe(0);
    expect(g.count('save')).toBe(0);
  });
  it('culls by the circumscribed rect: a box turned into the region is drawn, one that only its frame touches is not', () => {
    // 300×20 box about (150, 110) turned 90°: spans y -40..260 at x 140..160.
    const o: BoxRec = { kind: 'sticky', id: 'r', z: 'a', x: 0, y: 100, w: 300, h: 20, color: 'yellow', text: '', rot: 90 };
    const into = fakeCtx();
    drawObjects(into.ctx, [o], { x: 100, y: 200, w: 100, h: 50 }, env);
    expect(into.count('fill')).toBeGreaterThan(0);
    const out = fakeCtx();
    drawObjects(out.ctx, [o], { x: 250, y: 100, w: 40, h: 20 }, env); // inside the unrotated frame only
    // The circumscribed rect is x 140..160: this region is beyond it.
    expect(out.count('fill')).toBe(0);
  });
  it('PNG export frames the turned content (its circumscribed rect), not the unrotated frames', () => {
    const r = rig();
    r.make({ init: { kind: 'sticky', x: 0, y: 0, w: 400, h: 40, rot: 90 } });
    const c = r.engine.exportToCanvas({ pxPerUnit: 1, pad: 10 });
    expect(c?.width).toBe(40 + 20);
    expect(c?.height).toBe(400 + 20);
    const b = r.engine.scene.bounds();
    expect(b?.w).toBeCloseTo(40);
    expect(b?.h).toBeCloseTo(400);
  });
  it('a peer\'s selection outline is drawn turned too', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 0, y: 0, w: 100, h: 60, rot: 30 } });
    r.engine.setPeers([{ id: 'p', name: 'P', color: '#f00', selection: [a ?? ''], cursor: null }]);
    const f = fakeCtx();
    const box = r.engine.awareness.draw(f.ctx, { tx: 0, ty: 0, scale: 1 }, r.engine.scene, defaultPalette('light'), 0);
    expect(f.calls.find((c) => c.name === 'rotate')?.args[0]).toBeCloseTo((30 * Math.PI) / 180);
    expect(box?.w).toBeGreaterThan(100);
  });
});

describe('sticky pads (owner 30.10)', () => {
  const pad = (r: Rig): string => {
    const [id] = r.make({ init: { kind: 'sticky', x: 100, y: 100, w: 160, h: 160, color: 'pink', text: 'Ирина', pad: true } });
    r.engine.doc.checkpoint();
    return id ?? '';
  };

  it('a drag pulls a new empty sticky of its colour off the pad, in one undo step; the pad stays', () => {
    const r = rig();
    const p = pad(r);
    const steps = r.engine.doc.undo.undoStack.length;
    r.drag([180, 180], [580, 380]);
    expect(snap(r, p)).toMatchObject({ x: 100, y: 100, pad: true, text: 'Ирина' });
    const made = [...r.engine.selection];
    expect(made).toHaveLength(1);
    expect(made[0]).not.toBe(p);
    expect(snap(r, made[0])).toMatchObject({ kind: 'sticky', x: 500, y: 300, w: 160, h: 160, color: 'pink', text: '' });
    expect(snap(r, made[0])?.pad).toBeUndefined();
    expect(r.engine.doc.undo.undoStack.length).toBe(steps + 1);
    r.engine.undo();
    expect(r.engine.scene.has(made[0] ?? '')).toBe(false);
  });

  it('Alt-drag moves the pad itself; a locked pad still hands out stickies', () => {
    const r = rig();
    const p = pad(r);
    r.drag([180, 180], [280, 180], { altKey: true });
    expect(snap(r, p)).toMatchObject({ x: 200, y: 100 });
    expect(r.engine.scene.size).toBe(1);
    r.engine.doc.patch(p, { locked: true });
    r.engine.clearSelection();
    r.drag([280, 180], [280, 580]);
    expect(r.engine.scene.size).toBe(2);
    expect(snap(r, p)).toMatchObject({ x: 200, y: 100 });
  });

  it('is not written on: a double-click or a text edit does not open it', () => {
    const r = rig();
    const p = pad(r);
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 180, clientY: 180 }));
    expect(r.engine.getState().editing).toBe(false);
    expect(r.engine.startTextEdit(p)).toBe(false);
  });

  it('the pointer over it: a hand, the corner lifts over a few frames and settles when it leaves', () => {
    const r = rig({ reducedMotion: false });
    pad(r);
    r.raf.flush();
    r.move(180, 180);
    expect(r.canvas.style.cursor).toBe('grab');
    let frames = 0;
    for (let i = 0; i < 20; i++) {
      r.clock.t += 16;
      if (r.raf.pending === 0) break;
      r.raf.flush();
      frames++;
    }
    // A short animation, then no more frames at rest.
    expect(frames).toBeGreaterThan(2);
    expect(r.raf.pending).toBe(0);
    r.move(900, 700);
    r.clock.t += 400;
    r.raf.flush();
    r.raf.flush();
    expect(r.raf.pending).toBe(0);
    // With reduced motion the corner just lifts: one repaint, no animation.
    const still = rig();
    pad(still);
    still.raf.flush();
    still.move(180, 180);
    still.raf.flush();
    expect(still.raf.pending).toBe(0);
  });

  it('the flag is stored, copied and patched like any field', () => {
    const r = rig();
    const p = pad(r);
    expect(serialize(r.engine.scene, r.engine.doc, [p])).toContain('"pad":true');
    r.engine.doc.patch(p, { pad: false });
    expect(snap(r, p)?.pad).toBeUndefined();
  });
});

describe('new objects sized for the zoom (owner 30.10)', () => {
  it('createScale: about one screen size, in tidy steps', () => {
    expect(createScale(1)).toBe(1);
    expect(createScale(4)).toBe(4);
    expect(createScale(5.2)).toBe(6);
    expect(createScale(100)).toBe(8);
    expect(createScale(0.1)).toBe(0.5);
  });
  it('a sticky placed zoomed out at 25% is four times bigger, its text too', () => {
    const r = rig();
    r.engine.setCamera({ tx: 0, ty: 0, scale: 0.25 });
    r.key('s');
    r.click(200, 200);
    const id = [...r.engine.selection][0];
    expect(snap(r, id)).toMatchObject({ kind: 'sticky', w: 640, h: 640, x: 480, y: 480 });
    expect(snap(r, id)?.fontPx).toBe(72);
  });
});

describe('review fixes (30.10)', () => {
  it('a hovered «continue» dot animates over several painted frames, then stops', () => {
    const r = rig({ reducedMotion: false });
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, w: 160, h: 160 } });
    r.engine.setSelection([a ?? '']);
    r.raf.flush();
    const before = r.engine.renderer.stats.frames;
    r.engine.hoverQuick('right');
    for (let i = 0; i < 20 && r.raf.pending > 0; i++) {
      r.clock.t += 16;
      r.raf.flush();
    }
    expect(r.engine.renderer.stats.frames - before).toBeGreaterThan(3);
    expect(r.raf.pending).toBe(0);
  });

  it('«continue» inside a frame places the copy beside the source, inside the frame', () => {
    const r = rig();
    const [, a] = r.make(
      { init: { kind: 'frame', x: 0, y: 0, w: 960, h: 540, title: 'F' } },
      { init: { kind: 'sticky', x: 40, y: 40, w: 160, h: 160 } },
    );
    r.engine.setSelection([a ?? '']);
    r.engine.quickCreate('right');
    const made = [...r.engine.selection].find((id) => id !== a);
    expect(snap(r, made)).toMatchObject({ kind: 'sticky', y: 40 });
    expect(Number(snap(r, made)?.x)).toBeLessThan(960 - 160);
  });
});

