import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  session,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from 'electron';
import log from 'electron-log/main';
import { hostOf, validateAppUrl } from '../shared/appUrl';
import { safeFileName } from '../shared/fileName';
import { IPC, type WebAppNavAction, type WebAppNavState, type WebAppSignInAsk } from '../shared/ipc';
import { apiSession } from './apiTransport';
import { isAppSession, markAppSession } from './appSessions';
import { currentServerUrl, getAccessToken } from './auth';
import { markFromInternet } from './downloads';
import { mainStrings } from './strings';
import { hideTip } from './tipOverlay';
import { navShortcut } from './webAppKeys';
import {
  dropLru,
  mayNavigate,
  mayNavigateFrame,
  consentRequest,
  originOf,
  partitionOf,
  permissionCheck,
  permissionDecision,
  resolveWithRemembered,
  sameEndpoint,
  signInAllowed,
  signInAnswer,
  touchLru,
  windowOpenDecision,
  workspaceSignIn,
  type AskKind,
  type Remembered,
  type WorkspaceSignIn,
  type ViewBounds,
} from './webAppPolicy';
import { getMainWindow, isShown } from './windows';

/**
 * Workspace web apps (ADR-0050 §4–§5): each app is a WebContentsView of the main window —
 * sandboxed, no preload, no IPC, its own persistent session `persist:app-<id>` (site logins
 * stay, isolated from Calab and from each other). The renderer only says which app to show and
 * where (IPC `webapp:*`); it never reaches the site's content and the site never reaches Calab.
 *
 * A view is created on first open, hidden (not destroyed) when the user goes back to rooms, and
 * at most MAX_LIVE_VIEWS stay alive (LRU); a minimized / hidden window hides the view too.
 * Deleting the app destroys its view and clears its session and remembered permissions.
 */

interface Entry {
  appId: string;
  view: WebContentsView;
  /** The app's address as last opened (a changed address reloads the view). */
  home: string;
  /** The workspace the app belongs to: the only one whose sign-in Calab answers (ADR-0159). */
  workspaceId: string;
  /** When Calab answered the site's sign-in (ms), for the per-minute limit. */
  signIns: number[];
  /** A sign-in is being answered: a second request of the site waits for it, not a second dialog. */
  signingIn: boolean;
  /** The user refused the sign-in dialog: until the view goes, the site signs in its own way. */
  signInRefused: boolean;
  failed: string;
  crashed: boolean;
  /** In the window's view tree (only while shown: a hidden view is not composited). */
  attached: boolean;
  /** The one-shot CPU check of a hidden view (checkHidden). */
  check: NodeJS.Timeout | undefined;
}

const entries = new Map<string, Entry>();
/** Sign-in popups and same-site windows an app opened, by app. */
const children = new Map<string, Set<BrowserWindow>>();
let lru: string[] = [];
/** The app the renderer shows now; null = none (rooms, an overlay over the app). */
let shown: string | null = null;
let bounds: ViewBounds = { x: 0, y: 0, width: 0, height: 0 };
/** Main windows whose show / hide / minimize we follow. */
const followed = new WeakSet<BrowserWindow>();

// ---------------------------------------------------------------- remembered permissions

/**
 * Remembered answers by app, then by the site's origin: a view may navigate to any https site
 * (SSO, links), so a camera granted to the app's own site must not carry over to another one.
 */
type PermFile = Record<string, Record<string, Remembered>>;
let perms: PermFile | null = null;
const permPath = (): string => join(app.getPath('userData'), 'web-app-permissions.json');

function loadPerms(): PermFile {
  if (perms) return perms;
  try {
    perms = JSON.parse(readFileSync(permPath(), 'utf8')) as PermFile;
  } catch {
    perms = {};
  }
  return perms;
}

function savePerms(): void {
  try {
    writeFileSync(permPath(), JSON.stringify(perms ?? {}));
  } catch (e) {
    log.warn('[webapp] could not save permissions', e);
  }
}

