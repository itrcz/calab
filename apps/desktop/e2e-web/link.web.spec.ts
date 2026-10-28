import { expect, test, type Page } from '@playwright/test';

/**
 * Web link page (docs/09 #53): `/join/<code>` shows the «Открыть в Calab» card before any web
 * flow; «Продолжить в браузере» leads to registration with the code (signed out). The app launch
 * itself is not fired here (it would hand `calab://` to the OS) — its states are covered by
 * e2e-visual/web.spec.ts and lib/appLaunch.test.ts.
 */
test('invite link: card → continue in the browser → registration with the code', async ({ page }) => {
  await page.goto('/join/e2e-link-card-0000');
  const card = page.getByTestId('link-landing');
  await expect(card.getByRole('heading', { name: 'Вас пригласили в пространство' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Открыть в Calab' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Скачать приложение' })).toHaveAttribute('href', '/download/');
  await expect(card.getByRole('checkbox', { name: 'Запомнить выбор' })).not.toBeChecked();
  expect(new URL(page.url()).pathname).toBe('/join/e2e-link-card-0000'); // kept while the card is shown

  await card.getByRole('button', { name: 'Продолжить в браузере' }).click();
  // An unknown code: no invitation card, the code stays visible (and correctable) in its field.
  await expect(page.getByLabel('Код приглашения')).toHaveValue('e2e-link-card-0000');
  expect(new URL(page.url()).pathname).toBe('/');
});

/**
 * The invitation end to end (docs/09 #36) — against the mock API only (it needs `/__mock/invite`
 * for a code; the stand has no mailbox): link → «Продолжить в браузере» → sign-up with the
 * invitation card (no code field) → «Подтвердите почту» → in the workspace, without the join step
 * or the join dialog.
 */
async function mockInvite(page: Page, email?: string): Promise<string | null> {
  const res = await page.request.post('/__mock/invite', { data: email ? { email } : {} }).catch(() => null);
  if (!res?.ok()) return null;
  return ((await res.json()) as { code: string }).code;
}

async function signUpFromLink(page: Page, code: string, email: string | null): Promise<void> {
  await page.goto(`/join/${code}`);
  await page.getByTestId('link-landing').getByRole('button', { name: 'Продолжить в браузере' }).click();
  const card = page.getByTestId('auth-invite-card');
  await expect(card).toContainText('Приглашение в «Команда Calab»');
  // The code travels unseen; an emailed invitation locks the address.
  await expect(page.getByLabel('Код приглашения')).toHaveCount(0);
  const field = page.getByLabel('Email');
  if (email) {
    await expect(field).toHaveValue(email);
    await expect(field).toHaveAttribute('readonly', '');
  } else {
    await field.fill(`link-${Date.now().toString(36)}@example.com`);
  }
  await page.getByLabel('Имя').fill('Новичок');
  await page.getByLabel('Пароль', { exact: true }).fill('password-web-123');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).last().click();
}

async function expectInWorkspace(page: Page): Promise<void> {
  await expect(page.locator('aside').first().getByRole('button', { name: /^Команда Calab/ }).first()).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Присоединиться к пространству' })).toHaveCount(0);
}

test('emailed invitation: link → sign-up (address locked) → email code → in the workspace', async ({ page }) => {
  const email = `invited-${Date.now().toString(36)}@example.com`;
  const code = await mockInvite(page, email);
  test.skip(!code, 'needs the mock API (/__mock/invite)');
  await signUpFromLink(page, code ?? '', email);

  // Settings before the workspace; no «Присоединиться» step (web: verify, mic, notifications, mode, done).
  const verify = page.getByTestId('onboarding-verify');
  await expect(verify).toBeVisible();
  await expect(page.getByRole('list', { name: 'Шаг 1 из 5' })).toBeVisible();
  await verify.getByLabel('Код из письма').fill('123456'); // MOCK_EMAIL_CODE: submits by itself
  // One notice of the join (the confirmation's toast), then the onboarding goes on.
  await expect(page.getByText(/^Почта подтверждена — вы в/)).toHaveCount(1);
  await expect(page.getByTestId('onboarding-mic')).toBeVisible();
  await page.getByRole('button', { name: 'Пропустить настройку' }).click();
  await expectInWorkspace(page);
});

test('plain invitation link: link → sign-up with the hidden code → in the workspace', async ({ page }) => {
  const code = await mockInvite(page);
  test.skip(!code, 'needs the mock API (/__mock/invite)');
  await signUpFromLink(page, code ?? '', null);
  // Joined by the sign-up already: the onboarding has no join step (verify, mic, notifications, mode, done).
  await expect(page.getByTestId('onboarding-verify')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Шаг 1 из 5' })).toBeVisible();
  await page.getByRole('button', { name: 'Пропустить настройку' }).click();
  await expectInWorkspace(page);
});
