import { expect } from '@playwright/test';
import type { Short } from '../copy';
import { cameraPhoto } from '../photos';
import { IDS } from '../../e2e-support/mock-server';
import { feedBottom, inRoom, phoneRoom, startPublisher, tab, type Ctx } from './harness';

/**
 * The store scenes, in store order. Adding a screen = adding an entry here (the capture spec and the
 * compose step read only this list): `id` names the file (`NN-<id>.png`), `headline` and `subtitle` are the card's two
 * lines per language, `run` brings the signed-in phone (a fresh render on the room list, dark, in the
 * scene's language) to the screen; the shot is taken right after it.
 */
export interface Scene {
  id: string;
  /** The scene joins a voice call: captured in its own session (store-shots.spec.ts). */
  live?: boolean;
  headline: Record<'ru' | 'en', string>;
  /** One line under the headline. */
  subtitle: Record<'ru' | 'en', string>;
  run(ctx: Ctx): Promise<void>;
}

export const LOCALES: Short[] = ['ru', 'en'];

export const SCENES: Scene[] = [
  {
    // «Переговорка» live: I am in the call; Борис and Григорий on camera (real LiveKit tracks), Вера and Дина as
    // avatar tiles, Борис speaking (green ring), the call strip (mute, camera, hang up) above the tab bar.
    id: 'voice',
    live: true,
    headline: { ru: 'Голосовые комнаты', en: 'Voice rooms' },
    subtitle: {
      ru: 'Заходите в разговор одним касанием',
      en: 'Jump into a conversation in one tap',
    },
    async run(ctx) {
      const { page, mock, c } = ctx;
      for (const k of ['boris', 'grigory'] as const) {
        ctx.pubs.push(
          await startPublisher({
            userId: IDS.users[k],
            name: c.people[k].name,
            roomId: IDS.rooms.meeting,
            source: 'camera',
            image: cameraPhoto(k),
          }),
        );
        inRoom(mock, k, { camera: true, muted: k === 'grigory' });
      }
      await phoneRoom(page, c.rooms.meeting);
      await page.getByTestId('room-voice-join').tap();
      const strip = page.getByTestId('mobile-voice-strip');
      await expect(strip).toBeVisible({ timeout: 30_000 });
      // The remote camera opens the picture-in-picture; expand it to the gallery.
      const pip = page.getByTestId('camera-pip');
      await expect(pip).toBeVisible({ timeout: 30_000 });
      await pip
        .getByRole('button', { name: /Развернуть видео|Expand video/ })
        .first()
        .tap();
      await expect(page.getByTestId('video-grid')).toBeVisible();
      await expect
        .poll(() => page.locator('video').evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth > 0).length), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2);
      // Борис speaks: a steady tone from his microphone, so LiveKit's active-speaker detection lights his tile.
      ctx.pubs.push(
        await startPublisher({
          userId: IDS.users.boris,
          name: c.people.boris.name,
          roomId: IDS.rooms.meeting,
          source: 'microphone',
        }),
      );
      await expect(page.locator('[data-testid="video-tile"] span[class*="ring-[var(--color-green)]"]').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    // «общий»: the morning thread.
    id: 'chat',
    headline: { ru: 'Чат команды', en: 'Team chat' },
    subtitle: {
      ru: 'Обсуждайте работу, не теряя нить',
      en: 'Talk work through without losing the thread',
    },
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
    subtitle: {
      ru: 'Видно, где идёт разговор и кто в голосе',
      en: 'See where the talk is and who is on voice',
    },
    async run({ page }) {
      await expect(page.getByTestId('phone-room-list').getByTestId('phone-room-row').first()).toBeVisible();
      await page.waitForTimeout(400);
    },
  },
  {
    // «Доски» → «Продукт» as columns: the «В работе» column in focus.
    id: 'tasks',
    headline: { ru: 'Задачи и доски', en: 'Tasks and boards' },
    subtitle: {
      ru: 'Карточки, сроки и исполнители под рукой',
      en: 'Cards, due dates and assignees at hand',
    },
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
        (cols[2] as HTMLElement | undefined)?.scrollIntoView({
          inline: 'start',
          block: 'nearest',
        });
      });
      // One tidy column: the search / filter row (a horizontal scroller whose chips do not fit 390 pt) is left out of the shot,
      // and the neighbouring columns are not painted, so no card is cut at the edge.
      await page.addStyleTag({
        content:
          '[data-testid="filter-row"]{display:none!important}[data-testid="kanban-column"]:not([data-focus-shot]){visibility:hidden}[data-focus-shot]{width:calc(100vw - 32px)!important;min-width:0!important}',
      });
      await kanban.evaluate((el) => {
        const col = el.querySelectorAll('[data-testid="kanban-column"]')[2] as HTMLElement | undefined;
        col?.setAttribute('data-focus-shot', '');
      });
      await page.waitForTimeout(600);
    },
  },
  {
    // Today in the calendar: the team's meetings.
    id: 'calendar',
    headline: { ru: 'Календарь встреч', en: 'Team calendar' },
    subtitle: {
      ru: 'Встреча начинается в одно касание',
      en: 'A meeting starts in one tap',
    },
    async run({ page }) {
      await tab(page, 'calendar');
      await expect(page.getByTestId('day-view')).toBeVisible();
      await page.waitForTimeout(600);
    },
  },
];

export type { Short };
