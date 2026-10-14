import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * TESTING.md «Заметки» (ADR-0039), web client against the mock (e2e-support, `--static dist-web`):
 * Борис creates a shelf in «Личные» («+» → name → Enter), writes a note, forwards it to Вера
 * («Переслать…» → Вера), then drags the DM copy back onto the shelf by its grip — the copy appears
 * in the shelf. Mock only: it resets the fixtures first (POST /__mock/reset).
 */

test.skip(!!process.env['CALABA_WEB_LOGIN'], 'mock fixtures only (boris@calaba.test)');

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  const rail = page.getByRole('navigation', { name: 'Разделы' });
  await expect(skip.or(rail)).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(rail).toBeVisible();
}

/**
 * A native drag by the mouse: a short first move starts the drag over its source (locator.dragTo
 * jumps straight to the target, before the grip's dragstart can take the drag), then the target.
 */
async function dragByMouse(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('drag: no boxes');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 5, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
}

test('create a shelf, note, forward to a DM, drag the copy back onto the shelf', async ({ page, request }) => {
  expect((await request.post('/__mock/reset', { data: { scenario: 'data' } })).ok()).toBe(true);
  await signIn(page, 'boris@calaba.test');
  await page.getByTestId('rail-home').getByRole('button').click();
  const notes = page.getByTestId('notes-section');
  await expect(notes).toBeVisible();

  // «+» → the inline form (a default emoji) → Enter: the shelf is created and opens.
  await notes.getByTestId('notes-new').click();
  await page.getByTestId('notes-name').fill('Идеи');
  await page.getByTestId('notes-name').press('Enter');
  await expect(page.getByTestId('notes-header-bar')).toContainText('Идеи');
  const shelf = notes.getByTestId('notes-shelf').filter({ hasText: 'Идеи' });
  await expect(shelf).toHaveCount(1);

  // A note: the shelf's composer, then the list preview.
  const box = page.getByRole('textbox', { name: 'Заметка в «Идеи»' });
  await box.fill('Мысль из e2e');
  await box.press('Enter');
  const note = page.locator('[data-message-id]').filter({ hasText: 'Мысль из e2e' });
  await expect(note).toHaveCount(1);
  await expect(shelf).toContainText('Мысль из e2e');

  // «Переслать…» → Вера: the DM with her gets the copy (created on the way).
  await note.getByTestId('message-bubble').click({ button: 'right' });
  await page.getByTestId('message-forward').click();
  const dialog = page.getByTestId('forward-dialog');
  await dialog.getByRole('combobox').fill('Вера');
  await dialog.getByRole('option', { name: /Вера Ким/ }).click();
  await page.getByTestId('forward-send').click();
  const dmRow = page.getByTestId('dm-row').filter({ hasText: 'Вера Ким' });
  await expect(dmRow).toContainText('Мысль из e2e');

  // Drag and drop: the DM copy by its grip onto the shelf → forwarded back into the shelf.
  await dmRow.getByRole('button').first().click();
  await expect(page.getByTestId('dm-header')).toContainText('Вера Ким');
  const copy = page.locator('[data-message-id]').filter({ hasText: 'Мысль из e2e' });
  await copy.getByTestId('message-bubble').hover();
  await dragByMouse(page, copy.getByTestId('message-drag'), shelf);
  await expect(page.getByText('Сохранено в «📝 Идеи»')).toBeVisible();
  await shelf.getByRole('button').first().click();
  await expect(page.getByTestId('notes-header-bar')).toContainText('Идеи');
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Мысль из e2e' })).toHaveCount(2);
});
