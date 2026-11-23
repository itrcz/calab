import { rectCenter, rectsIntersect, DEG, type Rect } from '../../../lib/canvas/geometry';
import { connectorEndDirection, connectorMidpoint } from '../../../lib/canvas/route';
import { contentRect, STICKY_RADIUS, traceRounded, traceShape } from '../../../lib/canvas/shapes';
import { F_STRIKE, type Fmt } from '../../../lib/canvas/richText';
import { LABEL_SIZE, boxFontSize, fontOf, type TextLayout, type TextLayouter } from '../../../lib/canvas/textLayout';
import { MARKER_ALPHA, isDot, traceInk } from '../../../lib/canvas/ink';
import { visualBounds } from '../../../lib/canvas/scene';
import { FRAME_RADIUS, FRAME_TITLE_GAP, FRAME_TITLE_SIZE, frameTitleRect } from '../../../lib/canvas/frames';
import { MAX_SIZE, type ConnectorRec, type FrameRec, type ImageRec, type InkRec, type ObjectRec, type TextBoxRec } from '../../../lib/canvas/types';
import type { ImageSource } from './images';
import { readableInk, resolveColor, resolveFill, resolveSticky, type CanvasPalette } from './palette';
import type { VoteBadge } from '../../../lib/canvas/votes';
import { drawVoteMark } from './voteDraw';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Below this zoom, glyphs become plaques and strokes lose their details (ADR-0126 §4). */
export const TEXT_PLAQUE_SCALE = 0.25;
/** Glyphs smaller than this on screen (CSS px) become plaques; plain text keeps them down to 25 % anyway. */
const MIN_GLYPH_PX = 4;
/**
 * The same for a rotated box (ADR-0127). Every distinct angle × zoom rasterizes its own glyphs (no shared glyph
 * cache), so a zoom over hundreds of turned notes repainted them at 4–8 px — barely legible — for a 3–4× costlier
 * frame (docs/14-energy.md «Холст, вторая итерация»).
 */
const MIN_ROTATED_GLYPH_PX = 8;

export interface DrawEnv {
  palette: CanvasPalette;
  layouter: TextLayouter;
  /** Camera scale (world → CSS px). */
  scale: number;
  /** Object whose text is being edited in the overlay textarea: its glyphs are not painted. */
  hiddenText: string | null;
  /** Vote badges of the open or finished vote (ADR-0127); absent while there is no vote, so a plain canvas pays nothing. */
  votes?: { badge(id: string): VoteBadge | null } | undefined;
  /** Decoded pictures (ADR-0127, 2026-10-23); absent: every picture is its plaque. */
  images?: ImageSource | undefined;
  /** The world region being painted (set by `drawObjects`): an erased stroke composes only that much of itself. */
  region?: Rect | undefined;
  /** Objects not painted here: lifted into the renderer's drag sprite while they move. */
  skip?: ReadonlySet<string> | undefined;
  /** How far a sticky pad's corner is lifted by the pointer over it (0…1, animated by the engine); absent: 0. */
  padLift?: ((id: string) => number) | undefined;
}

const font = (env: DrawEnv, size: number): string => `${size}px ${env.palette.fontFamily}`;

interface DotTile {
  key: string;
  pattern: CanvasPattern | null;
}
let dotTile: DotTile | null = null;

function makeTileCanvas(px: number): (HTMLCanvasElement | OffscreenCanvas) | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(px, px);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    return c;
  }
  return null;
}

/**
 * The dot grid as a repeating pattern: a handful of dots in a tiny tile, filled with one fillRect. Thousands of
 * per-dot rects cost two orders of magnitude more on a software rasterizer.
 */
