import * as Y from 'yjs';
import { CanvasDoc, clampTitle, color, endpoint, isGroupId, isKind, isShapeKind, num, type StoredFields } from './doc';
import { FRAME_TITLE_H, FRAME_TITLE_SIZE, frameTitleRect } from './frames';
import {
  boundsOf, distToPolyline, normRot, pointsBounds, rectCenter, rectContainsPoint, rectInflate,
  rotatePoint, type Point, type Rect,
} from './geometry';
import { isValidKey } from './fracIndex';
import { INK_MAX_WIDTH, INK_MIN_WIDTH, fitErase, fitInk, inkDistance, inkErase, inkPoints, inSwath } from './ink';
import { SpatialGrid } from './grid';
import { RouteCache, connectorMidpoint, routeConnector } from './route';
import { pointInShape } from './shapes';
import { fmtFromDelta, type Fmt } from './richText';
import { SHAPE_PAD, TEXT_PAD, TextLayouter, stickyPad, isFontToken, storedFontPx, type FontToken } from './textLayout';
import {
  DEFAULTS, MAX_SIZE, aabb, isBound, isBox, isConnector, isFrame, isImageSrc, isLinkUrl,
  type BoxRec, type ConnectorRec, type Endpoint, type FrameRec, type ObjectRec, type RouteKind, type Arrow,
} from './types';

/** What a scene update touched: ids, the screen-relevant rects to repaint, and whether z-order moved. */
export interface SceneChange {
  readonly ids: ReadonlySet<string>;
  /** World rects (old and new visual bounds of everything that changed). */
  readonly dirty: readonly Rect[];
  /** More than a handful of objects changed: repaint everything. */
  readonly full: boolean;
  /** Added / removed objects or z changed (the draw order may differ). */
  readonly order: boolean;
}

/** Where a record's fields are read from: the object's Y.Map, or the map with a gesture preview over it. */
interface FieldSource {
  get(key: string): unknown;
}

const FULL_REPAINT_OVER = 256;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const ARROW_PAD = 14;
const LABEL_W = 180;
const LABEL_H = 28;

/** Visual bounds: where pixels of the object can land (stroke, arrowheads, connector label). */
export function visualBounds(o: ObjectRec): Rect {
  if (isConnector(o)) {
    let r = rectInflate(o, ARROW_PAD + o.strokeWidth);
    if (o.label) {
      const m = connectorMidpoint(o);
      r = {
        x: Math.min(r.x, m.x - LABEL_W / 2), y: Math.min(r.y, m.y - LABEL_H / 2),
        w: Math.max(r.x + r.w, m.x + LABEL_W / 2) - Math.min(r.x, m.x - LABEL_W / 2),
        h: Math.max(r.y + r.h, m.y + LABEL_H / 2) - Math.min(r.y, m.y - LABEL_H / 2),
      };
    }
    return r;
  }
  // A frame's title hangs above its top edge (as wide as the frame at most).
  if (o.kind === 'frame') return rectInflate({ x: o.x, y: o.y - FRAME_TITLE_H, w: o.w, h: o.h + FRAME_TITLE_H }, 1);
  return rectInflate(aabb(o), o.kind === 'shape' ? o.strokeWidth : o.kind === 'ink' ? o.strokeWidth / 2 + 1 : 1);
}

/** A stored web link of a text-bearing box (`isLinkUrl`); anything else reads as none. */
function linkOf(m: FieldSource): { link?: string } {
  const v = m.get('link');
  return isLinkUrl(v) ? { link: v } : {};
}

/**
 * The engine's read model: immutable records by id, built from the Y.Doc by its events (never through
 * Zustand/React), with a grid index for culling and hit-testing. Connectors are re-routed when a
 * glued object changes.
 */
