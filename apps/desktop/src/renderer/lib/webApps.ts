/**
 * Pure helpers of the web apps UI (ADR-0050 §3): the letter plate, reordering in the rail, and
 * which overlays must hide the desktop view (a native view is drawn above the whole page, so a
 * menu or a dialog over the content area would be hidden behind the site).
 */

/** The first letter or digit of the name, upper-cased («grafana» → «G»); «?» for none. */
export function appInitial(name: string): string {
  for (const ch of name.trim()) if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLocaleUpperCase();
  return '?';
}

export interface Slot {
  id: string;
  top: number;
  bottom: number;
}

/**
 * Where a dragged icon lands in the column: the new index among the others and the y of the
 * insertion line (relative to the list); null = its own place (no move).
 */
export function appDropAt(slots: readonly Slot[], y: number, draggedId: string): { index: number; lineY: number } | null {
  const from = slots.findIndex((s) => s.id === draggedId);
  if (from < 0 || !slots.length) return null;
  let at = slots.length;
  for (const [i, s] of slots.entries()) {
    if (y < (s.top + s.bottom) / 2) {
      at = i;
      break;
    }
  }
  const index = at > from ? at - 1 : at;
  if (index === from) return null;
  const lineY = at < slots.length ? (slots[at]?.top ?? 0) - 2 : (slots[slots.length - 1]?.bottom ?? 0) + 2;
  return { index, lineY };
}

/**
 * Moves `id` to `index` of `ids`: the new order and the neighbours the server needs (PUT
 * …/position: after / before, "" at an end).
 */
export function moveApp(ids: readonly string[], id: string, index: number): { order: string[]; after: string; before: string } {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const order = [...rest.slice(0, at), id, ...rest.slice(at)];
  return { order, after: rest[at - 1] ?? '', before: rest[at] ?? '' };
}

/** The bits of an element the overlay check reads (a DOM Element in the app, a stub in tests). */
export interface OverlayNode {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): unknown;
}

/**
 * A top-level child of <body> that covers content: a Radix popper (menu, popover, select) that is
 * not just a tooltip, or a dialog. Tooltips are ignored — hovering the rail must not blink the
 * site away.
 */
export function coversContent(el: OverlayNode): boolean {
  if (el.hasAttribute('data-radix-popper-content-wrapper')) return !el.querySelector('[role="tooltip"]');
  const role = el.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog' || role === 'menu') return true;
  return !!el.querySelector('[role="dialog"],[role="alertdialog"]');
}

/** A rectangle in CSS px of the window (the view's placeholder, an overlay). */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below this the site is not worth showing: the view is hidden while the overlays last. */
export const MIN_VIEW_WIDTH = 240;
export const MIN_VIEW_HEIGHT = 160;
/** Space kept between an overlay and the site. */
export const OVERLAY_GAP = 8;

/**
 * The part of the view's placeholder the native view may take while overlays of our page that
 * must stay visible are shown (toasts, knock cards, the calling strip — `[data-app-occluder]`):
 * the native view is drawn above the whole page, so it steps aside instead of hiding them. Each
 * overlay that intersects the view cuts it from the side that keeps the most area; null = too
 * little is left, the view is hidden meanwhile. Empty overlays (an empty toast stack) are ignored.
 */
export function visibleViewRect(view: ViewRect, overlays: readonly ViewRect[], gap = OVERLAY_GAP): ViewRect | null {
  let r = { ...view };
  for (const o of overlays) {
    if (o.width <= 0 || o.height <= 0) continue;
    const right = r.x + r.width;
    const bottom = r.y + r.height;
    const oRight = o.x + o.width;
    const oBottom = o.y + o.height;
    if (o.x >= right || oRight <= r.x || o.y >= bottom || oBottom <= r.y) continue;
    const cuts: ViewRect[] = [
      { x: r.x, y: oBottom + gap, width: r.width, height: bottom - (oBottom + gap) }, // below it
      { x: r.x, y: r.y, width: r.width, height: o.y - gap - r.y }, // above it
      { x: oRight + gap, y: r.y, width: right - (oRight + gap), height: r.height }, // right of it
      { x: r.x, y: r.y, width: o.x - gap - r.x, height: r.height }, // left of it
    ];
    let best: ViewRect | null = null;
    for (const c of cuts) {
      if (c.width <= 0 || c.height <= 0) continue;
      if (!best || c.width * c.height > best.width * best.height) best = c;
    }
    if (!best) return null;
    r = best;
  }
  return r.width >= MIN_VIEW_WIDTH && r.height >= MIN_VIEW_HEIGHT ? r : null;
}

/**
 * Hide profile and voice controls while a web app fills the content area, and on the Calendar /
 * Boards tabs — even during a call (owner, 02.10: the user returns to «Голос» to control it).
 */
export function showBottomIsland(appOpen: boolean, workTab = false): boolean {
  return !appOpen && !workTab;
}

/**
 * What the title bar's left slot shows: the open web app's name as plain text (no chevron, not a
 * menu) while the app view is active, otherwise the workspace switcher.
 */
export function titleSlot(appName: string | undefined): { kind: 'app'; text: string } | { kind: 'workspace' } {
  return appName ? { kind: 'app', text: appName } : { kind: 'workspace' };
}

/**
 * A tooltip must be drawn by the native overlay above the app (ADR-0053 «Поправка 1»): its
 * rectangle overlaps the visible app view (a DOM tooltip there would be under the site). Touching
 * edges do not count; no app on screen (`app` null) → the plain DOM tooltip.
 */
export function tipOverApp(tip: ViewRect, app: ViewRect | null): boolean {
  if (!app || tip.width <= 0 || tip.height <= 0 || app.width <= 0 || app.height <= 0) return false;
  return tip.x < app.x + app.width && tip.x + tip.width > app.x && tip.y < app.y + app.height && tip.y + tip.height > app.y;
}

/** Longest tooltip text the overlay accepts (main validates the same bound). */
export const TIP_TEXT_MAX = 200;

/** The overlay's text: whitespace collapsed, at most TIP_TEXT_MAX chars (an ellipsis when cut). */
export function tipText(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > TIP_TEXT_MAX ? `${s.slice(0, TIP_TEXT_MAX - 1)}…` : s;
}