function dotPattern(ctx: Ctx2D, color: string, step: number, scale: number, dpr: number): CanvasPattern | null {
  const tile = Math.max(2, Math.round(step * scale * dpr));
  const key = `${color}|${step}|${tile}`;
  if (dotTile?.key === key) return dotTile.pattern;
  let pattern: CanvasPattern | null = null;
  const c = makeTileCanvas(tile);
  const g = c?.getContext('2d');
  if (c && g) {
    g.fillStyle = color;
    const d = Math.max(1, Math.round(1.4 * dpr));
    g.fillRect(0, 0, d, d);
    pattern = ctx.createPattern(c, 'repeat');
    // One tile spans exactly `step` world units, whatever the rounding of its pixel size.
    pattern?.setTransform(new DOMMatrix().scale(step / tile));
  }
  dotTile = { key, pattern };
  return pattern;
}

/** Fills the region with the background and, when zoomed in enough, the dot grid. `r` is in world units. */
export function drawBackground(ctx: Ctx2D, p: CanvasPalette, r: Rect, scale: number, dpr = 1): void {
  ctx.fillStyle = p.background;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (scale < 0.3) return;
  const pattern = dotPattern(ctx, p.grid, scale >= 0.8 ? 24 : 96, scale, dpr);
  if (!pattern) return;
  ctx.fillStyle = pattern;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

export function drawObject(ctx: Ctx2D, o: ObjectRec, env: DrawEnv): void {
  // Sub-pixel objects are not worth a draw call.
  if (o.kind !== 'connector' && o.w * env.scale < 0.6 && o.h * env.scale < 0.6) return;
  if (o.kind !== 'connector' && o.rot) {
    // A rotated box is drawn in its own frame: the context turns about the center, nothing else knows.
    const c = rectCenter(o);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(o.rot * DEG);
    ctx.translate(-c.x, -c.y);
    drawBody(ctx, o, env);
    ctx.restore();
    return;
  }
  drawBody(ctx, o, env);
}

function drawBody(ctx: Ctx2D, o: ObjectRec, env: DrawEnv): void {
  switch (o.kind) {
    case 'sticky':
      drawSticky(ctx, o, env);
      if (env.votes) markVotes(ctx, o, env);
      break;
    case 'text':
      drawText(ctx, o, env);
      break;
    case 'shape':
      drawShape(ctx, o, env);
      if (env.votes) markVotes(ctx, o, env);
      break;
    case 'connector':
      drawConnector(ctx, o, env);
      break;
    case 'image':
      drawPicture(ctx, o, env);
      break;
    case 'ink':
      drawInk(ctx, o, env);
      break;
    case 'frame':
      drawFrame(ctx, o, env);
      break;
  }
}

/**
 * A frame: its board in the hue's soft tone (or none) with a hairline outline, and the title above the top-left corner,
 * cut at the frame's width. Drawn first of all (the scene orders frames below everything), so it never covers content.
 */
function drawFrame(ctx: Ctx2D, o: FrameRec, env: DrawEnv): void {
  const fill = resolveFill(env.palette, o.fill, true);
  const plain = env.scale < TEXT_PLAQUE_SCALE;
  ctx.beginPath();
  if (plain) ctx.rect(o.x, o.y, o.w, o.h);
  else traceRounded(ctx, o, FRAME_RADIUS);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = env.palette.plaque;
  ctx.lineWidth = 1 / env.scale;
  ctx.stroke();
  if (!o.title || env.hiddenText === o.id || FRAME_TITLE_SIZE * env.scale < MIN_GLYPH_PX) return;
  const lay = env.layouter.layout(o.title, FRAME_TITLE_SIZE, MAX_SIZE);
  const r = frameTitleRect(o, lay.widths[0] ?? 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h + FRAME_TITLE_GAP);
  ctx.clip();
  ctx.fillStyle = env.palette.ink;
  ctx.globalAlpha *= 0.72;
  ctx.font = font(env, FRAME_TITLE_SIZE);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(lay.lines[0] ?? o.title, o.x, o.y - FRAME_TITLE_GAP - FRAME_TITLE_SIZE * 0.22);
  ctx.restore();
}

/** A freehand stroke: the smoothed line with round caps and joins; a marker semi-transparent in one pass (no darker overlaps). */
function drawInk(ctx: Ctx2D, o: InkRec, env: DrawEnv): void {
  const color = resolveColor(env.palette, o.stroke) ?? env.palette.ink;
  const width = Math.max(o.strokeWidth, 1 / env.scale);
  if (!o.erase || !strokeErased(ctx, o, color, width, env.region)) strokeInk(ctx, o.points, o.x, o.y, color, width, o.marker === true);
}

let scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } | null = null;

