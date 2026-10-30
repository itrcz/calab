import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, devices, expect, webkit, type Browser, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../../e2e-visual/harness';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { APP_LOCALE, COPY, type Copy, type Short } from '../copy';
import { drawArt, msk, seedBoard, seedMeetings, seedScene } from '../seed';

/**
 * Capture harness of the store screenshots (apps/desktop/README.md «Store screenshots»): the web client in
 * WebKit on an iPhone 14 viewport (390×844 pt) at 3x → 1170×2532 raw PNGs, signed in against the mock
 * server (scenario `data` re-skinned by the landing's copy, e2e-marketing/seed.ts), real UI, dark.
 */
export const DIST = resolve(import.meta.dirname, '../../dist-web');
export const VIEWPORT = { width: 390, height: 844 };
export const SCALE = 3;

/**
 * Safe-area insets of the shot: the compose step draws a status bar (9:41, battery) over the top band and
 * rounds the corners, so the app keeps its content clear of both.
 */
export const INSETS = { top: 50, bottom: 22 };

export interface Ctx {
  page: Page;
  mock: MockServer;
  c: Copy;
  short: Short;
}

const U = IDS.users;
const R = IDS.rooms;

/** Someone in «Переговорка» (the mock's voice state). */
export function inRoom(mock: MockServer, k: 'anna' | 'boris' | 'vera' | 'grigory' | 'dina', extra: { camera?: boolean; streaming?: boolean; muted?: boolean } = {}): void {
  mock.setVoiceState({ userId: U[k], roomId: R.meeting, joinedAtMs: NOW.getTime() - 14 * 60_000, ...extra });
}

/** Data shared by every scene (set before sign-in, so READY carries it). */
function seedAll(mock: MockServer, c: Copy, short: 'ru' | 'en'): void {
  seedMeetings(mock, c);
  seedBoard(mock, c);
  mock.boards.categories.clear();
  inRoom(mock, 'boris');
  inRoom(mock, 'vera', { muted: true });
  inRoom(mock, 'grigory', { muted: true });
  // Rooms with a last message each (a believable list), the call room's chat behind the voice card.
  const say = (room: string, who: 'anna' | 'boris' | 'vera' | 'grigory' | 'dina', text: string, hhmm: string): void => {
    const m = mock.injectMessage({ roomId: room, authorId: U[who], content: text });
    m.createdAt = timestampFromMs(msk(hhmm));
  };
  const t = TALK[short];
  say(R.call, 'grigory', t.standup[0], '09:58');
  say(R.call, 'boris', t.standup[1], '10:02');
  say(R.meeting, 'vera', t.meeting[0], '13:12');
  say(R.meeting, 'boris', t.meeting[1], '13:14');
  say(R.meeting, 'vera', t.meeting[2], '13:21');
  say(R.meeting, 'anna', t.meeting[3], '13:24');
}

/** Short chat lines of the call room and the stand-up in each language. */
const TALK: Record<'ru' | 'en', { standup: [string, string]; meeting: [string, string, string, string] }> = {
  ru: {
    standup: ['Вчера закрыл доски, сегодня — экспорт', 'У меня всё по плану, блокеров нет'],
    meeting: ['Подключаюсь через минуту ☕', 'Мы уже в комнате, заходи', 'Показываю новый экран задач', 'Супер, отлично видно 👍'],
  },
  en: {
    standup: ['Closed the boards yesterday, export today', 'All on track, no blockers on my side'],
    meeting: ['Joining in a minute ☕', 'We are in the room already, come in', 'Sharing the new tasks screen', 'Great, I can see it clearly 👍'],
  },
};

export async function withStore<T>(short: Short, body: (ctx: Ctx) => Promise<T>): Promise<T> {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const browser: Browser = await webkit.launch();
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
  try {
    const c = COPY[short];
    mock.setClock(NOW.getTime());
    // The art (mockup, avatars) is drawn by Chromium.
    const art = await chromium.launch();
    seedScene(mock, c, await drawArt(art, c));
    await art.close();
    seedAll(mock, c, short as 'ru' | 'en');
    const context = await browser.newContext({ ...devices['iPhone 14'], viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.clock.setFixedTime(NOW);
    await page.goto(`${mock.url}/?visual-test`);
    await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
    await page.goto(`${mock.url}/?visual-test`);
    await insets(page);
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).tap();
    await expect(page.getByTestId('mobile-shell')).toBeVisible({ timeout: 30_000 });
    const ctx: Ctx = { page, mock, c, short };
    return await body(ctx);
  } finally {
    await browser.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
  }
}

async function insets(page: Page): Promise<void> {
  await page.addStyleTag({ content: `@media (max-width: 768px) { :root.web:not(.kb-open) { --safe-top: ${INSETS.top}px; --safe-bottom: ${INSETS.bottom}px; } }` });
}

/** The app in the scene's language from a fresh render (list previews and memoized rows keep the old one); lands on the room list. */
export async function fresh(ctx: Ctx): Promise<void> {
  const { page, short } = ctx;
  const l = APP_LOCALE[short];
  await page.evaluate((x) => (window as unknown as { __calabaLocale?: (l: string) => void }).__calabaLocale?.(x), l);
  await expect(page.locator('html')).toHaveAttribute('lang', l);
  await page.reload();
  await insets(page);
  await expect(page.getByTestId('mobile-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', l);
  // The app reopens on the last tab: back to «Команда».
  const rows = page.getByTestId('phone-room-list').getByTestId('phone-room-row');
  const back = page.getByTestId('phone-back');
  for (let i = 0; i < 6 && !(await page.getByTestId('phone-tabbar').isVisible()); i++) {
    if ((await back.count()) === 0) break;
    await back.first().tap();
  }
  if (!(await rows.first().isVisible())) await page.getByTestId('phone-tab-chats').tap();
  await expect(rows.first()).toBeVisible();
}

/** «Команда» → a room of the list. */
export async function phoneRoom(page: Page, name: string): Promise<void> {
  await page.getByTestId('phone-room-list').getByRole('button', { name: new RegExp(`^${name}`) }).first().tap();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
}

export async function feedBottom(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page
      .locator('[data-virtuoso-scroller]')
      .first()
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      .catch(() => undefined);
    await settle(page);
  }
}

/** A tab of the bottom bar. */
export async function tab(page: Page, name: 'chats' | 'dms' | 'boards' | 'calendar'): Promise<void> {
  await page.getByTestId(`phone-tab-${name}`).tap();
}

/** The raw PNG of the page: 390×844 pt at 3x, no focus, no caret. */
export async function shoot(page: Page, path: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
}
