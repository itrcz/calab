/**
 * Pure math of the viewer-side zoom and pan of a screen share (issue #33). The view is a CSS
 * `translate(x, y) scale(s)` of the whole stage box with `transform-origin: 0 0`, so a point of the
 * box at (px, py) lands at (x + px·s, y + py·s). 1× = fit. The box always covers the viewport:
 * x ∈ [W·(1−s), 0], y ∈ [H·(1−s), 0].
 */
export interface View {
  s: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Step of the `+` / `-` keys. */
export const KEY_STEP = 1.25;
export const FIT: View = { s: 1, x: 0, y: 0 };

export const clampScale = (s: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(s) ? s : 1));

/** Keeps the scaled box covering the W×H viewport (the image never leaves it). */
export function clampView(v: View, w: number, h: number): View {
  const s = clampScale(v.s);
  if (s === 1) return FIT;
  return { s, x: Math.min(0, Math.max(w * (1 - s), v.x)), y: Math.min(0, Math.max(h * (1 - s), v.y)) };
}

/** Scale to `next` keeping the viewport point (px, py) fixed under the cursor. */
export function zoomAt(v: View, next: number, px: number, py: number, w: number, h: number): View {
  const s = clampScale(next);
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, w, h);
}

export const panBy = (v: View, dx: number, dy: number, w: number, h: number): View => clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, w, h);

/** Double click: fit → 2× at the point; zoomed → back to fit. */
export function toggleAt(v: View, px: number, py: number, w: number, h: number): View {
  return v.s > 1.001 ? FIT : zoomAt(v, 2, px, py, w, h);
}

/** `deltaY` of a wheel event in pixels (Firefox sends lines / pages). */
export function wheelPixels(deltaY: number, deltaMode: number, pageSize: number): number {
  return deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageSize : deltaY;
}

/**
 * Zoom factor of one wheel event. A trackpad pinch arrives as many small `ctrlKey` deltas (a few
 * px), a mouse notch as one big one (≥ 50 px): the notch gets a gentler gain so it is ≈ 1.2×.
 */
export function wheelFactor(deltaPx: number): number {
  const d = Math.max(-150, Math.min(150, deltaPx));
  return Math.exp(-d * (Math.abs(d) >= 50 ? 0.002 : 0.01));
}

export interface Frac {
  l: number;
  t: number;
  w: number;
  h: number;
}

/** The visible part of the stage as fractions (0..1) of it: the minimap's viewport rectangle. */
export const viewFrac = (v: View, w: number, h: number): Frac => ({ l: Math.abs(v.x) / (w * v.s), t: Math.abs(v.y) / (h * v.s), w: 1 / v.s, h: 1 / v.s });

/** Minimap click / drag at fractions (fx, fy): the view centred there, clamped. */
export function centerOn(s: number, fx: number, fy: number, w: number, h: number): View {
  const f = Math.min(1, Math.max(0, fx));
  const g = Math.min(1, Math.max(0, fy));
  return clampView({ s, x: w / 2 - f * w * s, y: h / 2 - g * h * s }, w, h);
}

/** Two-finger gesture: scale by the ratio of finger distances, follow the midpoint. */
export function pinch(start: View, d0: number, m0: [number, number], d1: number, m1: [number, number], w: number, h: number): View {
  if (d0 <= 0) return start;
  const s = clampScale(start.s * (d1 / d0));
  const k = s / start.s;
  return clampView({ s, x: m1[0] - (m0[0] - start.x) * k, y: m1[1] - (m0[1] - start.y) * k }, w, h);
}

/** Percent text of the chip: «250 %». */
export const levelText = (s: number): string => `${Math.round(s * 100)} %`;
