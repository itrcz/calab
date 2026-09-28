import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * docs/09 #71 (issue #15): the voice seat after a connection loss. The server's record of this
 * device (docs/05 «Восстановление голоса после разрыва») and the LiveKit connection must agree —
 * never «I hear the room but the list does not show me», never a ghost the others see.
 *
 * Self-contained like mobile.web.spec.ts: dist-web (`pnpm build:web`) served by the mock API
 * (child process, port CALABA_VOICE_MOCK_PORT / CALABA_VISUAL_MOCK_PORT, default 39480) and the
 * dev LiveKit (`pnpm infra:dev`); MOCK_LIVEKIT_ROOM_PREFIX keeps parallel runs apart. Chromium only.
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-web');
const PORT = Number(process.env['CALABA_VOICE_MOCK_PORT'] ?? process.env['CALABA_VISUAL_MOCK_PORT'] ?? 39480);
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'mock_';
/** Fixture ids (e2e-support/fixtures.ts IDS: Анна, «Созвон», «Переговорка»). */
const ME = '00000000-0000-7000-8001-000000000001';
const CALL = { id: '00000000-0000-7000-8003-000000000004', name: 'Созвон' };
const MEETING = { id: '00000000-0000-7000-8003-000000000005', name: 'Переговорка' };

let mock: ChildProcess | undefined;
test.beforeAll(async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'voice e2e on the mock: Chromium (fake media)');
  test.skip(!!process.env['CALABA_WEB_URL'], 'mock-only spec: skipped in runs against a stand (CALABA_WEB_URL)');
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
test.beforeEach(async ({ request }) => {
  expect((await request.post(`${BASE}/__mock/reset`, { data: {} })).ok()).toBe(true);
});

