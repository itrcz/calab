import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../shared/ipc';
import { FIRST_CHECK_MS, NUDGE_MS, ONLINE_POLL_MS, RECHECK_MS, canAutoInstall, createUpdateFlow, type UpdateFlowEnv, type UpdaterLike } from './updateFlow';

const FEED = 'https://releases.calab.ru/';
const SERVER_FEED = 'https://chat.example.com/download/';
const PAGE = 'https://app.calab.ru/download/';

/** Scripted electron-updater: `next` decides what the next check emits. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  feed = '';
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  next: 'none' | { version: string } | Error | 'inactive' = 'none';

  setFeedURL(o: { provider: 'generic'; url: string }): void {
    this.feed = o.url;
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

function setup(over: Partial<UpdateFlowEnv> & { auto?: boolean } = {}) {
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const notified: Array<[string, string]> = [];
  const warns: unknown[][] = [];
  let autoUpdate = over.auto ?? true;
  const flow = createUpdateFlow(updater, {
    platform: 'win32',
    signed: false,
    appImage: false,
    autoUpdate: () => autoUpdate,
    buildFeed: FEED,
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
    const t = setup({ buildFeed: null, notifyFeed: () => null });
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
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      expect(t.updater.downloads).toBe(1);
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
      t.updater.finishDownload('0.1.1');
      const percents = t.statuses.flatMap((s) => (s.state === 'downloading' ? [s.percent] : []));
      expect(percents).toEqual([0, 12, 57, 100]);
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      expect(t.notified).toEqual([]);
      expect(t.flow.install()).toBe(true);
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
        const t = setup({ ...env, buildFeed: null, notifyFeed: () => SERVER_FEED });
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

  it('install() without a downloaded update does nothing', async () => {
    const t = setup();
    await t.flow.check();
    expect(t.flow.install()).toBe(false);
    expect(t.updater.installs).toEqual([]);
  });

  it('downloaded: later checks do not reset the banner', async () => {
    const t = setup();
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.finishDownload('0.1.1');
    const checks = t.updater.checks;
    expect(await t.flow.check()).toEqual({ state: 'downloaded', version: '0.1.1' });
    expect(t.updater.checks).toBe(checks);
    t.updater.emit('error', new Error('late'));
    expect(t.flow.status().state).toBe('downloaded');
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
    t.updater.next = new Error('ENOTFOUND releases.calab.ru');
    await expect(t.flow.check()).resolves.toEqual({ state: 'error', message: 'update failed' });
    expect(t.warns.length).toBeGreaterThan(0);
    expect(t.notified).toEqual([]);
    t.updater.next = 'none';
    expect(await t.flow.check()).toEqual({ state: 'none' });
  });

  it('download error → status error', async () => {
    const t = setup();
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.emit('download-progress', { percent: 40 });
    t.updater.emit('error', new Error('sha512 mismatch'));
    expect(t.flow.status().state).toBe('error');
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

    it('first check after 10 s, then every 6 h; start() is idempotent; manual checks add no timers', async () => {
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

    it('resume: one debounced check, no duplicate timers; nothing before start()', async () => {
      const t = setup();
      t.flow.resume();
      expect(vi.getTimerCount()).toBe(0);
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      expect(t.updater.checks).toBe(1);
      t.flow.resume();
      t.flow.resume();
      t.flow.resume();
      expect(vi.getTimerCount()).toBe(2); // periodic + one nudge
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
      t.flow.stop();
    });

    it('resume while downloading / downloaded: no check', async () => {
      const t = setup();
      t.updater.next = { version: '0.1.1' };
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      expect(t.flow.status().state).toBe('downloading');
      t.flow.resume();
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      t.updater.finishDownload('0.1.1');
      t.flow.resume();
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      t.flow.stop();
    });

    it('failed check offline → re-check once the network is back (debounced, single watcher)', async () => {
      let online = false;
      const t = setup({ isOnline: () => online });
      t.updater.next = new Error('ENOTFOUND');
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      expect(t.flow.status().state).toBe('error');
      expect(vi.getTimerCount()).toBe(2); // periodic + online watcher
      await t.flow.check(); // another failure does not add a watcher
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(ONLINE_POLL_MS * 3);
      expect(t.updater.checks).toBe(2);
      online = true;
      t.updater.next = 'none';
      await vi.advanceTimersByTimeAsync(ONLINE_POLL_MS);
      expect(t.updater.checks).toBe(2); // debounced
      await vi.advanceTimersByTimeAsync(NUDGE_MS);
      expect(t.updater.checks).toBe(3);
      expect(t.flow.status()).toEqual({ state: 'none' });
      expect(vi.getTimerCount()).toBe(1); // watcher gone
      t.flow.stop();
    });

    it('failed check while online: waits for an offline → online transition, not a retry loop', async () => {
      let online = true;
      const t = setup({ isOnline: () => online });
      t.updater.next = new Error('404');
      t.flow.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + ONLINE_POLL_MS * 5 + NUDGE_MS);
      expect(t.updater.checks).toBe(1);
      online = false;
      await vi.advanceTimersByTimeAsync(ONLINE_POLL_MS);
      online = true;
      await vi.advanceTimersByTimeAsync(ONLINE_POLL_MS + NUDGE_MS);
      expect(t.updater.checks).toBe(2);
      t.flow.stop();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
