import { seedInlineButtons } from '../e2e-support/inline-buttons';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { RecordingStatus } from '@calaba/protocol';
import { CODE_FIXTURE, IDS, MOCK_GPTUNNEL_WEB, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { expectAccessible, layoutProblems, NOW, PASSWORD, settle } from './harness';
import { seedDay } from './calendarWeb';

/**
 * Mobile web (ADR-0021) in Playwright's WebKit — the engine of iOS Safari — on iPhone
 * descriptors (playwright.mobile.config.ts): the production web build (dist-web) served
 * same-origin by the mock API, dark theme, the iPhone notch / home-indicator insets simulated
 * (WebKit here has no real safe area: the --safe-* tokens are set to an iPhone 14's 47 / 34 px).
 * One test per screen (named like its snapshot: -g "m-chat"). Every screen: layout invariants
 * (no horizontal scroll, nothing outside the viewport, 40 px targets that don't overlap in the
 * header and the voice strip, the shell exactly as tall as the viewport, no page scroll), axe;
 * the main screens also: the composer visible, no empty band under the last element.
 * Snapshots only on the baseline phone (iPhone 14, 390 px).
 */

const DIST = join(import.meta.dirname, '..', 'dist-web');
const BASELINE = 'webkit-iphone-14';
/** iPhone 14 portrait: status bar + notch, home indicator (Safari reports these as env(safe-area-inset-*)). */
const INSETS = { top: 47, bottom: 34 };
/** An empty band under the last element of the main screen above this is a defect. */
const MAX_BOTTOM_GAP = 24;

// A worktree run keeps its own LiveKit rooms (README «Parallel visual runs»).
process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ||= 'mobile_';

let mock: MockServer;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
});
test.afterAll(async () => {
  await mock.close();
});
test.beforeEach(() => {
  mock.reset('data');
});

const baseline = (): boolean => test.info().project.name === BASELINE;

/** Simulated notch / home-indicator insets (a style tag: re-added after every navigation). */
async function insets(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `@media (max-width: 768px) { :root.web:not(.kb-open) { --safe-top: ${INSETS.top}px; --safe-bottom: ${INSETS.bottom}px; } :root.web.kb-open { --safe-top: ${INSETS.top}px; } }`,
  });
}

async function open(page: Page, path: string, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate((p) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru', ...p }, version: 1 })), prefs);
  await page.goto(`${mock.url}${path}${path.includes('?') ? '&' : '?'}visual-test`);
  await insets(page);
}

async function signIn(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await open(page, '/', prefs);
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).tap();
}

async function signedIn(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await signIn(page, prefs);
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
}

/** Back to the tab root (ADR-0073): «←» until the tab bar shows. */
async function toRoot(page: Page): Promise<void> {
  const back = page.getByTestId('phone-back');
  for (let i = 0; i < 6 && (await back.count()) > 0; i++) await back.first().tap();
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
}

/** A tab of the bottom tab bar (its root). */
async function tab(page: Page, name: 'chats' | 'dms' | 'calendar' | 'me'): Promise<void> {
  await toRoot(page);
  await page.getByTestId(`phone-tab-${name}`).tap();
}

/** «Чаты» → a room of the list (the whole row opens it). */
async function openRoom(page: Page, name: RegExp): Promise<void> {
  await tab(page, 'chats');
  await page.getByTestId('phone-room-list').getByRole('button', { name }).first().tap();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
}

/** Signed in, in the first room (the app opens on the room list). */
async function signedInRoom(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await signedIn(page, prefs);
  await openRoom(page, /^общий/);
}

/**
 * Pins the feed to its bottom (the room can open at the first unread — docs/09 #39 — and a single
 * scrollTo can be overridden by Virtuoso settling right after; matches `feedAtBottom` in
 * screens.spec.ts).
 */
async function feedToBottom(page: Page): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await settle(page);
  }
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await settle(page);
}

