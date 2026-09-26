import { app, BrowserWindow, net, Notification, powerMonitor, shell } from 'electron';
import log from 'electron-log/main';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateStatus } from '../shared/ipc';
import { downloadPage, feedUrl, httpsFeed } from '../shared/updateFeed';
import { currentServerUrl } from './auth';
import { getSettings } from './settings';
import { createUpdateFlow, type UpdateFlow } from './updateFlow';

/**
 * Auto-update (electron-updater, generic provider). The logic lives in updateFlow.ts (pure,
 * unit-tested); this file wires it to Electron.
 *
 * - Feeds (security review M3, review pass 3 B1): decided in main, never by the renderer —
 *   shared/updateFeed.ts. Auto-install only from the build-time feed MAIN_VITE_UPDATE_FEED
 *   (release builds: `https://releases.calab.ru/`, .env.production; https only). Without it
 *   (dev / self-built) the feed derived from the server (`https://app.X` → `https://releases.X/`,
 *   else `https://<host>/download/`) is used for notify-only. CALABA_UPDATE_URL (runtime) is a
 *   notify-only override: it replaces the feed and disables auto-install.
 * - Checks: 10 s after start, every 6 h, «Проверить» in «О программе», after wake from sleep,
 *   and when the network returns after a failed check.
 * - Auto (build feed + «Автоматически обновлять» on + Windows / Linux AppImage / macOS built with
 *   MAIN_VITE_UPDATES_SIGNED=1): background download with progress, a «Обновление X готово —
 *   Перезапустить» banner in the self panel, install on restart or on quit.
 * - Otherwise notify only — «Доступна версия X — Скачать» opens `<server>/download/`.
 * - Errors go to the log (electron-log) only; the status turns 'error' for «О программе».
 */
/** Build-time only: a runtime env must not change what gets installed silently. */
const SIGNED = (import.meta.env.MAIN_VITE_UPDATES_SIGNED ?? '') === '1';
const BUILD_FEED = httpsFeed(import.meta.env.MAIN_VITE_UPDATE_FEED ?? '');
/** Runtime notify-only override (testing another feed). */
const FEED_OVERRIDE = process.env['CALABA_UPDATE_URL'] ?? '';

let flow: UpdateFlow | null = null;
/** Kept referenced: a garbage-collected Notification loses its click handler (review L5). */
let notification: Notification | null = null;

function broadcast(s: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appUpdateStatus, s);
}

function notifyAvailable(version: string, page: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Calab', body: `Доступна версия ${version} — Скачать` });
  n.on('click', () => {
    void shell.openExternal(page);
    notification = null;
  });
  n.on('close', () => {
    if (notification === n) notification = null;
  });
  notification = n;
  n.show();
}

function getFlow(): UpdateFlow {
  if (flow) return flow;
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = log;
  flow = createUpdateFlow(autoUpdater, {
    platform: process.platform,
    signed: SIGNED,
    appImage: Boolean(process.env['APPIMAGE']),
    autoUpdate: () => getSettings().autoUpdate,
    // Dev (unpackaged) builds never check; an override replaces the pinned feed (notify-only).
    buildFeed: app.isPackaged && !FEED_OVERRIDE.trim() ? BUILD_FEED : null,
    notifyFeed: () => (app.isPackaged ? feedUrl(currentServerUrl(), FEED_OVERRIDE) : null),
    downloadPage: () => downloadPage(currentServerUrl(), BUILD_FEED),
    isOnline: () => net.isOnline(),
    publish: broadcast,
    notify: notifyAvailable,
    log,
  });
  return flow;
}

/** App start: first check in 10 s, then every 6 h; re-check after wake / back online. */
export function startUpdates(): void {
  const f = getFlow();
  f.start();
  powerMonitor.on('resume', () => f.resume());
}

/** «Проверить» in «О программе». Never throws. */
export function checkForUpdates(): Promise<UpdateStatus> {
  return getFlow().check();
}

export function updateStatus(): UpdateStatus {
  return getFlow().status();
}

/** «Перезапустить»: quit and install the downloaded update. */
export function installUpdate(): boolean {
  return getFlow().install();
}

/** «Автоматически обновлять» changed. */
export function updateSettingsChanged(): void {
  getFlow().applySettings();
}