/** The most the eraser's scratch canvas holds per side, device px (1024² ≈ 4 MB); a larger stroke is painted in tiles. */
export const SCRATCH_TILE = 1024;

/** Drops the scratch canvas (a hidden window or a destroyed engine holds nothing); the next erased stroke makes it anew. */
export function releaseScratch(): void {
  if (scratch) {
    scratch.canvas.width = 0;
    scratch.canvas.height = 0;
  }
  scratch = null;
}

/** A shared offscreen canvas of at least `w × h` device px (≤ SCRATCH_TILE, grown, never shrunk), cleared; null where there is none. */
function scratchOf(w: number, h: number): Ctx2D | null {
  if (!scratch || scratch.canvas.width < w || scratch.canvas.height < h) {
    const cw = Math.max(w, scratch?.canvas.width ?? 0);
    const ch = Math.max(h, scratch?.canvas.height ?? 0);
    const c = makeTileCanvas(1);
    if (!c) return null;
    c.width = cw;
    c.height = ch;
    const x = c.getContext('2d');
    if (!x) return null;
    scratch = { canvas: c, ctx: x };
  }
  const x = scratch.ctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.clearRect(0, 0, w, h);
  return x;
}

/**
 * A stroke with eraser swaths: painted opaque into the scratch canvas (only the device box of the stroke inside the
 * painted region, walked in tiles of at most SCRATCH_TILE px so the scratch stays small), the swaths punched out with
 * `destination-out`, the result laid on `ctx` in one pass per tile (a marker's transparency applied once: tiles do
 * not overlap). False when it cannot (no transform or scratch: a test double), so the caller paints the stroke whole.
 */
function strokeErased(ctx: Ctx2D, o: InkRec, color: string, width: number, region: Rect | undefined): boolean {
  const erase = o.erase;
  if (!erase || typeof ctx.getTransform !== 'function') return false;
  const t = ctx.getTransform();
  const pad = width / 2 + 1;
  let box = { x: o.x - pad, y: o.y - pad, w: o.w + 2 * pad, h: o.h + 2 * pad };
  // The region is in world units; the context may be turned (a rotated stroke), so only an unrotated one clips by it.
  if (region && !o.rot) {
    const x0 = Math.max(box.x, region.x);
    const y0 = Math.max(box.y, region.y);
    const x1 = Math.min(box.x + box.w, region.x + region.w);
    const y1 = Math.min(box.y + box.h, region.y + region.h);
    if (x1 <= x0 || y1 <= y0) return true;
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  let dx0 = Infinity;
  let dy0 = Infinity;
  let dx1 = -Infinity;
  let dy1 = -Infinity;
  for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]] as const) {
    const px = t.a * x + t.c * y + t.e;
    const py = t.b * x + t.d * y + t.f;
    dx0 = Math.min(dx0, px);
    dy0 = Math.min(dy0, py);
    dx1 = Math.max(dx1, px);
    dy1 = Math.max(dy1, py);
  }
  dx0 = Math.max(0, Math.floor(dx0));
  dy0 = Math.max(0, Math.floor(dy0));
  dx1 = Math.min(ctx.canvas.width, Math.ceil(dx1));
  dy1 = Math.min(ctx.canvas.height, Math.ceil(dy1));
  if (dx1 <= dx0 || dy1 <= dy0) return true;
  for (let ty = dy0; ty < dy1; ty += SCRATCH_TILE) {
    for (let tx = dx0; tx < dx1; tx += SCRATCH_TILE) {
      const w = Math.min(SCRATCH_TILE, dx1 - tx);
      const h = Math.min(SCRATCH_TILE, dy1 - ty);
      if (!paintErasedTile(ctx, o, erase, t, color, width, tx, ty, w, h)) return false;
    }
  }
  return true;
}

