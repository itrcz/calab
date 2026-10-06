import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phone layout of the web client (ADR-0021, stage A) on emulated phones (projects `iphone-14`,
 * `pixel-7` in playwright.web.config.ts — Chromium with the device's viewport, touch and UA; fake
 * media). Self-contained: the production build (dist-web, `pnpm build:web`) served same-origin by
 * the deterministic mock API (e2e-support/mock-server.ts as a child process, port
 * CALABA_MOBILE_MOCK_PORT, default 39470); voice needs the dev LiveKit (`pnpm infra:dev`).
 * Parallel local runs: another port and MOCK_LIVEKIT_ROOM_PREFIX keep them apart.
 * CALABA_MOBILE_SHOTS=<dir> also saves the screens as PNGs there (review, not a baseline).
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-web');
const PASSWORD = 'password123';
const NOW = new Date('2026-01-15T13:30:00+03:00');
const PORT = Number(process.env['CALABA_MOBILE_MOCK_PORT'] ?? 39470);
const BASE = `http://127.0.0.1:${PORT}`;

let mock: ChildProcess | undefined;
test.beforeAll(async () => {
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

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['CALABA_MOBILE_SHOTS'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}-${test.info().project.name}.png`) });
}

/** No serious / critical axe violations (the same bar as the visual tests). */
async function expectAccessible(page: Page, name: string): Promise<void> {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('video').analyze();
  const bad = res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`) }));
  expect.soft(bad, `axe: ${name}`).toEqual([]);
}

/** Nothing wider than the screen: no horizontal page scroll. */
async function expectNoHorizontalScroll(page: Page, name: string): Promise<void> {
  const r: { doc: number; body: number; root: number; vw: number } = await page.evaluate(
    '({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, root: document.getElementById("root").scrollWidth, vw: window.innerWidth })',
  );
  expect.soft(Math.max(r.doc, r.body, r.root), `horizontal scroll: ${name}`).toBeLessThanOrEqual(r.vw);
}

async function signIn(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  // The fixtures are dated 2026-01-15 (voice timers, day labels): «now» is fixed there.
  await page.clock.setFixedTime(NOW);
  await page.goto(`${BASE}/?visual-test`);
  await page.evaluate(`localStorage.setItem('calaba-prefs', ${JSON.stringify(JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru', ...prefs }, version: 1 }))})`);
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
}

/**
 * Hold a finger on the element (Chromium CDP touch: real touch → pointer events, so pointer
 * capture works as on a phone). Returns the finger to move / lift.
 */
async function touchHold(page: Page, selector: string): Promise<{ move(x: number, y: number): Promise<void>; up(): Promise<void>; cancel(): Promise<void> }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  return {
    move: async (mx, my) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mx, y: my, id: 1 }] });
    },
    up: async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    cancel: async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    },
  };
}

/** The app opens on the room list (ADR-0073): «общий» from it. */
async function openGeneral(page: Page): Promise<void> {
  await page.getByTestId('phone-room-list').getByRole('button', { name: /^общий/ }).first().tap();
  await expect(page.getByTestId('composer')).toBeVisible();
}

