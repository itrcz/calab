import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { startPublisher, type Publisher } from '../e2e-visual/publisher';
import { render, slideHtml } from './art';
import { APP_LOCALE, COPY, type Copy, type PersonKey, type Short } from './copy';
import { cameraPhoto, dataUrl } from './photos';
import { SCENE, drawArt, seedBoard, seedMeetings, seedNotes, seedScene } from './seed';

/**
 * Landing v3 and README screenshots (docs/09 #139): the production web build (dist-web) served
 * same-origin by the mock API, in Chromium at 1440×900 CSS px, device scale 2, dark theme. Each
 * scene runs once per language with that language's team (e2e-marketing/copy.ts: names, rooms,
 * chat, meetings, board, notes); it is set up with the Russian UI (the selectors) and the UI is
 * switched live (`__calabaLocale`) right before the shot.
 *
 *   pnpm -F @calaba/desktop build:web
 *   cd apps/desktop && CALABA_VISUAL_MOCK_PORT=5224 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
 *     pnpm exec playwright test --config playwright.marketing.config.ts landing
 *
 * `-g "landing chat"` one scene, CALABA_LANDING_LOCALES=ru,en some languages. The voice and call
 * scenes need the dev LiveKit (pnpm infra:dev). Raw captures: apps/landing/shots/<scene>-<locale>@2x.png
 * (git-ignored); `pnpm -F @calaba/landing assets` turns them into public/screens/<locale>/*.webp.
 */
const OUT = resolve(import.meta.dirname, '../../landing/shots');
const DIST = resolve(import.meta.dirname, '../dist-web');
const SIZE = { width: 1440, height: 900 };
/** chat: the window (CSS px) of the closer chat frame — a narrow feed (crop in apps/landing/scripts/assets.mjs). */
const CHAT_WINDOW = { width: 930, height: 800 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const ALL: Short[] = ['ru', 'en', 'es', 'zh'];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
const LOCALES = ALL.filter((s) => !wanted || wanted.includes(s));
/** «Неделя» of the timeline in each language (the app's boards dictionaries, boards.tl.week). */
const WEEK: Record<Short, string> = { ru: 'Неделя', en: 'Week', es: 'Semana', zh: '周' };
/** A private LiveKit (MOCK_LIVEKIT_URL / _KEY / _SECRET), when the default dev one on :7880 is not the one to use. */
const lkOpts = (): { livekitUrl?: string; livekitKey?: string; livekitSecret?: string } => ({
  ...(process.env['MOCK_LIVEKIT_URL'] ? { livekitUrl: process.env['MOCK_LIVEKIT_URL'] } : {}),
  ...(process.env['MOCK_LIVEKIT_KEY'] ? { livekitKey: process.env['MOCK_LIVEKIT_KEY'] } : {}),
  ...(process.env['MOCK_LIVEKIT_SECRET'] ? { livekitSecret: process.env['MOCK_LIVEKIT_SECRET'] } : {}),
});
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'landing_';

interface Ctx {
  browser: Browser;
  page: Page;
  mock: MockServer;
  c: Copy;
  short: Short;
  pubs: Publisher[];
}

const aside = (page: Page) => page.locator('aside').first();

async function boot(short: Short, opts: { signIn?: boolean; seed?: ((mock: MockServer, c: Copy) => void) | undefined } = {}): Promise<Ctx> {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
  });
  const c = COPY[short];
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST, ...lkOpts() });
  mock.setClock(NOW.getTime());
  seedScene(mock, c, await drawArt(browser, c));
  opts.seed?.(mock, c);
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const ctx: Ctx = { browser, page, mock, c, short, pubs: [] };
  if (opts.signIn === false) return ctx;
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  await page.goto(`${mock.url}/?visual-test`);
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(aside(page)).toBeVisible({ timeout: 30_000 });
  return ctx;
}

async function shutdown(ctx: Ctx | undefined): Promise<void> {
  if (!ctx) return;
  for (const p of ctx.pubs) await p.stop().catch(() => undefined);
  await ctx.browser.close().catch(() => undefined);
  await ctx.mock.close().catch(() => undefined);
}

async function setLocale(page: Page, short: Short): Promise<void> {
  const l = APP_LOCALE[short];
  await page.evaluate((x) => (window as unknown as { __calabaLocale?: (l: string) => void }).__calabaLocale?.(x), l);
  await expect(page.locator('html')).toHaveAttribute('lang', l);
}

