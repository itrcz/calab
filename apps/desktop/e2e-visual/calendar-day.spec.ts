import type { Locator } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { AT_15, DAY, HOUR, expect, openDay, planerka, signIn, test } from './calendarWeb';

/**
 * The day view (ADR-0038 §7, docs/20 C.1, C.8, owner's d&d addendum): create → the meeting is in the
 * day view and selected; a block dragged 2 hours later → PATCH with the new times; the bottom edge
 * → the new end; the room badge on ROOM_EVENT_ACTIVE → its card; a locked meeting does not move.
 */

test('create: the dialog → the meeting in the day view, selected, the count in the header', async ({ page, mock }) => {
  await signIn(page, mock);
  await openDay(page);
  await expect(page.getByTestId('day-empty')).toBeVisible();
  await page.getByTestId('day-new-event').click();
  const dialog = page.getByTestId('event-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('event-title-input').fill('Ревью дизайна');
  await dialog.getByTestId('event-start').selectOption({ label: '15:00' });
  await dialog.getByTestId('event-end').selectOption({ label: '16:00' });
  await dialog.getByTestId('event-room').selectOption({ label: 'Переговорка' });
  await dialog.getByTestId('event-add-people').click();
  await page.getByTestId('event-member-picker').getByRole('option', { name: /Борис/ }).click();
  await dialog.getByTestId('event-email').fill('ext@example.com');
  await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(dialog.getByTestId('event-chip')).toHaveCount(2);
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/workspaces/${IDS.workspaces.main}/events`));
  await page.getByTestId('event-save').click();
  const body = (await post).postDataJSON() as { title: string; startsAt: string; endsAt: string; roomId: string; tz: string; attendees: Array<{ userId?: string; email?: string }> };
  expect(body).toMatchObject({ title: 'Ревью дизайна', startsAt: '2026-01-15T12:00:00Z', endsAt: '2026-01-15T13:00:00Z', roomId: IDS.rooms.meeting, tz: 'Europe/Moscow' });
  expect(body.attendees.map((a) => a.userId ?? a.email)).toEqual([IDS.users.boris, 'ext@example.com']);
  const block = page.getByTestId('event-block').filter({ hasText: 'Ревью дизайна' });
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('event-panel').getByTestId('event-title')).toHaveText('Ревью дизайна');
  await expect(page.getByTestId('section-calendar-count')).toHaveText('1');
});

test('drag: a block moved 2 hours later and resized sends PATCH with the new times', async ({ page, mock }) => {
  const id = planerka(mock, { organizerId: IDS.users.anna, attendees: [{ userId: IDS.users.boris }] });
  await signIn(page, mock);
  await openDay(page);
  const block = page.getByTestId('event-block').filter({ hasText: 'Планёрка' });
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  if (!box) throw new Error('no block');
  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/events/${id}`));
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  // 48 px an hour: 96 px = 2 hours, in steps (the ghost follows).
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2, box.y + 10 + i * 12);
  await expect(page.getByTestId('drag-ghost')).toContainText('17:00 – 18:00');
  await page.mouse.up();
  expect((await patch).postDataJSON()).toMatchObject({ startsAt: '2026-01-15T14:00:00Z', endsAt: '2026-01-15T15:00:00Z' });
  await expect(page.getByTestId('event-block').filter({ hasText: '17:00' })).toBeVisible();

  // The bottom edge: 30 minutes longer.
  const moved = page.getByTestId('event-block').filter({ hasText: 'Планёрка' });
  const b2 = await moved.boundingBox();
  if (!b2) throw new Error('no block');
  const resize = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/events/${id}`));
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height - 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height - 2 + i * 6);
  await page.mouse.up();
  expect((await resize).postDataJSON()).toMatchObject({ startsAt: '2026-01-15T14:00:00Z', endsAt: '2026-01-15T15:30:00Z' });
});

test('drag onto a day of the mini calendar moves the meeting there', async ({ page, mock }) => {
  const id = planerka(mock, { organizerId: IDS.users.anna, attendees: [] });
  await signIn(page, mock);
  await openDay(page);
  const block = page.getByTestId('event-block').filter({ hasText: 'Планёрка' });
  const box = await block.boundingBox();
  const target = await page.locator('[data-cal-day="2026-01-16"]').boundingBox();
  if (!box || !target) throw new Error('no boxes');
  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/events/${id}`));
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, box.y + 40, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await patch).postDataJSON()).toMatchObject({ startsAt: '2026-01-16T12:00:00Z', endsAt: '2026-01-16T13:00:00Z' });
});

