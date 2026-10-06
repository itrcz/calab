import { RecordingStatus } from '@calaba/protocol';
import type { Locator, Page } from '@playwright/test';
import { IDS, MOCK_GPTUNNEL_WEB, type MockServer } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { settle } from './harness';

/**
 * docs/09 #105: a dialog's «×» closes on a click at the exact centre of its icon. Behaviour only,
 * no screenshots. At 960×600 a tall dialog's «×» lands on the room header, a window drag region
 * (-webkit-app-region: drag): the OS takes a press there for a window drag before the page sees
 * it — whatever is painted above. Playwright's input bypasses the OS, so besides the click the
 * test resolves the drag region at that point the way Chromium builds it (every element with an
 * app-region, in document order, a later one overriding an earlier one) and asserts it's free.
 *
 *   pnpm -F @calaba/desktop e2e:visual --project modal-close
 */

/** The window's app-region at (x, y): the last element (document order) with a drag/no-drag region there. */
function appRegionAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ([x, y]) => {
      // The computed value when the engine exposes it; else the last stylesheet rule that sets it.
      const rules: Array<[string, string]> = [];
      const walk = (list: CSSRuleList): void => {
        for (const r of list) {
          if (r instanceof CSSStyleRule) {
            const v = r.style.getPropertyValue('-webkit-app-region') || r.style.getPropertyValue('app-region');
            if (v) rules.push([r.selectorText, v.trim()]);
          }
          if (r instanceof CSSGroupingRule) walk(r.cssRules);
        }
      };
      for (const s of document.styleSheets) walk(s.cssRules);
      const fromSheets = (el: Element): string => {
        let v = '';
        for (const [sel, val] of rules) if (el.matches(sel)) v = val;
        return v;
      };
      let region = 'none';
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        const v = cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || fromSheets(el);
        if (v !== 'drag' && v !== 'no-drag') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
        region = v;
      }
      return region;
    },
    [x, y] as const,
  );
}

/** The button hit at (x, y): its accessible name, or null. */
function buttonAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null, [x, y] as const);
}

/** Clicks the exact centre of the «×» icon and expects `dialog` to close. */
async function closeAtIconCentre(page: Page, dialog: Locator, close: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await settle(page);
  const label = await close.getAttribute('aria-label');
  const icon = await close.locator('svg').first().boundingBox();
  if (!icon) throw new Error('no «×» icon');
  const x = icon.x + icon.width / 2;
  const y = icon.y + icon.height / 2;
  expect(await buttonAt(page, x, y), 'the icon centre hits the close button').toBe(label);
  expect(await appRegionAt(page, x, y), 'no window drag region under the «×»').not.toBe('drag');
  // Hit area ≥ 32 px around the centre (docs/08 «Модалки — кнопка закрытия»).
  for (const [dx, dy] of [[-15, 0], [15, 0], [0, -15], [0, 15]] as const) {
    expect(await buttonAt(page, x + dx, y + dy), `hit area at ${dx},${dy}`).toBe(label);
  }
  await page.mouse.click(x, y);
  await expect(dialog).toBeHidden();
}

async function general(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await settle(page);
}

async function membersList(page: Page): Promise<Locator> {
  const members = page.getByRole('complementary', { name: 'Участники' });
  if (!(await members.isVisible())) await page.getByRole('button', { name: 'Участники' }).click();
  return members;
}

const modalClose = (dialog: Locator): Locator => dialog.getByRole('button', { name: 'Закрыть', exact: true });

