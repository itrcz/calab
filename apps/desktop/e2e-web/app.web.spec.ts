import { expect, test } from '@playwright/test';

/**
 * Web client main scenario: register → workspace → room → message → reload keeps the
 * session (HttpOnly refresh cookie) → voice. Voice in Firefox is opt-in
 * (CALABA_WEB_FF_VOICE=1): against a Docker-hosted LiveKit on 127.0.0.1 Firefox's ICE
 * does not connect; on the stand it should.
 */
test('register → workspace → room → message → reload → voice', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const id = `${browserName}-${Date.now().toString(36)}`;
  await page.goto('/');
  // Invite-only servers (the stand): CALABA_WEB_LOGIN + CALABA_WEB_PASSWORD sign in with an
  // existing account (preferred — doesn't spend invite uses); otherwise register, with
  // CALABA_WEB_INVITE as the invite code when set.
  const login = process.env['CALABA_WEB_LOGIN'];
  const password = process.env['CALABA_WEB_PASSWORD'];
  if (login && password) {
    await page.getByLabel('Email').fill(login);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await page.getByLabel('Email').fill(`web-${id}@example.com`);
    await page.getByLabel('Имя').fill(`Web ${id}`);
    await page.getByLabel('Пароль', { exact: true }).fill('password-web-123');
    const invite = process.env['CALABA_WEB_INVITE'];
    if (invite) await page.getByLabel('Код приглашения').fill(invite);
    await page.getByRole('button', { name: 'Зарегистрироваться' }).last().click();
  }
  // First run: onboarding (docs/08) — skip it, it has its own visual tests. (Builds from
  // before the onboarding go straight to the main window.)
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  const rail = page.getByRole('navigation', { name: 'Разделы' });
  await expect(skip.or(rail)).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  // READY is in before the non-waiting checks below: the rail's «Команда» (some workspace) or the
  // welcome screen's «Создать пространство» (none yet).
  await expect(page.getByTestId('section-chats').or(page.getByRole('button', { name: 'Создать пространство' })).first()).toBeVisible();

  // Idempotent on a shared account (the stand limits workspace creation, 3/hour): reuse the
  // «E2E web» workspace and its rooms when they exist, create them only when missing.
  // Workspaces are picked in the title bar's switcher (ADR-0074); give an existing «E2E web» a
  // bounded moment to appear before deciding to create one — creating needlessly hits the rate
  // limit on the stand.
  await page.getByTestId('titlebar-title').click();
  const existing = page.getByRole('menuitem', { name: /^E2E web\b/ });
  const found = await existing
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true, () => false);
  if (found) {
    await existing.first().click();
  } else {
    await page.getByRole('menuitem', { name: 'Создать пространство' }).click();
    await page.getByLabel('Название').fill('E2E web');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
  }
  // The selected workspace is named in the title bar (the switcher, ADR-0074): wait for it before
  // looking at the rooms.
  await expect(page.getByTestId('titlebar-title')).toContainText(/E2E web/, { timeout: 15_000 });
  const rooms = page.locator('aside').first();
  const general = rooms.getByRole('button', { name: /^общий(,|$)/ });
  const hasGeneral = await general
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true, () => false);
  if (hasGeneral) {
    await general.first().click();
  } else {
    await rooms.getByRole('button', { name: 'Создать комнату' }).first().click();
    await page.getByLabel('Название').fill('общий');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
  }

  const box = page.getByPlaceholder('Сообщение в #общий');
  await box.fill(`Привет из **веба** ${id}`);
  // Wait for the POST before reloading: a reload mid-request cancels it (API: 500 «context canceled»).
  const sent = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/rooms\/[^/]+\/messages$/.test(new URL(r.url()).pathname));
  await box.press('Enter');
  expect((await sent).ok()).toBe(true);
  await expect(page.getByText(id, { exact: false }).last()).toBeVisible();

  // The refresh token lives only in the HttpOnly cookie: JS must not see it, reload must keep us in.
  expect(String(await page.evaluate('document.cookie'))).not.toContain('calaba_refresh');
  const cookie = (await page.context().cookies()).find((c) => c.name === 'calaba_refresh');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'общий', exact: true })).toBeVisible();

  if (browserName === 'firefox' && process.env['CALABA_WEB_FF_VOICE'] !== '1') return;
  if ((await page.locator('aside button', { hasText: 'Созвон' }).count()) === 0) {
    await page.getByRole('button', { name: 'Создать комнату' }).nth(1).click();
    await page.getByLabel('Название').fill('Созвон');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
  }
  await page.locator('aside button', { hasText: 'Созвон' }).first().hover();
  await page.getByRole('button', { name: 'Войти в голос «Созвон»' }).click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  // Camera (docs/09 #41; server from feat/webcam): the browser's fake camera, first start through
  // the preview sheet. Chromium publishes VP9 simulcast, Firefox / Safari plain VP8 simulcast.
  if (process.env['CALABA_WEB_CAMERA'] !== '0') {
    await page.getByTestId('camera-button').click();
    await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('camera-preview-enable').click();
    await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await expect(page.getByTestId('camera-pip')).toBeVisible();
    await page.getByTestId('camera-button').click();
    await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
  }
  await page.getByRole('button', { name: 'Отключиться' }).click();
  await expect(page.getByText('Голос подключён')).toHaveCount(0);
});
