import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, checkpoint, type Shot, type Theme } from './harness';

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

/** ADR-0086: the custom plan of the `custom` scenario (the billing mock's MOCK_CUSTOM_NAME and limits). */
const CUSTOM_PLAN = {
  displayName: 'Нейро-офис Про',
  description: 'Договор № 7 от 01.10: до 120 человек, 500 ГБ',
  limits: { members: 120, roomMembers: 30, storageMb: String(500 * 1024), bots: 8, telephonyDisabled: true, boardWebhooksDisabled: true },
};

/** The workspace's plan as a superadmin sets it (Workspace.plan → the badge). */
async function setPlan(plan: 'PLAN_FREE' | 'PLAN_TEAM' | 'PLAN_ENTERPRISE' | 'PLAN_CUSTOM'): Promise<void> {
  const json = { 'content-type': 'application/json' };
  const login = await fetch(`${mock.url}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'owner@calaba.test', password: PASSWORD }) });
  const token = ((await login.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
  const r = await fetch(`${mock.url}/api/admin/workspaces/${IDS.workspaces.main}/plan`, {
    method: 'PUT',
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify(plan === 'PLAN_CUSTOM' ? { plan, note: '', ...CUSTOM_PLAN } : { plan, note: '' }),
  });
  expect(r.status, 'set the workspace plan').toBe(200);
}

interface Boot {
  scenario: 'normal' | 'debt' | 'suspended' | 'selfServe' | 'member' | 'memberSuspended' | 'lapsed' | 'memberLapsed';
  plan: 'PLAN_FREE' | 'PLAN_TEAM' | 'PLAN_ENTERPRISE' | 'PLAN_CUSTOM';
  /** ADR-0086 «Индивидуальный тариф»: the account is on its custom plan (mock `?custom=1`). */
  custom?: boolean;
  email?: string;
  /** The plan badge is expected in the header (default). */
  badge?: boolean;
  /** ADR-0083: markets open for new accounts (mock `?sales=`, default global) and the account's market. */
  sales?: 'both' | 'ru' | 'contact';
  market?: 'ru';
  /** ADR-0083 phase 2: the mock's one-click answer (default: paid at once). */
  oneclick?: '3ds' | 'decline';
  /** ADR-0086: the workspace exceeds Team / Free (mock `?limits=over`), the plan is admin-assigned (`?admin=1`). */
  limits?: 'over';
  admin?: boolean;
  /** The iOS native shell (apps/mobile): its host bridge declared before the page loads (owner 10.10: no payment UI there). */
  iosShell?: boolean;
}

/** One page load: the billing scenario, the theme, the sign-in, the workspace's main screen. */
async function boot(page: Page, o: Boot): Promise<Shot> {
  const theme: Theme = isLight() ? 'light' : 'dark';
  await setPlan(o.plan);
  if (o.iosShell) {
    // What apps/mobile activityBootstrap declares (platform field of 2026-10-10); the WebKit
    // project's iPhone user agent completes the signal (platform/nativeShell).
    await page.addInitScript(() => {
      Object.defineProperty(window, 'CalabHostActivity', {
        value: Object.freeze({ version: 1, host: 1, platform: 'ios', document: 'visual', rotateDocument: () => undefined, send: () => undefined }),
      });
    });
  }
  await page.clock.setFixedTime(NOW);
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate((th) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: th, onboarded: true, locale: 'ru' }, version: 1 })), theme);
  const extra = `${o.sales ? `&sales=${o.sales}` : ''}${o.market ? `&market=${o.market}` : ''}${o.oneclick ? `&oneclick=${o.oneclick}` : ''}${o.limits ? `&limits=${o.limits}` : ''}${o.admin ? '&admin=1' : ''}${o.custom ? '&custom=1' : ''}`;
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

/** Settings → «Тариф» from the badge (owner, 10.10: the badge leads to the plan tab). */
async function openPlanTab(page: Page): Promise<Locator> {
  await tap(page.getByTestId('plan-badge'));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await expect(settings.getByTestId('plan-limits')).toBeVisible();
  return settings;
}

/** The plan dialog: the badge → settings → «Сменить тариф». */
async function openPlans(page: Page): Promise<Locator> {
  const settings = await openPlanTab(page);
  const button = settings.getByTestId('plan-switch');
  await button.scrollIntoViewIfNeeded();
  await tap(button);
  await expect(page.getByTestId('billing-plans')).toBeVisible();
  return page.getByTestId('billing-plans');
}

/** From the plan dialog (opened over settings) back to the cabinet under it. */
async function backToCabinet(page: Page): Promise<Locator> {
  await closeTop(page);
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await settings.evaluate((el) => [el, ...el.querySelectorAll<HTMLElement>('*')].forEach((e) => (e.scrollTop = 0)));
  return settings;
}

/** Closes the top dialog with Escape (every billing dialog must answer it: the close box does not hold the focus). */
async function closeTop(page: Page): Promise<void> {
  // A dialog over a dialog hides the one below from the a11y tree: hold the top one by handle.
  const top = await dialog(page).elementHandle();
  await page.keyboard.press('Escape');
  await top.waitForElementState('hidden', { timeout: 10_000 });
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
  // The outline badge (owner 10.10) in both themes: the light one only here.
  await checkpoint(s, 'billing-badge-team');
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
  // The plan dialog opened over settings → «Тариф»: the cabinet is right under it.
  const settings = await backToCabinet(page);
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
  const settings = await backToCabinet(page);
  await expect(settings.getByTestId('billing-cabinet')).toBeVisible();
  await checkpoint(s, 'billing-cabinet-debt');
  await tap(settings.getByTestId('billing-topup-open'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-topup-debt');
});

// ---------------------------------------------------------------- Suspended: the owner's paywall, the dialog

test('billing-suspended: paywall, badge, plans, top-up', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'suspended', plan: 'PLAN_TEAM' });
  await expect(page.getByTestId('billing-paywall')).toBeVisible();
  await checkpoint(s, 'billing-paywall-owner');
  await tap(page.getByTestId('billing-paywall-topup'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-paywall-topup');
  await closeTop(page);
  // The plans open over settings → «Тариф» (ADR-0086): last, as settings stay under them.
  await openPlans(page);
  await checkpoint(s, 'billing-plans-suspended');
});

test('billing-suspended-member: the stub', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'memberSuspended', plan: 'PLAN_TEAM', email: 'vera@calaba.test', badge: false });
  await expect(page.getByTestId('billing-paywall')).toBeVisible();
  await checkpoint(s, 'billing-paywall-member');
});

// ---------------------------------------------------------------- A member: the read-only dialog and the stub

test('billing-member: the badge leads to the plan tab with the stub', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'member', plan: 'PLAN_TEAM', email: 'vera@calaba.test' });
  await checkpoint(s, 'billing-badge-member');
  // The badge → settings → «Тариф» (a member has no workspace menu entry for it).
  const settings = await openPlanTab(page);
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
  const settings = await openPlanTab(page);
  await tap(settings.getByTestId('billing-topup-open'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-topup-ru');
});

// ---------------------------------------------------------------- One-click top-up with a saved card (ADR-0083 phase 2)

/** The cabinet's top-up dialog with the saved card preselected. */
async function openTopup(page: Page): Promise<Locator> {
  const settings = await openPlanTab(page);
  await tap(settings.getByTestId('billing-topup-open'));
  const d = page.getByTestId('billing-topup');
  await expect(d).toBeVisible();
  await expect(d.getByTestId('billing-topup-saved').first()).toHaveAttribute('aria-checked', 'true');
  return d;
}

test('billing-oneclick: saved card, confirm, paid', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM' });
  await openTopup(page);
  await tap(page.getByTestId('billing-topup-pay'));
  await expect(page.getByTestId('billing-topup-confirm')).toBeVisible();
  await checkpoint(s, 'billing-oneclick-confirm');
  await tap(page.getByTestId('billing-topup-charge'));
  await expect(page.getByTestId('billing-checkout-done')).toBeVisible();
  await checkpoint(s, 'billing-oneclick-done');
});

test('billing-oneclick-3ds: the bank asks to confirm', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', oneclick: '3ds' });
  await openTopup(page);
  await tap(page.getByTestId('billing-topup-pay'));
  // The 3-D Secure page opens in a tab on the web: keep the shot on the app.
  page.context().on('page', (p) => void p.close());
  await tap(page.getByTestId('billing-topup-charge'));
  await expect(page.getByTestId('billing-checkout-waiting')).toBeVisible();
  await checkpoint(s, 'billing-oneclick-3ds');
});

test('billing-oneclick-ru: МИР card declined', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', market: 'ru', oneclick: 'decline' });
  await openTopup(page);
  await tap(page.getByTestId('billing-topup-pay'));
  await expect(page.getByTestId('billing-topup-confirm')).toBeVisible();
  await checkpoint(s, 'billing-oneclick-ru-confirm');
  await tap(page.getByTestId('billing-topup-charge'));
  await expect(page.getByTestId('billing-checkout-done')).toBeVisible();
  await checkpoint(s, 'billing-oneclick-ru-declined');
});

test('billing-contact: no acquirer takes new clients', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'selfServe', plan: 'PLAN_FREE', sales: 'contact' });
  await openPlans(page);
  await checkpoint(s, 'billing-plans-contact');
});

// ---------------------------------------------------------------- Payer requisites by country (ADR-0080 §0.1)

/** Picks a country in the payer form's searchable select (by its English name: the search covers it). */
async function pickCountry(page: Page, query: string, code: string): Promise<void> {
  await tap(page.getByTestId('payer-country'));
  const list = page.getByTestId('payer-country-list');
  await list.getByRole('combobox').fill(query);
  await tap(list.getByRole('option').filter({ hasText: code }).first());
  await expect(page.getByTestId('payer-country')).toContainText(code);
}

test('billing-payer: requisites form by country', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  // The RU account: the saved payer is a Russian company (ИНН, КПП, ОГРН, юридический адрес).
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', market: 'ru' });
  // The badge opens settings → «Тариф» with the cabinet (ADR-0086).
  const settings = await openPlanTab(page);
  await tap(settings.getByTestId('billing-payer-edit'));
  const form = page.getByTestId('billing-payer-form');
  await expect(form.getByTestId('billing-payer-type')).toBeVisible();
  await expect(form.getByTestId('billing-payer-field-inn')).toHaveValue('7707083893');
  await checkpoint(s, 'billing-payer-ru-company');
  // Inline check: a wrong ИНН check digit once the field is left.
  await form.getByTestId('billing-payer-field-inn').fill('7707083894');
  await form.getByTestId('billing-payer-field-inn').press('Tab');
  await expect(form.getByText('Номер с ошибкой — проверьте цифры')).toBeVisible();
  await checkpoint(s, 'billing-payer-ru-error');
  // ИП: ФИО, ИНН 12, ОГРНИП, адрес.
  await tap(form.getByRole('radio', { name: 'ИП' }));
  await form.getByRole('textbox', { name: 'ФИО предпринимателя' }).fill('ИП Иванов Иван Иванович');
  await form.getByTestId('billing-payer-field-inn').fill('500100732259');
  await form.getByTestId('billing-payer-field-ogrnip').fill('304500116000157');
  await form.getByTestId('billing-payer-field-address').fill('Тверь, ул. Советская, 1');
  await dialog(page).evaluate((el) => el.querySelectorAll<HTMLElement>('*').forEach((e) => (e.scrollTop = 0)));
  await checkpoint(s, 'billing-payer-ru-sole');
  // The searchable country list (the English name finds it too).
  await tap(page.getByTestId('payer-country'));
  await page.getByTestId('payer-country-list').getByRole('combobox').fill('Emir');
  await expect(page.getByTestId('payer-country-list').getByRole('option')).toHaveCount(1);
  await checkpoint(s, 'billing-payer-country-list');
  await page.keyboard.press('Escape');
  // UAE company: TRN (required), trade licence, address.
  await pickCountry(page, 'Emirates', 'AE');
  await expect(form.getByRole('radio', { name: 'ИП' })).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Название организации' }).fill('Falcon Trading LLC');
  await form.getByTestId('billing-payer-field-trn').fill('100 1234 5670 0003');
  await form.getByTestId('billing-payer-field-trade_license').fill('CN-1234567');
  await checkpoint(s, 'billing-payer-ae-company');
  // EU company: the VAT ID with its country prefix.
  await pickCountry(page, 'Germany', 'DE');
  await form.getByRole('textbox', { name: 'Название организации' }).fill('Muster GmbH');
  await form.getByTestId('billing-payer-field-vat').fill('DE123456789');
  await checkpoint(s, 'billing-payer-eu-company');
  // Any other country: an optional free-form tax number.
  await pickCountry(page, 'Brazil', 'BR');
  await form.getByRole('textbox', { name: 'Название организации' }).fill('Empresa Exemplo Ltda');
  await form.getByTestId('billing-payer-field-tax_id').fill('12.345.678/0001-95');
  await checkpoint(s, 'billing-payer-generic');
  // Saved: the card shows the new payer.
  await tap(page.getByTestId('billing-payer-save'));
  await expect(form).toBeHidden();
  await expect(settings.getByText('Empresa Exemplo Ltda')).toBeVisible();
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
  await checkpoint(s, 'billing-admin-list');
  // «Тариф не активен» (ADR-0086 amendment 1): the filter leaves only the lapsed account, its page shows the pill.
  await tap(admin.getByRole('radio', { name: 'Не активен' }));
  await expect(admin.getByTestId('admin-billing-account')).toHaveCount(1);
  await expect(admin.getByTestId('admin-billing-account').first()).toContainText('Quiet Co');
  await checkpoint(s, 'billing-admin-lapsed-filter');
  await tap(admin.getByTestId('admin-billing-account').first());
  await expect(admin.getByTestId('admin-billing-detail')).toContainText('ops@quiet.test');
  await checkpoint(s, 'billing-admin-lapsed-account');
  if (isPhone()) await tap(admin.getByTestId('admin-billing-back'));
  await tap(admin.getByRole('radio', { name: 'Все' }));
  await expect(admin.getByTestId('admin-billing-account')).toHaveCount(6);
  await tap(admin.getByTestId('admin-billing-account').first());
  await expect(admin.getByTestId('admin-billing-actions')).toBeVisible();
  await checkpoint(s, 'billing-admin-account');
  await admin.getByTestId('admin-billing-payments').scrollIntoViewIfNeeded();
  await checkpoint(s, 'billing-admin-payments');
  await scrollEnd(admin);
  await checkpoint(s, 'billing-admin-account-end');
  // ADR-0083: «Эквайеры» and the market change of an account without payments (Orbit, inactive).
  if (isPhone()) await tap(admin.getByTestId('admin-billing-back'));
  await tap(admin.getByTestId('admin-billing-nav-providers'));
  await expect(admin.getByTestId('admin-billing-providers-mode')).toBeVisible();
  await checkpoint(s, 'billing-admin-providers');
  if (isPhone()) await tap(admin.getByTestId('admin-billing-back'));
  await tap(admin.getByTestId('admin-billing-account').nth(3));
  await tap(admin.getByTestId('admin-billing-market'));
  await expect(page.getByRole('dialog').last()).toBeVisible();
  await checkpoint(s, 'billing-admin-market');
});

// ---------------------------------------------------------------- Plan transitions (ADR-0086)

test('billing-transitions: the plan tab, «Сменить тариф», a downgrade over the limits', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  // Business, over Team's and Free's limits (6 bots, rooms of 30, SSO, 7 GB of files, automations).
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_ENTERPRISE', limits: 'over' });
  const settings = await openPlanTab(page);
  const button = settings.getByTestId('plan-switch');
  await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-tr-plan-tab');
  await tap(button);
  await expect(page.getByTestId('billing-plans')).toBeVisible();
  await expect(page.getByTestId('plans-why-TEAM')).toBeVisible();
  await checkpoint(s, 'billing-tr-plans');
  await tap(page.getByTestId('plans-why-TEAM'));
  await expect(page.getByTestId('plan-violations')).toBeVisible();
  await checkpoint(s, 'billing-tr-plans-why');
  const cabinet = await backToCabinet(page);
  // Business → Team from the cabinet: the quote is refused with the violations and where to fix them.
  await tap(cabinet.getByTestId('billing-change-plan'));
  await expect(page.getByTestId('plan-violations')).toBeVisible();
  await checkpoint(s, 'billing-tr-quote-blocked');
  await closeTop(page);
  // Stop over Free's limits: allowed (ADR-0086 amendment); the dialog warns about «тариф не активен» with what does not fit.
  await tap(cabinet.getByTestId('billing-stop'));
  await expect(page.getByTestId('billing-stop-over-free')).toBeVisible();
  await expect(page.getByTestId('billing-quote-confirm')).toBeVisible();
  await checkpoint(s, 'billing-tr-stop-over-free');
});

// ---------------------------------------------------------------- «Тариф не активен» (ADR-0086 amendment, owner 10.10)

test('billing-lapsed: the banner, the composer, the 3rd voice join, «Перейти на Free», the cabinet', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'lapsed', plan: 'PLAN_FREE', limits: 'over' });
  await expect(page.getByTestId('billing-lapsed-banner')).toBeVisible();
  if (!isPhone()) await expect(page.getByTestId('composer-plan-inactive')).toBeVisible();
  await checkpoint(s, 'billing-lapsed-owner');
  // «Перейти на Free» from the banner: the quote answers what does not fit Free.
  await tap(page.getByTestId('billing-lapsed-banner').getByTestId('billing-lapsed-free'));
  await expect(page.getByTestId('plan-violations')).toBeVisible();
  await checkpoint(s, 'billing-lapsed-to-free');
  await closeTop(page);
  if (!isPhone()) {
    // The third person in a voice room: the server answers 409 ROOM_FULL / WORKSPACE_PLAN_INACTIVE.
    await page.route('**/api/rooms/*/join', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'ERROR_CODE_ROOM_FULL', message: 'the room is full', reason: 'WORKSPACE_PLAN_INACTIVE', used: '2', limit: '2' }),
      }),
    );
    await page.locator('aside').getByRole('button', { name: 'Созвон', exact: true }).hover();
    await page.locator('aside').getByRole('button', { name: 'Войти в голос «Созвон»' }).click();
    await expect(page.getByText('Тариф не активен — в голосовой комнате сейчас можно быть только вдвоём').first()).toBeVisible();
    // axe off: the fixture chat of «Созвон» has a link of its own contrast (not this screen's).
    await checkpoint(s, 'billing-lapsed-voice-full', { axe: false });
    await page.unroute('**/api/rooms/*/join');
    await page.getByTestId('toast').getByRole('button').last().click();
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  }
  const settings = await openPlanTab(page);
  await expect(settings.getByTestId('billing-lapsed-note')).toBeVisible();
  await settings.getByTestId('billing-lapsed-note').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-lapsed-cabinet');
});

test('billing-lapsed-member: the banner and the composer without actions', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'memberLapsed', plan: 'PLAN_FREE', email: 'vera@calaba.test' });
  await expect(page.getByTestId('billing-lapsed-banner')).toBeVisible();
  await expect(page.getByTestId('billing-lapsed-free')).toHaveCount(0);
  if (!isPhone()) await expect(page.getByTestId('composer-plan-inactive')).toBeVisible();
  await checkpoint(s, 'billing-lapsed-member');
});

test('billing-transitions-money: the pay step lines, the plan change net, the grouped history', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'selfServe', plan: 'PLAN_FREE' });
  await openPlans(page);
  await tap(page.getByTestId('plans-choose-TEAM'));
  await expect(page.getByTestId('plans-pay-lines')).toBeVisible();
  await checkpoint(s, 'billing-tr-pay-lines');
});

test('billing-transitions-change: the net of a plan change and its history row', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM' });
  const cabinet = await openPlanTab(page);
  await tap(cabinet.getByTestId('billing-change-plan'));
  await expect(page.getByTestId('billing-change-net')).toBeVisible();
  await checkpoint(s, 'billing-tr-quote-net');
  await tap(page.getByTestId('billing-quote-confirm'));
  await expect(page.getByTestId('billing-quote')).toBeHidden();
  const op = cabinet.getByTestId('billing-ledger-op').first();
  await expect(op).toBeVisible();
  await tap(op.getByRole('button', { name: 'Подробнее' }));
  await op.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-tr-history-op');
});

test('billing-transitions-admin: a plan assigned by a superadmin', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', admin: true, badge: false });
  await tap(page.getByTestId(isPhone() ? 'phone-ws-switcher' : 'titlebar-title'));
  await tap(page.getByRole('menuitem', { name: 'Настройки', exact: true }));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await tap(settings.getByText('Тариф', { exact: true }).first());
  const note = settings.getByTestId('plan-admin-assigned');
  await expect(note).toBeVisible();
  await note.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-tr-admin-assigned');
});

// ---------------------------------------------------------------- Custom plan (ADR-0086 «Индивидуальный тариф»)

test('billing-custom: the custom plan for the owner and the superadmin editor', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_CUSTOM', custom: true });
  // The badge carries the custom name.
  await expect(page.getByTestId('plan-badge')).toContainText(CUSTOM_PLAN.displayName);
  await checkpoint(s, 'billing-custom-badge');
  // Settings → «Тариф»: the name and description, the custom price and the scheduled one, no change / stop.
  const settings = await openPlanTab(page);
  const cabinet = settings.getByTestId('billing-cabinet');
  await expect(cabinet.getByTestId('billing-custom-price')).toBeVisible();
  await expect(cabinet.getByTestId('billing-change-plan')).toHaveCount(0);
  await expect(cabinet.getByTestId('billing-stop')).toHaveCount(0);
  await expect(cabinet.getByTestId('billing-topup-open')).toBeVisible();
  // The top: the plan row with the custom name and description, the note and «Условия тарифа».
  await settings.evaluate((el) => [el, ...el.querySelectorAll<HTMLElement>('*')].forEach((e) => (e.scrollTop = 0)));
  await checkpoint(s, 'billing-custom-plan-tab-top');
  await settings.getByTestId('plan-custom-terms').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(s, 'billing-custom-plan-tab');
  // «Условия тарифа»: the plans dialog shows the custom plan read-only.
  await tap(settings.getByTestId('plan-custom-open'));
  await expect(page.getByTestId('plans-custom')).toBeVisible();
  await checkpoint(s, 'billing-custom-plans');
});

test('billing-custom-admin: «Индивидуальный тариф» on the account page and its editor', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_CUSTOM', custom: true });
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
  await tap(admin.getByTestId('admin-billing-account').first());
  const actions = admin.getByTestId('admin-custom-actions');
  await expect(actions).toBeVisible();
  await expect(admin.getByTestId('admin-custom-history')).toBeVisible();
  await actions.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-custom-admin');
  await tap(admin.getByTestId('admin-custom-edit'));
  await expect(page.getByTestId('admin-custom-dialog')).toBeVisible();
  await checkpoint(s, 'billing-custom-admin-editor');
  // A new price from a later date: the preview of what moves now.
  await page.getByTestId('admin-custom-price-input').fill('0,40');
  await page.getByTestId('admin-custom-reason').fill('Новые условия договора');
  await tap(page.getByTestId('admin-custom-submit'));
  await expect(page.getByTestId('admin-custom-preview')).toBeVisible();
  await checkpoint(s, 'billing-custom-admin-preview');
});

// ---------------------------------------------------------------- Billing permissions (ADR-0087)

/** The owner gives Вера a custom role «Финансы» with billing `bits` (REST, before Вера signs in). */
async function grantVera(bits: bigint): Promise<void> {
  const json = { 'content-type': 'application/json' };
  const login = await fetch(`${mock.url}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'owner@calaba.test', password: PASSWORD }) });
  const token = ((await login.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
  const auth = { ...json, authorization: `Bearer ${token}` };
  const created = await fetch(`${mock.url}/api/workspaces/${IDS.workspaces.main}/roles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'Финансы', color: 0x34c759, permissions: bits.toString() }),
  });
  expect(created.status, 'create the billing role').toBe(201);
  const role = ((await created.json()) as { role: { id: string } }).role;
  const put = await fetch(`${mock.url}/api/workspaces/${IDS.workspaces.main}/members/${IDS.users.vera}/roles`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ roleIds: [role.id] }),
  });
  expect(put.status, 'assign the billing role').toBe(200);
}

const BILLING_VIEW = 1n << 32n;
const BILLING_TOPUP = 1n << 33n;

test('billing-roles: the «Биллинг» group of the role card', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM' });
  await tap(page.getByTestId(isPhone() ? 'phone-ws-switcher' : 'titlebar-title'));
  await tap(page.getByRole('menuitem', { name: 'Настройки', exact: true }));
  const settings = isPhone() ? page.getByTestId('settings-page') : page.getByRole('dialog').last();
  await tap(settings.getByText('Роли', { exact: true }).first());
  await tap(settings.getByRole('button', { name: 'Дизайн', exact: true }));
  const group = settings.getByTestId('role-billing-group');
  // The owner ticks «Пополнять баланс»: «Видеть оплату» comes with it (TOPUP implies VIEW).
  await tap(group.getByTestId('role-perm-BILLING_TOPUP'));
  await expect(group.getByTestId('role-perm-BILLING_VIEW')).toBeChecked();
  await expect(group.getByTestId('role-perm-BILLING_MANAGE')).not.toBeChecked();
  await group.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-roles-group');
});

test('billing-member-view: a member with «Видеть оплату»', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  await grantVera(BILLING_VIEW);
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', email: 'vera@calaba.test' });
  await checkpoint(s, 'billing-badge-member-view');
  const settings = await openPlanTab(page);
  const cabinet = settings.getByTestId('billing-cabinet');
  await expect(cabinet).toBeVisible();
  await expect(cabinet.getByTestId('billing-access-note')).toBeVisible();
  await expect(cabinet.getByTestId('billing-topup-open')).toHaveCount(0);
  await expect(cabinet.getByTestId('billing-stop')).toHaveCount(0);
  await cabinet.getByTestId('billing-access-note').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-cabinet-member-view');
});

test('billing-member-topup: a member with «Пополнять баланс»', async ({ page }) => {
  test.skip(isLight(), 'dark only');
  await grantVera(BILLING_TOPUP);
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', email: 'vera@calaba.test' });
  const settings = await openPlanTab(page);
  const cabinet = settings.getByTestId('billing-cabinet');
  await expect(cabinet.getByTestId('billing-topup-open')).toBeVisible();
  await expect(cabinet.getByTestId('billing-change-plan')).toHaveCount(0);
  await expect(settings.getByTestId('plan-switch')).toHaveCount(0);
  await cabinet.getByTestId('billing-actions').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-cabinet-member-topup');
  // The hosted page only: no saved card to charge, nothing to save.
  await tap(cabinet.getByTestId('billing-topup-open'));
  await expect(page.getByTestId('billing-topup')).toBeVisible();
  await checkpoint(s, 'billing-topup-member');
});

test('billing-ios-shell: the plan tab without payment UI', async ({ page }) => {
  test.skip(!isPhone(), 'the iOS shell: iPhone 14 only');
  const s = await boot(page, { scenario: 'normal', plan: 'PLAN_TEAM', iosShell: true });
  const settings = await openPlanTab(page);
  await expect(settings.getByTestId('billing-cabinet')).toBeVisible();
  await expect(settings.getByTestId('billing-payments-elsewhere')).toBeVisible();
  await expect(settings.getByTestId('billing-topup-open')).toHaveCount(0);
  await expect(settings.getByTestId('plan-switch')).toHaveCount(0);
  await expect(settings.getByTestId('billing-payer-edit')).toHaveCount(0);
  await settings.getByTestId('billing-payments-elsewhere').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(s, 'billing-cabinet-ios');
});