function remembered(appId: string, origin: string): Remembered {
  if (!origin) return {};
  const byOrigin = loadPerms()[appId];
  const r = byOrigin && typeof byOrigin === 'object' ? byOrigin[origin] : undefined;
  return r && typeof r === 'object' ? r : {};
}

function remember(appId: string, origin: string, kinds: readonly AskKind[], granted: boolean): void {
  if (!origin) return;
  const all = loadPerms();
  const byOrigin = { ...(all[appId] ?? {}) };
  const cur = { ...(byOrigin[origin] ?? {}) };
  for (const k of kinds) cur[k] = granted;
  byOrigin[origin] = cur;
  all[appId] = byOrigin;
  savePerms();
}

// ---------------------------------------------------------------- sessions

const configured = new WeakSet<Session>();
/** One consent dialog at a time per app (a site asking for camera and mic in a row). */
const askChain = new Map<string, Promise<unknown>>();

function appIdOf(ses: Session): string | null {
  for (const e of entries.values()) if (e.view.webContents.session === ses) return e.appId;
  for (const [id, set] of children) for (const w of set) if (!w.isDestroyed() && w.webContents.session === ses) return id;
  return null;
}

/** The request comes from what the user sees: the shown view, or a visible popup of it. */
function inForeground(wc: WebContents, appId: string): boolean {
  const e = entries.get(appId);
  if (e && e.view.webContents === wc) return shown === appId && windowShown();
  const win = BrowserWindow.fromWebContents(wc);
  return !!win && !win.isDestroyed() && win.isVisible() && (children.get(appId)?.has(win) ?? false);
}

const KIND_STRING: Record<AskKind, keyof ReturnType<typeof mainStrings>> = {
  camera: 'webAppCamera',
  microphone: 'webAppMicrophone',
  notifications: 'webAppNotifications',
  geolocation: 'webAppGeolocation',
  'clipboard-read': 'webAppClipboard',
};

async function askUser(appId: string, origin: string, site: string, kinds: readonly AskKind[]): Promise<boolean> {
  const s = mainStrings();
  const what = kinds.map((k) => s[KIND_STRING[k]]).join(', ');
  const parent = getMainWindow();
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    message: s.webAppAsk.replace('{site}', site || '—').replace('{what}', what),
    detail: s.webAppAskDetail,
    buttons: [s.webAppAllow, s.webAppDeny],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  const granted = r.response === 0;
  remember(appId, origin, kinds, granted);
  log.info('[webapp] permission', { appId, origin, kinds, granted });
  return granted;
}

function configureSession(ses: Session): void {
  if (configured.has(ses)) return;
  configured.add(ses);
  // Sites (Google sign-in above all) refuse embedded browsers by the Electron token: present the
  // plain Chromium user agent.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Calaba?)\/\S+/gi, ''));
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const appId = appIdOf(ses);
    const d = permissionDecision(permission, 'mediaTypes' in details ? (details.mediaTypes ?? []) : []);
    if (!appId || d.kind === 'deny') {
      callback(false);
      return;
    }
    if (d.kind === 'allow') {
      callback(true);
      return;
    }
    // Remembered per origin of the requesting page (a frame asks with its own origin).
    const origin = originOf(details.requestingUrl || wc.getURL());
    const r = resolveWithRemembered(d.ask, remembered(appId, origin));
    if ('grant' in r) {
      callback(r.grant);
      return;
    }
    // A background view or a hidden popup never raises a dialog.
    if (!origin || !inForeground(wc, appId)) {
      callback(false);
      return;
    }
    const site = hostOf(details.requestingUrl || wc.getURL());
    const prev = askChain.get(appId) ?? Promise.resolve();
    const next = prev
      .then(() => {
        // Answered meanwhile (the same site asked twice)?
        const again = resolveWithRemembered(r.ask, remembered(appId, origin));
        return 'grant' in again ? again.grant : askUser(appId, origin, site, r.ask);
      })
      .then(callback, (e: unknown) => {
        log.warn('[webapp] permission dialog failed', e);
        callback(false);
      });
    askChain.set(appId, next);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const appId = appIdOf(ses);
    const origin = originOf(requestingOrigin || details.requestingUrl || '');
    return !!appId && permissionCheck(permission, details.mediaType === 'unknown' ? undefined : details.mediaType, remembered(appId, origin));
  });
  // Screen capture, HID / serial / USB / Bluetooth devices: never.
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}));
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (e, _d, cb) => {
    e.preventDefault();
    cb();
  });
  ses.on('select-serial-port', (e, _p, _wc, cb) => {
    e.preventDefault();
    cb('');
  });
  ses.on('select-usb-device', (e, _d, cb) => {
    e.preventDefault();
    cb();
  });
  // Downloads: the OS save dialog (Chromium's default without a save path), in ~/Downloads by
  // default; the saved file is marked as downloaded from the Internet (downloads.ts).
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), safeFileName(item.getFilename() || 'download')) });
    const origin = (() => {
      try {
        return new URL(item.getURL()).origin;
      } catch {
        return '';
      }
    })();
    item.once('done', (_ev, state) => {
      if (state === 'completed' && item.getSavePath()) void markFromInternet(item.getSavePath(), origin);
    });
  });
}

