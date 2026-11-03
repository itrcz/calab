import { create } from '@bufbuild/protobuf';
import { DiskItemKind, FileMetaSchema } from '@calaba/protocol';
import type { Page } from '@playwright/test';
import { IDS, type MockServer } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { checkpoint, joinVoice } from './harness';

/**
 * «Открыть» of an office file (ADR-0143, docs/08 «Файлы в редакторе»): the editor in the shell's
 * content slot (the rail and the title bar stay), the opened files as tabs in the title bar's
 * strip. The Document Server is the mock itself: the real host page (infra/office) and a STUB
 * api.js that draws a fake document / sheet / slides in the layout of ONLYOFFICE
 * (e2e-support/assets/office-stub-api.js), so the screens check the Calab shell around the editor,
 * not ONLYOFFICE. The editor is on in the mock per test (`open({ office: true })`: the server's
 * GET /api/office/capabilities); the call checkpoint needs the dev LiveKit:
 *
 *   CALABA_VISUAL_MOCK_PORT=4318 MOCK_LIVEKIT_ROOM_PREFIX=office_ pnpm -F @calaba/desktop e2e:visual -g "office-"
 *
 * Projects office-dark-960 (all) and office-light-960 (the file view, the tabs, «Создать»).
 */

const WS = IDS.workspaces.main;

