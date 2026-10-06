import { IDS } from '../e2e-support/mock-server';
import { AT_15, DAY, HOUR, expect, openDay, signIn, test } from './calendarWeb';

/**
 * ADR-0041 (docs/20 C.22+): the calendar icon opens today; the «Люди» filter shows a colleague's
 * meetings and grey «Занято» for what I cannot see; «Подобрать время» lists slots and creates a
 * meeting from one (and hands a slot back to the meeting dialog); NO_COMMON_HOURS offers «вне
 * рабочих часов»; a CalDAV account → a calendar → external busy time in my day. The web build in
 * Chromium, Moscow, NOW = 15 January 2026, 13:30 MSK.
 */

const W = IDS.workspaces.main;
const U = IDS.users;

test('the rail’s «Календарь» opens today’s day view at once; «Чаты» goes back to the room; «Доски» turns the day off', async ({ page, mock }) => {
  await signIn(page, mock);
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  const calendar = page.getByTestId('section-calendar');
  const chats = page.getByTestId('section-chats');
  const boards = page.getByTestId('section-boards');
  await expect(chats).toHaveAttribute('aria-current', 'page');
  await calendar.click();
  await expect(page.getByTestId('day-view')).toBeVisible();
  await expect(page.getByTestId('day-view').getByRole('heading', { level: 1 })).toHaveText(/15 января/);
  await expect(page.getByTestId('mini-calendar')).toBeVisible();
  await expect(calendar).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('section-header')).toContainText('Календарь');
  // «Чаты» (ADR-0074): the room again, no day view, no mini month.
  await chats.click();
  await expect(chats).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('day-view')).toHaveCount(0);
  await expect(page.getByTestId('mini-calendar')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  // The calendar, then «Доски» (the day goes off), then the calendar again (the boards go off).
  await calendar.click();
  await expect(page.getByTestId('day-view')).toBeVisible();
  await boards.click();
  await expect(boards).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('day-view')).toHaveCount(0);
  await calendar.click();
  await expect(calendar).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('day-view')).toBeVisible();
});

