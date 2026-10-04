import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create, toJson } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  GetWorkspaceIdentityResponseSchema,
  IdentityAccessReason,
  IdentityConnectionStatus,
  IdentityConnectionSchema,
  IdentityDirectorySchema,
  IdentityPolicyMode,
  IdentityProvider,
  ListIdentityDirectoryMembersResponseSchema,
  OAuthConsentSnapshotSchema,
  WorkspaceIdentityAccessSchema,
} from '@calaba/protocol';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { APP_LOCALE, COPY, type Copy, type PersonKey, type Short } from './copy';
import { COPY2, type Copy2 } from './copy2';
import { drawArt, seedBoard, seedScene } from './seed';
import { seedBoardsV2, seedStickerChat, seedWebhook } from './seed2';

/**
 * Calab 2.0 scenes (boards 2.0, workspace identity, built-in stickers, the voice list's «Войти»):
 * the same web build, window and framing as landing.spec.ts (1440×900 CSS px, device scale 2, dark),
 * every scene once per language with that language's team (copy.ts, copy2.ts).
 *
 *   pnpm -F @calaba/desktop build:web
 *   cd apps/desktop && CALABA_VISUAL_MOCK_PORT=5224 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
 *     pnpm exec playwright test --config playwright.marketing.config.ts landing-v2
 *
 * `-g "v2 sso"` one scene, CALABA_LANDING_LOCALES=ru,en some languages. Raw captures go to
 * apps/landing/shots/<scene>-<locale>@2x.png (git-ignored); `pnpm -F @calaba/landing assets` crops them.
 * The mock has no identity endpoints: this spec answers them itself (protojson through page.route).
 */
const OUT = resolve(import.meta.dirname, '../../landing/shots');
const DIST = resolve(import.meta.dirname, '../dist-web');
const SIZE = { width: 1440, height: 900 };
/** boards2: the window width (CSS px) for three kanban columns (crop in apps/landing/scripts/assets.mjs). */
const BOARDS2_WIDTH = 1220;

const ALL: Short[] = ['ru', 'en', 'es', 'zh'];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
const LOCALES = ALL.filter((s) => !wanted || wanted.includes(s));
/** A private LiveKit (MOCK_LIVEKIT_URL / _KEY / _SECRET), when the default dev one on :7880 is not the one to use. */
const lkOpts = (): { livekitUrl?: string; livekitKey?: string; livekitSecret?: string } => ({
  ...(process.env['MOCK_LIVEKIT_URL'] ? { livekitUrl: process.env['MOCK_LIVEKIT_URL'] } : {}),
  ...(process.env['MOCK_LIVEKIT_KEY'] ? { livekitKey: process.env['MOCK_LIVEKIT_KEY'] } : {}),
  ...(process.env['MOCK_LIVEKIT_SECRET'] ? { livekitSecret: process.env['MOCK_LIVEKIT_SECRET'] } : {}),
});
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'landing_';

interface Ctx {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  mock: MockServer;
  c: Copy;
  c2: Copy2;
  short: Short;
}

const aside = (page: Page) => page.locator('aside').first();

async function boot(short: Short, seed?: (mock: MockServer, c: Copy, c2: Copy2) => void, routes?: (ctx: Ctx) => Promise<void>): Promise<Ctx> {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
  });
  const c = COPY[short];
  const c2 = COPY2[short];
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST, ...lkOpts() });
  mock.setClock(NOW.getTime());
  seedScene(mock, c, await drawArt(browser, c));
  seed?.(mock, c, c2);
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const ctx: Ctx = { browser, context, page, mock, c, c2, short };
  await routes?.(ctx);
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

/** Boards mode of the workspace (the language first: board chips format dates once per mount). */
async function boards(ctx: Ctx): Promise<void> {
  await openRoom(ctx, ctx.c.rooms.general);
  await setLocale(ctx.page, ctx.short);
  await ctx.page.getByTestId('boards-button').click();
  await ctx.page.getByTestId('board-row').filter({ hasText: ctx.c.board.name }).first().click();
  await expect(ctx.page.getByTestId('kanban')).toBeVisible();
  await expect(ctx.page.getByTestId('task-card').first()).toBeVisible();
}

async function boardSettings(ctx: Ctx, tab: number): Promise<void> {
  await boards(ctx);
  await ctx.page.getByTestId('board-more').click();
  await ctx.page.getByTestId('board-settings').click();
  await ctx.page.getByRole('tab').nth(tab).click();
}

const SEED_BOARDS = (mock: MockServer, c: Copy, c2: Copy2): void => {
  seedBoard(mock, c);
  seedBoardsV2(mock, c, c2);
};