/** Mobile-only invariants on top of harness.layoutProblems. */
async function mobileProblems(page: Page, main: boolean): Promise<string[]> {
  return page.evaluate(
    ({ main, maxGap }) => {
      const out: string[] = [];
      const W = innerWidth;
      const H = innerHeight;
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
      };
      // No page scroll in either direction: the app is exactly one screen, the feed scrolls inside.
      const se = document.scrollingElement ?? document.documentElement;
      if (se.scrollHeight > se.clientHeight + 1) out.push(`page scrolls vertically: ${se.scrollHeight} > ${se.clientHeight}`);
      if (scrollY !== 0) out.push(`page scrolled by ${scrollY}px`);
      // Nothing interactive outside the screen, unless a scroller (either axis) holds it.
      for (const el of document.querySelectorAll('button, input, select, textarea, a[href], [role="dialog"]')) {
        if (!visible(el)) continue;
        let scrolled = false;
        for (let p = el.parentElement; p && !scrolled; p = p.parentElement) {
          const cs = getComputedStyle(p);
          const y = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1;
          const x = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1;
          scrolled = x || y;
        }
        if (scrolled) continue;
        const r = el.getBoundingClientRect();
        if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
          const name = el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30);
          out.push(`outside the screen: <${el.tagName.toLowerCase()}> «${name}» ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      const shell = document.querySelector('[data-testid="mobile-shell"]');
      if (shell) {
        const r = shell.getBoundingClientRect();
        if (Math.abs(r.top) > 1 || Math.abs(r.bottom - H) > 1) out.push(`shell ${Math.round(r.top)}..${Math.round(r.bottom)} ≠ viewport 0..${H}`);
      }
      // Touch targets in the bars: ≥ 40×40 and no two overlapping.
      const bars = [...document.querySelectorAll('[data-testid="mobile-shell"] header, [data-testid="mobile-voice-strip"], [data-testid="dm-header"]')];
      for (const bar of bars) {
        if (!visible(bar)) continue;
        const buttons = [...bar.querySelectorAll('button, a[href]')].filter(visible);
        const rects = buttons.map((b) => b.getBoundingClientRect());
        buttons.forEach((b, i) => {
          const r = rects[i];
          if (!r) return;
          const name = b.getAttribute('aria-label') ?? b.textContent.trim().slice(0, 24);
          // A text button (the strip's room line) is as tall as its bar; icon buttons are ≥ 40×40.
          if (r.height < 39.5 || r.width < 39.5) out.push(`small target in ${bar.tagName.toLowerCase()}: «${name}» ${Math.round(r.width)}×${Math.round(r.height)}`);
          if (r.left < -0.5 || r.right > W + 0.5) out.push(`target outside the screen: «${name}» ${Math.round(r.left)}..${Math.round(r.right)}`);
          for (let j = i + 1; j < rects.length; j++) {
            const o = rects[j];
            if (!o) continue;
            const ix = Math.min(r.right, o.right) - Math.max(r.left, o.left);
            const iy = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top);
            if (ix > 0.5 && iy > 0.5) out.push(`overlapping targets: «${name}» and «${buttons[j]?.getAttribute('aria-label') ?? ''}»`);
          }
        });
      }
      if (main) {
        const composer = document.querySelector('[data-testid="composer"]');
        const field = composer?.querySelector('textarea');
        if (!composer || !field || !visible(field)) out.push('composer not visible');
        else {
          const f = field.getBoundingClientRect();
          if (f.top < 0 || f.bottom > H) out.push(`composer field outside the viewport: ${Math.round(f.top)}..${Math.round(f.bottom)}`);
        }
        // The last thing on screen (the voice strip or the composer) ends at the bottom edge: no
        // empty band under it beyond the home-indicator inset.
        const last = [document.querySelector('[data-testid="mobile-voice-strip"] [role="region"]'), composer?.querySelector('textarea')?.closest('div')]
          .filter((e): e is Element => !!e && visible(e))
          .map((e) => e.getBoundingClientRect().bottom);
        const safe = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0;
        const gap = H - safe - Math.max(0, ...last);
        if (gap > maxGap) out.push(`empty band under the last element: ${Math.round(gap)}px`);
      }
      return out;
    },
    { main, maxGap: MAX_BOTTOM_GAP },
  );
}

/** Screenshot (baseline phone) + layout invariants + axe for the current screen. */
async function checkpoint(page: Page, name: string, opts: { main?: boolean; snapshot?: boolean; mask?: Locator[] } = {}): Promise<void> {
  await settle(page);
  const dir = process.env['CALABA_MOBILE_SHOTS'];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}-${test.info().project.name}.png`) });
  }
  if (baseline() && opts.snapshot !== false) await expect.soft(page, `screenshot: ${name}`).toHaveScreenshot(`${name}.png`, { mask: opts.mask ?? [], maskColor: '#808080' });
  // On a phone every modal is a bottom sheet or a side drawer (never centred), and «outside the
  // window» is checked here with horizontal scrollers (the settings section pills) taken into account.
  const generic = (await layoutProblems(page)).filter((p) => p.kind !== 'modal-off-centre' && p.kind !== 'offscreen').map((p) => `${p.kind}: ${p.detail}`);
  expect.soft([...generic, ...(await mobileProblems(page, opts.main ?? false))], `layout invariants: ${name}`).toEqual([]);
  await expectAccessible(page, name);
}

/** No programmatic focus on a phone: iOS scrolls / zooms to a focused field and raises the keyboard. */
async function expectNoFieldFocus(page: Page, where: string): Promise<void> {
  const active = await page.evaluate(() => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable) ? `${a.tagName} ${a.getAttribute('aria-label') ?? a.getAttribute('placeholder') ?? ''}` : null;
  });
  expect.soft(active, `no field focused programmatically: ${where}`).toBeNull();
}

// ---------------------------------------------------------------- signed out

test('m-login', async ({ page }) => {
  await open(page, '/');
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  await expectNoFieldFocus(page, 'login');
  await checkpoint(page, 'm-login');
});

test('m-join', async ({ page }) => {
  await open(page, '/join/calaba-team-2026');
  await expect(page.getByTestId('link-landing').getByRole('button', { name: 'Открыть в Calab' })).toBeVisible();
  await checkpoint(page, 'm-join');
});

// Guest admission (ADR-0040): a room with approval — the guest's waiting screen on the phone.
test('m-guest-waiting', async ({ page }) => {
  mock.setGuestApproval(IDS.rooms.call, true);
  await open(page, '/r/call-guest-link');
  await page.getByTestId('link-landing').getByRole('button', { name: 'Продолжить в браузере' }).tap();
  await expect(page.getByTestId('approval-note')).toContainText('Комната требует подтверждения организатора');
  await page.getByLabel('Ваше имя').fill('Гость Ромашка');
  await page.getByRole('button', { name: 'Войти как гость' }).tap();
  const waiting = page.getByTestId('guest-waiting');
  await expect(waiting.getByText('Ожидаем подтверждения организатора…')).toBeVisible();
  await expect(waiting.getByRole('button', { name: 'Отменить' })).toBeVisible();
  await insets(page);
  await checkpoint(page, 'm-guest-waiting');
});

