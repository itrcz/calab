import { app, BrowserWindow, session, WebContentsView, type Session, type WebContents } from 'electron';
import log from 'electron-log/main';
import type { CheckoutWindowOutcome } from '../shared/ipc';
import { markCheckoutSession } from './appSessions';
import { currentServerUrl } from './auth';
import { addressOf, BAR_HEIGHT, barHtml, CANCEL_URL, checkoutNavigation, isSbpAppLink, mayNavigateCheckout, returnOutcome } from './checkoutPolicy';
import { mainStrings } from './strings';

/**
 * The in-app checkout window (ADR-0084): the provider's hosted checkout (Stripe Checkout, a Tochka
 * payment link) in a modal child window of the main one — a sheet on macOS — instead of the system
 * browser. The window holds two views:
 * - the title bar (the window's own webContents): lock + provider host + «Отмена», static HTML
 *   with JavaScript off, in its own in-memory session;
 * - the provider page (a WebContentsView): no preload, sandbox, context isolation, no Node, a
 *   fresh in-memory session per checkout (no cookies or card data outlive the window), all
 *   permission requests, downloads, devices and new windows refused, DevTools only unpackaged.
 * The start URL is checked by the IPC handler (checkoutPolicy.parseCheckoutStart). The page may
 * then go anywhere over https (card 3DS), SBP bank-app links are refused (the payer scans the QR
 * with the phone), nothing is handed to the OS, and reaching a return
 * URL closes the window. No payment data reaches our code: the outcome is only a hint, the
 * renderer polls the checkout for the truth.
 */

let current: { win: BrowserWindow; finish: (o: CheckoutWindowOutcome) => void } | null = null;

const DEV_TOOLS = !app.isPackaged;

/** One in-memory session for checkout pages (no `persist:`), wiped whenever a window closes. */
const PAGE_PARTITION = 'checkout';
const configured = new WeakSet<Session>();

function pageSession(): Session {
  const ses = session.fromPartition(PAGE_PARTITION, { cache: false });
  if (!configured.has(ses)) {
    configured.add(ses);
    configurePageSession(ses);
  }
  return ses;
}

function configurePageSession(ses: Session): void {
  markCheckoutSession(ses);
  // Banks' 3DS pages and Tochka's page may refuse an embedded browser by the Electron token.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Calaba?)\/\S+/gi, ''));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}));
  ses.on('will-download', (e) => e.preventDefault());
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
  // Belt and braces under mayNavigateCheckout: no plain-http request at all (mixed content,
  // a redirect hop) leaves this session.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (_d, cb) => cb({ cancel: true }));
}

function pagePreferences(ses: Session): Electron.WebPreferences {
  return {
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: DEV_TOOLS,
  };
}

