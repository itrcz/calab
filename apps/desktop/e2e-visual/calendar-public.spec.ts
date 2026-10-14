import { AttendeeStatus } from '@calaba/protocol';
import type { Page } from '@playwright/test';
import type { MockServer } from '../e2e-support/mock-server';
import { NOW } from './harness';
import { HOUR, expect, planerka, signIn, test } from './calendarWeb';

/**
 * Deep links for invited people (ADR-0038 «Диплинки для приглашённых», TESTING.md C.19–C.20):
 * the public meeting page of an external address (`/e/<id>?t=<view token>`, no account) with its
 * answer buttons and the guest link's window; an answer link applied on arrival; a guest of the
 * room sees the meeting's badge and card (counts only).
 */

const EXT = 'ext@example.com';

async function openPublic(page: Page, mock: MockServer, path: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  await page.goto(`${mock.url}${path}${path.includes('?') ? '&' : '?'}visual-test`);
  await expect(page.getByTestId('event-public')).toBeVisible();
}

test('view link: the meeting without an account, «Приму» with the answer token, the guest link not yet active', async ({ page, mock }) => {
  const id = planerka(mock);
  mock.eventGuestLink(id, EXT);
  await openPublic(page, mock, `/e/${id}?t=${encodeURIComponent(mock.eventViewToken(id, EXT))}`);
  await expect(page.getByTestId('event-title')).toHaveText('Планёрка');
  await expect(page.getByTestId('event-when')).toHaveText('Четверг, 15 января · 15:00 – 16:00');
  await expect(page.getByText('Повестка: релиз 1.0')).toBeVisible();
  await expect(page.getByText('Переговорка')).toBeVisible();
  // Other attendees are never listed (privacy).
  await expect(page.getByText('Вера')).toHaveCount(0);
  await expect(page.getByTestId('event-join')).toBeDisabled();
  await expect(page.getByTestId('event-join-hint')).toHaveText('Ссылка станет активной за 15 минут до начала');

  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/event-rsvp'));
  await page.getByRole('button', { name: 'Приму' }).click();
  expect((await post).postDataJSON()).toEqual({ token: mock.eventRsvpToken(id, EXT, AttendeeStatus.ACCEPTED) });
  await expect(page.getByRole('button', { name: 'Приму' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('event-saved')).toHaveText('Ответ сохранён: Приму');
});

test('inside the window «Присоединиться к встрече» leads to the room link', async ({ page, mock }) => {
  const start = NOW.getTime() + 10 * 60_000; // 13:40: the link is active from 13:25
  const id = planerka(mock, { startMs: start, endMs: start + HOUR });
  const url = mock.eventGuestLink(id, EXT);
  await openPublic(page, mock, `/e/${id}?t=${encodeURIComponent(mock.eventViewToken(id, EXT))}`);
  const join = page.getByTestId('event-join');
  await expect(join).toBeEnabled();
  await join.click();
  await expect(page).toHaveURL(new RegExp(new URL(url).pathname));
  await expect(page.getByTestId('link-landing')).toBeVisible();
});

test('answer link from the mail is applied once on arrival', async ({ page, mock }) => {
  const id = planerka(mock);
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/event-rsvp'));
  await openPublic(page, mock, `/e/${id}/rsvp?t=${encodeURIComponent(mock.eventRsvpToken(id, EXT, AttendeeStatus.MAYBE))}`);
  await post;
  await expect(page.getByTestId('event-saved')).toHaveText('Ответ сохранён: Может быть');
  await expect(page.getByRole('button', { name: 'Может быть' })).toHaveAttribute('aria-pressed', 'true');
});

test('a guest of the room: the meeting badge and its card, counts without the list', async ({ page, mock }) => {
  const start = NOW.getTime() + 10 * 60_000;
  const id = planerka(mock, { startMs: start, endMs: start + HOUR });
  await signIn(page, mock, `/e/${id}`, 'dina@calaba.test');
  // /e/<id> of a guest: the room, with the card open on its header badge.
  await expect(page.getByRole('heading', { name: 'Переговорка' }).first()).toBeVisible();
  const card = page.getByTestId('room-event-card');
  await expect(card.getByTestId('event-title')).toHaveText('Планёрка');
  await expect(card.getByTestId('event-counts')).toBeVisible();
  await expect(card.getByTestId('event-attendee')).toHaveCount(0);
  await expect(card.getByTestId('rsvp')).toHaveCount(0);
  await expect(card.getByTestId('event-edit')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // No calendar for a guest; the room row carries the badge.
  await expect(page.getByTestId('section-calendar')).toHaveCount(0);
  await expect(page.locator('aside').getByTestId('room-event-badge')).toHaveText('Планёрка в 13:40');
});
