import { CanvasDoc, clampText, color, endpoint, isGroupId, isKind, isShapeKind, newId, num, type PlainObject } from './doc';
import { INK_MAX_WIDTH, INK_MIN_WIDTH, inkErase, inkPoints } from './ink';
import { fmtFromDelta, type DeltaOp } from './richText';
import type { Scene } from './scene';
import { isFontToken } from './textLayout';
import { DEFAULTS, MAX_OBJECTS, MAX_TEXT, SOFT_PREFIX, isImageSrc, isLinkUrl, type Endpoint, type InitExtras, type ObjectInit } from './types';

/** Text-clipboard format: prefix + JSON (ADR-0126 §4). */
export const CLIPBOARD_PREFIX = 'calaba-canvas:';
const VERSION = 1;

export interface ClipboardPayload {
  v: number;
  objects: PlainObject[];
}

/**
 * Serializes objects bottom → top. Connectors whose glued target is not part of the copy keep their end
 * where it is (free point), so a pasted connector never points into the old document's objects.
 */
export function serialize(scene: Scene, doc: CanvasDoc, ids: Iterable<string>): string | null {
  const want = new Set(ids);
  const objects: PlainObject[] = [];
  for (const id of scene.orderedIds()) {
    if (!want.has(id)) continue;
    const plain = doc.snapshot(id);
    if (!plain) continue;
    if (plain.kind === 'connector') {
      for (const end of ['from', 'to'] as const) {
        const e = endpoint(plain[end]);
        if (e && 'id' in e && !want.has(e.id)) plain[end] = scene.pointOf(id, end) ?? { x: 0, y: 0 };
      }
    }
    objects.push(plain);
  }
  if (objects.length === 0) return null;
  const payload: ClipboardPayload = { v: VERSION, objects };
  return CLIPBOARD_PREFIX + JSON.stringify(payload);
}