test('phone: sign in → room list → message → voice → PTT hold', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await signIn(page);

  // ADR-0073: the app opens on «Чаты» — the rail and the room list, the tab bar at the bottom.
  const nav = page.getByTestId('phone-chats');
  await expect(nav).toBeVisible();
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  await expect(page.getByTestId('titlebar')).toHaveCount(0);
  await expect(nav.getByRole('navigation', { name: 'Пространства' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'room list');
  await expectAccessible(page, 'room list');
  await shot(page, 'mobile-home');
  // The whole row opens the room (pushed: «←», no tab bar).
  await nav.getByTestId('phone-room-list').getByRole('button', { name: /^общий/ }).first().tap();
  await expect(page.getByRole('heading', { name: 'общий', exact: true })).toBeVisible();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);

  // Composer: 16 px field (no iOS zoom), send with the round button.
  const box = page.getByPlaceholder('Сообщение в #общий');
  await expect(box, 'composer font size').toHaveCSS('font-size', '16px');
  await box.tap();
  await box.fill('Привет с телефона');
  await page.getByRole('button', { name: 'Отправить' }).tap();
  await expect(page.getByText('Привет с телефона').last()).toBeVisible();
  await expect(box).toHaveValue('');
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await expectAccessible(page, 'chat');
  await expectNoHorizontalScroll(page, 'chat after send');
  await shot(page, 'mobile-chat');

  // Members: a screen of their own; the browser's back (Android back) returns to the room.
  await page.getByRole('button', { name: 'Участники' }).tap();
  const members = page.getByTestId('members-page');
  await expect(members.getByRole('complementary', { name: 'Участники' })).toBeVisible();
  await expectAccessible(page, 'members');
  await page.goBack();
  await expect(members).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'общий', exact: true })).toBeVisible();

  // Voice: «←» to the list, «Созвон» → the handset in its header → the compact strip at the bottom.
  await page.getByTestId('phone-back').tap();
  await nav.getByTestId('phone-room-list').getByRole('button', { name: /^Созвон/ }).first().tap();
  await page.getByTestId('room-header-join').tap();
  const strip = page.getByTestId('mobile-voice-strip');
  await expect(strip.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  const stripBox = await strip.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  expect(stripBox && stripBox.y + stripBox.height, 'strip at the bottom edge').toBeGreaterThan(vh - 80);
  await expectNoHorizontalScroll(page, 'voice');
  await expectAccessible(page, 'voice strip');

  // Push-to-talk mode (settings sheet, from «Я») → the strip gets the hold button.
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-tab-me').tap();
  await page.getByTestId('phone-me-voice').tap();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  await settings.getByRole('radio', { name: 'Push-to-talk' }).tap();
  await expect(settings.getByRole('radio', { name: 'Push-to-talk' })).toHaveAttribute('aria-checked', 'true');
  await expectNoHorizontalScroll(page, 'settings');
  await shot(page, 'mobile-settings');
  await settings.getByRole('button', { name: 'Закрыть', exact: true }).tap();
  await expect(settings).toHaveCount(0);

  // PTT: held = on air; sliding the finger off keeps it (pointer capture); lifting ends it.
  const ptt = '[data-testid="ptt-hold"]';
  await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'false');
  if (browserName === 'chromium') {
    const finger = await touchHold(page, ptt);
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'true');
    await expect(strip.getByText('В эфире'), 'status line while on air').toBeVisible();
    await shot(page, 'mobile-voice-ptt');
    await finger.move(20, 200);
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'true');
    await finger.up();
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'false');
    // The system taking the gesture (touchcancel) releases it too — never stuck on.
    const again = await touchHold(page, ptt);
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'true');
    await again.cancel();
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'false');
  } else {
    // WebKit: no CDP touch input — the same press / release path from the keyboard (Space held).
    // No fake microphone there, so no «В эфире» (nothing is transmitted).
    await page.locator(ptt).focus();
    await page.keyboard.down(' ');
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.up(' ');
    await expect(page.locator(ptt)).toHaveAttribute('aria-pressed', 'false');
  }

  // Mute from the strip, then hang up.
  await strip.getByRole('button', { name: 'Выключить микрофон' }).tap();
  await expect(strip.getByRole('button', { name: 'Включить микрофон' })).toHaveAttribute('aria-pressed', 'true');
  await strip.getByRole('button', { name: 'Отключиться' }).tap();
  await expect(strip).toHaveCount(0);
});

test('phone: dialogs and menus are bottom sheets', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('phone-room-list').getByRole('button', { name: /^общий/ }).first().tap();
  // Attach menu (📎) → a sheet across the bottom, with the camera capture item.
  await page.getByRole('button', { name: 'Прикрепить файл' }).tap();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Камера' })).toBeVisible();
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  const m = await menu.boundingBox();
  expect(m?.width, 'menu sheet: full width').toBe(vp.width);
  expect(Math.round((m?.y ?? 0) + (m?.height ?? 0)), 'menu sheet: at the bottom').toBe(vp.height);
  await expect(page.getByTestId('composer-camera-input')).toHaveAttribute('capture', 'environment');
  await page.keyboard.press('Escape');

  // A modal (create workspace from the rail) → bottom sheet.
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-chats').getByRole('button', { name: 'Создать пространство' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Новое пространство' });
  await expect(dialog).toBeVisible();
  const d = await dialog.boundingBox();
  expect(d?.width, 'dialog sheet: full width').toBe(vp.width);
  expect(Math.round((d?.y ?? 0) + (d?.height ?? 0)), 'dialog sheet: at the bottom').toBe(vp.height);
  await expectAccessible(page, 'dialog sheet');
  await shot(page, 'mobile-sheet');
});

test('phone: «Личные» — the DM list on its tab, the DM full screen (ADR-0020, ADR-0073)', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('phone-tab-dms').tap();
  const nav = page.getByTestId('phone-dms');
  // The previews come with READY.
  const list = nav.getByTestId('dm-list');
  await expect(list).toBeVisible();
  const boris = list.getByRole('button', { name: /Борис Петров/ });
  await expect(boris).toContainText('Закрепил, чтобы не потерялся');
  await expectNoHorizontalScroll(page, 'dm list');
  await expectAccessible(page, 'dm list');
  await shot(page, 'mobile-dm-list');
  await boris.tap();
  await expect(nav).toHaveCount(0);
  const header = page.getByTestId('dm-header');
  await expect(header).toContainText('Борис Петров');
  // «←» in the DM header returns to the DM list; no members in a DM.
  await expect(header.getByTestId('phone-back')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Написать @Борис Петров' })).toBeVisible();
  // Wait for the fixture's message history to render (not just the welcome/composer) before the shot.
  await expect(page.getByText('Анна, привет! Посмотришь PR с миграцией')).toBeVisible();
  await expectNoHorizontalScroll(page, 'dm chat');
  await shot(page, 'mobile-dm-chat');
  await header.getByTestId('phone-back').tap();
  await expect(page.getByTestId('phone-dms').getByTestId('dm-list')).toBeVisible();
});

