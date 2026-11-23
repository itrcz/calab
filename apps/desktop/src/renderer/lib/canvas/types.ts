import { rotatedBounds, type Rect } from './geometry';
import type { Fmt } from './richText';
import type { FontToken } from './textLayout';

/** Document schema this build reads and writes (ADR-0126 §3). Newer docs open read-only. */
export const SCHEMA_VERSION = 1;
export const MAX_OBJECTS = 5000;
export const MAX_TEXT = 5000;
export const MAX_COORD = 1e7;
export const MAX_SIZE = 1e5;
/** Largest snapshot state of a canvas (ADR-0126 §3): the sync never posts a bigger one. */
export const MAX_STATE = 4 * 1024 * 1024;
/** Longest frame title (ADR-0127 addendum 2026-10-30): a name, not a text. */
export const MAX_TITLE = 120;

export type ObjectKind = 'sticky' | 'text' | 'shape' | 'connector' | 'image' | 'ink' | 'frame';
export type ShapeKind =
  | 'rect' | 'ellipse' | 'diamond' | 'triangle' | 'rounded'
  | 'star' | 'hexagon' | 'parallelogram' | 'arrow' | 'bubble' | 'cylinder';
/** A kind written by a newer build is not in this list: the reader draws it as `rect` (ADR-0127). */
export const SHAPE_KINDS: readonly ShapeKind[] = [
  'rect', 'ellipse', 'diamond', 'triangle', 'rounded', 'star', 'hexagon', 'parallelogram', 'arrow', 'bubble', 'cylinder',
];
export type Side = 'auto' | 'top' | 'right' | 'bottom' | 'left';
export type Arrow = 'none' | 'end' | 'both';
/** A route written by a newer build reads as `straight` (ADR-0127); `curve` is read as straight by builds before 2026-10-23. */
export type RouteKind = 'straight' | 'elbow' | 'curve';

/** Connector end: glued to a side of an object, or free in the world. */
export type Endpoint = { id: string; side: Side } | { x: number; y: number };

export const isBound = (e: Endpoint): e is { id: string; side: Side } => 'id' in e;

/** Colors are palette token names (or a #hex literal); the palette decides how they look per theme. */
export interface BaseRec {
  readonly id: string;
  readonly z: string;
  /** Bounds in world units (connectors: bounds of the routed path). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /**
   * Clockwise rotation about the frame's center, degrees (0, 360). Absent = 0; boxes only — a connector never
   * rotates. `x, y, w, h` stay the unrotated frame (ADR-0127).
   */
  readonly rot?: number;
  /** Cannot be moved, resized, rotated or edited; still selectable and deletable (ADR-0127). */
  readonly locked?: boolean;
  /** Id of the flat group this object belongs to; set only while the group still has two or more members (ADR-0127). */
  readonly group?: string;
}

/** Text formatting (bold / italic / strike, lists): absent for plain text (ADR-0127). */
export interface RichFields {
  readonly fmt?: Fmt;
  /**
   * A web link the object opens (owner 23.11, a pasted URL): http(s) only, ≤ MAX_LINK. ⌘/Ctrl+click or «Открыть ссылку»
   * opens it in the browser; the text is underlined. Builds before it ignore the field (plain text).
   */
  readonly link?: string;
}

/** The longest stored link. */
export const MAX_LINK = 2048;

/** A link an object may carry: an absolute http(s) URL without spaces or control characters. */
export function isLinkUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_LINK || !/^https?:\/\/\S+$/i.test(v)) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** A pasted text that is one web link and nothing else (surrounding spaces aside). */
export function pastedLink(text: string): string | null {
  const t = text.trim();
  return isLinkUrl(t) ? t : null;
}

export interface StickyRec extends BaseRec, RichFields {
  readonly kind: 'sticky';
  readonly color: string;
  readonly text: string;
  /** Text size token; absent = M (ADR-0127). */
  readonly fontSize?: FontToken;
  /** Exact text size in px when it is not a preset's (ADR-0127): wins over `fontSize` (kept as the nearest token). */
  readonly fontPx?: number;
  /** A pad (owner 30.10, Miro-style): drawn as a stack; dragging it pulls a new sticky of its colour, Alt-drag moves it. */
  readonly pad?: boolean;
}

export interface TextRec extends BaseRec, RichFields {
  readonly kind: 'text';
  readonly size: number;
  readonly color: string;
  readonly text: string;
}