// ---------------------------------------------------------------- guards of app webContents

/** Guards of every webContents in an app session (views and their popups; ADR-0050 §4). */
function guardAppContents(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (mayNavigate(url)) return;
    e.preventDefault();
    // A plain-http link to a public site: the browser, not Calab.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (!mayNavigate(url)) e.preventDefault();
  });
  wc.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !mayNavigateFrame(e.url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // Web Bluetooth: without preventDefault Electron picks the first device found.
  wc.on('select-bluetooth-device', (e, _devices, cb) => {
    e.preventDefault();
    cb('');
  });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const d = windowOpenDecision(wc.getURL(), url, disposition);
    if (d === 'external') {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    }
    if (d === 'deny') return { action: 'deny' };
    const popup = disposition === 'new-window';
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: popup ? 520 : 1100,
        height: popup ? 700 : 800,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: viewPreferences(wc.session),
      },
    };
  });
  wc.on('did-create-window', (win) => {
    const appId = appIdOf(wc.session);
    if (!appId) {
      win.close();
      return;
    }
    const set = children.get(appId) ?? new Set<BrowserWindow>();
    set.add(win);
    children.set(appId, set);
    win.on('closed', () => set.delete(win));
  });
  wc.on('context-menu', (_e, params) => {
    const host = BrowserWindow.fromWebContents(wc) ?? getMainWindow();
    Menu.buildFromTemplate(contextMenu(wc, params)).popup(host ? { window: host } : {});
  });
}

