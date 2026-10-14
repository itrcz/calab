import { expect, test } from './app';
import { checkpoint } from './harness';

/**
 * «Вики» on the desktop (ADR-0096 §9, docs/08 «Вики: раздел»): the page with its cover, icon,
 * document (live through the mock sync socket) and subpages; the trash in the tree column; the
 * «Поделиться» dialog. Fixture (e2e-support mock-server seedWiki): «Команда Calab» —
 * «Справочник команды» (cover, 📘, headings, checklist, quote, code, table; «Онбординг»,
 * «Процессы», «Глоссарий» inside), «Встречи», «Черновики» (restricted, Борис — правка); two pages
 * in the trash. Projects `wiki-dark-960` (all three) and `wiki-light-960` (`wiki-page` only);
 * run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=4319 MOCK_LIVEKIT_ROOM_PREFIX=wiki_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "wiki-"
 */

const ONLY_DARK = (theme: string): boolean => theme !== 'dark';

test('wiki-page', async ({ open, win, shot }) => {
  await open();
  await win.getByTestId('section-wiki').click();
  await expect(win.getByTestId('wiki-node').first()).toContainText('Справочник команды');
  await expect(win.getByTestId('wiki-title')).toHaveValue('Справочник команды');
  // The document came through the sync socket (the seeded snapshot).
  await expect(win.locator('.wiki-prose')).toContainText('Первая неделя');
  await expect(win.getByTestId('wiki-subpage')).toHaveCount(3);
  // One node expanded so the tree shows depth.
  await win.getByTestId('wiki-node').filter({ hasText: 'Справочник команды' }).getByTestId('wiki-node-toggle').click();
  await expect(win.getByTestId('wiki-node')).toHaveCount(6);
  await win.mouse.move(5, 5);
  await checkpoint(shot, 'wiki-page');
});

test('wiki-tree-trash', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-wiki').click();
  await win.getByTestId('wiki-open-trash').click();
  await expect(win.getByTestId('wiki-trash-row')).toHaveCount(2);
  await win.getByTestId('wiki-trash-row').first().click();
  await expect(win.getByTestId('wiki-trashed')).toBeVisible();
  await checkpoint(shot, 'wiki-tree-trash');
});

test('wiki-share', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-wiki').click();
  await win.getByTestId('wiki-node').filter({ hasText: 'Черновики' }).click();
  await expect(win.getByTestId('wiki-title')).toHaveValue('Черновики');
  await win.getByTestId('wiki-share').click();
  const dialog = win.getByTestId('wiki-share-dialog');
  await expect(dialog.getByTestId('wiki-access-row')).toHaveCount(1);
  await expect(dialog.getByRole('switch', { name: 'Только выбранные' })).toBeChecked();
  // Leaving a page never renames it (the title field saves only typed text).
  await expect(win.getByTestId('wiki-node').first()).toContainText('Справочник команды');
  await checkpoint(shot, 'wiki-share');
});

test('wiki-versions', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-wiki').click();
  await expect(win.locator('.wiki-prose')).toContainText('Первая неделя');
  await win.getByTestId('wiki-more').click();
  await win.getByTestId('wiki-open-versions').click();
  // The older version differs most: it is the one to compare.
  await win.getByTestId('wiki-version-row').nth(1).click();
  // Both columns share one block layout; changed blocks carry the accent bar and word marks.
  await expect(win.getByTestId('wiki-version-before').locator('[data-changed]').first()).toBeVisible();
  await expect(win.getByTestId('wiki-version-after').locator('ins').first()).toBeVisible();
  await checkpoint(shot, 'wiki-versions');
  await win.getByRole('switch', { name: 'Только изменения' }).click();
  await expect(win.getByTestId('wiki-version-after').locator('[data-changed]').first()).toBeVisible();
  await checkpoint(shot, 'wiki-versions-changes');
});
