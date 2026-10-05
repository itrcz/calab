import { join } from 'node:path';
import { app, BrowserWindow, powerMonitor, session } from 'electron';
import { IPC, type PowerEvent } from '../shared/ipc';
import { handleApiScheme, registerApiScheme } from './apiProtocol';
import { apiTransportWake } from './apiTransport';
import { forceQuit, handleMainWindowClose, installLifecycle } from './appLifecycle';
import { installDisplayMediaHandler, MAC_SYSTEM_AUDIO_FEATURES, macSystemAudioEnabled } from './capture';
import { echoFeatures } from './echoFeatures';
import { cleanupDragOut } from './dragOut';
import { findDeepLink, handleDeepLink, registerProtocolClient } from './deeplink';
import { registerIpc } from './ipc';
import { initLogging, log } from './logging';
import { recoverCapsRemap } from './capsRemap';
import { installRendererCsp } from './csp';
import { applyDevDockIcon } from './icons';
import { resetPttGate, shutdownPtt } from './ptt';
import { createTray } from './tray';
import { installAppMenu } from './appMenu';
import { startUpdates, updatesSessionEnding } from './updater';
import { loadResumeVoice } from './resumeVoice';
import { forgetAllApps, installWebAppGuards } from './webApps';
import { onSessionEnd, installSsoHandoff } from './auth';
import {
  createMainWindow,
  getMainWindow,
  installWebContentsGuards,
  isOwnOrigin,
  isOwnPage,
  setMainWindowHooks,
  showMainWindow,
} from './windows';

// The product is «Calab» (docs/10), but installed builds keep their data under the old name:
// userData (session, settings, logs) and the macOS Keychain item «Calaba Safe Storage» that
// safeStorage derives from app.name when Chromium starts. So main starts as «Calaba» and switches
// the visible name (menus, About) to productName once `ready`; both are fixed by then.
installSsoHandoff();
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
// One --enable-features switch: a second appendSwitch of the same name would replace the first.
const echo = echoFeatures(process.env);
const features: string[] = [...echo.enable];
if (macSystemAudioEnabled()) features.push(...MAC_SYSTEM_AUDIO_FEATURES);
app.commandLine.appendSwitch('enable-features', features.join(','));
if (echo.disable.length > 0) app.commandLine.appendSwitch('disable-features', echo.disable.join(','));
log.info('chromium features', { enable: features, disable: echo.disable });

// Test/automation only: synthetic mic (beep), no OS permission prompts.
if (process.env['CALABA_FAKE_MEDIA'] === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  // The fake UI also swaps getDisplayMedia for Chromium's fake screen (`screen:-3:0`), whatever
  // source our picker armed. CALABA_REAL_SCREEN=1 (tools/perf-call.ts --bench F) keeps the fake
  // mic but captures the real screen / window; permissions go through our own handler anyway.
  if (process.env['CALABA_REAL_SCREEN'] !== '1') app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

registerApiScheme();
// Close button hides (the call goes on), ⌘Q / tray «Выход» during a call asks (docs/09 #31).
installLifecycle();
setMainWindowHooks({
  close: handleMainWindowClose,
  // Windows logoff / shutdown: quit without questions, and without holding the quit for an update re-check.
  sessionEnd: () => {
    updatesSessionEnding();
    forceQuit();
  },
});
// Every webContents (main window, stream pop-outs, anything created later) gets the same
// navigation / window.open / <webview> guards (review L12).
installWebContentsGuards();
// Workspace web apps (ADR-0050 §4): their views and popups get their own guard set; the end of
// the Calab session clears every app's site data on this device.
installWebAppGuards();
onSessionEnd(() => void forgetAllApps());

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
  // The voice seat left by a restart for an update (docs/09 #126): read and deleted now, so only
  // this launch sees it.
  loadResumeVoice();
  registerIpc();
  createMainWindow();
  createTray();
  installAppMenu();

  const initialLink = findDeepLink(process.argv);
  if (initialLink) handleDeepLink(initialLink);

  // After sleep / unlock the pooled API connections are suspect (docs/09 #146): fresh ones.
  powerMonitor.on('resume', () => {
    apiTransportWake('resume');
    forwardPower('resume');
  });
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
  powerMonitor.on('unlock-screen', () => {
    apiTransportWake('unlock-screen');
    forwardPower('unlock-screen');
  });

  // Dock icon click: bring the hidden window back (or a new one if it is gone).
  app.on('activate', () => {
    if (!getMainWindow()) createMainWindow();
    else showMainWindow();
  });

  startUpdates();
});

app.on('will-quit', () => {
  shutdownPtt();
  cleanupDragOut();
});
