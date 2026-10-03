/**
 * Pure parts of the tooltip overlay over a workspace web app (ADR-0053 «Поправка 1»): payload
 * validation of `webapp:tip-show`, the static page and the script that fills it. No Electron
 * imports — unit-tested in tipOverlayPolicy.test.ts.
 */

export type TipTheme = 'dark' | 'light';
export type TipSide = 'top' | 'right' | 'bottom' | 'left';

/** A tooltip to draw: its rectangle in window DIPs (already multiplied by the page zoom). */
export interface TipPayload {
  text: string;
  shortcut: string;
  rect: { x: number; y: number; width: number; height: number };
  theme: TipTheme;
  side: TipSide;
}

export const TIP_TEXT_MAX = 200;
export const TIP_SHORTCUT_MAX = 32;
/** A tooltip is at most max-w-72 (288 px) wide; anything far larger is not a tooltip. */
const TIP_MAX_SIZE = 1024;
/** Rounding of CSS px × zoom may overshoot the window edge by a pixel. */
const EDGE_SLACK = 2;

const SIDES: readonly TipSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * Validates a `webapp:tip-show` payload from the renderer (CSS px of the main window) and turns
 * its rectangle into window DIPs: text ≤ 200 chars, a non-empty rect fully inside the window's
 * content area. Throws on anything else.
 */
export function parseTipPayload(v: unknown, zoom: number, win: { width: number; height: number }): TipPayload {
  if (typeof v !== 'object' || v === null) throw new Error('invalid tip');
  const r = v as Record<string, unknown>;
  const text = r['text'];
  if (typeof text !== 'string' || !text.trim() || text.length > TIP_TEXT_MAX) throw new Error('invalid tip text');
  const shortcut = r['shortcut'] ?? '';
  if (typeof shortcut !== 'string' || shortcut.length > TIP_SHORTCUT_MAX) throw new Error('invalid tip shortcut');
  const theme = r['theme'];
  if (theme !== 'dark' && theme !== 'light') throw new Error('invalid tip theme');
  const side = r['side'];
  if (typeof side !== 'string' || !SIDES.includes(side as TipSide)) throw new Error('invalid tip side');
  const rect = r['rect'];
  if (typeof rect !== 'object' || rect === null) throw new Error('invalid tip rect');
  const rr = rect as Record<string, unknown>;
  const n = (k: string): number => {
    const x = rr[k];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('invalid tip rect');
    return x;
  };
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // Outward to whole DIPs: a box a fraction narrower than the DOM one could wrap its text.
  const x = Math.floor(n('x') * z);
  const y = Math.floor(n('y') * z);
  const width = Math.ceil((n('x') + n('width')) * z) - x;
  const height = Math.ceil((n('y') + n('height')) * z) - y;
  if (width <= 0 || height <= 0 || width > TIP_MAX_SIZE * z || height > TIP_MAX_SIZE * z) throw new Error('invalid tip rect');
  if (x < -EDGE_SLACK || y < -EDGE_SLACK || x + width > win.width + EDGE_SLACK || y + height > win.height + EDGE_SLACK) {
    throw new Error('tip rect outside the window');
  }
  return { text, shortcut, rect: { x, y, width, height }, theme, side: side as TipSide };
}

/**
 * The overlay's page: a static document without network or scripts of its own (CSP
 * `default-src 'none'`), one tooltip box filling the view. The look copies the DOM `Tip`
 * (components/ui.tsx, app/styles.css tokens: --color-popover, --color-border-popover,
 * --color-label, --color-label-tertiary, --radius-row, text-caption / text-micro) as plain CSS
 * values for both themes. No animation: the view only moves and changes its text. The shadow of
 * the DOM tooltip is not drawn — the view is exactly the tooltip's rectangle (it must not reach
 * the trigger: a native view takes the mouse).
 */
export const TIP_PAGE_HTML = `<!doctype html><html class="dark"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{--p:#2c2c30;--b:rgb(255 255 255 / 8%);--f:#ececf0;--k:#a9a9ae}
:root.light{--p:#f7f7f9;--b:rgb(0 0 0 / 6%);--f:#1d1d1f;--k:#5a5a5f}
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,'Helvetica Neue','Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
#t{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;border:1px solid var(--b);background:var(--p);color:var(--f);font-size:12px;line-height:16px}
#k{font-family:inherit;font-size:11px;line-height:14px;color:var(--k)}
#k:empty{display:none}
</style></head><body><div id="t"><span id="l"></span><kbd id="k"></kbd></div></body></html>`;

export const TIP_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TIP_PAGE_HTML)}`;

/**
 * The one statement main runs in the overlay page to show a tooltip (executeJavaScript is not
 * subject to the page's CSP). Values travel as JSON literals and are set as text, never as HTML.
 */
export function tipRenderScript(p: Pick<TipPayload, 'text' | 'shortcut' | 'theme'>): string {
  return (
    `document.documentElement.className=${JSON.stringify(p.theme)};` +
    `document.getElementById('l').textContent=${JSON.stringify(p.text)};` +
    `document.getElementById('k').textContent=${JSON.stringify(p.shortcut)};void 0`
  );
}