function contextMenu(wc: WebContents, p: ContextMenuParams): MenuItemConstructorOptions[] {
  const s = mainStrings();
  const items: MenuItemConstructorOptions[] = [];
  const link = /^https?:\/\//i.test(p.linkURL) ? p.linkURL : '';
  if (link) {
    items.push({ label: s.webAppOpenLink, click: () => void shell.openExternal(link) });
    items.push({ label: s.webAppCopyLink, click: () => void clipboard.writeText(link) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ label: s.menuCut, role: 'cut', enabled: p.editFlags.canCut });
    items.push({ label: s.menuCopy, role: 'copy', enabled: p.editFlags.canCopy });
    items.push({ label: s.menuPaste, role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ label: s.menuSelectAll, role: 'selectAll' });
    items.push({ type: 'separator' });
  } else if (p.selectionText) {
    items.push({ label: s.menuCopy, role: 'copy' });
    items.push({ type: 'separator' });
  }
  const nav = wc.navigationHistory;
  items.push({ label: s.webAppBack, enabled: nav.canGoBack(), click: () => nav.goBack() });
  items.push({ label: s.webAppForward, enabled: nav.canGoForward(), click: () => nav.goForward() });
  items.push({ label: s.webAppReload, click: () => wc.reload() });
  const page = wc.getURL();
  if (/^https?:\/\//i.test(page)) items.push({ label: s.webAppOpenPage, click: () => void shell.openExternal(page) });
  return items;
}

/** webPreferences of a view and of the windows it opens (ADR-0050 §4). */
function viewPreferences(ses: Session): Electron.WebPreferences {
  return {
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // Unlike our own page: a hidden site is throttled (docs/14).
    backgroundThrottling: true,
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: true,
    autoplayPolicy: 'document-user-activation-required',
  };
}

export function installWebAppGuards(): void {
  app.on('web-contents-created', (_e, wc) => {
    if (isAppSession(wc.session)) guardAppContents(wc);
  });
}

// ---------------------------------------------------------------- sign-in with the Calab session

/**
 * ADR-0159: the app's site sends the user to «Sign in with Calab» of the app's own workspace.
 * Instead of the Calab sign-in form inside the site's isolated session, main asks the provider
 * with the Calab session it holds: a remembered consent gives a code at once, otherwise the user
 * answers a Calab dialog. The site gets only the provider's redirect to its own redirect_uri;
 * the Calab token and cookies never enter the site's session. Any other outcome loads the
 * site's request as before (the provider then shows its own sign-in).
 */
function interceptSignIn(e: Entry, url: string, prevent: () => void): void {
  const server = currentServerUrl();
  const req = server ? workspaceSignIn(url, server, e.workspaceId, e.home) : null;
  if (!req || e.signInRefused) return;
  if (e.signingIn) {
    prevent();
    return;
  }
  const now = Date.now();
  if (!signInAllowed(e.signIns, now)) {
    log.warn('[webapp] calab sign-in repeated too often: left to the site', { appId: e.appId });
    return;
  }
  e.signIns = [...e.signIns.filter((t) => now - t < 60_000), now];
  e.signingIn = true;
  prevent();
  void answerSignIn(e, server, req)
    .catch((err: unknown) => {
      log.warn('[webapp] calab sign-in failed', { appId: e.appId, err: err instanceof Error ? err.message : String(err) });
      return null;
    })
    .then((answer) => {
      e.signingIn = false;
      if (entries.get(e.appId) !== e || e.view.webContents.isDestroyed()) return;
      void e.view.webContents.loadURL(answer ?? req.interactive).catch(() => undefined);
    });
}

const SIGN_IN_TIMEOUT_MS = 15_000;

async function answerSignIn(e: Entry, server: string, req: WorkspaceSignIn): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const ses = apiSession();
  // net.fetch rejects a manual redirect («Redirect was cancelled»): the provider answers with a
  // 303, so its Location is read from net.request's redirect event and the request is dropped.
  // The session keeps the Set-Cookie of that answer (the consent request's browser binding).
  // The silent request is the bearer alone: a cookie of another Calab account in the API session
  // would make the provider refuse it. The consent request needs the jar for its binding.
  const authorize = (url: string, withCookies: boolean): Promise<string | null> =>
    new Promise((resolve) => {
      const r = net.request({ url, session: ses, redirect: 'manual', credentials: withCookies ? 'include' : 'omit', useSessionCookies: withCookies });
      const done = (v: string | null): void => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        r.abort();
        done(null);
      }, SIGN_IN_TIMEOUT_MS);
      r.setHeader('Authorization', `Bearer ${token}`);
      r.on('redirect', (_status, _method, location) => {
        done(location);
        r.abort();
      });
      r.on('response', () => {
        done(null);
        r.abort();
      });
      r.on('error', () => done(null));
      r.end();
    });
  const answer = signInAnswer(await authorize(req.silent, false), server, req.redirectUri);
  log.info('[webapp] calab sign-in', { appId: e.appId, answer: answer.kind });
  if (answer.kind === 'code') return answer.url;
  // A consent is asked only about what the user is looking at.
  if (answer.kind !== 'consent' || !inForeground(e.view.webContents, e.appId)) return null;
  // The consent request is bound to the API session's cookie jar (its browser binding).
  const handle = consentRequest(await authorize(req.interactive, true), server);
  if (!handle) return null;
  const post = async (what: 'bind' | 'decision', body: object): Promise<Record<string, unknown> | null> => {
    const res = await ses.fetch(new URL(`/api/oauth/requests/${encodeURIComponent(handle)}/${what}`, server).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: new URL(server).origin },
      body: JSON.stringify(body),
      redirect: 'manual',
      // Each call its own time: the dialog between bind and decision waits for the person.
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
    const json = res.ok ? ((await res.json()) as unknown) : (await res.arrayBuffer().catch(() => undefined), null);
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  };
  const shown = await post('bind', { csrfToken: handle });
  const csrf = shown?.['csrfToken'];
  if (!shown || typeof csrf !== 'string') return null;
  const allow = await askSignIn(shown, hostOf(req.redirectUri));
  if (!allow) e.signInRefused = true;
  const decided = await post('decision', { csrfToken: csrf, allow, allowRefresh: false });
  const redirect = decided?.['redirectUrl'];
  log.info('[webapp] calab sign-in consent', { appId: e.appId, allow });
  return typeof redirect === 'string' && sameEndpoint(redirect, req.redirectUri) ? redirect : null;
}