/** The Disk fixture plus a presentation, a legacy .doc and a sheet in the root (the mock's Disk has no events: seed after `open`, before the Disk loads). */
function seedOffice(mock: MockServer): void {
  const base = [...mock.disk.items.values()].find((i) => i.name === 'Бюджет 2026.xlsx')?.file;
  if (!base) throw new Error('no fixture xlsx');
  const put = (name: string, mime: string): void => {
    mock.disk.put({ workspaceId: WS, kind: DiskItemKind.FILE, name, ownerId: IDS.users.anna, file: { ...base, name, mime } });
  };
  put('Питч для инвесторов.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  put('Договор (старый).doc', 'application/msword');
  put('График отпусков 2026.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  // «Редактирует Вера» (DiskItem.editor_ids): the budget is open in Vera's editor.
  const budget = [...mock.disk.items.values()].find((i) => i.name === 'Бюджет 2026.xlsx');
  if (budget) budget.editorIds = [IDS.users.vera];
}

const row = (win: Page, name: string) => win.getByTestId('disk-row').filter({ hasText: name });

async function openDisk(win: Page): Promise<void> {
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-row').first()).toBeVisible();
}

test('office-entry-points', async ({ open, win, mock, shot }) => {
  await open({ office: true, prefs: { diskView: 'list' } });
  seedOffice(mock);
  await openDisk(win);
  // The Disk row menu: «Открыть» is the editor for an office file.
  await row(win, 'График отпусков 2026.xlsx').click({ button: 'right' });
  await expect(win.getByTestId('disk-menu-open')).toBeVisible();
  await checkpoint(shot, 'office-entry-disk-menu');
  await win.keyboard.press('Escape');

  // A task's attachment: the chip opens the editor (view only for a plain file).
  const meta = create(FileMetaSchema, { id: IDS.files.sheet, workspaceId: WS, name: 'График отпусков 2026.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 19n });
  const task = mock.boards.taskByKey('CAL-3');
  if (!task) throw new Error('no CAL-3');
  task.task.attachments = [meta];
  task.task.attachmentCount = 1;
  await win.getByTestId('section-boards').click();
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  await expect(win.getByTestId('task-attachment')).toBeVisible();
  await checkpoint(shot, 'office-entry-attachment');
  // «Скачать» on the chip (hover) and in its context menu: saves without opening the editor.
  const chip = win.getByTestId('task-attachment');
  // Hover reveals it (checked by the CSS); the shot is taken on keyboard focus, which the screenshot keeps (the pointer state does not survive it).
  await win.getByTestId('task-attachment-download').hover();
  await expect(win.getByTestId('task-attachment-download')).toHaveCSS('opacity', '1');
  await win.mouse.move(0, 0);
  await win.getByTestId('task-attachment-open').focus();
  await win.keyboard.press('Tab');
  await expect(win.getByTestId('task-attachment-download')).toBeFocused();
  await checkpoint(shot, 'office-entry-attachment-download');
  await chip.click({ button: 'right' });
  await expect(win.getByTestId('task-attachment-menu-download')).toBeVisible();
  await checkpoint(shot, 'office-entry-attachment-menu');
  await win.keyboard.press('Escape');
  await win.getByTestId('task-attachment-open').click();
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-mode', 'view');
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saved');
  // An attachment views only (config ?file=): «Сохранить в Диск» makes an editable copy.
  await expect(win.getByTestId('office-attachment-notice')).toBeVisible();
  await expect(win.getByTestId('office-attachment-notice').getByTestId('office-download')).toBeVisible();
  await checkpoint(shot, 'office-attachment');
  // The editor's own «Открыть расположение файла» goes back to the task; the editor is gone, the tab stays.
  await win.frameLocator('[data-testid="office-frame"]').getByTestId('stub-goback').click();
  await expect(win.getByTestId('office-view')).toHaveCount(0);
  await expect(win.getByTestId('task-attachment')).toBeVisible();
  await expect(win.getByTestId('file-tab')).toHaveCount(1);

  // A file message in chat.
  await win.getByTestId('section-chats').click();
  await win.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: 'График на подпись', attachments: [IDS.files.sheet] });
  await expect(win.getByRole('button', { name: /Открыть График отпусков 2026\.xlsx/ })).toBeVisible();
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await checkpoint(shot, 'office-entry-chat');
});

test('office-file-view', async ({ open, win, mock, shot }) => {
  await open({ office: true, prefs: { diskView: 'list' } });
  seedOffice(mock);
  await openDisk(win);
  await row(win, 'График отпусков 2026.xlsx').dblclick();
  const view = win.getByTestId('office-view');
  await expect(view).toHaveAttribute('data-state', 'saved');
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await expect(win.getByTestId('file-tab')).toHaveCount(1);
  // «Редактирует Вера» on the row being edited elsewhere is in the Disk under the view (checked in office-create).
  // A file edited in place has no bar over the editor (docs/08): «Скачать» is the editor's own.
  await expect(win.getByTestId('office-download')).toHaveCount(0);
  await checkpoint(shot, 'office-file-view');

  // In a call the island is folded into my avatar on the rail (ADR-0146): no strip under the
  // editor — the frame reaches the window's bottom; hovering the avatar opens the island over it.
  await joinVoice(win);
  await win.getByTestId('file-tab').getByRole('button').first().click();
  await expect(view).toHaveAttribute('data-state', 'saved');
  const island = win.getByTestId('bottom-island');
  await expect(island).toBeHidden();
  await expect(win.getByTestId('island-call-mark')).toBeVisible();
  await expect(win.getByTestId('office-island-spacer')).toHaveCSS('height', '0px');
  await checkpoint(shot, 'office-file-view-voice');
  await win.getByTestId('island-avatar').hover();
  await expect(island).toContainText('Голос подключён');
  await checkpoint(shot, 'office-file-view-voice-open', { keepPointer: true });
  // Leaving onto the editor (an iframe: the page gets no pointer events there) closes it too.
  await win.mouse.move(600, 300);
  await expect(island).toBeHidden();
});

test('office-create', async ({ open, win, mock, shot }) => {
  await open({ office: true, prefs: { diskView: 'list' } });
  seedOffice(mock);
  await openDisk(win);
  await expect(row(win, 'Бюджет 2026.xlsx').getByTestId('disk-editing')).toContainText('Редактирует');
  // «Создать»: Папка, then Документ, Таблица, Презентация (the editor is on and the folder is writable), then «Загрузить файлы».
  await win.getByTestId('disk-create').click();
  const menu = win.getByTestId('disk-create-menu');
  await expect(menu.getByTestId('disk-new-docx')).toBeVisible();
  await expect(menu.getByTestId('disk-new-xlsx')).toBeVisible();
  await expect(menu.getByTestId('disk-new-pptx')).toBeVisible();
  await checkpoint(shot, 'office-create-menu');
  // A blank document: created in the open folder and opened at once in the editor.
  await menu.getByTestId('disk-new-docx').click();
  const view = win.getByTestId('office-view');
  await expect(view).toHaveAttribute('data-mode', 'edit');
  await expect(view).toHaveAttribute('data-state', 'saved');
  await expect(win.getByTestId('file-tab').filter({ hasText: 'Новый документ.docx' })).toHaveAttribute('data-active', 'true');
  await checkpoint(shot, 'office-created');
  // A second one gets « (2)».
  await win.getByTestId('section-disk').click();
  await win.getByTestId('disk-create').click();
  await win.getByTestId('disk-create-menu').getByTestId('disk-new-docx').click();
  await expect(win.getByTestId('file-tab').filter({ hasText: 'Новый документ (2).docx' })).toHaveAttribute('data-active', 'true');
});

test('office-off', async ({ open, win, theme }) => {
  test.skip(theme !== 'dark', 'dark only');
  // The editor off on the server: no office items in «Создать», a sheet opens its card as before.
  await open({ prefs: { diskView: 'list' } });
  await openDisk(win);
  await win.getByTestId('disk-create').click();
  await expect(win.getByTestId('disk-new-folder')).toBeVisible();
  await expect(win.getByTestId('disk-new-docx')).toHaveCount(0);
  await win.keyboard.press('Escape');
  await row(win, 'Бюджет 2026.xlsx').dblclick();
  await expect(win.getByTestId('disk-file-card')).toBeVisible();
  await expect(win.getByTestId('office-view')).toHaveCount(0);
});

test('office-tabs', async ({ open, win, mock, shot }) => {
  await open({ office: true, prefs: { diskView: 'list' } });
  seedOffice(mock);
  mock.setOfficeFault('stuck');
  await openDisk(win);
  await row(win, 'График отпусков 2026.xlsx').dblclick();
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saved');
  // A second file: back to the Disk through the rail, open the presentation (the first one's editor saves and goes).
  await win.getByTestId('section-disk').click();
  await row(win, 'Питч для инвесторов.pptx').dblclick();
  await expect(win.getByTestId('file-tab')).toHaveCount(2);
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saved');
  // A task joins the strip.
  await win.getByTestId('section-boards').click();
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  await expect(win.getByTestId('task-tab')).toHaveCount(1);
  await expect(win.getByTestId('file-tab')).toHaveCount(2);
  await checkpoint(shot, 'office-tabs');
  // The spreadsheet: the active tab; an edit marks it unsaved (the dot).
  await win.getByTestId('file-tab').filter({ hasText: 'График отпусков' }).getByRole('button').first().click();
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saved');
  await win.frameLocator('[data-testid="office-frame"]').locator('body').click({ position: { x: 300, y: 260 } });
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saving');
  await expect(win.getByTestId('file-tab-dot')).toBeVisible();
  await checkpoint(shot, 'office-tab-unsaved');
  // Closing it asks: save and close, discard, cancel.
  await win.getByTestId('file-tab').filter({ hasText: 'График отпусков' }).getByTestId('file-tab-close').click();
  await expect(win.getByTestId('office-unsaved-save')).toBeVisible();
  await checkpoint(shot, 'office-unsaved-confirm');
  await win.getByTestId('office-unsaved-cancel').click();
  await expect(win.getByTestId('office-view')).toBeVisible();
  // Discard: the tab goes, the other file stays.
  await win.getByTestId('file-tab').filter({ hasText: 'График отпусков' }).getByTestId('file-tab-close').click();
  await win.getByTestId('office-unsaved-discard').click();
  await expect(win.getByTestId('file-tab')).toHaveCount(1);
});

test('office-error', async ({ open, win, mock, shot, theme }) => {
  test.skip(theme !== 'dark', 'dark only');
  await open({ office: true, prefs: { diskView: 'list' } });
  seedOffice(mock);
  mock.setOfficeFault('token');
  await openDisk(win);
  await row(win, 'График отпусков 2026.xlsx').dblclick();
  await expect(win.getByTestId('office-error')).toBeVisible();
  await checkpoint(shot, 'office-error');
  // «Повторить» fetches a fresh config and opens again.
  mock.setOfficeFault('');
  await win.getByTestId('office-retry').click();
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saved');
});

test('office-legacy-doc', async ({ open, win, mock, shot, theme }) => {
  test.skip(theme !== 'dark', 'dark only');
  await open({ office: true, prefs: { diskView: 'list' } });
  seedOffice(mock);
  await openDisk(win);
  await row(win, 'Договор (старый).doc').dblclick();
  await expect(win.getByTestId('office-convert-notice')).toContainText('.docx');
  await expect(win.getByTestId('office-view')).toHaveAttribute('data-state', 'saved');
  await checkpoint(shot, 'office-legacy-doc');
  await win.getByTestId('office-save-as').click();
  await expect(win.getByTestId('file-tab')).toHaveCount(2);
  await expect(win.getByTestId('file-tab').filter({ hasText: 'Договор (старый).docx' })).toHaveAttribute('data-active', 'true');
});
