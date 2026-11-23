import { DEG, HANDLE_IDS, handlePoint, rectCenter, type Point, type Rect } from '../../../lib/canvas/geometry';
import type { Guide } from '../../../lib/canvas/snap';
import { traceRounded } from '../../../lib/canvas/shapes';
import type { ConcreteSide } from '../../../lib/canvas/route';
import type { ConnectorRec } from '../../../lib/canvas/types';
import { strokeInk, type Ctx2D } from './draw';
import { resolveColor, type CanvasPalette } from './palette';
import { OPPOSITE, QUICK_HIT_PX, QUICK_OFFSET_PX, edgeMid, quickDot } from './quick';

export const HANDLE_PX = 8;
/** The phone's handles: drawn a little larger, hit from a 44 px zone (radius `TOUCH_HIT_PX`), the rotation handle hung further out. */
export const TOUCH_HANDLE_PX = 14;
export const TOUCH_ROTATE_OFFSET_PX = 40;
export const TOUCH_HIT_PX = 22;
/** The rotation handle hangs this many screen px above the top side of the frame. */
export const ROTATE_OFFSET_PX = 26;

/** An outline of a (possibly rotated) box: its unrotated frame and the angle. */
export interface Outline {
  rect: Rect;
  rot: number;
}

/**
 * The selection frame: the single box's own (rotated) frame, or the circumscribed rect of several. `resize` shows
 * the eight handles, `rotate` the rotation handle; both off (locked objects, a group's resize) leaves just the frame.
 */
export interface SelFrame {
  rect: Rect;
  rot: number;
  resize: boolean;
  rotate: boolean;
  /** A lone text sizes by width only: no top / bottom handles. */
  widthOnly?: boolean;
  /** Only the corner handles: a picture resizes keeping its aspect ratio. */
  cornersOnly?: boolean;
}

/** The freehand stroke in progress: world points and the pen it is drawn with (a palette token). */
export interface InkPreview {
  points: readonly number[];
  color: string;
  width: number;
  marker: boolean;
}

/** Transient, per-gesture decoration drawn over the content layer (never part of the document). */
export interface OverlayState {
  /** Outlines of selected boxes. */
  outlines: readonly Outline[];
  /** Selected connectors: highlighted path + end handles. */
  connectors: readonly ConnectorRec[];
  /** Selection frame with its handles; null when no box is selected. */
  group: SelFrame | null;
  marquee: Rect | null;
  guides: readonly Guide[];
  /** Angle badge hung by the cursor while turning: world point + whole degrees (one box: its angle, several: the turn). */
  angle: { at: Point; deg: number } | null;
  /** Rubber band while placing a new object. */
  ghost: Rect | null;
  /** Connector being drawn / retargeted: polyline in world units. */
  wire: readonly number[] | null;
  /** Glue target under the cursor while wiring: rect + its four anchors. */
  /** Touch editing: larger handles. */
  touch?: boolean;
  glue: { rect: Rect; /** Rotation of the glue target. */ rot?: number; anchors: readonly Point[]; active: Point | null } | null;
  /** The pen's stroke while it is drawn (written to the document on release). */
  ink?: InkPreview | null;
  /** «Continue» dots beside one selected sticky / shape (engine/quick.ts); `hot`: the hovered one with its preview. */
  quick?: QuickOverlay | null;
  /** The address of the hovered link (a click opens it): a pill under the object's bottom-left corner. */
  link?: { at: Point; text: string } | null;
}

/** The source frame and its sides (dots placed at draw time, so they keep their screen distance at any zoom). */
export interface QuickOverlay {
  rect: Rect;
  sides: readonly ConcreteSide[];
  /** `t`: 0…1, the hover animation's progress. */
  hot: { side: ConcreteSide; ghost: Rect; t: number } | null;
}

export const emptyOverlay = (): OverlayState => ({ outlines: [], connectors: [], group: null, marquee: null, guides: [], angle: null, ghost: null, wire: null, glue: null });

export const overlayIsEmpty = (o: OverlayState): boolean =>
  o.outlines.length === 0 && o.connectors.length === 0 && !o.group && !o.marquee && o.guides.length === 0 && !o.angle && !o.ghost && !o.wire && !o.glue && !o.ink && !o.quick && !o.link;

