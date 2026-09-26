import type { UpdateStatus } from '../shared/ipc';

/**
 * Update state machine, free of Electron imports so it is unit-tested with a fake updater
 * (updateFlow.test.ts). main/updater.ts wires it to electron-updater, notifications and IPC.
 *
 * Modes, decided per check (settings and the server can change at runtime):
 * - auto   — autoDownload + autoInstallOnAppQuit: background download with progress, then
 *            «Обновление X готово — Перезапустить»; installs on restart or on quit.
 *            ONLY from the build-time feed (review pass 3 B1: an unsigned Windows / AppImage
 *            update is verified by nothing but the sha512 in latest*.yml, served by the same
 *            host — so the host must be the one pinned at build time, never one derived from
 *            the server or set at runtime), and only where the update can be applied: Windows;
 *            Linux AppImage (electron-updater installs nothing else); macOS only when signed
 *            (Squirrel.Mac refuses unsigned updates).
 * - notify — nothing is downloaded: status 'available' + one notification per version that
 *            opens the human download page. Everything else: no build-time feed (dev /
 *            self-built), a runtime feed override, unsigned macOS, Linux deb/other, or
 *            «Автоматически обновлять» off.
 * Errors are logged and end in status 'error' (shown only in «О программе»); never thrown.
 *
 * Checks: 10 s after start, every 6 h, «Проверить», and (debounced) after wake from sleep or
 * when the network comes back after a failed check.
 */