/** One tile (`w × h` device px at `dx0, dy0`) of an erased stroke: paint, punch the swaths out, lay on `ctx`. */
function paintErasedTile(
  ctx: Ctx2D, o: InkRec, erase: readonly number[], t: DOMMatrix, color: string, width: number,
  dx0: number, dy0: number, w: number, h: number,
): boolean {
  const s = scratchOf(w, h);
  if (!s || !scratch) return false;
  s.setTransform(t.a, t.b, t.c, t.d, t.e - dx0, t.f - dy0);
  strokeInk(s, o.points, o.x, o.y, color, width, false);
  s.globalCompositeOperation = 'destination-out';
  s.fillStyle = '#000';
  s.strokeStyle = '#000';
  s.lineCap = 'round';
  for (let i = 0; i + 4 < erase.length; i += 5) {
    const ax = o.x + (erase[i] ?? 0);
    const ay = o.y + (erase[i + 1] ?? 0);
    const bx = o.x + (erase[i + 2] ?? 0);
    const by = o.y + (erase[i + 3] ?? 0);
    const r = erase[i + 4] ?? 0;
    s.beginPath();
    if (ax === bx && ay === by) {
      // A zero-length line has no caps in every engine: a click is a disc.
      s.arc(ax, ay, r, 0, Math.PI * 2);
      s.fill();
    } else {
      s.lineWidth = 2 * r;
      s.moveTo(ax, ay);
      s.lineTo(bx, by);
      s.stroke();
    }
  }
  s.globalCompositeOperation = 'source-over';
  s.lineCap = 'butt';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (o.marker) ctx.globalAlpha *= MARKER_ALPHA;
  ctx.drawImage(scratch.canvas, 0, 0, w, h, dx0, dy0, w, h);
  ctx.restore();
  return true;
}

/** Paints a stroke's points (relative to `ox, oy`); shared by the stored strokes and the live preview. */
export function strokeInk(ctx: Ctx2D, pts: readonly number[], ox: number, oy: number, color: string, width: number, marker: boolean): void {
  if (pts.length < 2) return;
  const alpha = ctx.globalAlpha;
  if (marker) ctx.globalAlpha = alpha * MARKER_ALPHA;
  if (isDot(pts)) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ox + (pts[0] ?? 0), oy + (pts[1] ?? 0), width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceInk(ctx, pts, ox, oy);
    ctx.stroke();
    // The other painters never set caps: leave the default behind.
    ctx.lineCap = 'butt';
  }
  ctx.globalAlpha = alpha;
}

/**
 * A picture: the decoded still scaled into its frame (aspect kept by the frame itself), or a plaque while it loads,
 * when it failed, on the public page without access, and below the plaque zoom.
 */
function drawPicture(ctx: Ctx2D, o: ImageRec, env: DrawEnv): void {
  const img = env.scale >= TEXT_PLAQUE_SCALE * 0.5 ? (env.images?.get(o.src) ?? null) : null;
  if (img) {
    ctx.drawImage(img, o.x, o.y, o.w, o.h);
    return;
  }
  ctx.fillStyle = env.palette.plaque;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.5;
  if (env.scale < TEXT_PLAQUE_SCALE) ctx.fillRect(o.x, o.y, o.w, o.h);
  else {
    ctx.beginPath();
    traceRounded(ctx, o, Math.min(12, o.w / 8, o.h / 8));
    ctx.fill();
  }
  ctx.globalAlpha = alpha;
}

function markVotes(ctx: Ctx2D, o: TextBoxRec, env: DrawEnv): void {
  const b = env.votes?.badge(o.id);
  if (b) drawVoteMark(ctx, o, b, env);
}

interface Laid {
  text: string;
  fmt: Fmt | undefined;
  size: number;
  w: number;
  lay: TextLayout;
}
/** Layout per record: records are immutable, so a repaint of unchanged text skips even the cache's key building. */
const laidOut = new WeakMap<object, Laid>();

