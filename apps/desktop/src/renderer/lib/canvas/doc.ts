import * as Y from 'yjs';
import { clamp, normRot, type Point } from './geometry';
import { after, before, between, isValidKey } from './fracIndex';
import { fmtFromDelta, fmtToDelta, formatChanges, rawText, type Fmt } from './richText';
import { INK_MAX_WIDTH, INK_MIN_WIDTH, inkErase, inkPoints } from './ink';
import { fontFields, isFontToken } from './textLayout';
import {
  DEFAULTS, MAX_COORD, MAX_OBJECTS, MAX_SIZE, MAX_STATE, MAX_TEXT, MAX_TITLE, SCHEMA_VERSION, SHAPE_KINDS, isImageSrc, isLinkUrl, splitFill,
  type Endpoint, type ObjectInit, type ObjectKind, type ObjectPatch, type ShapeKind, type Side,
} from './types';

/** Transaction origin of this client's own edits: the only one the UndoManager tracks. */
export const LOCAL_ORIGIN: object = Object.freeze({ canvas: 'local' });
/** Origin of the gesture preview written to `live` (lib/canvas/live.ts): never tracked, never undone. */
export const LIVE_ORIGIN: object = Object.freeze({ canvas: 'live' });
/** Undo steps kept; the oldest is dropped (and the values it held are freed) past this. */
export const MAX_UNDO = 100;

const KINDS: readonly ObjectKind[] = ['sticky', 'text', 'shape', 'connector', 'image', 'ink', 'frame'];
const SIDE_SET = new Set<string>(['auto', 'top', 'right', 'bottom', 'left']);
const ARROW_SET = new Set<string>(['none', 'end', 'both']);
const ROUTE_SET = new Set<string>(['straight', 'elbow', 'curve']);

export const isKind = (v: unknown): v is ObjectKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
export const isShapeKind = (v: unknown): v is ShapeKind => typeof v === 'string' && (SHAPE_KINDS as readonly string[]).includes(v);

export const num = (v: unknown, fallback: number, lo = -MAX_COORD, hi = MAX_COORD): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

/** A palette token name or a #hex literal; anything else is replaced by the fallback. */
export function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length <= 32 && /^(#[0-9a-fA-F]{3,8}|[a-z][a-z0-9-]*)$/.test(v) ? v : fallback;
}

export function endpoint(v: unknown): Endpoint | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 64) {
    const side = typeof o.side === 'string' && SIDE_SET.has(o.side) ? (o.side as Side) : 'auto';
    return { id: o.id, side };
  }
  if (typeof o.x === 'number' && typeof o.y === 'number' && Number.isFinite(o.x) && Number.isFinite(o.y)) {
    return { x: clamp(o.x, -MAX_COORD, MAX_COORD), y: clamp(o.y, -MAX_COORD, MAX_COORD) };
  }
  return null;
}

