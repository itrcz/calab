import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';
import log from 'electron-log/main';
import { ANNOT_OVERLAY_CHANNEL, displayBoundsFor, overlayRaiseDue, overlaySupported, type AnnotOverlayEvent, type AnnotOverlayMessage, type AnnotOverlayTarget } from '../shared/annot';

/**
 * Presenter's annotation overlay (ADR-0028): a transparent, click-through, always-on-top window
 * exactly over the shared display, drawing what viewers point at / draw on my stream.
 *
 * - Only whole screens: an arbitrary window's bounds are not available without native code.
 * - Content protection keeps the overlay out of the capture (checked on macOS 27 / Electron 44:
 *   neither the desktopCapturer thumbnail nor the getDisplayMedia frame contains it). Linux has no
 *   such protection → no overlay there (viewers would see the drawings twice, in the video too).
 * - One overlay at a time (one stream per device).
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const PRELOAD = join(here, '../preload/overlay.cjs');
const OVERLAY_HTML = join(here, '../renderer/overlay.html');
const VISUAL_TEST = process.env['CALABA_VISUAL_TEST'] === '1';

let overlay: { win: BrowserWindow; target: AnnotOverlayTarget; ready: Promise<void> } | null = null;

export function openOverlay(target: AnnotOverlayTarget): boolean {
  if (VISUAL_TEST || !overlaySupported(process.platform)) return false;
  const displays = screen.getAllDisplays();
  const bounds = displayBoundsFor(target, displays);
  // Issue #102: what the overlay was asked to cover and where it went, once per stream.
  const diag = {
    platform: process.platform,
    target,
    displays: displays.map((d) => `${d.id} ${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height} @${d.scaleFactor}`).join('; '),
  };
  if (!bounds) {
    log.warn('[annot] overlay: no display for the shared source', diag);
    return false;
  }
  if (overlay && !overlay.win.isDestroyed()) {
    if (overlay.target.sourceId === target.sourceId) return true;
    closeOverlay();
  }
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    title: 'Calab annotations',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  // Out of the capture first, before anything is shown (ADR-0028 §8).
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // macOS keeps a window below the menu bar unless it is set after creation.
  win.setBounds(bounds);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const ready = (devUrl ? win.loadURL(`${devUrl}/overlay.html`) : win.loadFile(OVERLAY_HTML)).then(
    () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      if (process.platform === 'win32') {
        // Windows: a window created on a display with another scale factor than the main one
        // gets its size scaled once more on the first show — set the bounds again; and topmost
        // is re-asserted after show, above other topmost windows that came up meanwhile.
        win.setBounds(bounds);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.moveTop();
      }
      log.info('[annot] overlay shown', { ...diag, bounds, got: win.getBounds(), visible: win.isVisible(), onTop: win.isAlwaysOnTop() });
    },
    (err: unknown) => log.warn('[annot] overlay load failed', err),
  );
  const entry = { win, target, ready };
  overlay = entry;
  win.on('closed', () => {
    if (overlay === entry) overlay = null;
  });
  return true;
}

function post(msg: AnnotOverlayMessage): void {
  const o = overlay;
  if (!o || o.win.isDestroyed()) return;
  void o.ready.then(() => {
    if (!o.win.isDestroyed()) o.win.webContents.send(ANNOT_OVERLAY_CHANNEL, msg);
  });
}

let raisedAt = 0;

export function sendOverlay(ev: AnnotOverlayEvent): void {
  post({ type: 'event', ev });
  const o = overlay;
  const now = Date.now();
  if (!o || o.win.isDestroyed() || !o.win.isVisible() || !overlayRaiseDue(process.platform, now, raisedAt)) return;
  raisedAt = now;
  // SWP_NOACTIVATE: back to the top of the topmost band without taking the focus.
  o.win.moveTop();
}

export function closeOverlay(): void {
  const o = overlay;
  overlay = null;
  if (o && !o.win.isDestroyed()) o.win.destroy();
}

/** The presenter's page reloads / dies: its stream is gone, so is the overlay. */
const watched = new WeakSet<Electron.WebContents>();
export function closeOverlayWith(owner: Electron.WebContents): void {
  if (watched.has(owner)) return;
  watched.add(owner);
  owner.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) closeOverlay();
  });
  owner.on('render-process-gone', () => closeOverlay());
  owner.once('destroyed', () => closeOverlay());
}

/** Screen layout changed (resolution, arrangement, unplugged): refit or close the overlay. */
export function refitOverlay(): void {
  const o = overlay;
  if (!o || o.win.isDestroyed()) return;
  const bounds = displayBoundsFor(o.target, screen.getAllDisplays());
  if (bounds) o.win.setBounds(bounds);
  else closeOverlay();
}