const sidebar = (page: Page) => page.locator('aside').first();
const voicePanel = (page: Page) => page.getByRole('region', { name: 'Голосовое подключение' });
/** Voice participants listed under a voice room in the room list. */
const participants = (page: Page, room: string) => sidebar(page).getByRole('list', { name: room, exact: true });

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/?visual-test`);
  await page.evaluate(`localStorage.setItem('calaba-prefs', ${JSON.stringify(JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 }))})`);
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: CALL.name, exact: true })).toBeVisible();
}

/** The server's (mock's) record of my voice seat. */
async function serverSeat(page: Page): Promise<string> {
  const res = await page.request.get(`${BASE}/__mock/voice`);
  const all = (await res.json()) as Record<string, { roomId: string; pending: boolean } | undefined>;
  const me = all[ME];
  return me && !me.pending ? me.roomId : me?.roomId ? `${me.roomId} (pending)` : '';
}

/** The LiveKit room this client is really connected to ('' = none). */
async function livekitRoom(page: Page): Promise<string> {
  // The app's ?visual-test hook (features/shell/VoiceBar.tsx → voice.linkTruth()).
  return page.evaluate<string>(`(() => { const l = window.__calabaVoiceLink?.(); return l && l.state === 'connected' && l.room ? l.room : ''; })()`);
}

async function joinRoom(page: Page, room: { id: string; name: string }): Promise<void> {
  await sidebar(page).getByRole('button', { name: room.name, exact: true }).click();
  await expect(voicePanel(page).getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await expectInSync(page, room);
}

/** Store, server and LiveKit agree: I am in `room` everywhere (the list shows me there too). */
async function expectInSync(page: Page, room: { id: string; name: string }): Promise<void> {
  await expect.poll(() => livekitRoom(page), { timeout: 20_000 }).toBe(`${PREFIX}${room.id}`);
  await expect.poll(() => serverSeat(page), { timeout: 20_000 }).toBe(room.id);
  await expect(participants(page, room.name).getByText('Анна Смирнова')).toBeVisible();
}

async function dropGateway(page: Page, downMs: number): Promise<void> {
  expect((await page.request.post(`${BASE}/__mock/gateway/drop`, { data: { downMs } })).ok()).toBe(true);
}

test('a stale /join of the reconnect cycle lands after a switch: the seat follows LiveKit', async ({ page }) => {
  await signIn(page);
  await joinRoom(page, CALL);

  // LiveKit drops; the reconnect cycle's /join into «Созвон» hangs in the network…
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  await page.route(`**/api/rooms/${CALL.id}/join`, async (route: Route) => {
    held++;
    await gate;
    await route.continue();
  });
  await page.evaluate('window.__calabaVoiceDrop?.()');
  await expect.poll(() => held, { timeout: 10_000 }).toBe(1);

  // …the user clicks another room meanwhile and gets in…
  await sidebar(page).getByRole('button', { name: MEETING.name, exact: true }).click();
  await expect(voicePanel(page).getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => livekitRoom(page), { timeout: 20_000 }).toBe(`${PREFIX}${MEETING.id}`);

  // …and then the stale /join reaches the server, recording me back in «Созвон».
  release(); // later /join calls into «Созвон» pass through the (open) gate
  await expectInSync(page, MEETING);
  await expect(participants(page, CALL.name).getByText('Анна Смирнова')).toHaveCount(0);

  // And back: the switch after the recovery is ordinary.
  await joinRoom(page, CALL);
  await expect(participants(page, MEETING.name).getByText('Анна Смирнова')).toHaveCount(0);
});

test('the server lost my device during a gateway outage: LiveKit still connected → the seat is restored', async ({ page }) => {
  await signIn(page);
  await joinRoom(page, CALL);

  await dropGateway(page, 2000);
  // The device expired on the server meanwhile (participant_left / pending timeout).
  expect((await page.request.post(`${BASE}/__mock/voice`, { data: { userId: ME, roomId: '' } })).ok()).toBe(true);
  await expectInSync(page, CALL);
});

test('the seat cannot be restored (no access any more): leave with a toast, no ghost', async ({ page }) => {
  await signIn(page);
  await joinRoom(page, CALL);

  await page.route(`**/api/rooms/${CALL.id}/join`, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'ERROR_CODE_FORBIDDEN', message: 'CONNECT required' }) }),
  );
  await dropGateway(page, 2000);
  expect((await page.request.post(`${BASE}/__mock/voice`, { data: { userId: ME, roomId: '' } })).ok()).toBe(true);
  await expect(page.getByText('Соединение с голосом потеряно')).toBeVisible({ timeout: 20_000 });
  await expect(voicePanel(page)).toHaveCount(0);
  await expect.poll(() => livekitRoom(page)).toBe('');
  expect(await serverSeat(page)).toBe('');
});

test('my /voice/leave was lost in the outage: the server ghost is cleared after the reconnect', async ({ page }) => {
  await signIn(page);
  await joinRoom(page, CALL);

  await page.route('**/api/rooms/*/voice/leave', (route) => route.abort('internetdisconnected'));
  await voicePanel(page).getByRole('button', { name: 'Отключиться' }).click();
  await expect(voicePanel(page)).toHaveCount(0);
  expect(await livekitRoom(page)).toBe('');
  // The others still see me in «Созвон».
  expect(await serverSeat(page)).toBe(CALL.id);

  await page.unroute('**/api/rooms/*/voice/leave');
  await dropGateway(page, 500);
  await expect.poll(() => serverSeat(page), { timeout: 20_000 }).toBe('');
  await expect(participants(page, CALL.name).getByText('Анна Смирнова')).toHaveCount(0);
});

test('the server holds my seat, LiveKit is lost: back in at once when the connection returns', async ({ page }) => {
  await signIn(page);
  await joinRoom(page, CALL);

  // LiveKit drops and /join cannot get through: the reconnect cycle backs off (1, 2, 4, 8 s).
  let attempts = 0;
  await page.route(`**/api/rooms/${CALL.id}/join`, (route) => {
    attempts++;
    return route.abort('internetdisconnected');
  });
  await page.evaluate('window.__calabaVoiceDrop?.()');
  await expect.poll(() => attempts, { timeout: 15_000 }).toBe(3);
  await expect(voicePanel(page)).toBeVisible(); // the seat stays through the cycle

  // The network is back (the gateway reconnects): no waiting out the 8 s backoff.
  await page.unroute(`**/api/rooms/${CALL.id}/join`);
  await dropGateway(page, 0);
  const t0 = Date.now();
  await expect(voicePanel(page).getByText('Голос подключён')).toBeVisible({ timeout: 20_000 });
  expect(Date.now() - t0, 'rejoined right after the reconnect, not after the backoff').toBeLessThan(6000);
  await expectInSync(page, CALL);
});
