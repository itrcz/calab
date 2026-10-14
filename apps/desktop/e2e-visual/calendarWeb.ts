import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { AttendeeStatus, EventRepeat } from '@calaba/protocol';
import { IDS, startMockServer, type AddEventArgs, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD } from './harness';

/**
 * Calendar behaviour specs (ADR-0038, docs/20 (c)): the production web build (dist-web) served
 * same-origin by the mock API, in Chromium with the Moscow zone, the page and the mock frozen at
 * NOW (15 January 2026, 13:30 MSK). No screenshots here — the calendar's baselines are in
 * screens.spec.ts / mobile.visual.spec.ts.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project calendar
 */

const DIST = join(import.meta.dirname, '..', 'dist-web');
export const DAY = '2026-01-15';
/** 15:00 MSK on NOW's day. */
export const AT_15 = Date.parse('2026-01-15T12:00:00Z');
export const HOUR = 3_600_000;

export const test = base.extend<{ mock: MockServer }>({
  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
    const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    mock.setClock(NOW.getTime());
    await use(mock);
    await mock.close();
  },
});

export { expect };

/** Opens `path` (default the app) signed in as `email` (Анна by default), dark theme, Russian UI. */
export async function signIn(page: Page, mock: MockServer, path = '/', email = 'owner@calaba.test'): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  await page.goto(`${mock.url}${path}${path.includes('?') ? '&' : '?'}visual-test`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
}

/** The header icon → the mini month → NOW's day: the day view. */
export async function openDay(page: Page, day = DAY): Promise<void> {
  const mini = page.getByTestId('mini-calendar');
  if (!(await mini.isVisible())) await page.getByTestId('section-calendar').click();
  await mini.locator(`[data-cal-day="${day}"]`).click();
  await expect(page.getByTestId('day-view')).toBeVisible();
}

/**
 * A full day for the calendar screens (NOW's day, Moscow): an all-day release, a daily stand-up,
 * «Обед» I declined, «Планёрка» (Борис's, my answer pending) overlapping my «Ревью дизайна», and a
 * meeting tomorrow (a dot in the mini month). Returns «Планёрка»'s id.
 */
export function seedDay(mock: MockServer): string {
  const W = IDS.workspaces.main;
  const U = IDS.users;
  const at = (iso: string): number => Date.parse(iso);
  mock.addEvent({ workspaceId: W, title: 'Релиз 1.0', startMs: at('2026-01-14T21:00:00Z'), endMs: at('2026-01-15T21:00:00Z'), allDay: true, tz: 'Europe/Moscow', attendees: [{ userId: U.boris, status: AttendeeStatus.ACCEPTED }] });
  mock.addEvent({ workspaceId: W, title: 'Стендап', startMs: at('2026-01-13T07:00:00Z'), endMs: at('2026-01-13T07:15:00Z'), roomId: IDS.rooms.call, repeat: EventRepeat.DAILY, attendees: [{ userId: U.boris, status: AttendeeStatus.ACCEPTED }, { userId: U.vera }] });
  mock.addEvent({ workspaceId: W, organizerId: U.vera, title: 'Обед с командой', startMs: at('2026-01-15T09:00:00Z'), endMs: at('2026-01-15T10:00:00Z'), attendees: [{ userId: U.anna, status: AttendeeStatus.DECLINED }, { userId: U.boris, status: AttendeeStatus.ACCEPTED }] });
  const id = planerka(mock, { attendees: [{ userId: U.anna }, { userId: U.vera, required: false, status: AttendeeStatus.MAYBE }, { userId: U.grigory, status: AttendeeStatus.ACCEPTED }, { email: 'ext@example.com', required: false }] });
  mock.addEvent({ workspaceId: W, title: 'Ревью дизайна', startMs: AT_15 + HOUR / 2, endMs: AT_15 + 1.5 * HOUR, attendees: [{ userId: U.boris, status: AttendeeStatus.ACCEPTED }] });
  mock.addEvent({ workspaceId: W, title: 'Ретро', startMs: at('2026-01-20T13:00:00Z'), endMs: at('2026-01-20T14:00:00Z'), roomId: IDS.rooms.meeting });
  return id;
}

/** «Планёрка» 15:00–16:00 MSK in «Переговорка», organized by Борис, Анна invited (optional external too). */
export function planerka(mock: MockServer, extra: Partial<AddEventArgs> = {}): string {
  return mock.addEvent({
    workspaceId: IDS.workspaces.main,
    organizerId: IDS.users.boris,
    title: 'Планёрка',
    description: 'Повестка: релиз 1.0',
    startMs: AT_15,
    endMs: AT_15 + HOUR,
    roomId: IDS.rooms.meeting,
    attendees: [{ userId: IDS.users.anna }, { userId: IDS.users.vera, required: false }, { email: 'ext@example.com', required: false }],
    ...extra,
  }).id;
}