test('the people filter: a colleague’s meeting, grey «Занято» for one I cannot see, mine hidden', async ({ page, mock }) => {
  // Борис with Григорий, no room: Анна may not see it. Вера's in «Переговорка»: visible to all.
  mock.addEvent({ workspaceId: W, organizerId: U.boris, title: 'Секрет', startMs: AT_15 + HOUR, endMs: AT_15 + 2 * HOUR, attendees: [{ userId: U.grigory }] });
  mock.addEvent({ workspaceId: W, organizerId: U.vera, title: 'Ретро команды', startMs: AT_15 - 2 * HOUR, endMs: AT_15 - HOUR, roomId: IDS.rooms.meeting, attendees: [{ userId: U.boris }] });
  mock.addEvent({ workspaceId: W, title: 'Мой обзор', startMs: AT_15, endMs: AT_15 + HOUR / 2, attendees: [] });
  await signIn(page, mock);
  await openDay(page);
  const blocks = page.getByTestId('event-block');
  await expect(blocks.filter({ hasText: 'Мой обзор' })).toBeVisible();
  await expect(page.getByTestId('busy-block')).toHaveCount(0);

  await page.getByTestId('people-filter-add').click();
  await page.getByTestId('people-filter-picker').getByRole('option', { name: /Борис/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('person-chip')).toHaveCount(1);
  await expect(blocks.filter({ hasText: 'Ретро команды' })).toBeVisible();
  await expect(blocks.filter({ hasText: 'Мой обзор' })).toHaveCount(0);
  const busy = page.getByTestId('busy-block');
  await expect(busy).toHaveCount(1);
  await expect(busy).toHaveAccessibleName(/Занято · Борис Петров, 16:00 – 17:00/);
  // The mini month follows the filter (Борис's only other day: none) and the selection survives a reload.
  await page.reload();
  await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
  await openDay(page);
  await expect(page.getByTestId('person-chip')).toHaveCount(1);
  await page.getByTestId('people-filter-clear').click();
  await expect(page.getByTestId('person-chip')).toHaveCount(0);
  await expect(blocks.filter({ hasText: 'Мой обзор' })).toBeVisible();
});

test('a member dragged from the members list onto the filter is added', async ({ page, mock }) => {
  await signIn(page, mock);
  await openDay(page);
  const row = page.locator(`[data-member-row="${U.vera}"]`);
  await expect(row).toBeVisible();
  await row.dragTo(page.getByTestId('people-filter'));
  await expect(page.getByTestId('person-chip')).toHaveAttribute('data-user', U.vera);
});

test('find a time: slots from suggest, a slot → the dialog prefilled → the meeting created', async ({ page, mock }) => {
  // Борис (Екатеринбург, 10–19 = 08–17 MSK) busy 14:00–15:00 MSK.
  mock.addEvent({ workspaceId: W, organizerId: U.boris, title: 'Занят', startMs: AT_15 - HOUR, endMs: AT_15, attendees: [] });
  await signIn(page, mock);
  await openDay(page);
  await page.getByTestId('day-find').click();
  const pane = page.getByTestId('find-time');
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId('person-chip')).toHaveCount(1); // me
  await pane.getByTestId('find-people-add').click();
  await page.getByTestId('find-people-picker').getByRole('option', { name: /Борис/ }).click();
  await page.keyboard.press('Escape');
  await pane.getByRole('radio', { name: '60 мин' }).click();
  await expect(pane.getByTestId('busy-column')).toHaveCount(2);
  // 1280 with the members column: the centre is narrow — «Ближайшие окна» is the toolbar's popover.
  await pane.getByTestId('find-slots-toggle').click();
  const slots = page.getByTestId('find-slot');
  // 13:30 is too late for an hour before 14:00; the next common hour: 15:00–16:00 (Борис ends at 17:00 MSK).
  await expect(slots.first()).toContainText('15:00 – 16:00');
  await expect(pane.getByTestId('free-window').first()).toBeVisible();
  await slots.first().click();
  const dialog = page.getByTestId('event-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('event-chip')).toHaveCount(1);
  await dialog.getByTestId('event-title-input').fill('Синк');
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/workspaces/${W}/events`));
  await page.getByTestId('event-save').click();
  const body = (await post).postDataJSON() as { startsAt: string; endsAt: string; attendees: Array<{ userId?: string }> };
  expect(body).toMatchObject({ startsAt: '2026-01-15T12:00:00Z', endsAt: '2026-01-15T13:00:00Z' });
  expect(body.attendees.map((a) => a.userId)).toEqual([U.boris]);
  // The meeting shown in its day, the find-a-time mode closed.
  await expect(page.getByTestId('find-time')).toHaveCount(0);
  await expect(page.getByTestId('event-block').filter({ hasText: 'Синк' })).toBeVisible();
});

test('find a time from the dialog hands the slot back; a conflict warns; NO_COMMON_HOURS offers any hours', async ({ page, mock }) => {
  // Борис busy 13:00–16:00 MSK.
  mock.addEvent({ workspaceId: W, organizerId: U.boris, title: 'Занят', startMs: AT_15 - 2 * HOUR, endMs: AT_15 + HOUR, attendees: [] });
  await signIn(page, mock);
  await openDay(page, DAY);
  await page.getByTestId('day-new-event').click();
  const dialog = page.getByTestId('event-dialog');
  await dialog.getByTestId('event-start').selectOption({ label: '15:00' });
  await dialog.getByTestId('event-add-people').click();
  await page.getByTestId('event-member-picker').getByRole('option', { name: /Борис/ }).click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByTestId('availability-conflict')).toContainText('Борис Петров');

  await dialog.getByTestId('event-find').click();
  const find = page.getByTestId('find-time-dialog');
  await expect(find.getByTestId('person-chip')).toHaveCount(2);
  await find.getByTestId('find-slots-toggle').click();
  await page.getByTestId('find-slot').first().click();
  await expect(find).toHaveCount(0);
  // 30 minutes after Борис is free (16:00 MSK).
  await expect(dialog.getByTestId('event-start')).toHaveValue(String(16 * 60));
  await expect(dialog.getByTestId('availability-conflict')).toHaveCount(0);

  // 21–23 in Екатеринбург = 19–21 MSK: never inside Анна's 10–19.
  mock.setWorkHours(U.boris, { startMin: 21 * 60, endMin: 23 * 60, days: [1, 2, 3, 4, 5] });
  await dialog.getByTestId('event-find').click();
  const again = page.getByTestId('find-time-dialog');
  await expect(again.getByTestId('find-no-hours')).toBeVisible();
  await again.getByRole('button', { name: 'Искать и вне рабочих часов' }).click();
  await again.getByTestId('find-slots-toggle').click();
  await expect(page.getByTestId('find-slot').first()).toBeVisible();
});

test('CalDAV: connect → pick a calendar → its event in my day view; «Что видят коллеги» saved', async ({ page, mock }) => {
  await signIn(page, mock);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  await settings.getByRole('tab', { name: 'Календарь' }).click();
  const form = settings.getByTestId('caldav-connect');
  await form.getByTestId('caldav-url').fill('https://caldav.example.com');
  await form.getByTestId('caldav-login').fill('anna@example.com');
  await form.getByTestId('caldav-password').fill('abcd-efgh-ijkl');
  await form.getByTestId('caldav-submit').click();
  const account = settings.getByTestId('caldav-account');
  await expect(account).toBeVisible();
  await account.getByTestId('caldav-calendar').selectOption({ label: 'Работа' });
  await expect(account.getByRole('switch', { name: 'Импортировать занятость' })).toBeChecked();
  await expect(account).toContainText('Последняя:');
  // Work hours saved with PATCH /api/me.
  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/me'));
  await settings.getByTestId('wh-start').selectOption({ label: '09:00' });
  expect((await patch).postDataJSON()).toMatchObject({ workHours: { startMin: 540, endMin: 1140, days: [1, 2, 3, 4, 5] } });
  // ADR-0045 §2: what colleagues see — PATCH /api/me/caldav.
  const share = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/me/caldav'));
  await account.getByRole('radio', { name: 'Название', exact: true }).click();
  expect((await share).postDataJSON()).toEqual({ shareLevel: 'CAL_DAV_SHARE_LEVEL_TITLE' });
  await expect(account.getByTestId('caldav-share')).toContainText('Коллеги видят название события');
  await page.keyboard.press('Escape');

  // My external event (no title in the fake calendar) as a card instead of grey «Занято».
  await openDay(page);
  await expect(page.getByTestId('busy-block')).toHaveCount(0);
  await expect(page.getByTestId('external-block')).toHaveAccessibleName(/Без названия, 11:00 – 12:00 · внешний календарь/);
});