/** Clamps text to `max` (MAX_TEXT) without cutting a surrogate pair. */
export function clampText(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

export function newId(): string {
  const buf = new Uint8Array(9);
  globalThis.crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += (b % 36).toString(36);
  return s;
}

/** A frame's title: one line (breaks become spaces), at most MAX_TITLE. */
export const clampTitle = (v: unknown): string => (typeof v === 'string' ? clampText(v.replace(/[\r\n\t]+/g, ' '), MAX_TITLE) : '');

/** Applies `next` to `yt` as the smallest single delete+insert (keeps concurrent edits mergeable). */
export function applyTextDiff(yt: Y.Text, next: string, original?: string): void {
  const cur = yt.toJSON();
  if (cur === next) return;
  if (original !== undefined && original !== cur && applyOriginalDiff(yt, cur, original, next)) return;
  let p = 0;
  const max = Math.min(cur.length, next.length);
  while (p < max && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (p > 0) {
    const c = cur.charCodeAt(p - 1);
    if (c >= 0xd800 && c <= 0xdbff) p--;
  }
  let s = 0;
  while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  if (s > 0) {
    const c = cur.charCodeAt(cur.length - s);
    if (c >= 0xdc00 && c <= 0xdfff) s--;
  }
  yt.doc?.transact(() => {
    if (cur.length - p - s > 0) yt.delete(p, cur.length - p - s);
    if (next.length - p - s > 0) yt.insert(p, next.slice(p, next.length - s));
  }, LOCAL_ORIGIN);
}

/**
 * Applies the original→next change onto a text that moved on since `original` (a co-author edited meanwhile), so
 * their edit survives. Returns false when the edited range overlaps their change (caller falls back to cur→next).
 */
function applyOriginalDiff(yt: Y.Text, cur: string, original: string, next: string): boolean {
  const max = Math.min(original.length, next.length);
  let p = 0;
  while (p < max && original.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (p > 0 && isHigh(original.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && original.charCodeAt(original.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  if (s > 0 && isLow(original.charCodeAt(original.length - s))) s--;
  const oe = original.length - s;
  // Unchanged prefix/suffix between original and the current text.
  const cmax = Math.min(original.length, cur.length);
  let pc = 0;
  while (pc < cmax && original.charCodeAt(pc) === cur.charCodeAt(pc)) pc++;
  let sc = 0;
  while (sc < cmax - pc && original.charCodeAt(original.length - 1 - sc) === cur.charCodeAt(cur.length - 1 - sc)) sc++;
  const delta = cur.length - original.length;
  const map = (i: number): number => (i <= pc ? i : i >= original.length - sc ? i + delta : -1);
  const a = map(p);
  const b = map(oe);
  if (a < 0 || b < 0 || b < a) return false;
  yt.doc?.transact(() => {
    if (b - a > 0) yt.delete(a, b - a);
    if (next.length - p - s > 0) yt.insert(a, next.slice(p, next.length - s));
  }, LOCAL_ORIGIN);
  return true;
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Plain copy of one object (text as string), the shape the clipboard and tests work with. */
export type PlainObject = { id: string; kind: ObjectKind; z: string } & Record<string, unknown>;

const FIELD_KEYS: Record<ObjectKind, readonly string[]> = {
  sticky: ['x', 'y', 'w', 'h', 'color', 'fontSize', 'fontPx', 'pad', 'link', 'rot', 'locked', 'group'],
  text: ['x', 'y', 'w', 'size', 'color', 'link', 'rot', 'locked', 'group'],
  shape: ['shape', 'x', 'y', 'w', 'h', 'fill', 'soft', 'stroke', 'strokeWidth', 'fontSize', 'fontPx', 'link', 'rot', 'locked', 'group'],
  connector: ['from', 'to', 'arrow', 'route', 'stroke', 'strokeWidth', 'label', 'locked', 'group'],
  image: ['x', 'y', 'w', 'h', 'src', 'stickerId', 'rot', 'locked', 'group'],
  ink: ['x', 'y', 'w', 'h', 'points', 'stroke', 'strokeWidth', 'marker', 'erase', 'rot', 'locked', 'group'],
  frame: ['x', 'y', 'w', 'h', 'title', 'fill', 'locked', 'group'],
};

const PATCH_KEYS: Record<ObjectKind, readonly (keyof ObjectPatch)[]> = {
  sticky: ['x', 'y', 'w', 'h', 'color', 'fontSize', 'fontPx', 'pad', 'link', 'rot', 'locked', 'group'],
  text: ['x', 'y', 'w', 'size', 'color', 'link', 'rot', 'locked', 'group'],
  shape: ['x', 'y', 'w', 'h', 'shape', 'fill', 'soft', 'stroke', 'strokeWidth', 'fontSize', 'fontPx', 'link', 'rot', 'locked', 'group'],
  connector: ['from', 'to', 'arrow', 'route', 'stroke', 'strokeWidth', 'label', 'locked', 'group'],
  // The picture itself (`src`) is fixed at creation.
  image: ['x', 'y', 'w', 'h', 'rot', 'locked', 'group'],
  // The stroke itself (`points`, `marker`) is fixed at creation; a resize stretches it through `w` / `h`; the eraser adds swaths.
  ink: ['x', 'y', 'w', 'h', 'stroke', 'strokeWidth', 'erase', 'rot', 'locked', 'group'],
  // A frame never rotates.
  frame: ['x', 'y', 'w', 'h', 'title', 'fill', 'locked', 'group'],
};

/** A group id is a short token (newId's alphabet); anything else is ignored. */
export const isGroupId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,32}$/.test(v);

/** Optional transform fields of an init that are worth storing: absent = default, so nothing is written for the defaults. */
function extraFields(init: ObjectInit): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rot = init.kind !== 'connector' && init.kind !== 'frame' && typeof init.rot === 'number' ? normRot(init.rot) : 0;
  if (rot !== 0) out.rot = rot;
  if (init.locked === true) out.locked = true;
  if (isGroupId(init.group)) out.group = init.group;
  if (init.kind === 'sticky' || init.kind === 'shape') {
    if (typeof init.fontPx === 'number' && Number.isFinite(init.fontPx)) Object.assign(out, fontFields(init.kind, clamp(init.fontPx, DEFAULTS.minTextSize, DEFAULTS.maxTextSize)));
    else if (isFontToken(init.fontSize) && init.fontSize !== 'm') out.fontSize = init.fontSize;
  }
  if ((init.kind === 'sticky' || init.kind === 'text' || init.kind === 'shape') && isLinkUrl(init.link)) out.link = init.link;
  return out;
}

/** Validated, defaulted field map for an init (what gets stored). */
function initFields(init: ObjectInit): { fields: Record<string, unknown>; text: string | null } {
  switch (init.kind) {
    case 'sticky':
      return {
        fields: {
          x: num(init.x, 0), y: num(init.y, 0),
          w: num(init.w, DEFAULTS.stickySize, DEFAULTS.minBox, MAX_SIZE), h: num(init.h, DEFAULTS.stickySize, DEFAULTS.minBox, MAX_SIZE),
          color: color(init.color, DEFAULTS.stickyColor),
          ...(init.pad === true ? { pad: true } : {}),
        },
        text: clampText(init.text ?? ''),
      };
    case 'text':
      return {
        fields: {
          x: num(init.x, 0), y: num(init.y, 0),
          w: num(init.w, DEFAULTS.textW, DEFAULTS.minTextW, MAX_SIZE),
          size: num(init.size, DEFAULTS.textSize, DEFAULTS.minTextSize, DEFAULTS.maxTextSize),
          color: color(init.color, DEFAULTS.textColor),
        },
        text: clampText(init.text ?? ''),
      };
    case 'shape': {
      const fill = splitFill(typeof init.fill === 'string' ? init.fill : '');
      return {
        fields: {
          shape: isShapeKind(init.shape) ? init.shape : 'rect',
          x: num(init.x, 0), y: num(init.y, 0),
          w: num(init.w, DEFAULTS.shapeW, DEFAULTS.minBox, MAX_SIZE), h: num(init.h, DEFAULTS.shapeH, DEFAULTS.minBox, MAX_SIZE),
          fill: color(fill.fill, DEFAULTS.shapeFill), ...(fill.soft ? { soft: true } : {}), stroke: color(init.stroke, DEFAULTS.shapeStroke),
          strokeWidth: num(init.strokeWidth, DEFAULTS.strokeWidth, 0, 24),
        },
        text: clampText(init.text ?? ''),
      };
    }
    case 'connector':
      return {
        fields: {
          from: endpoint(init.from) ?? { x: 0, y: 0 }, to: endpoint(init.to) ?? { x: 0, y: 0 },
          arrow: ARROW_SET.has(init.arrow ?? '') ? init.arrow : 'end',
          route: ROUTE_SET.has(init.route ?? '') ? init.route : 'straight',
          stroke: color(init.stroke, DEFAULTS.connectorStroke), strokeWidth: num(init.strokeWidth, DEFAULTS.strokeWidth, 0, 24),
          label: clampText(init.label ?? ''),
        },
        text: null,
      };
    case 'image':
      return {
        fields: {
          x: num(init.x, 0), y: num(init.y, 0),
          w: num(init.w, DEFAULTS.imageSize, DEFAULTS.minBox, MAX_SIZE), h: num(init.h, DEFAULTS.imageSize, DEFAULTS.minBox, MAX_SIZE),
          src: init.src,
          ...(typeof init.stickerId === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(init.stickerId) ? { stickerId: init.stickerId } : {}),
        },
        text: null,
      };
    case 'ink':
      return {
        fields: {
          x: num(init.x, 0), y: num(init.y, 0),
          w: num(init.w, 1, 1, MAX_SIZE), h: num(init.h, 1, 1, MAX_SIZE),
          points: [...(inkPoints(init.points) ?? [0, 0, 0, 0])],
          stroke: color(init.stroke, DEFAULTS.inkStroke), strokeWidth: num(init.strokeWidth, DEFAULTS.inkWidth, INK_MIN_WIDTH, INK_MAX_WIDTH),
          ...(init.marker === true ? { marker: true } : {}),
          ...(inkErase(init.erase) ? { erase: [...(init.erase ?? [])] } : {}),
        },
        text: null,
      };
    case 'frame':
      return {
        fields: {
          x: num(init.x, 0), y: num(init.y, 0),
          w: num(init.w, DEFAULTS.frameW, DEFAULTS.minFrame, MAX_SIZE), h: num(init.h, DEFAULTS.frameH, DEFAULTS.minFrame, MAX_SIZE),
          title: clampTitle(init.title),
          // A soft tone is how every frame hue is drawn: a `soft:` prefix from a picker is the same hue.
          fill: color(splitFill(typeof init.fill === 'string' ? init.fill : '').fill, DEFAULTS.frameFill),
        },
        text: null,
      };
  }
}

/** Patch value meaning "remove the key" (a default is stored as absence, never as a value). */
const REMOVE = Symbol('remove');

/** What an undo step deleted (yjs does not export the type). */
type DeleteSet = Y.UndoManager['undoStack'][number]['deletions'];

/**
 * Spells a `fontPx` / `fontSize` patch out in stored fields: a text object's `size`; a sticky's or shape's token and exact size
 * (`fontFields`). A plain token write drops the exact size it overrides, so a token set by older code is never shadowed.
 */
function expandFont(kind: ObjectKind, patch: ObjectPatch): ObjectPatch {
  if (kind === 'connector' || kind === 'image' || kind === 'ink' || kind === 'frame') return patch;
  const px = patch.fontPx;
  if (typeof px === 'number' && Number.isFinite(px)) {
    const v = clamp(px, DEFAULTS.minTextSize, DEFAULTS.maxTextSize);
    if (kind === 'text') return { ...patch, size: v };
    const f = fontFields(kind, v);
    return { ...patch, fontSize: f.fontSize ?? 'm', fontPx: f.fontPx ?? null };
  }
  if (kind !== 'text' && 'fontSize' in patch && !('fontPx' in patch)) return { ...patch, fontPx: null };
  return patch;
}

/** Spells a `soft:<hue>` fill out as `fill` + `soft`; a plain fill drops the soft tone. */
function expandFill(kind: ObjectKind, patch: ObjectPatch): ObjectPatch {
  if ((kind !== 'shape' && kind !== 'frame') || typeof patch.fill !== 'string') return patch;
  const f = splitFill(patch.fill);
  // A frame draws every hue soft: the prefix is dropped, not stored.
  if (kind === 'frame') return { ...patch, fill: f.fill };
  return { ...patch, fill: f.fill, soft: f.soft };
}

/** Normalizes a stored field before it is written by a patch; undefined = reject. */
function patchValue(kind: ObjectKind, key: keyof ObjectPatch, v: unknown): unknown {
  switch (key) {
    case 'rot': return typeof v === 'number' && Number.isFinite(v) ? (normRot(v) === 0 ? REMOVE : normRot(v)) : undefined;
    case 'locked': case 'soft': case 'pad': return typeof v === 'boolean' ? (v ? true : REMOVE) : undefined;
    case 'group': return v === null ? REMOVE : isGroupId(v) ? v : undefined;
    case 'fontSize': return isFontToken(v) ? (v === 'm' ? REMOVE : v) : undefined;
    case 'fontPx': return v === null ? REMOVE : typeof v === 'number' && Number.isFinite(v) ? clamp(v, DEFAULTS.minTextSize, DEFAULTS.maxTextSize) : undefined;
    case 'x': case 'y': return typeof v === 'number' && Number.isFinite(v) ? clamp(v, -MAX_COORD, MAX_COORD) : undefined;
    case 'w': return typeof v === 'number' && Number.isFinite(v) ? clamp(v, kind === 'text' ? DEFAULTS.minTextW : kind === 'ink' ? 1 : kind === 'frame' ? DEFAULTS.minFrame : DEFAULTS.minBox, MAX_SIZE) : undefined;
    case 'h': return typeof v === 'number' && Number.isFinite(v) ? clamp(v, kind === 'ink' ? 1 : kind === 'frame' ? DEFAULTS.minFrame : DEFAULTS.minBox, MAX_SIZE) : undefined;
    case 'size': return typeof v === 'number' && Number.isFinite(v) ? clamp(v, DEFAULTS.minTextSize, DEFAULTS.maxTextSize) : undefined;
    case 'strokeWidth': return typeof v === 'number' && Number.isFinite(v) ? (kind === 'ink' ? clamp(v, INK_MIN_WIDTH, INK_MAX_WIDTH) : clamp(v, 0, 24)) : undefined;
    case 'color': case 'fill': case 'stroke': return color(v, '') || undefined;
    case 'shape': return isShapeKind(v) ? v : undefined;
    case 'from': case 'to': return endpoint(v) ?? undefined;
    case 'arrow': return typeof v === 'string' && ARROW_SET.has(v) ? v : undefined;
    case 'route': return typeof v === 'string' && ROUTE_SET.has(v) ? v : undefined;
    case 'label': return typeof v === 'string' ? clampText(v) : undefined;
    case 'erase': return v === null ? REMOVE : inkErase(v) ? [...(v as number[])] : undefined;
    case 'title': return typeof v === 'string' ? clampTitle(v) : undefined;
    case 'link': return v === null ? REMOVE : isLinkUrl(v) ? v : undefined;
  }
}

/** A patch as it would be stored: field → value, `undefined` = the key is removed (a default is stored as absence). */
export type StoredFields = ReadonlyMap<string, unknown>;

/** The fields `patchMany` would write for `raw` on an object of `kind` (only keys valid for it, values normalized). */
export function normalizePatch(kind: ObjectKind, raw: ObjectPatch): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const patch = expandFill(kind, expandFont(kind, raw));
  for (const key of PATCH_KEYS[kind]) {
    if (!(key in patch)) continue;
    const v = patchValue(kind, key, patch[key]);
    if (v === REMOVE) out.set(key, undefined);
    else if (v !== undefined) out.set(key, v);
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

export interface CanvasDocOptions {
  /** Random source for z-key tails and ids (tests). */
  rng?: (() => number) | null;
  makeId?: () => string;
}

/**
 * The canvas document on a Y.Doc (ADR-0126 §3): `objects: Y.Map<id, Y.Map>` with flat fields, `z` a
 * fractional key, text in `Y.Text`, `meta.schema`. All local edits are one transaction each with
 * `LOCAL_ORIGIN`; the UndoManager tracks only that origin, so undo never reverts someone else's edit.
 */
export class CanvasDoc {
  readonly ydoc: Y.Doc;
  readonly objects: Y.Map<Y.Map<unknown>>;
  readonly meta: Y.Map<unknown>;
  /** Gesture previews by client id (lib/canvas/live.ts): outside the undo scope, each entry overwritten in place. */
  readonly live: Y.Map<unknown>;
  readonly undo: Y.UndoManager;
  private readonly rng: (() => number) | null;
  private readonly makeId: () => string;
  private gesture = 0;
  /** The undo step the current gesture opened (null while it has written nothing). */
  private gestureStep: unknown = null;
  private static readonly CAPTURE_MS = 500;
  /** Rough encoded size of an object without its text (measured ≈ 230 bytes for a sticky) and the per-transaction budget. */
  private static readonly OBJECT_BYTES = 260;
  private static readonly CHUNK_BYTES = 40_000;

  /** What a batch adds to the encoded state: the fields of each object, its text in UTF-8 and a stroke's points. */
  private static batchBytes(items: readonly { text: string | null; fields: Record<string, unknown> }[]): number {
    const enc = new TextEncoder();
    let bytes = 0;
    for (const { text, fields } of items) {
      bytes += CanvasDoc.OBJECT_BYTES + (text ? enc.encode(text).length : 0) + (Array.isArray(fields.points) ? fields.points.length * 4 : 0);
    }
    return bytes;
  }

  constructor(ydoc: Y.Doc, opts: CanvasDocOptions = {}) {
    this.ydoc = ydoc;
    this.rng = opts.rng === undefined ? Math.random : opts.rng;
    this.makeId = opts.makeId ?? newId;
    this.objects = ydoc.getMap<Y.Map<unknown>>('objects');
    this.meta = ydoc.getMap<unknown>('meta');
    this.live = ydoc.getMap<unknown>('live');
    this.undo = new Y.UndoManager(this.objects, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: CanvasDoc.CAPTURE_MS });
    this.undo.on('stack-item-added', this.onStepAdded);
    ydoc.on('afterAllTransactions', this.trimUndo);
  }

  private readonly onStepAdded = (e: { stackItem: unknown; origin: unknown; type: 'undo' | 'redo' }): void => {
    if (this.gesture > 0 && e.type === 'undo' && e.origin === LOCAL_ORIGIN) this.gestureStep = e.stackItem;
  };

  /**
   * Keeps at most MAX_UNDO steps. The UndoManager keeps every value a step overwrote, content and all, in the doc (and so
   * in its encoded state) for as long as the step exists; a dropped step lets them go: unkept and collected right away.
   * Runs after the transaction's `update` went out, so it never touches structs being encoded.
   */
  private readonly trimUndo = (): void => {
    const stack = this.undo.undoStack;
    if (stack.length <= MAX_UNDO) return;
    for (const old of stack.splice(0, stack.length - MAX_UNDO)) this.release(old.deletions);
  };

  private release(ds: DeleteSet): void {
    const store = this.ydoc.store;
    ds.clients.forEach((dels, client) => {
      const structs = store.clients.get(client);
      if (!structs) return;
      for (const d of dels) {
        for (let i = Y.findIndexSS(structs, d.clock); i < structs.length; i++) {
          const s = structs[i];
          if (!s || s.id.clock >= d.clock + d.len) break;
          if (s instanceof Y.Item && s.keep && Y.isParentOf(this.objects, s)) s.keep = false;
        }
      }
    });
    if (this.ydoc.gc) Y.tryGc(ds, store, this.ydoc.gcFilter);
  }

  /** Schema stored in the doc (0 = not initialized yet). */
  get schema(): number {
    const v = this.meta.get('schema');
    return typeof v === 'number' ? v : 0;
  }

  /** A doc written by a newer client: open it read-only. */
  get isFuture(): boolean {
    return this.schema > SCHEMA_VERSION;
  }

  /** Writes `meta.schema = 1` into a fresh doc (not undoable). Returns false for a newer schema. */
  ensureSchema(): boolean {
    if (this.isFuture) return false;
    if (this.schema === 0) this.ydoc.transact(() => this.meta.set('schema', SCHEMA_VERSION), 'canvas-init');
    return true;
  }

  get count(): number {
    return this.objects.size;
  }

  get canCreate(): boolean {
    return this.objects.size < MAX_OBJECTS;
  }

  transact<T>(fn: () => T): T {
    let out!: T;
    this.ydoc.transact(() => {
      out = fn();
    }, LOCAL_ORIGIN);
    return out;
  }

  /** The next local change starts a new undo step (discrete commands: delete, paste, create…). */
  checkpoint(): void {
    this.undo.stopCapturing();
  }

  /** One drag = one undo step, however long it pauses. */
  beginGesture(): void {
    if (this.gesture++ > 0) return;
    this.gestureStep = null;
    this.undo.stopCapturing();
    this.undo.captureTimeout = 1e12;
  }

  endGesture(): void {
    if (this.gesture === 0 || --this.gesture > 0) return;
    this.gestureStep = null;
    this.undo.captureTimeout = CanvasDoc.CAPTURE_MS;
    this.undo.stopCapturing();
  }

  /**
   * Ends the gesture and takes back what it wrote. A gesture that wrote nothing undoes nothing: the step on top of the
   * stack is then an earlier action of the user (the sticky just created, a text edit), not this gesture.
   */
  cancelGesture(): void {
    if (this.gesture === 0) return;
    const step = this.gesture === 1 ? this.gestureStep : null;
    this.endGesture();
    if (step !== null && this.undo.undoStack[this.undo.undoStack.length - 1] === step) this.undo.undo();
  }

  /** The undo step on top of the stack (to take back with `undoStep` if nothing came after it). */
  topStep(): unknown {
    return this.undo.undoStack[this.undo.undoStack.length - 1] ?? null;
  }

  /** Undoes `step` if it is still on top of the stack (and drops it from history); false otherwise. */
  undoStep(step: unknown): boolean {
    if (step === null || this.topStep() !== step) return false;
    this.undo.undo();
    this.undo.redoStack.pop();
    return true;
  }

  /** Highest z key currently in the doc. */
  maxZ(): string | null {
    let best: string | null = null;
    for (const m of this.objects.values()) {
      const z = m.get('z');
      if (isValidKey(z) && (best === null || z > best)) best = z;
    }
    return best;
  }

  minZ(): string | null {
    let best: string | null = null;
    for (const m of this.objects.values()) {
      const z = m.get('z');
      if (isValidKey(z) && (best === null || z < best)) best = z;
    }
    return best;
  }

  /**
   * Creates objects on top, in order. All-or-nothing against the object limit and, for a batch above one chunk,
   * against MAX_STATE. Returns the new ids ([] if refused).
   * A big batch is written as several transactions of ≲ CHUNK_BYTES each (one undo step): the sync provider sends a
   * transaction above its 64 KiB frame as a snapshot of the whole document, to everyone — 500 stickies already
   * exceed it — while smaller updates travel as plain UPDATE frames.
   */
  createMany(all: readonly { id?: string; init: ObjectInit }[]): string[] {
    // A picture of anything but the app's own media, or a stroke without sane points, is never written.
    const items = all.filter((i) => (i.init.kind !== 'image' || isImageSrc(i.init.src)) && (i.init.kind !== 'ink' || inkPoints(i.init.points) !== null));
    if (items.length === 0 || this.objects.size + items.length > MAX_OBJECTS) return [];
    const ids: string[] = [];
    let z = this.maxZ();
    const prepared = items.map((item) => ({ item, ...initFields(item.init), extra: extraFields(item.init) }));
    const chunks: (typeof prepared)[] = [];
    let cur: typeof prepared = [];
    let bytes = 0;
    for (const p of prepared) {
      // A stroke's points: ~4 bytes each number (a varint or a float32).
      const est = CanvasDoc.OBJECT_BYTES + (p.text?.length ?? 0) * 3 + (p.item.init.kind === 'ink' ? (p.item.init.points.length + (p.item.init.erase?.length ?? 0)) * 4 : 0);
      if (cur.length > 0 && bytes + est > CanvasDoc.CHUNK_BYTES) {
        chunks.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(p);
      bytes += est;
    }
    chunks.push(cur);
    // Such a batch goes out as UPDATE chunks: past MAX_STATE the server takes about MAX_STATE of them (the socket's
    // byte burst), and the rest — one diff above a frame after the reconnect — is a snapshot never posted, so the
    // others would keep a part of it. The state is measured only for a batch this big.
    if (chunks.length > 1 && Y.encodeStateAsUpdate(this.ydoc).length + CanvasDoc.batchBytes(prepared) > MAX_STATE) return [];
    const write = (chunk: typeof prepared): void => {
      this.transact(() => {
        for (const { item, fields, text, extra } of chunk) {
          let id = item.id ?? this.makeId();
          while (this.objects.has(id)) id = this.makeId();
          z = after(z, this.rng);
          const m = new Y.Map<unknown>();
          this.objects.set(id, m);
          m.set('kind', item.init.kind);
          m.set('z', z);
          for (const [k, v] of Object.entries(fields)) m.set(k, v);
          for (const [k, v] of Object.entries(extra)) m.set(k, v);
          if (text !== null) {
            const yt = new Y.Text();
            const ops = item.init.kind !== 'connector' && item.init.fmt ? fmtToDelta(text, item.init.fmt) : null;
            if (ops) yt.applyDelta(ops);
            else if (text !== '') yt.insert(0, text);
            m.set('text', yt);
          }
          ids.push(id);
        }
      });
    };
    if (chunks.length === 1) write(cur);
    else {
      this.beginGesture();
      try {
        for (const c of chunks) write(c);
      } finally {
        this.endGesture();
      }
    }
    return ids;
  }

  create(init: ObjectInit, id?: string): string | null {
    return this.createMany([id === undefined ? { init } : { id, init }])[0] ?? null;
  }

  /** Applies plain-field patches (only keys valid for the object's kind, only real changes). */
  patchMany(patches: ReadonlyMap<string, ObjectPatch>): void {
    if (patches.size === 0) return;
    this.transact(() => {
      for (const [id, raw] of patches) {
        const m = this.objects.get(id);
        if (!m) continue;
        const kind = m.get('kind');
        if (!isKind(kind)) continue;
        for (const [key, v] of normalizePatch(kind, raw)) {
          if (v === undefined) {
            if (m.has(key)) m.delete(key);
          } else if (!same(m.get(key), v)) m.set(key, v);
        }
      }
    });
  }

  patch(id: string, patch: ObjectPatch): void {
    this.patchMany(new Map([[id, patch]]));
  }

  /** Sets an object's text (Y.Text, minimal diff). Connectors: the label. */
  setText(id: string, text: string): void {
    const m = this.objects.get(id);
    if (!m) return;
    const kind = m.get('kind');
    if (kind === 'connector') {
      this.patch(id, { label: text });
      return;
    }
    if (kind === 'frame') {
      this.patch(id, { title: text });
      return;
    }
    if (kind === 'image' || kind === 'ink') return;
    const next = clampText(text);
    this.transact(() => {
      const cur = m.get('text');
      if (cur instanceof Y.Text) applyTextDiff(cur, next);
      else m.set('text', new Y.Text(next));
    });
  }

  /**
   * Sets an object's text together with its formatting: the text by the same minimal diff as `setText`, then only the
   * attribute ranges that differ (`Y.Text.format`), so the parts nobody touched stay as concurrent editors left them.
   * `text` is plain text (no list terminator); a connector keeps only the plain label.
   */
  setRich(id: string, text: string, fmt: Fmt | undefined, original?: string): void {
    const m = this.objects.get(id);
    if (!m) return;
    if (m.get('kind') === 'connector') {
      this.patch(id, { label: text });
      return;
    }
    if (m.get('kind') === 'frame') {
      this.patch(id, { title: text });
      return;
    }
    if (m.get('kind') === 'image' || m.get('kind') === 'ink') return;
    const next = clampText(text);
    this.transact(() => {
      let yt = m.get('text');
      if (!(yt instanceof Y.Text)) {
        yt = new Y.Text();
        m.set('text', yt);
      }
      if (!(yt instanceof Y.Text)) return;
      applyTextDiff(yt, rawText(next, fmt), original);
      for (const c of formatChanges(yt.toDelta() as never, fmtToDelta(next, fmt))) yt.format(c.index, c.length, c.attrs);
    });
  }

  /** The raw Y.Text content of an object (what `setRich`'s `original` is compared against), '' when none. */
  rawTextOf(id: string): string {
    const t = this.objects.get(id)?.get('text');
    return t instanceof Y.Text ? t.toJSON() : '';
  }

  /** An object's plain text and formatting (the list terminator of the last paragraph is not part of the text). */
  getRich(id: string): { text: string; fmt: Fmt | undefined } {
    const t = this.objects.get(id)?.get('text');
    if (t instanceof Y.Text) return fmtFromDelta(t.toDelta() as never);
    return { text: this.getText(id), fmt: undefined };
  }

  getText(id: string): string {
    const m = this.objects.get(id);
    if (!m) return '';
    const t = m.get('text');
    if (t instanceof Y.Text) {
      const raw = t.toJSON();
      return raw.endsWith('\n') ? fmtFromDelta(t.toDelta() as never).text : raw;
    }
    const label = m.get(m.get('kind') === 'frame' ? 'title' : 'label');
    return typeof label === 'string' ? label : '';
  }

  /**
   * Deletes objects. Connectors that pointed at a deleted object (and are not deleted themselves)
   * keep their end where it was: `pointOf(connectorId, 'from'|'to')` supplies the resolved position.
   */
  remove(ids: Iterable<string>, pointOf?: (connectorId: string, end: 'from' | 'to') => Point | null): void {
    const gone = new Set(ids);
    if (gone.size === 0) return;
    this.transact(() => {
      for (const [id, m] of this.objects) {
        if (gone.has(id) || m.get('kind') !== 'connector') continue;
        for (const end of ['from', 'to'] as const) {
          const e = endpoint(m.get(end));
          if (e && 'id' in e && gone.has(e.id)) m.set(end, pointOf?.(id, end) ?? { x: 0, y: 0 });
        }
      }
      for (const id of gone) this.objects.delete(id);
    });
  }

  /** Reads one object as plain data (null if missing/unknown kind). */
  snapshot(id: string): PlainObject | null {
    const m = this.objects.get(id);
    if (!m) return null;
    const kind = m.get('kind');
    if (!isKind(kind)) return null;
    const z = m.get('z');
    const out: PlainObject = { id, kind, z: isValidKey(z) ? z : '' };
    for (const k of FIELD_KEYS[kind]) {
      const v = m.get(k);
      if (v !== undefined) out[k] = v;
    }
    if (kind !== 'connector' && kind !== 'image' && kind !== 'ink' && kind !== 'frame') {
      const t = m.get('text');
      if (t instanceof Y.Text) {
        const { text, fmt } = fmtFromDelta(t.toDelta() as never);
        out.text = text;
        if (fmt) out.rich = fmtToDelta(text, fmt);
      } else out.text = '';
    }
    return out;
  }

  /** All ids ordered bottom → top (z, then id). */
  orderedIds(): string[] {
    const arr: [string, string][] = [];
    for (const [id, m] of this.objects) {
      const z = m.get('z');
      arr.push([isValidKey(z) ? z : '', id]);
    }
    arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    return arr.map((e) => e[1]);
  }

  private setZ(id: string, z: string): void {
    this.objects.get(id)?.set('z', z);
  }

  /** Moves the ids (keeping their relative order) above everything else. */
  bringToFront(ids: readonly string[]): void {
    const order = this.orderedIds();
    const set = new Set(ids);
    const moving = order.filter((i) => set.has(i));
    if (moving.length === 0) return;
    const rest = order.filter((i) => !set.has(i));
    const top = rest[rest.length - 1];
    if (top !== undefined && order.slice(order.length - moving.length).every((i) => set.has(i))) return;
    this.transact(() => {
      let z = top === undefined ? null : this.zOf(top);
      for (const id of moving) {
        z = after(z, this.rng);
        this.setZ(id, z);
      }
    });
  }

  sendToBack(ids: readonly string[]): void {
    const order = this.orderedIds();
    const set = new Set(ids);
    const moving = order.filter((i) => set.has(i));
    if (moving.length === 0) return;
    const rest = order.filter((i) => !set.has(i));
    if (order.slice(0, moving.length).every((i) => set.has(i))) return;
    this.transact(() => {
      let z = rest[0] === undefined ? null : this.zOf(rest[0]);
      for (let i = moving.length - 1; i >= 0; i--) {
        const id = moving[i];
        if (id === undefined) continue;
        z = before(z, this.rng);
        this.setZ(id, z);
      }
    });
  }

  /** One step up/down among the objects (the selection moves past its neighbour, order inside it kept). */
  step(ids: readonly string[], dir: 1 | -1): void {
    const order = this.orderedIds();
    const set = new Set(ids);
    const moving = order.filter((i) => set.has(i));
    if (moving.length === 0) return;
    // The nearest non-selected neighbour above (dir=1) / below the selection's extreme member.
    const edge = dir > 0 ? order.lastIndexOf(moving[moving.length - 1] ?? '') : order.indexOf(moving[0] ?? '');
    let n = edge + dir;
    while (n >= 0 && n < order.length && set.has(order[n] ?? '')) n += dir;
    const neighbour = order[n];
    if (neighbour === undefined) return;
    const beyond = order[n + dir];
    this.transact(() => {
      const nz = this.zOf(neighbour);
      const bz = beyond === undefined ? null : this.zOf(beyond);
      // Place the moving objects between the neighbour and the next one past it, in their old order.
      const lo = dir > 0 ? nz : bz;
      const hi = dir > 0 ? bz : nz;
      let prev = lo;
      for (const id of moving) {
        prev = prev !== null && hi !== null && prev >= hi ? prev + 'V' : between(prev, hi, this.rng);
        this.setZ(id, prev);
      }
    });
  }

  private zOf(id: string): string {
    const z = this.objects.get(id)?.get('z');
    return isValidKey(z) ? z : '';
  }

  destroy(): void {
    this.ydoc.off('afterAllTransactions', this.trimUndo);
    this.undo.off('stack-item-added', this.onStepAdded);
    this.undo.destroy();
  }
}
