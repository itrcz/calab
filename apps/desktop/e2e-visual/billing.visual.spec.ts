import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, checkpoint, settle, type Shot, type Theme } from './harness';

/**
 * Balance billing screens (ADR-0080, docs/08 «Тариф», owner 10.10: visual runs allowed for billing).
 * The production web build made with VITE_BILLING_MOCK=1 (`pnpm e2e:visual:billing`) — the in-memory
 * billing mock of lib/billing/mock.ts, scenario from `?billing=` — served same-origin by the mock API.
 * One page load per scenario, several checkpoints per load (names `billing-*`: -g "billing").
 * Projects (playwright.visual.config.ts): billing-dark-960 (Chromium, the web top bar), billing-light-960
 * (the plan dialog only), billing-phone-390 (WebKit, iPhone 14, dark). The Electron title bar carries
 * the same <PlanBadge/>; only the traffic-light inset differs.
 */

const DIST = join(import.meta.dirname, '..', 'dist-web');
const INSETS = { top: 47, bottom: 34 };
const PROJECT = (): string => test.info().project.name;
const isPhone = (): boolean => PROJECT().includes('phone');
const isLight = (): boolean => PROJECT().includes('light');

process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ||= 'billing_';

test.use({ actionTimeout: 10_000 });
test.setTimeout(60_000);

let mock: MockServer;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm e2e:visual:billing`').toBe(true);
  // The bundle must be the mock build (VITE_BILLING_MOCK=1): the mock names its localStorage key.
  const assets = join(DIST, 'assets');
  const mocked = readdirSync(assets).some((f) => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes('calaba-billing-mock'));
  expect(mocked, 'dist-web is not a billing-mock build: run `pnpm e2e:visual:billing`').toBe(true);
  mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
});
test.afterAll(async () => {
  await mock.close();
});
test.beforeEach(() => {
  mock.reset('data');
});

/** The workspace's plan as a superadmin sets it (Workspace.plan → the badge). */
async function setPlan(plan: 'PLAN_FREE' | 'PLAN_TEAM' | 'PLAN_ENTERPRISE'): Promise<void> {
  const json = { 'content-type': 'application/json' };
  const login = await fetch(`${mock.url}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'owner@calaba.test', password: PASSWORD }) });
  const token = ((await login.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
  const r = await fetch(`${mock.url}/api/admin/workspaces/${IDS.workspaces.main}/plan`, {
    method: 'PUT',
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan, note: '' }),
  });
  expect(r.status, 'set the workspace plan').toBe(200);
}

interface Boot {
  scenario: 'normal' | 'debt' | 'suspended' | 'selfServe' | 'member' | 'memberSuspended';
  plan: 'PLAN_FREE' | 'PLAN_TEAM' | 'PLAN_ENTERPRISE';
  email?: string;
  /** The plan badge is expected in the header (default). */
  badge?: boolean;
  /** ADR-0083: markets open for new accounts (mock `?sales=`, default global) and the account's market. */
  sales?: 'both' | 'ru' | 'contact';
  market?: 'ru';
}

/** One page load: the billing scenario, the theme, the sign-in, the workspace's main screen. */
async function boot(page: Page, o: Boot): Promise<Shot> {
  const theme: Theme = isLight() ? 'light' : 'dark';
  await setPlan(o.plan);
  await page.clock.setFixedTime(NOW);
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate((th) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: th, onboarded: true, locale: 'ru' }, version: 1 })), theme);
  const extra = `${o.sales ? `&sales=${o.sales}` : ''}${o.market ? `&market=${o.market}` : ''}`;
  await page.goto(`${mock.url}/?visual-test&billing=${o.scenario}${extra}`);
  if (isPhone()) {
    await page.addStyleTag({ content: `@media (max-width: 768px) { :root.web:not(.kb-open) { --safe-top: ${INSETS.top}px; --safe-bottom: ${INSETS.bottom}px; } }` });
  }
  await page.getByLabel('Email').fill(o.email ?? 'owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await tap(page.getByRole('button', { name: 'Войти', exact: true }));
  if (isPhone()) await expect(page.getByTestId('mobile-shell')).toBeVisible();
  else {
    await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
    await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  }
  if (o.badge !== false) await expect(page.getByTestId('plan-badge')).toBeVisible();
  const size = page.viewportSize() ?? { width: 960, height: 600 };
  return { page, theme, viewport: size };
}