async function shoot(ctx: Ctx, scene: string): Promise<void> {
  await ctx.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(ctx.page);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${scene}-${ctx.short}@2x.png`);
  await ctx.page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  console.log(scene, ctx.short, `${(statSync(path).size / 1e6).toFixed(1)} MB`);
}

async function feedBottom(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page
      .locator('[data-virtuoso-scroller]')
      .first()
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      .catch(() => undefined);
    await settle(page);
  }
}

async function openRoom(ctx: Ctx, name: string): Promise<void> {
  await aside(ctx.page).getByRole('button', { name: new RegExp(`^# ?${name}|${name}`) }).first().click();
  await expect(ctx.page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  await expect(ctx.page.locator('[data-message-id]').first()).toBeVisible();
  await feedBottom(ctx.page);
}

/** Someone in voice (the mock's state; publishers make the media real where it shows). */
function inRoom(mock: MockServer, k: PersonKey, extra: { camera?: boolean; streaming?: boolean; muted?: boolean } = {}): void {
  mock.setVoiceState({ userId: IDS.users[k], roomId: IDS.rooms.meeting, joinedAtMs: NOW.getTime() - 14 * 60_000, ...extra });
}

/** 3.0: the rail's «Календарь» tile → the mini month → today's day view. */
async function openDay(page: Page): Promise<void> {
  const mini = page.getByTestId('mini-calendar');
  if (!(await mini.isVisible())) await page.getByTestId('section-calendar').click();
  await mini.locator('[data-cal-day="2026-01-15"]').click();
  await expect(page.getByTestId('day-view')).toBeVisible();
}

async function speaking(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.(list), ids);
}

/** Chromium's fake camera replaced by Анна's camera photo (the page's own camera requests). */
async function fakeCamera(page: Page, frame: Buffer): Promise<void> {
  await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = 1280;
    cv.height = 720;
    const g = cv.getContext('2d');
    if (!g) return;
    const draw = (): void => g.drawImage(img, 0, 0, cv.width, cv.height);
    draw();
    setInterval(draw, 100);
    const stream = cv.captureStream(10);
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => (constraints?.video ? new MediaStream(stream.getVideoTracks().map((t) => t.clone())) : orig(constraints));
  }, dataUrl(frame));
}

async function frames(page: Page, n: number): Promise<void> {
  await expect
    .poll(() => page.locator('video').evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth > 0).length), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(n);
  await settle(page);
}

/** In «Переговорка», muted (the fake mic beeps), a room status, steady «good» signal. */
async function joinMeeting(ctx: Ctx): Promise<void> {
  const { page, c } = ctx;
  // 2.0: the room row opens the chat, «Войти» is the way into the call.
  await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
  await aside(page).getByRole('button', { name: `Войти в голос «${c.rooms.meeting}»` }).click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  const row = aside(page).getByTestId('voice-status-row');
  await row.click();
  await aside(page).getByTestId('voice-status-input').fill(c.voiceStatus);
  await aside(page).getByTestId('voice-status-input').press('Enter');
  await expect(row).toContainText(c.voiceStatus);
  await page.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 14 * 60_000));
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
}

