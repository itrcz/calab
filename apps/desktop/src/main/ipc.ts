import { readFileSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, screen, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import log from 'electron-log/main';
import {
  IPC,
  type AppInfo,
  type AppSettings,
  type CaptureSelection,
  type DownloadArgs,
  type LoginArgs,
  type PermissionStatus,
  type PrivacyPane,
  type ProcessMetrics,
  type PttBinding,
  type RegisterArgs,
  type TrayState,
  type LegalTexts,
} from '../shared/ipc';
import { serverUrlProblem } from '../shared/serverUrl';
import {
  recoverIdentity,
  beginSso,
  cancelSso,
  invalidateSsoServer,
  forceRefresh,
  getAccessToken,
  guestJoin,
  login,
  logout,
  register,
  restore,
  revoked,
} from './auth';
import { apiSession, apiTransportWake } from './apiTransport';
import { parseOverlayEvent, parseOverlayTarget } from '../shared/annot';
import { closeOverlay, closeOverlayWith, openOverlay, refitOverlay, sendOverlay } from './annotOverlay';
import { armSelection, listSources, requestScreenAccess, screenAccess, systemAudioSupport } from './capture';
import { parseThumbRequest } from '../shared/captureThumb';
import { takePendingDeepLink } from './deeplink';
import { fullscreenFor } from './fullscreen';
import { systemLocales } from './systemLocales';
import { downloadFile } from './downloads';
import { prepareDragOut, startDragOut } from './dragOut';
import { decodeImageNative } from './imageDecode';
import { cancelCapture, captureNext, pttStatus, setBinding } from './ptt';
import { getSettings, updateSettings } from './settings';
import { parseMainStrings, setMainStrings } from './strings';
import { setTrayBadge, setTrayState } from './tray';
import { setMenuState } from './appMenu';
import { parseMenuState } from '../shared/menu';
import { checkForUpdates, downloadUpdate, installUpdate, updateSettingsChanged, updatesNudge, updateStatus } from './updater';
import { reloadIfServerChanged } from './csp';
import { setResumeSeat, takeResumeVoice } from './resumeVoice';
import { hideTip, showTip } from './tipOverlay';
import { parseTipPayload } from './tipOverlayPolicy';
import { appViewShown, forgetApp, hideApp, navigateApp, openApp, openAppExternal, setAppBounds } from './webApps';
import { parseAppId, parseBounds } from './webAppPolicy';
import { getMainWindow, isOwnPage, isShown } from './windows';

const VISUAL_TEST = process.env['CALABA_VISUAL_TEST'] === '1';

/** Only our own renderer may call privileged IPC. */
function assertTrusted(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!isOwnPage(url)) throw new Error(`IPC from untrusted origin: ${url}`);
}

function str(v: unknown, max = 256, allowEmpty = false): string {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && v.length === 0)) throw new Error('invalid argument');
  return v;
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error('invalid argument');
  return v as Record<string, unknown>;
}

function parseLogin(v: unknown): LoginArgs {
  const r = obj(v);
  return { serverUrl: str(r['serverUrl'], 512), email: str(r['email'], 320), password: str(r['password'], 256) };
}

function parseRegister(v: unknown): RegisterArgs {
  const r = obj(v);
  return {
    ...parseLogin(v),
    displayName: str(r['displayName'], 100),
    inviteCode: str(r['inviteCode'], 128, true),
    locale: r['locale'] === undefined ? '' : str(r['locale'], 35, true),
    checkSimilar: r['checkSimilar'] === true,
  };
}

function parseSelection(v: unknown): CaptureSelection {
  const r = obj(v);
  if (typeof r['audio'] !== 'boolean') throw new Error('invalid selection');
  return { sourceId: str(r['sourceId']), audio: r['audio'] };
}

