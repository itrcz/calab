import type { UpdateStatus } from '../shared/ipc';
import { feedKey, type FeedSource } from '../shared/updateFeed';
import { isNewerVersion } from '../shared/version';

/**
 * Update state machine, free of Electron imports so it is unit-tested with a fake updater
 * (updateFlow.test.ts). main/updater.ts wires it to electron-updater, notifications and IPC.
 *
 * Modes, decided per check (settings and the server can change at runtime):
 * - auto   — autoDownload + autoInstallOnAppQuit: background download with progress, then
 *            «Обновление X готово — Перезапустить»; installs on restart or on quit.
 *            ONLY from a pinned source (review pass 3 B1: an unsigned Windows / AppImage
 *            update is verified by nothing but the sha512 in latest*.yml, served by the same
 *            host — so the host must be one pinned at build time, never one derived from the
 *            server or set at runtime: the GitHub repo or the S3 feed, whichever channel the
 *            user chose — shared/updateFeed.ts), and only where the update can be applied: Windows;
 *            Linux AppImage (electron-updater installs nothing else); macOS only when signed
 *            (Squirrel.Mac refuses unsigned updates).
 * - notify — nothing is downloaded: status 'available' + one notification per version that
 *            opens the human download page. Everything else: no pinned source (dev /
 *            self-built), a runtime feed override, unsigned macOS, Linux deb/other, or
 *            «Автоматически обновлять» off. Also the fallback of a failed automatic download
 *            (owner 12.10, «не предлагает обновиться»: a background download that failed used to
 *            end in a silent 'error' — now «Доступна версия X» stays on screen with «Скачать»).
 * - manual — notify, but the update is `installable` (pinned source + a platform able to apply it;
 *            only the setting is off): «Скачать и установить» in «О программе» calls
 *            download() — the same download / install-on-quit as auto, on the user's request.
 * Errors are logged and end in status 'error' (shown only in «О программе»); never thrown.
 *
 * Checks (docs/09 P1 #16): 10 s after start, then every hour (the period is shifted by a random
 * ±5 min once per run so a fleet of clients does not hit the feed on the hour), «Проверить», and
 * — debounced and at most once per 10 min — after wake from sleep, screen unlock and when the
 * network comes back (the renderer's `online` event). «Проверять обновления автоматически» off →
 * only «Проверить» checks. A call / stream does not defer anything (owner, 30.09): the update
 * downloads in the background and «Перезапустить» restarts at once — prepareRestart hands the
 * voice seat to the relaunched app, which rejoins the same room / 1:1 call (docs/09 #126).
 *
 * A pending download is re-validated against the feed (docs/09 #125, «обновлялись дважды»): the
 * flow used to stop checking once an update was downloaded, so a client that fetched 0.8.0 and ran
 * for days installed 0.8.0 on restart / quit although the feed already said 0.9.0 — and offered
 * 0.9.0 right after the restart. Now, while an update is pending, the feed is read again on the
 * same hourly (± jitter) tick as when idle (with several releases a day a 6 h cadence still left
 * «1.1.0 готово» on screen while 1.3.0 was out — owner, 30.09), on wake / unlock / back online
 * (throttled like any nudge) and right before «Перезапустить» (unless the last check is fresh); a
 * newer version replaces the pending download and «Перезапустить» installs it once ready. A feed
 * offering a version not newer than the running one is ignored (stale mirror).
 *
 * One update, to the newest (owner, 30.09: several releases a day, people restart late). Facts of
 * electron-updater 6.8.9 this relies on (read in node_modules, docs/12 «двойное обновление»):
 * - All platforms keep ONE downloaded file (`<cache>/pending`). Starting the download of a newer
 *   version deletes the older one (DownloadedUpdateHelper.getValidCachedUpdateFile: sha512 of the
 *   cached file ≠ the new one → emptyDir(pending)); a failed download clears it too
 *   (executeDownload → removeFileIfAny → clear()). So once a replacement download starts there is
 *   nothing installable until it ends: `downloadedVersion` is reset, «Перезапустить» waits for the
 *   newer one (installWhenReady), a quit installs nothing (the next start fetches the newest).
 * - Windows NSIS / AppImage install `downloadedUpdateHelper.file` — always the newest downloaded —
 *   from BaseUpdater's `quit` handler, which reads `autoInstallOnAppQuit` live.
 * - macOS: MacUpdater serves the newest downloaded zip to Squirrel.Mac through a local proxy (a new
 *   one per download, setFeedURL) but, with `autoInstallOnAppQuit` on, also makes Squirrel fetch and
 *   STAGE it at download time — and Squirrel installs what it staged on any quit. A newer download
 *   re-feeds Squirrel, but `quitAndInstall()` goes straight to Squirrel once anything was staged
 *   (`squirrelDownloadedUpdate` stays true from the first one), and a quit while the newer one
 *   downloads installs the older staged one: two updates in a row. So on macOS the flow keeps
 *   `autoInstallOnAppQuit` OFF (nothing is staged at download time) and stages itself (env.stage,
 *   Squirrel's own check against MacUpdater's proxy = the newest downloaded file) right before
 *   «Перезапустить» quits and, for install-on-quit, in `will-quit` — the only moments it matters.
 *
 * Install on quit (beforeQuit, wired to `will-quit`): a quit with a pending download re-checks the
 * feed first when the last check is older than QUIT_FRESH_MS (the quit is held at most
 * QUIT_RECHECK_TIMEOUT_MS); a feed newer than the downloaded file → no install on this quit (the next
 * start downloads the newest — one update); same / older feed, a timeout or an error → install:
 * Windows / AppImage through electron-updater's `quit` handler, macOS by staging now (the windows are
 * already closed; ≤ QUIT_STAGE_TIMEOUT_MS). At OS shutdown / logout nothing is awaited: Windows /
 * AppImage decide by the last known feed version, macOS installs nothing (the next start offers the
 * already downloaded update again — no re-download).
 */