/** How long the Calab dialog waits for an answer: then it closes and counts as «Deny». */
const ASK_TIMEOUT_MS = 120_000;

let pendingAsk: { id: string; settle: (allow: boolean) => void } | null = null;

/**
 * The consent in a Calab dialog of the main window (renderer: features/webapps/AppSignIn). The
 * renderer only shows the server's texts and returns «Allow» / «Deny»; no answer in two minutes,
 * no main window, or a second ask while one is open — «Deny».
 */
function askSignIn(shown: Record<string, unknown>, site: string): Promise<boolean> {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || pendingAsk) return Promise.resolve(false);
  const text = (k: string): string => {
    const v = shown[k];
    return typeof v === 'string' ? v.slice(0, 200) : '';
  };
  const scopes = Array.isArray(shown['scopes']) ? shown['scopes'].filter((v): v is string => typeof v === 'string').slice(0, 20) : [];
  const ask: WebAppSignInAsk = {
    id: randomUUID(),
    client: text('clientName'),
    workspace: text('workspaceName'),
    account: text('displayName'),
    site,
    scopes,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(false), ASK_TIMEOUT_MS);
    const settle = (allow: boolean): void => {
      if (pendingAsk?.id !== ask.id) return;
      pendingAsk = null;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.webContents.send(IPC.webAppSignInAsk, null);
      resolve(allow);
    };
    pendingAsk = { id: ask.id, settle };
    win.webContents.send(IPC.webAppSignInAsk, ask);
  });
}

/** The person's answer from the main window's dialog; an unknown or stale id is ignored. */
export function answerSignInAsk(id: string, allow: boolean): void {
  if (pendingAsk?.id === id) pendingAsk.settle(allow);
}

// ---------------------------------------------------------------- views

function windowShown(): boolean {
  const win = getMainWindow();
  return !!win && isShown(win);
}

function sendState(e: Entry): void {
  const win = getMainWindow();
  if (!win || e.view.webContents.isDestroyed()) return;
  const wc = e.view.webContents;
  const state: WebAppNavState = {
    appId: e.appId,
    url: wc.getURL() || e.home,
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
    failed: e.failed,
    crashed: e.crashed,
  };
  win.webContents.send(IPC.webAppState, state);
}

/** A hidden view whose page keeps using more than this share of one core is unloaded (ADR-0050 §5). */
const HIDDEN_CPU_LIMIT = 2;
/** When a hidden page is checked once (a one-shot timer per hide, nothing periodic). */
const HIDDEN_CHECK_MS = 15_000;

/** CPU of process `pid` in % of one core since the previous app.getAppMetrics() (null = gone). */
function cpuOf(pid: number): number | null {
  const m = app.getAppMetrics().find((x) => x.pid === pid);
  // percentCPUUsage is normalised to all cores on macOS (see ipc.ts systemMetrics).
  return m ? m.cpu.percentCPUUsage * (process.platform === 'darwin' ? cpus().length : 1) : null;
}

/**
 * Electron cannot make a WebContentsView's page hidden: neither `setVisible(false)` nor taking
 * it out of the window changes `document.visibilityState`, so a hidden page keeps its timers,
 * animations and videos (measured 30.09: github.com's home 7–8 % of a core hidden, Wikipedia
 * 0.01 %). A hidden view is therefore checked once, 15 s after it was hidden: still above 2 %
 * of a core → it is unloaded (its session stays; the next open loads the page again).
 */