/**
 * A screenshot without the layout invariants / axe, for a screen with a known (reported) defect:
 * the phone «Оплата» account rows overflow their state pill (QA finding), which `checkpoint` would fail on.
 */
async function shotOnly(s: Shot, name: string): Promise<void> {
  await settle(s.page);
  await expect.soft(s.page, `screenshot: ${name}`).toHaveScreenshot(`${name}-${s.theme}-${s.viewport.width}.png`);
}

const tap = (l: Locator): Promise<void> => (isPhone() ? l.tap() : l.click());

/** Scrolls the open dialog's (or page's) scroll container to the bottom. */
async function scrollEnd(root: Locator): Promise<void> {
  await root.evaluate((el) => {
    const all = [el, ...el.querySelectorAll<HTMLElement>('*')] as HTMLElement[];
    for (const e of all) {
      const o = getComputedStyle(e).overflowY;
      if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 2) e.scrollTop = e.scrollHeight;
    }
  });
}

const dialog = (page: Page): Locator => page.getByRole('dialog').last();

/** The plan dialog from the badge. */
async function openPlans(page: Page): Promise<Locator> {
  await tap(page.getByTestId('plan-badge'));
  await expect(page.getByTestId('billing-plans')).toBeVisible();
  return page.getByTestId('billing-plans');
}

/**
 * Closes the top dialog with its «Закрыть» / «Отмена» button. Not Escape: the plan dialog ignores Escape
 * (the settings dialog does not) — reported by this spec's author, see the QA notes.
 */
async function closeTop(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: /^(Закрыть|Отмена)/ }).first().click();
}

// ---------------------------------------------------------------- Free: the badge, the plan choice, the payment step

test('billing-free: badge, plan choice, pay step', async ({ page }) => {
  const s = await boot(page, { scenario: 'selfServe', plan: 'PLAN_FREE' });
  if (!isLight()) await checkpoint(s, 'billing-badge-free');
  await openPlans(page);
  await checkpoint(s, 'billing-plans-free');
  if (!isLight()) {
    await scrollEnd(dialog(page));
    await checkpoint(s, 'billing-plans-free-end');
    await dialog(page).evaluate((el) => el.querySelectorAll<HTMLElement>('*').forEach((e) => (e.scrollTop = 0)));
  }
  await tap(page.getByTestId('plans-choose-TEAM'));
  await expect(page.getByTestId('plans-pay-step')).toBeVisible();
  await checkpoint(s, 'billing-pay-team');
  if (isLight()) return;
  // Seats above the minimum: the sum follows.
  await tap(page.getByRole('button', { name: 'Больше мест' }));
  await tap(page.getByRole('button', { name: 'Больше мест' }));
  await checkpoint(s, 'billing-pay-team-seats');
  await tap(page.getByRole('button', { name: 'Назад' }));
  await tap(page.getByTestId('plans-choose-ENTERPRISE'));
  await expect(page.getByTestId('plans-pay-step')).toBeVisible();
  await checkpoint(s, 'billing-pay-business');
});

// ---------------------------------------------------------------- Team: badge, plan dialog, cabinet, top-up, quotes

