#!/usr/bin/env node
/**
 * win-smoke.yml helper (TESTING.md «Windows smoke»): drives an INSTALLED Calab build, logged in to the
 * e2e-support mock server (owner@calaba.test), through every rail section and every settings tab,
 * with a screenshot per step, and reports whether the app (main and renderer) survived.
 *
 *   node scripts/win-smoke-app.mjs <path to Calab.exe> <userData dir> <out dir> <mock url>
 *
 * Needs the desktop devDependencies installed (@playwright/test). Test only.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron } = require('@playwright/test');

const [exe, userData, out, mockUrl] = process.argv.slice(2);
if (!exe || !userData || !out || !mockUrl) {
  console.error('usage: win-smoke-app.mjs <exe> <userData> <out> <mock url>');
  process.exit(2);
}
const shots = join(out, 'app-shots');
mkdirSync(shots, { recursive: true });
const report = (line) => {
  console.log(line);
  appendFileSync(join(out, 'summary.txt'), `${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const app = await _electron.launch({
  executablePath: exe,
  args: ['--enable-logging', '--v=0'],
  env: { ...process.env, CALABA_USER_DATA: userData, CALABA_SERVER_URL: mockUrl, CALABA_ALLOW_INSECURE_HTTP: '1', CALABA_FAKE_MEDIA: '1' },
  timeout: 60_000,
});
let gone = null;
app.process().on('exit', (code, signal) => {
  gone = `code=${code} signal=${signal}`;
  report(`app: MAIN PROCESS EXITED ${gone}`);
});
app.process().stderr?.on('data', (d) => appendFileSync(join(out, 'app-stderr.txt'), d));

const page = await app.firstWindow({ timeout: 60_000 });
page.on('crash', () => report('app: RENDERER CRASHED'));
page.on('pageerror', (e) => appendFileSync(join(out, 'app-pageerrors.txt'), `${e.stack ?? e}\n`));
page.on('console', (m) => appendFileSync(join(out, 'app-console.txt'), `[${m.type()}] ${m.text()}\n`));

const shot = async (name) => {
  if (gone) return;
  await page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) }).catch((e) => report(`app: screenshot ${name} failed ${String(e).slice(0, 200)}`));
};
const step = async (name, fn) => {
  if (gone) return;
  try {
    await fn();
    report(`app: ${name} ok`);
  } catch (e) {
    report(`app: ${name} FAILED ${String(e).split('\n')[0].slice(0, 300)}`);
  }
  await sleep(2500);
  await shot(name.replace(/[^\w-]+/g, '_').slice(0, 40));
};

await page.waitForLoadState('domcontentloaded');
await step('prefs', async () => {
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  await page.reload();
});
await step('login', async () => {
  await page.getByLabel('Email').fill('owner@calaba.test', { timeout: 30_000 });
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByTestId('section-rail').waitFor({ timeout: 30_000 });
});
await sleep(10_000);
await shot('logged-in');

const rail = page.getByTestId('section-rail');
const tiles = gone ? 0 : await rail.locator('button, a').count().catch(() => 0);
report(`app: rail tiles=${tiles}`);
for (let i = 0; i < tiles; i++) {
  const label = (await rail.locator('button, a').nth(i).getAttribute('aria-label').catch(() => null)) ?? `tile${i}`;
  await step(`section ${label}`, () => rail.locator('button, a').nth(i).click({ timeout: 10_000 }));
  await sleep(3000);
}

await step('settings open', () => page.getByRole('button', { name: /^Настройки/ }).first().click({ timeout: 10_000 }));
const dialog = page.getByRole('dialog', { name: 'Настройки' });
const tabs = gone ? 0 : await dialog.getByRole('tab').count().catch(() => 0);
report(`app: settings tabs=${tabs}`);
for (let i = 0; i < tabs; i++) {
  const label = (await dialog.getByRole('tab').nth(i).textContent().catch(() => null))?.trim() || `tab${i}`;
  await step(`settings ${label}`, () => dialog.getByRole('tab').nth(i).click({ timeout: 10_000 }));
}
await step('settings close', () => page.keyboard.press('Escape'));

// Idle logged in for a while (gateway, presence, timers, the mail engine if any).
await sleep(45_000);
await shot('idle');
report(`app: done, main alive=${!gone}`);
await app.close().catch(() => {});
process.exit(0);
