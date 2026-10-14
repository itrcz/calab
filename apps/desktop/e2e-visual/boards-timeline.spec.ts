import type { Page } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { expect, signIn, test } from './calendarWeb';

/**
 * Task boards 1.1.0 (ADR-0042 §5, docs/21): the timeline's drags as PATCH bodies, «Создать
 * задачу» from a message (POST with from_message_id), a /t/ link card in chat opening the task
 * panel. Behaviour only, the web build in Chromium against the mock.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project boards -g timeline
 */

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();
}

const patchOf = (page: Page) => page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(r.url()));

test('boards timeline: move, resize, place from «Без дат»', async ({ page, mock }) => {
  await signIn(page, mock);
  await page.getByTestId('section-boards').click();
  await expect(page.getByTestId('kanban')).toBeVisible();
  await page.keyboard.press('3');
  const tl = page.getByTestId('timeline');
  await expect(tl).toBeVisible();
  // Week scale: 44 px a day.
  await tl.getByRole('radio', { name: 'Неделя' }).click();
  const row = (key: string) => tl.locator('[data-testid=timeline-row]').filter({ hasText: key });
  await expect(row('CAL-4').getByTestId('bar-blocked')).toBeVisible();

  // Move CAL-3 (12–14 Jan) two days right.
  const bar = row('CAL-3').getByTestId('timeline-bar');
  const b = await bar.boundingBox();
  if (!b) throw new Error('no bar');
  let patch = patchOf(page);
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + 88, y: b.y + b.height / 2 });
  expect((await patch).postDataJSON()).toEqual({ startOn: '2026-01-14', dueOn: '2026-01-16' });
  // CAL-3 now ends after CAL-4 starts (13th) still: the marker stays.
  await expect(row('CAL-4').getByTestId('bar-blocked')).toBeVisible();

  // Resize CAL-4's end one day right (13–15 → 13–16).
  const bar4 = row('CAL-4').getByTestId('timeline-bar');
  await bar4.hover();
  const e = await bar4.getByTestId('bar-end').boundingBox();
  if (!e) throw new Error('no edge');
  patch = patchOf(page);
  await drag(page, { x: e.x + e.width / 2, y: e.y + e.height / 2 }, { x: e.x + e.width / 2 + 44, y: e.y + e.height / 2 });
  expect((await patch).postDataJSON()).toEqual({ dueOn: '2026-01-16' });

  // «Без дат»: CAL-1 dropped on the scale gets one day (start = due).
  const chip = page.getByTestId('undated-task').filter({ hasText: 'CAL-1' });
  const c = await chip.boundingBox();
  const s = await page.getByTestId('timeline-scroll').boundingBox();
  if (!c || !s) throw new Error('no boxes');
  patch = patchOf(page);
  await drag(page, { x: c.x + 20, y: c.y + c.height / 2 }, { x: s.x + s.width - 100, y: s.y + 120 });
  const body = (await patch).postDataJSON() as { startOn: string; dueOn: string };
  expect(body.startOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.dueOn).toBe(body.startOn);
  await expect(row('CAL-1')).toBeVisible();

  // A click on a bar opens the task panel.
  await row('CAL-3').getByTestId('timeline-bar').click();
  await expect(page.getByTestId('task-panel').getByTestId('task-title')).toHaveValue('Эхо в звонке при включённых колонках');
});

test('boards: task from a message, and a /t/ card opening the panel', async ({ page, mock }) => {
  await signIn(page, mock);
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  const msg = mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: '**Починить** экспорт в CSV\nподробности в треде' });
  const bubble = page.locator(`[data-message-id="${msg.id}"]`);
  await expect(bubble).toBeVisible();

  // Right click → «Создать задачу»: the title from the first line, the message id in the POST.
  await bubble.getByText('подробности в треде').click({ button: 'right' });
  await page.getByTestId('message-create-task').click();
  await expect(page.getByTestId('create-task-title')).toHaveValue('Починить экспорт в CSV');
  const post = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/boards\/[^/]+\/tasks$/.test(r.url()));
  await page.getByTestId('create-task-submit').click();
  expect((await post).postDataJSON()).toMatchObject({ title: 'Починить экспорт в CSV', fromMessageId: msg.id });
  await page.getByRole('button', { name: 'Закрыть уведомление' }).click();

  // A /t/ link: the card; a click opens the task in the boards mode.
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: 'Глянь https://calab.test/t/CAL-4' });
  const card = page.getByTestId('task-link-card');
  await expect(card).toContainText('CAL-4');
  await expect(card).toContainText('Карточки задач в чате');
  await card.click();
  await expect(page.getByTestId('task-panel').getByTestId('task-title')).toHaveValue('Карточки задач в чате (unfurl)');
  await expect(page.getByTestId('boards-list')).toBeVisible();
});
