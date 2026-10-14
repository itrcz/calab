import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { InlineKeyboardSchema, Plan, SipCallStatus, WorkspaceAppSchema, WorkspacePlanSchema } from '@calaba/protocol';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { ENTERPRISE_PLAN_LIMITS, fileMeta } from '../e2e-support/fixtures';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { APP_LOCALE, COPY, type Copy, type Short } from './copy';
import { appIconHtml, pageHtml, render, salesHtml, type SalesCopy } from './art';
import { avatarPhoto, cameraPhoto, dataUrl } from './photos';
import { drawArt, seedScene } from './seed';

/**
 * Landing v4 scenes (SIP calls, workspace web apps): the same web build, window and framing as
 * landing.spec.ts (1440×900 CSS px, device scale 2, dark), the data of the deployed mock plus a
 * few scene-only additions made here (the SIP account, calls, the journal and the apps of the rail
 * are set through the mock's control methods — no app source is touched).
 *
 *   pnpm -F @calaba/desktop build:web
 *   cd apps/desktop && CALABA_VISUAL_MOCK_PORT=5224 pnpm exec playwright test --config playwright.marketing.config.ts landing-v4
 *
 * `-g "v4 sipdial"` one scene, CALABA_LANDING_LOCALES=ru,en some languages. Raw captures go to
 * apps/landing/shots/<scene>-<locale>@2x.png (git-ignored); `pnpm -F @calaba/landing assets` crops them.
 */
const OUT = resolve(import.meta.dirname, '../../landing/shots');
const DIST = resolve(import.meta.dirname, '../dist-web');
const SIZE = { width: 1440, height: 900 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const U = IDS.users;

const ALL: Short[] = ['ru', 'en', 'es', 'zh'];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
const LOCALES = ALL.filter((s) => !wanted || wanted.includes(s));

/** Fictional numbers (reserved/test ranges) of each team, shown in the dialer, the room and the journal. */
const NUMBERS: Record<Short, string[]> = {
  ru: ['+74951234567', '+79161234567', '+78123456789', '+74951230099'],
  en: ['+14155550134', '+12125550187', '+442079460958', '+14155550142'],
  es: ['+34910000123', '+34600000456', '+525555550123', '+34910000199'],
  zh: ['+861055550134', '+8613800000123', '+862155550187', '+861055550199'],
};
const NUMBER_TYPED: Record<Short, string> = { ru: '+7 495 123-45-67', en: '+1 415 555-0134', es: '+34 910 000-123', zh: '+86 10 5555-0134' };
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
  extra: Array<{ close(): Promise<void> | void }>;
}

const aside = (page: Page) => page.locator('aside').first();