function checkHidden(e: Entry): void {
  clearTimeout(e.check);
  const pid = e.view.webContents.getOSProcessId();
  cpuOf(pid); // starts the measuring window
  e.check = setTimeout(() => {
    e.check = undefined;
    if (entries.get(e.appId) !== e || e.attached || e.view.webContents.isDestroyed()) return;
    const cpu = cpuOf(pid);
    if (cpu !== null && cpu > HIDDEN_CPU_LIMIT) {
      log.info('[webapp] hidden page keeps the CPU busy: unloaded', { appId: e.appId, cpu: Math.round(cpu * 10) / 10 });
      destroy(e.appId);
    }
  }, HIDDEN_CHECK_MS);
}

/**
 * Shows the view the renderer wants (if the window is on screen and the page is fine); the rest
 * are taken out of the window (not composited, no input) and checked for CPU (checkHidden).
 */
function applyVisibility(): void {
  const on = windowShown();
  const win = getMainWindow();
  let anyVisible = false;
  let changed = false;
  for (const e of entries.values()) {
    const visible = !!win && on && e.appId === shown && !e.failed && !e.crashed && bounds.width > 0 && bounds.height > 0;
    if (visible) {
      clearTimeout(e.check);
      e.check = undefined;
      anyVisible = true;
      if (!e.attached) {
        win.contentView.addChildView(e.view);
        e.attached = true;
        changed = true;
      }
      e.view.setBounds(bounds);
      e.view.setVisible(true);
    } else if (e.attached) {
      // Keyboard focus in the site goes with it to Calab's page: otherwise no page has focus, and a
      // menu opened over the app (Radix highlights the item under the pointer by focusing it)
      // shows no highlight and takes no arrow keys.
      const hadFocus = !e.view.webContents.isDestroyed() && e.view.webContents.isFocused();
      e.view.setVisible(false);
      try {
        win?.contentView.removeChildView(e.view);
      } catch {
        // the window is gone
      }
      if (hadFocus && win && !win.isDestroyed()) win.webContents.focus();
      e.attached = false;
      changed = true;
      if (!e.failed && !e.crashed) checkHidden(e);
    }
  }
  // A tooltip drawn over the app (tipOverlay.ts) goes with it; a newly attached view would be
  // above it — the next show raises the overlay again.
  if (changed || !anyVisible) hideTip();
}

/** An app view is on screen now: tooltips over it may be drawn by the overlay. */
export function appViewShown(): boolean {
  for (const e of entries.values()) if (e.attached) return true;
  return false;
}

function follow(win: BrowserWindow): void {
  if (followed.has(win)) return;
  followed.add(win);
  win.on('show', applyVisibility);
  win.on('hide', applyVisibility);
  win.on('minimize', applyVisibility);
  win.on('restore', applyVisibility);
  // Our page reloaded (a server change, ⌘R in dev) or crashed: it no longer shows an app.
  win.webContents.on('did-navigate', hideApp);
  win.webContents.on('render-process-gone', hideApp);
  win.on('closed', () => {
    for (const id of [...entries.keys()]) destroy(id);
    shown = null;
  });
}