/** Screen px every overlay box is padded by: handles, the rotate knob above a frame, the «continue» dots, line widths. */
const OVERLAY_PAD_PX = TOUCH_ROTATE_OFFSET_PX + TOUCH_HANDLE_PX + QUICK_HIT_PX + 6;
/** Room the angle pill takes down-right of its point (screen px), whatever its text. */
const ANGLE_BOX_PX = { w: 14 + 72, h: 14 + 24 };
/** The link pill: at most this wide (screen px), its text cut with an ellipsis; hung this far under the object. */
const LINK_MAX_PX = 360;
const LINK_GAP_PX = 6;
const LINK_H_PX = 22;

/**
 * The world rect everything `drawOverlay` paints lies in (padded for handles, knobs and dots), or null for an empty
 * overlay. The renderer composites only what changed: the old and the new overlay box plus the changed content — a
 * dragged sticky no longer re-composites the whole screen every frame. Errs on the large side; must never be smaller.
 */
export function overlayBounds(o: OverlayState, scale: number): Rect | null {
  const px = 1 / scale;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number, w = 0, h = 0): void => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w;
    if (y + h > y1) y1 = y + h;
  };
  // A turned rect: the circle around it.
  const turned = (r: Rect, rot: number | undefined): void => {
    if (!rot) {
      add(r.x, r.y, r.w, r.h);
      return;
    }
    const c = rectCenter(r);
    const R = Math.hypot(r.w, r.h) / 2;
    add(c.x - R, c.y - R, 2 * R, 2 * R);
  };
  const pts = (p: readonly number[], pad: number): void => {
    for (let i = 0; i + 1 < p.length; i += 2) add((p[i] ?? 0) - pad, (p[i + 1] ?? 0) - pad, 2 * pad, 2 * pad);
  };
  for (const r of o.outlines) turned(r.rect, r.rot);
  for (const c of o.connectors) pts(c.points, Math.max(c.strokeWidth, 1) * px);
  if (o.group) turned(o.group.rect, o.group.rot);
  if (o.quick) {
    const d = (QUICK_OFFSET_PX + QUICK_HIT_PX) * px;
    add(o.quick.rect.x - d, o.quick.rect.y - d, o.quick.rect.w + 2 * d, o.quick.rect.h + 2 * d);
    if (o.quick.hot) add(o.quick.hot.ghost.x, o.quick.hot.ghost.y, o.quick.hot.ghost.w, o.quick.hot.ghost.h);
  }
  if (o.marquee) add(o.marquee.x, o.marquee.y, o.marquee.w, o.marquee.h);
  if (o.ghost) add(o.ghost.x, o.ghost.y, o.ghost.w, o.ghost.h);
  if (o.glue) {
    turned(o.glue.rect, o.glue.rot);
    for (const a of o.glue.anchors) add(a.x, a.y);
  }
  if (o.wire) pts(o.wire, 0);
  for (const g of o.guides) {
    if (g.axis === 'x') add(g.at, Math.min(g.from, g.to), 0, Math.abs(g.to - g.from));
    else add(Math.min(g.from, g.to), g.at, Math.abs(g.to - g.from), 0);
  }
  if (o.angle) add(o.angle.at.x, o.angle.at.y, ANGLE_BOX_PX.w * px, ANGLE_BOX_PX.h * px);
  if (o.link) add(o.link.at.x, o.link.at.y, LINK_MAX_PX * px, (LINK_GAP_PX + LINK_H_PX) * px);
  if (o.ink) pts(o.ink.points, Math.max(o.ink.width, px) / 2);
  if (x1 < x0) return null;
  const pad = OVERLAY_PAD_PX * px;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Paints the overlay. The context carries the camera transform (world units); `scale` is the camera scale. */
