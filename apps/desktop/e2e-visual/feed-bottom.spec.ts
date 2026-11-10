import type { Page, Route } from '@playwright/test';
import { UNFURLS } from '../e2e-support/fixtures';
import { IDS, type MockServer } from '../e2e-support/mock-server';
import { expect, signIn, test } from './calendarWeb';

/**
 * CBF-13 «Сообщения в чате не сразу видно» (ADR-0110): a reader at the bottom of the feed stays at
 * the bottom through everything that changes its geometry — someone's new message (one line, many
 * lines, an image, a link whose preview arrives late and grows the row), the composer growing to
 * several lines, my own send — and a reader scrolled up is never moved by any of it (the «to
 * bottom» button counts the new ones). Behaviour only, the web build in Chromium, a desktop
 * window and phone width.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project feed-scroll -g bottom
 */

const SIZES = [
  { width: 960, height: 600 },
  { width: 390, height: 844 },
];
const ROOM = IDS.rooms.general;
const PREVIEW_URL = 'https://calaba.test/docs/08-design';

interface Bottom {
  /** The last row in the feed's DOM. */
  key: string;
  /** Distance from the scroller's bottom, px. */
  gap: number;
  scrollTop: number;
  /** How far the last row's bottom reaches below the feed's visible bottom / the composer's top (≤ 0 = visible). */
  belowFeed: number;
  belowComposer: number;
}

const bottom = (page: Page): Promise<Bottom> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
    const composer = document.querySelector<HTMLElement>('[data-testid="composer"]');
    if (!el || !composer) throw new Error('no feed');
    const rows = el.querySelectorAll<HTMLElement>('[data-message-id]');
    const last = rows[rows.length - 1];
    const lastBottom = last ? last.getBoundingClientRect().bottom : 0;
    return {
      key: last?.dataset['messageId'] ?? '',
      gap: el.scrollHeight - el.clientHeight - el.scrollTop,
      scrollTop: el.scrollTop,
      belowFeed: lastBottom - el.getBoundingClientRect().bottom,
      belowComposer: lastBottom - composer.getBoundingClientRect().top,
    };
  });

/** The feed ends with `key`, fully on screen above the composer — and still does a moment later. */
async function expectAtEnd(page: Page, key: string, what: string): Promise<void> {
  const ok = (b: Bottom): boolean => b.key === key && b.gap <= 1 && b.belowFeed <= 1 && b.belowComposer <= 1;
  let seen: Bottom | null = null;
  await expect
    .poll(
      async () => {
        seen = await bottom(page);
        return ok(seen);
      },
      { message: `${what}: the last message is not at the end of the feed`, timeout: 5000 },
    )
    .toBe(true)
    .catch((e: unknown) => {
      throw new Error(`${String(e)}\n${what}: ${JSON.stringify(seen)}, expected ${key}`);
    });
  await page.waitForTimeout(400);
  const b = await bottom(page);
  expect(ok(b), `${what}: the feed left the end afterwards (${JSON.stringify(b)})`).toBe(true);
}

/** Holds the matching requests until the returned release() (a slow network). */
async function hold(page: Page, url: string | RegExp): Promise<() => Promise<void>> {
  const held: Route[] = [];
  let open = false;
  await page.route(url, (r) => (open ? r.continue() : void held.push(r)));
  return async () => {
    open = true;
    await Promise.all(held.splice(0).map((r) => r.continue()));
  };
}

async function openRoom(page: Page, mock: MockServer, size: { width: number; height: number }): Promise<void> {
  for (let i = 0; i < 30; i++) mock.injectMessage({ roomId: ROOM, authorId: i % 2 ? IDS.users.vera : IDS.users.boris, content: `Сообщение ${i + 1}` });
  const all = mock.state.messages.get(ROOM) ?? [];
  const last = all[all.length - 1];
  if (last) mock.markRead(IDS.users.anna, ROOM, last.id);
  await page.setViewportSize(size);
  await signIn(page, mock);
  if (size.width < 500) await page.getByText('общий').first().click();
  else await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.locator('[data-virtuoso-scroller]').first()).toBeVisible();
  if (last) await expectAtEnd(page, last.id, 'opened');
}

