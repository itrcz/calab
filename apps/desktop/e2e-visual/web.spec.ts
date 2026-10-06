import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, THEMES, VIEWPORTS, checkpoint, type Shot } from './harness';
import { seedDay } from './calendarWeb';

/**
 * Web client chrome (docs/09 #46, ADR-0015): the production web build (dist-web, `pnpm build:web`)
 * served same-origin by the mock API, in Playwright's Chromium with `?visual-test`. Covers the
 * compact 30 px top bar: no reserved traffic-light inset, ← → at the left edge, the workspace
 * centred, «Упоминания» and «?» on the right; the search pill at every width (docs/09 #53: the only
 * workspace search entry point). Screenshot of the whole window + of the bar, layout + axe.
 */

const DIST = join(import.meta.dirname, '..', 'dist-web');

/**
 * Locally (owner, 26.09) only the join card in dark 960 with one snapshot; the top bar, the other
 * themes/widths, the «not found» shot and the room-preview flow run with CALABA_VISUAL_ALL=1 (nightly).
 */
const ALL = process.env['CALABA_VISUAL_ALL'] === '1';

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`web top bar: ${theme} ${viewport.width}`, async ({ page }) => {
      test.skip(!ALL, 'full matrix only (CALABA_VISUAL_ALL=1, nightly CI)');
      expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
      let mock: MockServer | undefined;
      try {
        mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
        await page.setViewportSize(viewport);
        await page.clock.setFixedTime(NOW);
        await page.goto(`${mock.url}/?visual-test`);
        await page.evaluate((t) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: true, locale: 'ru' }, version: 1 })), theme);
        await page.reload();
        await page.getByLabel('Email').fill('owner@calaba.test');
        await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
        await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

        const bar = page.getByTestId('titlebar');
        await expect(bar).toHaveAttribute('data-variant', 'web');
        const box = await bar.boundingBox();
        expect(box?.height, 'web top bar height').toBe(30);
        expect(box?.y).toBe(0);
        // No traffic-light inset: the workspace menu sits at the left edge (docs/09 #140; no «‹ ›»).
        const title = bar.getByTestId('titlebar-title');
        await expect(title).toContainText('Команда Calab');
        await expect(bar.getByRole('button', { name: 'Назад' })).toHaveCount(0);
        const box2 = await title.boundingBox();
        expect(box2?.x ?? 99, 'workspace menu at the left edge').toBeLessThanOrEqual(8);
        await expect(bar.getByRole('button', { name: /^Упоминания/ })).toBeVisible();
        await expect(bar.getByRole('button', { name: 'Горячие клавиши' })).toBeVisible();
        // The search pill: at every width (docs/09 #53, no field in the room header).
        await expect(bar.getByRole('button', { name: 'Поиск' })).toBeVisible();

        const s: Shot = { page, theme, viewport };
        // The feed opens at the first unread; that anchor lands a few px apart between runs:
        // pin the shot to the bottom of the feed (as the Electron main-chat shot does).
        await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
        await checkpoint(s, 'web-main');
        await expect.soft(bar, 'screenshot: web-titlebar').toHaveScreenshot(`web-titlebar-${theme}-${viewport.width}.png`);
      } finally {
        await mock?.close();
      }
    });
  }
}

/**
 * Web link page (docs/09 #53): /join/<code> and /r/<code> show a card — «Открыть в Calab»,
 * «Продолжить в браузере», «Скачать приложение» — before any web flow. `?visual-test` keeps the
 * `calab://` launch inside the page (no OS hand-off), so the «Приложение не найдено» state comes
 * from the probe's own timeout: the page never loses focus here.
 */
