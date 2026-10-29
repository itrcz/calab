import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ReactionSchema, TaskRelationKind } from '@calaba/protocol';
import { chromium, devices, expect, webkit, type Browser, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { startPublisher, type Publisher } from '../e2e-visual/publisher';
import { APP_WINDOW, captureAppWindow, launchAppWindow, resizeAppWindow, type AppWindow } from './app-window';
import { APP_LOCALE, COPY, type Copy, type PersonKey, type Short } from './copy';
import { COPY4, type Copy4 } from './copy4';
import { cameraPhoto, dataUrl } from './photos';
import { SCENE, drawArt, msk, seedBoard, seedScene } from './seed';

export { expect, settle, startPublisher, cameraPhoto, msk };
export type { MockServer, Page, Publisher };

/**
 * Shared helpers of the landing v6 scenes (landing-v6.spec.ts): the same web build, framing and
 * mock as landing.spec.ts / landing-v5.spec.ts (1440×900 CSS px, device scale 2, dark), plus the
 * «one day of a team» story seeds (copy4.ts) that several frames share.
 */
export const OUT = resolve(import.meta.dirname, '../../landing/shots');
export const DIST = resolve(import.meta.dirname, '../dist-web');
export const SIZE = { width: 1440, height: 900 };
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
export const U = IDS.users;
export const R = IDS.rooms;

const ALL: Short[] = ['ru', 'en', 'es', 'zh'];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
export const LOCALES = ALL.filter((s) => !wanted || wanted.includes(s));
export const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'landing_';

const lkOpts = (): { livekitUrl?: string; livekitKey?: string; livekitSecret?: string } => ({
  ...(process.env['MOCK_LIVEKIT_URL'] ? { livekitUrl: process.env['MOCK_LIVEKIT_URL'] } : {}),
  ...(process.env['MOCK_LIVEKIT_KEY'] ? { livekitKey: process.env['MOCK_LIVEKIT_KEY'] } : {}),
  ...(process.env['MOCK_LIVEKIT_SECRET'] ? { livekitSecret: process.env['MOCK_LIVEKIT_SECRET'] } : {}),
});

/** The title bar's settings button in each language (the app's `settings.title`). */
export const SETTINGS: Record<Short, string> = { ru: 'Настройки', en: 'Settings', es: 'Ajustes', zh: '设置' };

/** Safe-area insets of the phone shots (as landing-v5.spec.ts). */
const INSETS = { top: 12, bottom: 8 };

export interface Ctx {
  browser: Browser;
  page: Page;
  mock: MockServer;
  c: Copy;
  c4: Copy4;
  short: Short;
  pubs: Publisher[];
  phone: boolean;
  /** The real app window (app-window.ts): the scene is the OS capture of the window, chrome included. */
  win?: AppWindow;
}

export type Seed = (mock: MockServer, c: Copy, c4: Copy4) => void | Promise<void>;

export const aside = (page: Page) => page.locator('aside').first();

export async function boot(short: Short, seed: Seed | undefined, opts: { phone?: boolean; size?: { width: number; height: number }; ui?: { sidebarWidth?: number; membersPanel?: boolean }; window?: boolean } = {}): Promise<Ctx> {
  const phone = opts.phone ?? false;
  const window = (opts.window ?? false) && APP_WINDOW && !phone;
  if (window) expect(existsSync(join(DIST, '../out/renderer/index.html')), 'out/ is missing: run `pnpm build:app` first').toBe(true);
  else expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const browser = phone
    ? await webkit.launch()
    : await chromium.launch({
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
      });
  const c = COPY[short];
  const c4 = COPY4[short];
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST, ...lkOpts() });
  mock.setClock(NOW.getTime());
  const artBrowser = phone ? await chromium.launch() : browser;
  seedScene(mock, c, await drawArt(artBrowser, c));
  if (phone) await artBrowser.close();
  await seed?.(mock, c, c4);
  if (window) {
    // The art and the camera frames are still drawn by the Chromium above; the scene runs in the app.
    const win = await launchAppWindow(mock.url, opts.size ?? SIZE, opts.ui);
    return { browser, page: win.page, mock, c, c4, short, pubs: [], phone, win };
  }
  const context = phone
    ? await browser.newContext({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' })
    : await browser.newContext({ viewport: opts.size ?? SIZE, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const ctx: Ctx = { browser, page, mock, c, c4, short, pubs: [], phone };
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  // The window's own layout choices (the column's width, the members' panel), as a user would leave them.
  if (opts.ui) await page.evaluate((ui) => localStorage.setItem('calaba-ui', JSON.stringify({ state: ui, version: 1 })), opts.ui);
  await page.goto(`${mock.url}/?visual-test`);
  if (phone) await insets(page);
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  const signIn = page.getByRole('button', { name: 'Войти', exact: true });
  if (phone) await signIn.tap();
  else await signIn.click();
  if (phone) await expect(page.getByTestId('mobile-shell')).toBeVisible({ timeout: 30_000 });
  else await expect(aside(page)).toBeVisible({ timeout: 30_000 });
  return ctx;
}

/** The window's size mid-scene: the page's viewport, or the app window's content size. */
export async function resize(ctx: Ctx, size: { width: number; height: number }): Promise<void> {
  if (ctx.win) await resizeAppWindow(ctx.win, size);
  else await ctx.page.setViewportSize(size);
}

export async function insets(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `@media (max-width: 768px) { :root.web:not(.kb-open) { --safe-top: ${INSETS.top}px; --safe-bottom: ${INSETS.bottom}px; } }`,
  });
}

export async function shutdown(ctx: Ctx | undefined): Promise<void> {
  if (!ctx) return;
  for (const p of ctx.pubs) await p.stop().catch(() => undefined);
  await ctx.win?.close();
  await ctx.browser.close().catch(() => undefined);
  await ctx.mock.close().catch(() => undefined);
}

export async function setLocale(page: Page, short: Short): Promise<void> {
  const l = APP_LOCALE[short];
  await page.evaluate((x) => (window as unknown as { __calabaLocale?: (l: string) => void }).__calabaLocale?.(x), l);
  await expect(page.locator('html')).toHaveAttribute('lang', l);
}

export async function shoot(ctx: Ctx, scene: string, keepPointer = false): Promise<void> {
  if (!keepPointer) await ctx.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(ctx.page, keepPointer);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${scene}-${ctx.short}@2x.png`);
  if (ctx.win) await captureAppWindow(ctx.win.app, path);
  else await ctx.page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  console.log(scene, ctx.short, `${(statSync(path).size / 1e6).toFixed(1)} MB`);
}

/** The box (CSS px) of an element: the crops of scripts/assets.mjs follow the panels' borders. */
export async function box(page: Page, sel: string): Promise<string> {
  const b = await page.locator(sel).first().boundingBox({ timeout: 1500 }).catch(() => null);
  return b ? [b.x, b.y, b.width, b.height].map(Math.round).join(',') : 'none';
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

export async function speaking(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.(list), ids);
}

/** Someone in «Переговорка» (the mock's voice state). */
export function inRoom(mock: MockServer, k: PersonKey, extra: { camera?: boolean; streaming?: boolean; muted?: boolean } = {}): void {
  mock.setVoiceState({ userId: U[k], roomId: R.meeting, joinedAtMs: NOW.getTime() - 14 * 60_000, ...extra });
}

/** Chromium's fake camera replaced by a camera photo (the page's own camera requests). */
export async function fakeCamera(page: Page, frame: Buffer): Promise<void> {
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

/** In «Переговорка», muted, steady «good» signal (as landing.spec.ts joinMeeting). */
export async function joinMeeting(ctx: Ctx): Promise<void> {
  const { page, c } = ctx;
  await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
  await aside(page).getByRole('button', { name: `Войти в голос «${c.rooms.meeting}»` }).click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await page.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 14 * 60_000));
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
}

export async function openRoom(ctx: Ctx, name: string): Promise<void> {
  await aside(ctx.page).getByRole('button', { name: new RegExp(`^# ?${name}|${name}`) }).first().click();
  await expect(ctx.page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  await expect(ctx.page.locator('[data-message-id]').first()).toBeVisible();
  await feedBottom(ctx.page);
}

// ---------------------------------------------------------------- the story's seeds

type Raw = {
  tasks: Map<string, { task: { id: string; key: string; title: string; boardId: string; roomId: string } }>;
  boards: Map<string, { board: { id: string; key: string } }>;
};

/** The board «Продукт» of the story: 14 tasks (APP-7 = the CSV export, 4 columns of 3–4 cards), a work-plan checklist 2/4, «Согласует: …». Returns the task. */
export function seedStoryBoard(mock: MockServer, c: Copy, c4: Copy4): { id: string; key: string } {
  const cc: Copy = {
    ...c,
    board: {
      ...c.board,
      tasks: c4.board.tasks,
      open: { index: 6, description: c4.task.description, subtasks: [], comments: c4.task.comment },
    },
  };
  seedBoard(mock, cc);
  const b = mock.boards;
  const raw = b as unknown as Raw & {
    categories: Map<string, unknown>;
    createChecklist(taskId: string, me: string, body: { title: string }): { checklist?: { id: string } };
    addChecklistItem(id: string, me: string, body: { text: string }): unknown;
    checklists: Map<string, { id: string; items: { id: string }[] }[]>;
    updateChecklistItem(id: string, me: string, body: { done: boolean }): unknown;
    setApprovers(id: string, me: string, userIds: string[], required: number): unknown;
    setRelation(id: string, me: string, other: string, kind: number, on: boolean): unknown;
  };
  raw.categories.clear();
  const app = [...raw.boards.values()].find((r) => r.board.key === 'APP');
  const tasks = [...raw.tasks.values()].filter((t) => t.task.boardId === app?.board.id);
  const story = tasks.find((t) => t.task.title === c4.task.title);
  if (!story) throw new Error('no story task');
  // seedBoard makes the opened task block the fourth one: no marker in this story.
  const blocked = tasks.find((t) => t.task.title === c4.board.tasks[3]?.title);
  if (blocked) raw.setRelation(story.task.id, U.anna, blocked.task.id, TaskRelationKind.BLOCKS, false);
  const list = raw.createChecklist(story.task.id, U.anna, { title: c4.task.checklistTitle }).checklist?.id ?? '';
  for (const text of c4.task.checklist) raw.addChecklistItem(list, U.anna, { text });
  raw.checklists
    .get(story.task.id)
    ?.find((x) => x.id === list)
    ?.items.slice(0, 2)
    .forEach((it, i) => raw.updateChecklistItem(it.id, i ? U.boris : U.anna, { done: true }));
  raw.setApprovers(story.task.id, U.anna, [U.anna], 1);
  for (const t of raw.tasks.values()) (t as unknown as { unread: Set<string> }).unread.clear();
  return { id: story.task.id, key: story.task.key };
}

/** «общий» of the story day: the pinned note, Вера's request, a reply with a quote, a voice note, a sticker, the regression, the task card, the review. */
export function seedStoryChat(mock: MockServer, _c: Copy, c4: Copy4, key: string, compact = false): void {
  const s = mock.state;
  s.messages.set(R.general, []);
  const post = (k: PersonKey, hhmm: string, content: string, extra: { replyToId?: string; attachments?: string[]; stickerId?: string } = {}) => {
    const m = mock.injectMessage({ roomId: R.general, authorId: U[k], content, ...extra });
    m.createdAt = timestampFromMs(msk(hhmm));
    return m;
  };
  const react = (m: ReturnType<typeof post>, list: Record<string, PersonKey[]>): void => {
    const map = new Map(Object.entries(list).map(([e, who]) => [e, new Set(who.map((k) => U[k]))]));
    s.reactions.set(m.id, map);
    m.reactions = Object.entries(list).map(([emoji, who]) => create(ReactionSchema, { emoji, count: who.length, me: who.includes('anna') }));
  };
  const request = post('vera', '10:05', c4.chat.request);
  // The client's ask is the pinned message (the banner under the room's header).
  request.pinnedAt = timestampFromMs(msk('10:06'));
  request.pinnedBy = U.boris;
  const reply = post('anna', '10:07', c4.chat.reqReply, { replyToId: request.id });
  if (compact) react(reply, { '🔥': ['boris', 'vera'] });
  if (!compact) {
    post('boris', '10:09', '', { attachments: [SCENE.files.voice] });
    const pack = s.stickerPacks.get(IDS.stickerPacks.calab);
    post('grigory', '10:11', '', { stickerId: pack?.stickers[0]?.id ?? '' });
  }
  post('anna', '10:18', `${c4.chat.taskLead} [${key}](https://calab.test/t/${key})`);
  if (compact) {
    post('boris', '10:21', c4.chat.meetingNote);
  }
  const last = (rid: string): string => s.messages.get(rid)?.at(-1)?.id ?? '';
  for (const k of ['anna', 'boris', 'vera', 'grigory', 'dina'] as const) s.readStates.get(U[k])?.set(R.general, last(R.general));
}