/** The part of electron-updater's AppUpdater the flow uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(options: FeedSource): void;
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
  /** «Проверять обновления автоматически», read live: off → only «Проверить» checks. */
  autoCheck: () => boolean;
  /** The running app version (`app.getVersion()`): a feed offering ≤ this is ignored. */
  currentVersion?: string;
  /** Jitter source in [0, 1) (Math.random; fixed in tests). */
  random?: () => number;
  /**
   * The pinned source for the chosen channel (GitHub repo or S3 feed, baked in at build time; read
   * per check — the channel can change) — the only kind auto mode uses. null → no auto-install at
   * all (dev build, self-built without MAIN_VITE_UPDATE_FEED / _GITHUB, runtime override).
   */
  pinnedFeed: () => FeedSource | null;
  /** Notify-only feed used when there is no pinned source (runtime override / server-derived); null → none. */
  notifyFeed: () => string | null;
  /** Human download page for the notification / «Скачать» (https); null → the checked feed. */
  downloadPage: () => string | null;
  publish: (s: UpdateStatus) => void;
  /** Notify-only: «Доступна версия X — Скачать» opening `page`. Called once per version. */
  notify: (version: string, page: string) => void;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  /**
   * Called right before quitAndInstall: marks the quit as real (windows close instead of hiding
   * to the tray, no «Вы в голосовой комнате» question — docs/09 #31). On macOS Electron closes
   * the windows before `before-quit`, so the flag must be set here.
   */
  beforeInstall?: () => void;
  /**
   * Awaited before quitAndInstall: a token refresh in flight finishes (bounded) so its answer
   * is not lost with the old process (docs/09 #89). Optional; absent → install at once.
   */
  settle?: () => Promise<void>;
  /**
   * Awaited right before quitAndInstall, once the install is certain (after the re-check): the
   * renderer hands over its voice seat so the relaunched app rejoins it (docs/09 #126). Must be
   * bounded and never reject. Not called for install-on-quit (no relaunch).
   */
  prepareRestart?: () => Promise<void>;
  /**
   * macOS only: have Squirrel.Mac fetch and stage the newest downloaded update (from MacUpdater's
   * local proxy); resolves once staged (Squirrel's `update-downloaded`), rejects on its error.
   * Called right before «Перезапустить» quits and at install-on-quit — see the file docblock.
   * Absent on macOS → treated as staged (tests).
   */
  stage?: () => Promise<void>;
}

