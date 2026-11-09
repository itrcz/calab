import { expect, test } from './app';
import { IDS, MOCK_UPLOAD_RATE_LIMITED } from '../e2e-support/mock-server';
import { checkpoint, expectToolbarHeights, joinVoice } from './harness';

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
  await expectToolbarHeights(win.getByTestId('disk-bar'), 'disk toolbar');
  await checkpoint(shot, 'disk-tiles');
});

/**
 * ADR-0146: outside «Команда» the bottom island is folded into my avatar on the rail; hovering it
 * opens the full island over the Disk, its avatar on the same pixels; in a call the avatar carries
 * the call mark (green speaker, red crossed mic when muted). Dark and light (collapsed + open);
 * the call in dark only.
 */
test('disk-island', async ({ open, win, shot, theme }) => {
  await open();
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-tile')).toHaveCount(9);
  const avatar = win.getByTestId('island-avatar');
  const island = win.getByTestId('bottom-island');
  await expect(avatar).toBeVisible();
  await expect(island).toBeHidden();
  // Nothing reserved for the island: the Disk's own bottom padding only.
  expect(await win.getByTestId('disk').evaluate((el) => getComputedStyle(el).getPropertyValue('--island-height'))).toBe('');
  const folded = await avatar.boundingBox();
  await checkpoint(shot, 'disk-island');

  // Hover: the full island over the content, its avatar exactly where the folded one is.
  await avatar.hover();
  await expect(island).toBeVisible();
  await expect(avatar).toHaveAttribute('aria-expanded', 'true');
  const inner = await island.locator('[data-presence]').first().locator('..').boundingBox();
  expect(inner && folded && Math.abs(inner.x - folded.x) < 0.5 && Math.abs(inner.y - folded.y) < 0.5).toBe(true);
  await checkpoint(shot, 'disk-island-open', { keepPointer: true });
  // Leaving closes it (after the grace).
  await win.mouse.move(600, 300);
  await expect(island).toBeHidden();

  // Keyboard: Enter opens, Esc closes and keeps focus on the avatar.
  await avatar.focus();
  await win.keyboard.press('Enter');
  await expect(island).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(island).toBeHidden();
  await expect(avatar).toBeFocused();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (theme !== 'dark') return;

  // In a call: the folded avatar carries the call mark; muted — the red crossed mic.
  await joinVoice(win);
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-tile')).toHaveCount(9);
  const mark = win.getByTestId('island-call-mark');
  await expect(mark).toBeVisible();
  await expect(mark).not.toHaveAttribute('data-muted');
  await checkpoint(shot, 'disk-island-voice');
  await avatar.hover();
  await expect(island).toContainText('Голос подключён');
  await island.getByRole('button', { name: /^Выключить микрофон/ }).click();
  await expect(island.getByRole('button', { name: /^Включить микрофон/ })).toBeVisible();
  await checkpoint(shot, 'disk-island-voice-open', { keepPointer: true });
  await win.mouse.move(600, 300);
  await expect(island).toBeHidden();
  await expect(mark).toHaveAttribute('data-muted', 'true');
  await checkpoint(shot, 'disk-island-voice-muted');
});

