import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../shared/ipc';
import { feedKey, type FeedSource } from '../shared/updateFeed';
import {
  FIRST_CHECK_MS,
  INSTALL_FRESH_MS,
  INSTALL_RECHECK_TIMEOUT_MS,
  INSTALL_STAGE_TIMEOUT_MS,
  NUDGE_MIN_GAP_MS,
  NUDGE_MS,
  QUIT_FRESH_MS,
  QUIT_RECHECK_TIMEOUT_MS,
  QUIT_STAGE_TIMEOUT_MS,
  RECHECK_JITTER_MS,
  RECHECK_MS,
  canAutoInstall,
  createUpdateFlow,
  type UpdateFlowEnv,
  type UpdaterLike,
} from './updateFlow';

const FEED = 'https://releases.calab.io/';
const SERVER_FEED = 'https://chat.example.com/download/';
const PAGE = 'https://app.calab.io/download/';

/** Scripted electron-updater: `next` decides what the next check emits. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  feed = '';
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  next: 'none' | { version: string } | Error | 'inactive' = 'none';

  setFeedURL(o: FeedSource): void {
    this.feed = feedKey(o);
  }
  checkForUpdates(): Promise<unknown> {
    this.checks++;
    const n = this.next;
    if (n === 'inactive') return Promise.resolve(null);
    this.emit('checking-for-update');
    if (n instanceof Error) {
      this.emit('error', n);
      return Promise.reject(n);
    }
    if (n === 'none') {
      this.emit('update-not-available', { version: '0.1.0' });
      return Promise.resolve({ updateInfo: { version: '0.1.0' } });
    }
    this.emit('update-available', n);
    if (this.autoDownload) void this.downloadUpdate();
    return Promise.resolve({ updateInfo: n });
  }
  downloadUpdate(): Promise<unknown> {
    this.downloads++;
    return Promise.resolve([]);
  }
  /** Drives the download the way electron-updater does. */
  finishDownload(version: string, steps: number[] = [12.3, 12.9, 57.5, 100]): void {
    for (const percent of steps) this.emit('download-progress', { percent });
    this.emit('update-downloaded', { version });
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

/** Lets pending promise callbacks run (real timers). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(opts: Omit<Partial<UpdateFlowEnv>, 'autoCheck'> & { auto?: boolean; autoCheck?: boolean } = {}) {
  const { auto, autoCheck: autoCheckInit, ...over } = opts;
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const notified: Array<[string, string]> = [];
  const warns: unknown[][] = [];
  let autoUpdate = auto ?? true;
  let autoCheck = autoCheckInit ?? true;
  const flow = createUpdateFlow(updater, {
    platform: 'win32',
    signed: false,
    appImage: false,
    autoUpdate: () => autoUpdate,
    autoCheck: () => autoCheck,
    // 0.5 → no jitter: the periodic check runs exactly every RECHECK_MS.
    random: () => 0.5,
    pinnedFeed: () => ({ provider: 'generic', url: FEED }),
    notifyFeed: () => null,
    downloadPage: () => PAGE,
    publish: (s) => statuses.push(s),
    notify: (v, p) => notified.push([v, p]),
    log: { info: () => undefined, warn: (...a) => warns.push(a) },
    ...over,
  });
  return {
    updater,
    flow,
    statuses,
    notified,
    warns,
    setAuto: (v: boolean) => {
      autoUpdate = v;
    },
    setAutoCheck: (v: boolean) => {
      autoCheck = v;
    },
    states: () => statuses.map((s) => s.state),
  };
}

describe('canAutoInstall', () => {
  const base = { platform: 'win32', signed: false, appImage: false, pinnedFeed: true, autoUpdate: true };
  it('pinned build feed: windows always, macOS only signed, Linux only AppImage', () => {
    expect(canAutoInstall(base)).toBe(true);
    expect(canAutoInstall({ ...base, platform: 'darwin' })).toBe(false);
    expect(canAutoInstall({ ...base, platform: 'darwin', signed: true })).toBe(true);
    expect(canAutoInstall({ ...base, platform: 'linux' })).toBe(false);
    expect(canAutoInstall({ ...base, platform: 'linux', signed: true })).toBe(false);
    expect(canAutoInstall({ ...base, platform: 'linux', appImage: true })).toBe(true);
    expect(canAutoInstall({ ...base, platform: 'freebsd', signed: true, appImage: true })).toBe(false);
  });
  it('never from a feed that is not the build-time one, signed or not (review pass 3 B1)', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const signed of [false, true]) {
        expect(canAutoInstall({ platform, signed, appImage: true, pinnedFeed: false, autoUpdate: true })).toBe(false);
      }
    }
  });
  it('never with «Автоматически обновлять» off', () => {
    expect(canAutoInstall({ ...base, signed: true, autoUpdate: false })).toBe(false);
  });
});

describe('update flow', () => {
  it('checking → none, feed set from env', async () => {
    const t = setup();
    const s = await t.flow.check();
    expect(s).toEqual({ state: 'none' });
    expect(t.states()).toEqual(['checking', 'none']);
    expect(t.updater.feed).toBe(FEED);
  });

  it('no feed (dev build / no server) → disabled, updater untouched', async () => {
    const t = setup({ pinnedFeed: () => null, notifyFeed: () => null });
    expect(await t.flow.check()).toEqual({ state: 'disabled' });
    expect(t.updater.checks).toBe(0);
  });

  it('inactive updater (null result, e.g. Linux without a package) → disabled', async () => {
    const t = setup({ platform: 'linux' });
    t.updater.next = 'inactive';
    expect(await t.flow.check()).toEqual({ state: 'disabled' });
  });

  for (const [name, env] of [
    ['windows', { platform: 'win32' }],
    ['linux AppImage', { platform: 'linux', appImage: true }],
    ['signed macOS', { platform: 'darwin', signed: true }],
  ] as const) {
    it(`${name}: available → downloading (progress) → downloaded → restart installs`, async () => {
      const t = setup(env);
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.autoDownload).toBe(true);
      // macOS: MacUpdater must not stage at download time (the flow stages the newest itself).
      expect(t.updater.autoInstallOnAppQuit).toBe(env.platform !== 'darwin');
      expect(t.updater.downloads).toBe(1);
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
      t.updater.finishDownload('0.1.1');
      const percents = t.statuses.flatMap((s) => (s.state === 'downloading' ? [s.percent] : []));
      expect(percents).toEqual([0, 12, 57, 100]);
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      expect(t.notified).toEqual([]);
      expect(t.flow.install()).toBe(true);
      await flush();
      expect(t.updater.installs).toEqual([[false, true]]);
    });
  }

  describe('feed trust (review pass 3 B1)', () => {
    const platforms = [
      ['unsigned windows', { platform: 'win32' }],
      ['signed windows', { platform: 'win32', signed: true }],
      ['unsigned linux AppImage', { platform: 'linux', appImage: true }],
      ['signed macOS', { platform: 'darwin', signed: true }],
      ['unsigned macOS', { platform: 'darwin' }],
    ] as const;
    for (const [name, env] of platforms) {
      it(`${name}: a server-derived feed never auto-downloads, only notifies with the download page`, async () => {
        const t = setup({ ...env, pinnedFeed: () => null, notifyFeed: () => SERVER_FEED });
        t.updater.next = { version: '6.6.6' };
        await t.flow.check();
        expect(t.updater.feed).toBe(SERVER_FEED);
        expect(t.updater.autoDownload).toBe(false);
        expect(t.updater.autoInstallOnAppQuit).toBe(false);
        expect(t.updater.downloads).toBe(0);
        expect(t.flow.status()).toEqual({ state: 'available', version: '6.6.6', downloadPage: PAGE });
        expect(t.notified).toEqual([['6.6.6', PAGE]]);
        // Turning the setting on (again) must not start a download from that feed either.
        t.flow.applySettings();
        expect(t.updater.downloads).toBe(0);
        expect(t.flow.install()).toBe(false);
      });
    }

    it('build feed + unsigned win32 → auto from the build feed, even with a server feed around', async () => {
      const t = setup({ platform: 'win32', notifyFeed: () => SERVER_FEED });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.feed).toBe(FEED);
      expect(t.updater.autoDownload).toBe(true);
      expect(t.updater.downloads).toBe(1);
      expect(t.notified).toEqual([]);
    });

    it('build feed + unsigned linux AppImage → auto', async () => {
      const t = setup({ platform: 'linux', appImage: true });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      expect(t.updater.downloads).toBe(1);
    });

    it('build feed + unsigned macOS → notify from the build feed', async () => {
      const t = setup({ platform: 'darwin', notifyFeed: () => SERVER_FEED });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.feed).toBe(FEED);
      expect(t.updater.downloads).toBe(0);
      expect(t.notified).toEqual([['0.1.1', PAGE]]);
    });

    it('no download page → the checked feed is shown', async () => {
      const t = setup({ platform: 'darwin', downloadPage: () => null });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.notified).toEqual([['0.1.1', FEED]]);
    });
  });

  it('install() marks the quit as real before quitAndInstall (docs/09 #31)', async () => {
    const order: string[] = [];
    const t = setup({ beforeInstall: () => order.push('force') });
    const orig = t.updater.quitAndInstall.bind(t.updater);
    t.updater.quitAndInstall = (a, b) => {
      order.push('install');
      orig(a, b);
    };
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.finishDownload('0.1.1');
    expect(t.flow.install()).toBe(true);
    expect(order).toEqual(['force', 'install']);
  });

  it('install() waits for settle() (a token refresh in flight) before quitting, once (docs/09 #89)', async () => {
    let release!: () => void;
    const settled = new Promise<void>((r) => (release = r));
    let settles = 0;
    const t = setup({
      settle: () => {
        settles++;
        return settled;
      },
    });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.finishDownload('0.1.1');
    expect(t.flow.install()).toBe(true);
    expect(t.flow.install()).toBe(true); // a second click while waiting
    await Promise.resolve();
    expect(t.updater.installs).toEqual([]);
    release();
    await settled;
    await Promise.resolve();
    expect(t.updater.installs).toEqual([[false, true]]);
    expect(settles).toBe(1);
  });

  it('install() hands the voice seat over (prepareRestart) before quitting, once (docs/09 #126)', async () => {
    let release!: () => void;
    const prepared = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const t = setup({
      prepareRestart: () => {
        order.push('prepare');
        return prepared;
      },
      beforeInstall: () => order.push('force'),
    });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.finishDownload('0.1.1');
    expect(t.flow.install()).toBe(true);
    expect(t.flow.install()).toBe(true); // a second click while the renderer answers
    await Promise.resolve();
    expect(order).toEqual(['prepare']);
    expect(t.updater.installs).toEqual([]);
    release();
    await prepared;
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['prepare', 'force']);
    expect(t.updater.installs).toEqual([[false, true]]);
  });

  it('install() without a downloaded update does nothing', async () => {
    const t = setup();
    await t.flow.check();
    expect(t.flow.install()).toBe(false);
    expect(t.updater.installs).toEqual([]);
  });

  it('downloaded: a later check of the same version keeps it, nothing re-downloaded (docs/09 #125)', async () => {
    const t = setup();
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.finishDownload('0.1.1');
    const checks = t.updater.checks;
    const before = t.statuses.length;
    expect(await t.flow.check()).toEqual({ state: 'downloaded', version: '0.1.1' });
    expect(t.updater.checks).toBe(checks + 1);
    expect(t.updater.downloads).toBe(1);
    expect(t.updater.autoDownload).toBe(true); // restored after the re-check
    expect(t.statuses.slice(before)).toEqual([]);
    // Nothing newer on the feed / a failed check: the pending download stays.
    t.updater.next = 'none';
    await t.flow.check();
    t.updater.next = new Error('offline');
    await t.flow.check();
    t.updater.emit('error', new Error('late'));
    expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
  });

  describe('pending download vs the feed (docs/09 #125: «обновлялись дважды»)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** 0.1.1 downloaded, the last check INSTALL_FRESH_MS ago. */
    async function pending(opts: Parameters<typeof setup>[0] = {}) {
      const t = setup(opts);
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      t.updater.finishDownload('0.1.1');
      await vi.advanceTimersByTimeAsync(INSTALL_FRESH_MS);
      return t;
    }

    it('pending < feed: «Перезапустить» downloads the newer one and installs it when ready', async () => {
      const t = await pending();
      t.updater.next = { version: '0.1.2' };
      expect(t.flow.install()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.updater.installs).toEqual([]);
      expect(t.updater.downloads).toBe(2);
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.2', percent: 0 });
      t.updater.finishDownload('0.1.2');
      expect(t.updater.installs).toEqual([[false, true]]);
    });

    it('pending == feed: «Перезапустить» installs the pending download after the re-check', async () => {
      const t = await pending();
      const checks = t.updater.checks;
      expect(t.flow.install()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.updater.checks).toBe(checks + 1);
      expect(t.updater.downloads).toBe(1);
      expect(t.updater.installs).toEqual([[false, true]]);
    });

    it('a fresh check (< INSTALL_FRESH_MS): installs at once, no re-check', async () => {
      const t = setup();
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      t.updater.finishDownload('0.1.1');
      expect(t.flow.install()).toBe(true);
      expect(t.updater.checks).toBe(1);
      expect(t.updater.installs).toEqual([[false, true]]);
    });

    it('a re-check that hangs: installs the pending download after INSTALL_RECHECK_TIMEOUT_MS', async () => {
      const t = await pending();
      t.updater.checkForUpdates = () => new Promise(() => undefined);
      expect(t.flow.install()).toBe(true);
      await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_TIMEOUT_MS - 1);
      expect(t.updater.installs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.updater.installs).toEqual([[false, true]]);
    });

    it('while pending, the hourly check re-reads the feed and replaces a stale download', async () => {
      const t = setup();
      t.updater.next = { version: '0.1.1' };
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      t.updater.finishDownload('0.1.1');
      // Same version on the feed: re-checked every hour, the pending download stays.
      await vi.advanceTimersByTimeAsync(RECHECK_MS - FIRST_CHECK_MS);
      expect(t.updater.checks).toBe(2);
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      expect(t.updater.downloads).toBe(1);
      // A newer release: the next hourly tick replaces the pending download.
      t.updater.next = { version: '0.1.2' };
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(t.updater.checks).toBe(3);
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.2', percent: 0 });
      expect(t.updater.downloads).toBe(2);
      t.updater.finishDownload('0.1.2');
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.2' });
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      expect(t.updater.installs).toEqual([]); // nobody pressed «Перезапустить»
      t.flow.stop();
    });

    it('while pending, a nudge finding a newer version replaces the download (the bar shows it)', async () => {
      const t = setup();
      t.updater.next = { version: '0.1.1' };
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      t.updater.finishDownload('0.1.1');
      await vi.advanceTimersByTimeAsync(NUDGE_MIN_GAP_MS);
      t.updater.next = { version: '0.1.3' };
      t.flow.nudge('resume');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.statuses).toContainEqual({ state: 'available', version: '0.1.3', installable: true });
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.3', percent: 0 });
      t.updater.finishDownload('0.1.3');
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.3' });
      t.flow.stop();
    });

    describe('install on quit (beforeQuit)', () => {
      /** 0.1.1 downloaded, the last check QUIT_FRESH_MS ago. */
      async function stalePending(opts: Parameters<typeof setup>[0] = {}) {
        const t = setup(opts);
        t.updater.next = { version: '0.1.1' };
        await t.flow.check();
        t.updater.finishDownload('0.1.1');
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS);
        return t;
      }

      it('stale check + a newer feed: holds, re-checks, and does not install the stale file', async () => {
        const t = await stalePending();
        t.updater.next = { version: '0.1.3' };
        const wait = t.flow.beforeQuit(false);
        expect(wait).not.toBeNull();
        await wait;
        expect(t.updater.checks).toBe(2);
        expect(t.updater.autoInstallOnAppQuit).toBe(false);
        expect(t.updater.downloads).toBe(1); // no download started on the way out
        expect(t.updater.installs).toEqual([]);
        // Acts once: the re-issued quit passes through; nothing turns install-on-quit back on.
        expect(t.flow.beforeQuit(false)).toBeNull();
        t.flow.applySettings();
        expect(t.updater.autoInstallOnAppQuit).toBe(false);
      });

      it('stale check + the same version on the feed: installs after the re-check', async () => {
        const t = await stalePending();
        const wait = t.flow.beforeQuit(false);
        expect(wait).not.toBeNull();
        await wait;
        expect(t.updater.checks).toBe(2);
        expect(t.updater.autoInstallOnAppQuit).toBe(true);
      });

      it('fresh check (< QUIT_FRESH_MS): decides at once, no re-check, installs', async () => {
        const t = setup();
        t.updater.next = { version: '0.1.1' };
        await t.flow.check();
        t.updater.finishDownload('0.1.1');
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS - 1);
        expect(t.flow.beforeQuit(false)).toBeNull();
        expect(t.updater.checks).toBe(1);
        expect(t.updater.autoInstallOnAppQuit).toBe(true);
      });

      it('a re-check that hangs: installs after QUIT_RECHECK_TIMEOUT_MS', async () => {
        const t = await stalePending();
        t.updater.checkForUpdates = () => new Promise(() => undefined);
        let done = false;
        void t.flow.beforeQuit(false)?.then(() => (done = true));
        await vi.advanceTimersByTimeAsync(QUIT_RECHECK_TIMEOUT_MS - 1);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
        expect(t.updater.autoInstallOnAppQuit).toBe(true);
      });

      it('a failing re-check (offline): installs', async () => {
        const t = await stalePending();
        t.updater.next = new Error('offline');
        await t.flow.beforeQuit(false);
        expect(t.updater.autoInstallOnAppQuit).toBe(true);
        expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      });

      it('OS shutdown: never waits; the last known feed version decides', async () => {
        const t = await stalePending();
        expect(t.flow.beforeQuit(true)).toBeNull();
        expect(t.updater.checks).toBe(1);
        expect(t.updater.autoInstallOnAppQuit).toBe(true);

        // A newer version already known (its replacement download still running) → no install.
        const u = await stalePending();
        u.updater.next = { version: '0.1.2' };
        await u.flow.check();
        expect(u.flow.status().state).toBe('downloading');
        expect(u.flow.beforeQuit(true)).toBeNull();
        expect(u.updater.autoInstallOnAppQuit).toBe(false);
      });

      it('a newer version already known (replacement downloading): no install, no wait', async () => {
        const t = await stalePending();
        t.updater.next = { version: '0.1.2' };
        await t.flow.check();
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS);
        const checks = t.updater.checks;
        expect(t.flow.beforeQuit(false)).toBeNull();
        expect(t.updater.checks).toBe(checks);
        expect(t.updater.autoInstallOnAppQuit).toBe(false);
      });

      it('nothing downloaded, or «Перезапустить» under way: no wait', async () => {
        const none = setup();
        await none.flow.check();
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS);
        expect(none.flow.beforeQuit(false)).toBeNull();
        expect(none.updater.checks).toBe(1);
        expect(none.updater.autoInstallOnAppQuit).toBe(false);

        const restart = await stalePending();
        restart.updater.checkForUpdates = () => new Promise(() => undefined);
        expect(restart.flow.install()).toBe(true); // waiting for its own re-check
        expect(restart.flow.beforeQuit(false)).toBeNull();
      });
    });
  });

  describe('one update, to the newest (owner, 30.09: several releases a day)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const platforms = [
      ['windows', { platform: 'win32' }],
      ['linux AppImage', { platform: 'linux', appImage: true }],
      ['signed macOS', { platform: 'darwin', signed: true }],
    ] as const;

    /**
     * setup() + a fake Squirrel.Mac staging: `staged` records the flow's downloaded version at each
     * staging (what MacUpdater's proxy serves then); `mode` scripts the outcome.
     */
    function newest(opts: Parameters<typeof setup>[0] = {}) {
      const sq = { staged: [] as string[], mode: 'ok' as 'ok' | 'fail' | 'hang' };
      const ref: { status?: () => UpdateStatus } = {};
      const t = setup({
        ...opts,
        stage: () => {
          const s = ref.status?.() ?? { state: 'none' };
          sq.staged.push(s.state === 'downloaded' ? s.version : `!${s.state}`);
          if (sq.mode === 'ok') return Promise.resolve();
          if (sq.mode === 'fail') return Promise.reject(new Error('code signature invalid'));
          return new Promise<void>(() => undefined);
        },
      });
      ref.status = () => t.flow.status();
      return { ...t, sq };
    }

    /** 0.1.1 downloaded; INSTALL_FRESH_MS later a check finds `next` (its download starts). */
    async function replaced(opts: Parameters<typeof setup>[0], next = '0.1.2') {
      const t = newest(opts);
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      t.updater.finishDownload('0.1.1');
      await vi.advanceTimersByTimeAsync(INSTALL_FRESH_MS);
      t.updater.next = { version: next };
      await t.flow.check();
      return t;
    }

    for (const [name, env] of platforms) {
      const isMac = env.platform === 'darwin';

      it(`${name}: A downloaded, B and C released later → pending C, the bar says C, «Перезапустить» installs C once`, async () => {
        const t = newest(env);
        t.updater.next = { version: '0.1.1' };
        t.flow.start();
        await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
        t.updater.finishDownload('0.1.1');
        t.updater.next = { version: '0.1.2' };
        await vi.advanceTimersByTimeAsync(RECHECK_MS - FIRST_CHECK_MS);
        expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.2', percent: 0 });
        t.updater.finishDownload('0.1.2');
        t.updater.next = { version: '0.1.3' };
        await vi.advanceTimersByTimeAsync(RECHECK_MS);
        t.updater.finishDownload('0.1.3');
        expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.3' });
        expect(t.statuses.flatMap((s) => (s.state === 'downloaded' ? [s.version] : []))).toEqual(['0.1.1', '0.1.2', '0.1.3']);
        expect(t.updater.downloads).toBe(3);
        // Nothing staged in Squirrel.Mac at download time.
        expect(t.updater.autoInstallOnAppQuit).toBe(!isMac);
        expect(t.sq.staged).toEqual([]);
        expect(t.flow.install()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.updater.installs).toEqual([[false, true]]);
        expect(t.sq.staged).toEqual(isMac ? ['0.1.3'] : []);
        t.flow.stop();
      });

      it(`${name}: «Перезапустить» while B downloads → waits for B, installs B (never A)`, async () => {
        const t = await replaced(env);
        expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.2', percent: 0 });
        expect(t.flow.install()).toBe(true);
        await vi.advanceTimersByTimeAsync(INSTALL_STAGE_TIMEOUT_MS * 2);
        expect(t.updater.installs).toEqual([]);
        expect(t.sq.staged).toEqual([]);
        t.updater.finishDownload('0.1.2');
        await vi.advanceTimersByTimeAsync(0);
        expect(t.updater.installs).toEqual([[false, true]]);
        expect(t.sq.staged).toEqual(isMac ? ['0.1.2'] : []);
      });

      it(`${name}: quit while B downloads (A's file is gone) → nothing installed, no wait; the next start fetches B`, async () => {
        const t = await replaced(env);
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS);
        const checks = t.updater.checks;
        expect(t.flow.beforeQuit(false)).toBeNull();
        expect(t.updater.checks).toBe(checks);
        expect(t.updater.autoInstallOnAppQuit).toBe(false);
        expect(t.sq.staged).toEqual([]);
        expect(t.updater.installs).toEqual([]);
      });

      it(`${name}: quit with B downloaded after A → installs B`, async () => {
        const t = await replaced(env);
        t.updater.finishDownload('0.1.2');
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS);
        const wait = t.flow.beforeQuit(false);
        expect(wait).not.toBeNull();
        await wait;
        // Windows / AppImage: electron-updater's quit handler installs its newest file (B).
        expect(t.updater.autoInstallOnAppQuit).toBe(!isMac);
        // macOS: Squirrel.Mac staged B during the held quit and installs it once the app exits.
        expect(t.sq.staged).toEqual(isMac ? ['0.1.2'] : []);
        expect(t.updater.installs).toEqual([]);
      });

      it(`${name}: a feed error keeps A — «Перезапустить» installs A`, async () => {
        const t = newest(env);
        t.updater.next = { version: '0.1.1' };
        await t.flow.check();
        t.updater.finishDownload('0.1.1');
        await vi.advanceTimersByTimeAsync(INSTALL_FRESH_MS);
        t.updater.next = new Error('ENOTFOUND releases.calab.io');
        await t.flow.check();
        expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
        await vi.advanceTimersByTimeAsync(INSTALL_FRESH_MS);
        expect(t.flow.install()).toBe(true); // its re-check fails too
        await vi.advanceTimersByTimeAsync(0);
        expect(t.updater.installs).toEqual([[false, true]]);
        expect(t.sq.staged).toEqual(isMac ? ['0.1.1'] : []);
      });

      it(`${name}: B's download fails → nothing pending (A was deleted with it), B offered; the next check fetches B`, async () => {
        const t = await replaced(env);
        t.updater.emit('error', new Error('ECONNRESET'));
        expect(t.flow.status()).toMatchObject({ state: 'available', version: '0.1.2', installable: true });
        expect(t.flow.install()).toBe(false);
        await t.flow.check();
        expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.2', percent: 0 });
        t.updater.finishDownload('0.1.2');
        expect(t.flow.install()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.updater.installs).toEqual([[false, true]]);
        expect(t.sq.staged).toEqual(isMac ? ['0.1.2'] : []);

        // Quitting right after the failed download installs nothing.
        const u = await replaced(env);
        u.updater.emit('error', new Error('ECONNRESET'));
        expect(u.flow.beforeQuit(false)).toBeNull();
        expect(u.updater.autoInstallOnAppQuit).toBe(false);
        expect(u.sq.staged).toEqual([]);
      });
    }

    describe('macOS staging (Squirrel.Mac)', () => {
      const mac = { platform: 'darwin', signed: true } as const;

      /** 0.1.1 downloaded just now (the last check is fresh). */
      async function macPending() {
        const t = newest(mac);
        t.updater.next = { version: '0.1.1' };
        await t.flow.check();
        t.updater.finishDownload('0.1.1');
        return t;
      }

      it('install-on-quit with a fresh check: stages at once and holds the quit until staged', async () => {
        const t = await macPending();
        const wait = t.flow.beforeQuit(false);
        expect(wait).not.toBeNull();
        await wait;
        expect(t.updater.checks).toBe(1);
        expect(t.sq.staged).toEqual(['0.1.1']);
        expect(t.flow.beforeQuit(false)).toBeNull(); // the re-issued quit passes
      });

      it('install-on-quit: a staging that hangs releases the quit after QUIT_STAGE_TIMEOUT_MS', async () => {
        const t = await macPending();
        t.sq.mode = 'hang';
        let done = false;
        void t.flow.beforeQuit(false)?.then(() => (done = true));
        await vi.advanceTimersByTimeAsync(QUIT_STAGE_TIMEOUT_MS - 1);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
      });

      it('install-on-quit: a newer version on the feed → nothing staged (one update at the next start)', async () => {
        const t = await macPending();
        await vi.advanceTimersByTimeAsync(QUIT_FRESH_MS);
        t.updater.next = { version: '0.1.2' };
        await t.flow.beforeQuit(false);
        expect(t.updater.checks).toBe(2);
        expect(t.sq.staged).toEqual([]);
        expect(t.updater.downloads).toBe(1);
      });

      it('OS shutdown / logout: never waits, nothing staged', async () => {
        const t = await macPending();
        expect(t.flow.beforeQuit(true)).toBeNull();
        expect(t.sq.staged).toEqual([]);
      });

      it('«Перезапустить»: staging fails → no quit, status error; the next check offers the cached download again', async () => {
        const t = await macPending();
        t.sq.mode = 'fail';
        expect(t.flow.install()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.updater.installs).toEqual([]);
        expect(t.flow.status()).toEqual({ state: 'error', message: 'update install failed' });
        // electron-updater finds the file in its cache: 'update-downloaded' without a new transfer.
        await t.flow.check();
        t.updater.finishDownload('0.1.1', []);
        t.sq.mode = 'ok';
        expect(t.flow.install()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.updater.installs).toEqual([[false, true]]);
        expect(t.sq.staged).toEqual(['0.1.1', '0.1.1']);
      });

      it('«Перезапустить»: a staging that hangs gives up after INSTALL_STAGE_TIMEOUT_MS; no checks meanwhile', async () => {
        const t = await macPending();
        t.sq.mode = 'hang';
        expect(t.flow.install()).toBe(true);
        t.updater.next = { version: '0.1.2' };
        await t.flow.check(); // a tick while Squirrel reads the file must not replace it
        expect(t.updater.checks).toBe(1);
        await vi.advanceTimersByTimeAsync(INSTALL_STAGE_TIMEOUT_MS);
        expect(t.updater.installs).toEqual([]);
        expect(t.flow.status().state).toBe('error');
      });
    });
  });

  it('a stale feed offering the running version or older is ignored', async () => {
    const t = setup({ currentVersion: '0.2.0' });
    t.updater.next = { version: '0.1.9' };
    await t.flow.check();
    expect(t.flow.status()).toEqual({ state: 'none' });
    t.updater.next = { version: '0.2.0' };
    await t.flow.check();
    expect(t.flow.status()).toEqual({ state: 'none' });
    t.updater.next = { version: '0.2.1' };
    await t.flow.check();
    expect(t.flow.status().state).toBe('downloading');
  });

  it('unsigned macOS: available with downloadPage, notified once per version, nothing downloaded', async () => {
    const t = setup({ platform: 'darwin', signed: false });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    await t.flow.check();
    expect(t.updater.autoDownload).toBe(false);
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
    expect(t.updater.downloads).toBe(0);
    expect(t.flow.status()).toEqual({ state: 'available', version: '0.1.1', downloadPage: PAGE });
    expect(t.notified).toEqual([['0.1.1', PAGE]]);
    t.updater.next = { version: '0.1.2' };
    await t.flow.check();
    expect(t.notified).toEqual([
      ['0.1.1', PAGE],
      ['0.1.2', PAGE],
    ]);
  });

  it('linux without AppImage (deb): notify only', async () => {
    const t = setup({ platform: 'linux', appImage: false });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    expect(t.updater.downloads).toBe(0);
    expect(t.flow.status().state).toBe('available');
    expect(t.notified).toHaveLength(1);
  });

  it('«Автоматически обновлять» off: notify only; turning it on downloads the available update', async () => {
    const t = setup({ auto: false });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    expect(t.updater.autoDownload).toBe(false);
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
    expect(t.updater.downloads).toBe(0);
    expect(t.flow.status().state).toBe('available');
    expect(t.notified).toEqual([['0.1.1', PAGE]]);
    t.setAuto(true);
    t.flow.applySettings();
    expect(t.updater.autoDownload).toBe(true);
    expect(t.updater.autoInstallOnAppQuit).toBe(true);
    expect(t.updater.downloads).toBe(1);
    expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
  });

  it('turning the setting off clears install-on-quit', async () => {
    const t = setup();
    await t.flow.check();
    t.setAuto(false);
    t.flow.applySettings();
    expect(t.updater.autoDownload).toBe(false);
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
  });

  it('error → status error, logged, no throw; the next check recovers', async () => {
    const t = setup();
    t.updater.next = new Error('ENOTFOUND releases.calab.io');
    await expect(t.flow.check()).resolves.toEqual({ state: 'error', message: 'update failed' });
    expect(t.warns.length).toBeGreaterThan(0);
    expect(t.notified).toEqual([]);
    t.updater.next = 'none';
    expect(await t.flow.check()).toEqual({ state: 'none' });
  });

  it('download error → the version is offered (bar + one notification), not a silent error; «Скачать и установить» retries', async () => {
    const t = setup();
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.emit('download-progress', { percent: 40 });
    t.updater.emit('error', new Error('sha512 mismatch'));
    expect(t.flow.status()).toEqual({ state: 'available', version: '0.1.1', downloadPage: PAGE, installable: true });
    expect(t.notified).toEqual([['0.1.1', PAGE]]);
    expect(t.flow.install()).toBe(false);
    expect(t.flow.download()).toBe(true);
    expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
    t.updater.emit('error', new Error('again'));
    // Still offered, notified once per version.
    expect(t.flow.status().state).toBe('available');
    expect(t.notified).toEqual([['0.1.1', PAGE]]);
  });

  it('download error without a download page → offered with the page of the checked feed', async () => {
    const t = setup({ downloadPage: () => null });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.emit('error', new Error('403'));
    expect(t.flow.status()).toEqual({ state: 'available', version: '0.1.1', downloadPage: FEED, installable: true });
  });

  it('check error (nothing known about a version) stays an error', async () => {
    const t = setup();
    t.updater.next = new Error('403 Forbidden');
    expect((await t.flow.check()).state).toBe('error');
    expect(t.notified).toEqual([]);
  });

  describe('update channel (owner 12.10: GitHub by default, or the S3 feed)', () => {
    const GH: FeedSource = { provider: 'github', owner: 'itrcz', repo: 'calab' };
    const S3: FeedSource = { provider: 'generic', url: FEED };

    it('github source: handed to the updater as is, auto-installs like the S3 feed', async () => {
      const t = setup({ platform: 'darwin', signed: true, pinnedFeed: () => GH });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.feed).toBe('github:itrcz/calab');
      expect(t.updater.autoDownload).toBe(true);
      expect(t.updater.downloads).toBe(1);
    });

    it('github source + unsigned macOS → notify with the download page', async () => {
      const t = setup({ platform: 'darwin', pinnedFeed: () => GH });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.downloads).toBe(0);
      expect(t.notified).toEqual([['0.1.1', PAGE]]);
    });

    it('the channel is read per check; a switch mid-download keeps the download trusted', async () => {
      let src: FeedSource = GH;
      const t = setup({ pinnedFeed: () => src });
      await t.flow.check();
      expect(t.updater.feed).toBe('github:itrcz/calab');
      src = S3;
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.feed).toBe(FEED);
      expect(t.flow.status().state).toBe('downloading');
      src = GH;
      // A check while downloading is skipped (busy): the running download and its install-on-quit stay.
      await t.flow.check();
      expect(t.updater.feed).toBe(FEED);
      t.flow.applySettings();
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      t.updater.finishDownload('0.1.1');
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      // The re-check of the pending download goes to the newly chosen channel.
      await t.flow.check();
      expect(t.updater.feed).toBe('github:itrcz/calab');
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
    });
  });

  describe('«Скачать и установить» (docs/09 #93)', () => {
    it('auto off: available is installable; download() → downloading (speed) → downloaded → install', async () => {
      const t = setup({ auto: false });
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.flow.status()).toEqual({ state: 'available', version: '0.1.1', downloadPage: PAGE, installable: true });
      expect(t.updater.autoInstallOnAppQuit).toBe(false);
      expect(t.flow.download()).toBe(true);
      expect(t.updater.downloads).toBe(1);
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
      t.updater.emit('download-progress', { percent: 42.7, bytesPerSecond: 1_234_567.8 });
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 42, bytesPerSecond: 1_234_568 });
      expect(t.flow.download()).toBe(false); // already downloading
      t.updater.finishDownload('0.1.1');
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      // Re-reading the (still off) setting keeps install-on-quit for the requested download.
      t.flow.applySettings();
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      expect(t.flow.install()).toBe(true);
      expect(t.updater.installs).toEqual([[false, true]]);
      expect(t.updater.downloads).toBe(1);
    });

    const notInstallable = [
      ['unsigned macOS', { platform: 'darwin' }],
      ['linux deb', { platform: 'linux' }],
      ['server-derived feed', { pinnedFeed: () => null, notifyFeed: () => SERVER_FEED }],
    ] as const;
    for (const [name, env] of notInstallable) {
      it(`${name}: not installable, download() refuses (only the download page)`, async () => {
        const t = setup({ ...env, auto: false });
        t.updater.next = { version: '0.1.1' };
        await t.flow.check();
        const s = t.flow.status();
        expect(s.state).toBe('available');
        expect(s.state === 'available' && s.installable).toBeFalsy();
        expect(t.flow.download()).toBe(false);
        expect(t.updater.downloads).toBe(0);
        expect(t.updater.autoInstallOnAppQuit).toBe(false);
      });
    }

    it('nothing available / error → download() refuses; a download error offers it again, download() retries', async () => {
      const t = setup({ auto: false });
      await t.flow.check();
      expect(t.flow.download()).toBe(false);
      t.updater.next = new Error('offline');
      await t.flow.check();
      expect(t.flow.status().state).toBe('error');
      expect(t.flow.download()).toBe(false);
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.flow.download()).toBe(true);
      t.updater.emit('error', new Error('sha512 mismatch'));
      expect(t.flow.status()).toMatchObject({ state: 'available', version: '0.1.1', installable: true });
      expect(t.flow.download()).toBe(true);
      expect(t.updater.downloads).toBe(2);
    });
  });

  it('concurrent checks share one updater call', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.flow.check(), t.flow.check()]);
    expect(a).toEqual(b);
    expect(t.updater.checks).toBe(1);
  });

  describe('timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('first check after 10 s, then every hour; start() is idempotent; manual checks add no timers', async () => {
      const t = setup();
      t.flow.start();
      t.flow.start();
      await t.flow.check();
      expect(t.updater.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
      expect(t.updater.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.updater.checks).toBe(2);
      await vi.advanceTimersByTimeAsync(RECHECK_MS - FIRST_CHECK_MS);
      expect(t.updater.checks).toBe(3);
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(t.updater.checks).toBe(4);
      expect(vi.getTimerCount()).toBe(1);
      t.flow.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    for (const [r, shift] of [
      [0, -RECHECK_JITTER_MS],
      [0.999999, RECHECK_JITTER_MS],
    ] as const) {
      it(`the hourly period is shifted by the jitter (random ${r} → ${shift / 60_000} min)`, async () => {
        const t = setup({ random: () => r });
        t.flow.start();
        const period = RECHECK_MS + shift;
        await vi.advanceTimersByTimeAsync(period - 1_000);
        expect(t.updater.checks).toBe(1); // only the startup check
        await vi.advanceTimersByTimeAsync(1_000);
        expect(t.updater.checks).toBe(2);
        await vi.advanceTimersByTimeAsync(period);
        expect(t.updater.checks).toBe(3);
        t.flow.stop();
      });
    }

    it('«Проверять обновления автоматически» off: no startup / hourly / nudge checks, «Проверить» still works', async () => {
      const t = setup({ autoCheck: false });
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + RECHECK_MS * 3);
      t.flow.nudge('online');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(0);
      expect(await t.flow.check()).toEqual({ state: 'none' });
      expect(t.updater.checks).toBe(1);
      // Turned back on: the next hourly tick checks again.
      t.setAutoCheck(true);
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(t.updater.checks).toBe(2);
      t.flow.stop();
    });

    it('nudge: debounced, one timer, nothing before start(); throttled to once per 10 min', async () => {
      const t = setup();
      t.flow.nudge('resume');
      expect(vi.getTimerCount()).toBe(0);
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      expect(t.updater.checks).toBe(1);
      // Right after the startup check: throttled.
      t.flow.nudge('resume');
      t.flow.nudge('online');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(NUDGE_MIN_GAP_MS);
      t.flow.nudge('resume');
      t.flow.nudge('unlock');
      t.flow.nudge('online');
      expect(vi.getTimerCount()).toBe(2); // periodic + one nudge
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
      // Unlock 1 min later: within 10 min of the last check → nothing.
      await vi.advanceTimersByTimeAsync(60_000);
      t.flow.nudge('unlock');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      // Window focus 10 min after the last check: a check (several releases a day).
      await vi.advanceTimersByTimeAsync(NUDGE_MIN_GAP_MS);
      t.flow.nudge('focus');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(3);
      t.flow.stop();
    });

    it('a manual check during the nudge debounce throttles the nudge', async () => {
      const t = setup();
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + NUDGE_MIN_GAP_MS);
      t.flow.nudge('online');
      await t.flow.check();
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      t.flow.stop();
    });

    it('nudge while downloading: no check; downloaded: a throttled re-check of the feed', async () => {
      const t = setup();
      t.updater.next = { version: '0.1.1' };
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + NUDGE_MIN_GAP_MS);
      expect(t.flow.status().state).toBe('downloading');
      t.flow.nudge('resume');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(1);
      t.updater.finishDownload('0.1.1');
      t.flow.nudge('online');
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      t.flow.nudge('online'); // within NUDGE_MIN_GAP_MS of that check
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
      t.flow.stop();
    });
  });
});