export interface ShapeRec extends BaseRec, RichFields {
  readonly kind: 'shape';
  /** Text size token; absent = M (ADR-0127). */
  readonly fontSize?: FontToken;
  /** Exact text size in px when it is not a preset's (ADR-0127): wins over `fontSize` (kept as the nearest token). */
  readonly fontPx?: number;
  readonly shape: ShapeKind;
  readonly fill: string;
  /** The fill's soft tone (ADR-0127 addendum 2026-10-29): `fill` stays a plain hue, so an older build draws that hue. */
  readonly soft?: boolean;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly text: string;
}

export interface ConnectorRec extends BaseRec {
  readonly kind: 'connector';
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly arrow: Arrow;
  readonly route: RouteKind;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly label: string;
  /**
   * Routed path, flat [x0, y0, x1, y1, …]. A `curve` is flattened into it (hit tests, bounds, the mini-map use the
   * polyline); the exact Bézier is in `curve`.
   */
  readonly points: readonly number[];
  /** Control points of a `curve` route, [c1x, c1y, c2x, c2y] (derived, never stored): the path is drawn as this cubic. */
  readonly curve?: readonly number[];
}

/**
 * A picture on the board (ADR-0127, 2026-10-23): a sticker from a workspace pack. `src` is an API media path
 * (`/api/files/{id}` or a built-in sticker), loaded with the app's auth; no text, no fill or stroke. Builds before
 * it skip the kind (unknown kinds are not read).
 */
export interface ImageRec extends BaseRec {
  readonly kind: 'image';
  readonly src: string;
  /** The sticker it came from (informational). */
  readonly stickerId?: string;
}

/**
 * A freehand stroke (ADR-0127 addendum 2026-10-29): pen or marker. The doc stores `points` relative to the frame's corner
 * as drawn; a resized frame stretches them (lib/canvas/ink.ts `fitInk`). Builds before it skip the kind.
 */
export interface InkRec extends BaseRec {
  readonly kind: 'ink';
  /** Center line fitted to the frame, flat [x0, y0, …] relative to `x, y` (derived from the stored points and `w × h`). */
  readonly points: readonly number[];
  readonly stroke: string;
  readonly strokeWidth: number;
  /** A highlighter: drawn semi-transparent (`MARKER_ALPHA`). */
  readonly marker?: boolean;
  /** What the eraser took: swaths [x0, y0, x1, y1, r, …] relative to `x, y`, fitted like `points`; cut out when drawn. */
  readonly erase?: readonly number[];
}

/**
 * A frame (ADR-0127 addendum 2026-10-30): a titled board behind other objects. It is a background — always drawn below
 * every other kind and picked last — and never rotates. What it holds is computed, not stored: the objects whose center
 * lies inside it (`Scene.frameMembers`); moving the frame moves them. Builds before it skip the kind.
 */
export interface FrameRec extends BaseRec {
  readonly kind: 'frame';
  /** Plain short name (≤ MAX_TITLE), shown above the top-left corner; '' = untitled. */
  readonly title: string;
  /** A hue drawn as its soft tone, or 'none' (outline only). */
  readonly fill: string;
}

export type ObjectRec = StickyRec | TextRec | ShapeRec | ConnectorRec | ImageRec | InkRec | FrameRec;
export type BoxRec = StickyRec | TextRec | ShapeRec | ImageRec | InkRec | FrameRec;
/** Boxes that carry text (everything but a picture). */
export type TextBoxRec = StickyRec | TextRec | ShapeRec;

export const hasText = (o: ObjectRec): o is TextBoxRec => o.kind === 'sticky' || o.kind === 'text' || o.kind === 'shape';

const IMAGE_SRC = /^(\/api\/files\/[0-9A-Za-z-]{1,64}|\/api\/stickers\/builtin\/[0-9A-Za-z-]{1,64}\.webp)$/;
/** Only the app's own media paths: the loader adds the auth header, so a picture never points anywhere else. */
export const isImageSrc = (v: unknown): v is string => typeof v === 'string' && IMAGE_SRC.test(v);

export const isConnector = (o: ObjectRec): o is ConnectorRec => o.kind === 'connector';
export const isFrame = (o: ObjectRec): o is FrameRec => o.kind === 'frame';
export const isBox = (o: ObjectRec): o is BoxRec => o.kind !== 'connector';

export const recBounds = (o: BaseRec): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h });

/** Rotation of a record in degrees (0 when absent and for connectors). */
export const rotOf = (o: ObjectRec): number => (o.kind === 'connector' || o.kind === 'frame' ? 0 : (o.rot ?? 0));

/** Circumscribed axis-aligned rect: where the object lies on the world axes (a rotated box's frame is wider than itself). */
export const aabb = (o: ObjectRec): Rect => (o.kind === 'connector' || !o.rot ? o : rotatedBounds(o, o.rot));