async function openLink(page: import('@playwright/test').Page, base: string, path: string, theme: string, extra: Record<string, string> = {}): Promise<void> {
  await page.goto(`${base}/?visual-test`);
  await page.evaluate(
    ({ t, e }) => {
      localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: true, locale: 'ru' }, version: 1 }));
      for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
    },
    { t: theme, e: extra },
  );
  await page.goto(`${base}${path}?visual-test`);
  await expect(page.getByTestId('link-landing')).toBeVisible();
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`web join card: ${theme} ${viewport.width}`, async ({ page }) => {
      test.skip(!ALL && (theme !== 'dark' || viewport.width !== 960), 'full matrix only (CALABA_VISUAL_ALL=1, nightly CI)');
      expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
      let mock: MockServer | undefined;
      try {
        mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
        await page.setViewportSize(viewport);
        await page.clock.setFixedTime(NOW);
        await openLink(page, mock.url, '/join/calaba-team-2026', theme);
        const card = page.getByTestId('link-landing');
        // Signed out: GET /api/invites/{code} is public (ADR-0023) — the workspace and its members.
        await expect(card.getByText('Вас пригласили в пространство')).toBeVisible();
        await expect(card.getByRole('heading', { name: 'Команда Calab' })).toBeVisible();
        await expect(card.getByText('4 участника')).toBeVisible();
        const open = card.getByRole('button', { name: 'Открыть в Calab' });
        const browser = card.getByRole('button', { name: 'Продолжить в браузере' });
        const download = card.getByRole('link', { name: 'Скачать приложение' });
        await expect(download).toHaveAttribute('href', '/download/');
        // Focus order: open → browser → download → «always in the app».
        await open.focus();
        await page.keyboard.press('Tab');
        await expect(browser).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(download).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(card.getByRole('checkbox', { name: 'Всегда открывать в приложении' })).toBeFocused();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

        const s: Shot = { page, theme, viewport };
        await checkpoint(s, 'web-join-card');

        // «Открыть в Calab» without an app: after the timeout — «Приложение не найдено» (role=status),
        // «Продолжить в браузере» becomes the primary action and takes the focus.
        await open.click();
        const status = card.getByRole('status');
        await expect(status).toContainText('Приложение не найдено', { timeout: 5000 });
        await expect(card.getByRole('button', { name: 'Продолжить в браузере' })).toBeFocused();
        await expect(card.getByRole('link', { name: 'Скачать приложение' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Открыть в Calab ещё раз' })).toBeVisible();
        // «Всегда открывать в приложении» contradicts «не найдено»: hidden in this state.
        await expect(card.getByRole('checkbox')).toHaveCount(0);
        if (ALL) await checkpoint(s, 'web-join-card-not-found');

        // «Продолжить в браузере» → the regular web flow: registration with the invitation card on
        // top; the code travels unseen (docs/09 #36).
        await card.getByRole('button', { name: 'Продолжить в браузере' }).click();
        await expect(page.getByTestId('link-landing')).toHaveCount(0);
        await expect(page.getByTestId('auth-invite-card')).toContainText('Приглашение в «Команда Calab»');
        await expect(page.getByLabel('Код приглашения')).toHaveCount(0);
        expect(new URL(page.url()).pathname).toBe('/');
        await checkpoint(s, 'web-join-signup');
      } finally {
        await mock?.close();
      }
    });
  }
}

/**
 * The public meeting page of an invited address (ADR-0038 «Диплинки для приглашённых»): no account,
 * the card with the time in the viewer's zone, the organizer's, the room, the description, the
 * answers and «Присоединиться к встрече» — not active yet (15 minutes before the start). Dark 960.
 */
test('calendar-public: dark 960', async ({ page }) => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  let mock: MockServer | undefined;
  try {
    mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    mock.setClock(NOW.getTime());
    const id = seedDay(mock);
    mock.eventGuestLink(id, 'ext@example.com');
    const viewport = { width: 960, height: 600 };
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(NOW);
    await page.goto(`${mock.url}/?visual-test`);
    await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
    await page.goto(`${mock.url}/e/${id}?t=${encodeURIComponent(mock.eventViewToken(id, 'ext@example.com'))}&visual-test`);
    const card = page.getByTestId('event-public');
    await expect(card.getByTestId('event-title')).toHaveText('Планёрка');
    await expect(card.getByTestId('event-join-hint')).toHaveText('Ссылка станет активной за 15 минут до начала');
    await checkpoint({ page, theme: 'dark', viewport }, 'calendar-public');
  } finally {
    await mock?.close();
  }
});