export function drawOverlay(ctx: Ctx2D, o: OverlayState, p: CanvasPalette, scale: number): void {
  const px = 1 / scale;
  const hp = o.touch ? TOUCH_HANDLE_PX : HANDLE_PX;
  ctx.lineJoin = 'miter';
  ctx.lineWidth = px * 1.5;
  ctx.strokeStyle = p.accent;
  for (const r of o.outlines) strokeTurned(ctx, r.rect, r.rot);

  for (const c of o.connectors) {
    const pts = c.points;
    if (pts.length < 4) continue;
    ctx.lineWidth = Math.max(c.strokeWidth, 1) * px + 3 * px;
    ctx.strokeStyle = p.accentFill;
    ctx.beginPath();
    ctx.moveTo(pts[0] ?? 0, pts[1] ?? 0);
    for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] ?? 0, pts[i + 1] ?? 0);
    ctx.stroke();
    drawHandle(ctx, { x: pts[0] ?? 0, y: pts[1] ?? 0 }, p, px, true, hp);
    drawHandle(ctx, { x: pts[pts.length - 2] ?? 0, y: pts[pts.length - 1] ?? 0 }, p, px, true, hp);
  }

  if (o.group) {
    const g = o.group;
    const c = rectCenter(g.rect);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(g.rot * DEG);
    ctx.translate(-c.x, -c.y);
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.accent;
    ctx.strokeRect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
    if (g.rotate) {
      const top = { x: g.rect.x + g.rect.w / 2, y: g.rect.y };
      const knob = { x: top.x, y: top.y - (o.touch ? TOUCH_ROTATE_OFFSET_PX : ROTATE_OFFSET_PX) * px };
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(knob.x, knob.y + (hp / 2 + 1) * px);
      ctx.stroke();
      drawHandle(ctx, knob, p, px, true, hp);
    }
    if (g.resize) for (const h of HANDLE_IDS) if (!(g.widthOnly && (h === 'n' || h === 's')) && !(g.cornersOnly && h.length === 1)) drawHandle(ctx, handlePoint(g.rect, h), p, px, false, hp);
    ctx.restore();
  }

  if (o.quick) drawQuick(ctx, o.quick, p, px);

  if (o.marquee) {
    ctx.fillStyle = p.accentFill;
    ctx.fillRect(o.marquee.x, o.marquee.y, o.marquee.w, o.marquee.h);
    ctx.lineWidth = px;
    ctx.strokeStyle = p.accent;
    ctx.strokeRect(o.marquee.x, o.marquee.y, o.marquee.w, o.marquee.h);
  }

  if (o.ghost) {
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.accent;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(o.ghost.x, o.ghost.y, o.ghost.w, o.ghost.h);
    ctx.setLineDash([]);
  }

  if (o.glue) {
    ctx.lineWidth = px * 2;
    ctx.strokeStyle = p.accent;
    strokeTurned(ctx, o.glue.rect, o.glue.rot ?? 0);
    for (const a of o.glue.anchors) {
      const active = o.glue.active !== null && a.x === o.glue.active.x && a.y === o.glue.active.y;
      ctx.beginPath();
      ctx.arc(a.x, a.y, (active ? 5 : 3.5) * px, 0, Math.PI * 2);
      ctx.fillStyle = active ? p.accent : p.handleFill;
      ctx.fill();
      ctx.stroke();
    }
  }

  if (o.wire && o.wire.length >= 4) {
    ctx.lineWidth = px * 2;
    ctx.strokeStyle = p.accent;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(o.wire[0] ?? 0, o.wire[1] ?? 0);
    for (let i = 2; i + 1 < o.wire.length; i += 2) ctx.lineTo(o.wire[i] ?? 0, o.wire[i + 1] ?? 0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (o.guides.length > 0) {
    ctx.lineWidth = px;
    ctx.strokeStyle = p.guide;
    ctx.beginPath();
    for (const g of o.guides) {
      if (g.axis === 'x') {
        ctx.moveTo(g.at, g.from);
        ctx.lineTo(g.at, g.to);
      } else {
        ctx.moveTo(g.from, g.at);
        ctx.lineTo(g.to, g.at);
      }
    }
    ctx.stroke();
  }

  if (o.angle) drawAngle(ctx, o.angle, p, px);
  if (o.link) drawLinkPill(ctx, o.link, p, px);

  if (o.ink) strokeInk(ctx, o.ink.points, 0, 0, resolveColor(p, o.ink.color) ?? p.ink, Math.max(o.ink.width, px), o.ink.marker);
}

/** The «45°» pill: screen-sized, hung down-right of the cursor so the pointer and the handle stay visible. */
function drawAngle(ctx: Ctx2D, a: { at: Point; deg: number }, p: CanvasPalette, px: number): void {
  const text = `${a.deg}°`;
  ctx.save();
  ctx.font = `600 ${12 * px}px ${p.fontFamily}`;
  const w = ctx.measureText(text).width + 14 * px;
  const h = 20 * px;
  ctx.beginPath();
  traceRounded(ctx, { x: a.at.x + 14 * px, y: a.at.y + 14 * px, w, h }, h / 2);
  ctx.fillStyle = p.accent;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, a.at.x + 14 * px + w / 2, a.at.y + 14 * px + h / 2 + 0.5 * px);
  ctx.restore();
}

