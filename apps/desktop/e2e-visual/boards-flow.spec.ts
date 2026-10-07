import type { Page } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { expect, signIn, test } from './calendarWeb';

/**
 * Task boards (ADR-0042 §5, docs/21): one flow against the mock, the web build in Chromium —
 * boards mode → kanban → create a task → drag it to another column (PATCH body) → the panel:
 * assignees with the lead and a note (PUT body) → a comment with a reaction → filter by a label
 * → save the view (POST body) → the list: bulk status. Behaviour only, no screenshots.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project boards
 */

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
}

test('boards: kanban → create → drag → assignees → comment → filter → view → list bulk', async ({ page, mock }) => {
  const cal = [...mock.boards.boards.values()].find((b) => b.board.key === 'CAL')?.board;
  if (!cal) throw new Error('no CAL board');
  const status = (name: string): string => cal.statuses.find((s) => s.name === name)?.id ?? '';
  await signIn(page, mock);

  // Boards mode: the header icon; the column lists boards, the centre is the first board.
  await page.getByTestId('section-boards').click();
  await expect(page.getByTestId('boards-list')).toBeVisible();
  await expect(page.getByTestId('board-row')).toHaveCount(2);
  const kanban = page.getByTestId('kanban');
  await expect(kanban).toBeVisible();
  await expect(kanban.getByTestId('kanban-column')).toHaveCount(6);
  await expect(page.getByTestId('task-card').filter({ hasText: 'CAL-3' })).toBeVisible();

  // Create (C): the dialog, the task lands in the default column.
  await page.keyboard.press('c');
  const dialog = page.getByTestId('create-task');
  await expect(dialog).toBeVisible();
  await page.getByTestId('create-task-title').fill('Проверить доски на стенде');
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/boards/${cal.id}/tasks`));
  await page.getByTestId('create-task-submit').click();
  expect((await created).status()).toBe(201);
  const card = page.getByTestId('task-card').filter({ hasText: 'Проверить доски на стенде' });
  await expect(card).toBeVisible();
  // «Создана задача CAL-9 · Открыть» (the page clock is frozen: close it by hand).
  await page.getByRole('button', { name: 'Закрыть уведомление' }).click();
  const todo = kanban.locator(`[data-column="${status('Todo')}"]`);
  await expect(todo.getByTestId('task-card').filter({ hasText: 'Проверить доски' })).toBeVisible();

  // Drag it to «В работе», under CAL-4: PATCH with the status and the neighbours.
  const doing = kanban.locator(`[data-column="${status('В работе')}"]`);
  const src = await card.boundingBox();
  const cal4 = await doing.getByTestId('task-card').filter({ hasText: 'CAL-4' }).boundingBox();
  if (!src || !cal4) throw new Error('no boxes');
  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(r.url()));
  await drag(page, { x: src.x + src.width / 2, y: src.y + 12 }, { x: cal4.x + cal4.width / 2, y: cal4.y + cal4.height - 4 });
  const cal4Id = mock.boards.taskByKey('CAL-4')?.task.id ?? '';
  expect((await patch).postDataJSON()).toMatchObject({ statusId: status('В работе'), afterTaskId: cal4Id });
  await expect(doing.getByTestId('task-card').filter({ hasText: 'Проверить доски' })).toBeVisible();

  // The panel: assignees Вера and Борис, Борис the lead, a note for Вера.
  await doing.getByTestId('task-card').filter({ hasText: 'Проверить доски' }).getByTestId('card-title').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel.getByTestId('task-title')).toHaveValue('Проверить доски на стенде');
  await panel.getByTestId('assignee-add').click();
  const menu = page.getByTestId('assignee-menu');
  await menu.getByRole('option', { name: /Вера/ }).click();
  await menu.getByRole('option', { name: /Борис/ }).click();
  await page.keyboard.press('Escape');
  await expect(panel.getByTestId('assignee-row')).toHaveCount(2);
  const lead = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/assignees'));
  await panel.locator(`[data-testid=assignee-row][data-user="${IDS.users.boris}"]`).getByTestId('assignee-lead').click();
  expect((await lead).postDataJSON()).toMatchObject({ assignees: [{ userId: IDS.users.boris, isLead: true }, { userId: IDS.users.vera }] });
  const note = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/assignees'));
  const veraNote = panel.locator(`[data-testid=assignee-row][data-user="${IDS.users.vera}"]`).getByTestId('assignee-note');
  await veraNote.fill('Дизайн карточек');
  await veraNote.press('Enter');
  expect((await note).postDataJSON()).toMatchObject({ assignees: [{ userId: IDS.users.boris, isLead: true }, { userId: IDS.users.vera, note: 'Дизайн карточек' }] });

  // A comment (the task room through the chat composer) and a reaction on it.
  const composer = panel.getByTestId('task-composer').getByRole('textbox');
  await composer.fill('Проверил на Mac — всё работает');
  const sent = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/rooms\/[^/]+\/messages$/.test(r.url()));
  await composer.press('Enter');
  expect((await sent).status()).toBe(201);
  const comment = panel.locator('[data-message-id]').filter({ hasText: 'Проверил на Mac' });
  await expect(comment).toBeVisible();
  await comment.hover();
  const react = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/reactions/'));
  await comment.getByRole('button', { name: /Реакция 👍/ }).click();
  expect((await react).ok()).toBe(true);
  await expect(panel.getByTestId('activity-row').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Закрыть' }).click();
  await expect(panel).toBeHidden();

  // Filter by a label (F → Лейблы → Баг): only CAL-3 stays.
  await page.keyboard.press('f');
  await page.getByTestId('filter-fields').getByRole('option', { name: 'Лейблы' }).click();
  await page.getByTestId('filter-values').getByRole('option', { name: /Баг/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('filter-chip')).toHaveCount(1);
  await expect(page.getByTestId('task-card')).toHaveCount(1);
  await expect(page.getByTestId('task-card')).toContainText('CAL-3');

  // Save it as a view: POST with the filter.
  await page.getByTestId('views-menu').click();
  await page.getByTestId('save-view').click();
  await page.getByTestId('view-name').fill('Баги');
  const view = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/boards/${cal.id}/views`));
  await page.getByTestId('save-view-submit').click();
  const bug = cal.labels.find((l) => l.name === 'Баг')?.id ?? '';
  expect((await view).postDataJSON()).toMatchObject({ name: 'Баги', filter: { conditions: [{ field: 'TASK_FIELD_LABEL', values: [bug] }] } });
  await expect(page.getByTestId('views-menu')).toContainText('Баги');

  // The list (2): reset the filter, select two rows, set their status at once.
  await page.getByTestId('filter-reset').click();
  await page.keyboard.press('2');
  const list = page.getByTestId('list-view');
  await expect(list).toBeVisible();
  const rows = list.getByTestId('list-row');
  await rows.filter({ hasText: 'CAL-1' }).getByTestId('row-select').click();
  await rows.filter({ hasText: 'CAL-2' }).getByTestId('row-select').click();
  await expect(page.getByTestId('bulk-bar')).toContainText('2 задачи');
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(r.url())) patches.push(JSON.stringify(r.postDataJSON()));
  });
  await page.getByTestId('bulk-status').click();
  const done = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.ok());
  await page.getByTestId('status-menu').getByRole('option', { name: 'Ревью' }).click();
  await done;
  await expect.poll(() => patches.length).toBe(2);
  for (const p of patches) expect(JSON.parse(p)).toEqual({ statusId: status('Ревью') });
  await expect(list.getByTestId('list-group').filter({ hasText: 'Ревью' })).toContainText('3');

  // Esc peels one layer at a time (selection, focus) and then leaves the mode: the rooms are back.
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  for (let i = 0; i < 4 && !(await page.getByTestId('room-list').isVisible()); i++) await page.keyboard.press('Escape');
  await expect(page.getByTestId('room-list')).toBeVisible();
});