async function boot(short: Short, seed?: (mock: MockServer, c: Copy) => void, size = SIZE): Promise<Ctx> {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
  });
  const c = COPY[short];
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST, ...lkOpts() });
  mock.setClock(NOW.getTime());
  seedScene(mock, c, await drawArt(browser, c));
  seed?.(mock, c);
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const ctx: Ctx = { browser, page, mock, c, short, extra: [] };
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
  for (const e of ctx.extra) await Promise.resolve(e.close()).catch(() => undefined);
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
  await settle(ctx.page, true);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${scene}-${ctx.short}@2x.png`);
  await ctx.page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  console.log(scene, ctx.short, `${(statSync(path).size / 1e6).toFixed(1)} MB`);
}

async function speaking(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.(list), ids);
}

/** Chromium's fake camera replaced by Анна's camera photo. */
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

function team(mock: MockServer): void {
  for (const k of ['boris', 'vera', 'grigory'] as const) {
    mock.setVoiceState({ userId: U[k], roomId: IDS.rooms.meeting, joinedAtMs: NOW.getTime() - 14 * 60_000, muted: k === 'grigory' });
  }
}

/** The telephony of the workspace as an admin left it: the account saved and on (set before sign-in). */
function telephony(mock: MockServer): void {
  // Telephony is a Business+ feature: the workspace on Enterprise, or the dial button stays hidden.
  const w = mock.state.workspaces.get(IDS.workspaces.main);
  if (w) w.plan = create(WorkspacePlanSchema, { plan: Plan.ENTERPRISE, limits: ENTERPRISE_PLAN_LIMITS, validUntil: timestampFromMs(Date.parse('2026-12-31T23:59:59Z')), expired: false });
  mock.setSip(IDS.workspaces.main, { enabled: true, host: 'sip.zadarma.com', callerId: '+74951230099', allowedPrefixes: ['+7', '+1', '+34', '+44', '+86', '+52'], hasPassword: true });
}

async function inCall(ctx: Ctx): Promise<void> {
  await fakeCamera(ctx.page, cameraPhoto('anna'));
  await joinMeeting(ctx);
  await setLocale(ctx.page, ctx.short);
}

/** The settings tab's scroller (the outermost scrollable box inside the dialog) to its top or bottom. */
async function scrollTab(page: Page, to: 'start' | 'end'): Promise<void> {
  await page.getByRole('dialog').evaluate((dlg, where) => {
    for (const el of dlg.querySelectorAll<HTMLElement>('*')) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20 && el.clientWidth > 500) el.scrollTop = where === 'end' ? el.scrollHeight : 0;
    }
  }, to);
}

const scenes: Record<string, (ctx: Ctx) => Promise<void>> = {
  // The dialer popover over the voice room: the number typed, «Позвонить».
  async sipdial(ctx) {
    const { page, short } = ctx;
    await inCall(ctx);
    await speaking(page, [U.boris]);
    await page.getByTestId('sip-dial').click();
    await page.getByTestId('sip-number').fill(NUMBER_TYPED[short]);
    await shoot(ctx, 'sipdial');
  },

  // The phone line in the room as a participant: a phone icon, the number, «В разговоре 02:14».
  async siproom(ctx) {
    const { page, mock, short } = ctx;
    await inCall(ctx);
    mock.placeSipCall(IDS.rooms.meeting, U.anna, NUMBERS[short][0] ?? '', SipCallStatus.ACTIVE, 134_000);
    await expect(page.getByTestId('sip-call-row')).toBeVisible({ timeout: 10_000 });
    // The mock stamps the answer with the wall clock; the page's clock is frozen on NOW: align it for «02:14».
    await page.clock.setFixedTime(Date.now() + 500);
    await speaking(page, [U.boris]);
    await page.waitForTimeout(800);
    await shoot(ctx, 'siproom');
  },

  // Workspace settings → «Телефония»: the provider card (top of the tab) and, below, the test and the journal.
  async sipsettings(ctx) {
    const { page, mock, short } = ctx;
    const room = IDS.rooms.meeting;
    const n = NUMBERS[short];
    const call = (num: string, by: string, status: SipCallStatus, reason: string, answeredAgoMs: number) => {
      const id = mock.placeSipCall(room, by, num, SipCallStatus.ACTIVE, answeredAgoMs);
      mock.setSipCallStatus(id, status, reason);
    };
    call(n[1] ?? '', U.boris, SipCallStatus.FAILED, 'no_answer', 0);
    call(n[2] ?? '', U.vera, SipCallStatus.ENDED, 'remote', 6 * 60_000);
    await setLocale(page, short);
    await page.getByTestId('titlebar-title').or(aside(page).getByRole('button').first()).first().click();
    await page.getByRole('menuitem', { name: /^(Настройки|Settings|Ajustes|设置)$/ }).first().click();
    await page.getByRole('dialog').getByRole('tab').filter({ hasText: /Телефония|Telephony|Telefonía|电话/ }).first().click();
    await expect(page.getByTestId('sip-form')).toBeVisible();
    await page.getByTestId('sip-test').click();
    await expect(page.getByTestId('sip-test-result')).toBeVisible({ timeout: 30_000 });
    await scrollTab(page, 'end');
    await settle(page, true);
    await shoot(ctx, 'siplog');
    await scrollTab(page, 'start');
    await settle(page, true);
    await shoot(ctx, 'sipsettings');
  },

  // «Свои инструменты и боты внутри мессенджера» (landing 14.10): the team's sales dashboard open
  // from its rail icon (the name in the tip), then the reporting bot's daily summary with inline
  // buttons (ADR-0047) in «общий». Two captures: webapps-<l>@2x.png (the window) and
  // webapps-bot-<l>@2x.png (the bot's message); scripts/assets.mjs lays the second over the first.
  async webapps(ctx) {
    const { page, mock, short, c } = ctx;
    const t = APPS[short];
    const people = (['boris', 'vera', 'grigory', 'anna'] as const).map((k) => ({ name: c.people[k].name, avatar: dataUrl(avatarPhoto(k)) }));
    const site = await testSite(pageHtml(t.sales.title, salesHtml(t.sales, people)));
    ctx.extra.push(site);
    const apps: Array<[string, string, 'sales' | 'wiki' | 'support']> = [
      [t.sales.title, `${site.url}/sales`, 'sales'],
      [t.wiki, `${site.url}/wiki`, 'wiki'],
      [t.support, `${site.url}/support`, 'support'],
    ];
    for (const [i, [name, url, kind]] of apps.entries()) {
      const icon = await render(ctx.browser, appIconHtml(kind), 128, 128, { transparent: true });
      const fileId = `00000000-0000-7000-8000-00000000a1${i + 1}`;
      mock.state.files.set(fileId, {
        meta: fileMeta(fileId, IDS.workspaces.main, U.anna, `${kind}.png`, 'image/png', icon, timestampFromMs(NOW.getTime() - 5 * 86_400_000), { width: 128, height: 128 }),
        bytes: icon,
        thumbnail: { bytes: icon, mime: 'image/png' },
      });
      mock.dispatch({
        event: {
          case: 'workspaceAppUpsert',
          value: {
            app: create(WorkspaceAppSchema, {
              id: `00000000-0000-7000-8000-00000000a0${i + 1}`,
              workspaceId: IDS.workspaces.main,
              name,
              url,
              iconFileId: fileId,
              iconUrl: `/api/files/${fileId}`,
              position: i + 1,
              createdBy: U.anna,
              createdAt: timestampFromMs(NOW.getTime() - (i + 3) * 86_400_000),
              updatedAt: timestampFromMs(NOW.getTime() - (i + 3) * 86_400_000),
            }),
          },
        },
      });
    }
    await setLocale(page, short);
    const tiles = page.getByTestId('rail-app');
    await expect(tiles).toHaveCount(3, { timeout: 10_000 });
    await tiles.first().click();
    await expect(page.getByTestId('app-screen')).toBeVisible();
    const frame = page.frameLocator('[data-testid="app-screen"] iframe');
    await expect(frame.locator('table')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tiles.first().locator('img').evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0), { timeout: 10_000 }).toBe(true);
    // The rail tip with the app's name.
    // (A lazy Tip: a keyboard focus wakes it and opens it at once; shoot() would blur it, so the capture is taken here.)
    await page.mouse.move(700, 450);
    await page.keyboard.press('Shift+Tab');
    await tiles.first().focus();
    await expect(page.locator('[data-app-tooltip]').filter({ hasText: t.sales.title })).toBeVisible({ timeout: 5_000 });
    await settle(page, true);
    await page.waitForTimeout(400);
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, `webapps-${short}@2x.png`), animations: 'disabled', caret: 'hide' });

    // The bot's summary in «общий»: a narrow window, the message alone.
    const face = await render(ctx.browser, appIconHtml('bot'), 128, 128, { transparent: true });
    mock.state.files.set(BOT_AVATAR, {
      meta: fileMeta(BOT_AVATAR, '', IDS.bots.deploy, 'avatar.png', 'image/png', face, timestampFromMs(NOW.getTime() - 9 * 86_400_000), { width: 128, height: 128 }),
      bytes: face,
      thumbnail: { bytes: face, mime: 'image/png' },
    });
    await page.mouse.move(700, 450);
    await page.setViewportSize({ width: 930, height: 800 });
    await page.getByTestId('section-chats').click();
    await aside(page).getByRole('button', { name: new RegExp(c.rooms.general) }).first().click();
    const msg = page.locator(`[data-message-id="${BOT_MESSAGE.id}"]`);
    await expect(msg.getByRole('button', { name: t.bot.open })).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.mouse.move(0, 799);
    await settle(page, true);
    // The row spans the feed; the clip ends at the bubble's right edge (its widest descendant short of the row).
    const clip = await msg.evaluate((row) => {
      const r = row.getBoundingClientRect();
      let right = r.left;
      for (const el of row.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.width < r.width * 0.8) right = Math.max(right, b.right);
      }
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(right - r.left + 16), height: Math.round(r.height) };
    });
    mkdirSync(OUT, { recursive: true });
    const path = join(OUT, `webapps-bot-${short}@2x.png`);
    await page.screenshot({ path, clip, animations: 'disabled', caret: 'hide' });
    console.log('webapps-bot', short, clip);
  },
};

/** The scene's bot message (its id is needed to find the row). */
const BOT_MESSAGE = { id: '' };
/** The bot's avatar file (its bytes: appIconHtml('bot'), set by the scene). */
const BOT_AVATAR = '00000000-0000-7000-8000-00000000a1f1';

interface AppsCopy {
  wiki: string;
  support: string;
  sales: SalesCopy;
  bot: { name: string; title: string; lines: string[]; open: string; remind: string };
}

/** The web apps scene in each language: the rail's apps, the dashboard page and the bot's summary. `{boris}` = his name. */
const APPS: Record<Short, AppsCopy> = {
  ru: {
    wiki: 'Вики',
    support: 'Поддержка',
    sales: {
      title: 'Продажи',
      sub: 'Нордлайт · январь 2026',
      range: ['День', 'Неделя', 'Месяц'],
      export: 'Экспорт',
      kpis: [
        ['Выручка', '4,82 млн ₽', '18 %'],
        ['Сделки', '126', '12'],
        ['Конверсия', '24 %', '3 п. п.'],
        ['Средний чек', '38 200 ₽', '5 %'],
      ],
      chart: 'Выручка по неделям',
      plan: 'План',
      fact: 'Факт',
      weeks: ['24 нояб', '1 дек', '8 дек', '15 дек', '22 дек', '29 дек', '5 янв', '12 янв'],
      funnel: 'Воронка',
      stages: [
        ['Заявки', '1 240'],
        ['Квалифицированы', '486'],
        ['Предложение', '212'],
        ['Сделка', '126'],
      ],
      table: 'Крупные сделки',
      cols: ['Клиент', 'Менеджер', 'Этап', 'Сумма'],
      rows: [
        ['Северстрой', 2, '1 240 000 ₽'],
        ['Ладога Транс', 1, '860 000 ₽'],
        ['Кедр Медиа', 0, '540 000 ₽'],
        ['Тайга Софт', 3, '415 000 ₽'],
      ],
      pills: ['Переговоры', 'Предложение', 'Договор', 'Оплачено'],
      goal: ['Цель месяца', '4,82 из 5,9 млн ₽'],
    },
    bot: {
      name: 'Опса',
      title: 'Продажи за вчера',
      lines: ['Выручка: 412 000 ₽, +18 % к плану 📈', 'Новых сделок: 9, закрыто: 4', 'Лучший результат дня 🏆 {boris}'],
      open: 'Открыть отчёт',
      remind: 'Напомнить в 18:00',
    },
  },
  en: {
    wiki: 'Wiki',
    support: 'Support',
    sales: {
      title: 'Sales',
      sub: 'Northwind · January 2026',
      range: ['Day', 'Week', 'Month'],
      export: 'Export',
      kpis: [
        ['Revenue', '$482,000', '18%'],
        ['Deals', '126', '12'],
        ['Conversion', '24%', '3 pp'],
        ['Average deal', '$3,820', '5%'],
      ],
      chart: 'Revenue by week',
      plan: 'Plan',
      fact: 'Actual',
      weeks: ['Nov 24', 'Dec 1', 'Dec 8', 'Dec 15', 'Dec 22', 'Dec 29', 'Jan 5', 'Jan 12'],
      funnel: 'Funnel',
      stages: [
        ['Leads', '1,240'],
        ['Qualified', '486'],
        ['Proposal', '212'],
        ['Won', '126'],
      ],
      table: 'Top deals',
      cols: ['Client', 'Owner', 'Stage', 'Amount'],
      rows: [
        ['Bluepine Builders', 2, '$124,000'],
        ['Harborline Freight', 1, '$86,000'],
        ['Cedar Lane Media', 0, '$54,000'],
        ['Tundra Software', 3, '$41,500'],
      ],
      pills: ['Negotiation', 'Proposal', 'Contract', 'Paid'],
      goal: ['Monthly goal', '$482K of $590K'],
    },
    bot: {
      name: 'Opsy',
      title: 'Yesterday’s sales',
      lines: ['Revenue: $41,200, +18% vs plan 📈', 'New deals: 9, closed: 4', 'Top result of the day 🏆 {boris}'],
      open: 'Open report',
      remind: 'Remind me at 6 pm',
    },
  },
  es: {
    wiki: 'Wiki',
    support: 'Soporte',
    sales: {
      title: 'Ventas',
      sub: 'Brisa Labs · enero de 2026',
      range: ['Día', 'Semana', 'Mes'],
      export: 'Exportar',
      kpis: [
        ['Ingresos', '482.000 €', '18 %'],
        ['Operaciones', '126', '12'],
        ['Conversión', '24 %', '3 p. p.'],
        ['Ticket medio', '3.820 €', '5 %'],
      ],
      chart: 'Ingresos por semana',
      plan: 'Objetivo',
      fact: 'Real',
      weeks: ['24 nov', '1 dic', '8 dic', '15 dic', '22 dic', '29 dic', '5 ene', '12 ene'],
      funnel: 'Embudo',
      stages: [
        ['Contactos', '1240'],
        ['Cualificados', '486'],
        ['Propuesta', '212'],
        ['Ganadas', '126'],
      ],
      table: 'Mayores operaciones',
      cols: ['Cliente', 'Responsable', 'Etapa', 'Importe'],
      rows: [
        ['Construcciones Alba', 2, '124.000 €'],
        ['Transportes Nervión', 1, '86.000 €'],
        ['Cedro Media', 0, '54.000 €'],
        ['Tundra Software', 3, '41.500 €'],
      ],
      pills: ['Negociación', 'Propuesta', 'Contrato', 'Pagado'],
      goal: ['Objetivo del mes', '482.000 de 590.000 €'],
    },
    bot: {
      name: 'Opsy',
      title: 'Ventas de ayer',
      lines: ['Ingresos: 41.200 €, +18 % 📈', 'Operaciones nuevas: 9, cerradas: 4', 'Mejor resultado del día 🏆 {boris}'],
      open: 'Abrir informe',
      remind: 'Recordar a las 18:00',
    },
  },
  zh: {
    wiki: '维基',
    support: '客服',
    sales: {
      title: '销售',
      sub: '星河科技 · 2026 年 1 月',
      range: ['日', '周', '月'],
      export: '导出',
      kpis: [
        ['收入', '¥482 万', '18%'],
        ['成交', '126', '12'],
        ['转化率', '24%', '3 个百分点'],
        ['客单价', '¥38,200', '5%'],
      ],
      chart: '每周收入',
      plan: '目标',
      fact: '实际',
      weeks: ['11/24', '12/1', '12/8', '12/15', '12/22', '12/29', '1/5', '1/12'],
      funnel: '销售漏斗',
      stages: [
        ['线索', '1,240'],
        ['已确认', '486'],
        ['已报价', '212'],
        ['已成交', '126'],
      ],
      table: '重点交易',
      cols: ['客户', '负责人', '阶段', '金额'],
      rows: [
        ['北辰建设', 2, '¥1,240,000'],
        ['长风物流', 1, '¥860,000'],
        ['青松传媒', 0, '¥540,000'],
        ['雪原软件', 3, '¥415,000'],
      ],
      pills: ['洽谈中', '已报价', '签约中', '已付款'],
      goal: ['本月目标', '¥482 万 / ¥590 万'],
    },
    bot: {
      name: 'Opsy',
      title: '昨日销售',
      lines: ['收入：¥412,000，超出目标 18% 📈', '新增交易 9 笔，成交 4 笔', '今日最佳 🏆 {boris}'],
      open: '打开报告',
      remind: '18:00 提醒我',
    },
  },
};

/** The reporting bot (the mock's «Деплой» bot renamed, a picture avatar) posts the daily summary in «общий» before sign-in. */
function salesBot(mock: MockServer, c: Copy): void {
  const short = (Object.keys(COPY) as Short[]).find((k) => COPY[k] === c) ?? 'ru';
  const b = APPS[short].bot;
  mock.seedBots();
  const bot = mock.state.users.get(IDS.bots.deploy);
  if (bot) bot.user.displayName = b.name;
  if (bot) bot.user.avatarFileId = BOT_AVATAR; // the picture itself is added by the scene (drawn by Chromium) before the chat opens
  const text = `**${b.title}**\n${b.lines.map((l) => l.replace('{boris}', c.people.boris.name)).join('\n')}`;
  const m = mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.bots.deploy, content: text });
  m.createdAt = timestampFromMs(NOW.getTime() - 4 * 3600_000);
  m.inlineKeyboard = create(InlineKeyboardSchema, {
    rows: [{ buttons: [
      { id: 'open', label: b.open, data: 'report:open' },
      { id: 'remind', label: b.remind, data: 'report:remind' },
    ] }],
  });
  m.keyboardRevision = 1n;
  BOT_MESSAGE.id = m.id;
  const last = m.id;
  for (const reads of mock.state.readStates.values()) reads.set(IDS.rooms.general, last);
}

/** A local site of the web app (a private address) serving one page for any path. */
async function testSite(html: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const SEEDS: Record<string, ((mock: MockServer, c: Copy) => void) | undefined> = {
  sipdial: (mock) => {
    telephony(mock);
    team(mock);
  },
  siproom: (mock) => {
    telephony(mock);
    team(mock);
  },
  sipsettings: (mock) => telephony(mock),
  webapps: (mock, c) => salesBot(mock, c),
};

for (const [name, run] of Object.entries(scenes)) {
  for (const short of LOCALES) {
    test(`landing v4 ${name} ${short}`, async () => {
      test.setTimeout(240_000);
      process.env['MOCK_LIVEKIT_ROOM_PREFIX'] = `${PREFIX}v4${name}_${short}_${Date.now().toString(36)}_`;
      let ctx: Ctx | undefined;
      try {
        ctx = await boot(short, SEEDS[name], SIZE);
        await run(ctx);
      } finally {
        await shutdown(ctx);
      }
    });
  }
}
