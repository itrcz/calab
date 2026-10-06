import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeTheme, screen, shell, type Rectangle, type TitleBarOverlayOptions, type WebContents } from 'electron';
import { API_SCHEME, IPC } from '../shared/ipc';
import { isAppSession } from './appSessions';
import { windowIconPath } from './icons';
import { mainStrings } from './strings';

const here = fileURLToPath(new URL('.', import.meta.url));
const PRELOAD = join(here, '../preload/index.cjs');
const RENDERER_HTML = join(here, '../renderer/index.html');
/** The window layer (--color-rail in styles.css): the opaque window background per theme. */
const WINDOW_BG = { dark: '#171719', light: '#e8e8ec' } as const;
const windowBg = (): string => (nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light);

let mainWindow: BrowserWindow | null = null;

/** Close / session-end hooks of the main window (appLifecycle.ts; a setter avoids an import cycle). */
export interface MainWindowHooks {
  close: (e: Electron.Event, win: BrowserWindow) => void;
  /** Windows logoff / shutdown: quit for real, without questions. */
  sessionEnd: () => void;
}
let hooks: MainWindowHooks | null = null;
export function setMainWindowHooks(h: MainWindowHooks): void {
  hooks = h;
}

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadState(): WindowState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    // Only restore if the saved bounds are still on a connected display.
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.bounds.x < a.x + a.width && s.bounds.x + s.bounds.width > a.x && s.bounds.y < a.y + a.height && s.bounds.y + s.bounds.height > a.y;
    });
    return visible ? s : null;
  } catch {
    return null;
  }
}

function saveState(win: BrowserWindow): void {
  try {
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // non-fatal
  }
}

/** Popup windows the renderer may open (stream pop-out). Everything else is denied. */
const POPUP_PREFIX = 'calaba-popout-';

export const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  // A voice client must not throttle timers/media while in background.
  backgroundThrottling: false,
  // Remote <audio> must start without a click.
  autoplayPolicy: 'no-user-gesture-required',
  spellcheck: true,
} as const;

/** Height of the renderer's title bar (docs/09 #1; --titlebar-height in styles.css). */
const TITLEBAR_HEIGHT = 46;

/**
 * Window chrome per platform (docs/09 #1):
 * - macOS: `hiddenInset`, traffic lights at (16, 16) — vertically centred in the 46 px bar (owner,
 *   07.10: a taller, airier bar); the renderer keeps the first 80 px of the bar empty for them.
 * - Windows: `hidden` + Window Controls Overlay — the native min/max/close buttons sit in our
 *   own 46 px bar (like Discord/VS Code), so the chrome is one row instead of an OS caption plus
 *   our bar. The renderer reserves their width via `env(titlebar-area-*)`; colours follow the theme.
 * - Linux: the standard frame. WCO buttons there are Chromium-drawn (not the GTK/KDE theme),
 *   and client-side decorations misbehave under tiling WMs and some compositors — the native
 *   frame is the predictable choice; our bar then is just a toolbar below it.
 */
function chrome(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } };
  if (process.platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() };
  return { titleBarStyle: 'default' };
}

function overlayColors(): TitleBarOverlayOptions {
  // Same colours as the rail/title bar material (--color-rail, --color-label).
  return nativeTheme.shouldUseDarkColors
    ? { color: WINDOW_BG.dark, symbolColor: '#ececf0', height: TITLEBAR_HEIGHT }
    : { color: WINDOW_BG.light, symbolColor: '#1d1d1f', height: TITLEBAR_HEIGHT };
}

