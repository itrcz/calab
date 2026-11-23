import { create } from '@bufbuild/protobuf';
import { CANVAS_BITS, CanvasPermissionEntrySchema, PermissionTargetType, Plan } from '@calaba/protocol';
import type { Page } from '@playwright/test';
import { IDS } from '../e2e-support/fixtures';
import { expect, test } from './app';
import { checkpoint, joinVoice } from './harness';

/**
 * «Холст» on the desktop (ADR-0126 §5, docs/08 «Холст»): one test, one `checkpoint` per state —
 * the empty section, the tree + an open canvas (stickies, shapes, connectors, a text), a selected
 * object with its properties panel, «только просмотр», the history dialog, the «Доступ» dialog and
 * the trash. Fixture (e2e-support/mock-server seedCanvas): «Команда Calab» — «Продукт» (→ «Дорожная
 * карта Q1», «Ретро-доска»), «Дизайн» (→ «Схема навигации»), «Планирование спринта», «Черновики»
 * (restricted); in the trash «Старая схема» and the folder «Архив». The read-only canvas is added by
 * the test («Протокол встречи», Борис's, Анна has «Просмотр» only); so are a scripted co-author on the
 * roadmap (`canvas-peers`), an empty canvas with the templates card (`canvas-blank`) and a live public link
 * (`canvas-link`). Projects `canvas-dark-960` (everything) and `canvas-light-960` (the open canvas, the
 * selection and the «Доступ» dialog). The phone's section and the public page `/c/{code}` are in
 * mobile.visual.spec.ts and web.spec.ts.
 *
 *   CALABA_VISUAL_WORKERS=1 CALABA_VISUAL_MOCK_PORT=4750 MOCK_LIVEKIT_ROOM_PREFIX=canvas_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "canvas"
 */

/** The first sticky of «Дорожная карта Q1» is at world (0,0); the objects span x 0…600, y −80…340. */
const FIT = { cx: 300, cy: 130, w: 600, h: 420 } as const;

/** The screen point of a world point right after «Показать всё» (scale ≤ 1, padding 48, the box centred). */
async function atWorld(win: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await win.getByTestId('canvas-surface').boundingBox();
  if (!box) throw new Error('no canvas surface');
  const s = Math.min(1, (box.width - 96) / FIT.w, (box.height - 96) / FIT.h);
  return { x: box.x + box.width / 2 + (x - FIT.cx) * s, y: box.y + box.height / 2 + (y - FIT.cy) * s };
}

/** Fits the content and waits for the camera animation and the first frame. */
async function fitted(win: Page): Promise<void> {
  await expect(win.getByTestId('canvas-surface')).toBeVisible();
  await win.getByTestId('canvas-fit-all').click();
  await win.waitForTimeout(900);
}

async function openRoadmap(win: Page): Promise<void> {
  await win.getByTestId('section-canvas').click();
  await expect(win.getByTestId('canvas-node').first()).toBeVisible();
  const product = win.getByTestId('canvas-node').filter({ hasText: 'Продукт' });
  await product.getByTestId('canvas-node-toggle').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Дорожная карта Q1' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Дорожная карта Q1');
  // The sync socket delivered the seeded document and left «Подключение…» behind.
  await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
  await fitted(win);
}

