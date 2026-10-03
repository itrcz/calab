import { app, nativeTheme, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import log from 'electron-log/main';
import { TIP_PAGE_URL, tipRenderScript, type TipPayload } from './tipOverlayPolicy';

/**
 * Tooltips over a workspace web app (ADR-0053 «Поправка 1»). A web app is a native view drawn
 * above the whole page, so a DOM tooltip that falls on it would be hidden; instead of shrinking
 * the app around the tooltip, the renderer asks main to draw that tooltip in this tiny native
 * view above the app.
 *
 * - One transparent WebContentsView per main window, created lazily on the first such tooltip,
 *   destroyed with the window. Its bounds are the tooltip's rectangle (it takes the mouse, so it
 *   never covers more — in particular not the trigger).
 * - A static local page (tipOverlayPolicy.ts): no preload, no IPC, no Node, sandboxed, its own
 *   in-memory session with every request cancelled, CSP `default-src 'none'`. Main sets the text
 *   with executeJavaScript (JSON literals → textContent).
 * - Idle cost zero: no timers, no animations; a hidden overlay is `setVisible(false)` at 0×0.
 * - Hidden with the tooltip, and whenever the app view is hidden or another one is attached
 *   (window hide / minimize, app switch, our page reloading — webApps.ts), and on a theme change.
 */

interface Overlay {
  win: BrowserWindow;
  view: WebContentsView;
  ready: Promise<boolean>;
  /** Bumped by every show / hide: a show that waited for the page is dropped if another came. */
  seq: number;
  visible: boolean;
}

let overlay: Overlay | null = null;
const ZERO = { x: 0, y: 0, width: 0, height: 0 };

let tipSession: Session | null = null;
function overlaySession(): Session {
  if (tipSession) return tipSession;
  const ses = session.fromPartition('tip-overlay'); // in memory: nothing on disk
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  tipSession = ses;
  return ses;
}

function create(win: BrowserWindow): Overlay {
  const view = new WebContentsView({
    webPreferences: {
      session: overlaySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      javascript: true, // only main's executeJavaScript runs: the page's CSP allows no script
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: true,
      navigateOnDragDrop: false,
    },
  });
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  view.setBounds(ZERO);
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  const ready = wc.loadURL(TIP_PAGE_URL).then(
    () => true,
    (err: unknown) => {
      log.warn('[tip] overlay page failed', err);
      return false;
    },
  );
  win.contentView.addChildView(view);
  const o: Overlay = { win, view, ready, seq: 0, visible: false };
  const onTheme = (): void => hideTip();
  nativeTheme.on('updated', onTheme);
  wc.on('render-process-gone', () => {
    if (overlay === o) destroyTip();
  });
  win.once('closed', () => {
    nativeTheme.off('updated', onTheme);
    if (overlay === o) destroyTip();
  });
  return o;
}

/** Draw `p` (window DIPs, validated by parseTipPayload) above the app view of `win`. */
export function showTip(win: BrowserWindow, p: TipPayload, zoom: number): void {
  if (win.isDestroyed()) return;
  if (overlay && overlay.win !== win) destroyTip();
  const o = (overlay ??= create(win));
  const seq = ++o.seq;
  void o.ready.then(async (ok) => {
    if (!ok || overlay !== o || o.seq !== seq || o.view.webContents.isDestroyed()) return;
    const wc = o.view.webContents;
    if (wc.getZoomFactor() !== zoom) wc.setZoomFactor(zoom);
    try {
      await wc.executeJavaScript(tipRenderScript(p));
    } catch (err) {
      log.warn('[tip] overlay render failed', err);
      return;
    }
    if (overlay !== o || o.seq !== seq || win.isDestroyed()) return;
    // Re-added on every show: the topmost child, above whichever app view is attached now.
    win.contentView.addChildView(o.view);
    o.view.setBounds(p.rect);
    o.view.setVisible(true);
    o.visible = true;
  });
}

export function hideTip(): void {
  const o = overlay;
  if (!o) return;
  o.seq++;
  if (!o.visible) return;
  o.visible = false;
  o.view.setVisible(false);
  // 0×0 while hidden: the next show resizes it, so a stale frame of the previous text never shows.
  o.view.setBounds(ZERO);
}

function destroyTip(): void {
  const o = overlay;
  if (!o) return;
  overlay = null;
  try {
    if (!o.win.isDestroyed()) o.win.contentView.removeChildView(o.view);
  } catch {
    // the window is gone
  }
  if (!o.view.webContents.isDestroyed()) o.view.webContents.close();
}