export class Scene {
  readonly grid = new SpatialGrid();
  readonly routes = new RouteCache();
  private recs = new Map<string, ObjectRec>();
  /** target id → connectors that reference it (even if the target does not exist right now). */
  private readonly byTarget = new Map<string, Set<string>>();
  /** Group id as stored in the doc → ids carrying it; a group of fewer than two is not one (records show `group` only for real groups). */
  private readonly rawGroups = new Map<string, Set<string>>();
  private readonly rawOf = new Map<string, string>();
  private readonly touchedGroups = new Set<string>();
  private order: string[] | null = null;
  private ranks: Map<string, number> | null = null;
  private readonly listeners = new Set<(c: SceneChange) => void>();
  /** Gesture previews (lib/canvas/live.ts): fields shown instead of the stored ones, by object id. */
  private overrides: ReadonlyMap<string, StoredFields> = new Map();
  /** Bumped on every update; renderers use it to invalidate caches. */
  version = 0;
  private readonly onDeep: (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;

  constructor(
    readonly doc: CanvasDoc,
    readonly text: TextLayouter = new TextLayouter(),
  ) {
    this.rebuildAll();
    this.onDeep = (events) => this.handleEvents(events);
    doc.objects.observeDeep(this.onDeep);
  }

  destroy(): void {
    this.doc.objects.unobserveDeep(this.onDeep);
    this.listeners.clear();
  }

  subscribe(fn: (c: SceneChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.recs.size;
  }

  /**
   * Replaces the previewed fields (by object id; `undefined` = the stored key reads as absent) and rebuilds the objects
   * whose entry changed, by identity: an unchanged entry must be passed as the same map.
   */
  setOverrides(next: ReadonlyMap<string, StoredFields>): void {
    const prev = this.overrides;
    if (prev.size === 0 && next.size === 0) return;
    this.overrides = next;
    const ids = new Set<string>();
    for (const [id, f] of prev) if (next.get(id) !== f) ids.add(id);
    for (const [id, f] of next) if (prev.get(id) !== f) ids.add(id);
    if (ids.size > 0) this.refresh(ids);
  }

  private source(id: string, m: Y.Map<unknown>): FieldSource {
    const ov = this.overrides.get(id);
    return ov ? { get: (k) => (ov.has(k) ? ov.get(k) : m.get(k)) } : m;
  }

  get(id: string): ObjectRec | undefined {
    return this.recs.get(id);
  }

  has(id: string): boolean {
    return this.recs.has(id);
  }

  /** Ids bottom → top: every frame below every other object (frames are backgrounds), then by z. Cached until the set or a z changes. */
  orderedIds(): readonly string[] {
    if (!this.order) {
      const arr = Array.from(this.recs.values());
      arr.sort((a, b) => {
        const fa = a.kind === 'frame';
        if (fa !== (b.kind === 'frame')) return fa ? -1 : 1;
        return a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1;
      });
      this.order = arr.map((r) => r.id);
    }
    return this.order;
  }

  rankOf(id: string): number {
    if (!this.ranks) {
      const m = new Map<string, number>();
      this.orderedIds().forEach((i, n) => m.set(i, n));
      this.ranks = m;
    }
    return this.ranks.get(id) ?? -1;
  }

  /** All records bottom → top. */
  all(): ObjectRec[] {
    const out: ObjectRec[] = [];
    for (const id of this.orderedIds()) {
      const r = this.recs.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  /** Records whose visual bounds intersect `r`, bottom → top. */
  query(r: Rect): ObjectRec[] {
    // Decorate with the layer rank once, sort by number: thousands of Map lookups inside the comparator cost more than the draw.
    if (!this.ranks) this.rankOf('');
    const ranks = this.ranks;
    const hits: { rank: number; rec: ObjectRec }[] = [];
    this.grid.forEach(r, (id) => {
      const rec = this.recs.get(id);
      if (rec) hits.push({ rank: ranks?.get(id) ?? -1, rec });
    });
    hits.sort((a, b) => a.rank - b.rank);
    return hits.map((h) => h.rec);
  }

  connectorsOf(id: string): ReadonlySet<string> {
    return this.byTarget.get(id) ?? new Set<string>();
  }

  /** Resolved position of a connector end (for keeping it in place when its target is deleted). */
  pointOf(connectorId: string, end: 'from' | 'to'): Point | null {
    const c = this.recs.get(connectorId);
    if (!c || !isConnector(c) || c.points.length < 4) return null;
    return end === 'from' ? { x: c.points[0] ?? 0, y: c.points[1] ?? 0 } : { x: c.points[c.points.length - 2] ?? 0, y: c.points[c.points.length - 1] ?? 0 };
  }

  /** The frames, bottom → top (the order the frames panel lists them in). */
  frames(): FrameRec[] {
    const out: FrameRec[] = [];
    for (const id of this.orderedIds()) {
      const r = this.recs.get(id);
      // Frames lead the order: the first other object ends the list.
      if (!r || !isFrame(r)) break;
      out.push(r);
    }
    return out;
  }

  /**
   * What a frame holds, computed (never stored): every object whose center lies inside it, and — a frame inside a frame
   * being a member as well — what those hold in turn. A frame at least as big as this one is never its member, so two
   * frames cannot hold each other. Empty for anything but a frame.
   */
  frameMembers(id: string): string[] {
    const root = this.recs.get(id);
    if (!root || !isFrame(root)) return [];
    const out = new Set<string>();
    const todo: FrameRec[] = [root];
    for (let f = todo.pop(); f; f = todo.pop()) {
      const area = f.w * f.h;
      for (const o of this.query(f)) {
        if (o.id === id || out.has(o.id)) continue;
        if (!rectContainsPoint(f, rectCenter(aabb(o)), 0)) continue;
        if (isFrame(o) && o.w * o.h >= area) continue;
        out.add(o.id);
        if (isFrame(o)) todo.push(o);
      }
    }
    return [...out];
  }

  /** The ids plus the members of the frames among them (what moves when they move). */
  withFrameMembers(ids: Iterable<string>): string[] {
    const out = new Set(ids);
    for (const id of [...out]) if (this.recs.get(id)?.kind === 'frame') for (const m of this.frameMembers(id)) out.add(m);
    return [...out];
  }

  /** A frame's title band (empty title: none). */
  frameTitleRect(f: FrameRec): Rect | null {
    if (!f.title) return null;
    return frameTitleRect(f, this.text.layout(f.title, FRAME_TITLE_SIZE, MAX_SIZE).widths[0] ?? 0);
  }

  /** Members of a real group (two or more), empty for anything else. */
  groupMembers(gid: string | undefined): ReadonlySet<string> {
    const set = gid === undefined ? undefined : this.rawGroups.get(gid);
    return set && set.size >= 2 ? set : EMPTY_IDS;
  }

  /** The object together with its group: what a click on it selects. */
  unitOf(id: string): string[] {
    const g = this.recs.get(id)?.group;
    const m = this.groupMembers(g);
    return m.size > 0 ? [...m] : [id];
  }

  /** Bounds on the world axes (rotated boxes by their circumscribed rect). */
  bounds(ids?: Iterable<string>): Rect | null {
    const rects: Rect[] = [];
    if (ids) {
      for (const id of ids) {
        const r = this.recs.get(id);
        if (r) rects.push(aabb(r));
      }
    } else for (const r of this.recs.values()) rects.push(aabb(r));
    return boundsOf(rects);
  }

  /**
   * Topmost object at a world point; `tol` is the pick radius in world units. An unfilled, textless shape is picked
   * by its outline only, so a big empty frame never swallows the clicks (and the marquee) inside it. `boxTol` widens
   * a sticky / text / frame by that much around its edge (a finger's slack; the mouse picks them exactly).
   */
  hit(p: Point, tol: number, accept?: (o: ObjectRec) => boolean, boxTol = 0): ObjectRec | null {
    return this.pick(p, tol, accept, false, boxTol);
  }

  /**
   * Topmost object whose whole area (a shape's transparent interior included) contains the point, `tol` around its
   * edge counted in. For wiring connectors, not for selection: releasing a wire anywhere inside a frame glues to it.
   */
  hitArea(p: Point, tol: number, accept?: (o: ObjectRec) => boolean): ObjectRec | null {
    return this.pick(p, tol, accept, true, 0);
  }

  private pick(p: Point, tol: number, accept: ((o: ObjectRec) => boolean) | undefined, area: boolean, boxTol: number): ObjectRec | null {
    const r = Math.max(tol, boxTol);
    const cands = this.query({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
    for (let i = cands.length - 1; i >= 0; i--) {
      const o = cands[i];
      if (!o || (accept && !accept(o))) continue;
      if (this.hitsObject(o, p, tol, area, boxTol)) return o;
    }
    return null;
  }

  private hitsObject(o: ObjectRec, p: Point, tol: number, area: boolean, boxTol: number): boolean {
    if (isConnector(o)) {
      if (distToPolyline(p, o.points) <= tol) return true;
      if (o.label) {
        const m = connectorMidpoint(o);
        return Math.abs(p.x - m.x) <= LABEL_W / 2 && Math.abs(p.y - m.y) <= LABEL_H / 2 && o.label.length > 0;
      }
      return false;
    }
    if (o.kind === 'frame') {
      // By its area (frames are picked after everything above them) or by the title over its corner.
      if (rectContainsPoint(o, p, boxTol)) return true;
      const t = this.frameTitleRect(o);
      return t !== null && rectContainsPoint(t, p, tol);
    }
    // A rotated box is tested in its own frame: the point is turned back about the center.
    const q = o.rot ? rotatePoint(p, rectCenter(o), -o.rot) : p;
    // A stroke is picked by its line (its width counted in), never by the empty corners of its frame.
    // An erased spot is empty: it picks nothing.
    if (o.kind === 'ink') {
      const l = { x: q.x - o.x, y: q.y - o.y };
      return inkDistance(l, o.points) <= o.strokeWidth / 2 + Math.max(tol, boxTol) && !inSwath(l, o.erase);
    }
    if (o.kind !== 'shape') return rectContainsPoint(o, q, boxTol);
    if (!pointInShape(o.shape, rectInflate(o, tol), q)) return false;
    if (area || o.fill !== 'none' || o.text !== '') return pointInShape(o.shape, o, q) || distNearOutline(o, q, tol);
    // Unfilled and empty: only the outline picks.
    const inner = rectInflate(o, -2 * tol);
    return !(inner.w > 0 && inner.h > 0 && pointInShape(o.shape, inner, q));
  }

  /**
   * Objects the rect takes whole (marquee, as in Miro — owner 23.11): a column or an area behind the stickies that the
   * frame only crosses stays out, so a frame drawn over the stickies of a column picks the stickies alone. A rotated
   * box by its outer bounds; a stroke by its points; a connector by its routed path.
   */
  inRect(r: Rect): ObjectRec[] {
    const inside = (x: number, y: number): boolean => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
    return this.query(r).filter((o) => {
      if (isConnector(o) || (o.kind === 'ink' && !o.rot)) {
        const p = o.points;
        const ox = isConnector(o) ? 0 : o.x;
        const oy = isConnector(o) ? 0 : o.y;
        if (p.length < 2) return false;
        for (let i = 0; i + 1 < p.length; i += 2) if (!inside(ox + (p[i] ?? 0), oy + (p[i + 1] ?? 0))) return false;
        return true;
      }
      const b = aabb(o);
      return inside(b.x, b.y) && inside(b.x + b.w, b.y + b.h);
    });
  }

  // ── building ────────────────────────────────────────────────────────────────

  private boxLookup = (id: string): BoxRec | undefined => {
    const r = this.recs.get(id);
    return r && isBox(r) ? r : undefined;
  };

  private rebuildAll(): void {
    this.recs = new Map();
    this.byTarget.clear();
    this.rawGroups.clear();
    this.rawOf.clear();
    this.grid.clear();
    this.order = null;
    this.ranks = null;
    const conns: [string, Y.Map<unknown>][] = [];
    for (const [id, m] of this.doc.objects) {
      if (m.get('kind') === 'connector') {
        conns.push([id, m]);
        continue;
      }
      const rec = this.buildBox(id, m);
      if (rec) {
        this.store(rec);
        this.grid.insert(id, visualBounds(rec));
      }
    }
    for (const [id, m] of conns) this.putConnector(id, m);
    this.normalizeGroups(new Set());
    this.version++;
  }

  private handleEvents(events: Y.YEvent<Y.AbstractType<unknown>>[]): void {
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.doc.objects) {
        for (const k of ev.changes.keys.keys()) ids.add(k);
      } else {
        const first = ev.path[0];
        if (typeof first === 'string') ids.add(first);
      }
    }
    if (ids.size > 0) this.refresh(ids);
  }

  /** Rebuilds the records of `ids` (and the connectors glued to them) from the doc and notifies. */
  refresh(ids: Iterable<string>): SceneChange {
    const changed = new Set<string>();
    const dirty: Rect[] = [];
    let order = false;
    const touch = (id: string): void => {
      changed.add(id);
      const old = this.recs.get(id);
      if (old) dirty.push(visualBounds(old));
    };
    const connIds = new Set<string>();
    // Phase 1: boxes (and removals).
    for (const id of ids) {
      const m = this.doc.objects.get(id);
      const old = this.recs.get(id);
      if (!m || !isKind(m.get('kind'))) {
        if (old) {
          touch(id);
          this.drop(id);
          order = true;
        }
        continue;
      }
      if (m.get('kind') === 'connector') {
        connIds.add(id);
        continue;
      }
      const rec = this.buildBox(id, m);
      if (!rec) {
        if (old) {
          touch(id);
          this.drop(id);
          order = true;
        }
        continue;
      }
      if (old && sameButFlags(old, rec)) {
        // Only locked / group changed: nothing on the canvas moves, so no repaint and no connector is re-routed.
        changed.add(id);
        this.store(rec);
        continue;
      }
      touch(id);
      if (!old || old.z !== rec.z) order = true;
      this.store(rec);
      this.grid.update(id, visualBounds(rec));
      dirty.push(visualBounds(rec));
      for (const c of this.byTarget.get(id) ?? []) connIds.add(c);
    }
    // Deleted targets also re-route their connectors (dangling → keep last position).
    for (const id of ids) if (!this.recs.has(id)) for (const c of this.byTarget.get(id) ?? []) connIds.add(c);
    // Phase 2: connectors, against the final boxes.
    for (const id of connIds) {
      const m = this.doc.objects.get(id);
      const old = this.recs.get(id);
      if (!m || !isKind(m.get('kind')) || m.get('kind') !== 'connector') {
        if (old) {
          touch(id);
          this.drop(id);
          order = true;
        }
        continue;
      }
      touch(id);
      const rec = this.putConnector(id, m);
      if (!old || old.z !== rec?.z) order = true;
      if (rec) dirty.push(visualBounds(rec));
    }
    this.normalizeGroups(changed);
    if (order) {
      this.order = null;
      this.ranks = null;
    }
    this.version++;
    const change: SceneChange = { ids: changed, dirty, full: changed.size > FULL_REPAINT_OVER, order };
    for (const fn of this.listeners) fn(change);
    return change;
  }

  private drop(id: string): void {
    const old = this.recs.get(id);
    if (old && isConnector(old)) this.unlinkConnector(old);
    this.recs.delete(id);
    this.grid.remove(id);
    this.setRawGroup(id, undefined);
  }

  /** Puts a record in (its `group` is the doc's raw value until `normalizeGroups` runs at the end of the update). */
  private store(rec: ObjectRec): void {
    this.recs.set(rec.id, rec);
    this.setRawGroup(rec.id, rec.group);
    // A rebuilt record carries the raw id again: its group is judged anew.
    if (rec.group !== undefined) this.touchedGroups.add(rec.group);
  }

  private setRawGroup(id: string, gid: string | undefined): void {
    const prev = this.rawOf.get(id);
    if (prev === gid) return;
    if (prev !== undefined) {
      const set = this.rawGroups.get(prev);
      set?.delete(id);
      if (set?.size === 0) this.rawGroups.delete(prev);
      this.touchedGroups.add(prev);
    }
    if (gid === undefined) this.rawOf.delete(id);
    else {
      this.rawOf.set(id, gid);
      let set = this.rawGroups.get(gid);
      if (!set) this.rawGroups.set(gid, (set = new Set()));
      set.add(id);
      this.touchedGroups.add(gid);
    }
  }

  /**
   * Makes every record's `group` the effective one: set only while two or more objects carry the id (a lone
   * leftover — the others deleted, or a concurrent delete — is an ordinary object). Records that change are
   * reported in `changed`; nothing is repainted for it.
   */
  private normalizeGroups(changed: Set<string>): void {
    if (this.touchedGroups.size === 0) return;
    const gids = [...this.touchedGroups];
    this.touchedGroups.clear();
    for (const gid of gids) {
      const members = this.rawGroups.get(gid);
      if (!members) continue;
      const want = members.size >= 2 ? gid : undefined;
      for (const id of members) {
        const rec = this.recs.get(id);
        if (!rec || rec.group === want) continue;
        const { group: _drop, ...rest } = rec;
        this.recs.set(id, (want === undefined ? rest : { ...rest, group: want }));
        changed.add(id);
      }
    }
  }

  private link(connId: string, e: Endpoint): void {
    if (!isBound(e)) return;
    let set = this.byTarget.get(e.id);
    if (!set) this.byTarget.set(e.id, (set = new Set()));
    set.add(connId);
  }

  private unlinkConnector(c: ConnectorRec): void {
    for (const e of [c.from, c.to]) {
      if (!isBound(e)) continue;
      const set = this.byTarget.get(e.id);
      if (set) {
        set.delete(c.id);
        if (set.size === 0) this.byTarget.delete(e.id);
      }
    }
  }

  private zOf(m: FieldSource): string {
    const z = m.get('z');
    return isValidKey(z) ? z : '';
  }

  /** Optional transform fields as they are in the doc; defaults stay absent so unchanged documents build the same records. */
  private extras(m: FieldSource, box: boolean): { rot?: number; locked?: boolean; group?: string } {
    const out: { rot?: number; locked?: boolean; group?: string } = {};
    const rot = box ? normRot(num(m.get('rot'), 0, -1e6, 1e6)) : 0;
    if (rot !== 0) out.rot = rot;
    if (m.get('locked') === true) out.locked = true;
    const g = m.get('group');
    if (isGroupId(g)) out.group = g;
    return out;
  }

  private buildBox(id: string, ym: Y.Map<unknown>): BoxRec | null {
    const m = this.source(id, ym);
    const kind = m.get('kind');
    const z = this.zOf(m);
    const x = num(m.get('x'), 0);
    const y = num(m.get('y'), 0);
    // Text and its formatting from the Y.Text delta. A rebuilt record keeps the old `fmt` object while it is equal, so
    // a lock or a move (which rebuild it) never look like a text change.
    const cell: { fmt?: Fmt } = {};
    const textOf = (): string => {
      const t = ym.get('text');
      if (!(t instanceof Y.Text)) return '';
      const r = fmtFromDelta(t.toDelta() as never);
      let f = r.fmt;
      if (f) {
        const old = this.recs.get(id);
        if (old && (old.kind === 'sticky' || old.kind === 'text' || old.kind === 'shape') && old.fmt?.key === f.key) f = old.fmt;
        cell.fmt = f;
      }
      return r.text;
    };
    const rich = (): { fmt?: Fmt } => (cell.fmt ? { fmt: cell.fmt } : {});
    const fontSizeOf = (kind: 'sticky' | 'shape'): { fontSize?: FontToken; fontPx?: number } => {
      const v = m.get('fontSize');
      const token: FontToken = isFontToken(v) ? v : 'm';
      const px = storedFontPx(kind, m.get('fontPx'), token, DEFAULTS.minTextSize, DEFAULTS.maxTextSize);
      return { ...(token !== 'm' ? { fontSize: token } : {}), ...(px !== undefined ? { fontPx: px } : {}) };
    };
    switch (kind) {
      case 'sticky':
        return {
          kind, id, z, x, y,
          w: num(m.get('w'), DEFAULTS.stickySize, DEFAULTS.minBox, MAX_SIZE), h: num(m.get('h'), DEFAULTS.stickySize, DEFAULTS.minBox, MAX_SIZE),
          color: color(m.get('color'), DEFAULTS.stickyColor), text: textOf(), ...rich(), ...fontSizeOf('sticky'),
          ...(m.get('pad') === true ? { pad: true } : {}), ...linkOf(m), ...this.extras(m, true),
        };
      case 'text': {
        const w = num(m.get('w'), DEFAULTS.textW, DEFAULTS.minTextW, MAX_SIZE);
        const size = num(m.get('size'), DEFAULTS.textSize, DEFAULTS.minTextSize, DEFAULTS.maxTextSize);
        const text = textOf();
        const lay = cell.fmt ? this.text.layoutRich(text, cell.fmt, size, w - 2 * TEXT_PAD) : this.text.layout(text, size, w - 2 * TEXT_PAD);
        const h = Math.max(size * 1.3, lay.height) + 2 * TEXT_PAD;
        return { kind, id, z, x, y, w, h, size, color: color(m.get('color'), DEFAULTS.textColor), text, ...rich(), ...linkOf(m), ...this.extras(m, true) };
      }
      case 'shape': {
        const shape = m.get('shape');
        return {
          kind, id, z, x, y,
          w: num(m.get('w'), DEFAULTS.shapeW, DEFAULTS.minBox, MAX_SIZE), h: num(m.get('h'), DEFAULTS.shapeH, DEFAULTS.minBox, MAX_SIZE),
          shape: isShapeKind(shape) ? shape : 'rect',
          fill: color(m.get('fill'), DEFAULTS.shapeFill), ...(m.get('soft') === true ? { soft: true } : {}), stroke: color(m.get('stroke'), DEFAULTS.shapeStroke),
          strokeWidth: num(m.get('strokeWidth'), DEFAULTS.strokeWidth, 0, 24), text: textOf(), ...rich(), ...fontSizeOf('shape'), ...linkOf(m), ...this.extras(m, true),
        };
      }
      case 'image': {
        const src = m.get('src');
        // A picture of anything but the app's own media is not read (the loader would send the token along).
        if (!isImageSrc(src)) return null;
        const sid = m.get('stickerId');
        return {
          kind, id, z, x, y,
          w: num(m.get('w'), DEFAULTS.imageSize, DEFAULTS.minBox, MAX_SIZE), h: num(m.get('h'), DEFAULTS.imageSize, DEFAULTS.minBox, MAX_SIZE),
          src, ...(typeof sid === 'string' && sid.length <= 64 ? { stickerId: sid } : {}), ...this.extras(m, true),
        };
      }
      case 'ink': {
        // A stroke without sane points is not read (a newer build's variant, a broken write).
        const raw = inkPoints(m.get('points'));
        if (!raw) return null;
        const w = num(m.get('w'), 1, 1, MAX_SIZE);
        const h = num(m.get('h'), 1, 1, MAX_SIZE);
        const erase = inkErase(m.get('erase'));
        return {
          kind, id, z, x, y, w, h, points: fitInk(raw, w, h), ...(erase ? { erase: fitErase(raw, erase, w, h) } : {}),
          stroke: color(m.get('stroke'), DEFAULTS.inkStroke), strokeWidth: num(m.get('strokeWidth'), DEFAULTS.inkWidth, INK_MIN_WIDTH, INK_MAX_WIDTH),
          ...(m.get('marker') === true ? { marker: true } : {}), ...this.extras(m, true),
        };
      }
      case 'frame':
        return {
          kind, id, z, x, y,
          w: num(m.get('w'), DEFAULTS.frameW, DEFAULTS.minFrame, MAX_SIZE), h: num(m.get('h'), DEFAULTS.frameH, DEFAULTS.minFrame, MAX_SIZE),
          title: clampTitle(m.get('title')), fill: color(m.get('fill'), DEFAULTS.frameFill), ...this.extras(m, false),
        };
      default:
        return null;
    }
  }

  private putConnector(id: string, ym: Y.Map<unknown>): ConnectorRec | null {
    const m = this.source(id, ym);
    const old = this.recs.get(id);
    if (old && isConnector(old)) this.unlinkConnector(old);
    const from = endpoint(m.get('from')) ?? { x: 0, y: 0 };
    const to = endpoint(m.get('to')) ?? { x: 0, y: 0 };
    const arrowRaw = m.get('arrow');
    const routeRaw = m.get('route');
    const arrow: Arrow = arrowRaw === 'none' || arrowRaw === 'both' ? arrowRaw : 'end';
    const route: RouteKind = routeRaw === 'elbow' || routeRaw === 'curve' ? routeRaw : 'straight';
    const last: { from?: Point; to?: Point } = {};
    if (old && isConnector(old) && old.points.length >= 4) {
      last.from = { x: old.points[0] ?? 0, y: old.points[1] ?? 0 };
      last.to = { x: old.points[old.points.length - 2] ?? 0, y: old.points[old.points.length - 1] ?? 0 };
    }
    const routed = routeConnector(from, to, route, this.boxLookup, last, this.routes);
    const b = pointsBounds(routed.points);
    const lab = m.get('label');
    const rec: ConnectorRec = {
      kind: 'connector', id, z: this.zOf(m), x: b.x, y: b.y, w: b.w, h: b.h,
      from, to, arrow, route, stroke: color(m.get('stroke'), DEFAULTS.connectorStroke),
      strokeWidth: num(m.get('strokeWidth'), DEFAULTS.strokeWidth, 0, 24), label: typeof lab === 'string' ? lab : '',
      points: routed.points, ...(routed.curve ? { curve: routed.curve } : {}), ...this.extras(m, false),
    };
    this.store(rec);
    this.grid.update(id, visualBounds(rec));
    this.link(id, from);
    this.link(id, to);
    return rec;
  }
}

/** Same record except the `locked` / `group` flags (shallow compare; records are flat apart from connector paths, which are not boxes). */
function sameButFlags(a: ObjectRec, b: ObjectRec): boolean {
  const ka = Object.keys(a).filter((k) => k !== 'locked' && k !== 'group');
  const kb = Object.keys(b).filter((k) => k !== 'locked' && k !== 'group');
  if (ka.length !== kb.length) return false;
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  return ka.every((k) => x[k] === y[k]);
}

function distNearOutline(o: BoxRec, p: Point, tol: number): boolean {
  const inner = rectInflate(o, -2 * tol);
  if (o.kind !== 'shape') return false;
  return !(inner.w > 0 && inner.h > 0 && pointInShape(o.shape, inner, p));
}

export const boxPad = (o: BoxRec): number => (o.kind === 'sticky' ? stickyPad(o) : o.kind === 'shape' ? SHAPE_PAD : TEXT_PAD);