test('phone: onboarding and the join card fit the screen', async ({ page }) => {
  // Join card (docs/09 #53) signed out.
  await page.goto(`${BASE}/join/calaba-team-2026?visual-test`);
  const card = page.getByTestId('link-landing');
  await expect(card.getByRole('button', { name: 'Открыть в Calab' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'join card');
  await expectAccessible(page, 'join card');
  await shot(page, 'mobile-join-card');

  // First run: onboarding.
  await page.goto(`${BASE}/?visual-test`);
  await page.evaluate(`localStorage.setItem('calaba-prefs', ${JSON.stringify(JSON.stringify({ state: { theme: 'dark', onboarded: false, locale: 'ru' }, version: 1 }))})`);
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Пропустить настройку' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'onboarding');
  await expectAccessible(page, 'onboarding');
  await shot(page, 'mobile-onboarding');
});

test('phone: PWA manifest and service worker', async ({ page, request }) => {
  const res = await request.get(`${BASE}/manifest.webmanifest`);
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as { display: string; theme_color: string; icons: Array<{ sizes: string }> };
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toBeTruthy();
  expect(manifest.icons.map((i) => i.sizes)).toContain('512x512');
  const sw = await request.get(`${BASE}/sw.js`);
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).not.toContain("'fetch'"); // install-only: no fetch handler, no cache
  await page.goto(`${BASE}/?visual-test`);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  await expect
    .poll(() => page.evaluate('navigator.serviceWorker.getRegistration().then((r) => !!r && !!(r.active || r.installing || r.waiting))'), { timeout: 10_000 })
    .toBe(true);
});

type Size = { width: number; height: number };

/** Home-screen web app emulation: display-mode: standalone + iOS navigator.standalone. */
async function emulateStandalone(page: Page): Promise<void> {
  await page.addInitScript(`{
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q.replace(/\\s/g, '') === '(display-mode:standalone)' ? mm('(min-width: 0px)') : mm(q));
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
  }`);
}

/** Where the composer ends and how much is under its content, against the viewport. */
async function bottomOf(page: Page): Promise<{ vh: number; edge: number; gap: number; shell: number; app: string; standalone: boolean }> {
  await expect(page.getByTestId('composer')).toBeVisible();
  return page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer"]');
    const root = document.documentElement;
    return {
      vh: innerHeight,
      edge: el.getBoundingClientRect().bottom,
      gap: innerHeight - (el.firstElementChild?.getBoundingClientRect().bottom ?? 0),
      shell: document.querySelector('[data-testid="mobile-shell"]')?.getBoundingClientRect().height ?? 0,
      app: root.style.getPropertyValue('--app-height'),
      standalone: root.classList.contains('pwa-standalone'),
    };
  })()`);
}

test('phone: a Safari tab — the shell is the viewport, no standalone handling', async ({ page }) => {
  await signIn(page);
  await openGeneral(page);
  const b = await bottomOf(page);
  expect(b.standalone).toBe(false);
  expect(b.app).toBe('');
  expect(Math.abs(b.edge - b.vh)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.shell - b.vh)).toBeLessThanOrEqual(1);
});

test('phone: home-screen app (standalone) — no band under the composer', async ({ page, browser }) => {
  const use = test.info().project.use;
  // The iPhone SE descriptor has no screen size: its screen is 16:9 (375×667).
  const screen = (use as { screen?: Size }).screen ?? (use.viewport ? { width: use.viewport.width, height: Math.round((use.viewport.width * 16) / 9) } : undefined);
  test.skip(!screen, 'the device has no screen size');
  if (!screen) return;
  await emulateStandalone(page);
  // The whole screen is the viewport (no toolbars): the composer ends at the bottom edge.
  await page.setViewportSize(screen);
  await signIn(page);
  await openGeneral(page);
  const b = await bottomOf(page);
  expect(b.standalone).toBe(true);
  expect(b.app).toBe('');
  expect(Math.abs(b.edge - b.vh)).toBeLessThanOrEqual(1);
  // env(safe-area-inset-bottom) is 0 here; on an iPhone it is the home indicator (≤ 34 px).
  expect(b.gap).toBeLessThanOrEqual(34);

  // WebKit reporting a viewport shorter than the screen by the status bar (the iOS standalone
  // bug): the shell is stretched to the screen height, the composer to the real bottom edge.
  const ctx = await browser.newContext({
    viewport: { width: screen.width, height: screen.height - 47 },
    screen,
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    locale: 'ru-RU',
  });
  try {
    const short = await ctx.newPage();
    await emulateStandalone(short);
    await signIn(short);
    await openGeneral(short);
    await expect.poll(async () => (await bottomOf(short)).app).toBe(`${screen.height}px`);
    const s = await bottomOf(short);
    expect(Math.abs(s.shell - screen.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.edge - screen.height)).toBeLessThanOrEqual(1);
  } finally {
    await ctx.close();
  }
});