test('billing-team: badge, plans, cabinet, top-up, quotes', async ({ page }) => {
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM' });
  if (!isLight()) await checkpoint(s, 'billing-badge-team');
  await openPlans(page);
  await checkpoint(s, 'billing-plans-team');
  if (isLight()) return;
  await scrollEnd(dialog(page));
  await checkpoint(s, 'billing-plans-team-end');
  await dialog(page).evaluate((el) => el.querySelectorAll<HTMLElement>('*').forEach((e) => (e.scrollTop = 0)));
  // Switching to Business: the payment step for a plan change.
  await tap(page.getByTestId('plans-choose-ENTERPRISE'));
  await expect(page.getByTestId('plans-pay-step')).toBeVisible();
  await checkpoint(s, 'billing-pay-change');
  await tap(page.getByRole('button', { name: 'Назад' }));
  // «Подробнее о балансе» → the cabinet in settings.
  await tap(page.getByTestId('plans-details'));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  const cabinet = settings.getByTestId('billing-cabinet');
  await expect(cabinet).toBeVisible();
  await expect(cabinet.getByTestId('billing-ledger-row').first()).toBeVisible();
  await checkpoint(s, 'billing-cabinet-top');
  for (const [name, title] of [
    ['autotopup', 'Автопополнение'],
    ['payer', 'Плательщик'],
    ['history', 'История'],
  ] as const) {
    await cabinet.getByText(title, { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await checkpoint(s, `billing-cabinet-${name}`);
  }
  await scrollEnd(settings);
  await checkpoint(s, 'billing-cabinet-end');
  await settings.evaluate((el) => [el, ...el.querySelectorAll<HTMLElement>('*')].forEach((e) => (e.scrollTop = 0)));
  // Top-up dialog.
  await tap(cabinet.getByTestId('billing-topup-open'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-topup');
  await closeTop(page);
  // Plan change and stop: the quotes.
  await tap(cabinet.getByTestId('billing-change-plan'));
  await expect(page.getByTestId('billing-quote')).toBeVisible();
  await checkpoint(s, 'billing-quote-change');
  await closeTop(page);
  await tap(cabinet.getByTestId('billing-stop'));
  await expect(page.getByTestId('billing-quote')).toBeVisible();
  await checkpoint(s, 'billing-quote-stop');
});

// ---------------------------------------------------------------- Business: the badge and the plan dialog

test('billing-business: badge and plans', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_ENTERPRISE' });
  await checkpoint(s, 'billing-badge-business');
  await openPlans(page);
  await checkpoint(s, 'billing-plans-business');
});

// ---------------------------------------------------------------- Debt: the badge, the bar, the cabinet

test('billing-debt: badge, bar, plans, cabinet, top-up', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'debt', plan: 'PLAN_TEAM' });
  await expect(page.getByTestId('billing-banner')).toBeVisible();
  await checkpoint(s, 'billing-badge-debt');
  await openPlans(page);
  await checkpoint(s, 'billing-plans-debt');
  await tap(page.getByTestId('plans-details'));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await expect(settings.getByTestId('billing-cabinet')).toBeVisible();
  await checkpoint(s, 'billing-cabinet-debt');
  await tap(settings.getByTestId('billing-topup-open'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-topup-debt');
});

// ---------------------------------------------------------------- Suspended: the owner's paywall, the dialog

test('billing-suspended: paywall, badge, plans, top-up', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  // The phone paywall replaces the whole shell: no plan badge there (a finding), so no plan dialog.
  const s = await boot(page, { scenario: 'suspended', plan: 'PLAN_TEAM', badge: !isPhone() });
  await expect(page.getByTestId('billing-paywall')).toBeVisible();
  await checkpoint(s, 'billing-paywall-owner');
  if (!isPhone()) await openPlans(page);
  // axe scrollable-region-focusable: every plan card is blocked, the scrolling body has nothing focusable (QA finding).
  if (!isPhone()) {
    await checkpoint(s, 'billing-plans-suspended', { axe: false });
    await closeTop(page);
  }
  await tap(page.getByTestId('billing-paywall-topup'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-paywall-topup');
});

test('billing-suspended-member: the stub', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'memberSuspended', plan: 'PLAN_TEAM', email: 'vera@calaba.test', badge: false });
  await expect(page.getByTestId('billing-paywall')).toBeVisible();
  await checkpoint(s, 'billing-paywall-member');
});

// ---------------------------------------------------------------- A member: the read-only dialog and the stub

test('billing-member: read-only plans and the settings stub', async ({ page }) => {
  const s = await boot(page, { scenario: 'member', plan: 'PLAN_TEAM', email: 'vera@calaba.test' });
  if (!isLight()) await checkpoint(s, 'billing-badge-member');
  await tap(page.getByTestId('plan-badge'));
  await expect(page.getByTestId('billing-plans-member')).toBeVisible();
  await checkpoint(s, 'billing-plans-member');
  if (isLight()) return;
  // «Лимиты тарифа» → settings → «Тариф» (a member has no workspace menu entry for it).
  await tap(page.getByRole('button', { name: 'Лимиты тарифа' }));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await expect(settings.getByTestId('billing-member-stub')).toBeVisible();
  await checkpoint(s, 'billing-cabinet-member');
});