/** The hovered link's address under its object: screen-sized, cut to `LINK_MAX_PX` with an ellipsis. */
function drawLinkPill(ctx: Ctx2D, l: { at: Point; text: string }, p: CanvasPalette, px: number): void {
  ctx.save();
  ctx.font = `500 ${12 * px}px ${p.fontFamily}`;
  const pad = 8 * px;
  const max = LINK_MAX_PX * px - 2 * pad;
  let text = l.text;
  if (ctx.measureText(text).width > max) {
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
      else hi = mid - 1;
    }
    text = `${text.slice(0, lo)}…`;
  }
  const w = ctx.measureText(text).width + 2 * pad;
  const h = LINK_H_PX * px;
  const y = l.at.y + LINK_GAP_PX * px;
  ctx.beginPath();
  traceRounded(ctx, { x: l.at.x, y, w, h }, h / 2);
  ctx.fillStyle = p.accent;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, l.at.x + pad, y + h / 2 + 0.5 * px);
  ctx.restore();
}

function strokeTurned(ctx: Ctx2D, r: Rect, rot: number): void {
  if (!rot) {
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    return;
  }
  const c = rectCenter(r);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(rot * DEG);
  ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
}

/** The «continue» dots; the hovered one grows into an arrow button with the next object and its wire previewed. */
function drawQuick(ctx: Ctx2D, q: QuickOverlay, p: CanvasPalette, px: number): void {
  const hot = q.hot;
  // Ease-out: quick at first, settling at the end.
  const e = hot ? 1 - (1 - hot.t) ** 3 : 0;
  if (hot) {
    ctx.save();
    ctx.globalAlpha = e;
    const from = edgeMid(q.rect, hot.side);
    const to = edgeMid(hot.ghost, OPPOSITE[hot.side]);
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.accent;
    ctx.fillStyle = p.accentFill;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.fillRect(hot.ghost.x, hot.ghost.y, hot.ghost.w, hot.ghost.h);
    ctx.strokeRect(hot.ghost.x, hot.ghost.y, hot.ghost.w, hot.ghost.h);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
  for (const side of q.sides) {
    if (hot?.side === side) continue;
    const d = quickDot(q.rect, side, px);
    ctx.beginPath();
    ctx.arc(d.x, d.y, 4.5 * px, 0, Math.PI * 2);
    ctx.fillStyle = p.accent;
    ctx.fill();
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.handleFill;
    ctx.stroke();
  }
  if (!hot) return;
  const at = quickDot(q.rect, hot.side, px);
  const dir = { x: hot.side === 'right' ? 1 : hot.side === 'left' ? -1 : 0, y: hot.side === 'bottom' ? 1 : hot.side === 'top' ? -1 : 0 };
  ctx.beginPath();
  ctx.arc(at.x, at.y, (4.5 + 7.5 * e) * px, 0, Math.PI * 2);
  ctx.fillStyle = p.accent;
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = e;
  // An arrow pointing where the object will go.
  const s = 5 * px;
  const nx = -dir.y;
  const ny = dir.x;
  ctx.beginPath();
  ctx.moveTo(at.x - dir.x * s, at.y - dir.y * s);
  ctx.lineTo(at.x + dir.x * s, at.y + dir.y * s);
  ctx.moveTo(at.x + dir.x * s - (dir.x - nx) * s * 0.7, at.y + dir.y * s - (dir.y - ny) * s * 0.7);
  ctx.lineTo(at.x + dir.x * s, at.y + dir.y * s);
  ctx.lineTo(at.x + dir.x * s - (dir.x + nx) * s * 0.7, at.y + dir.y * s - (dir.y + ny) * s * 0.7);
  ctx.lineWidth = px * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // White on the accent in both themes (the handle fill is dark in the dark one).
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

function drawHandle(ctx: Ctx2D, at: Point, p: CanvasPalette, px: number, round: boolean, size = HANDLE_PX): void {
  const s = size * px;
  ctx.fillStyle = p.handleFill;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = px * 1.5;
  ctx.beginPath();
  if (round) ctx.arc(at.x, at.y, s / 2 + px, 0, Math.PI * 2);
  else ctx.rect(at.x - s / 2, at.y - s / 2, s, s);
  ctx.fill();
  ctx.stroke();
}