// ---------------------------------------------------------------- onboarding

test('m-onboarding', async ({ page }) => {
  await signIn(page, { onboarded: false });
  await expect(page.getByTestId('onboarding-mic')).toBeVisible();
  await checkpoint(page, 'm-onboarding');
  // The other steps: layout only (and shots for review with CALABA_MOBILE_SHOTS).
  for (const step of ['notifications', 'mode', 'done']) {
    // The first action of the step («Позже» where there is a permission to grant, else «Продолжить»).
    await page.locator('[data-onb-footer] .ml-auto button').first().tap();
    await expect(page.getByTestId(`onboarding-${step}`)).toBeVisible();
    await checkpoint(page, `m-onboarding-${step}`, { snapshot: false });
  }
  // «Начать» → the app, with nothing focused (docs/09: the composer is focused only by a tap).
  await page.getByRole('button', { name: 'Начать' }).tap();
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await settle(page);
  await expectNoFieldFocus(page, 'after onboarding');
  expect(await page.evaluate(() => scrollY), 'page not scrolled after onboarding').toBe(0);
  await checkpoint(page, 'm-after-onboarding', { snapshot: false, main: (await page.getByTestId('composer').count()) > 0 });
});

// ---------------------------------------------------------------- the app

test('m-chat', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expectNoFieldFocus(page, 'first room');
  await feedToBottom(page);
  await expect.soft(page.locator('html'), 'a Safari tab is not standalone').not.toHaveClass(/pwa-standalone/);
  await checkpoint(page, 'm-chat', { main: true });
  // Switching rooms from the list does not focus the composer either.
  await openRoom(page, /^разработка/);
  await expectNoFieldFocus(page, 'room switch');
  // A long room name: the header's buttons keep their size and place.
  await openRoom(page, /очень-длинное/);
  await checkpoint(page, 'm-chat-long-name', { main: true, snapshot: false });
  await openRoom(page, /^разработка/);
  // The composer grows with its text and stays on screen.
  const box = page.getByTestId('composer').locator('textarea');
  await box.tap();
  await box.fill('Длинное сообщение\nв несколько\nстрок\nс переносами\nи ещё одной');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(page, 'm-chat-multiline', { main: true, snapshot: false });
});

/**
 * docs/09 #125: the server (GET /api/version at READY) is newer than the loaded bundle — the accent
 * bar under the top with «Обновить страницу» (the web has no updater).
 */
test('m-update-bar', async ({ page }) => {
  mock.state.serverVersion = '99.0.0';
  await signedInRoom(page);
  const bar = page.getByTestId('update-bar');
  await expect(bar).toContainText('Доступна версия 99.0.0');
  await expect(bar.getByRole('button', { name: 'Обновить страницу' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Позже' })).toBeVisible();
  await feedToBottom(page);
  await checkpoint(page, 'm-update-bar', { main: true });
});

/** The feed never scrolls sideways and nothing in it pokes past the screen (issue #9). */
async function expectFeedFits(page: Page): Promise<void> {
  const wide = await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => {
    const out: string[] = [];
    if (el.scrollWidth > el.clientWidth + 1) out.push(`feed scrolls sideways: ${el.scrollWidth} > ${el.clientWidth}`);
    // Whatever pokes out (not inside its own horizontal scroller, like a code block's lines).
    for (const b of el.querySelectorAll('*')) {
      const r = b.getBoundingClientRect();
      if (!r.width || (r.right <= innerWidth + 1 && r.left >= -1)) continue;
      let scroller = false;
      for (let p = b.parentElement; p && p !== el && !scroller; p = p.parentElement) scroller = ['auto', 'scroll', 'hidden'].includes(getComputedStyle(p).overflowX);
      if (!scroller) out.push(`<${b.tagName.toLowerCase()} class="${String(b.getAttribute('class')).slice(0, 80)}"> ${Math.round(r.left)}..${Math.round(r.right)} outside 0..${innerWidth}`);
      if (out.length > 5) break;
    }
    return out;
  });
  expect(wide).toEqual([]);
}

// Issue #9: a portrait photo in a phone's bubble stays inside the 70 % lane (no sideways scroll of
// the feed), proportions kept, no taller than 60 % of the screen.
test('m-chat-image', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.portrait] });
  const img = page.getByRole('button', { name: 'Открыть изображение «IMG_2041.png»' });
  await expect.poll(() => img.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  await feedToBottom(page);
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  // Playwright's WebKit keeps a mouse where the sign-in tap was: the message may land under it.
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-message-actions]')).toHaveCount(0);
  await expectFeedFits(page);
  const r = await img.boundingBox();
  const vh = await page.evaluate(() => innerHeight);
  expect(r).not.toBeNull();
  if (r) {
    expect(Math.abs(r.width / r.height - 720 / 1280)).toBeLessThan(0.02);
    expect(r.height).toBeLessThanOrEqual(vh * 0.6 + 1);
  }
  await checkpoint(page, 'm-chat-image', { main: true });
});