for (const size of SIZES) {
  const name = `${size.width}x${size.height}`;

  test(`feed ${name}: at the bottom, the feed stays at the end of the chat`, async ({ page, mock }) => {
    await openRoom(page, mock, size);
    const say = (content: string, extra: { attachments?: string[]; authorId?: string } = {}): string =>
      mock.injectMessage({ roomId: ROOM, authorId: extra.authorId ?? IDS.users.boris, content, ...(extra.attachments ? { attachments: extra.attachments } : {}) }).id;

    await expectAtEnd(page, say('Короткое сообщение'), 'a one-line message');
    await expectAtEnd(page, say(Array.from({ length: 12 }, (_, i) => `Строка ${i + 1} длинного сообщения`).join('\n')), 'a twelve-line message');

    // A link whose preview arrives late: the row grows after it was appended.
    const releasePreview = await hold(page, /\/api\/unfurl\?/);
    const link = say(`Глянь ${PREVIEW_URL}`);
    await expectAtEnd(page, link, 'a link before its preview');
    await releasePreview();
    await expect(page.locator(`[data-message-id="${link}"]`).getByText('Дизайн и UX')).toBeVisible();
    await expectAtEnd(page, link, 'a link preview loaded late');

    // An image whose thumbnail arrives late.
    const releaseImage = await hold(page, /\/api\/files\/.*thumbnail/);
    const photo = say('', { attachments: [IDS.files.portrait], authorId: IDS.users.vera });
    await expectAtEnd(page, photo, 'an image before its thumbnail');
    await releaseImage();
    await expect(page.locator(`[data-message-id="${photo}"] img`).first()).toBeVisible();
    await expectAtEnd(page, photo, 'an image loaded late');

    // The composer grows to several lines (the feed's scroller shrinks), then a message comes.
    const box = page.getByPlaceholder('Сообщение в #общий');
    await box.fill('черновик\nв\nнесколько\nстрок\nподряд');
    await expectAtEnd(page, photo, 'the composer grown');
    await expectAtEnd(page, say('Пока я пишу'), 'a message while the composer is tall');
    await box.fill('');
    await expectAtEnd(page, (await bottom(page)).key, 'the composer shrunk');

    // Several at once.
    say('Раз');
    say('Два');
    await expectAtEnd(page, say('Три'), 'three messages at once');

    // My own message.
    await box.fill('Моё сообщение');
    await box.press('Enter');
    await expect(page.locator('[data-message-id]').last()).toContainText('Моё сообщение');
    await expectAtEnd(page, (await bottom(page)).key, 'my own message');
  });

  test(`feed ${name}: scrolled up, new messages never move the reader`, async ({ page, mock }) => {
    await openRoom(page, mock, size);
    const scroller = page.locator('[data-virtuoso-scroller]').first();
    const box = await scroller.boundingBox();
    if (!box) throw new Error('no feed');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -150);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(300);
    const before = await bottom(page);
    expect(before.gap).toBeGreaterThan(300);
    const releasePreview = await hold(page, /\/api\/unfurl\?/);
    mock.injectMessage({ roomId: ROOM, authorId: IDS.users.boris, content: 'Новое, пока я читаю выше' });
    mock.injectMessage({ roomId: ROOM, authorId: IDS.users.vera, content: `И ссылка ${PREVIEW_URL}` });
    await expect(page.getByRole('button', { name: 'Вниз, непрочитанных: 2' })).toBeVisible();
    await releasePreview();
    await page.waitForTimeout(500);
    const after = await bottom(page);
    expect(Math.abs(after.scrollTop - before.scrollTop), 'the reader was moved').toBeLessThanOrEqual(1);
    // My own send from up there takes the feed to its end (and keeps it there).
    const composer = page.getByPlaceholder('Сообщение в #общий');
    await composer.fill('Отвечаю снизу');
    await composer.press('Enter');
    await expect(page.locator('[data-message-id]').last()).toContainText('Отвечаю снизу');
    await expectAtEnd(page, (await bottom(page)).key, 'my own message sent from above');
  });
}

/**
 * GitHub #313: a room whose last messages are links (a bot posting a run of them) — cards, one with
 * a picture, and «preview not found» (404) — each preview answering late, at its own moment.
 * Virtuoso keeps its list `visibility: hidden` until its scroll to the bottom lands; every row
 * growing after it was measured restarts that scroll. The feed must settle at its end, shown, and
 * stop moving.
 */