const scenes: Record<string, (ctx: Ctx) => Promise<void>> = {
  // «общий»: a morning thread — a design mockup with reactions and a reply, a PDF, a voice note, a sticker, a mention.
  async chat(ctx) {
    await openRoom(ctx, ctx.c.rooms.general);
    await setLocale(ctx.page, ctx.short);
    // Memoized feed rows keep the old language after a live switch: re-open the room.
    await aside(ctx.page).getByRole('button', { name: new RegExp(ctx.c.rooms.dev) }).first().click();
    await openRoom(ctx, ctx.c.rooms.general);
    // A shorter window: the bottom-anchored feed brings the mockup, the reactions, the reply and the
    // sticker right under the room header (assets.mjs crops the feed only, no members column).
    await ctx.page.setViewportSize(CHAT_WINDOW);
    await feedBottom(ctx.page);
    await shoot(ctx, 'chat');
  },

  // «Переговорка»: Вера shares the release slide, Борис and Григорий on camera, my own camera, Дина listening.
  async voice(ctx) {
    const { page, mock, c } = ctx;
    await openRoom(ctx, c.rooms.general);
    await fakeCamera(page, cameraPhoto('anna'));
    await joinMeeting(ctx);
    inRoom(mock, 'dina', { muted: true });
    await page.getByTestId('camera-button').click();
    await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('camera-preview-enable').click();
    await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    for (const k of ['boris', 'grigory'] as const) {
      ctx.pubs.push(await startPublisher({ userId: IDS.users[k], name: c.people[k].name, roomId: IDS.rooms.meeting, source: 'camera', image: cameraPhoto(k) }));
      inRoom(mock, k, { camera: true, muted: k === 'grigory' });
    }
    ctx.pubs.push(await startPublisher({ userId: IDS.users.vera, name: c.people.vera.name, roomId: IDS.rooms.meeting, image: await render(ctx.browser, slideHtml(c), 1280, 720) }));
    inRoom(mock, 'vera', { streaming: true });
    const stage = page.getByTestId('stream-stage').or(page.getByTestId('stream-pip'));
    const chip = page.getByRole('button', { name: c.people.vera.name, exact: true });
    await expect(stage.or(chip).first()).toBeVisible({ timeout: 30_000 });
    if ((await stage.count()) === 0) await chip.first().click();
    const expand = page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' });
    if (await expand.count()) await expand.first().click();
    await expect(page.getByTestId('stream-stage')).toBeVisible();
    await frames(page, 4);
    await speaking(page, [IDS.users.boris]);
    await setLocale(page, ctx.short);
    await page.waitForTimeout(1500);
    await shoot(ctx, 'voice');
  },

  // Today's day view with the planning meeting's card open.
  async calendar(ctx) {
    const { page, c } = ctx;
    await openDay(page);
    await setLocale(page, ctx.short);
    await page.getByTestId('event-block').filter({ hasText: c.calendar.planning }).first().click();
    await expect(page.getByTestId('event-panel').getByTestId('event-title')).toHaveText(c.calendar.planning);
    await setLocale(page, ctx.short);
    await shoot(ctx, 'calendar');
  },

  // «Подобрать время» with Борис and Вера: busy columns, green windows, «Ближайшие окна».
  async findtime(ctx) {
    const { page, c } = ctx;
    await openDay(page);
    await setLocale(page, ctx.short);
    await page.getByTestId('day-find').click();
    const pane = page.getByTestId('find-time');
    await pane.getByTestId('find-people-add').click();
    const picker = page.getByTestId('find-people-picker');
    await picker.getByRole('option', { name: new RegExp(c.people.boris.name) }).click();
    await picker.getByRole('option', { name: new RegExp(c.people.vera.name) }).click();
    await picker.getByRole('option', { name: new RegExp(c.people.dina.name) }).click();
    await page.keyboard.press('Escape');
    await expect(pane.getByTestId('busy-column')).toHaveCount(4);
    await setLocale(page, ctx.short);
    const toggle = pane.getByTestId('find-slots-toggle');
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.getByTestId('find-slot').first()).toBeVisible();
    await page.getByTestId('find-next').click();
    await expect(pane.getByTestId('find-selection')).toBeVisible();
    // The slots popover covers the columns: close it, the outlined window stays.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('find-slot')).toHaveCount(0);
    await shoot(ctx, 'findtime');
  },

  async kanban(ctx) {
    await boards(ctx);
    await setLocale(ctx.page, ctx.short);
    await shoot(ctx, 'kanban');
  },

  async timeline(ctx) {
    await boards(ctx);
    await ctx.page.keyboard.press('3');
    await expect(ctx.page.getByTestId('timeline')).toBeVisible();
    // The week scale: bars wide enough for their titles.
    await ctx.page.getByText(WEEK[ctx.short], { exact: true }).first().click({ timeout: 10_000 });
    await ctx.page.waitForTimeout(300);
    await shoot(ctx, 'timeline');
  },

  async task(ctx) {
    const key = await boards(ctx);
    await ctx.page.getByTestId('task-card').filter({ hasText: key }).getByTestId('card-title').click();
    const panel = ctx.page.getByTestId('task-panel');
    await expect(panel.locator('[data-message-id]')).toHaveCount(ctx.c.board.open.comments.length);
    await setLocale(ctx.page, ctx.short);
    await ctx.page.waitForTimeout(500);
    // Down to the subtasks and the comments (the chat-like feed under the properties).
    await panel.evaluate((root) => {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const e = el as HTMLElement;
        if (e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = e.scrollHeight;
      }
    });
    await shoot(ctx, 'task');
  },

  // «Личные» → «Заметки»: the first shelf open.
  async notes(ctx) {
    const { page, c } = ctx;
    await page.getByRole('button', { name: /^Личные/ }).first().click();
    const shelves = page.getByTestId('notes-shelf');
    await expect(shelves).toHaveCount(c.notes.shelves.length);
    await shelves.filter({ hasText: c.notes.open }).getByRole('button').first().click();
    await expect(page.getByTestId('notes-header-bar')).toContainText(c.notes.open);
    await feedBottom(page);
    await setLocale(page, ctx.short);
    await shelves.filter({ hasText: c.notes.shelves[1]?.[0] ?? '' }).getByRole('button').first().click();
    await shelves.filter({ hasText: c.notes.open }).getByRole('button').first().click();
    await feedBottom(page);
    await shoot(ctx, 'notes');
  },

  // A guest by the meeting room's link, waiting for the organizer (the room asks for approval).
  async guest(ctx) {
    const { page, mock, c } = ctx;
    mock.setGuestApproval(IDS.rooms.meeting, true);
    await page.goto(`${mock.url}/?visual-test`);
    await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
    await page.goto(`${mock.url}/r/${SCENE.meetingLink}?visual-test`);
    await expect(page.getByTestId('link-landing').getByTestId('approval-note')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('link-landing').getByRole('button', { name: 'Продолжить в браузере' }).click();
    await expect(page.getByText('Комната требует подтверждения организатора')).toBeVisible();
    await page.getByLabel('Ваше имя').fill(c.guest);
    await page.getByRole('button', { name: 'Войти как гость' }).click();
    const waiting = page.getByTestId('guest-waiting');
    await expect(waiting.getByText('Ожидаем подтверждения организатора…')).toBeVisible({ timeout: 30_000 });
    await expect(waiting.getByRole('heading', { name: c.rooms.meeting })).toBeVisible();
    await setLocale(page, ctx.short);
    await shoot(ctx, 'guest');
  },

  // A one-to-one call with Борис in «Личные», in progress.
  async call(ctx) {
    const { page, mock, c } = ctx;
    await page.getByRole('button', { name: /^Личные/ }).first().click();
    await page.getByTestId('dm-list').getByRole('button', { name: new RegExp(c.people.boris.name) }).click();
    await expect(page.getByTestId('dm-header')).toContainText(c.people.boris.name);
    mock.ringCall(IDS.users.boris, IDS.users.anna);
    await page.getByTestId('call-accept').click();
    await expect(page.getByTestId('dm-call-active')).toBeVisible();
    await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press(`${MOD}+Shift+m`);
    await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
    await speaking(page, [IDS.users.boris]);
    await feedBottom(page);
    await setLocale(page, ctx.short);
    await feedBottom(page);
    await shoot(ctx, 'call');
    await page.getByTestId('dm-call-hangup').click();
  },
};