function create(appId: string, url: string, workspaceId: string): Entry | null {
  const win = getMainWindow();
  if (!win) return null;
  follow(win);
  const ses = session.fromPartition(partitionOf(appId));
  markAppSession(ses); // before the webContents exists: web-contents-created sees an app session
  configureSession(ses);
  const view = new WebContentsView({ webPreferences: viewPreferences(ses) });
  // CSS overflow on the renderer placeholder cannot clip this native layer.
  // Match --radius-panel at the native compositing boundary as well.
  view.setBorderRadius(12);
  view.setVisible(false);
  view.setBackgroundColor('#ffffff');
  const e: Entry = { appId, view, home: url, workspaceId, signIns: [], signingIn: false, signInRefused: false, failed: '', crashed: false, attached: false, check: undefined };
  entries.set(appId, e);
  const wc = view.webContents;
  const update = (): void => sendState(e);
  wc.on('did-start-loading', () => {
    if (e.failed) {
      e.failed = '';
      applyVisibility();
    }
    update();
  });
  // No toolbar (ADR-0050 «Уточнение»): ⌘/Ctrl+[ ] and ⌘/Ctrl+R drive the focused view.
  wc.on('before-input-event', (ev, input) => {
    const action = navShortcut(input, process.platform === 'darwin');
    if (!action) return;
    ev.preventDefault();
    navigateApp(action);
  });
  // «Sign in with Calab» of the app's own workspace is answered with the Calab session (ADR-0159).
  wc.on('will-redirect', (ev) => {
    if (ev.isMainFrame) interceptSignIn(e, ev.url, () => ev.preventDefault());
  });
  wc.on('will-navigate', (ev) => {
    if (ev.isMainFrame) interceptSignIn(e, ev.url, () => ev.preventDefault());
  });
  // A new page: a picture taken ahead is of the old one.
  wc.on('did-start-loading', () => {
    if (still?.appId === appId) still = null;
  });
  wc.on('did-stop-loading', update);
  wc.on('did-navigate', update);
  wc.on('did-navigate-in-page', update);
  wc.on('page-title-updated', update);
  wc.on('did-fail-load', (_ev, code, description, _url, isMainFrame) => {
    // -3 = ABORTED (a new navigation replaced this one).
    if (!isMainFrame || code === -3) return;
    e.failed = description || String(code);
    applyVisibility();
    update();
  });
  wc.on('render-process-gone', (_ev, details) => {
    log.warn('[webapp] page process gone', { appId, reason: details.reason });
    e.crashed = true;
    applyVisibility();
    update();
  });
  void wc.loadURL(url).catch(() => undefined); // failures arrive as did-fail-load
  return e;
}

function destroy(appId: string): void {
  const e = entries.get(appId);
  if (!e) return;
  entries.delete(appId);
  if (still?.appId === appId) still = null;
  clearTimeout(e.check);
  lru = dropLru(lru, appId);
  if (e.attached) {
    try {
      getMainWindow()?.contentView.removeChildView(e.view);
    } catch {
      // the window is gone
    }
  }
  if (!e.view.webContents.isDestroyed()) e.view.webContents.close();
}

/** Show app `appId` at `b` (window DIPs); `url` is its address (loaded on first open or when it changed). */
export function openApp(appId: string, url: string, workspaceId: string, b: ViewBounds): void {
  const checked = validateAppUrl(url);
  if (!checked.ok) throw new Error('invalid app url');
  bounds = b;
  let e = entries.get(appId);
  if (e?.crashed) {
    destroy(appId);
    e = undefined;
  }
  if (!e) {
    e = create(appId, checked.url, workspaceId) ?? undefined;
    if (!e) return;
  } else if (e.home !== checked.url) {
    e.home = checked.url;
    e.failed = '';
    void e.view.webContents.loadURL(checked.url).catch(() => undefined);
  } else if (e.failed) {
    // Coming back to an app whose page did not load tries it again (a site restarting for a minute).
    const wc = e.view.webContents;
    const cur = wc.getURL();
    void wc.loadURL(cur && !cur.startsWith('chrome-error:') ? cur : e.home).catch(() => undefined);
  }
  e.workspaceId = workspaceId;
  const t = touchLru(lru, appId);
  lru = t.order;
  for (const id of t.evicted) destroy(id);
  shown = appId;
  applyVisibility();
  sendState(e);
}

/** A picture older than this is taken again when an overlay opens. */
const STILL_MAX_AGE_MS = 30_000;

let still: { appId: string; at: number; url: Promise<string> } | null = null;

function capture(e: Entry): Promise<string> {
  return e.view.webContents.capturePage().then(
    (img) => (img.isEmpty() ? '' : `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}`),
    () => '',
  );
}