// A done meeting recording on a phone (docs/09 #47): the card across the feed, the summary folded,
// the actions wrap; 44 px targets; the REC circle plays (#88), no «Готово» row.
test('m-chat-recording', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await feedToBottom(page);
  const recording = mock.injectRecordingCard({
    roomId: IDS.rooms.general,
    byUserId: IDS.users.boris,
    durationSec: 42 * 60 + 10,
    status: RecordingStatus.DONE,
    webUrl: `${MOCK_GPTUNNEL_WEB}/meetings/1`,
    result: true,
  });
  await feedToBottom(page);
  const card = page.getByTestId('recording-card');
  await expect(card).toContainText('Релиз 0.7');
  await expect(card.getByRole('button', { name: 'Слушать запись' })).toBeVisible();
  await expect(card.getByTestId('recording-card-status')).toHaveCount(0);
  for (const b of await card.getByRole('button').all()) {
    const box = await b.boundingBox();
    expect(box && box.height, `${await b.textContent()}: tall enough to tap`).toBeGreaterThanOrEqual(32);
  }
  await feedToBottom(page);
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expectFeedFits(page);
  await checkpoint(page, 'm-chat-recording', { main: true });
  await card.getByRole('button', { name: 'Ответить', exact: true }).tap();
  const composer = page.getByTestId('composer');
  await expect(composer).toContainText('Встреча записана · 42 мин');
  await composer.getByRole('textbox').fill('Draft the meeting tasks');
  await composer.getByRole('button', { name: 'Отправить', exact: true }).tap();
  await expect.poll(() => mock.state.messages.get(IDS.rooms.general)?.find((m) => m.content === 'Draft the meeting tasks')?.replyToId).toBe(recording.id);
});

// Chat audio player on a phone (docs/08 «Медиа в чате»): the same player, 44 px targets; the web
// client shows the size until the file is played (no download just for the duration).
test('m-chat-audio', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: 'Джингл для релиза', attachments: [IDS.files.audio] });
  const player = page.getByTestId('audio-player');
  await expect(player).toContainText('Джингл релиза');
  for (const b of await player.getByRole('button').all()) {
    const box = await b.boundingBox();
    expect(box && Math.min(box.width, box.height), `${await b.getAttribute('aria-label')}: 44 px target`).toBeGreaterThanOrEqual(44);
  }
  await feedToBottom(page);
  // At rest: the floating date pill fades out 1 s after scrolling.
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await checkpoint(page, 'm-chat-audio', { main: true });
});

// Code blocks on a phone (docs/08 «Код в сообщениях»): the same block — language label, copy
// always visible (no hover on touch), horizontal scroll inside the block, not the page.
test('m-chat-code', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: CODE_FIXTURE.long });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: CODE_FIXTURE.js });
  await expect(page.getByText('Вот обработчик для поиска:')).toBeAttached();
  await feedToBottom(page);
  const js = page.getByTestId('code-block').last();
  await expect(js.locator('.syn-keyword').first()).toBeVisible();
  await expect(js.getByTestId('code-copy')).toHaveCSS('opacity', '1');
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await checkpoint(page, 'm-chat-code', { main: true });
});

// Voice message on a phone (docs/08 «Голосовые сообщения»): the bubble with 44 px targets and
// the mic in the composer (empty field) instead of «send».
test('m-chat-voice', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.getByTestId('voice-button')).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.voice] });
  const player = page.getByTestId('voice-player');
  await expect(player).toContainText('0:05');
  for (const b of await player.getByRole('button').all()) {
    const box = await b.boundingBox();
    expect(box && Math.min(box.width, box.height), `${await b.getAttribute('aria-label')}: 44 px target`).toBeGreaterThanOrEqual(44);
  }
  await feedToBottom(page);
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await checkpoint(page, 'm-chat-voice', { main: true });
});

type Size = { width: number; height: number };

/**
 * Home-screen web app (standalone PWA): no Safari toolbars, the viewport is the whole screen.
 * Emulated: display-mode: standalone + navigator.standalone, the viewport = the device's screen.
 */
async function standalone(page: Page): Promise<void> {
  const use = test.info().project.use;
  // The iPhone SE descriptor has no screen size: its screen is 16:9 (375×667).
  const screen = (use as { screen?: Size }).screen ?? (use.viewport ? { width: use.viewport.width, height: Math.round((use.viewport.width * 16) / 9) } : undefined);
  if (screen) await page.setViewportSize(screen);
  await page.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.replace(/\s/g, '') === '(display-mode:standalone)' ? mm('(min-width: 0px)') : mm(q));
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
  });
}

test('m-chat-standalone', async ({ page }) => {
  await standalone(page);
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/pwa-standalone/);
  await feedToBottom(page);
  await checkpoint(page, 'm-chat-standalone', { main: true });
  // The composer block ends at the bottom edge; under its content only the home-indicator inset.
  const g = await page.getByTestId('composer').evaluate((el) => {
    const inner = el.firstElementChild?.getBoundingClientRect().bottom ?? 0;
    return { edge: innerHeight - el.getBoundingClientRect().bottom, gap: innerHeight - inner, app: document.documentElement.style.getPropertyValue('--app-height') };
  });
  expect.soft(Math.abs(g.edge), 'composer ends at the bottom edge').toBeLessThanOrEqual(1);
  expect.soft(g.gap, 'no more than the home-indicator inset under the composer').toBeLessThanOrEqual(INSETS.bottom + 1);
  expect.soft(g.app, 'no --app-height override when the viewport is the whole screen').toBe('');
});