/** Boards mode on «Продукт»; returns the opened task's key. */
async function boards(ctx: Ctx): Promise<string> {
  const key = ctx.mock.boards.tasks.size ? [...ctx.mock.boards.tasks.values()][ctx.c.board.open.index]?.task.key ?? '' : '';
  await openRoom(ctx, ctx.c.rooms.general);
  // Board chips format dates once per mount: the language first, then the board.
  await setLocale(ctx.page, ctx.short);
  await ctx.page.getByTestId('section-boards').click();
  await expect(ctx.page.getByTestId('kanban')).toBeVisible();
  await expect(ctx.page.getByTestId('task-card').first()).toBeVisible();
  return key;
}

const SEEDS: Record<string, ((mock: MockServer, c: Copy) => void) | undefined> = {
  chat: (mock) => {
    inRoom(mock, 'boris');
    inRoom(mock, 'vera', { muted: true });
  },
  calendar: (mock, c) => void seedMeetings(mock, c),
  findtime: (mock, c) => void seedMeetings(mock, c),
  kanban: (mock, c) => void seedBoard(mock, c),
  timeline: (mock, c) => void seedBoard(mock, c),
  task: (mock, c) => void seedBoard(mock, c),
  notes: (mock, c) => void seedNotes(mock, c),
};

for (const [name, run] of Object.entries(scenes)) {
  for (const short of LOCALES) {
    test(`landing ${name} ${short}`, async () => {
      test.setTimeout(240_000);
      process.env['MOCK_LIVEKIT_ROOM_PREFIX'] = `${PREFIX}${name}_${short}_${Date.now().toString(36)}_`;
      let ctx: Ctx | undefined;
      try {
        ctx = await boot(short, { signIn: name !== 'guest', seed: SEEDS[name] });
        await run(ctx);
      } finally {
        await shutdown(ctx);
      }
    });
  }
}
