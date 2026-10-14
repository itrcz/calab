import { app, autoUpdater as nativeUpdater, BrowserWindow, Notification, powerMonitor, shell } from 'electron';
import log from 'electron-log/main';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateStatus } from '../shared/ipc';
import { downloadPage, feedUrl, githubSource, httpsFeed, pinnedSource, sourcePage } from '../shared/updateFeed';
import { currentServerUrl, refreshSettled } from './auth';
import { forceQuit } from './appLifecycle';
import { prepareRestart } from './resumeVoice';
import { getSettings } from './settings';
import { mainStrings } from './strings';
import { setTrayUpdate } from './tray';
import { createUpdateFlow, type NudgeReason, type UpdateFlow } from './updateFlow';

/**
 * Auto-update (electron-updater: `github` or `generic` provider). The logic lives in updateFlow.ts
 * (pure, unit-tested); this file wires it to Electron.
 *
 * - Feeds (security review M3, review pass 3 B1): decided in main, never by the renderer —
 *   shared/updateFeed.ts. Auto-install only from a source pinned at build time, per the
 *   «Источник обновлений» setting (updateChannel): GitHub Releases of MAIN_VITE_UPDATE_GITHUB
 *   (default; `itrcz/calab`) or the S3 feed MAIN_VITE_UPDATE_FEED (`https://releases.calab.io/`;
 *   both in .env.production). Without either (dev / self-built) the feed derived from the server
 *   (`https://app.X` → `https://releases.X/`, else `https://<host>/download/`) is used for
 *   notify-only. CALABA_UPDATE_URL (runtime) is a notify-only override: it replaces the feed and
 *   disables auto-install. Changing the channel re-runs a check (updateChannelChanged).
 * - Checks: 10 s after start, then hourly (± 5 min) — also while an update waits —, «Проверить» in
 *   «О программе», and — at most once per 10 min — after wake from sleep, screen unlock, window
 *   focus and when the network returns (the renderer's `online` event). «Проверять обновления
 *   автоматически» off → only «Проверить».
 * - A call / stream defers nothing: the update downloads, and «Перезапустить» restarts at once —
 *   the relaunched app rejoins the same room / 1:1 call (prepareRestart, main/resumeVoice.ts).
 * - Auto (pinned source + «Автоматически обновлять» on + Windows / Linux AppImage / macOS built with
 *   MAIN_VITE_UPDATES_SIGNED=1): background download with progress, an accent bar under the
 *   title bar («Доступна версия X — обновление уже загружено · Перезапустить и обновить», docs/09
 *   #125) and a tray item, install on restart or on quit. A pending download is re-validated
 *   against the feed hourly, before «Перезапустить» and before install-on-quit (`will-quit` held
 *   ≤ 3 s; a newer feed → nothing installed, the next start fetches the newest); a newer version
 *   replaces it. macOS stages the newest download in Squirrel.Mac only right before installing
 *   (stageSquirrel) — one update, to the newest (updateFlow.ts).
 * - Otherwise notify only — «Доступна версия X — Скачать» opens `<server>/download/`. When the
 *   update is `installable` (pinned source + a platform able to apply it, only the setting is off)
 *   «О программе» offers «Скачать и установить» — the same flow, on request.
 * - Errors go to the log (electron-log) only; the status turns 'error' for «О программе».
 */
/** Build-time only: a runtime env must not change what gets installed silently. */
const SIGNED = (import.meta.env.MAIN_VITE_UPDATES_SIGNED ?? '') === '1';
const BUILD_FEED = httpsFeed(import.meta.env.MAIN_VITE_UPDATE_FEED ?? '');
const BUILD_GITHUB = githubSource(import.meta.env.MAIN_VITE_UPDATE_GITHUB ?? '');
/** Runtime notify-only override (testing another feed). */
const FEED_OVERRIDE = process.env['CALABA_UPDATE_URL'] ?? '';

/** How long «Перезапустить» waits for a token refresh in flight before quitting. */
const INSTALL_SETTLE_MS = 3_000;

let flow: UpdateFlow | null = null;
/** Kept referenced: a garbage-collected Notification loses its click handler (review L5). */
let notification: Notification | null = null;

function broadcast(s: UpdateStatus): void {
  setTrayUpdate(s.state === 'downloaded' ? s.version : null, () => installUpdate());
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appUpdateStatus, s);
}