test('canvas-screen', async ({ open, win, mock, shot, theme }) => {
  if (theme === 'dark') {
    // 1. An empty section: no canvas open, nothing in the tree.
    await open();
    mock.canvas.items.clear();
    await win.getByTestId('section-canvas').click();
    await expect(win.getByTestId('canvas-empty')).toBeVisible();
    await checkpoint(shot, 'canvas-empty');
  }

  // 2. The tree and an open canvas: stickies, a shape, a text, three connectors (dark and light).
  await open();
  await openRoadmap(win);
  await expect(win.getByTestId('canvas-node')).toHaveCount(6);
  await expect(win.getByTestId('canvas-toolbar')).toBeVisible();
  await checkpoint(shot, 'canvas-tree');

  // 2a. The open canvas's row is filled; the pointer on its neighbour fills the same box (dark and light).
  await win.getByTestId('canvas-node').filter({ hasText: 'Ретро-доска' }).hover();
  await win.waitForTimeout(150);
  await checkpoint(shot, 'canvas-tree-hover');
  await win.mouse.move(700, 300);

  // 2b. The folded list: «show» at the left of the header, the canvas takes the width (dark and light).
  await win.getByTestId('canvas-tree-toggle').click();
  await expect(win.getByTestId('canvas-column')).toHaveCount(0);
  await expect(win.getByTestId('canvas-tree-toggle')).toBeVisible();
  // ADR-0146: outside «Команда» the island is folded into my avatar on the rail, the tree folded or not.
  await expect(win.getByTestId('bottom-island')).toBeHidden();
  await expect(win.getByTestId('island-avatar')).toBeVisible();
  await win.waitForTimeout(150);
  await checkpoint(shot, 'canvas-tree-collapsed');
  await win.getByTestId('canvas-tree-toggle').click();
  await expect(win.getByTestId('canvas-column')).toBeVisible();

  // 3. A selected sticky and its properties panel (dark and light).
  const p = await atWorld(win, 300, 80);
  await win.mouse.click(p.x, p.y);
  await expect(win.getByTestId('canvas-props')).toBeVisible();
  // A screen reader hears what got selected (the canvas is one <canvas>).
  await expect(win.getByTestId('canvas-announce')).toHaveText('Стикер: Раздел «Холст»');
  await win.waitForTimeout(300);
  await checkpoint(shot, 'canvas-selected');

  if (theme === 'dark') {
    // 3a. Two people on the canvas: Борис's cursor and selection, his avatar in «кто на холсте».
    const road = [...mock.canvas.items.values()].find((i) => i.name === 'Дорожная карта Q1');
    if (!road) throw new Error('no roadmap');
    const blue = mock.canvas.objects(road.id).find((o) => o.text === 'Телефон: просмотр');
    mock.canvas.peer(road.id, 424242, { user: { id: IDS.users.boris, name: 'Борис Петров', color: '#e5484d' }, canvas: { cursor: { x: 560, y: 150 }, selection: blue ? [blue.id] : [] } });
    await expect(win.getByTestId('canvas-presence-user')).toHaveCount(1);
    await win.waitForTimeout(300);
    await checkpoint(shot, 'canvas-peers');
    mock.canvas.peer(road.id, 424242, null);

    // 3b. A new, empty canvas: the templates card in the middle.
    await open();
    mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Новый холст', ownerId: IDS.users.anna });
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-node').filter({ hasText: 'Новый холст' }).getByTestId('canvas-node-open').click();
    await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
    await expect(win.getByTestId('canvas-templates-card')).toBeVisible();
    await checkpoint(shot, 'canvas-blank');

    // 4. «Только просмотр»: a canvas of someone else's private folder with «Просмотр» only.
    await open();
    const anna = IDS.users.anna;
    const boris = IDS.users.boris;
    const minutes = mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Протокол встречи', ownerId: boris, restricted: true }, (d) => {
      d.create({ kind: 'sticky', x: 0, y: 0, color: 'blue', text: 'Решения' });
      d.create({ kind: 'sticky', x: 220, y: 0, color: 'yellow', text: 'Вопросы' });
      d.create({ kind: 'shape', shape: 'rounded', x: 110, y: 220, text: 'Итог' });
    });
    mock.canvas.perms.set(minutes.id, [create(CanvasPermissionEntrySchema, { targetType: PermissionTargetType.USER, targetId: anna, allow: CANVAS_BITS.VIEW })]);
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-node').filter({ hasText: 'Протокол встречи' }).getByTestId('canvas-node-open').click();
    await expect(win.getByTestId('canvas-view-only')).toBeVisible();
    await expect(win.getByTestId('canvas-toolbar')).toHaveCount(0);
    await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
    await win.getByTestId('canvas-fit-all').click();
    await win.waitForTimeout(900);
    await checkpoint(shot, 'canvas-view-only');

    // 5. The history: «Восстановить» is live (the open canvas registered its document).
    await open();
    await openRoadmap(win);
    await win.getByTestId('canvas-more').click();
    await win.getByTestId('canvas-menu-versions').click();
    await expect(win.getByTestId('canvas-version-row')).toHaveCount(2);
    await win.getByTestId('canvas-version-row').first().click();
    await expect(win.getByTestId('canvas-version-restore')).toBeEnabled();
    await checkpoint(shot, 'canvas-versions');
  }

  // 5a. The palette: a sticky in every colour and a shape in every hue (dark and light).
  await open();
  const swatches = [
    'yellow', 'amber', 'orange', 'coral', 'red', 'crimson', 'pink', 'magenta', 'violet', 'purple', 'lavender', 'indigo', 'cobalt',
    'blue', 'sky', 'cyan', 'teal', 'mint', 'green', 'emerald', 'lime', 'brown', 'gray', 'slate', 'black',
  ];
  const hues = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'magenta', 'pink', 'brown', 'gray'];
  mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Палитра', ownerId: IDS.users.anna }, (d) => {
    swatches.forEach((color, i) => d.create({ kind: 'sticky', x: (i % 9) * 150, y: Math.floor(i / 9) * 150, color, text: color }));
    hues.forEach((hue, i) => d.create({ kind: 'shape', shape: 'rounded', x: (i % 7) * 190, y: 470 + Math.floor(i / 7) * 120, w: 160, h: 90, fill: 'none', stroke: hue, text: hue }));
  });
  await win.getByTestId('section-canvas').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Палитра' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Палитра');
  await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
  await win.getByTestId('canvas-tree-toggle').click();
  await win.getByTestId('canvas-fit-all').click();
  await win.waitForTimeout(900);
  await checkpoint(shot, 'canvas-palette');

  // 5b. Connector routes: straight, elbow and curved between pairs of shapes, with arrows and labels (dark and light).
  await open();
  const routes = ['straight', 'elbow', 'curve'] as const;
  const routeText = { straight: 'прямой', elbow: 'ломаный', curve: 'плавный' } as const;
  mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Связи', ownerId: IDS.users.anna }, (d) => {
    routes.forEach((route, i) => {
      const a = d.create({ kind: 'shape', shape: 'rounded', x: 0, y: i * 170, w: 140, h: 80, fill: 'blue', text: `A${i + 1}` });
      const b = d.create({ kind: 'shape', shape: 'rounded', x: 460, y: i * 170 + 70, w: 140, h: 80, fill: 'green', text: `B${i + 1}` });
      d.create({ kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' }, route, arrow: 'end', label: routeText[route] });
    });
  });
  await win.getByTestId('section-canvas').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Связи' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Связи');
  await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
  await win.getByTestId('canvas-fit-all').click();
  await win.waitForTimeout(900);
  await checkpoint(shot, 'canvas-connectors');

  if (theme === 'dark') {
    // 5c. The connector tool's route menu: three routes with their icons.
    // A tool's variants open from the tool itself (Miro-style flyouts).
    await win.getByTestId('canvas-tool-connector').click();
    await expect(win.getByTestId('canvas-route-menu')).toBeVisible();
    await checkpoint(shot, 'canvas-route-menu');
    await win.keyboard.press('Escape');

    // 5d. A sticker from the workspace's pack placed on the board (the chat's sticker panel, K), selected.
    await win.getByTestId('canvas-tool-sticker').click();
    const panel = win.getByTestId('canvas-sticker-panel');
    await expect(panel.getByRole('button', { name: 'Стикер 💎' })).toBeVisible();
    await checkpoint(shot, 'canvas-sticker-panel');
    await panel.getByRole('button', { name: 'Стикер 💎' }).click();
    await expect(panel).toHaveCount(0);
    await expect(win.getByTestId('canvas-announce')).toHaveText('Стикер-картинка');
    await win.waitForTimeout(600);
    await checkpoint(shot, 'canvas-sticker');
  }

  // 5e. Links (owner 23.11): an underlined linked text and sticky; the selected sticky's panel shows where a click leads
  // («↗ figma.com») and «Убрать ссылку» (dark and light). The ⌘-hover pill is covered by unit tests: the test driver
  // sends a pointerleave right after a hover, so it cannot be screenshotted here.
  await open();
  mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Ссылки', ownerId: IDS.users.anna }, (d) => {
    d.create({ kind: 'text', x: 0, y: 0, w: 320, text: 'https://example.com/roadmap/q1', link: 'https://example.com/roadmap/q1' });
    d.create({ kind: 'sticky', x: 380, y: -40, color: 'blue', text: 'Макеты в Figma', link: 'https://www.figma.com/file/calab-canvas-links' });
    d.create({ kind: 'sticky', x: 380, y: 160, color: 'yellow', text: 'Без ссылки' });
  });
  await win.getByTestId('section-canvas').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Ссылки' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Ссылки');
  await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
  await win.getByTestId('canvas-fit-all').click();
  await win.waitForTimeout(900);
  const surface = await win.getByTestId('canvas-surface').boundingBox();
  if (!surface) throw new Error('no canvas surface');
  // Objects span x 0…540, y −40…320; «Показать всё» centres them at scale ≤ 1 with 48 px padding (as `atWorld`).
  const fit = Math.min(1, (surface.width - 96) / 540, (surface.height - 96) / 360);
  const linkAt = { x: surface.x + surface.width / 2 + (460 - 270) * fit, y: surface.y + surface.height / 2 + (40 - 140) * fit };
  await win.mouse.click(linkAt.x, linkAt.y);
  await expect(win.getByTestId('canvas-prop-open-link')).toBeVisible();
  await expect(win.getByTestId('canvas-prop-remove-link')).toBeVisible();
  await expect(win.getByTestId('canvas-prop-open-link')).toHaveText('figma.com');
  await win.mouse.move(linkAt.x + 4, linkAt.y + 4);
  await win.waitForTimeout(300);
  await checkpoint(shot, 'canvas-links', { keepPointer: true });

  // 6. «Доступ» (dark and light).
  await open();
  await win.getByTestId('section-canvas').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Черновики' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Черновики');
  await win.getByTestId('canvas-share').click();
  const dialog = win.getByTestId('canvas-share-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Только выбранные' })).toBeChecked();
  await checkpoint(shot, 'canvas-share');
  // A private canvas has no link: the switch is off and says why.
  await win.getByTestId('canvas-share-tabs').getByRole('radio', { name: 'Ссылка' }).click();
  await expect(dialog.getByTestId('canvas-link-private')).toBeVisible();

  // 6b. «Отправить в чат» (owner 23.10): from the «⋯» menu, the share dialog gives way to the chat picker;
  // the card of the sent link in the feed (dark and light), and the card of a canvas that is not mine to see.
  await win.getByTestId('canvas-share-send').click();
  await expect(win.getByTestId('forward-dialog')).toBeVisible();
  await checkpoint(shot, 'canvas-send');
  await win.keyboard.press('Escape');
  const board = [...mock.canvas.items.values()].find((i) => i.name === 'Дорожная карта Q1');
  expect(board).toBeTruthy();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: `Посмотрите доску ${mock.url}/canvas/${board?.id ?? ''}` });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: `А эта удалена ${mock.url}/canvas/00000000-0000-4000-8000-00000000dead` });
  await win.getByTestId('section-chats').click();
  await win.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(win.getByTestId('canvas-link-card').first()).toHaveAttribute('data-state', 'page');
  await expect(win.getByTestId('canvas-link-card').last()).toHaveAttribute('data-state', 'unavailable');
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'canvas-chat-card');

  if (theme === 'dark') {
    // 6a. «Ссылка» of a canvas that can have one: turned on, the address, the term and the views.
    await open();
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-node').filter({ hasText: 'Планирование спринта' }).getByTestId('canvas-node-open').click();
    await win.getByTestId('canvas-share').click();
    await win.getByTestId('canvas-share-tabs').getByRole('radio', { name: 'Ссылка' }).click();
    await dialog.getByRole('switch', { name: 'Доступ по ссылке' }).click();
    await expect(dialog.getByTestId('canvas-link-url')).toHaveValue(/\/c\/mockCanvas/);
    await checkpoint(shot, 'canvas-link');
  }

  if (theme === 'dark') {
    // 7. The trash: a canvas and a folder; a trashed canvas shows the restore banner.
    await open();
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-open-trash').click();
    await expect(win.getByTestId('canvas-trash-row')).toHaveCount(2);
    await win.getByTestId('canvas-trash-row').first().getByRole('button').first().click();
    await expect(win.getByTestId('canvas-trashed')).toBeVisible();
    await checkpoint(shot, 'canvas-trash');

    // 7a. The plan's canvas cap (ADR-0126 addendum, owner 23.10): on Free (3) the fixture's four live
    // canvases are already over it — «+ Новый холст» answers with the plan toast, as the Wiki.
    await open();
    mock.setPlanKind(IDS.workspaces.main, Plan.FREE);
    await win.getByTestId('section-canvas').click();
    await expect(win.getByTestId('canvas-node').first()).toBeVisible();
    await win.getByTestId('canvas-create').click();
    await win.getByTestId('canvas-new-canvas').click();
    await expect(win.getByTestId('toast')).toContainText('Лимит тарифа Free: 3 холстов');
    await checkpoint(shot, 'canvas-plan-limit');
  }

  // 8. Comments like the chat (owner 23.10, dark and light): thread cards with chat rows (Борис's two
  // grouped, my reply with a mention, Вера's answer), the reply composer of the active thread, a
  // resolved thread; then (dark) the hover bar of my comment and a new thread's composer at the bottom.
  await open();
  const roadmap = [...mock.canvas.items.values()].find((i) => i.name === 'Дорожная карта Q1');
  if (!roadmap) throw new Error('no roadmap');
  const target = mock.canvas.objects(roadmap.id).find((o) => o.text === 'Раздел «Холст»');
  const { anna, boris, vera } = IDS.users;
  const root = mock.canvas.seedComment(roadmap.id, boris, 'Давайте добавим сюда **макет** панели комментариев', { objectId: target?.id ?? '', x: 150, y: 20 });
  mock.canvas.seedComment(roadmap.id, boris, 'И ссылку на ADR-0127', { parentId: root.id });
  mock.canvas.seedComment(roadmap.id, anna, `@${vera} посмотришь сегодня?`, { parentId: root.id });
  mock.canvas.seedComment(roadmap.id, vera, 'Да, вечером 👍', { parentId: root.id });
  mock.canvas.seedComment(roadmap.id, vera, 'Цвета стикеров согласованы', { x: 40, y: 300, resolved: true });
  mock.canvas.seedComment(roadmap.id, anna, 'Проверить контраст в светлой теме', { x: 520, y: 320 });
  await openRoadmap(win);
  await win.getByTestId('canvas-comments-toggle').click();
  const panel = win.getByTestId('canvas-comments-panel');
  await expect(panel.getByTestId('canvas-comment-thread')).toHaveCount(3);
  await panel.getByTestId('canvas-comment-thread').first().getByTestId('canvas-comment').first().click();
  await expect(panel.getByTestId('canvas-comment-input')).toHaveCount(1);
  if (theme === 'dark') {
    await panel.getByTestId('canvas-comment-thread').first().getByTestId('canvas-comment').nth(2).getByTestId('comment-bubble').hover();
    await expect(panel.getByTestId('comment-actions')).toBeVisible();
    await checkpoint(shot, 'canvas-comments-hover', { keepPointer: true });
  }
  // The reply composer at the bottom of the active thread, the resolved and my threads below it.
  await win.mouse.move(10, 10);
  await panel.getByTestId('canvas-comment-input').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await win.waitForTimeout(300);
  await checkpoint(shot, 'canvas-comments');

  if (theme === 'dark') {
    // 8a. A pin opens its thread in a window at the pin (owner 30.10): «Решено», the rows, the reply field.
    await win.getByTestId('canvas-comments-close').click();
    await win.getByTestId('canvas-comment-pin').first().click();
    const popover = win.getByTestId('canvas-comment-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId('canvas-comment-input')).toBeVisible();
    await win.mouse.move(10, 10);
    await win.waitForTimeout(300);
    await checkpoint(shot, 'canvas-comment-popover');
    await win.keyboard.press('Escape');
    // 8b. The comment tool opens a new thread's field in that window, at the new pin.
    await win.getByTestId('canvas-tool-comment').click();
    const at = await atWorld(win, 60, 260);
    await win.mouse.click(at.x, at.y);
    await expect(win.getByTestId('canvas-comment-popover').getByTestId('canvas-comment-input')).toBeVisible();
    await win.keyboard.type('Новая ветка про @');
    await expect(win.getByRole('option')).not.toHaveCount(0);
    await win.waitForTimeout(200);
    await checkpoint(shot, 'canvas-comments-draft');
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
  }

  if (theme === 'dark') {
    // 8c. What came with canvas-polish (owner 29–30.10): a frame with sticky pads under names, a sticky with
    // centred text, pen and marker strokes (the marker with an eraser hole); the Frames panel, the pencil's
    // panel and the «continue» dots of a selected sticky (a synthetic hover does not raise a dot's preview here).
    await open();
    mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Новинки', ownerId: IDS.users.anna }, (d) => {
      d.create({ kind: 'frame', x: 0, y: 0, w: 560, h: 300, title: 'Стикеры по людям' });
      ['Ирина', 'Тимофей', 'Тимур'].forEach((name, i) => {
        d.create({ kind: 'text', x: 30 + i * 175, y: 40, w: 150, text: name });
        d.create({ kind: 'sticky', x: 30 + i * 175, y: 90, w: 150, h: 150, color: ['pink', 'sky', 'orange'][i], pad: true });
      });
      d.create({ kind: 'sticky', x: 640, y: 40, w: 180, h: 180, color: 'yellow', text: 'Текст стикера по центру, переносится по ширине' });
      d.create({ kind: 'ink', x: 0, y: 360, w: 400, h: 120, points: [0, 60, 60, 0, 130, 110, 200, 10, 270, 120, 340, 20, 400, 80], stroke: 'blue', strokeWidth: 4 });
      d.create({ kind: 'ink', x: 460, y: 380, w: 480, h: 60, points: [0, 30, 160, 0, 320, 60, 480, 20], stroke: 'yellow', strokeWidth: 32, marker: true, erase: [240, -20, 240, 80, 18] });
    });
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-node').filter({ hasText: 'Новинки' }).getByTestId('canvas-node-open').click();
    await expect(win.getByTestId('canvas-title')).toHaveText('Новинки');
    await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
    await win.getByTestId('canvas-tree-toggle').click();
    await fitted(win);
    await checkpoint(shot, 'canvas-frames-pad');
    await win.getByTestId('canvas-frames-toggle').click();
    await expect(win.getByTestId('canvas-frames-panel')).toBeVisible();
    await win.waitForTimeout(400);
    await checkpoint(shot, 'canvas-frames-panel');
    await win.getByTestId('canvas-frames-close').click();
    await win.getByTestId('canvas-tool-pen').click();
    await expect(win.getByTestId('canvas-ink-menu')).toBeVisible();
    await checkpoint(shot, 'canvas-ink-menu');
    await win.keyboard.press('Escape');
    await win.getByTestId('canvas-tool-select').click();
    // The fit of this board in the 960 × 600 window is fixed (56 %, the tree folded): the yellow sticky is at
    // (533, 285) on screen, its right edge at 584; the right «continue» dot hangs 22 px off it.
    await win.mouse.click(533, 285);
    await expect(win.getByTestId('canvas-props')).toBeVisible();
    await win.mouse.move(584 + 22, 285);
    await win.waitForTimeout(400);
    await checkpoint(shot, 'canvas-quick-dots', { keepPointer: true });
  }

  // In a call: the island folded into my avatar with the call mark (ADR-0146).
  await open();
  await joinVoice(win);
  await openRoadmap(win);
  await checkpoint(shot, 'canvas-voice');
  // A folded tree: the left controls sit at the canvas edge.
  await win.getByTestId('canvas-tree-toggle').click();
  await expect(win.getByTestId('canvas-column')).toHaveCount(0);
  // ADR-0146: outside «Команда» the island is folded into my avatar on the rail, the tree folded or not.
  await expect(win.getByTestId('bottom-island')).toBeHidden();
  await expect(win.getByTestId('island-avatar')).toBeVisible();
  await checkpoint(shot, 'canvas-voice-collapsed');
});