function parseBinding(v: unknown): PttBinding | null {
  if (v === null) return null;
  const r = obj(v);
  const kind = r['kind'];
  if ((kind !== 'key' && kind !== 'mouse') || typeof r['code'] !== 'number') throw new Error('invalid binding');
  const mode = r['mode'] === 'toggle' ? 'toggle' : 'hold';
  const label = str(r['label'], 64);
  if (kind === 'mouse') return { kind, code: r['code'], label, mode };
  const src = r['source'];
  const source: { source?: 'hid' | 'tap' } = src === 'hid' || src === 'tap' ? { source: src } : {};
  return { kind, code: r['code'], label, mode, ...(r['remap'] === 'caps-f18' ? { remap: 'caps-f18' as const } : {}), ...source };
}

function parseCaptureId(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('invalid capture id');
  return v;
}

function parseSettings(v: unknown): Partial<AppSettings> {
  const r = obj(v);
  const out: Partial<AppSettings> = {};
  if (r['serverUrl'] !== undefined) {
    const u = str(r['serverUrl'], 512, true);
    // https, or plain http on loopback only (review L11; CALABA_ALLOW_INSECURE_HTTP=1 for LAN tests).
    if (u && serverUrlProblem(u, process.env['CALABA_ALLOW_INSECURE_HTTP'] === '1')) throw new Error('serverUrl must be https (http only for localhost)');
    out.serverUrl = u;
  }
  // updateUrl is NOT settable from the renderer (security review M3): main derives the feed.
  if (r['autostart'] !== undefined) out.autostart = Boolean(r['autostart']);
  if (r['autoUpdate'] !== undefined) out.autoUpdate = Boolean(r['autoUpdate']);
  if (r['autoCheckUpdates'] !== undefined) out.autoCheckUpdates = Boolean(r['autoCheckUpdates']);
  if (r['closeToTray'] !== undefined) out.closeToTray = Boolean(r['closeToTray']);
  return out;
}

const PRIVACY_URLS: Record<PrivacyPane, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
};

function mediaAccess(kind: 'microphone' | 'screen' | 'camera'): string {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'n/a';
  return systemPreferences.getMediaAccessStatus(kind);
}

type Handler = (e: IpcMainInvokeEvent, arg: unknown) => unknown;

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, (e, arg: unknown) => {
    assertTrusted(e);
    return fn(e, arg);
  });
}