export const FIRST_CHECK_MS = 10_000;
export const RECHECK_MS = 60 * 60 * 1000;
/** The periodic check runs every RECHECK_MS ± RECHECK_JITTER_MS (drawn once per start()). */
export const RECHECK_JITTER_MS = 5 * 60 * 1000;
/** Debounce of the wake / unlock / back-online re-check (the network needs a moment after resume). */
export const NUDGE_MS = 5_000;
/** A wake / unlock / online nudge checks only if the last check started at least this long ago. */
export const NUDGE_MIN_GAP_MS = 10 * 60 * 1000;
/** A quit with a pending download re-checks the feed unless the last check started less than this ago. */
export const QUIT_FRESH_MS = 10 * 60 * 1000;
/** The quit waits at most this long for that re-check, then installs what it has. */
export const QUIT_RECHECK_TIMEOUT_MS = 3_000;
/** «Перезапустить» re-checks the feed first unless the last check started less than this ago. */
export const INSTALL_FRESH_MS = 2 * 60 * 1000;
/** «Перезапустить» waits at most this long for that re-check before installing what it has. */
export const INSTALL_RECHECK_TIMEOUT_MS = 8_000;
/** macOS «Перезапустить»: how long Squirrel.Mac may take to stage the update (local copy + signature check). */
export const INSTALL_STAGE_TIMEOUT_MS = 60_000;
/** macOS install-on-quit: the quit (windows already closed) waits at most this long for the staging. */
export const QUIT_STAGE_TIMEOUT_MS = 20_000;

export type NudgeReason = 'resume' | 'unlock' | 'online' | 'focus';

export interface AutoInstallInput {
  platform: string;
  signed: boolean;
  appImage: boolean;
  /** The feed about to be checked is a pinned source (build time). */
  pinnedFeed: boolean;
  /** «Автоматически обновлять». */
  autoUpdate: boolean;
}

/**
 * Whether an update may be downloaded and installed without the user: the setting is on, the
 * feed is a pinned one, and the platform can apply it (signed, or Windows / AppImage,
 * whose unsigned updates are trusted only because the https host is pinned at build time).
 */
export function canAutoInstall(i: AutoInstallInput): boolean {
  if (!i.autoUpdate || !i.pinnedFeed) return false;
  if (i.signed) return i.platform === 'win32' || i.platform === 'darwin' || (i.platform === 'linux' && i.appImage);
  return i.platform === 'win32' || (i.platform === 'linux' && i.appImage);
}

/** Whether an update from this feed could be installed in place at all (canAutoInstall, setting aside). */
export function canInstall(i: Omit<AutoInstallInput, 'autoUpdate'>): boolean {
  return canAutoInstall({ ...i, autoUpdate: true });
}

export interface UpdateFlow {
  /** Schedules the first check (+10 s) and the periodic one (every hour ± 5 min). Idempotent. */
  start(): void;
  /** Stops all timers (tests / shutdown). */
  stop(): void;
  /**
   * Wake / unlock / back online / window focus: a debounced check (once started, automatic checks
   * on, not while downloading, and not within NUDGE_MIN_GAP_MS of the last check).
   */
  nudge(reason: NudgeReason): void;
  /** A check now (startup timer, periodic timer, «Проверить»). Concurrent calls share one check. */
  check(): Promise<UpdateStatus>;
  /**
   * «Перезапустить» (also during a call — the relaunched app rejoins it): re-check the feed (a
   * newer version replaces the pending download and installs once ready), then quit and install
   * (macOS: after staging the newest download). During a download: install it once downloaded.
   * false when nothing is downloaded or downloading.
   */
  install(): boolean;
  /**
   * «Скачать и установить»: download an `installable` available update now and install it on
   * quit. false when there is nothing to download.
   */
  download(): boolean;
  /** Re-reads the settings (autoUpdate / autoCheck toggled); may start a download of an available update. */
  applySettings(): void;
  /**
   * The app is quitting (`will-quit`): decide whether the pending download is installed on this
   * quit. null → decided now, let the quit go on; a promise → hold the quit until it resolves
   * (≤ QUIT_RECHECK_TIMEOUT_MS, never rejects), then quit again. Acts once per run: later calls
   * return null, so the re-issued quit passes straight through. `sessionEnding` (OS shutdown /
   * logout) → never waits.
   */
  beforeQuit(sessionEnding: boolean): Promise<void> | null;
  status(): UpdateStatus;
}