test('m-chat-empty', async ({ page }) => {
  mock.reset('empty');
  await signIn(page);
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await checkpoint(page, 'm-chat-empty', { snapshot: false });
});

/** Борис and Вера talk in «Созвон» (since 25 minutes before the page clock). */
function seedCall(): void {
  const since = NOW.getTime() - 25 * 60_000;
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, joinedAtMs: since });
  mock.setVoiceState({ userId: IDS.users.vera, roomId: IDS.rooms.call, joinedAtMs: since + 60_000 });
}

// ADR-0073 §1, §3: the app opens on «Чаты» — the rail, the room list as a messenger's chats (68 px
// rows, the voice room with people in green), the tab bar.
test('m-home', async ({ page }) => {
  seedCall();
  await signedIn(page);
  const list = page.getByTestId('phone-room-list');
  await expect(list.getByTestId('phone-room-row').first()).toBeVisible();
  await expect(list.getByTestId('room-voice-line')).toContainText('Борис');
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  await expect(page.getByTestId('room-join')).toHaveCount(0);
  for (const row of await list.getByTestId('phone-room-row').all()) {
    const box = await row.boundingBox();
    expect(box && Math.round(box.height), 'a 68 px room row').toBe(68);
  }
  await checkpoint(page, 'm-home');
  // A category collapses and expands from its header.
  const cat = list.getByRole('button', { name: /^Свернуть / }).first();
  if ((await cat.count()) > 0) {
    await cat.tap();
    await expect(list.getByRole('button', { name: /^Развернуть / }).first()).toBeVisible();
    await list.getByRole('button', { name: /^Развернуть / }).first().tap();
  }
});

// ADR-0073 §4: people in the room's voice, I am not — the banner under the header with «Присоединиться».
test('m-room-voice-banner', async ({ page }) => {
  seedCall();
  await signedIn(page);
  await openRoom(page, /^Созвон/);
  const banner = page.getByTestId('room-voice-banner');
  await expect(banner).toContainText('В голосе · 2');
  const join = banner.getByTestId('room-voice-join');
  const box = await join.boundingBox();
  expect(box && Math.round(box.height), '44 px «Присоединиться»').toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('room-header-join')).toHaveCount(0);
  await checkpoint(page, 'm-room-voice-banner', { main: true });
  // Back (the browser's, as Android back) returns to the list.
  await page.goBack();
  await expect(page.getByTestId('phone-room-list')).toBeVisible();
});

// ADR-0073 §1: the members are a screen of their own (the right drawer is gone); back → the room.
test('m-members-page', async ({ page }) => {
  await signedInRoom(page);
  await page.getByRole('button', { name: 'Участники' }).tap();
  const members = page.getByTestId('members-page');
  await expect(members.getByRole('complementary', { name: 'Участники' })).toBeVisible();
  await checkpoint(page, 'm-members-page');
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('composer')).toBeVisible();
});

// ADR-0073 §1: «Я» — the profile card, mic / sound, the settings entries, «Выйти».
test('m-me', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'me');
  await expect(page.getByTestId('phone-me-card')).toContainText('Анна');
  await expect(page.getByTestId('phone-me-logout')).toBeVisible();
  await checkpoint(page, 'm-me');
});

// Calendar (ADR-0038 §7, ADR-0073): the «Календарь» tab → today, full screen; the meeting card is
// pushed over it (← back).
test('m-calendar-day', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedDay(mock);
  await signedIn(page);
  // «Календарь» is a tab (ADR-0073): today at once.
  await tab(page, 'calendar');
  await expect(page.getByTestId('day-view')).toBeVisible();
  await expect(page.getByTestId('now-line')).toBeVisible();
  await checkpoint(page, 'm-calendar-day');
  await page.getByTestId('event-block').filter({ hasText: 'Планёрка' }).tap();
  await expect(page.getByTestId('event-panel').getByTestId('event-title')).toHaveText('Планёрка');
  await checkpoint(page, 'm-calendar-event-card', { snapshot: false });
  await page.getByRole('button', { name: 'Назад' }).tap();
  await expect(page.getByTestId('day-view')).toBeVisible();
});

// «Подобрать время» on a phone (ADR-0041 §3): the chips, the duration, «в рабочие часы» and the
// nearest windows as a list — no grid.
test('m-calendar-findtime', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedDay(mock);
  await signedIn(page);
  await tab(page, 'calendar');
  await expect(page.getByTestId('day-view')).toBeVisible();
  await page.getByTestId('day-find').tap();
  const pane = page.getByTestId('find-time');
  await pane.getByTestId('find-people-add').tap();
  await page.getByTestId('find-people-picker').getByRole('option', { name: /Борис/ }).tap();
  await page.keyboard.press('Escape');
  await expect(pane.getByTestId('person-chip')).toHaveCount(2);
  await expect(pane.getByTestId('find-slot')).not.toHaveCount(0);
  await expect(pane.getByTestId('availability')).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(page, 'm-calendar-findtime');
});

// The public meeting page of an invited address (ADR-0038 «Диплинки для приглашённых»), no account.
test('m-calendar-public', async ({ page }) => {
  mock.setClock(NOW.getTime());
  const id = seedDay(mock);
  mock.eventGuestLink(id, 'ext@example.com');
  await open(page, `/e/${id}?t=${encodeURIComponent(mock.eventViewToken(id, 'ext@example.com'))}`);
  await expect(page.getByTestId('event-public').getByTestId('event-title')).toHaveText('Планёрка');
  await checkpoint(page, 'm-calendar-public');
});