test('web link card: room preview, «always in the app», signed in', async ({ page }) => {
  test.skip(!ALL, 'full matrix only (CALABA_VISUAL_ALL=1, nightly CI)');
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  let mock: MockServer | undefined;
  try {
    mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.clock.setFixedTime(NOW);

    // /r/<code>: the public preview names the room and the workspace.
    await openLink(page, mock.url, '/r/call-guest-link', 'dark');
    const card = page.getByTestId('link-landing');
    await expect(card.getByRole('heading', { name: /Созвон/ })).toBeVisible();
    await expect(card.getByText('в «Команда Calab»')).toBeVisible();

    // «Всегда открывать в приложении»: remembered; on arrival the app is tried right away, with
    // a visible way back to the browser.
    await card.getByRole('checkbox', { name: 'Всегда открывать в приложении' }).check();
    await page.reload();
    await expect(card.getByRole('status')).toContainText('Открываем Calab');
    await expect(card.getByRole('status').getByRole('button', { name: 'Открыть в браузере' })).toBeVisible();
    await expect(card.getByRole('status')).toContainText('Приложение не найдено', { timeout: 5000 });
    await expect(card.getByRole('checkbox', { name: 'Всегда открывать в приложении' })).toBeChecked();
    await card.getByRole('checkbox', { name: 'Всегда открывать в приложении' }).uncheck();

    // Signed in: the card is still shown (no jump), now with the workspace name.
    await card.getByRole('button', { name: 'Продолжить в браузере' }).click();
    await page.getByRole('button', { name: 'Войти', exact: true }).click(); // guest screen → login
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Войти в комнату «Созвон» пространства «Команда Calab»?' })).toBeVisible();
    await page.goto(`${mock.url}/join/calaba-team-2026?visual-test`);
    await expect(page.getByTestId('link-landing').getByRole('heading', { name: 'Команда Calab' })).toBeVisible();
  } finally {
    await mock?.close();
  }
});

/**
 * Room header at the members-column breakpoint (owner's bug 27.09): from 1200 px the members list
 * is a 240 px column next to the chat; with the widest room column (320 px) the header's right-hand
 * button group used to overflow the chat and paint over the members column. The header and every
 * control in it stay inside the chat section. Layout only (no screenshot): runs locally too.
 */
test('web room header stays inside the chat at 1200–1320 with a 320 px room column', async ({ page }) => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  let mock: MockServer | undefined;
  try {
    mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.clock.setFixedTime(NOW);
    await page.goto(`${mock.url}/?visual-test`);
    await page.evaluate(() => {
      localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 }));
      localStorage.setItem('calaba-ui', JSON.stringify({ state: { sidebarWidth: 320 }, version: 1 }));
    });
    await page.reload();
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    // A short text room, the longest name (it truncates), voice rooms.
    for (const [room, width] of ['общий', 'очень-длинное-название-комнаты-для-проверки-обрезки', 'Созвон', 'Переговорка'].flatMap((r) => [1200, 1220, 1260, 1320, 1440].map((w) => [r, w] as const))) {
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.locator('aside').getByRole('button', { name: room }).first().click();
      await expect(page.locator('section[data-toast-anchor] h1')).toHaveText(room);
      await page.setViewportSize({ width, height: 800 });
      await page.waitForFunction((w) => innerWidth === w, width);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // docs/09 #53: one ⌘K entry point — the title bar's pill, never a field in the header.
      await expect(page.getByTestId('titlebar').getByRole('button', { name: 'Поиск' }), `${room} ${width}: title bar search`).toBeVisible();
      const m = await page.evaluate(() => {
        const section = document.querySelector('section[data-toast-anchor]');
        const header = section?.querySelector(':scope > header');
        if (!section || !header) return null;
        const s = section.getBoundingClientRect();
        const h = header.getBoundingClientRect();
        const items = [...header.querySelectorAll('button, input, h1')].map((el) => {
          const r = el.getBoundingClientRect();
          return { what: el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20), left: r.left, right: r.right };
        });
        return { section: { left: s.left, right: s.right }, header: { left: h.left, right: h.right, scrollW: header.scrollWidth, clientW: header.clientWidth }, items, search: !!header.querySelector('input[type="search"]') };
      });
      expect(m, 'chat section with a header').not.toBeNull();
      if (!m) continue;
      expect.soft(m.header.right, `${width}: header inside the chat`).toBeLessThanOrEqual(m.section.right + 0.5);
      for (const it of m.items) expect.soft(it.right, `${width}: «${it.what}» inside the chat`).toBeLessThanOrEqual(m.section.right + 0.5);
      expect.soft(m.header.scrollW, `${width}: header content fits`).toBeLessThanOrEqual(m.header.clientW);
      expect.soft(m.search, `${width}: no search field in the room header`).toBe(false);
    }
  } finally {
    await mock?.close();
  }
});