/** Resolves when `p` settles or after `ms`, whichever is first (the timer is then cleared). */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** true when `p` resolves within `ms`; false when it rejects or times out. Never rejects. */
function succeeds(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

interface VersionInfo {
  version: string;
}
interface Progress {
  percent: number;
  bytesPerSecond: number;
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
  /** install() is waiting for settle(): a second click does not queue a second quit. */
  let installing = false;
  /** Date.now() when the last updater check started (0 = never). */
  let lastCheckAt = 0;
  /** Key of the feed last handed to the updater ('' before the first check). */
  let feed = '';
  /** That feed is a pinned source (may auto-install); kept per check, so a channel switch mid-download does not revoke it. */
  let feedPinned = false;
  /** The user asked for a download («Скачать и установить»): install on quit even with auto off. */
  let requested = false;
  /** A version newer than the pending download was found: download it. */
  let replacing = false;
  /** «Перезапустить» found a newer version: install as soon as it is downloaded. */
  let installWhenReady = false;
  /**
   * Version of the file electron-updater holds, i.e. what a restart / quit would install — always
   * the newest downloaded. '' = nothing installable (none yet, or a replacement / failed download
   * deleted it — see the file docblock).
   */
  let downloadedVersion = '';
  /** Squirrel.Mac stages the update (install / quit on macOS): no checks, no new downloads meanwhile. */
  let staging = false;
  /** The pending download should be installed on quit (what `autoInstallOnAppQuit` means off macOS). */
  let installOnQuit = false;
  const mac = env.platform === 'darwin';
  /** Newest version the feed offered at the last check ('' = nothing newer than the app). */
  let feedVersion = '';
  /** beforeQuit() ran: no new downloads, and its install decision is not undone by applyFlags(). */
  let quitting = false;
  /** beforeQuit() decided not to install the stale download on this quit. */
  let skipQuitInstall = false;

  const autoFeed = (): boolean =>
    feed !== '' &&
    canAutoInstall({
      platform: env.platform,
      signed: env.signed,
      appImage: env.appImage,
      pinnedFeed: feedPinned,
      autoUpdate: env.autoUpdate(),
    });

  const installableFeed = (): boolean =>
    feed !== '' &&
    canInstall({
      platform: env.platform,
      signed: env.signed,
      appImage: env.appImage,
      pinnedFeed: feedPinned,
    });

  /** Feed for the next check: the pinned source when there is one, else the notify-only feed. */
  const nextFeed = (): { source: FeedSource; pinned: boolean } | null => {
    const pinned = env.pinnedFeed();
    if (pinned) return { source: pinned, pinned: true };
    const url = env.notifyFeed();
    return url ? { source: { provider: 'generic', url }, pinned: false } : null;
  };

  /** A download is running: nothing new to learn from the feed until it ends. */
  const busy = (): boolean => status.state === 'downloading';

  const gapOk = (): boolean => Date.now() - lastCheckAt >= NUDGE_MIN_GAP_MS;

  const nudge = (reason: NudgeReason): void => {
    if (!periodic || nudgeTimer || busy() || !env.autoCheck() || !gapOk()) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      // Re-tested: a scheduled / manual check may have run during the debounce.
      if (busy() || !env.autoCheck() || !gapOk()) return;
      env.log.info('[update] check on', reason);
      void check();
    }, NUDGE_MS);
  };

  /**
   * Startup / periodic check: skipped with «Проверять обновления автоматически» off. With an update
   * pending it runs on the same hourly tick (is the pending download still the latest?).
   */
  const scheduled = (): void => {
    if (!env.autoCheck()) return;
    void check();
  };

  const publish = (s: UpdateStatus): void => {
    status = s;
    env.publish(s);
  };

  /**
   * Starts a download now if one may run (auto mode, or a newer version replacing a pending
   * download) and an update is waiting.
   */
  const downloadIfWaiting = (): void => {
    // Quitting: the next start downloads it (a download cut off by the exit is only wasted traffic).
    if (quitting) return;
    if (status.state === 'available' && (updater.autoDownload || replacing)) {
      env.log.info('[update] download', status.version);
      // electron-updater deletes the older downloaded file when this download starts.
      if (replacing) downloadedVersion = '';
      replacing = false;
      publish({ state: 'downloading', version: status.version, percent: 0 });
      startDownload();
    }
  };

  const applyFlags = (): void => {
    const on = autoFeed();
    updater.autoDownload = on;
    installOnQuit = !skipQuitInstall && (on || (requested && installableFeed()));
    // macOS: never let MacUpdater stage at download time (the flow stages the newest itself).
    updater.autoInstallOnAppQuit = !mac && installOnQuit;
  };

  /** Install-on-quit is off for this quit (Windows / AppImage: electron-updater's `quit` handler skips it). */
  const skipOnQuit = (): void => {
    skipQuitInstall = true;
    installOnQuit = false;
    updater.autoInstallOnAppQuit = false;
  };

  /** macOS: Squirrel.Mac stages the newest download (true when staged within `ms`); elsewhere true. */
  const stageNewest = async (ms: number): Promise<boolean> => {
    if (!mac || !env.stage) return true;
    staging = true;
    try {
      return await succeeds(env.stage(), ms);
    } finally {
      staging = false;
    }
  };

  const startDownload = (): void => {
    updater.downloadUpdate().catch((e: unknown) => {
      // The 'error' event carries the status; this only keeps the rejection handled.
      env.log.warn('[update] download failed', e);
    });
  };

  /** Notify-only offer: 'available' with the download page (+ «Скачать и установить» when installable), one notification per version. */
  function offer(version: string): void {
    publish({ state: 'available', version, downloadPage: page, ...(installableFeed() ? { installable: true as const } : {}) });
    if (notified !== version && page) {
      notified = version;
      env.notify(version, page);
    }
  }

  // Listeners get the event's first argument (UpdateInfo / ProgressInfo / Error in electron-updater).
  const on = (event: string, fn: (a: unknown) => void): void => {
    updater.on(event, (...args) => fn(args[0]));
  };
  const versionOf = (a: unknown): string => (a as Partial<VersionInfo> | undefined)?.version ?? '';

  on('checking-for-update', () => {
    if (status.state !== 'downloading' && status.state !== 'downloaded') publish({ state: 'checking' });
  });
  on('update-not-available', () => {
    feedVersion = '';
    // A re-check of a pending download: nothing newer than the app on the feed — keep it.
    if (status.state === 'downloaded') return;
    publish({ state: 'none' });
  });
  on('update-available', (a) => {
    const version = versionOf(a);
    if (env.currentVersion && version && !isNewerVersion(version, env.currentVersion)) {
      // A stale feed / mirror: never offer the running version or an older one.
      env.log.warn('[update] feed offers', version, 'not newer than', env.currentVersion, '— ignored');
      feedVersion = '';
      if (status.state !== 'downloaded') publish({ state: 'none' });
      return;
    }
    feedVersion = version;
    if (status.state === 'downloaded') {
      // A re-check of the pending download (autoDownload is off for it, see run()).
      if (!isNewerVersion(version, status.version)) return;
      env.log.info('[update] feed has', version, 'newer than the pending', status.version, '— replacing it');
      pendingVersion = version;
      replacing = true;
      publish({ state: 'available', version, installable: true });
      downloadIfWaiting();
      return;
    }
    pendingVersion = version;
    if (updater.autoDownload) {
      // electron-updater starts the download itself (autoDownload); another version replaces
      // (deletes) a file still held from before (e.g. after a failed staging → 'error').
      if (version !== downloadedVersion) downloadedVersion = '';
      publish({ state: 'downloading', version, percent: 0 });
      return;
    }
    offer(version);
  });
  on('download-progress', (a) => {
    const p = a as Partial<Progress> | undefined;
    const raw = p?.percent ?? 0;
    const percent = Math.max(0, Math.min(100, Math.floor(Number.isFinite(raw) ? raw : 0)));
    // Progress fires many times a second: publish only when the integer percent changes.
    if (status.state === 'downloading' && status.percent === percent) return;
    const bps = p?.bytesPerSecond;
    const speed = typeof bps === 'number' && Number.isFinite(bps) && bps >= 0 ? { bytesPerSecond: Math.round(bps) } : {};
    publish({ state: 'downloading', version: pendingVersion, percent, ...speed });
  });
  on('update-downloaded', (a) => {
    const version = versionOf(a) || pendingVersion;
    env.log.info('[update] downloaded', version);
    downloadedVersion = version;
    publish({ state: 'downloaded', version });
    if (installWhenReady) {
      // «Перезапустить» found this newer version: install it now (the feed was just read).
      installWhenReady = false;
      installNow(false);
    }
  });
  on('error', (e) => {
    env.log.warn('[update] failed', e);
    // A failed download leaves nothing installable (electron-updater clears its cache).
    if (status.state === 'downloading') {
      downloadedVersion = '';
      installWhenReady = false;
      // Never silent about a known newer version (owner 12.10): the bar offers it again —
      // «Скачать и установить» retries the download, «Скачать» opens the page. The next check retries too.
      const version = status.version;
      if (version) {
        env.log.warn('[update] download of', version, 'failed — offering it instead');
        if (!page) page = env.downloadPage() ?? '';
        offer(version);
        return;
      }
    }
    if (status.state !== 'downloaded') installWhenReady = false;
    // A failure after the download (e.g. a later check) must not hide «Перезапустить».
    if (status.state !== 'downloaded') publish({ state: 'error', message: 'update failed' });
  });

  const run = async (): Promise<UpdateStatus> => {
    // Downloading: nothing new to learn until it ends. Staging: the file must stay as it is.
    if (busy() || staging) return status;
    // Downloaded: the check only asks whether the pending version is still the latest.
    const pending = status.state === 'downloaded';
    const next = nextFeed();
    if (!next) {
      if (!pending) publish({ state: 'disabled' });
      return status;
    }
    const key = feedKey(next.source);
    page = env.downloadPage() ?? (next.source.provider === 'generic' ? next.source.url : '');
    if (key !== feed) env.log.info('[update] feed', key, next.pinned ? '(pinned)' : '(notify-only)');
    feed = key;
    feedPinned = next.pinned;
    applyFlags();
    // Never re-download the pending version blindly: 'update-available' decides (newer → replace).
    if (pending) updater.autoDownload = false;
    updater.setFeedURL(next.source);
    lastCheckAt = Date.now();
    try {
      const r = await updater.checkForUpdates();
      if ((r === null || r === undefined) && status.state !== 'downloaded') publish({ state: 'disabled' });
    } catch (e) {
      // electron-updater already emitted 'error' (→ status); keep it logged and non-fatal.
      if (status.state !== 'error' && status.state !== 'downloaded') {
        env.log.warn('[update] check failed', e);
        publish({ state: 'error', message: 'update check failed' });
      }
    } finally {
      if (pending) applyFlags();
    }
    return status;
  };

  /**
   * Quit and install — after re-reading the feed (unless `recheck` is false or the last check is
   * fresh; bounded by INSTALL_RECHECK_TIMEOUT_MS) and after settle(). A newer version found by the
   * re-check replaces the pending download and installs once downloaded (installWhenReady).
   */
  function installNow(recheck: boolean): boolean {
    if (status.state !== 'downloaded') return false;
    if (installing) return true;
    const go = (): void => {
      installing = false;
      if (status.state !== 'downloaded') {
        // The re-check found a newer version: it is downloading.
        env.log.info('[update] install when', pendingVersion, 'is downloaded');
        installWhenReady = true;
        return;
      }
      installing = true;
      const version = status.version;
      const quit = (): void => {
        env.log.info('[update] quit and install', version);
        env.beforeInstall?.();
        // Not silent (Windows shows the installer progress), relaunch after install.
        updater.quitAndInstall(false, true);
      };
      const restart = (): void => {
        if (env.prepareRestart) void env.prepareRestart().catch(() => undefined).then(quit);
        else quit();
      };
      if (!mac) {
        restart();
        return;
      }
      // macOS: Squirrel.Mac stages exactly this (newest) download now; quitAndInstall() then
      // installs it (MacUpdater: staged → Squirrel's quitAndInstall at once). Staged before
      // prepareRestart, so a failure leaves the call untouched.
      env.log.info('[update] staging', version);
      void stageNewest(INSTALL_STAGE_TIMEOUT_MS).then((ok) => {
        if (ok) {
          restart();
          return;
        }
        env.log.warn('[update] staging', version, 'failed — not installing');
        installing = false;
        // Recovers on the next check (the downloaded file is still cached, nothing re-downloaded).
        publish({ state: 'error', message: 'update install failed' });
      });
    };
    const fresh = !recheck || Date.now() - lastCheckAt < INSTALL_FRESH_MS;
    const waits: Array<Promise<unknown>> = [];
    if (!fresh) waits.push(bounded(check(), INSTALL_RECHECK_TIMEOUT_MS));
    if (env.settle) waits.push(env.settle());
    if (waits.length === 0) {
      go();
      return true;
    }
    installing = true;
    void Promise.allSettled(waits).then(go);
    return true;
  }

  const check = (): Promise<UpdateStatus> => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  /** The feed has a version newer than the downloaded file: installing it now means a second update. */
  const staleDownload = (): boolean => feedVersion !== '' && isNewerVersion(feedVersion, downloadedVersion);

  /**
   * Final install-on-quit decision (see the file docblock). null → decided; a promise → macOS
   * stages the update, the quit waits for it (never rejects).
   */
  const decideQuitInstall = (): Promise<void> | null => {
    if (staleDownload()) {
      env.log.info('[update] quit: feed has', feedVersion, '— not installing the downloaded', downloadedVersion, '(the next start downloads it)');
      skipOnQuit();
      return null;
    }
    env.log.info('[update] quit: installing', downloadedVersion);
    if (!mac) return null;
    // Squirrel.Mac installs what it staged once the app has exited.
    return stageNewest(QUIT_STAGE_TIMEOUT_MS).then((ok) => {
      if (!ok) env.log.warn('[update] quit: staging', downloadedVersion, 'failed / timed out — installs on a later restart');
    });
  };

  const beforeQuit = (sessionEnding: boolean): Promise<void> | null => {
    if (quitting) return null;
    quitting = true;
    // «Перезапустить» is under way (quitAndInstall).
    if (installing) return null;
    // Nothing installable (none, or a newer one still downloading), or install-on-quit is off.
    if (downloadedVersion === '' || !installOnQuit) {
      skipOnQuit();
      return null;
    }
    // OS shutdown / logout: never wait. macOS would have to stage first — the next start offers
    // the downloaded update again instead.
    if (sessionEnding && mac) {
      env.log.info('[update] quit: session ends — not staging', downloadedVersion);
      skipOnQuit();
      return null;
    }
    if (sessionEnding || staleDownload() || Date.now() - lastCheckAt < QUIT_FRESH_MS) return decideQuitInstall();
    env.log.info('[update] quit: re-checking the feed before installing', downloadedVersion);
    return bounded(check(), QUIT_RECHECK_TIMEOUT_MS).then(() => decideQuitInstall() ?? undefined);
  };

  return {
    start() {
      first ??= setTimeout(scheduled, FIRST_CHECK_MS);
      if (!periodic) {
        const r = Math.min(Math.max((env.random ?? Math.random)(), 0), 1);
        const every = Math.round(RECHECK_MS + (r * 2 - 1) * RECHECK_JITTER_MS);
        env.log.info('[update] periodic check every', Math.round(every / 1000), 's');
        periodic = setInterval(scheduled, every);
      }
    },
    stop() {
      if (first) clearTimeout(first);
      if (periodic) clearInterval(periodic);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      first = null;
      periodic = null;
      nudgeTimer = null;
    },
    nudge,
    check,
    install() {
      if (status.state === 'downloading' && !quitting) {
        // Pressed as a newer version started replacing the pending one (its file is already gone):
        // install that one once downloaded — the renderer shows the progress meanwhile.
        env.log.info('[update] install when', status.version, 'is downloaded');
        installWhenReady = true;
        return true;
      }
      return installNow(true);
    },
    download() {
      if (status.state !== 'available' || !status.installable || !installableFeed()) return false;
      env.log.info('[update] download on request', status.version);
      requested = true;
      applyFlags();
      publish({ state: 'downloading', version: status.version, percent: 0 });
      startDownload();
      return true;
    },
    applySettings() {
      applyFlags();
      downloadIfWaiting();
    },
    beforeQuit,
    status: () => status,
  };
}