export function registerIpc(): void {
  // ---- auth ----
  handle(IPC.authIdentityClearCache, () => apiSession().clearCache());
  handle(IPC.authIdentityRecover, (_e, a) => {
    const r = obj(a);
    return recoverIdentity(str(r['workspaceId'], 128), str(r['code'], 256));
  });
  handle(IPC.authSsoBegin, (_e, a) => {
    const r = obj(a);
    const purpose = str(r['purpose']);
    if (purpose !== 'login' && purpose !== 'step_up' && purpose !== 'link' && purpose !== 'test') throw new Error('Invalid SSO purpose');
    return beginSso({ workspaceId: str(r['workspaceId'], 128), purpose });
  });
  handle(IPC.authSsoCancel, (_e, a) => cancelSso(str(a, 128)));
  // Safety net (incident 2.0.0): a restored session on another server than the page CSP was
  // built for reloads the page like a login does — never a gateway blocked by connect-src.
  handle(IPC.authRestore, async () => {
    const s = await restore();
    if (s) reloadIfServerChanged();
    return s;
  });
  // A login to another server changes the renderer CSP (review L3): reload after the reply.
  const afterAuth = <T extends { ok: boolean }>(r: T): T => {
    if (r.ok) reloadIfServerChanged();
    return r;
  };
  handle(IPC.authLogin, async (_e, a) => afterAuth(await login(parseLogin(a))));
  handle(IPC.authRegister, async (_e, a) => afterAuth(await register(parseRegister(a))));
  handle(IPC.authGuestJoin, (_e, a) => {
    const r = obj(a);
    const code = str(r['code'], 64);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) throw new Error('invalid code');
    return guestJoin(code, str(r['nickname'], 64)).then(afterAuth);
  });
  handle(IPC.authLogout, (_e, a) => logout(Boolean(a)));
  handle(IPC.authAccessToken, () => getAccessToken());
  handle(IPC.authForceRefresh, (_e, a) => {
    if (a === 'revoked') {
      revoked();
      return null;
    }
    return forceRefresh();
  });

  // ---- app ----
  handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    hostname: hostname(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    fakeMedia: process.env['CALABA_FAKE_MEDIA'] === '1',
    forceRelay: process.env['CALABA_FORCE_RELAY'] === '1',
    visualTest: VISUAL_TEST,
    systemAudioLoopback: systemAudioSupport(),
    micAccess: mediaAccess('microphone'),
    screenAccess: mediaAccess('screen'),
    // app.getLocale() follows --lang (tests pin it to ru); the system list covers languages
    // Chromium has no UI pack for (ADR-0022: kk, be → ru; the app ships only our packs).
    locales: systemLocales(app.getLocale(), app.getPreferredSystemLanguages(), app.commandLine.hasSwitch('lang')),
  }));
  handle(IPC.appSetStrings, (_e, a) => {
    const s = parseMainStrings(a);
    if (s) setMainStrings(s);
  });
  handle(IPC.appGetSettings, () => getSettings());
  handle(IPC.appSetSettings, (_e, a) => {
    if (obj(a)['serverUrl'] !== undefined) invalidateSsoServer();
    const patch = parseSettings(a);
    const next = updateSettings(patch);
    if (patch.autoUpdate !== undefined || patch.autoCheckUpdates !== undefined) updateSettingsChanged();
    reloadIfServerChanged();
    return next;
  });
  handle(IPC.appTakeDeepLink, () => takePendingDeepLink());
  handle(IPC.appCheckUpdates, () => checkForUpdates());
  handle(IPC.appGetUpdateStatus, () => updateStatus());
  handle(IPC.appInstallUpdate, () => installUpdate());
  handle(IPC.appDownloadUpdate, () => downloadUpdate());
  handle(IPC.appNetworkOnline, () => {
    // Network back: connections opened on the old one are suspect (docs/09 #146).
    apiTransportWake('online');
    updatesNudge('online');
  });
  handle(IPC.appResumeVoice, (_e, a) => setResumeSeat(a));
  handle(IPC.appTakeResumeVoice, () => takeResumeVoice());
  handle(IPC.appLog, (_e, a) => {
    const r = obj(a);
    const msg = str(r['message'], 8192, true);
    if (r['level'] === 'error') log.error('[renderer]', msg);
    else if (r['level'] === 'warn') log.warn('[renderer]', msg);
    else log.info('[renderer]', msg);
  });
  handle(IPC.appOpenExternal, (_e, a) => {
    const url = str(a, 2048).trim();
    // http(s) pages and mailto: (the plan contact, ADR-0024); never file:, custom schemes, etc.
    if (!/^(https?:\/\/|mailto:[^\s/]+@)/i.test(url)) throw new Error('only http(s) and mailto: links');
    return shell.openExternal(url);
  });
  handle(IPC.appLegal, (): LegalTexts => {
    // Packaged: copied into resources by electron-builder (extraResources). Dev: the repo
    // files and the notices generated by `pnpm build:app`.
    const read = (packaged: string, dev: string): string => {
      try {
        return readFileSync(app.isPackaged ? join(process.resourcesPath, packaged) : join(app.getAppPath(), dev), 'utf8');
      } catch {
        return '';
      }
    };
    return {
      license: read('LICENSE', '../../LICENSE'),
      notice: read('NOTICE', '../../NOTICE'),
      commercial: read('COMMERCIAL-LICENSE.md', '../../COMMERCIAL-LICENSE.md'),
      thirdParty: read('THIRD-PARTY-NOTICES.txt', 'build/.gen/THIRD-PARTY-NOTICES.txt'),
    };
  });
  handle(IPC.appSetTheme, (_e, a) => {
    if (a !== 'dark' && a !== 'light' && a !== 'system') return;
    if (nativeTheme.themeSource === a) return;
    // nativeTheme 'updated' recolours the window background (windows.ts).
    nativeTheme.themeSource = a;
  });
  handle(IPC.systemPermissions, (): PermissionStatus =>
    // Visual tests: fixed statuses so screenshots don't depend on the machine's TCC state.
    VISUAL_TEST
      ? { microphone: 'granted', camera: 'granted', screen: 'denied', accessibility: false, notifications: 'n/a' }
      : {
          microphone: mediaAccess('microphone'),
          camera: mediaAccess('camera'),
          screen: mediaAccess('screen'),
          accessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true,
          notifications: 'n/a', // the renderer knows Notification.permission
        },
  );
  handle(IPC.systemRequestMic, async () => {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  handle(IPC.screenAccess, () => screenAccess());
  handle(IPC.screenRequestAccess, () => requestScreenAccess());
  handle(IPC.appRelaunch, () => {
    if (VISUAL_TEST) return;
    log.info('[app] relaunch requested (screen recording grant)');
    app.relaunch();
    app.exit(0);
  });
  handle(IPC.appAttention, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isFocused()) {
      if (process.platform === 'darwin') app.dock?.bounce('informational');
      else win.flashFrame(true);
    }
  });

  handle(IPC.appSetBadge, (_e, a) => {
    const n = Math.max(0, Math.min(9999, Math.trunc(Number(a)) || 0));
    setTrayBadge(n);
    if (VISUAL_TEST) return; // never touch the owner's Dock from a test instance
    if (process.platform === 'darwin') app.dock?.setBadge(n > 0 ? (n > 99 ? '99+' : String(n)) : '');
    else app.setBadgeCount(n); // Linux (Unity launchers); a no-op elsewhere
  });

  // ---- tray ----
  handle(IPC.trayState, (_e, a) => {
    const r = obj(a);
    setTrayState({ inVoice: Boolean(r['inVoice']), muted: Boolean(r['muted']), deafened: Boolean(r['deafened']) } satisfies TrayState);
  });

  // ---- macOS menu ----
  handle(IPC.menuState, (_e, a) => setMenuState(parseMenuState(a)));

  // ---- files ----
  handle(IPC.filesDownload, (_e, a) => {
    const r = obj(a);
    const args: DownloadArgs = { fileId: str(r['fileId'], 64), name: str(r['name'], 512) };
    return downloadFile(args);
  });
  handle(IPC.filesDragPrepare, (_e, a) => {
    const r = obj(a);
    return prepareDragOut(str(r['fileId'], 64), str(r['name'], 512));
  });
  // The drag starts from the caller's own window (the press began there), never another one.
  handle(IPC.filesDragStart, (e, a) => startDragOut(e.sender, str(a, 64)));
  handle(IPC.filesDecodeImage, (_e, a) => decodeImageNative(a));

  // ---- media ----
  handle(IPC.captureListSources, (_e, req) => listSources(parseThumbRequest(req)));
  // The caller's own window (main window or a stream pop-out), never another one.
  handle(IPC.windowSetFullScreen, (e, on) => {
    if (typeof on !== 'boolean') throw new Error('invalid argument');
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? fullscreenFor(win).set(on) : false;
  });
  handle(IPC.windowIsShown, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? isShown(win) : true;
  });
  handle(IPC.windowIsFullScreen, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? fullscreenFor(win).isFullScreen() : false;
  });
  handle(IPC.annotOverlayOpen, (e, target) => {
    closeOverlayWith(e.sender);
    return openOverlay(parseOverlayTarget(target));
  });
  handle(IPC.annotOverlaySend, (_e, ev) => sendOverlay(parseOverlayEvent(ev)));
  handle(IPC.annotOverlayClose, () => closeOverlay());
  screen.on('display-metrics-changed', refitOverlay);
  screen.on('display-removed', refitOverlay);
  handle(IPC.captureSelectSource, (e, sel) => {
    armSelection(e.sender, parseSelection(sel));
  });
  handle(IPC.pttSetBinding, (e, b) => setBinding(e.sender, parseBinding(b)));
  handle(IPC.pttCaptureNext, (e, id) => captureNext(e.sender, parseCaptureId(id)));
  handle(IPC.pttCancelCapture, (_e, id) => cancelCapture(parseCaptureId(id)));
  handle(IPC.pttStatus, () => (VISUAL_TEST ? { ...pttStatus(), trusted: false, hid: 'unsupported' as const } : pttStatus()));
  handle(IPC.systemIdleSeconds, () => powerMonitor.getSystemIdleTime());
  handle(IPC.systemMetrics, (e): ProcessMetrics => {
    const pid = e.sender.getOSProcessId();
    const metrics = app.getAppMetrics();
    // percentCPUUsage is normalised to *all* cores on macOS (verified against
    // `ps`: 83.8 % vs 9.0 on 10 cores) → convert to "% of one core" like ps/top.
    const cores = cpus().length;
    const cpuOf = (pred: (m: Electron.ProcessMetric) => boolean): number | null => {
      const m = metrics.find(pred);
      return m ? m.cpu.percentCPUUsage * cores : null;
    };
    return {
      rendererPid: pid,
      rendererCpu: cpuOf((m) => m.pid === pid),
      gpuCpu: cpuOf((m) => m.type === 'GPU'),
      mainCpu: cpuOf((m) => m.type === 'Browser'),
    };
  });
  // ---- workspace web apps (ADR-0050 §4): only the main window's page drives the views ----
  const mainOnly = (e: IpcMainInvokeEvent): BrowserWindow => {
    const win = getMainWindow();
    if (!win || BrowserWindow.fromWebContents(e.sender) !== win) throw new Error('web apps: main window only');
    return win;
  };
  handle(IPC.webAppOpen, (e, a) => {
    const win = mainOnly(e);
    const r = obj(a);
    openApp(parseAppId(r['appId']), str(r['url'], 2048), parseBounds(r['bounds'], win.webContents.getZoomFactor()));
  });
  handle(IPC.webAppHide, (e) => {
    mainOnly(e);
    hideApp();
  });
  handle(IPC.webAppSetBounds, (e, a) => {
    const win = mainOnly(e);
    setAppBounds(parseBounds(a, win.webContents.getZoomFactor()));
  });
  handle(IPC.webAppNavigate, (e, a) => {
    mainOnly(e);
    if (a !== 'back' && a !== 'forward' && a !== 'reload') throw new Error('invalid action');
    navigateApp(a);
  });
  handle(IPC.webAppOpenExternal, (e) => {
    mainOnly(e);
    openAppExternal();
  });
  handle(IPC.webAppForget, (e, a) => {
    mainOnly(e);
    return forgetApp(parseAppId(a));
  });
  handle(IPC.webAppTipShow, (e, a) => {
    const win = mainOnly(e);
    const zoom = win.webContents.getZoomFactor();
    const p = parseTipPayload(a, zoom, win.getContentBounds());
    if (appViewShown()) showTip(win, p, zoom);
    else hideTip();
  });
  handle(IPC.webAppTipHide, (e) => {
    mainOnly(e);
    hideTip();
  });
  handle(IPC.systemOpenPrivacySettings, (_e, pane) => {
    if (process.platform === 'win32') {
      const win: Partial<Record<PrivacyPane, string>> = { microphone: 'ms-settings:privacy-microphone', camera: 'ms-settings:privacy-webcam' };
      const url = win[pane as PrivacyPane];
      if (url) void shell.openExternal(url);
      return;
    }
    if (process.platform !== 'darwin') return;
    const url = PRIVACY_URLS[pane as PrivacyPane];
    if (url) void shell.openExternal(url);
  });
}
