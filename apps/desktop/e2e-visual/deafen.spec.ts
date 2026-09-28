import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { IDS } from '../e2e-support/fixtures';
import { startPublisher, type Publisher } from './publisher';

/**
 * Deafen holds for a voice that arrives later (docs/09 #70, issues #11/#12, docs/02 «Deafen»):
 * deafen → a new participant publishes a microphone (a 440 Hz tone) → its <audio> element is
 * muted from the start; something writing `muted = false` behind our back (LiveKit's
 * Room.startAudio) is undone; undeafen makes it audible and returns the mic as it was.
 *
 * Self-contained, like mobile.web.spec.ts: the mock API serving dist-web (`pnpm build:web`) on
 * CALABA_DEAFEN_MOCK_PORT (or CALABA_VISUAL_MOCK_PORT, default 39475) + the dev LiveKit
 * (`pnpm infra:dev`); MOCK_LIVEKIT_ROOM_PREFIX for parallel runs. Chromium only; skipped on a
 * stand run (CALABA_WEB_URL set). The browser plays with --mute-audio: the check is the element state.
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-web');
const PORT = Number(process.env['CALABA_DEAFEN_MOCK_PORT'] ?? process.env['CALABA_VISUAL_MOCK_PORT'] ?? 39475);
const BASE = `http://127.0.0.1:${PORT}`;

test.skip(({ browserName }) => browserName !== 'chromium' || process.env['CALABA_WEB_URL'] !== undefined, 'self-contained mock run, Chromium');

let mock: ChildProcess | undefined;
test.beforeAll(async ({ browserName }) => {
  if (browserName !== 'chromium' || process.env['CALABA_WEB_URL'] !== undefined) return;
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const proc = spawn(process.execPath, ['--import', 'tsx', 'e2e-support/mock-server.ts', '--port', String(PORT), '--static', DIST, '--quiet'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  mock = proc;
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('mock server did not start')), 30_000);
    proc.stdout.on('data', (b: Buffer) => {
      if (b.toString().includes('Calaba mock server')) {
        clearTimeout(timer);
        ok();
      }
    });
    proc.on('exit', (code) => fail(new Error(`mock server exited: ${String(code)}`)));
  });
});
test.afterAll(() => {
  mock?.kill('SIGTERM');
});

/** Remote audio elements of the call (services/voice.ts puts them in #remote-audio-sink). */
function remoteAudio(page: Page): Promise<Array<{ muted: boolean; volume: number; tracks: number }>> {
  // A string, like the other web specs: this file is compiled without the DOM lib.
  return page.evaluate<Array<{ muted: boolean; volume: number; tracks: number }>>(`[...document.querySelectorAll('#remote-audio-sink audio')].map((el) => ({
      muted: el.muted,
      volume: el.volume,
      tracks: el.srcObject instanceof MediaStream ? el.srcObject.getAudioTracks().length : 0,
    }))`);
}

test('deafen: a participant who joins later stays silent; undeafen restores sound and the mic', async ({ page, request }) => {
  test.setTimeout(120_000);
  expect((await request.post(`${BASE}/__mock/reset`, { data: {} })).ok()).toBe(true);
  await page.goto(`${BASE}/?visual-test`);
  await page.evaluate(`localStorage.setItem('calaba-prefs', ${JSON.stringify(JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 }))})`);
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  await page.locator('aside button', { hasText: 'Созвон' }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });

  // Mic off first, then deafen: undeafen must bring back «off», not turn the mic on (#11).
  await page.getByRole('button', { name: 'Выключить микрофон', exact: true }).click();
  await page.getByRole('button', { name: 'Выключить звук', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Включить звук', exact: true })).toBeVisible();

  let vera: Publisher | undefined;
  try {
    vera = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.call, source: 'microphone' });
    // Her voice is subscribed and attached — and muted from the first sample.
    await expect.poll(async () => (await remoteAudio(page)).filter((a) => a.tracks > 0).length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect((await remoteAudio(page)).every((a) => a.muted)).toBe(true);

    // A write behind our back (LiveKit Room.startAudio sets muted = false) is undone.
    await page.evaluate(`for (const el of document.querySelectorAll('#remote-audio-sink audio')) el.muted = false;`);
    await expect.poll(async () => (await remoteAudio(page)).every((a) => a.muted)).toBe(true);

    // Undeafen: audible again; the mic is still off as before deafen.
    await page.getByRole('button', { name: 'Включить звук', exact: true }).click();
    await expect.poll(async () => (await remoteAudio(page)).some((a) => a.tracks > 0 && !a.muted && a.volume > 0)).toBe(true);
    await expect(page.getByRole('button', { name: 'Включить микрофон', exact: true })).toBeVisible();
  } finally {
    await vera?.stop();
  }
});