function windowIcon(): { icon?: string } {
  const icon = windowIconPath();
  return icon ? { icon } : {};
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const state = loadState();
  const win = new BrowserWindow({
    width: state?.bounds.width ?? 1280,
    height: state?.bounds.height ?? 820,
    ...(state ? { x: state.bounds.x, y: state.bounds.y } : {}),
    minWidth: 960,
    minHeight: 600,
    title: 'Calab',
    // Opaque, no vibrancy (docs/08 «Материалы», docs/09 #65): the compositor would re-blur the
    // desktop behind the window on every frame. The colour follows the theme (below).
    transparent: false,
    backgroundColor: windowBg(),
    show: false,
    ...chrome(),
    ...windowIcon(),
    webPreferences: { ...webPreferences },
  });
  if (state?.maximized) win.maximize();
  // The renderer's theme drives nativeTheme.themeSource (IPC appSetTheme): recolour the window
  // background (seen while resizing and before the first paint) and the Windows caption buttons.
  const recolor = (): void => {
    if (win.isDestroyed()) return;
    win.setBackgroundColor(windowBg());
    if (process.platform === 'win32') win.setTitleBarOverlay(overlayColors());
  };
  nativeTheme.on('updated', recolor);
  win.on('closed', () => nativeTheme.off('updated', recolor));
  win.once('ready-to-show', () => win.show());
  // The page can't see it (backgroundThrottling: false pins document.visibilityState): tell it,
  // so it can stop decoding video nobody sees (lib/windowVisibility.ts, docs/14-energy.md).
  let lastShown: boolean | null = null;
  const sendShown = (): void => {
    if (win.isDestroyed()) return;
    const shown = isShown(win);
    if (shown === lastShown) return;
    lastShown = shown;
    win.webContents.send(IPC.windowShownChanged, shown);
  };
  win.on('show', sendShown);
  win.on('hide', sendShown);
  win.on('minimize', sendShown);
  win.on('restore', sendShown);

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveState(win), 500);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', (e) => {
    saveState(win);
    // Hides instead of closing unless the app is really quitting (docs/09 #31).
    hooks?.close(e, win);
    // Electron 44 on macOS emits no 'hide' for win.hide(): report the result of the close ourselves
    // (a full-screen window hides only after leaving full screen).
    if (!win.isDestroyed() && win.isFullScreen()) win.once('leave-full-screen', () => setImmediate(sendShown));
    else setImmediate(sendShown);
  });
  win.on('query-session-end', () => hooks?.sessionEnd());
  win.on('session-end', () => hooks?.sessionEnd());

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName.startsWith(POPUP_PREFIX)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 580,
          minWidth: 320,
          minHeight: 200,
          backgroundColor: '#000000',
          title: mainStrings().streamWindow,
          autoHideMenuBar: true,
          alwaysOnTop: true,
          webPreferences: { ...webPreferences },
        },
      };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    if (details.url !== 'about:blank' || !details.frameName.startsWith(POPUP_PREFIX)) return;
    // This is an independent floating stream, including above fullscreen apps on macOS.
    if (process.platform === 'darwin') child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const sendShown = (): void => {
      if (!child.isDestroyed()) child.webContents.send(IPC.windowShownChanged, isShown(child));
    };
    child.on('show', sendShown);
    child.on('hide', sendShown);
    child.on('minimize', sendShown);
    child.on('restore', sendShown);
  });
  // Navigation / frame / <webview> guards: installWebContentsGuards (every webContents).

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(RENDERER_HTML);
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

/**
 * Guards for every webContents the app creates — the main window, stream pop-outs (their
 * `about:blank` page gets the full preload) and anything added later (review L12):
 * - no navigation away from our page (main frame or sub-frames);
 * - no <webview>;
 * - window.open: denied (http(s) goes to the browser) unless the owner installs its own
 *   handler afterwards (the main window allows its stream pop-out).
 */
export function guardWebContents(wc: WebContents): void {
  // A workspace web app (ADR-0050 §4): its own, separate guard set (main/webApps.ts); it never
  // shows our page, has no preload and no IPC.
  if (isAppSession(wc.session)) return;
  wc.on('will-navigate', (e, url) => {
    if (!isOwnPage(url)) e.preventDefault();
  });
  wc.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !isOwnPage(e.url)) e.preventDefault();
  });
  wc.on('will-redirect', (e, url) => {
    if (!isOwnPage(url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export function installWebContentsGuards(): void {
  app.on('web-contents-created', (_e, wc) => guardWebContents(wc));
}

/** On screen: shown and not minimized (macOS occlusion by other windows is not reported). */
export function isShown(win: BrowserWindow): boolean {
  return win.isVisible() && !win.isMinimized();
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function showMainWindow(): void {
  const w = getMainWindow() ?? createMainWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** Origins our renderer is served from; used to scope permission grants and IPC. */
/**
 * Our renderer page, exactly: the packaged index.html (any hash/query), the dev server origin,
 * or an about:blank stream pop-out opened by it. Security review L1: a bare `file://` prefix
 * would trust any local HTML (e.g. a downloaded file) with the full preload API.
 */
const RENDERER_FILE_URL = pathToFileURL(RENDERER_HTML).href;

export function isOwnPage(url: string): boolean {
  if (url === 'about:blank') return true;
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    try {
      if (new URL(url).origin === new URL(devUrl).origin) return true;
    } catch {
      return false;
    }
  }
  return url.split(/[?#]/)[0] === RENDERER_FILE_URL;
}

/**
 * Permission checks only get an origin (`file:///` for any local page), so they also require
 * the asking webContents to show our page.
 */
export function isOwnOrigin(origin: string, pageUrl?: string): boolean {
  if (pageUrl !== undefined && !isOwnPage(pageUrl)) return false;
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl && origin.startsWith(new URL(devUrl).origin)) return true;
  return origin.startsWith('file://') || origin === 'about:blank' || origin.startsWith(`${API_SCHEME}:`);
}