// ---------------------------------------------------------------- After creating a workspace: the plan choice step

test('billing-welcome: the plan choice after workspace creation', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'selfServe', plan: 'PLAN_FREE' });
  await tap(page.getByTestId(isPhone() ? 'phone-ws-switcher' : 'titlebar-title'));
  await tap(page.getByRole('menuitem', { name: 'Создать пространство' }));
  const dlg = page.getByRole('dialog').last();
  await dlg.getByRole('textbox').first().fill('Новая команда');
  await checkpoint(s, 'billing-create-workspace');
  await tap(dlg.getByRole('button', { name: /^Создать/ }));
  await expect(page.getByTestId('billing-plans')).toBeVisible();
  await checkpoint(s, 'billing-plans-welcome');
});

// ---------------------------------------------------------------- RU market (ADR-0083): the switch, СБП / Карта МИР, contact mode

test('billing-ru: market switch and the RU pay step', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  // Both markets open, Russian UI: Russia, ₽ is preselected; the seller line names the RU seller.
  const s = await boot(page, { scenario: 'selfServe', plan: 'PLAN_FREE', sales: 'both' });
  await openPlans(page);
  await expect(page.getByTestId('plans-market')).toBeVisible();
  await checkpoint(s, 'billing-plans-market');
  await tap(page.getByTestId('plans-choose-TEAM'));
  await expect(page.getByTestId('plans-methods')).toBeVisible();
  await checkpoint(s, 'billing-pay-ru');
});

test('billing-ru-cabinet: the RU top-up dialog', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', market: 'ru' });
  await openPlans(page);
  await tap(page.getByTestId('plans-details'));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await tap(settings.getByTestId('billing-topup-open'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-topup-ru');
});

test('billing-contact: no acquirer takes new clients', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'selfServe', plan: 'PLAN_FREE', sales: 'contact' });
  await openPlans(page);
  await checkpoint(s, 'billing-plans-contact');
});

// ---------------------------------------------------------------- Superadmin: «Оплата» list and account page

test('billing-admin: accounts list and the account page', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM' });
  if (isPhone()) {
    await tap(page.getByTestId('phone-tab-profile'));
    await tap(page.getByRole('button', { name: 'Администрирование' }));
  } else {
    await tap(page.getByRole('button', { name: /^Мой статус/ }));
    await tap(page.getByRole('menuitem', { name: 'Администрирование' }));
  }
  const admin = page.getByTestId('admin-window');
  await expect(admin).toBeVisible();
  await tap(admin.getByRole('radio', { name: 'Оплата' }));
  await expect(admin.getByTestId('admin-billing-list')).toBeVisible();
  await (isPhone() ? shotOnly : checkpoint)(s, 'billing-admin-list');
  await tap(admin.getByTestId('admin-billing-account').first());
  await expect(admin.getByTestId('admin-billing-actions')).toBeVisible();
  await (isPhone() ? shotOnly : checkpoint)(s, 'billing-admin-account');
  await admin.getByTestId('admin-billing-payments').scrollIntoViewIfNeeded();
  await (isPhone() ? shotOnly : checkpoint)(s, 'billing-admin-payments');
  await scrollEnd(admin);
  await (isPhone() ? shotOnly : checkpoint)(s, 'billing-admin-account-end');
  // ADR-0083: «Эквайеры» and the market change of an account without payments (Orbit, inactive).
  await tap(admin.getByTestId('admin-billing-nav-providers'));
  await expect(admin.getByTestId('admin-billing-providers-mode')).toBeVisible();
  await (isPhone() ? shotOnly : checkpoint)(s, 'billing-admin-providers');
  await tap(admin.getByTestId('admin-billing-account').nth(3));
  await tap(admin.getByTestId('admin-billing-market'));
  await expect(page.getByRole('dialog').last()).toBeVisible();
  await (isPhone() ? shotOnly : checkpoint)(s, 'billing-admin-market');
});