const KNOWN = Object.keys(UNFURLS);

function seedLinks(mock: MockServer, count: number): string {
  let last = '';
  for (let i = 0; i < count; i++) {
    const url = i % 3 === 2 ? `https://calaba.test/missing/${i}` : (KNOWN[i % KNOWN.length] ?? PREVIEW_URL);
    last = mock.injectMessage({ roomId: ROOM, authorId: IDS.users.boris, content: `Отчёт ${i + 1}: ${url}` }).id;
  }
  mock.markRead(IDS.users.anna, ROOM, last);
  return last;
}

async function openGeneral(page: Page, mock: MockServer, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await signIn(page, mock);
  if (size.width < 500) await page.getByText('общий').first().click();
  else await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.locator('[data-virtuoso-scroller]').first()).toBeVisible();
}

interface Remounts {
  mounted: number;
  bare: string[];
}

for (const size of SIZES) {
  const name = `${size.width}x${size.height}`;

  test(`feed ${name}: a room of late link previews opens at its end, shown and still (#313)`, async ({ page, mock }) => {
    const last = seedLinks(mock, 30);
    // Every preview answers late, each after its own delay (40–1000 ms), out of order.
    let n = 0;
    await page.route(/\/api\/unfurl/, async (r) => {
      await new Promise((res) => setTimeout(res, 40 + ((n++ * 137) % 960)));
      await r.continue().catch(() => undefined);
    });
    await openGeneral(page, mock, size);
    const list = page.locator('[data-testid="virtuoso-item-list"]').first();
    await expect.poll(() => list.evaluate((el) => getComputedStyle(el).visibility), { message: 'the feed stays hidden', timeout: 5000 }).toBe('visible');
    await expectAtEnd(page, last, 'opened with late previews');
    // Still: nothing keeps scrolling, the geometry no longer changes.
    const sample = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
        const items = el?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
        return `${el?.scrollTop ?? -1}/${el?.scrollHeight ?? -1}/${items?.style.paddingTop ?? ''}/${items?.style.paddingBottom ?? ''}`;
      });
    await page.waitForTimeout(2500);
    const a = await sample();
    await page.waitForTimeout(800);
    expect(await sample(), 'the feed keeps moving').toBe(a);
    expect(await page.locator('[data-virtuoso-scroller]').first().getAttribute('data-scrolling'), 'the feed keeps scrolling').toBeNull();
  });

  // The engine of #313: a row Virtuoso remounts (scrolled back into its overscan) drew no preview
  // on its first commit and the card a render later, even with the answer cached — it grew after
  // being measured. Now a remounted row carries its card (or, for a 404, nothing) from the start.
  test(`feed ${name}: a remounted link row has its preview from its first commit (#313)`, async ({ page, mock }) => {
    seedLinks(mock, 30);
    await openGeneral(page, mock, size);
    await expect(page.locator('[data-testid="link-preview"]').last()).toBeVisible();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const list = document.querySelector('[data-testid="virtuoso-item-list"]');
      if (!list) throw new Error('no feed');
      const seen: Remounts = { mounted: 0, bare: [] };
      (window as unknown as { gh313: Remounts }).gh313 = seen;
      // Runs right after React's commit, before its passive effects: the row as it is measured.
      new MutationObserver((records) => {
        for (const r of records)
          for (const node of r.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const row = node.querySelector<HTMLElement>('[data-message-id]');
            const text = row?.textContent ?? '';
            if (!row || !(text.includes('calaba.test/docs/') || text.includes('calaba.test/board'))) continue;
            seen.mounted++;
            if (!row.querySelector('[data-testid="link-preview"]')) seen.bare.push(row.dataset['messageId'] ?? '');
          }
      }).observe(list, { childList: true });
    });
    const scroller = page.locator('[data-virtuoso-scroller]').first();
    // Far up (the bottom rows unmount), then back down (they mount again, answers cached).
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(400);
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => (window as unknown as { gh313: Remounts }).gh313);
    expect(seen.mounted, 'no link row was remounted').toBeGreaterThan(0);
    expect(seen.bare, 'remounted rows drew their preview a render late').toEqual([]);
  });
}