/** Parses clipboard text; null if it is not ours or is malformed. Does not touch the document. */
export function parse(text: string): ClipboardPayload | null {
  if (!text.startsWith(CLIPBOARD_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(CLIPBOARD_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as { v?: unknown; objects?: unknown };
  if (p.v !== VERSION || !Array.isArray(p.objects) || p.objects.length === 0 || p.objects.length > MAX_OBJECTS) return null;
  const objects: PlainObject[] = [];
  for (const o of p.objects as unknown[]) {
    if (typeof o !== 'object' || o === null) continue;
    const r = o as Record<string, unknown>;
    if (typeof r.id !== 'string' || !isKind(r.kind)) continue;
    objects.push({ ...r, id: r.id, kind: r.kind, z: typeof r.z === 'string' ? r.z : '' });
  }
  return objects.length > 0 ? { v: VERSION, objects } : null;
}

/** The formatted text of a clipboard object: its `rich` Y.Text delta when it is a sane one, else the plain `text`. */
function richOf(o: PlainObject): { text: string; fmt: InitExtras['fmt'] } {
  const raw = o.rich;
  if (Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_TEXT) {
    const ops: DeltaOp[] = [];
    for (const op of raw as unknown[]) {
      if (typeof op !== 'object' || op === null) continue;
      const r = op as { insert?: unknown; attributes?: unknown };
      if (typeof r.insert !== 'string') continue;
      ops.push({ insert: r.insert, ...(typeof r.attributes === 'object' && r.attributes !== null ? { attributes: r.attributes as Record<string, unknown> } : {}) });
    }
    const { text, fmt } = fmtFromDelta(ops);
    if (ops.length > 0) return { text: clampText(text), fmt };
  }
  return { text: typeof o.text === 'string' ? clampText(o.text) : '', fmt: undefined };
}

/**
 * Turns clipboard objects into creation inits at `dx, dy` with fresh ids. Connector ends glued to a copied
 * object follow its new id; others become free points.
 */
export function toInits(payload: ClipboardPayload, dx: number, dy: number, makeId: () => string = newId): { id: string; init: ObjectInit }[] {
  const ids = new Map<string, string>();
  for (const o of payload.objects) ids.set(o.id, makeId());
  const shift = (e: Endpoint | null): Endpoint => {
    if (!e) return { x: dx, y: dy };
    if ('id' in e) {
      const nid = ids.get(e.id);
      return nid ? { id: nid, side: e.side } : { x: dx, y: dy };
    }
    return { x: e.x + dx, y: e.y + dy };
  };
  // Groups travel with their members under a fresh id (a pasted copy must not join the original group); a group the
  // copy holds fewer than two members of is not carried at all.
  const members = new Map<string, number>();
  for (const o of payload.objects) if (isGroupId(o.group)) members.set(o.group, (members.get(o.group) ?? 0) + 1);
  const groups = new Map<string, string>();
  for (const [g, n] of members) if (n >= 2) groups.set(g, makeId());
  const out: { id: string; init: ObjectInit }[] = [];
  for (const o of payload.objects) {
    const id = ids.get(o.id);
    if (!id) continue;
    const { text, fmt } = richOf(o);
    const extras: InitExtras = {};
    if (fmt && o.kind !== 'connector' && o.kind !== 'image' && o.kind !== 'ink' && o.kind !== 'frame') extras.fmt = fmt;
    if ((o.kind === 'sticky' || o.kind === 'shape') && isFontToken(o.fontSize)) extras.fontSize = o.fontSize;
    if ((o.kind === 'sticky' || o.kind === 'shape') && typeof o.fontPx === 'number') extras.fontPx = o.fontPx;
    if (o.kind !== 'connector' && o.kind !== 'frame' && typeof o.rot === 'number') extras.rot = o.rot;
    if (o.locked === true) extras.locked = true;
    if ((o.kind === 'sticky' || o.kind === 'text' || o.kind === 'shape') && isLinkUrl(o.link)) extras.link = o.link;
    const g = isGroupId(o.group) ? groups.get(o.group) : undefined;
    if (g !== undefined) extras.group = g;
    const x = num(o.x, 0) + dx;
    const y = num(o.y, 0) + dy;
    switch (o.kind) {
      case 'sticky':
        out.push({ id, init: { kind: 'sticky', x, y, w: num(o.w, 160), h: num(o.h, 160), color: color(o.color, 'yellow'), text, ...(o.pad === true ? { pad: true } : {}), ...extras } });
        break;
      case 'text':
        out.push({ id, init: { kind: 'text', x, y, w: num(o.w, 240), size: num(o.size, 20), color: color(o.color, 'text'), text, ...extras } });
        break;
      case 'shape':
        out.push({
          id,
          init: {
            kind: 'shape', shape: isShapeKind(o.shape) ? o.shape : 'rect', x, y, w: num(o.w, 160), h: num(o.h, 100),
            // A copied soft tone travels as its `soft:` fill (the doc splits it again).
            fill: o.soft === true ? `${SOFT_PREFIX}${color(o.fill, 'none')}` : color(o.fill, 'none'), stroke: color(o.stroke, 'stroke'), strokeWidth: num(o.strokeWidth, 2, 0, 24), text, ...extras,
          },
        });
        break;
      case 'connector':
        out.push({
          id,
          init: {
            kind: 'connector', from: shift(endpoint(o.from)), to: shift(endpoint(o.to)),
            arrow: o.arrow === 'none' || o.arrow === 'both' ? o.arrow : 'end', route: o.route === 'elbow' || o.route === 'curve' ? o.route : 'straight',
            stroke: color(o.stroke, 'stroke'), strokeWidth: num(o.strokeWidth, 2, 0, 24), label: typeof o.label === 'string' ? clampText(o.label) : '', ...extras,
          },
        });
        break;
      case 'image':
        // A picture of anything but the app's own media is dropped (the doc would refuse it anyway).
        if (!isImageSrc(o.src)) break;
        out.push({
          id,
          init: {
            kind: 'image', src: o.src, x, y, w: num(o.w, DEFAULTS.imageSize), h: num(o.h, DEFAULTS.imageSize),
            ...(typeof o.stickerId === 'string' ? { stickerId: o.stickerId } : {}), ...extras,
          },
        });
        break;
      case 'ink': {
        // A stroke without sane points is dropped (the doc would refuse it anyway).
        const pts = inkPoints(o.points);
        if (!pts) break;
        out.push({
          id,
          init: {
            kind: 'ink', x, y, w: num(o.w, 1, 1), h: num(o.h, 1, 1), points: pts,
            stroke: color(o.stroke, DEFAULTS.inkStroke), strokeWidth: num(o.strokeWidth, DEFAULTS.inkWidth, INK_MIN_WIDTH, INK_MAX_WIDTH),
            ...(o.marker === true ? { marker: true } : {}),
            ...(inkErase(o.erase) ? { erase: o.erase as number[] } : {}), ...extras,
          },
        });
        break;
      }
      case 'frame':
        out.push({
          id,
          init: {
            kind: 'frame', x, y, w: num(o.w, DEFAULTS.frameW), h: num(o.h, DEFAULTS.frameH),
            title: typeof o.title === 'string' ? o.title : '', fill: color(o.fill, DEFAULTS.frameFill), ...extras,
          },
        });
        break;
    }
  }
  return out;
}

/** Duplicates objects in the doc at an offset; connectors between duplicated objects stay glued to the copies. */
export function duplicate(scene: Scene, doc: CanvasDoc, ids: Iterable<string>, dx: number, dy: number): string[] {
  const text = serialize(scene, doc, ids);
  const payload = text ? parse(text) : null;
  if (!payload) return [];
  return doc.createMany(toInits(payload, dx, dy));
}
