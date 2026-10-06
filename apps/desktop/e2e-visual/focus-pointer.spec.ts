import type { Locator, Page } from '@playwright/test';
import { expect, test } from './app';
import { settle } from './harness';

/**
 * docs/08 «Фокус», docs/09 #138: a mouse click never leaves a focus outline — not on the
 * clicked control, not on the control Radix hands focus back to (a menu / dialog trigger) —
 * and Tab right after it shows the one ring. Behaviour only, no screenshots.
 *
 *   pnpm -F @calaba/desktop e2e:visual --project focus-pointer
 */

interface FocusState {
  what: string;
  outline: string;
  ring: boolean;
}

/** What the focused element shows: its outline style and whether any focus indication is drawn. */
function focused(page: Page): Promise<FocusState> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { what: 'body', outline: 'none', ring: false };
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-focus)';
    document.body.appendChild(probe);
    const focusColor = getComputedStyle(probe).color;
    probe.remove();
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    // Text fields (and the composer / number box around one) mark focus with the border instead;
    // a split control (the island's mic + ▾) rings the whole pill.
    const box = getComputedStyle(el.closest('[data-focus-box]') ?? el);
    const border =
      (parseFloat(box.borderTopWidth) >= 1 && box.borderTopColor === focusColor) || (box.outlineStyle !== 'none' && parseFloat(box.outlineWidth) >= 2);
    const shape = el.querySelector(':scope > [data-focus-shape]');
    const bubble = !!shape && getComputedStyle(shape).filter.includes('drop-shadow');
    return {
      what: `<${el.tagName.toLowerCase()}> ${el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30)}`,
      outline: cs.outlineStyle,
      ring: outline || border || bubble,
    };
  });
}

/** Clicks `target` with the mouse: neither it nor whatever holds focus afterwards shows an outline. */
async function clickNoOutline(page: Page, target: Locator): Promise<void> {
  await target.click();
  await settle(page, true);
  if ((await target.count()) === 1 && (await target.isVisible())) {
    expect(await target.evaluate((el) => getComputedStyle(el).outlineStyle), 'the clicked control has no outline').toBe('none');
  }
  const f = await focused(page);
  expect(f.outline, `no outline on the focused ${f.what} after a click`).toBe('none');
}

/** Tab after the click: the next stop shows the ring. */
async function tabShowsRing(page: Page): Promise<void> {
  await page.keyboard.press('Tab');
  const f = await focused(page);
  expect(f.ring, `Tab shows the focus ring on ${f.what}`).toBe(true);
}

async function general(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await settle(page);
}

test('pointer focus leaves no outline, Tab shows the ring', async ({ open, win }) => {
  await open();
  await general(win);

  // Sidebar room.
  await clickNoOutline(win, win.locator('aside').getByRole('button', { name: /разработка/ }).first());
  await tabShowsRing(win);

  // Island mic, then its ▾ menu trigger (Radix hands focus back to it on close).
  await clickNoOutline(win, win.getByRole('button', { name: /^(Выключить|Включить) микрофон$/ }));
  await tabShowsRing(win);
  const micMenu = win.getByRole('button', { name: 'Выбор микрофона' });
  await micMenu.click();
  await expect(win.getByRole('menu')).toBeVisible();
  await clickNoOutline(win, micMenu);
  await expect(win.getByRole('menu')).toBeHidden();
  await tabShowsRing(win);

  // Composer send.
  await general(win);
  const composer = win.getByRole('textbox').last();
  await composer.click();
  await composer.fill('Фокус без обводки');
  await clickNoOutline(win, win.getByRole('button', { name: 'Отправить', exact: true }));
  await tabShowsRing(win);

  // Title-bar gear → settings; a nav item; the modal «×» (focus returns to the gear).
  const gear = win.getByRole('button', { name: 'Настройки', exact: true });
  await clickNoOutline(win, gear);
  const dialog = win.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // A text field: a click focuses it with the border, never an outer outline.
  const search = dialog.getByRole('searchbox').first();
  await clickNoOutline(win, search);
  expect((await focused(win)).ring, 'the focused field shows its border').toBe(true);
  await clickNoOutline(win, dialog.getByRole('tab').nth(1));
  await tabShowsRing(win);
  await clickNoOutline(win, dialog.getByRole('button', { name: 'Закрыть', exact: true }));
  await expect(dialog).toBeHidden();
  expect(await gear.evaluate((el) => getComputedStyle(el).outlineStyle), 'the gear, focused again on close').toBe('none');
  await tabShowsRing(win);
});
