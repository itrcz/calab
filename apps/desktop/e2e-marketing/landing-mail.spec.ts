import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { APP_LOCALE, COPY, type Short } from './copy';
import { COPY3 } from './copy3';
import { drawArt, seedScene } from './seed';

/**
 * Landing 3.3: the desktop mail client (ADR-0088) with a mailbox in the page's language. Mail exists
 * only in the Electron app, so this scene runs the built app (`out/`, `pnpm build:app`) against the
 * mock API with the landing team (seed.ts), at 1440×900 and a forced device scale 2, dark theme.
 *
 * The mailbox: the renderer's own in-memory mail mock (src/renderer/features/mail/mock/mockApi.ts),
 * bundled here with esbuild with its fixtures swapped for mail-fixtures.ts (copy3.ts letters), and
 * answering `mail:request` in Electron's main process in place of the mail engine — no app source
 * is touched, no IMAP server is needed.
 *
 *   pnpm -F @calaba/desktop build:app
 *   cd apps/desktop && pnpm exec playwright test --config playwright.marketing.config.ts landing-mail
 *
 * One Electron at a time (CLAUDE.md). Raw captures: apps/landing/shots/mail-<locale>@2x.png.
 */
const OUT = resolve(import.meta.dirname, '../../landing/shots');
const ROOT = resolve(import.meta.dirname, '..');
const SIZE = { width: 1440, height: 900 };

const ALL: Short[] = ['ru', 'en', 'es', 'zh'];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
const LOCALES = ALL.filter((s) => !wanted || wanted.includes(s));

/** The renderer mail mock with the landing fixtures, as an IIFE exposing `__calabMail.createMockMailApi`. */
async function mailBundle(): Promise<string> {
  const mockDir = resolve(ROOT, 'src/renderer/features/mail/mock');
  const r = await build({
    stdin: { contents: "export { createMockMailApi } from './mockApi';", resolveDir: mockDir, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__calabMail',
    platform: 'node',
    target: 'node20',
    plugins: [
      {
        name: 'landing-mail-fixtures',
        setup(b) {
          b.onResolve({ filter: /^\.\/fixtures$/ }, (a) => (a.resolveDir === mockDir ? { path: resolve(import.meta.dirname, 'mail-fixtures.ts') } : undefined));
        },
      },
    ],
  });
  const out = r.outputFiles[0];
  if (!out) throw new Error('mail bundle: no output');
  return out.text;
}

/** Replaces the mail engine with the bundled mock: `mail:request` answered in main, events sent to the windows. */
async function installMail(app: ElectronApplication, code: string, data: unknown): Promise<void> {
  await app.evaluate(
    ({ ipcMain, BrowserWindow }, a) => {
      (globalThis as unknown as { __calabMailData: unknown }).__calabMailData = a.data;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the test's own bundle, evaluated in main
      const load = new Function(`${a.code}\nreturn __calabMail;`) as () => { createMockMailApi: (o: object) => Record<string, unknown> };
      const mod = load();
      const api = mod.createMockMailApi({ delayMs: 0, syncDelayMs: 0, now: () => (a.data as { now: number }).now });
      (api['onEvent'] as (cb: (e: unknown) => void) => void)((e) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mail:event', e);
      });
      ipcMain.removeHandler('mail:request');
      ipcMain.handle('mail:request', async (_e, call: { method: string; params: unknown[] }) => {
        try {
          const path = call.method.split('.');
          let owner: Record<string, unknown> = api;
          for (const k of path.slice(0, -1)) owner = owner[k] as Record<string, unknown>;
          const fn = owner[path[path.length - 1] ?? ''] as (...p: unknown[]) => Promise<unknown>;
          return { ok: true, result: await fn.apply(owner, call.params) };
        } catch (err) {
          const e = err as { code?: string; message?: string };
          return { ok: false, error: { code: e.code ?? 'INVALID', message: e.message ?? String(err) } };
        }
      });
    },
    { code, data },
  );
}

async function setLocale(page: Page, short: Short): Promise<void> {
  const l = APP_LOCALE[short];
  await page.evaluate((x) => (window as unknown as { __calabaLocale?: (l: string) => void }).__calabaLocale?.(x), l);
  await expect(page.locator('html')).toHaveAttribute('lang', l);
}

let bundle = '';
test.beforeAll(async () => {
  bundle = await mailBundle();
});

for (const short of LOCALES) {
  test(`landing mail ${short}`, async () => {
    test.setTimeout(180_000);
    const c = COPY[short];
    const c3 = COPY3[short];
    let mock: MockServer | undefined;
    let app: ElectronApplication | undefined;
    const userData = mkdtempSync(join(tmpdir(), 'calab-landing-mail-'));
    try {
      mock = await startMockServer({ port: 0, scenario: 'data' });
      mock.setClock(NOW.getTime());
      const art = await chromium.launch();
      try {
        seedScene(mock, c, await drawArt(art, c));
      } finally {
        await art.close();
      }
      app = await electron.launch({
        args: ['.', '--lang=ru', '--mute-audio', '--force-device-scale-factor=2'],
        cwd: ROOT,
        env: {
          ...process.env,
          CALABA_SERVER_URL: mock.url,
          CALABA_USER_DATA: userData,
          CALABA_MULTI_INSTANCE: '1',
          CALABA_FAKE_MEDIA: '1',
          CALABA_VISUAL_TEST: '1',
          ELECTRON_RENDERER_URL: '',
          TZ: 'Europe/Moscow',
          LANG: 'ru_RU.UTF-8',
        },
      });
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }, v) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.setContentSize(v.width, v.height);
        w?.center();
        w?.setIgnoreMouseEvents(true);
      }, SIZE);
      await installMail(app, bundle, { mail: c3.mail, now: NOW.getTime() });
      await page.clock.setFixedTime(NOW);
      await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
      await page.reload();
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(SIZE.width);
      await page.getByLabel('Email').fill('owner@calaba.test');
      await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
      await page.getByRole('button', { name: 'Войти', exact: true }).click();
      await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
      await setLocale(page, short);
      await page.getByTestId('section-mail').click();
      const list = page.getByTestId('mail-list');
      await expect(list.getByTestId('mail-row').first()).toBeVisible({ timeout: 15_000 });
      await list.getByTestId('mail-row').filter({ hasText: c3.mail.letters[0]?.subject ?? '' }).first().click();
      await expect(page.getByTestId('mail-thread')).toBeVisible();
      await expect(page.getByTestId('mail-attachments').first()).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(800);
      await settle(page);
      mkdirSync(OUT, { recursive: true });
      const path = join(OUT, `mail-${short}@2x.png`);
      await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
      console.log('mail', short, `${(statSync(path).size / 1e6).toFixed(1)} MB`);
    } finally {
      await app?.close().catch(() => undefined);
      await mock?.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
    }
  });
}