test('disk-list', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open({ prefs: { diskView: 'list' } });
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-row')).toHaveCount(9);
  // A selected row (the «⋯» shows on it).
  await win.getByTestId('disk-row').filter({ hasText: 'Отчёт за квартал.pdf' }).click();
  await checkpoint(shot, 'disk-list');
  // CBF-22: type plates in «Проекты / Q4» and the previews (Space = Quick Look, ←/→ among the viewable files).
  await win.getByTestId('disk-row').filter({ hasText: 'Проекты' }).dblclick();
  await win.getByTestId('disk-row').filter({ hasText: 'Q4' }).dblclick();
  await expect(win.getByTestId('disk-row')).toHaveCount(4);
  await checkpoint(shot, 'disk-type-icons');
  await win.getByTestId('disk-row').filter({ hasText: 'План релиза.md' }).click();
  await win.keyboard.press('Space');
  await expect(win.getByTestId('disk-view-markdown')).toBeVisible();
  await checkpoint(shot, 'disk-preview-markdown');
  await win.keyboard.press('ArrowRight');
  await expect(win.getByTestId('disk-viewer')).toHaveAttribute('data-kind', /./);
  await win.keyboard.press('ArrowLeft');
  await expect(win.getByTestId('disk-view-markdown')).toBeVisible();
  await win.keyboard.press('Space');
  await expect(win.getByTestId('disk-viewer')).toHaveCount(0);
  await win.getByTestId('disk-row').filter({ hasText: 'Выгрузка продаж.csv' }).click();
  await expect(win.getByTestId('disk-row').filter({ hasText: 'Выгрузка продаж.csv' })).toHaveAttribute('data-selected', 'true');
  await win.keyboard.press('Space');
  await expect(win.getByTestId('disk-view-csv')).toBeVisible();
  await checkpoint(shot, 'disk-preview-csv');
  await win.keyboard.press('Escape');
  await win.getByTestId('disk-row').filter({ hasText: 'Подкаст' }).click();
  await win.keyboard.press('Space');
  await expect(win.getByTestId('audio-player')).toBeVisible();
  await checkpoint(shot, 'disk-preview-audio');
  await win.keyboard.press('Escape');
  await win.getByTestId('disk-crumb').filter({ hasText: 'Диск' }).first().click();
  await expect(win.getByTestId('disk-row')).toHaveCount(9);
  // CBF-21: «Колонки» — the root column, a folder opens the next one, a file adds the card column.
  await win.getByTestId('disk-view').getByRole('radio', { name: 'Колонки' }).click();
  await expect(win.getByTestId('disk-column')).toHaveCount(1);
  await win.getByTestId('disk-col-row').filter({ hasText: 'Проекты' }).click();
  await expect(win.getByTestId('disk-column')).toHaveCount(2);
  await win.keyboard.press('ArrowRight');
  await expect(win.getByTestId('disk-column')).toHaveCount(3);
  await checkpoint(shot, 'disk-columns');
  await win.getByTestId('disk-col-row').filter({ hasText: 'Отчёт за квартал.pdf' }).click();
  await expect(win.getByTestId('disk-col-preview')).toBeVisible();
  await expect(win.getByTestId('disk-column')).toHaveCount(1);
  await checkpoint(shot, 'disk-columns-card');
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
  // CBF-161: the third level «Управление» (people only) — Борис manages, Дина is added with «Правка».
  const level = (name: string) => dialog.getByTestId('disk-access-row').filter({ hasText: name }).getByTestId('disk-access-level');
  await expect(level('Борис').locator('option')).toHaveText(['Просмотр', 'Правка', 'Управление', 'Нет доступа']);
  await level('Борис').selectOption('manage');
  await dialog.getByTestId('disk-access-add').click();
  await win.getByTestId('disk-access-picker').getByTestId('picker-option').filter({ hasText: 'Дина' }).click();
  await expect(dialog.getByTestId('disk-access-row')).toHaveCount(3);
  await level('Дина').selectOption('edit');
  await checkpoint(shot, 'disk-share-levels');
  // CBF-20: a file without a viewer opens its card (no download), «Отправить в чат» opens the picker.
  await win.keyboard.press('Escape');
  await win.getByTestId('disk-tile').filter({ hasText: 'Бюджет 2026.xlsx' }).click({ button: 'right' });
  await win.getByTestId('disk-menu-open').click();
  await expect(win.getByTestId('disk-file-card')).toBeVisible();
  await checkpoint(shot, 'disk-file-card');
  await win.getByTestId('disk-card-send').click();
  await expect(win.getByTestId('forward-dialog')).toBeVisible();
  await checkpoint(shot, 'disk-send-to-chat');
  // CBF-66: a folder has «Копировать ссылку» in its menu and goes to a chat as its own card.
  await win.keyboard.press('Escape');
  await win.getByTestId('disk-tile').filter({ hasText: 'Проекты' }).click({ button: 'right' });
  await expect(win.getByTestId('disk-menu-copy-link')).toBeVisible();
  await win.getByTestId('disk-menu-send').click();
  await expect(win.getByTestId('forward-dialog')).toBeVisible();
  await win.getByRole('option', { name: /#разработка/ }).click();
  await win.getByTestId('forward-send').click();
  await win.getByRole('button', { name: 'Открыть' }).first().click();
  const card = win.getByTestId('disk-folder-card').last();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('disk-folder-card-name')).toHaveText('Проекты');
  await expect(card.getByTestId('disk-folder-card-summary')).toContainText('папка');
  await checkpoint(shot, 'disk-folder-card');
});

/**
 * The upload rows (ADR-0155): a file held by the upload rate limit waits («Ждёт лимита загрузок»,
 * Retry-After 600 s in the mock), a file over the workspace's limit (1 MB here) names the limit.
 */
test('disk-uploads', async ({ open, win, mock, shot }) => {
  await open();
  mock.state.uploadLimits.set(IDS.workspaces.main, { maxFileMb: 1 });
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-tile')).toHaveCount(9);
  await win.getByTestId('disk-file-input').setInputFiles([
    { name: `${MOCK_UPLOAD_RATE_LIMITED}-Смета.xlsx`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024, 1) },
    { name: 'Видео с презентации.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2 * 1024 * 1024, 1) },
  ]);
  const rows = win.getByTestId('disk-upload-row');
  await expect(rows).toHaveCount(2);
  await expect(win.getByTestId('disk-upload-waiting')).toHaveText('Ждёт лимита загрузок…');
  await expect(rows.nth(1)).toContainText(/Больше лимита 1[,.]0+ МБ на файл/);
  await checkpoint(shot, 'disk-uploads');
});