/**
 * Guest admission (ADR-0040, docs/08 «Подтверждение входа гостей»): «Созвон» asks for the
 * organizer's approval → a guest by its link sees the note before the name step, knocks, waits on
 * the waiting screen (snapshot `guest-waiting`, dark 960) and gets into the room once admitted.
 */
async function knockAsGuest(page: import('@playwright/test').Page, mock: MockServer, name: string): Promise<string> {
  mock.setGuestApproval(IDS.rooms.call, true);
  await openLink(page, mock.url, '/r/call-guest-link', 'dark');
  await expect(page.getByTestId('link-landing').getByTestId('approval-note')).toBeVisible();
  await page.getByTestId('link-landing').getByRole('button', { name: 'Продолжить в браузере' }).click();
  await expect(page.getByText('Комната требует подтверждения организатора')).toBeVisible();
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти как гость' }).click();
  const waiting = page.getByTestId('guest-waiting');
  await expect(waiting.getByText('Ожидаем подтверждения организатора…')).toBeVisible();
  await expect(waiting.getByRole('heading', { name: 'Созвон' })).toBeVisible();
  await expect(waiting.getByText('в «Команда Calab»')).toBeVisible();
  const knock = [...mock.state.admissions.values()].find((a) => a.roomId === IDS.rooms.call);
  expect(knock, 'the knock reached the mock').toBeDefined();
  return knock?.userId ?? '';
}

test('guest-waiting: approval → waiting screen → admitted → the room', async ({ page }) => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  let mock: MockServer | undefined;
  try {
    mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.clock.setFixedTime(NOW);
    const guest = await knockAsGuest(page, mock, 'Гость Ромашка');
    await expect(page.getByTestId('guest-waiting').getByRole('button', { name: 'Отменить' })).toBeVisible();
    await checkpoint({ page, theme: 'dark', viewport: { width: 960, height: 600 } }, 'guest-waiting');

    mock.decideAdmission(IDS.rooms.call, guest, 'admitted');
    await expect(page.getByTestId('guest-waiting')).toHaveCount(0);
    await expect(page.locator('section[data-toast-anchor] h1')).toHaveText('Созвон');
  } finally {
    await mock?.close();
  }
});

test('guest admission: cancel → join card → knock again; declined shows the retry time', async ({ page }) => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  let mock: MockServer | undefined;
  try {
    mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.clock.setFixedTime(NOW);
    const guest = await knockAsGuest(page, mock, 'Гость Василёк');
    const waiting = page.getByTestId('guest-waiting');

    // «Отменить» → the join card of the room; «Постучать» knocks again with the same link.
    await waiting.getByRole('button', { name: 'Отменить' }).click();
    await expect(waiting.getByText('Запрос отменён')).toBeVisible();
    await expect.poll(() => mock?.state.admissions.size).toBe(0);
    await waiting.getByRole('button', { name: 'Постучать', exact: true }).click();
    await expect(waiting.getByText('Ожидаем подтверждения организатора…')).toBeVisible();
    await expect.poll(() => [...(mock?.state.admissions.values() ?? [])].some((a) => a.userId === guest)).toBe(true);

    // Declined by the organizer: no «Постучать снова» for 10 minutes, the time is shown.
    mock.decideAdmission(IDS.rooms.call, guest, 'declined');
    await expect(waiting.getByText('Организатор отклонил вход')).toBeVisible();
    await expect(waiting.getByText(/^Постучать снова можно в \d{1,2}:\d{2}/)).toBeVisible();
    await expect(waiting.getByRole('button', { name: 'Постучать снова' })).toHaveCount(0);
    await waiting.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.getByTestId('guest-waiting')).toHaveCount(0);
  } finally {
    await mock?.close();
  }
});