function notifyAvailable(version: string, page: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Calab', body: mainStrings().updateAvailable.replaceAll('{version}', version) });
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

/** The pinned source of the chosen channel; null in dev builds and with CALABA_UPDATE_URL. */
function pinnedFeed(): ReturnType<typeof pinnedSource> {
  if (!app.isPackaged || FEED_OVERRIDE.trim()) return null;
  return pinnedSource(getSettings().updateChannel, BUILD_FEED, BUILD_GITHUB);
}

function getFlow(): UpdateFlow {
  if (flow) return flow;
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = log;
  flow = createUpdateFlow(autoUpdater, {
    platform: process.platform,
    signed: SIGNED,
    appImage: Boolean(process.env['APPIMAGE']),
    currentVersion: app.getVersion(),
    autoUpdate: () => getSettings().autoUpdate,
    autoCheck: () => getSettings().autoCheckUpdates,
    // Dev (unpackaged) builds never check; an override replaces the pinned sources (notify-only).
    pinnedFeed,
    notifyFeed: () => (app.isPackaged ? feedUrl(currentServerUrl(), FEED_OVERRIDE) : null),
    downloadPage: () => {
      const pinned = pinnedFeed();
      return downloadPage(currentServerUrl(), pinned ? sourcePage(pinned) : null);
    },
    publish: broadcast,
    notify: notifyAvailable,
    log,
    beforeInstall: forceQuit,
    // A refresh cut off by the quit would leave the rotated token's answer unread (docs/09 #89).
    settle: () => refreshSettled(INSTALL_SETTLE_MS),
    // Back into the same room / call after the relaunch (docs/09 #126, main/resumeVoice.ts).
    prepareRestart,
    // macOS: the flow stages the newest download itself (autoInstallOnAppQuit stays off there).
    ...(process.platform === 'darwin' ? { stage: stageSquirrel } : {}),
  });
  return flow;
}

/**
 * macOS: Squirrel.Mac fetches the update from electron-updater's local proxy (MacUpdater sets
 * the native feed URL to it on every download — the newest downloaded zip) and stages it; it
 * installs on quit, or at once via quitAndInstall(). Resolves on Squirrel's `update-downloaded`
 * (MacUpdater's own listener sets `squirrelDownloadedUpdate` on the same event), rejects on its
 * `error` / `update-not-available`. The flow bounds the wait.
 */
function stageSquirrel(): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      nativeUpdater.removeListener('update-downloaded', ok);
      nativeUpdater.removeListener('update-not-available', none);
      nativeUpdater.removeListener('error', fail);
    };
    const ok = (): void => {
      done();
      resolve();
    };
    const none = (): void => {
      done();
      reject(new Error('Squirrel.Mac: update not available'));
    };
    const fail = (e: Error): void => {
      done();
      reject(e);
    };
    nativeUpdater.on('update-downloaded', ok);
    nativeUpdater.on('update-not-available', none);
    nativeUpdater.on('error', fail);
    try {
      nativeUpdater.checkForUpdates();
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** OS shutdown / reboot / logout is under way: the quit must not wait for a feed re-check. */
let sessionEnding = false;

/** Windows `query-session-end` / `session-end` of the main window (macOS / Linux: powerMonitor 'shutdown'). */
export function updatesSessionEnding(): void {
  sessionEnding = true;
}

/** App start: first check in 10 s, then hourly; re-check after wake / unlock / back online. */
export function startUpdates(): void {
  // Visual tests fake the status (window.__calabaUpdateStatus); a real check 10 s in would
  // overwrite it mid-run (and there is nothing to update in a test build anyway).
  if (process.env['CALABA_VISUAL_TEST'] === '1') return;
  const f = getFlow();
  f.start();
  powerMonitor.on('resume', () => f.nudge('resume'));
  powerMonitor.on('unlock-screen', () => f.nudge('unlock'));
  powerMonitor.on('shutdown', updatesSessionEnding);
  // Several releases a day: a window brought back after a while re-checks too (≤ once per 10 min).
  app.on('browser-window-focus', () => f.nudge('focus'));
  // Install-on-quit of a pending download: re-check the feed first (≤ 3 s) so a stale file is not
  // installed when a newer version is out (docs/09 #125); macOS then stages the newest (≤ 20 s).
  // `will-quit` comes after the lifecycle's `before-quit` (in-call question, tray «Выход», ⌘Q,
  // forceQuit) and after the windows closed, and before electron-updater's `quit` handler reads
  // autoInstallOnAppQuit. beforeQuit() acts once: the app.quit() re-issued below passes through
  // (before-quit is then a no-op — already quitting).
  app.on('will-quit', (e) => {
    const wait = f.beforeQuit(sessionEnding);
    if (!wait) return;
    e.preventDefault();
    void wait.then(() => app.quit());
  });
}

/** Wake / unlock / back online (renderer `online`): a throttled check. No-op before startUpdates(). */
export function updatesNudge(reason: NudgeReason): void {
  flow?.nudge(reason);
}

/** «Проверить» in «О программе». Never throws. */
export function checkForUpdates(): Promise<UpdateStatus> {
  return getFlow().check();
}

export function updateStatus(): UpdateStatus {
  return getFlow().status();
}

/**
 * «Перезапустить» (bar, «О программе», tray): re-check the feed, then quit and install the
 * downloaded update — at once, also during a call (the relaunched app rejoins it).
 */
export function installUpdate(): boolean {
  return getFlow().install();
}

/** «Скачать и установить» in «О программе»: download an installable available update now. */
export function downloadUpdate(): boolean {
  return getFlow().download();
}

/** «Автоматически обновлять» changed. */
export function updateSettingsChanged(): void {
  getFlow().applySettings();
}

/** «Источник обновлений» changed: check the new source now (a running download goes on). */
export function updateChannelChanged(): void {
  if (process.env['CALABA_VISUAL_TEST'] === '1') return;
  void getFlow().check();
}