/** Defaults and limits shared by the model and the tools. */
export const DEFAULTS = {
  stickySize: 160,
  shapeW: 160,
  shapeH: 100,
  textW: 240,
  textSize: 20,
  minBox: 24,
  minTextW: 40,
  minTextSize: 8,
  maxTextSize: 200,
  strokeWidth: 2,
  stickyColor: 'yellow',
  textColor: 'text',
  shapeFill: 'none',
  shapeStroke: 'stroke',
  connectorStroke: 'stroke',
  /** Long side of a new picture (stickers are 512 px squares). */
  imageSize: 200,
  /** The long side of a picture pasted or dropped from outside, at most (its own pixel size below that). */
  pastedImageMax: 480,
  inkStroke: 'stroke',
  inkWidth: 4,
  /** A new frame: 16:9 at a size that holds a row of stickies. */
  frameW: 960,
  frameH: 540,
  frameFill: 'white',
  minFrame: 80,
} as const;

/** A fill as the pickers and templates write it: `soft:<hue>` is the hue's soft tone. */
export const SOFT_PREFIX = 'soft:';
export function splitFill(fill: string): { fill: string; soft: boolean } {
  return fill.startsWith(SOFT_PREFIX) ? { fill: fill.slice(SOFT_PREFIX.length), soft: true } : { fill, soft: false };
}

/** Transform fields any creation call may carry (copy / paste keep them; `rot` is ignored for connectors). */
export interface InitExtras {
  rot?: number;
  locked?: boolean;
  group?: string;
  /** Formatting of the object's text (`text` is the plain text it applies to). */
  fmt?: Fmt;
  /** Text size token of a sticky or shape (ignored by the others). */
  fontSize?: FontToken;
  /** Exact text size in px of a sticky or shape; wins over `fontSize`. */
  fontPx?: number;
  /** A web link of a sticky, text or shape (`isLinkUrl`; ignored by the others). */
  link?: string;
}

/** Fields a creation call may set (kind-specific; unknown ones are ignored). */
export type ObjectInit = InitExtras & (
  | { kind: 'sticky'; x: number; y: number; w?: number; h?: number; color?: string; text?: string; pad?: boolean }
  | { kind: 'text'; x: number; y: number; w?: number; size?: number; color?: string; text?: string }
  | { kind: 'shape'; shape?: ShapeKind; x: number; y: number; w?: number; h?: number; fill?: string; stroke?: string; strokeWidth?: number; text?: string }
  | { kind: 'connector'; from: Endpoint; to: Endpoint; arrow?: Arrow; route?: RouteKind; stroke?: string; strokeWidth?: number; label?: string }
  | { kind: 'image'; x: number; y: number; w?: number; h?: number; src: string; stickerId?: string }
  | { kind: 'ink'; x: number; y: number; w?: number; h?: number; points: readonly number[]; stroke?: string; strokeWidth?: number; marker?: boolean; erase?: readonly number[] }
  | { kind: 'frame'; x: number; y: number; w?: number; h?: number; title?: string; fill?: string }
);

/** Patch of plain (non-text) fields; applied only to the keys valid for the object's kind. */
export interface ObjectPatch {
  /** Degrees; 0 removes the field. Ignored for connectors. */
  rot?: number;
  /** false removes the field. */
  locked?: boolean;
  /** null removes the field. */
  group?: string | null;
  /** Text size token of a sticky or shape; 'm' removes the field. A plain token also drops an exact `fontPx`. */
  fontSize?: FontToken;
  /**
   * Text size in px of any text-bearing kind (a text object's `size`; a sticky's or shape's token + exact size, see `fontFields`).
   * `null` removes a sticky's or shape's exact size.
   */
  fontPx?: number | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
  size?: number;
  shape?: ShapeKind;
  /** A hue, or `soft:<hue>` for its soft tone (stored as `fill` + `soft`). */
  fill?: string;
  /** The fill's soft tone; false removes it (a `fill` patch sets it from its prefix). */
  soft?: boolean;
  /** A sticky pad; false removes it. */
  pad?: boolean;
  /** The web link of a sticky, text or shape (`isLinkUrl`); null removes it. */
  link?: string | null;
  stroke?: string;
  strokeWidth?: number;
  from?: Endpoint;
  to?: Endpoint;
  arrow?: Arrow;
  route?: RouteKind;
  label?: string;
  /** A stroke's eraser swaths (same frame as its stored points); null removes them. */
  erase?: readonly number[] | null;
  /** A frame's name. */
  title?: string;
}