// ---- identity answers (the mock has none): protojson, same shapes as the server's
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function identityRoutes(ctx: Ctx): Promise<void> {
  const { context, c2 } = ctx;
  const ws = IDS.workspaces.main;
  const tenant = '5d0c1f3a-7b2e-4c19-9a61-2f4e8d3b6a10';
  const access = create(WorkspaceIdentityAccessSchema, {
    workspaceId: ws,
    mode: IdentityPolicyMode.OPTIONAL,
    reason: IdentityAccessReason.ALLOWED,
    policyVersion: 3n,
    membershipVersion: 1n,
  });
  const connection = create(IdentityConnectionSchema, {
    id: '00000000-0000-7000-8009-000000000001',
    workspaceId: ws,
    name: c2.sso.name,
    provider: IdentityProvider.ENTRA,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    tenantId: tenant,
    clientId: c2.sso.clientId,
    secretConfigured: true,
    version: 4n,
    status: IdentityConnectionStatus.ACTIVE,
    testedAt: timestampFromMs(Date.parse('2026-01-13T08:20:00Z')),
  });
  await context.route('**/api/workspaces/*/identity', (r) => r.fulfill(json(toJson(GetWorkspaceIdentityResponseSchema, create(GetWorkspaceIdentityResponseSchema, { access, connection })))));
  await context.route('**/api/workspaces/*/identity/directory', (r) => r.fulfill(json(toJson(IdentityDirectorySchema, create(IdentityDirectorySchema, { workspaceId: ws, version: 1n })))));
  await context.route('**/api/workspaces/*/identity/directory/members**', (r) =>
    r.fulfill(json(toJson(ListIdentityDirectoryMembersResponseSchema, create(ListIdentityDirectoryMembersResponseSchema, {})))),
  );
}

async function consentRoutes(ctx: Ctx): Promise<void> {
  const { context, c, c2 } = ctx;
  const snapshot = create(OAuthConsentSnapshotSchema, {
    requestId: 'req-1',
    workspaceId: IDS.workspaces.main,
    workspaceName: c.company,
    clientName: c2.consent.app,
    redirectUri: c2.consent.redirect,
    displayName: c.people.anna.name,
    scopes: ['openid', 'profile', 'email'],
    refreshRequested: true,
    csrfToken: 'csrf-0123456789abcdef0123456789abcdef',
    expiresAt: timestampFromMs(NOW.getTime() + 9 * 60_000),
  });
  await context.route('**/api/oauth/requests/*/bind', (r) => r.fulfill(json(toJson(OAuthConsentSnapshotSchema, snapshot))));
}