// Task boards on a phone (ADR-0042 §5): boards on the space screen, the list by default, the task full screen.
test('m-boards-list', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  // «Доски» of the space screen (ADR-0073): the list in place of the rooms, a board is pushed.
  const nav = page.getByTestId('phone-room-list');
  await nav.getByTestId('boards-button').tap();
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
  await expect(page.getByTestId('list-view')).toBeVisible();
  await checkpoint(page, 'm-boards-list');
});

test('m-boards-task', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  // «Доски» of the space screen (ADR-0073): the list in place of the rooms, a board is pushed.
  const nav = page.getByTestId('phone-room-list');
  await nav.getByTestId('boards-button').tap();
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).tap();
  const panel = page.getByTestId('task-panel');
  await expect(panel.getByTestId('assignee-row')).toHaveCount(2);
  await checkpoint(page, 'm-boards-task');
});

// The kanban on a phone: columns a screen wide, swiped horizontally with snap (ADR-0042 §5).
test('m-boards-kanban', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  // «Доски» of the space screen (ADR-0073): the list in place of the rooms, a board is pushed.
  const nav = page.getByTestId('phone-room-list');
  await nav.getByTestId('boards-button').tap();
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('view-kanban').tap();
  const kanban = page.getByTestId('kanban');
  await expect(kanban.getByTestId('kanban-column').first()).toBeVisible();
  await expect(kanban).toHaveCSS('scroll-snap-type', /x mandatory/);
  await checkpoint(page, 'm-boards-kanban');
});

// The composer's «Стикеры» panel as a bottom sheet (ADR-0030): the pack strip, my pack, «Эмоции»
// to add; animated stickers stand on their first frame (they play only on hover).
test('m-sticker-picker', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signedInRoom(page);
  await page.getByTestId('sticker-button').tap();
  const panel = page.getByTestId('sticker-panel');
  await expect(panel.getByTestId('sticker-grid').locator('button[data-sticker-pick]')).toHaveCount(3);
  await expect(page.locator('[data-sticker-still][data-drawn]')).toHaveCount(1);
  await checkpoint(page, 'm-sticker-picker');
  await panel.getByRole('button', { name: 'Стикер ☀️' }).tap();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('sticker-message')).toHaveCount(1);
});

// Stickers by emoji above the field (docs/08 «Композер — подсказка стикеров»): 😂 typed → the
// three 😂 of «Смех» in 56 px tiles; a tap sends one and clears the field.
test('m-chat-sticker-suggest', async ({ page }) => {
  mock.seedLaughStickers();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signedInRoom(page);
  const field = page.getByRole('textbox', { name: /^Сообщение в/ });
  await field.fill('😂');
  const strip = page.getByTestId('sticker-suggest');
  await expect(strip.locator('[data-sticker-suggest]')).toHaveCount(3);
  await expect(page.locator('[data-sticker-still][data-drawn]')).toHaveCount(1);
  await checkpoint(page, 'm-chat-sticker-suggest');
  await strip.locator('[data-sticker-suggest]').first().tap();
  await expect(page.getByTestId('sticker-message')).toHaveCount(1);
  await expect(field).toHaveValue('');
});

test('m-sheet', async ({ page }) => {
  await signedInRoom(page);
  await page.getByRole('button', { name: 'Прикрепить файл' }).tap();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Камера' })).toBeVisible();
  await checkpoint(page, 'm-sheet', { snapshot: false });
  await page.keyboard.press('Escape');
  // A long-press menu on a message.
  await feedToBottom(page);
  await page.getByText('Готово, выдал.').dispatchEvent('contextmenu', { clientX: 120, clientY: 400 });
  await expect(page.getByRole('menu')).toBeVisible();
  await checkpoint(page, 'm-message-menu', { snapshot: false });
});

test('m-voice', async ({ page }) => {
  await signedIn(page);
  // Push-to-talk mode: the fullest strip (room line, mute, deafen, PTT hold, hang up).
  await tab(page, 'me');
  await page.getByTestId('phone-me-voice').tap();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  await settings.getByRole('radio', { name: 'Push-to-talk' }).tap();
  await settings.getByRole('button', { name: 'Закрыть', exact: true }).tap();
  await expect(settings).toHaveCount(0);
  // Nobody in «Созвон»: the handset in its header joins (ADR-0073 §4).
  await openRoom(page, /^Созвон/);
  await page.getByTestId('room-header-join').tap();
  const strip = page.getByTestId('mobile-voice-strip');
  await expect(strip.getByTestId('ptt-hold')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('room-voice-banner')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Созвон' })).toBeVisible();
  await expectNoFieldFocus(page, 'voice room');
  // The status is never cut («Переподк…»): it wraps instead.
  const status = strip.getByTestId('mobile-voice-status');
  expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'voice status not truncated').toBe(true);
  await checkpoint(page, 'm-voice', { main: true });
  // On the list the strip sits above the tab bar; a tap on it opens the call's room.
  await toRoot(page);
  await expect(strip).toBeVisible();
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  await checkpoint(page, 'm-home-voice');
  await strip.getByRole('button', { name: /Созвон/ }).tap();
  await expect(page.getByRole('heading', { name: 'Созвон' })).toBeVisible();
});