function layoutFor(owner: object, env: DrawEnv, text: string, fmt: Fmt | undefined, size: number, w: number): TextLayout {
  const hit = laidOut.get(owner);
  if (hit && hit.text === text && hit.fmt === fmt && hit.size === size && hit.w === w) return hit.lay;
  const lay = fmt ? env.layouter.layoutRich(text, fmt, size, w) : env.layouter.layout(text, size, w);
  laidOut.set(owner, { text, fmt, size, w, lay });
  return lay;
}

/** How strongly a plaque shows its text color. */
const PLAQUE_ALPHA = 0.4;

/** Where a link's underline sits under the glyph top, in text sizes. */
const UNDERLINE_AT = 1.02;

/** Paints glyphs, or plaques when the zoom is too small to read them; `underline`: the object is a link. */
function drawLines(ctx: Ctx2D, env: DrawEnv, owner: object, text: string, fmt: Fmt | undefined, size: number, box: Rect, fg: string, align: 'left' | 'center', vcenter: boolean, underline = false): void {
  if (text === '' || box.w <= 0) return;
  const lay = layoutFor(owner, env, text, fmt, size, box.w);
  const top = vcenter ? box.y + Math.max(0, (box.h - lay.height) / 2) : box.y;
  const bottom = box.y + box.h + lay.lineHeight * 0.5;
  const minPx = (owner as { rot?: number }).rot ? MIN_ROTATED_GLYPH_PX : MIN_GLYPH_PX;
  if (env.scale < TEXT_PLAQUE_SCALE || size * env.scale < minPx) {
    // The text's own (readable) color, faded: a theme-wide light plaque reads as white text on a light card.
    ctx.fillStyle = fg;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * PLAQUE_ALPHA;
    if (env.scale < 0.15) {
      // Lines are ~2 px tall here: one block per text.
      const w = Math.max(...lay.widths);
      if (w > 0) ctx.fillRect(align === 'center' ? box.x + (box.w - w) / 2 : box.x, top, w, Math.min(lay.height, box.h) * 0.6);
      ctx.globalAlpha = alpha;
      return;
    }
    const bar = lay.lineHeight * 0.45;
    for (let i = 0; i < lay.lines.length; i++) {
      const y = top + i * lay.lineHeight + (lay.lineHeight - bar) / 2;
      if (y > bottom) break;
      const w = lay.widths[i] ?? 0;
      if (w <= 0) continue;
      ctx.fillRect(align === 'center' ? box.x + (box.w - w) / 2 : box.x, y, w, bar);
    }
    ctx.globalAlpha = alpha;
    return;
  }
  ctx.font = font(env, size);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'top';
  if (lay.segs) {
    drawRich(ctx, env, lay, size, box, align, top, bottom, underline);
    return;
  }
  ctx.textAlign = align;
  const x = align === 'center' ? box.x + box.w / 2 : box.x;
  const bar = Math.max(size / 16, 1 / env.scale);
  for (let i = 0; i < lay.lines.length; i++) {
    const y = top + i * lay.lineHeight;
    if (y + lay.lineHeight > bottom) break;
    const line = lay.lines[i];
    if (!line) continue;
    const ty = y + (lay.lineHeight - size) / 2;
    ctx.fillText(line, x, ty);
    if (underline) {
      const w = lay.widths[i] ?? 0;
      ctx.fillRect(align === 'center' ? x - w / 2 : x, ty + size * UNDERLINE_AT, w, bar);
    }
  }
}

/** Formatted lines: each piece in its own font, strike-through as a bar, list markers in the regular font. */
function drawRich(ctx: Ctx2D, env: DrawEnv, lay: TextLayout, size: number, box: Rect, align: 'left' | 'center', top: number, bottom: number, underline: boolean): void {
  ctx.textAlign = 'left';
  let current = -1;
  const setFont = (f: number): void => {
    if (f === current) return;
    current = f;
    ctx.font = fontOf(size, env.palette.fontFamily, f);
  };
  const bar = Math.max(size / 16, 1 / env.scale);
  for (let i = 0; i < lay.lines.length; i++) {
    const y = top + i * lay.lineHeight;
    if (y + lay.lineHeight > bottom) break;
    const ty = y + (lay.lineHeight - size) / 2;
    const left = align === 'center' ? box.x + Math.max(0, (box.w - (lay.widths[i] ?? 0)) / 2) : box.x;
    const mark = lay.marks?.[i];
    if (mark) {
      setFont(0);
      ctx.fillText(mark, left, ty);
    }
    for (const seg of lay.segs?.[i] ?? []) {
      setFont(seg.f);
      ctx.fillText(seg.text, left + seg.x, ty);
      if (seg.f & F_STRIKE) ctx.fillRect(left + seg.x, ty + size * 0.56, seg.w, bar);
      if (underline) ctx.fillRect(left + seg.x, ty + size * UNDERLINE_AT, seg.w, bar);
    }
  }
}

