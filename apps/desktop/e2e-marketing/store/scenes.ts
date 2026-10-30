import { expect } from '@playwright/test';
import type { Short } from '../copy';
import { feedBottom, phoneRoom, tab, type Ctx } from './harness';

/**
 * The store scenes, in store order. Adding a screen = adding an entry here (the capture spec and the
 * compose step read only this list): `id` names the file (`NN-<id>.png`), `headline` is the card's one
 * line per language, `run` brings the signed-in phone (a fresh render on the room list, dark, in the
 * scene's language) to the screen; the shot is taken right after it.
 */
export interface Scene {
  id: string;
  headline: Record<'ru' | 'en', string>;
  run(ctx: Ctx): Promise<void>;
}

export const LOCALES: Short[] = ['ru', 'en'];

export const SCENES: Scene[] = [
  {
    // «Переговорка»: who is in the call (header strip) and the room's chat.
    id: 'voice',
    headline: { ru: 'Голосовые комнаты', en: 'Voice rooms' },
    async run({ page, c }) {
      await phoneRoom(page, c.rooms.meeting);
      // The header strip shows who is in the call and «Присоединиться»; the room's chat is below.
      await expect(page.getByTestId('room-voice-people')).toBeVisible();
      await page.waitForTimeout(800);
      await feedBottom(page);
    },
  },
  {
    // «общий»: the morning thread.
    id: 'chat',
    headline: { ru: 'Чат команды', en: 'Team chat' },
    async run({ page, c }) {
      await phoneRoom(page, c.rooms.general);
      await page.waitForTimeout(800);
      await feedBottom(page);
    },
  },
  {
    // The room list: last messages, who is in voice.
    id: 'rooms',
    headline: { ru: 'Все комнаты рядом', en: 'All rooms in one place' },
    async run({ page }) {
      await expect(page.getByTestId('phone-room-list').getByTestId('phone-room-row').first()).toBeVisible();
      await page.waitForTimeout(400);
    },
  },
  {
    // «Доски» → «Продукт» as columns.
    id: 'tasks',
    headline: { ru: 'Задачи и доски', en: 'Tasks and boards' },
    async run({ page, c }) {
      await tab(page, 'boards');
      const nav = page.getByTestId('phone-boards');
      await nav.getByTestId('board-row').filter({ hasText: c.board.name }).getByRole('button').first().tap();
      await page.getByTestId('board-more').tap();
      await page.getByTestId('view-kanban').tap();
      const kanban = page.getByTestId('kanban');
      await expect(kanban.getByTestId('kanban-column').first()).toBeVisible();
      await kanban.evaluate((el) => {
        const cols = el.querySelectorAll('[data-testid="kanban-column"]');
        (cols[2] as HTMLElement | undefined)?.scrollIntoView({ inline: 'start', block: 'nearest' });
      });
      await page.waitForTimeout(600);
    },
  },
  {
    // Today in the calendar: the team's meetings.
    id: 'calendar',
    headline: { ru: 'Календарь встреч', en: 'Team calendar' },
    async run({ page }) {
      await tab(page, 'calendar');
      await expect(page.getByTestId('day-view')).toBeVisible();
      await page.waitForTimeout(600);
    },
  },
];

export type { Short };