// Soundboard (ADR-0036): the strip's «Звуки» opens the island's panel as a bottom sheet (voice
// activation mode; in push-to-talk mode it is «Ещё → Звуки»).
test('m-voice-soundboard', async ({ page }) => {
  mock.addSound(IDS.workspaces.main, 'Фанфары', '🎺');
  await signedIn(page);
  await openRoom(page, /^Созвон/);
  await page.getByTestId('room-header-join').tap();
  const strip = page.getByTestId('mobile-voice-strip');
  await expect(strip.getByTestId('mobile-voice-more')).toBeEnabled({ timeout: 30_000 });
  await strip.getByTestId('mobile-voice-more').tap();
  await page.getByTestId('mobile-voice-sounds').tap();
  const board = page.getByTestId('soundboard');
  await expect(board.getByRole('region', { name: 'Стандартные' }).getByTestId('sound-tile')).toHaveCount(6);
  await expect(board.getByRole('region', { name: 'Звуки пространства' }).getByTestId('sound-tile')).toHaveCount(1);
  await checkpoint(page, 'm-voice-soundboard');
});

test('m-dm-list', async ({ page }) => {
  await signedIn(page);
  // «Личные» is a tab (ADR-0073): notes and DMs at full width.
  await tab(page, 'dms');
  const nav = page.getByTestId('phone-dms');
  const list = nav.getByTestId('dm-list');
  await expect(list.getByRole('button', { name: /Борис Петров/ })).toContainText('Закрепил, чтобы не потерялся');
  // docs/09 #51: a left swipe on Григорий's row reveals «В архив»; tapping it archives the DM
  // («Архив — 1» at the bottom, collapsed). The list stays (the row keeps the gesture).
  await swipeLeft(list.getByRole('button', { name: /Григорий/ }));
  await expect(nav).toBeVisible();
  await checkpoint(page, 'm-dm-swipe', { snapshot: false });
  await nav.getByTestId('dm-swipe-action').getByText('В архив').tap();
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(nav.getByTestId('dm-archive').getByRole('button', { name: 'Архив — 1' })).toHaveAttribute('aria-expanded', 'false');
  await checkpoint(page, 'm-dm-list');
});

// «Заметки» (ADR-0039): the same section above the DMs on «Личные».
test('m-notes', async ({ page }) => {
  const ideas = mock.addShelf(IDS.users.anna, 'Идеи', '💡');
  mock.addShelf(IDS.users.anna, 'Черновики', '');
  mock.injectMessage({ roomId: ideas, authorId: IDS.users.anna, content: 'Тёмная тема для лендинга' });
  await signedIn(page);
  await tab(page, 'dms');
  const nav = page.getByTestId('phone-dms');
  const shelves = nav.getByTestId('notes-shelf');
  await expect(shelves).toHaveCount(2);
  await expect(shelves.first()).toContainText('Тёмная тема для лендинга');
  await checkpoint(page, 'm-notes');
});

/**
 * A finger swipe to the left over the element. Synthetic events: desktop WebKit has neither a
 * touch input API for Playwright nor a Touch constructor, so plain events carry `touches` (what
 * React's touch handlers read).
 */
async function swipeLeft(target: Locator): Promise<void> {
  await target.evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type: string, x: number): void => {
      const t = { identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(ev, { touches: { value: type === 'touchend' ? [] : [t] }, changedTouches: { value: [t] }, targetTouches: { value: type === 'touchend' ? [] : [t] } });
      el.dispatchEvent(ev);
    };
    const x0 = r.right - 20;
    fire('touchstart', x0);
    for (let dx = 15; dx <= 120; dx += 15) {
      fire('touchmove', x0 - dx);
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    fire('touchend', x0 - 120);
  });
}

test('m-dm-chat', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'dms');
  await page.getByTestId('phone-dms').getByTestId('dm-list').getByRole('button', { name: /Борис Петров/ }).tap();
  await expect(page.getByText('Анна, привет! Посмотришь PR с миграцией')).toBeVisible();
  await expectNoFieldFocus(page, 'dm open');
  await feedToBottom(page);
  await checkpoint(page, 'm-dm-chat', { main: true });
});

test('m-call-incoming', async ({ page }) => {
  // ADR-0034: an incoming call on a phone — the whole screen, «Отклонить» / «Принять».
  await signedIn(page);
  mock.ringCall(IDS.users.boris, IDS.users.anna);
  const modal = page.getByTestId('call-incoming');
  await expect(modal).toContainText('Входящий звонок');
  await checkpoint(page, 'm-call-incoming');
  await modal.getByRole('button', { name: 'Отклонить' }).tap();
  await expect(modal).toHaveCount(0);
});

test('m-settings', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'me');
  await page.getByTestId('phone-me-general').tap();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  await expect(settings).toBeVisible();
  await expectNoFieldFocus(page, 'settings');
  await checkpoint(page, 'm-settings');
  await settings.getByRole('tab', { name: 'Голос и устройства' }).tap();
  await checkpoint(page, 'm-settings-voice', { snapshot: false });
  // The section scrolls inside the sheet (its last control can be reached).
  const panel = settings.locator('[data-settings-panel="voice"]');
  const fits = await panel.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.getBoundingClientRect().bottom <= innerHeight + 1 && el.scrollTop > 0;
  });
  expect(fits, 'settings section scrolls inside the sheet').toBe(true);
});

