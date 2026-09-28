import { expect, test, type Locator, type Page } from '@playwright/test';
import { launch, login, settle, type Env } from './harness';

/**
 * Issue #13 (docs/09 #72): a mouse drag over a message selects its text (plain, a link, a code
 * block), the author's name and the time stay out of a selection, ⌘C / Ctrl+C copies it, and a
 * file dragged over the chat does not break it. The production renderer against the mock API;
 * behaviour only, no screenshots.
 */

let env: Env | undefined;
test.afterEach(async () => {
  await env?.close();
});

const selection = (page: Page): Promise<string> => page.evaluate(() => window.getSelection()?.toString() ?? '');
const bubble = (page: Page, text: string): Locator => page.getByTestId('message-bubble').filter({ visible: true, hasText: text }).first();

/** Scrolls `el` into the feed's view and waits until the virtualized list stops moving it. */
async function inView(page: Page, el: Locator): Promise<void> {
  await expect(async () => {
    await el.scrollIntoViewIfNeeded();
    await settle(page);
    const b = await el.boundingBox();
    expect(b && b.y > 40 && b.y + b.height < 500).toBe(true);
  }).toPass({ timeout: 10_000 });
}

/** Drags the primary button inside `el` from the first character of `from` to the last of `to`. */
async function dragAcross(page: Page, el: Locator, from: string, to = from): Promise<void> {
  await inView(page, el);
  const box = await el.evaluate(
    (node, [from, to]) => {
      const rect = (t: string, first: boolean): DOMRect | null => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent?.indexOf(t) ?? -1;
          if (i < 0) continue;
          const at = first ? i : i + t.length - 1;
          const r = document.createRange();
          r.setStart(n, at);
          r.setEnd(n, at + 1);
          return r.getBoundingClientRect();
        }
        return null;
      };
      const a = rect(from, true);
      const b = rect(to, false);
      return a && b ? { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 } : null;
    },
    [from, to] as const,
  );
  if (!box) throw new Error(`«${from}»…«${to}» not found`);
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 5 });
  await page.mouse.move(box.x1, box.y1, { steps: 5 });
  await page.mouse.up();
}

test('drag-select message text, copy it; a file drag keeps the selection', async () => {
  env = await launch({ theme: 'dark', viewport: { width: 960, height: 600 }, onboarded: true });
  const { page, app } = env;
  await login(page);
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

  // Plain text in a bubble.
  const checklist = bubble(page, 'Чек-лист: миграции');
  await dragAcross(page, checklist, 'миграции, конфиг LiveKit');
  expect(await selection(page)).toBe('миграции, конфиг LiveKit');
  // The press focused nothing that draws a ring: the bubble is not left focused.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')).not.toBe('message-bubble');

  // ⌘C / Ctrl+C copies exactly the selection.
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('миграции, конфиг LiveKit');

  // Across a link's text.
  await dragAcross(page, bubble(page, 'Дашборд:'), 'Дашборд:', 'Grafana');
  expect(await selection(page)).toBe('Дашборд: Grafana');

  // Inside a code block.
  await dragAcross(page, bubble(page, 'Предлагаю так'), 'defer');
  expect(await selection(page)).toBe('defer');

  // A selection over whole messages leaves out the author's name and the time.
  const morning = bubble(page, 'Всем доброе утро');
  await inView(page, morning);
  const whole = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-testid="message-bubble"]')].filter((b) => b.checkVisibility());
    const a = all.find((b) => b.textContent.includes('Всем доброе утро'));
    const b = all.find((b) => b.textContent.includes('Повестка в'));
    const sel = window.getSelection();
    if (!a || !b || !sel) return '';
    const r = document.createRange();
    r.setStartBefore(a);
    r.setEndAfter(b);
    sel.removeAllRanges();
    sel.addRange(r);
    return sel.toString();
  });
  expect(whole).toContain('Всем доброе утро!');
  expect(whole).toContain('закреплённом');
  expect(whole).not.toContain('Борис');
  expect(whole).not.toContain('12:02');

  // A file dragged over the chat (the drop overlay shows and goes) leaves the selection alone…
  // (A press inside a selection would drag the selected text: start from none.)
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await dragAcross(page, morning, 'Всем доброе');
  expect(await selection(page)).toBe('Всем доброе');
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="composer"]')?.parentElement ?? document.body;
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
    for (const type of ['dragenter', 'dragover', 'dragleave'])
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  expect(await selection(page)).toBe('Всем доброе');
  // …and a drag-select afterwards works as before.
  await dragAcross(page, morning, 'утро! Сегодня');
  expect(await selection(page)).toBe('утро! Сегодня');
});