/** The part of electron-updater's AppUpdater the flow uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  /** Resolves null when the updater is inactive (not packaged, Linux without AppImage/package). */
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateFlowEnv {
  /** `process.platform`. */
  platform: string;
  /** Build is code-signed (CALABA_UPDATES_SIGNED / MAIN_VITE_UPDATES_SIGNED = 1). */
  signed: boolean;
  /** Running as an AppImage (`process.env.APPIMAGE` set). */
  appImage: boolean;
  /** The «Автоматически обновлять» setting, read live. */
  autoUpdate: () => boolean;
  /**
   * The feed pinned at build time (validated https) — the only one auto mode uses. null → no
   * auto-install at all (dev build, self-built without MAIN_VITE_UPDATE_FEED, runtime override).
   */
  buildFeed: string | null;
  /** Notify-only feed used when there is no build feed (runtime override / server-derived); null → none. */
  notifyFeed: () => string | null;
  /** Human download page for the notification / «Скачать» (https); null → the checked feed. */
  downloadPage: () => string | null;
  /** Network state (Electron `net.isOnline()`); enables the re-check when it comes back. */
  isOnline?: () => boolean;
  publish: (s: UpdateStatus) => void;
  /** Notify-only: «Доступна версия X — Скачать» opening `page`. Called once per version. */
  notify: (version: string, page: string) => void;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export const FIRST_CHECK_MS = 10_000;
export const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Debounce of the wake / back-online re-check (the network needs a moment after resume). */
export const NUDGE_MS = 5_000;
/** How often the network state is polled after a failed check (main has no online event). */
export const ONLINE_POLL_MS = 30_000;

export interface AutoInstallInput {
  platform: string;
  signed: boolean;
  appImage: boolean;
  /** The feed about to be checked is the build-time feed. */
  pinnedFeed: boolean;
  /** «Автоматически обновлять». */
  autoUpdate: boolean;
}

/**
 * Whether an update may be downloaded and installed without the user: the setting is on, the
 * feed is the build-time one, and the platform can apply it (signed, or Windows / AppImage,
 * whose unsigned updates are trusted only because the https host is pinned at build time).
 */
export function canAutoInstall(i: AutoInstallInput): boolean {
  if (!i.autoUpdate || !i.pinnedFeed) return false;
  if (i.signed) return i.platform === 'win32' || i.platform === 'darwin' || (i.platform === 'linux' && i.appImage);
  return i.platform === 'win32' || (i.platform === 'linux' && i.appImage);
}

export interface UpdateFlow {
  /** Schedules the first check (+10 s) and the periodic one (every 6 h). Idempotent. */
  start(): void;
  /** Stops all timers (tests / shutdown). */
  stop(): void;
  /** Woke from sleep: a debounced check (once started; not while downloading / downloaded). */
  resume(): void;
  /** A check now (startup timer, periodic timer, «Проверить»). Concurrent calls share one check. */
  check(): Promise<UpdateStatus>;
  /** «Перезапустить»: quit and install the downloaded update. false when nothing is downloaded. */
  install(): boolean;
  /** Re-reads the settings (autoUpdate toggled); may start a download of an available update. */
  applySettings(): void;
  status(): UpdateStatus;
}

interface VersionInfo {
  version: string;
}
interface Progress {
  percent: number;
}

export function createUpdateFlow(updater: UpdaterLike, env: UpdateFlowEnv): UpdateFlow {
  let status: UpdateStatus = { state: 'disabled' };
  let page = '';
  let notified = '';
  let pendingVersion = '';
  let inFlight: Promise<UpdateStatus> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let periodic: ReturnType<typeof setInterval> | null = null;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let onlineWatch: ReturnType<typeof setInterval> | null = null;
  /** The feed last handed to the updater ('' before the first check). */
  let feed = '';

  const autoFor = (url: string): boolean =>
    canAutoInstall({
      platform: env.platform,
      signed: env.signed,
      appImage: env.appImage,
      pinnedFeed: env.buildFeed !== null && url === env.buildFeed,
      autoUpdate: env.autoUpdate(),
    });

  /** Feed for the next check: the build feed when there is one, else the notify-only feed. */
  const nextFeed = (): string | null => env.buildFeed ?? env.notifyFeed();

  const busy = (): boolean => status.state === 'downloading' || status.state === 'downloaded';

  const nudge = (): void => {
    if (!periodic || nudgeTimer || busy()) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      void check();
    }, NUDGE_MS);
  };

  const stopOnlineWatch = (): void => {
    if (onlineWatch) clearInterval(onlineWatch);
    onlineWatch = null;
  };

  /** After a failure: re-check once the network goes offline → online (e.g. Wi-Fi back). */
  const startOnlineWatch = (): void => {
    const isOnline = env.isOnline;
    if (!isOnline || onlineWatch || !periodic) return;
    let wasOffline = !isOnline();
    onlineWatch = setInterval(() => {
      const online = isOnline();
      if (online && wasOffline) {
        stopOnlineWatch();
        nudge();
      }
      wasOffline = !online;
    }, ONLINE_POLL_MS);
  };

  const publish = (s: UpdateStatus): void => {
    status = s;
    env.publish(s);
    if (s.state === 'error') startOnlineWatch();
    else if (s.state !== 'checking') stopOnlineWatch();
  };

  const applyFlags = (): void => {
    const on = feed !== '' && autoFor(feed);
    updater.autoDownload = on;
    updater.autoInstallOnAppQuit = on;
  };

  const startDownload = (): void => {
    updater.downloadUpdate().catch((e: unknown) => {
      // The 'error' event carries the status; this only keeps the rejection handled.
      env.log.warn('[update] download failed', e);
    });
  };

  // Listeners get the event's first argument (UpdateInfo / ProgressInfo / Error in electron-updater).
  const on = (event: string, fn: (a: unknown) => void): void => {
    updater.on(event, (...args) => fn(args[0]));
  };
  const versionOf = (a: unknown): string => (a as Partial<VersionInfo> | undefined)?.version ?? '';

  on('checking-for-update', () => {
    if (status.state !== 'downloading' && status.state !== 'downloaded') publish({ state: 'checking' });
  });
  on('update-not-available', () => publish({ state: 'none' }));
  on('update-available', (a) => {
    const version = versionOf(a);
    pendingVersion = version;
    if (updater.autoDownload) {
      // electron-updater starts the download itself (autoDownload).
      publish({ state: 'downloading', version, percent: 0 });
      return;
    }
    publish({ state: 'available', version, downloadPage: page });
    if (notified !== version && page) {
      notified = version;
      env.notify(version, page);
    }
  });
  on('download-progress', (a) => {
    const raw = (a as Partial<Progress> | undefined)?.percent ?? 0;
    const percent = Math.max(0, Math.min(100, Math.floor(Number.isFinite(raw) ? raw : 0)));
    // Progress fires many times a second: publish only when the integer percent changes.
    if (status.state === 'downloading' && status.percent === percent) return;
    publish({ state: 'downloading', version: pendingVersion, percent });
  });
  on('update-downloaded', (a) => {
    const version = versionOf(a) || pendingVersion;
    env.log.info('[update] downloaded', version);
    publish({ state: 'downloaded', version });
  });
  on('error', (e) => {
    env.log.warn('[update] failed', e);
    // A failure after the download (e.g. a later check) must not hide «Перезапустить».
    if (status.state !== 'downloaded') publish({ state: 'error', message: 'update failed' });
  });

  const run = async (): Promise<UpdateStatus> => {
    // Downloading / ready: nothing new to learn, and a new check would reset the banner.
    if (busy()) return status;
    const url = nextFeed();
    if (!url) {
      publish({ state: 'disabled' });
      return status;
    }
    page = env.downloadPage() ?? url;
    feed = url;
    applyFlags();
    updater.setFeedURL({ provider: 'generic', url });
    try {
      const r = await updater.checkForUpdates();
      if (r === null || r === undefined) publish({ state: 'disabled' });
    } catch (e) {
      // electron-updater already emitted 'error' (→ status); keep it logged and non-fatal.
      if (status.state !== 'error' && status.state !== 'downloaded') {
        env.log.warn('[update] check failed', e);
        publish({ state: 'error', message: 'update check failed' });
      }
    }
    return status;
  };

  const check = (): Promise<UpdateStatus> => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start() {
      first ??= setTimeout(() => void check(), FIRST_CHECK_MS);
      periodic ??= setInterval(() => void check(), RECHECK_MS);
    },
    stop() {
      if (first) clearTimeout(first);
      if (periodic) clearInterval(periodic);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      stopOnlineWatch();
      first = null;
      periodic = null;
      nudgeTimer = null;
    },
    resume: nudge,
    check,
    install() {
      if (status.state !== 'downloaded') return false;
      env.log.info('[update] quit and install', status.version);
      // Not silent (Windows shows the installer progress), relaunch after install.
      updater.quitAndInstall(false, true);
      return true;
    },
    applySettings() {
      applyFlags();
      if (status.state === 'available' && updater.autoDownload) {
        publish({ state: 'downloading', version: status.version, percent: 0 });
        startDownload();
      }
    },
    status: () => status,
  };
}
