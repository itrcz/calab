import { join } from 'node:path';
import { app, BrowserWindow, powerMonitor, session } from 'electron';
import { IPC, type PowerEvent } from '../shared/ipc';
import { handleApiScheme, registerApiScheme } from './apiProtocol';
import { installDisplayMediaHandler, MAC_SYSTEM_AUDIO_FEATURES, macSystemAudioEnabled } from './capture';
import { findDeepLink, handleDeepLink, registerProtocolClient } from './deeplink';
import { registerIpc } from './ipc';
import { initLogging, log } from './logging';
import { recoverCapsRemap } from './capsRemap';
import { installRendererCsp } from './csp';
import { applyDevDockIcon } from './icons';
import { resetPttGate, shutdownPtt } from './ptt';
import { createTray } from './tray';
import { startUpdates } from './updater';
import { createMainWindow, getMainWindow, installWebContentsGuards, isOwnOrigin, isOwnPage, showMainWindow } from './windows';

// The product is «Calab» (docs/10), but installed builds keep their data under the old name:
// userData (session, settings, logs) and the macOS Keychain item «Calaba Safe Storage» that
// safeStorage derives from app.name when Chromium starts. So main starts as «Calaba» and switches
// the visible name (menus, About) to productName once `ready`; both are fixed by then.
const PRODUCT_NAME = app.name;
app.setName('Calaba');
app.setPath('userData', join(app.getPath('appData'), 'Calaba'));
app.once('ready', () => app.setName(PRODUCT_NAME));
// Windows: the AUMID must equal the NSIS shortcuts' appId (electron-builder.yml, permanent) or
// toasts are attributed to another app / dropped. Electron's default derives it from the name.
if (process.platform === 'win32') app.setAppUserModelId('app.calaba.desktop');
// Tests/automation may run several isolated instances side by side.
if (process.env['CALABA_USER_DATA']) app.setPath('userData', process.env['CALABA_USER_DATA']);

initLogging();

// ---- single instance: a second launch (or a deep link on Windows/Linux) focuses us ----
if (process.env['CALABA_MULTI_INSTANCE'] !== '1' && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showMainWindow();
    const link = findDeepLink(argv);
    if (link) handleDeepLink(link);
  });
}
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});
registerProtocolClient();

// ---- Chromium switches: must be set before `ready` ----
const features: string[] = [];
if (macSystemAudioEnabled()) features.push(...MAC_SYSTEM_AUDIO_FEATURES);
if (features.length > 0) app.commandLine.appendSwitch('enable-features', features.join(','));

// Test/automation only: synthetic mic (beep), no OS permission prompts.
if (process.env['CALABA_FAKE_MEDIA'] === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

registerApiScheme();
// Every webContents (main window, stream pop-outs, anything created later) gets the same
// navigation / window.open / <webview> guards (review L12).
installWebContentsGuards();

const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'speaker-selection', 'fullscreen', 'notifications', 'clipboard-sanitized-write']);

function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isOwnPage(wc.getURL()) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler(
    (wc, permission, origin) => isOwnOrigin(origin, wc?.getURL()) && ALLOWED_PERMISSIONS.has(permission),
  );
  installDisplayMediaHandler(ses);
  installRendererCsp();
}

function forwardPower(ev: PowerEvent): void {
  log.info('power', ev);
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appPower, ev);
}

void app.whenReady().then(() => {
  lockDownSession();
  applyDevDockIcon();
  // A crash with the Caps Lock → F18 remap applied leaves the keyboard remapped: undo it
  // before the renderer re-applies it for a binding that still wants it.
  void recoverCapsRemap();
  handleApiScheme();
  registerIpc();
  createMainWindow();
  createTray();

  const initialLink = findDeepLink(process.argv);
  if (initialLink) handleDeepLink(initialLink);

  powerMonitor.on('resume', () => forwardPower('resume'));
  // A PTT key-up lost during sleep / lock (or eaten by secure input) must not leave the mic
  // transmitting after wake (review M6).
  powerMonitor.on('suspend', () => {
    resetPttGate();
    forwardPower('suspend');
  });
  powerMonitor.on('lock-screen', () => {
    resetPttGate();
    forwardPower('lock-screen');
  });
  powerMonitor.on('unlock-screen', () => forwardPower('unlock-screen'));

  app.on('activate', () => {
    if (!getMainWindow()) createMainWindow();
    else showMainWindow();
  });

  startUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  shutdownPtt();
});