async function ssoScene(ctx: Ctx, heading: string, scene: string): Promise<void> {
  const { page } = ctx;
  await openRoom(ctx, ctx.c.rooms.general);
  await page.getByTestId('titlebar-title').click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  await page.getByRole('tab', { name: 'Настройка SSO' }).click();
  await expect(page.getByTestId('identity-settings')).toBeVisible();
  await expect(page.getByTestId('identity-settings').getByRole('textbox').first()).toHaveValue(ctx.c2.sso.name);
  await page.getByRole('heading', { name: heading }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await setLocale(page, ctx.short);
  await page.waitForTimeout(400);
  await shoot(ctx, scene);
}

function inRoom(mock: MockServer, k: PersonKey, extra: { camera?: boolean; streaming?: boolean; muted?: boolean } = {}): void {
  mock.setVoiceState({ userId: IDS.users[k], roomId: IDS.rooms.meeting, joinedAtMs: NOW.getTime() - 14 * 60_000, ...extra });
}

const scenes: Record<string, { run: (ctx: Ctx) => Promise<void>; seed?: (mock: MockServer, c: Copy, c2: Copy2) => void; routes?: (ctx: Ctx) => Promise<void> }> = {
  // Boards list with two categories, cards with checklist progress «3/7».
  boards2: {
    seed: SEED_BOARDS,
    async run(ctx) {
      await boards(ctx);
      await expect(ctx.page.getByTestId('board-category')).toHaveCount(2);
      await expect(ctx.page.getByTestId('task-card').filter({ hasText: '3/7' })).toHaveCount(1);
      // A closer frame (assets.mjs crops the board only): the window just wide enough for three
      // columns and the whole header toolbar.
      await ctx.page.setViewportSize({ width: BOARDS2_WIDTH, height: SIZE.height });
      await ctx.page.waitForTimeout(300);
      await shoot(ctx, 'boards2');
    },
  },

  // The task panel with two named checklists.
  checklists: {
    seed: SEED_BOARDS,
    async run(ctx) {
      await boards(ctx);
      await ctx.page.getByTestId('task-card').filter({ hasText: '3/7' }).getByTestId('card-title').click();
      const panel = ctx.page.getByTestId('task-panel');
      await expect(panel.getByTestId('checklist-title').filter({ hasText: ctx.c2.checklists[1].title })).toBeVisible();
      await setLocale(ctx.page, ctx.short);
      await panel.getByTestId('checklist-title').filter({ hasText: ctx.c2.checklists[0].title }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await ctx.page.waitForTimeout(400);
      await shoot(ctx, 'checklists');
    },
  },

  // Board settings → «Фичи».
  boardfeatures: {
    seed: SEED_BOARDS,
    async run(ctx) {
      await boardSettings(ctx, 1);
      await expect(ctx.page.getByTestId('board-features')).toBeVisible();
      await shoot(ctx, 'boardfeatures');
    },
  },

  // Board settings → «Вебхук» (Business plan).
  boardhook: {
    seed: (mock, c, c2) => {
      SEED_BOARDS(mock, c, c2);
      seedWebhook(mock, c, c2);
    },
    async run(ctx) {
      await boardSettings(ctx, 6);
      await expect(ctx.page.getByTestId('webhook-url')).toHaveValue(ctx.c2.webhookUrl);
      await expect(ctx.page.getByTestId('webhook-status')).toBeVisible();
      await shoot(ctx, 'boardhook');
    },
  },

  // Workspace settings → «Настройка SSO»: Entra connection configured; the policy card below it (mode «По выбору»).
  sso: { routes: identityRoutes, run: (ctx) => ssoScene(ctx, 'SSO-подключение', 'sso') },
  ssopolicy: { routes: identityRoutes, run: (ctx) => ssoScene(ctx, 'Политика входа', 'ssopolicy') },

  // «Войти через Calab»: the consent screen of an OAuth client (web route /oauth/consent).
  consent: {
    routes: consentRoutes,
    async run(ctx) {
      const { page, mock } = ctx;
      await page.goto(`${mock.url}/oauth/consent?request=${'a'.repeat(40)}&visual-test`);
      await expect(page.getByTestId('oauth-consent')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('oauth-consent').getByText(ctx.c2.consent.app)).toBeVisible();
      await setLocale(page, ctx.short);
      await shoot(ctx, 'consent');
    },
  },

  // A chat where the team answers with built-in «Calab Stikers».
  stickerchat: {
    seed: (mock, c) => seedStickerChat(mock, c),
    async run(ctx) {
      await openRoom(ctx, ctx.c.rooms.general);
      await setLocale(ctx.page, ctx.short);
      await aside(ctx.page).getByRole('button', { name: new RegExp(ctx.c.rooms.dev) }).first().click();
      await openRoom(ctx, ctx.c.rooms.general);
      await expect(ctx.page.getByTestId('sticker-message')).toHaveCount(4);
      await shoot(ctx, 'stickerchat');
    },
  },

  // The sticker picker open on the built-in pack.
  stickerpicker: {
    seed: (mock, c) => seedStickerChat(mock, c),
    async run(ctx) {
      await openRoom(ctx, ctx.c.rooms.general);
      await setLocale(ctx.page, ctx.short);
      await ctx.page.getByTestId('sticker-button').click();
      await expect(ctx.page.getByTestId('sticker-panel')).toBeVisible();
      await expect(ctx.page.getByTestId('sticker-grid').locator('img').first()).toBeVisible();
      await expect
        .poll(() => ctx.page.getByTestId('sticker-grid').locator('img').evaluateAll((l) => l.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).length))
        .toBeGreaterThan(8);
      await shoot(ctx, 'stickerpicker');
    },
  },

  // The room list: people in «Переговорка» and the «Войти» button (hover on the row).
  voicelist: {
    seed: (mock) => {
      inRoom(mock, 'boris');
      inRoom(mock, 'vera', { muted: true });
      inRoom(mock, 'grigory', { camera: true });
    },
    async run(ctx) {
      await openRoom(ctx, ctx.c.rooms.general);
      await setLocale(ctx.page, ctx.short);
      const join = aside(ctx.page).getByTestId('room-join').first();
      await expect(join).toBeVisible();
      const box = await join.boundingBox();
      if (box) await ctx.page.mouse.move(box.x - 90, box.y + box.height / 2);
      await ctx.page.waitForTimeout(300);
      await shoot(ctx, 'voicelist');
    },
  },
};

for (const [name, scene] of Object.entries(scenes)) {
  for (const short of LOCALES) {
    test(`landing v2 ${name} ${short}`, async () => {
      test.setTimeout(240_000);
      process.env['MOCK_LIVEKIT_ROOM_PREFIX'] = `${PREFIX}v2${name}_${short}_${Date.now().toString(36)}_`;
      let ctx: Ctx | undefined;
      try {
        ctx = await boot(short, scene.seed, scene.routes);
        await scene.run(ctx);
      } finally {
        await shutdown(ctx);
      }
    });
  }
}
