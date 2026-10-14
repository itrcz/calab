import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, devices, expect, test, webkit, type ElectronApplication, type Page } from '@playwright/test';
import { IDS, MARKETING_IDS, startMockServer } from '../e2e-support/mock-server';
import { NOW } from '../e2e-visual/harness';
import { startPublisher } from '../e2e-visual/publisher';

/**
 * Packaged-app window captures (docs/09 #52). No longer the README / landing source: those come from
 * landing.spec.ts per UI language (docs/09 #110); kept for real-frame shots on demand. The packaged app (vibrancy, the system window frame
 * and shadow), mock data, captured by the window server with `screencapture -l` at the display's
 * native 2x. No resizing, no 1x copies. `<name>-<theme>@2x.png` has no shadow (exact window size);
 * `chat-<theme>-shadow@2x.png` keeps the system shadow for the hero.
 * Data: the mock's `marketing` scenario (e2e-support/fixtures-marketing.ts); Вера shares a
 * release checklist slide (e2e-support/assets/stream-slide.png). Shots: onboarding, chat (hero: in
 * voice, Борис speaking, the room card with its status, a DM badge on the rail), settings (guest
 * link), dm (list + conversation), stream; `mobile-dark@2x.png` — the web client in WebKit on an
 * iPhone 14 viewport (390×844 pt at 2x; needs dist-web: `pnpm build:web`).
 * CALABA_MARKETING_PORT: the mock's port (a worktree run keeps its own, README «Parallel visual runs»).
 */
const APP = process.env['CALABA_APP'] ?? resolve(import.meta.dirname, '../dist/mac-arm64/Calab.app/Contents/MacOS/Calab');
const OUT = resolve(import.meta.dirname, '../../../docs/images');
const WINDOW = { width: 1440, height: 900 };
const PORT = Number(process.env['CALABA_MARKETING_PORT'] ?? 39180);
const DIST_WEB = resolve(import.meta.dirname, '../dist-web');
const STATUS = 'Планёрка по релизу 0.2';


function windowId(owner: string): string {
  const out = execFileSync('swift', [resolve(import.meta.dirname, '../scripts/window-id.swift'), owner], { encoding: 'utf8' });
  // "<id> <width> <height> <title>" per on-screen window; the main window is the largest.
  const rows = out.trim().split('\n').filter(Boolean).map((l) => l.split(' '));
  rows.sort((a, b) => Number(b[1]) * Number(b[2]) - Number(a[1]) * Number(a[2]));
  const id = rows[0]?.[0];
  if (!id) throw new Error(`no on-screen window for ${owner}`);
  return id;
}

const frontmostPid = (): string =>
  execFileSync('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'], { encoding: 'utf8' }).trim();

/** The app is frontmost and its main window is key. */
async function isActive(app: ElectronApplication): Promise<boolean> {
  return frontmostPid() === String(app.process().pid) && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false));
}

/**
 * Makes the main window key in the frontmost app: the window server draws an inactive window
 * with grey traffic lights (Electron's isFocused() can be true while another app is active).
 */
async function activate(app: ElectronApplication): Promise<boolean> {
  const pid = app.process().pid;
  if (frontmostPid() !== String(pid)) {
    execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
  }
  await app.evaluate(({ app: a, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.show();
    a.focus({ steal: true });
    w?.focus();
  });
  return isActive(app);
}

async function shoot(app: ElectronApplication, page: Page, name: string, shadow = false): Promise<void> {
  await expect.poll(() => activate(app)).toBe(true);
  // No focus rings / hover-revealed controls (e.g. the stream toolbar shows on focus-within).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(WINDOW.width - 2, WINDOW.height - 2);
  await page.waitForTimeout(1200); // vibrancy + fonts + animations settle
  const id = windowId('Calab');
  const file = join(OUT, `${name}@2x.png`);
  // Another app may take focus while we wait: re-activate and capture until the window stayed key.
  for (let attempt = 0; ; attempt++) {
    await expect.poll(() => activate(app)).toBe(true);
    await page.waitForTimeout(400); // the frame redraws as active
    execFileSync('screencapture', ['-x', ...(shadow ? [] : ['-o']), `-l${id}`, file]);
    if ((await isActive(app)) || attempt >= 4) break;
  }
  const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  console.log(name, size.replace(/\s+/g, ' ').trim(), `${(statSync(file).size / 1e6).toFixed(1)} MB`);
}

/** Who speaks (VoiceBar's visual-test hook): fixture members have no LiveKit audio. */
async function speaking(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.(list), ids);
}

