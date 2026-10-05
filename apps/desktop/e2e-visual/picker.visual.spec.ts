import { expect, test } from './app';
import { checkpoint, settle } from './harness';

/**
 * The member picker (docs/08 «Выбор участника», docs/09 #33) in room settings → «Права»:
 * «Добавить роль или участника…» lists the roles (owner and admin fixed, «полный доступ») and
 * every member of the workspace with avatars; a query narrows it. Project `picker-dark-960`
 * (playwright.visual.config.ts); run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=41570 MOCK_LIVEKIT_ROOM_PREFIX=pick_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "room-permissions-picker"
 */

test('room-permissions-picker', async ({ open, win, shot }) => {
  await open();
  await win.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(win.getByRole('heading', { name: 'общий' })).toBeVisible();
  await win.getByRole('button', { name: 'Настройки комнаты' }).first().click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Права' }).click();
  await expect(dialog.getByTestId('perm-fixed-role')).toHaveCount(2);
  await dialog.getByTestId('perm-add').click();

  const picker = win.getByTestId('member-picker');
  await expect(picker).toBeVisible();
  // The whole workspace (fixture: Анна owner, Борис admin, Вера, Григорий, Дина guest) + 6 roles
  // (4 built-in, «Дизайн», «Модератор»; ADR-0026).
  await expect(picker.getByTestId('picker-option')).toHaveCount(11);
  await expect(picker.getByRole('option', { name: /Анна/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(picker.getByRole('option', { name: /Борис/ })).toHaveAttribute('aria-disabled', 'true');
  const field = picker.getByRole('combobox');
  await expect(field).toBeFocused();
  // Keyboard: the first choosable row is @Дизайн (owner / admin rows are skipped).
  await expect(picker.getByRole('option', { selected: true })).toContainText('Дизайн');
  await settle(win);
  await checkpoint(shot, 'room-permissions-picker');

  // Search is case-insensitive and debounced; Enter adds the match to the targets.
  await field.fill('ВЕР');
  await expect(picker.getByTestId('picker-option')).toHaveCount(1);
  await field.press('Enter');
  await expect(picker).toBeHidden();
  await expect(dialog.getByTestId('perm-targets').locator('button[aria-pressed]', { hasText: 'Вера' })).toHaveAttribute('aria-pressed', 'true');

  // Nothing found → the empty state.
  await dialog.getByTestId('perm-add').click();
  await win.getByTestId('member-picker').getByRole('combobox').fill('zzz');
  await expect(win.getByTestId('member-picker').getByTestId('picker-empty')).toHaveText('Никого не найдено');
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('member-picker')).toBeHidden();
});