/** The guards of the provider page (main frame, frames, new windows). */
function guardPage(wc: WebContents, done: (o: CheckoutWindowOutcome) => void): void {
  const serverUrl = currentServerUrl();
  const onMain = (e: Electron.Event, url: string): void => {
    const d = checkoutNavigation(url, serverUrl);
    if (d.kind === 'load') return;
    e.preventDefault();
    if (d.kind === 'return') done(d.outcome);
    // SBP on the desktop: the payer scans the page's QR with the phone, the window stays on it.
    else log.info('[checkout] navigation kept on the page', { sbp: isSbpAppLink(url) });
  };
  wc.on('will-navigate', onMain);
  wc.on('will-redirect', (e) => {
    if (e.isMainFrame) onMain(e, e.url);
    else if (!mayNavigateCheckout(e.url)) e.preventDefault();
  });
  wc.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !mayNavigateCheckout(e.url)) e.preventDefault();
  });
  // A return page reached some other way (history, a server-side hop we did not see).
  wc.on('did-navigate', (_e, url) => {
    const back = returnOutcome(url, serverUrl);
    if (back) done(back);
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // A TLS client certificate (a bank-client token, a corporate cert) is never offered to the
  // page: Electron's default picks the first one silently, and the page may be any https host.
  wc.on('select-client-certificate', (e, _url, _list, cb) => {
    e.preventDefault();
    // No argument = continue without a certificate (Electron's binding; the typings demand one).
    (cb as () => void)();
  });
  wc.on('select-bluetooth-device', (e, _devices, cb) => {
    e.preventDefault();
    cb('');
  });
  // New windows: none, and nothing is handed to the OS (an SBP bank-app link included).
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function barUrl(address: { host: string; secure: boolean }): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(barHtml(address, mainStrings().checkoutCancel))}`;
}

/**
 * Opens `url` (already checked against the start allowlist) over `parent`. Resolves when the
 * window is gone, once. A second checkout replaces the first (that one resolves `closed`).
 */
export function openCheckoutWindow(parent: BrowserWindow, url: string): Promise<CheckoutWindowOutcome> {
  current?.finish('closed');
  return new Promise((resolve) => {
    const ses = pageSession();
    const barSession = session.fromPartition('checkout-bar', { cache: false });
    const win = new BrowserWindow({
      parent,
      modal: true,
      show: false,
      width: 520,
      height: 760,
      minWidth: 400,
      minHeight: 520,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: mainStrings().checkoutTitle,
      backgroundColor: '#ffffff',
      webPreferences: { session: barSession, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false, spellcheck: false },
    });
    const page = new WebContentsView({ webPreferences: pagePreferences(ses) });
    page.setBackgroundColor('#ffffff');
    win.contentView.addChildView(page);
    const layout = (): void => {
      const [w = 0, h = 0] = win.getContentSize();
      page.setBounds({ x: 0, y: BAR_HEIGHT, width: w, height: Math.max(0, h - BAR_HEIGHT) });
    };
    layout();
    win.on('resize', layout);

    let outcome: CheckoutWindowOutcome | null = null;
    const finish = (o: CheckoutWindowOutcome): void => {
      if (outcome) return;
      outcome = o;
      if (!win.isDestroyed()) win.close();
    };
    current = { win, finish };
    guardPage(page.webContents, finish);

    // The title bar: «Отмена» is a link main catches; the host follows the page.
    const bar = win.webContents;
    bar.on('will-navigate', (e, to) => {
      e.preventDefault();
      if (to === CANCEL_URL) finish('closed');
    });
    // Shift/middle-click on «Отмена» would open a window (windows.ts would hand it to the OS).
    bar.setWindowOpenHandler(() => ({ action: 'deny' }));
    let shownHost = '';
    const showAddress = (to: string): void => {
      const a = addressOf(to);
      const key = `${a.secure}|${a.host}`;
      if (key === shownHost || !a.host) return;
      shownHost = key;
      void bar.loadURL(barUrl(a)).catch(() => undefined);
    };
    // Only a committed main-frame navigation moves the host: a pending one may never commit (a
    // 204, a refused redirect) and would leave another host's name over the current page.
    page.webContents.on('did-navigate', (_e, to) => showAddress(to));
    // Cmd/Ctrl+W and Esc in the title bar or the page close the window like «Отмена».
    const onKey = (e: Electron.Event, input: Electron.Input): void => {
      if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'w') {
        e.preventDefault();
        finish('closed');
      }
    };
    bar.on('before-input-event', onKey);
    page.webContents.on('before-input-event', onKey);

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (current?.win === win) current = null;
      if (!page.webContents.isDestroyed()) page.webContents.close();
      // In memory anyway; cleared at once so nothing of the payment lingers until quit — unless
      // a newer checkout already uses the session.
      if (!current) {
        void ses.clearStorageData().catch(() => undefined);
        void ses.clearCache().catch(() => undefined);
      }
      resolve(outcome ?? 'closed');
    });

    showAddress(url);
    page.webContents.loadURL(url).catch((err: unknown) => {
      // ERR_ABORTED is a redirect we refused or the window closing; anything else stays on screen.
      log.warn('[checkout] page load failed', err instanceof Error ? err.message : err);
    });
    log.info('[checkout] window opened', { host: addressOf(url).host });
  });
}
