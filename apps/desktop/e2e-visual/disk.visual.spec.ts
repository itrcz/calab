import { expect, test } from './app';
import { checkpoint } from './harness';

/**
 * «Диск» on the desktop (ADR-0094 §8, docs/08 «Диск»): the root as tiles and as a list, the
 * trash, the «Доступ» dialog of a restricted folder. Fixture (e2e-support mock-server seedDisk):
 * «Команда Calab» — folders «Дизайн», «Договоры» (restricted: Борис — правка, Вера — просмотр),
 * «Проекты»; two pictures, a PDF, a table, a video with a public link, an archive; two items in
 * the trash. Projects `disk-dark-960` (all four) and `disk-light-960` (`disk-share` only);
 * run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=4313 MOCK_LIVEKIT_ROOM_PREFIX=disk_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "disk-"
 */

const ONLY_DARK = (theme: string): boolean => theme !== 'dark';

test('disk-tiles', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-disk').click();
  const tiles = win.getByTestId('disk-tile');
  await expect(tiles).toHaveCount(9);
  await expect(tiles.first()).toContainText('Дизайн');
  await expect(win.getByTestId('disk-meter')).toBeVisible();
  await checkpoint(shot, 'disk-tiles');
});

test('disk-list', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open({ prefs: { diskView: 'list' } });
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-row')).toHaveCount(9);
  // A selected row (the «⋯» shows on it).
  await win.getByTestId('disk-row').filter({ hasText: 'Отчёт за квартал.pdf' }).click();
  await checkpoint(shot, 'disk-list');
});

test('disk-trash', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-disk').click();
  await win.getByTestId('disk-more').click();
  await win.getByTestId('disk-open-trash').click();
  await expect(win.getByTestId('disk-trash-row')).toHaveCount(2);
  await expect(win.getByTestId('disk-empty-trash')).toBeVisible();
  await checkpoint(shot, 'disk-trash');
});

test('disk-share', async ({ open, win, shot }) => {
  await open();
  await win.getByTestId('section-disk').click();
  await win.getByTestId('disk-tile').filter({ hasText: 'Договоры' }).click({ button: 'right' });
  await win.getByTestId('disk-menu-access').click();
  const dialog = win.getByTestId('disk-access');
  await expect(dialog.getByTestId('disk-access-row')).toHaveCount(2);
  await expect(dialog.getByRole('switch', { name: 'Только выбранные' })).toBeChecked();
  await checkpoint(shot, 'disk-share');
});