test('invite to voice room', async ({ open, win }) => {
  await open();
  await general(win);
  await win.locator('aside').getByRole('button', { name: /Созвон/ }).first().click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Пригласить', exact: true }).click();
  const dialog = win.getByRole('dialog').filter({ has: win.getByTestId('room-invite') });
  await expect(dialog.getByTestId('picker-option').first()).toBeVisible();
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

test('recording transcript', async ({ open, win, mock }) => {
  await open();
  await general(win);
  const card = await recordingCard(win, mock);
  await card.getByRole('button', { name: 'Полный транскрипт' }).click();
  const dialog = win.getByRole('dialog', { name: 'Транскрипт встречи' });
  await expect(dialog.getByTestId('recording-transcript-row').first()).toBeVisible();
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

test('forward dialog', async ({ open, win }) => {
  await open();
  await general(win);
  await win.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Переслать' }).click();
  const dialog = win.getByRole('dialog', { name: 'Переслать…' });
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

test('custom status dialog', async ({ open, win }) => {
  await open();
  await general(win);
  await win.getByRole('button', { name: /^Мой статус/ }).click();
  await win.getByTestId('status-custom-sub').click(); // the profile menu's «Свой статус ›» (owner, 07.10)
  await win.getByTestId('status-custom').click();
  const dialog = win.getByRole('dialog', { name: 'Свой статус' });
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

test('settings window', async ({ open, win }) => {
  await open();
  await general(win);
  await win.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

test('profile dialog', async ({ open, win }) => {
  await open();
  await general(win);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Профиль' }).click();
  const dialog = win.getByTestId('profile-dialog');
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

test('lightbox', async ({ open, win, mock }) => {
  await open();
  await general(win);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.portrait] });
  const thumb = win.getByRole('button', { name: 'Открыть изображение «IMG_2041.png»' });
  await expect.poll(() => thumb.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  await thumb.click();
  const box = win.getByTestId('lightbox');
  await closeAtIconCentre(win, box, box.getByRole('button', { name: 'Закрыть', exact: true }));
});

// docs/09 #132: a click on the image closes the lightbox like the backdrop; a drag does not.
test('lightbox image click', async ({ open, win, mock }) => {
  await open();
  await general(win);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.portrait] });
  const thumb = win.getByRole('button', { name: 'Открыть изображение «IMG_2041.png»' });
  await expect.poll(() => thumb.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const box = win.getByTestId('lightbox');
  const frame = box.getByTestId('lightbox-frame');

  // Press on the image, move 40 px, release (over the image and then over the backdrop): stays open.
  await thumb.click();
  await expect(frame).toBeVisible();
  const r = await frame.boundingBox();
  if (!r) throw new Error('no lightbox frame');
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  await win.mouse.move(cx, cy);
  await win.mouse.down();
  await win.mouse.move(cx + 40, cy, { steps: 5 });
  await win.mouse.up();
  await expect(box).toBeVisible();
  await win.mouse.move(cx, cy);
  await win.mouse.down();
  await win.mouse.move(r.x + r.width + 12, cy, { steps: 5 });
  await win.mouse.up();
  await expect(box).toBeVisible();

  // A plain click on the image closes it.
  await frame.click();
  await expect(box).toHaveCount(0);
});

test('new direct message', async ({ open, win }) => {
  await open({ ui: { activeWorkspaceId: '@me' } });
  await expect(win.getByTestId('dm-list').getByRole('button').first()).toBeVisible();
  await win.getByRole('button', { name: 'Новое сообщение' }).first().click();
  const dialog = win.getByRole('dialog', { name: 'Новое сообщение' });
  await closeAtIconCentre(win, dialog, modalClose(dialog));
});

/** A finished recording card in «Переговорка» (as screens.spec «recording-transcript»). */
async function recordingCard(win: Page, mock: MockServer): Promise<Locator> {
  mock.injectRecordingCard({
    roomId: IDS.rooms.meeting,
    byUserId: IDS.users.boris,
    durationSec: 42 * 60 + 10,
    status: RecordingStatus.DONE,
    webUrl: `${MOCK_GPTUNNEL_WEB}/meetings/1`,
    result: true,
  });
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Переговорка/ }).click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const card = win.getByTestId('recording-card');
  await expect(card).toHaveCount(1);
  return card;
}
