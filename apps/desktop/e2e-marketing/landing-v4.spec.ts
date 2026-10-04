import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { Plan, SipCallStatus, WorkspaceAppSchema, WorkspacePlanSchema } from '@calaba/protocol';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { ENTERPRISE_PLAN_LIMITS } from '../e2e-support/fixtures';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { APP_LOCALE, COPY, type Copy, type Short } from './copy';
import { cameraPhoto, dataUrl } from './photos';
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

  // A web app of the workspace open inside Calab while the call goes on.
  async webapps(ctx) {
    const { page, mock, short } = ctx;
    const site = await testSite(short);
    ctx.extra.push(site);
    const apps: Array<[string, string]> = [
      ['Grafana', `${site.url}/grafana`],
      [APPS[short].wiki, `${site.url}/wiki`],
      ['CRM', `${site.url}/crm`],
    ];
    await inCall(ctx);
    apps.forEach(([name, url], i) => {
      mock.dispatch({
        event: {
          case: 'workspaceAppUpsert',
          value: {
            app: create(WorkspaceAppSchema, {
              id: `00000000-0000-7000-8000-00000000a0${i + 1}`,
              workspaceId: IDS.workspaces.main,
              name,
              url,
              position: i + 1,
              createdBy: U.anna,
              createdAt: timestampFromMs(NOW.getTime() - (i + 3) * 86_400_000),
              updatedAt: timestampFromMs(NOW.getTime() - (i + 3) * 86_400_000),
            }),
          },
        },
      });
    });
    const tiles = page.getByTestId('rail-app');
    await expect(tiles).toHaveCount(3, { timeout: 10_000 });
    await tiles.first().click();
    await expect(page.getByTestId('app-screen')).toBeVisible();
    const frame = page.frameLocator('[data-testid="app-screen"] iframe');
    await expect(frame.locator('h1')).toBeVisible({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    await speaking(page, [U.boris]);
    await page.waitForTimeout(800);
    await shoot(ctx, 'webapps');
  },
};

const APPS: Record<Short, { wiki: string; title: string; sub: string; panels: string[] }> = {
  ru: { wiki: 'Вики', title: 'Обзор сервисов', sub: 'за последние 6 часов', panels: ['Запросы в секунду', 'Задержка p95, мс', 'Ошибки 5xx', 'Очередь заданий'] },
  en: { wiki: 'Wiki', title: 'Services overview', sub: 'last 6 hours', panels: ['Requests per second', 'Latency p95, ms', '5xx errors', 'Job queue'] },
  es: { wiki: 'Wiki', title: 'Resumen de servicios', sub: 'últimas 6 horas', panels: ['Solicitudes por segundo', 'Latencia p95, ms', 'Errores 5xx', 'Cola de trabajos'] },
  zh: { wiki: '维基', title: '服务概览', sub: '最近 6 小时', panels: ['每秒请求数', 'p95 延迟（毫秒）', '5xx 错误', '任务队列'] },
};

/** A local Grafana-like dashboard page (the «site» of the web app), served on a private address. */
async function testSite(short: Short): Promise<{ url: string; close(): Promise<void> }> {
  const t = APPS[short];
  const wave = (seed: number, amp: number, base: number): string => {
    const pts: string[] = [];
    for (let x = 0; x <= 300; x += 6) {
      const y = base - amp * (0.5 + 0.35 * Math.sin(x / 23 + seed) + 0.15 * Math.sin(x / 7 + seed * 3));
      pts.push(`${x},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  };
  const colors = ['#73bf69', '#5794f2', '#f2495c', '#fade2a'];
  const panel = (name: string, i: number): string => `
    <section><h2>${name}</h2>
      <svg viewBox="0 0 300 120" preserveAspectRatio="none">
        <g stroke="#2c3235">${[20, 50, 80, 110].map((y) => `<line x1="0" x2="300" y1="${y}" y2="${y}"/>`).join('')}</g>
        <polyline fill="none" stroke="${colors[i]}" stroke-width="2" points="${wave(i * 1.7, 70, 105)}"/>
        <polyline fill="none" stroke="#b877d9" stroke-width="1.5" opacity=".7" points="${wave(i * 2.3 + 1, 40, 100)}"/>
      </svg>
      <p><b>${['1 284', '142', '0,02 %', '37'][i]}</b><span>${['req/s', 'ms', '', ''][i]}</span></p></section>`;
  const html = `<!doctype html><meta charset="utf-8"><title>${t.title}</title><style>
    *{box-sizing:border-box}body{margin:0;background:#111217;color:#ccccdc;font:14px/1.4 system-ui,sans-serif}
    header{display:flex;align-items:center;gap:16px;padding:14px 24px;border-bottom:1px solid #2c3235;background:#181b1f}
    header i{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#f9d423,#ff4e50)}
    h1{margin:0;font-size:18px;font-weight:600;color:#fff}header span{color:#8e8e9e}
    main{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;padding:24px}
    section{background:#181b1f;border:1px solid #2c3235;border-radius:4px;padding:14px 16px}
    h2{margin:0 0 8px;font-size:14px;font-weight:500;color:#fff}svg{width:100%;height:150px;display:block}
    p{margin:8px 0 0}b{font-size:28px;color:#fff;font-weight:500;margin-right:6px}span{color:#8e8e9e}
  </style><header><i></i><h1>${t.title}</h1><span>${t.sub}</span></header><main>${t.panels.map(panel).join('')}</main>`;
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
  webapps: (mock) => team(mock),
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
