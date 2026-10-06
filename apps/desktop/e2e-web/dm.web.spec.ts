import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * TESTING.md «Личные сообщения» (ADR-0020), web client against the mock (e2e-support,
 * `--static dist-web`): Борис starts a DM with Вера from «Новое сообщение» and writes; Вера,
 * signed in in another context, gets the DM (DM_CREATE) and the message live, answers, and
 * Борис sees the answer. The shared `/dm/<id>` link opens the DM. Mock only: it resets the
 * fixtures first (POST /__mock/reset).
 */

test.skip(!!process.env['CALABA_WEB_LOGIN'], 'mock fixtures only (boris@ / vera@calaba.test)');

async function signIn(browser: Browser, baseURL: string | undefined, email: string): Promise<Page> {
  const ctx = await browser.newContext(baseURL ? { baseURL } : {});
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  const rail = page.getByRole('navigation', { name: 'Разделы' });
  await expect(skip.or(rail)).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(rail).toBeVisible();
  return page;
}

async function openHome(page: Page): Promise<void> {
  await page.getByTestId('rail-home').getByRole('button').click();
  await expect(page.getByRole('complementary', { name: 'Личные сообщения' })).toBeVisible();
}

test('create a DM, write, the peer gets it live and answers', async ({ browser, baseURL, request }) => {
  expect((await request.post('/__mock/reset', { data: { scenario: 'data' } })).ok()).toBe(true);
  const boris = await signIn(browser, baseURL, 'boris@calaba.test');
  const vera = await signIn(browser, baseURL, 'vera@calaba.test');
  await openHome(vera);
  const veraList = vera.getByTestId('dm-list').or(vera.getByTestId('dm-empty'));
  await expect(veraList).toBeVisible();
  await expect(vera.getByTestId('dm-list').getByRole('button', { name: /Борис Петров/ })).toHaveCount(0);

  // Борис: «Новое сообщение» → Вера → the DM opens.
  await openHome(boris);
  await boris.getByRole('button', { name: 'Новое сообщение' }).first().click();
  const dialog = boris.getByRole('dialog', { name: 'Новое сообщение' });
  await dialog.getByRole('combobox').fill('Вера');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await dialog.getByRole('option', { name: /Вера Ким/ }).click();
  await expect(dialog).toBeHidden();
  await expect(boris.getByTestId('dm-header')).toContainText('Вера Ким');

  const box = boris.getByRole('textbox', { name: 'Написать @Вера Ким' });
  await box.fill('Привет из e2e');
  await box.press('Enter');
  await expect(boris.locator('[data-message-id]').filter({ hasText: 'Привет из e2e' })).toBeVisible();

  // Вера: the DM appears live (DM_CREATE) with the message as its preview and 1 unread.
  const row = vera.getByTestId('dm-list').getByRole('button', { name: /Борис Петров/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Привет из e2e');
  await expect(vera.getByTestId('rail-home').getByRole('button')).toHaveAccessibleName(/непрочитанных: 1/);
  await row.click();
  await expect(vera.getByTestId('dm-header')).toContainText('Борис Петров');
  await expect(vera.locator('[data-message-id]').filter({ hasText: 'Привет из e2e' })).toBeVisible();
  await expect(vera.getByTestId('rail-home').getByRole('button')).toHaveAccessibleName('Личные сообщения');

  const answer = vera.getByRole('textbox', { name: 'Написать @Борис Петров' });
  await answer.fill('Привет, Борис');
  await answer.press('Enter');
  await expect(boris.locator('[data-message-id]').filter({ hasText: 'Привет, Борис' })).toBeVisible();

  // The shared link: https://<server>/dm/<id> opens the DM after a reload.
  const roomId = await vera.evaluate(() => {
    const raw = localStorage.getItem('calaba-ui');
    return raw ? ((JSON.parse(raw) as { state: { lastRoom: Record<string, string> } }).state.lastRoom['@me'] ?? '') : '';
  });
  expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
  // Somewhere else first (a workspace), so the link is what brings the DM back.
  await vera.evaluate(() => localStorage.setItem('calaba-ui', JSON.stringify({ state: { activeWorkspaceId: null }, version: 1 })));
  await vera.goto(`/dm/${roomId}`);
  await expect(vera.getByTestId('dm-header')).toContainText('Борис Петров', { timeout: 20_000 });
  await expect(vera).toHaveURL(/\/$/);

  // Someone else's (or an unknown) DM link: a clear error, not an empty «Личные».
  await vera.goto('/dm/00000000-0000-7000-8000-00000000dead');
  await expect(vera.getByText('Переписка по ссылке недоступна')).toBeVisible({ timeout: 20_000 });
  await expect(vera.getByTestId('dm-pick')).toBeVisible();
});