for (const theme of ['dark', 'light'] as const) {
  test(`marketing ${theme}`, async () => {
    test.skip(process.platform !== 'darwin', 'macOS only (screencapture, vibrancy)');
    const mock = await startMockServer({ port: PORT, scenario: 'marketing' });
    const userData = mkdtempSync(join(tmpdir(), 'calab-shots-'));
    const app = await electron.launch({
      executablePath: APP,
      args: ['--lang=ru', '--mute-audio'], // Russian UI on any host (ADR-0022); no test sound
      env: {
        ...process.env,
        CALABA_SERVER_URL: mock.url,
        CALABA_USER_DATA: userData,
        CALABA_MULTI_INSTANCE: '1',
        CALABA_FAKE_MEDIA: '1',
        CALABA_VISUAL_TEST: '1',
        TZ: 'Europe/Moscow',
        LANG: 'ru_RU.UTF-8',
      },
    });
    let publisher: Awaited<ReturnType<typeof startPublisher>> | null = null;
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }, v) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.setSize(v.width, v.height);
        w?.center();
      }, WINDOW);
      await page.clock.setFixedTime(NOW);
      await page.evaluate((t) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: false }, version: 1 })), theme);
      await page.reload();

      // ---- sign in → onboarding «Как включать микрофон»
      await page.getByLabel('Email').fill('owner@calaba.test');
      await page.getByLabel('Пароль', { exact: true }).fill('password123');
      await page.getByRole('button', { name: 'Войти', exact: true }).click();
      await page.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await page.getByRole('button', { name: 'Слышно хорошо' }).click();
      await expect(page.getByTestId('onboarding-mode')).toBeVisible();
      await shoot(app, page, `onboarding-${theme}`);
      await page.getByRole('button', { name: 'Пропустить настройку' }).click();

      // ---- in voice: «Переговорка» with a status, muted (the fake mic would light my own ring)
      const sidebar = page.locator('aside').first();
      await sidebar.getByRole('button', { name: /Переговорка/ }).first().click();
      await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press(`Meta+Shift+m`);
      await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
      await sidebar.getByTestId('voice-status-row').click();
      await sidebar.getByTestId('voice-status-input').fill(STATUS);
      await sidebar.getByTestId('voice-status-input').press('Enter');
      await expect(sidebar.getByTestId('voice-status-row')).toContainText(STATUS);
      // Joined a minute ago: past the «Пригласить» row's 30 s window.
      await page.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
      await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });

      // ---- chat (hero): «общий» while in voice, Борис speaking
      await sidebar.getByRole('button', { name: /общий/ }).first().click();
      await expect(page.locator('[data-message-id]').first()).toBeVisible();
      await page.waitForTimeout(800);
      await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await speaking(page, [IDS.users.boris]);
      await expect(sidebar.getByRole('listitem', { name: /Борис Петров/ })).toHaveAttribute('data-speaking', 'true');
      await shoot(app, page, `chat-${theme}`);
      await shoot(app, page, `chat-${theme}-shadow`, true);

      // ---- room settings → «Ссылка для гостей»
      await page.getByRole('button', { name: 'Настройки комнаты' }).click();
      await page.getByRole('dialog').getByRole('tab', { name: 'Ссылка для гостей' }).click();
      // Shared links are built from the server URL; show the product domain instead of the mock's.
      await expect(page.getByRole('dialog').getByText(`${mock.url}/r/`)).toBeVisible();
      await page.getByRole('dialog').evaluate((dialog, from) => {
        const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = n.nodeValue?.replaceAll(from, 'https://calab.io') ?? null;
      }, mock.url);
      await shoot(app, page, `settings-${theme}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // ---- direct messages: the list and the conversation with Борис
      await page.getByTestId('rail-home').getByRole('button').click();
      const dms = page.getByTestId('dm-list');
      await expect(dms.getByRole('button')).toHaveCount(3);
      await expect(dms).toContainText('Созвонимся в «Переговорке»');
      await expect(dms).toContainText('Спасибо, посмотрю вечером');
      await expect(dms).toContainText('Хорошего отдыха');
      await dms.getByRole('button', { name: /Борис Петров/ }).click();
      await expect(page.getByTestId('dm-header')).toContainText('Борис Петров');
      await expect(page.locator('[data-message-id]')).toHaveCount(4);
      await page.waitForTimeout(800);
      await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await shoot(app, page, `dm-${theme}`);

      // ---- voice room with a screen share on the stage
      await page.getByLabel('Пространства').getByRole('button', { name: /Команда Calab/ }).click();
      await sidebar.getByRole('button', { name: /Переговорка/ }).first().click();
      publisher = await startPublisher({
        userId: IDS.users.vera,
        name: 'Вера Ким',
        roomId: MARKETING_IDS.rooms.meeting,
        image: readFileSync(resolve(import.meta.dirname, '../e2e-support/assets/stream-slide.png')),
      });
      const video = page.locator('video');
      const chip = page.getByRole('button', { name: 'Вера Ким', exact: true });
      await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
      if ((await video.count()) === 0) await chip.first().click();
      await expect.poll(() => video.first().evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0), { timeout: 30_000 }).toBe(true);
      const expand = page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' });
      if (await expand.count()) await expand.first().click();
      await expect(page.getByTestId('stream-stage')).toBeVisible();
      await speaking(page, [IDS.users.boris]);
      await shoot(app, page, `stream-${theme}`);
      await page.getByRole('button', { name: 'Отключиться' }).click();
    } finally {
      await publisher?.stop();
      await app.close().catch(() => undefined);
      await mock.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
}

// ---- mobile web: iPhone 14 in WebKit (Safari's engine), dark, «общий» (docs/09 #21)
test('marketing mobile', async () => {
  test.skip(!existsSync(join(DIST_WEB, 'index.html')), 'dist-web is missing: run `pnpm build:web` first');
  const mock = await startMockServer({ port: PORT, scenario: 'marketing', staticDir: DIST_WEB });
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow', colorScheme: 'dark' });
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    await page.goto(mock.url);
    await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
    await page.goto(mock.url);
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Войти', exact: true }).tap();
    await expect(page.getByTestId('mobile-shell')).toBeVisible();
    // ADR-0073: the app opens on the room list; the row opens the room.
    await page.getByTestId('phone-room-list').getByRole('button', { name: /^общий/ }).first().tap();
    await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
    await expect(page.locator('[data-message-id]').first()).toBeVisible();
    await page.waitForTimeout(1000);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(600);
    const file = join(OUT, 'mobile-dark@2x.png');
    await page.screenshot({ path: file, scale: 'device', animations: 'disabled', caret: 'hide' });
    console.log('mobile-dark', `${(statSync(file).size / 1e6).toFixed(1)} MB`);
    await context.close();
  } finally {
    await browser.close();
    await mock.close();
  }
});