test('a meeting of someone else does not move; the card and the menu offer no edit', async ({ page, mock }) => {
  planerka(mock);
  // Вера: an attendee without MANAGE_ROOM in «Переговорка» (Анна, the owner, may change it).
  await signIn(page, mock, '/', 'vera@calaba.test');
  await openDay(page);
  let patched = false;
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/api/events/')) patched = true;
  });
  const block = page.getByTestId('event-block').filter({ hasText: 'Планёрка' });
  await expect(block).toHaveAttribute('title', /организатор/);
  const box = await block.boundingBox();
  if (!box) throw new Error('no block');
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 110, { steps: 6 });
  await page.mouse.up();
  expect(patched).toBe(false);
  await block.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Дублировать' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Изменить' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('room badge: ROOM_EVENT_ACTIVE shows «Планёрка в 15:00» on the room, a click opens the card; ENDED removes it', async ({ page, mock }) => {
  const id = planerka(mock, { startMs: AT_15 + 2 * HOUR, endMs: AT_15 + 3 * HOUR }); // outside the window: no badge yet
  await signIn(page, mock);
  const badge = page.locator('aside').getByTestId('room-event-badge');
  await expect(badge).toHaveCount(0);
  mock.setEventActive(id, true);
  await expect(badge).toHaveText('Планёрка в 17:00');
  await badge.click();
  const card = page.getByTestId('room-event-card');
  await expect(card.getByTestId('event-title')).toHaveText('Планёрка');
  await expect(card.getByTestId('event-attendee')).toHaveCount(4);
  await page.keyboard.press('Escape');
  mock.setEventActive(id, false);
  await expect(badge).toHaveCount(0);
});

test('keyboard: → next day, T today, N new meeting', async ({ page, mock }) => {
  await signIn(page, mock);
  await openDay(page);
  const title = page.getByTestId('day-view').getByRole('heading', { level: 1 });
  // Focus out of the mini calendar (its own arrows move the focused day).
  await title.click();
  await page.keyboard.press('ArrowRight');
  await expect(title).toHaveText(/16 января/);
  await page.keyboard.press('t');
  await expect(title).toHaveText(/15 января/);
  await page.keyboard.press('n');
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  // Esc on an untouched dialog closes it without asking.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-dialog')).toHaveCount(0);
  await expect(page.locator(`[data-cal-day="${DAY}"]`)).toHaveAttribute('aria-current', 'date');
});

test('the card: Esc closes it (focus back on the block), another day closes it, a click on the grid first deselects', async ({ page, mock }) => {
  planerka(mock);
  await signIn(page, mock);
  await openDay(page);
  const block = page.getByTestId('event-block').filter({ hasText: 'Планёрка' });
  const panel = page.getByTestId('event-panel');
  await block.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(block).toBeFocused();
  await expect(block).toHaveAttribute('aria-pressed', 'false');

  // Another day: the card of a meeting not on it goes.
  await block.click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Следующий день' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Предыдущий день' }).click();

  // With a meeting selected, a click on the empty grid closes the card; the next one creates.
  await block.click();
  await expect(panel).toBeVisible();
  const scroller = page.getByTestId('day-scroller');
  await scroller.evaluate((el) => (el.scrollTop = 18 * 48));
  const box = await scroller.boundingBox();
  if (!box) throw new Error('no scroller');
  const at = { x: box.x + 120, y: box.y + 100 };
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('event-dialog')).toHaveCount(0);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('event-dialog')).toBeVisible();
});

test('editing a selected meeting: the members column is back for a drag; a room dragged from the list highlights the field', async ({ page, mock }) => {
  planerka(mock, { organizerId: IDS.users.anna, attendees: [] });
  await signIn(page, mock);
  await openDay(page);
  await page.getByTestId('event-block').filter({ hasText: 'Планёрка' }).click();
  await page.getByTestId('event-panel').getByRole('button', { name: 'Изменить' }).click();
  const dialog = page.getByTestId('event-dialog');
  await expect(dialog).toBeVisible();
  const members = page.getByRole('complementary', { name: 'Участники' });
  await expect(members).toBeVisible();
  await expect(page.getByTestId('event-panel')).toHaveCount(0);

  const drag = async (from: Locator, to: Locator, during?: () => Promise<void>): Promise<void> => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    if (!a || !b) throw new Error('drag: no boxes');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 5, { steps: 3 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await during?.();
    await page.mouse.up();
  };
  await drag(members.getByRole('button', { name: /Вера Ким/ }).first(), dialog.getByTestId('event-attendees'));
  await expect(dialog.getByTestId('event-chip').filter({ hasText: 'Вера Ким' })).toHaveCount(1);

  // The room list's own drag (dnd-kit): the field lights up like under a native drag.
  const field = dialog.locator('[data-drop-room]');
  await drag(page.locator('aside').first().getByRole('button', { name: /Созвон/ }).first(), dialog.getByTestId('event-room'), async () => {
    await expect(field).toHaveClass(/outline-accent/);
  });
  await expect(dialog.getByTestId('event-room')).toHaveValue(IDS.rooms.call);
  await expect(field).not.toHaveClass(/outline-accent/);
});
