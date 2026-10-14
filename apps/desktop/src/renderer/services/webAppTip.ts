import type { WebAppTip } from '../../shared/ipc';
import { tipOverApp, tipText, type ViewRect } from '../lib/webApps';

/**
 * Tooltips over an open workspace app on the desktop (ADR-0053 «Поправка 1»). The app is a
 * native view above the whole page, so a DOM tooltip that falls on it would be hidden under the
 * site; such a tooltip is drawn by main's overlay view instead (main/tipOverlay.ts) and its DOM
 * copy is made transparent (`data-tip-native`, it stays for screen readers). Tooltips elsewhere
 * are untouched. The web client embeds an iframe, which the DOM covers anyway: only the desktop
 * view (AppScreen's DesktopView, `platform.webApps`) records a rectangle, so nothing here runs
 * on the web. No platform import: `Tip` (components/ui.tsx) stays free of host code.
 *
 * No store, no re-render: the app screen records the rectangle its view occupies (plain module
 * state), an open `Tip` checks it once laid out and whenever Radix moves it.
 */

type TipApi = { tipShow(tip: WebAppTip): Promise<void>; tipHide(): Promise<void> };

/** Where the app view is now (CSS px of the window); null = no app on screen. */
let appRect: ViewRect | null = null;
let tipApi: TipApi | null = null;
/** Tooltip contents being mirrored now. */
const mirrored = new WeakSet<HTMLElement>();

/** The desktop app view moved (`r`) or went (null); `api` draws tooltips over it. */
export function setAppViewRect(r: ViewRect | null, api?: TipApi): void {
  appRect = r && r.width > 0 && r.height > 0 ? r : null;
  if (api) tipApi = api;
}

function rectOf(el: Element): ViewRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** The label's text: the content's own nodes without the shortcut and Radix's hidden a11y copy. */
function labelOf(content: HTMLElement): string {
  let s = '';
  for (const n of content.childNodes) {
    if (n instanceof Element && (n.hasAttribute('data-tip-shortcut') || n.getAttribute('role') === 'tooltip')) continue;
    s += n.textContent ?? '';
  }
  return tipText(s);
}

const SIDES = new Set(['top', 'right', 'bottom', 'left']);

/**
 * Called by an open `Tip` once its content is mounted; returns the cleanup for its close.
 * Does nothing (and observes nothing) while no app is on screen.
 */
export function mirrorTip(content: HTMLElement): (() => void) | undefined {
  const api = tipApi;
  const wrapper = content.parentElement;
  // Radix renders a tooltip's children twice (the visible box and a hidden copy for screen
  // readers): the second call for the same content is a no-op.
  if (!api || !appRect || !wrapper || mirrored.has(content)) return undefined;
  mirrored.add(content);
  let sent = '';
  const update = (): void => {
    const rect = rectOf(wrapper);
    if (!tipOverApp(rect, appRect)) {
      if (sent) {
        sent = '';
        content.removeAttribute('data-tip-native');
        void api.tipHide().catch(() => undefined);
      }
      return;
    }
    const side = content.dataset['side'] ?? 'top';
    const tip: WebAppTip = {
      text: labelOf(content),
      shortcut: content.querySelector('[data-tip-shortcut]')?.textContent.slice(0, 32) ?? '',
      rect,
      theme: document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark',
      side: (SIDES.has(side) ? side : 'top') as WebAppTip['side'],
    };
    if (!tip.text) return;
    const key = JSON.stringify(tip);
    if (key === sent) return;
    sent = key;
    content.setAttribute('data-tip-native', '');
    void api.tipShow(tip).catch(() => undefined);
  };
  // Radix (floating-ui) places the wrapper by its inline style: first off-screen, then at the
  // computed spot, again when the trigger moves. Nothing else is watched.
  const mo = new MutationObserver(update);
  mo.observe(wrapper, { attributes: true, attributeFilter: ['style'] });
  update();
  return () => {
    mirrored.delete(content);
    mo.disconnect();
    if (!sent) return;
    content.removeAttribute('data-tip-native');
    void api.tipHide().catch(() => undefined);
  };
}
