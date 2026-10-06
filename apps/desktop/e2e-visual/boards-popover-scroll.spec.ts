import { expect, signIn, test } from './calendarWeb';

/**
 * docs/09 #118 (global fix): a popover portaled to <body> from inside a modal dialog scrolls with
 * the wheel — here the assignee picker of «Создать задачу». The window is short so the member list
 * overflows. Behaviour only, no screenshots.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project boards -g "popover scroll"
 */
test('popover scroll: create-task assignee picker scrolls with the wheel', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn(page, mock);
  await page.getByTestId('section-boards').click();
  await expect(page.getByTestId('kanban')).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-task')).toBeVisible();
  await page.getByTestId('create-task-assignees').click();
  const list = page.getByRole('listbox').last();
  await expect(list.getByTestId('picker-option').first()).toBeVisible();
  const before = await list.evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  expect(before.room, 'the member list overflows').toBeGreaterThan(20);
  const box = await list.boundingBox();
  if (!box) throw new Error('no picker list');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(before.top);
});