test('m-dialog', async ({ page }) => {
  await signedIn(page);
  await page.getByTestId('phone-chats').getByRole('button', { name: 'Создать пространство' }).tap();
  await expect(page.getByRole('dialog', { name: 'Новое пространство' })).toBeVisible();
  await expectNoFieldFocus(page, 'dialog sheet');
  await checkpoint(page, 'm-dialog', { snapshot: false });
});

// ADR-0031: workspace settings → «Боты» as a phone sheet — the create form wraps, the bot rows
// keep «…» in reach, the webhook error line truncates.
test('m-settings-bots', async ({ page }) => {
  await signedIn(page);
  mock.seedBots();
  await page.getByTestId('phone-room-list').locator('button[aria-haspopup="menu"]', { hasText: 'Команда Calab' }).tap();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).tap();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Боты' }).tap();
  await expect(dialog.getByTestId('bot-row')).toHaveCount(2);
  await expectNoFieldFocus(page, 'bots');
  // The list, not the form: the rows are what the phone shot is about.
  await dialog.getByTestId('bot-row').last().scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-settings-bots');
});

// Issue #10: «Новая комната» on a phone — the room-type glyph inside «Название» keeps clear of the
// typed text (the field's phone padding used to override the caller's pl-7).
test('m-room-new', async ({ page }) => {
  await signedIn(page);
  // The space screen's «+» (docs/09 #140: no longer in the workspace menu).
  await page.getByTestId('phone-room-list').getByTestId('sidebar-create').tap();
  await page.getByRole('menuitem', { name: 'Создать комнату' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Новая комната' });
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel('Название');
  await name.tap();
  await name.fill('дизайн-ревью');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const gap = await name.evaluate((el) => {
    const icon = el.parentElement?.querySelector('svg')?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return icon ? r.left + parseFloat(getComputedStyle(el).paddingLeft) - icon.right : -1;
  });
  expect(gap, 'text starts right of the icon').toBeGreaterThanOrEqual(4);
  await checkpoint(page, 'm-room-new');
});

// docs/09 #55: «Пригласить» from a room's menu (long press) — the guest link first, as a sheet.
test('m-room-invite', async ({ page }) => {
  await signedIn(page);
  const nav = page.getByTestId('phone-room-list');
  await nav.getByTestId('phone-room-row').filter({ hasText: 'общий' }).first().dispatchEvent('contextmenu', { clientX: 120, clientY: 300 });
  await page.getByRole('menuitem', { name: 'Пригласить' }).tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Пригласить гостя без регистрации')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Ссылка для гостей' })).toHaveValue(/\/r\/general-guest-link$/);
  await expectNoFieldFocus(page, 'room invite');
  // The link carries the mock's (random) port: masked.
  await checkpoint(page, 'm-room-invite', { mask: [dialog.getByRole('textbox', { name: 'Ссылка для гостей' })] });
});

type KeyboardStub = { __keyboard: (px: number | null) => void };

/**
 * The on-screen keyboard (lib/mobile.ts installVisualViewport). WebKit here has no software
 * keyboard: visualViewport is replaced by a stand-in whose height the test shrinks, as iOS does
 * while the keyboard is up — and keeps shrunk after the field loses focus, as iOS 26 sometimes
 * does (the stale viewport that left an empty band at the bottom).
 */
test('m-keyboard', async ({ page }) => {
  await page.addInitScript(() => {
    let covered: number | null = null;
    const vv = new EventTarget();
    const props: Record<string, () => number> = {
      height: () => innerHeight - (covered ?? 0),
      width: () => innerWidth,
      offsetTop: () => 0,
      offsetLeft: () => 0,
      scale: () => 1,
    };
    for (const [k, get] of Object.entries(props)) Object.defineProperty(vv, k, { get });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    (window as unknown as KeyboardStub).__keyboard = (px) => {
      covered = px;
      vv.dispatchEvent(new Event('resize'));
    };
  });
  await signedInRoom(page);
  const keyboard = (px: number | null): Promise<void> => page.evaluate((h) => (window as unknown as KeyboardStub).__keyboard(h), px);
  const shellBottom = (): Promise<number> => page.getByTestId('mobile-shell').evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  const vh = page.viewportSize()?.height ?? 0;
  const KB = 300;
  const field = page.getByTestId('composer').locator('textarea');

  // Keyboard up over a focused composer: the shell ends at the keyboard, the composer right above it.
  await field.tap();
  await keyboard(KB);
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await expect.poll(shellBottom, 'shell ends at the keyboard').toBe(vh - KB);
  const f = await field.boundingBox();
  expect(f && f.y + f.height, 'composer above the keyboard').toBeLessThanOrEqual(vh - KB);
  expect(await page.evaluate(() => scrollY), 'document not scrolled').toBe(0);

  // Focus leaves the field, the viewport stays (stale): the app is full height again, no gap.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator('html')).not.toHaveClass(/kb-open/);
  await expect.poll(shellBottom, 'shell back to the full screen').toBe(vh);

  // A shrunk viewport without a focused field (a toolbar, a zoom) is not a keyboard.
  await keyboard(200);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.locator('html')).not.toHaveClass(/kb-open/);
  expect(await shellBottom()).toBe(vh);
  await keyboard(null);
});


test('m-chat-inline-buttons', async ({ page }) => {
  seedInlineButtons(mock);
  await signedInRoom(page);
  await feedToBottom(page);
  await expect(page.getByTestId('inline-keyboard')).toBeVisible();
  await checkpoint(page, 'm-chat-inline-buttons', { main: true });
});