/** The stack band at the bottom of a sticky pad, world units: a share of its height, within bounds. */
export const padBand = (h: number): number => Math.min(14, Math.max(6, h * 0.07));

function drawSticky(ctx: Ctx2D, o: TextBoxRec & { kind: 'sticky' }, env: DrawEnv): void {
  const c = resolveSticky(env.palette, o.color);
  ctx.fillStyle = c.bg;
  const plain = env.scale < TEXT_PLAQUE_SCALE;
  if (plain) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  } else {
    ctx.beginPath();
    traceRounded(ctx, o, STICKY_RADIUS);
    ctx.fill();
  }
  // A pad (a stack to tear sheets off): the edges of the sheets under the top one as a darker band at the bottom, and
  // the top sheet's bottom-right corner curled up, the next sheet showing under it. All inside the sticky's frame, so
  // its bounds and repaints stay those of a sticky.
  const band = o.pad ? padBand(o.h) : 0;
  if (band > 0 && !plain) {
    const a = ctx.globalAlpha;
    const top = o.y + o.h - band;
    // The pointer over the pad lifts the corner (eased by the engine): an invitation to tear a sheet off.
    const lift = env.padLift?.(o.id) ?? 0;
    const curl = Math.min(o.w, o.h - band) * (0.16 + 0.2 * lift);
    const right = o.x + o.w;
    ctx.save();
    ctx.beginPath();
    traceRounded(ctx, o, STICKY_RADIUS);
    ctx.clip();
    ctx.fillStyle = '#000000';
    // The sheet edges: two darker stripes.
    ctx.globalAlpha = a * 0.16;
    ctx.fillRect(o.x, top, o.w, band);
    ctx.globalAlpha = a * 0.12;
    ctx.fillRect(o.x, top + band / 2, o.w, band / 2);
    // Under the curl: the next sheet.
    ctx.globalAlpha = a * 0.16;
    ctx.beginPath();
    ctx.moveTo(right, top - curl);
    ctx.lineTo(right, top);
    ctx.lineTo(right - curl, top);
    ctx.closePath();
    ctx.fill();
    // The curled flap: the sheet's back, lighter, with a soft shadow along its fold.
    ctx.globalAlpha = a;
    ctx.fillStyle = c.bg;
    ctx.beginPath();
    ctx.moveTo(right, top - curl);
    ctx.quadraticCurveTo(right - curl * 0.55, top - curl * 0.55, right - curl, top);
    ctx.lineTo(right - curl * 0.92, top - curl * 0.92);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = a * 0.28;
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.globalAlpha = a * 0.18;
    ctx.lineWidth = Math.max(1 / env.scale, curl * 0.04);
    ctx.beginPath();
    ctx.moveTo(right, top - curl);
    ctx.quadraticCurveTo(right - curl * 0.55, top - curl * 0.55, right - curl, top);
    ctx.stroke();
    ctx.restore();
  }
  // Centred both ways, as in Miro (owner 30.10); the lines wrap at the sticky's width.
  if (env.hiddenText !== o.id) drawLines(ctx, env, o, o.text, o.fmt, boxFontSize(o), contentRect(band > 0 ? { ...o, h: o.h - band } : o), c.fg, 'center', true, o.link !== undefined);
}

function drawText(ctx: Ctx2D, o: TextBoxRec & { kind: 'text' }, env: DrawEnv): void {
  if (env.hiddenText === o.id) return;
  drawLines(ctx, env, o, o.text, o.fmt, o.size, contentRect(o), resolveColor(env.palette, o.color) ?? env.palette.ink, 'left', false, o.link !== undefined);
}