/**
 * A capture waits for the site's next frame — about half a second on an idle page, the whole
 * open animation of a menu. So the picture is taken ahead, when the pointer comes back from the
 * site to Calab (where the next menu opens), and kept for the shown app.
 */
export function prepareSnapshot(): void {
  const e = shown ? entries.get(shown) : undefined;
  if (!e || e.view.webContents.isDestroyed() || !e.attached) return;
  if (still?.appId === e.appId && Date.now() - still.at < 1000) return;
  still = { appId: e.appId, at: Date.now(), url: capture(e) };
}

/**
 * A still picture of the shown app, for the renderer to lay in its place while a menu or dialog of
 * Calab is open and the view steps aside (ADR-0053 «Поправка 2»): the site looks as it was instead
 * of an empty area. Pixels only, kept in the renderer's memory while the overlay is open; nothing
 * of the site's DOM is read. '' when there is nothing to show.
 */
export function snapshotApp(): Promise<string> {
  const e = shown ? entries.get(shown) : undefined;
  if (!e || e.view.webContents.isDestroyed() || !e.attached) return Promise.resolve('');
  if (still?.appId !== e.appId || Date.now() - still.at > STILL_MAX_AGE_MS) still = { appId: e.appId, at: Date.now(), url: capture(e) };
  return still.url;
}

export function hideApp(): void {
  shown = null;
  applyVisibility();
}

export function setAppBounds(b: ViewBounds): void {
  bounds = b;
  if (shown) applyVisibility();
}

/**
 * ◀ ▶ ⟳ of the shown app, or of `appId` — the rail's «Перезагрузить» comes while its menu is still
 * open and the view is hidden under it, so «the shown app» would be none.
 */
export function navigateApp(action: WebAppNavAction, appId?: string): void {
  const id = appId ?? shown;
  const e = id ? entries.get(id) : undefined;
  if (!e) return;
  const wc = e.view.webContents;
  if (action === 'reload' && e.crashed) {
    const { home, workspaceId } = e;
    destroy(e.appId);
    // A hidden app comes back fresh on its next open (the renderer opens it when the menu goes).
    if (shown === e.appId) openApp(e.appId, home, workspaceId, bounds);
    return;
  }
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') {
    // After a failed load the error page is not the address: load the page that failed again.
    if (e.failed) void wc.loadURL(wc.getURL() && !wc.getURL().startsWith('chrome-error:') ? wc.getURL() : e.home).catch(() => undefined);
    else wc.reload();
  }
}

/** «Открыть в браузере»: the shown app's current page (its address if the page did not load). */
export function openAppExternal(): void {
  const e = shown ? entries.get(shown) : undefined;
  if (!e) return;
  const cur = e.view.webContents.getURL();
  const url = /^https?:\/\//i.test(cur) ? cur : e.home;
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** The app was deleted: its view, popups, site data and remembered permissions go. */
export async function forgetApp(appId: string): Promise<void> {
  if (shown === appId) shown = null;
  destroy(appId);
  for (const w of children.get(appId) ?? []) if (!w.isDestroyed()) w.close();
  children.delete(appId);
  const all = loadPerms();
  if (appId in all) {
    delete all[appId];
    savePerms();
  }
  await clearPartition(partitionOf(appId));
}

async function clearPartition(partition: string): Promise<void> {
  try {
    const ses = session.fromPartition(partition);
    await Promise.all([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]);
  } catch (e) {
    log.warn('[webapp] could not clear site data', partition, e);
  }
}

/**
 * The Calab session ended (logout, revoked, expired): every view and popup closes and the site
 * data of every app on this device is cleared — the next account must not find the previous
 * one's site logins.
 */
export async function forgetAllApps(): Promise<void> {
  shown = null;
  for (const id of [...entries.keys()]) destroy(id);
  for (const set of children.values()) for (const w of set) if (!w.isDestroyed()) w.close();
  children.clear();
  perms = {};
  savePerms();
  const dir = join(app.getPath('userData'), 'Partitions');
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^app-[0-9a-f-]{36}$/.test(n));
  } catch {
    return;
  }
  await Promise.all(names.map((n) => clearPartition(`persist:${n}`)));
}