function drawShape(ctx: Ctx2D, o: TextBoxRec & { kind: 'shape' }, env: DrawEnv): void {
  const fill = resolveFill(env.palette, o.fill, o.soft);
  const stroke = resolveColor(env.palette, o.stroke);
  ctx.beginPath();
  traceShape(ctx, o.shape, o);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke && o.strokeWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(o.strokeWidth, 1 / env.scale);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  if (env.hiddenText !== o.id) {
    const ink = resolveColor(env.palette, 'text') ?? env.palette.ink;
    drawLines(ctx, env, o, o.text, o.fmt, boxFontSize(o), contentRect(o), fill && o.text ? readableInk(fill, ink) : ink, 'center', true, o.link !== undefined);
  }
}

function drawConnector(ctx: Ctx2D, o: ConnectorRec, env: DrawEnv): void {
  const pts = o.points;
  if (pts.length < 4) return;
  const stroke = resolveColor(env.palette, o.stroke) ?? env.palette.ink;
  const lw = Math.max(o.strokeWidth, 1 / env.scale);
  const detail = env.scale >= TEXT_PLAQUE_SCALE;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.lineJoin = detail ? 'round' : 'miter';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(pts[0] ?? 0, pts[1] ?? 0);
  const c = o.curve;
  // A curve is drawn as the exact cubic (the flattened `points` serve hit tests and bounds).
  if (c && c.length === 4) ctx.bezierCurveTo(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0, pts[pts.length - 2] ?? 0, pts[pts.length - 1] ?? 0);
  else for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] ?? 0, pts[i + 1] ?? 0);
  ctx.stroke();
  if (!detail) return;
  const head = 8 + o.strokeWidth * 2;
  if (o.arrow !== 'none') drawArrowHead(ctx, pts[pts.length - 2] ?? 0, pts[pts.length - 1] ?? 0, connectorEndDirection(o, true), head, stroke);
  if (o.arrow === 'both') drawArrowHead(ctx, pts[0] ?? 0, pts[1] ?? 0, connectorEndDirection(o, false), head, stroke);
  if (o.label) {
    const m = connectorMidpoint(o);
    const lay = env.layouter.layout(o.label, LABEL_SIZE, 160);
    // A pixel of slack: re-laid at exactly its measured width, the last glyph could wrap onto a line that is cut off.
    const w = Math.ceil(Math.max(...lay.widths, 0)) + 1 + 12;
    const h = lay.height + 6;
    ctx.fillStyle = env.palette.labelBg;
    ctx.beginPath();
    traceRounded(ctx, { x: m.x - w / 2, y: m.y - h / 2, w, h }, 6);
    ctx.fill();
    drawLines(ctx, env, o, o.label, undefined, LABEL_SIZE, { x: m.x - w / 2 + 6, y: m.y - h / 2 + 3, w: w - 12, h: h - 6 }, env.palette.ink, 'center', false);
  }
}

function drawArrowHead(ctx: Ctx2D, x: number, y: number, d: { x: number; y: number }, size: number, color: string): void {
  const nx = -d.y;
  const ny = d.x;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - d.x * size + nx * size * 0.45, y - d.y * size + ny * size * 0.45);
  ctx.lineTo(x - d.x * size - nx * size * 0.45, y - d.y * size - ny * size * 0.45);
  ctx.closePath();
  ctx.fill();
}

/** Draws `objects` (already z-sorted) that touch `region`. */
export function drawObjects(ctx: Ctx2D, objects: readonly ObjectRec[], region: Rect, env: DrawEnv): void {
  const e = env.region === region ? env : { ...env, region };
  // By what is painted (a wide marker's or a thick outline's edge is outside the frame), or a repaint beside the line
  // would wipe that edge with the background.
  for (const o of objects) if (!e.skip?.has(o.id) && (o.kind === 'connector' || rectsIntersect(visualBounds(o), region))) drawObject(ctx, o, e);
}
