import { seedInlineButtons } from '../e2e-support/inline-buttons';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { AiState, FileMetaSchema, FormerMemberReason, Plan, RecordingStatus, SipCallStatus, WorkspaceRole, ReportReason } from '@calaba/protocol';
import { ts } from '../e2e-support/fixtures';
import { CANVAS_PUBLIC_CODE, CODE_FIXTURE, IDS, MOCK_GPTUNNEL_WEB, WIKI_PUBLIC_CODE, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { expectAccessible, expectAssigneeStacks, layoutProblems, NOW, PASSWORD, seedAssigneeCounts, seedBotAuthoredTask, seedDays, seedLabelOverflow, seedReleases, seedRichComments, seedViaMcp, settle } from './harness';
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
async function tab(page: Page, name: 'chats' | 'dms' | 'boards' | 'calendar' | 'disk' | 'wiki' | 'canvas' | 'telephony' | 'profile'): Promise<void> {
  await toRoot(page);
  const pinned = page.getByTestId(`phone-tab-${name}`);
  if ((await pinned.count()) > 0) {
    await pinned.tap();
    return;
  }
  // Not pinned (ADR-0095): through the «Ещё» card.
  await page.getByTestId('phone-tab-more').tap();
  await page.getByTestId(`more-row-${name}`).tap();
}

/** The «Профиль» tab: my avatar at the right end of the tab bar (ADR-0073 §1, owner 07.10). */
async function openProfile(page: Page): Promise<void> {
  await tab(page, 'profile');
  await expect(page.getByTestId('phone-profile')).toBeVisible();
}

/** «Команда» → a room of the list (the whole row opens it). */
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
      // Touch targets in the bars: ≥ 44×44 and no two overlapping.
      const bars = [...document.querySelectorAll('[data-testid="mobile-shell"] header, [data-testid="mobile-voice-strip"], [data-testid="dm-header"]')];
      for (const bar of bars) {
        if (!visible(bar)) continue;
        const buttons = [...bar.querySelectorAll('button, a[href]')].filter(visible);
        // A header-bar control (`[data-bar]`, docs/08 «Шапки»): its target is the visual box grown by the ::before pad.
        const rects = buttons.map((b) => {
          const r = b.getBoundingClientRect();
          if (!b.closest('[data-bar]')) return r;
          const pc = getComputedStyle(b, '::before');
          const w = parseFloat(pc.width) || r.width;
          const h = parseFloat(pc.height) || r.height;
          return new DOMRect(r.x - (w - r.width) / 2, r.y - (h - r.height) / 2, w, h);
        });
        buttons.forEach((b, i) => {
          const r = rects[i];
          if (!r) return;
          const name = b.getAttribute('aria-label') ?? b.textContent.trim().slice(0, 24);
          // A text button (the strip's room line) is as tall as its bar; icon buttons are ≥ 44×44.
          if (r.height < 43.5 || r.width < 43.5) out.push(`small target in ${bar.tagName.toLowerCase()}: «${name}» ${Math.round(r.width)}×${Math.round(r.height)}`);
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
      // Touch targets everywhere (owner, 07.10; docs/08 «Размеры контролов на телефоне»): every visible
      // interactive element is ≥ 44 px on its short side (≥ 44 tall for rows / fields, ≥ 44×44 for icon
      // buttons). A checkbox / radio is measured by its label (the row is the target); a `.tap-hit` control by its ::before square.
      // Allowlist = only things that sit inside running text or are not a control of their own.
      const TARGET = 44;
      const INTERACTIVE = 'button, a[href], input, select, textarea, [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"]';
      const ALLOW: Array<[string, string]> = [
        ['[data-inline-target]', 'a link inside a sentence of body text (e.g. the organizer mailto in «Организатор: …»), marked in code'],
        ['.wiki-prose[contenteditable="true"] a[href]', 'links in text being edited (wiki page, task description): inline in running text, a tap places the caret'],
        ['[data-message-id] a[href]','links in message text and link-preview titles: inline in running text; the row itself is the tap / long-press target'],
        ['[data-message-id] button[data-profile-user], [data-message-id] [data-inline-target]', 'author avatar / name and reaction chips in a feed message: dense by design (Telegram-like), the message row is the target; chips keep >= 8 px gaps'],
        ['[data-history-row] button[data-profile-user]', 'actor avatar / name in a task history row (ADR-0091): dense like the feed; the row and its 44 px details chevron are the targets'],
        ['input[type="file"], input[type="range"], input[aria-hidden="true"]', 'native input hidden behind a custom control, or a slider whose thumb row is the target'],
        ['.sr-only', 'visually hidden helpers'],
      ];
      const seen = new Set<Element>();
      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (seen.has(el) || !visible(el)) continue;
        // not a target at all: the pointer goes through it to the element under it (.tap-inert kanban-card chips)
        if (getComputedStyle(el).pointerEvents === 'none') continue;
        seen.add(el);
        if (ALLOW.some(([sel]) => el.matches(sel))) continue;
        if (el.closest('[data-allow-small-target]')) continue;
        const tag = el.tagName.toLowerCase();
        let box: Element = el;
        if (tag === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)) box = el.closest('label') ?? el;
        let r = box.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // `.tap-hit`: a small visual with a centred ::before hit square (docs/08) — measure the square
        if (el.matches('.tap-hit') || el.closest('[data-bar]')) {
          const pc = getComputedStyle(el, '::before');
          r = new DOMRect(r.x, r.y, parseFloat(pc.width) || 0, parseFloat(pc.height) || 0);
        }
        if (r.height < TARGET - 0.5 || r.width < TARGET - 0.5) {
          const name = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent.trim().slice(0, 24);
          out.push(`small target: <${tag}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> «${name}» ${Math.round(r.width)}×${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`);
        }
      }
      // Header bars (owner, 07.10; docs/08 «Шапки»): every visible control of a bar has the same visual
      // height (±1 px) — the CreateButton's disc, --bar-ctl-h-phone — whatever it is (back, switcher,
      // search, «+», «…», arrows, text buttons). Segmented groups opt out with data-bar-skip.
      const refH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-ctl-h-phone')) || 36;
      for (const bar of document.querySelectorAll('[data-bar]')) {
        if (!visible(bar)) continue;
        const ctls = [...bar.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="radio"], input, select')].filter(
          (c) => visible(c) && !c.closest('[data-bar-skip]') && getComputedStyle(c).pointerEvents !== 'none',
        );
        for (const c of ctls) {
          const h = c.getBoundingClientRect().height;
          if (Math.abs(h - refH) > 1) out.push(`header control height ${Math.round(h * 10) / 10} ≠ ${refH}: «${c.getAttribute('aria-label') ?? c.textContent.trim().slice(0, 24)}» in ${bar.getAttribute('data-testid') ?? bar.tagName.toLowerCase()}`);
        }
        const bh = bar.getBoundingClientRect().height;
        if (bar.tagName === 'HEADER' && Math.abs(bh - 48) > 1) out.push(`header bar height ${Math.round(bh)} ≠ 48 (${bar.getAttribute('data-testid') ?? ''})`);
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

/**
 * Screenshot (baseline phone) + layout invariants + axe for the current screen. `axe: false` only for a
 * known violation outside the screen's change (as the desktop checkpoint), with the reason at the call.
 */
async function checkpoint(page: Page, name: string, opts: { main?: boolean; snapshot?: boolean; mask?: Locator[]; keyboard?: boolean; axe?: boolean } = {}): Promise<void> {
  await settle(page);
  const dir = process.env['CALABA_MOBILE_SHOTS'];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}-${test.info().project.name}.png`) });
  }
  if (baseline() && opts.snapshot !== false) await expect.soft(page, `screenshot: ${name}`).toHaveScreenshot(`${name}.png`, { mask: opts.mask ?? [], maskColor: '#808080' });
  // Dialogs are centred cards on a phone too (owner 07.10); «outside the window» is checked here with
  // horizontal scrollers (the settings section pills) taken into account.
  const generic = (await layoutProblems(page)).filter((p) => p.kind !== 'offscreen').map((p) => `${p.kind}: ${p.detail}`);
  // With the keyboard up the shell ends at the keyboard on purpose (m-keyboard checks that).
  const problems = [...generic, ...(await mobileProblems(page, opts.main ?? false))].filter((p) => !(opts.keyboard && p.startsWith('shell ')));
  expect.soft(problems, `layout invariants: ${name}`).toEqual([]);
  if (opts.axe !== false) await expectAccessible(page, name);
}

/** No programmatic focus on a phone: iOS scrolls / zooms to a focused field and raises the keyboard. */
async function expectNoFieldFocus(page: Page, where: string): Promise<void> {
  const active = await page.evaluate(() => {
    const a = document.activeElement;
    // A checkbox (the haptics switch, lib/haptics) raises no keyboard: only text fields count.
    const text = a?.tagName === 'INPUT' && !['checkbox', 'radio'].includes((a as HTMLInputElement).type);
    return a && (text || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable) ? `${a.tagName} ${a.getAttribute('aria-label') ?? a.getAttribute('placeholder') ?? ''}` : null;
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

// The one-time mailbox password page (ADR-0101): the bot's reset link on the phone — the hosting
// password once, mono and selectable, «Скопировать» / «Открыть в Calab» at 44 px (Button's
// mobile:tap-h); nothing else leaks into the shot.
test('m-mail-reset', async ({ page }) => {
  await open(page, '/mail-reset/visual-reset-token');
  await expect(page.getByTestId('mail-reset').getByTestId('mail-reset-password')).toHaveText('correct horse battery staple');
  await checkpoint(page, 'm-mail-reset');
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
  seedDays(mock, IDS.rooms.dev); // #87: messages over several days in «разработка»
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expectNoFieldFocus(page, 'first room');
  await feedToBottom(page);
  await expect.soft(page.locator('html'), 'a Safari tab is not standalone').not.toHaveClass(/pwa-standalone/);
  await checkpoint(page, 'm-chat', { main: true });
  // Switching rooms from the list does not focus the composer either.
  await openRoom(page, /^разработка/);
  await expectNoFieldFocus(page, 'room switch');
  // #87: day pills in the feed (Сегодня / Вчера / «12 января» / the other year), none twice.
  await feedToBottom(page);
  await expect(page.getByRole('separator').filter({ hasText: 'Вчера' }).first()).toBeVisible();
  await expect(page.getByRole('separator').filter({ hasText: 'Сегодня' }).first()).toBeVisible();
  await checkpoint(page, 'm-chat-days', { main: true });
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

// docs/08 «Свайпы и долгое нажатие» (Telegram iOS): a message swiped left shows «Ответить» past
// 48 px; the release puts the reply into the composer (as the menu's «Ответить»), no menu opens.
test('m-chat-swipe-reply', async ({ page }) => {
  await signedInRoom(page);
  await feedToBottom(page);
  const bubble = page.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал.' });
  await touchSwipe(bubble, { dx: -60, from: 'center', release: false });
  await expect(page.getByTestId('reply-swipe-icon')).toHaveAttribute('data-armed', '');
  await checkpoint(page, 'm-chat-swipe-reply');
  await touchRelease(page);
  await expect(page.getByTestId('reply-swipe-icon')).toHaveCount(0);
  await expect(page.getByTestId('composer-context')).toContainText('Готово, выдал.');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await checkpoint(page, 'm-chat-swipe-replied', { main: true, snapshot: false });
  // A short swipe (under the trigger) springs back without a reply.
  await page.getByTestId('composer-context').getByRole('button', { name: 'Отмена' }).tap();
  await touchSwipe(bubble, { dx: -30, from: 'center' });
  await expect(page.getByTestId('composer-context')).toHaveCount(0);
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
  // Owner 28.10: a PNG stored with a wrong type and no thumbnail still shows as a picture.
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.untypedPng] });
  const untyped = page.getByRole('button', { name: 'Открыть изображение «image.png»' });
  await expect.poll(() => untyped.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth === 960)).toBe(true);
  await feedToBottom(page);
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expectFeedFits(page);
  await checkpoint(page, 'm-chat-image-untyped', { main: true });

  // Board #118: the viewer behaves like Telegram's. Touch is simulated with pointer events on the
  // frame (Playwright's WebKit has no multi-touch); double tap uses real taps.
  await untyped.click();
  const box = page.getByTestId('lightbox');
  const frame = box.getByTestId('lightbox-frame');
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  const touch = (type: string, id: number, x: number, y: number): Promise<void> =>
    frame.evaluate(
      (el, a) => {
        el.dispatchEvent(new PointerEvent(a.type, { bubbles: true, pointerId: a.id, pointerType: 'touch', isPrimary: a.id === 1, clientX: a.x, clientY: a.y }));
      },
      { type, id, x, y },
    );
  const center = (await frame.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  const cx = center.x + center.width / 2;
  const cy = center.y + center.height / 2;
  // Pinch out: the picture grows about the fingers and fills the screen width.
  await touch('pointerdown', 1, cx - 30, cy);
  await touch('pointerdown', 2, cx + 30, cy);
  for (let i = 1; i <= 6; i++) {
    await touch('pointermove', 1, cx - 30 - i * 20, cy);
    await touch('pointermove', 2, cx + 30 + i * 20, cy);
  }
  await touch('pointerup', 1, cx - 150, cy);
  await touch('pointerup', 2, cx + 150, cy);
  await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThan(center.width * 2);
  await checkpoint(page, 'm-lightbox-zoomed');
  // Zoomed: a horizontal drag pans, it does not page (still the second photo).
  await touch('pointerdown', 1, cx, cy);
  await touch('pointermove', 1, cx - 80, cy);
  await touch('pointerup', 1, cx - 80, cy);
  await expect(box.getByRole('heading', { name: 'image.png' })).toBeVisible();
  // Double tap zooms back out.
  await page.touchscreen.tap(cx, cy);
  await page.touchscreen.tap(cx, cy);
  await expect.poll(async () => Math.round((await frame.boundingBox())?.width ?? 0)).toBe(Math.round(center.width));
  // Fitted: a swipe right shows the previous photo, another one at the first photo does nothing.
  await touch('pointerdown', 1, cx - 80, cy);
  await touch('pointermove', 1, cx, cy);
  await touch('pointermove', 1, cx + 120, cy);
  await touch('pointerup', 1, cx + 120, cy);
  const counter = box.locator('span.tabular-nums');
  await expect(box.getByRole('heading', { name: 'IMG_2041.png' })).toBeVisible();
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await checkpoint(page, 'm-lightbox-paged');
  const swipe = async (from: number, to: number): Promise<void> => {
    await touch('pointerdown', 1, from, cy);
    await touch('pointermove', 1, to, cy);
    await touch('pointerup', 1, to, cy);
  };
  // The chat holds three photos (message order): one more swipe right reaches the first, the next does nothing.
  await expect(counter).toHaveText('2 / 3');
  await swipe(cx - 80, cx + 120);
  await expect(counter).toHaveText('1 / 3');
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await swipe(cx - 80, cx + 120);
  await expect(counter).toHaveText('1 / 3');
  // Swipe left goes forward to the last one (then nothing more); swipe down closes.
  await swipe(cx + 80, cx - 120);
  await expect(counter).toHaveText('2 / 3');
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await swipe(cx + 80, cx - 120);
  await expect(counter).toHaveText('3 / 3');
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await swipe(cx + 80, cx - 120);
  await expect(counter).toHaveText('3 / 3');
  await expect(box.getByRole('heading', { name: 'image.png' })).toBeVisible();
  await touch('pointerdown', 1, cx, cy);
  await touch('pointermove', 1, cx, cy + 200);
  await touch('pointerup', 1, cx, cy + 200);
  await expect(box).toHaveCount(0);
});

// CBF-66: a Disk folder link in a chat is its own card — name, who shared, what is inside, «Открыть».
test('m-chat-folder-card', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  const folder = [...mock.disk.items.values()].find((i) => i.name === 'Проекты');
  expect(folder).toBeTruthy();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: `Материалы по проектам ${new URL(page.url()).origin}/disk/${folder?.id ?? ''}` });
  const card = page.getByTestId('disk-folder-card');
  await expect(card.getByTestId('disk-folder-card-summary')).toContainText('папка');
  await feedToBottom(page);
  await page.mouse.move(0, 0);
  await expectFeedFits(page);
  await checkpoint(page, 'm-chat-folder-card', { main: true });
});

// A canvas link in a chat (owner 23.10): the card like a wiki page's — tile, name, «Холст · изменён …», «Открыть»;
// a tap opens the board on the phone's «Холст» tab; a canvas not mine to see is the muted «Холст недоступен».
test('m-chat-canvas-card', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  const roadmap = [...mock.canvas.items.values()].find((i) => i.name === 'Дорожная карта Q1');
  expect(roadmap).toBeTruthy();
  const origin = new URL(page.url()).origin;
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: `Доска по плану ${origin}/canvas/${roadmap?.id ?? ''}` });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: `Старая ${origin}/canvas/00000000-0000-4000-8000-00000000dead` });
  const cards = page.getByTestId('canvas-link-card');
  await expect(cards.first()).toHaveAttribute('data-state', 'page');
  await expect(cards.last()).toHaveAttribute('data-state', 'unavailable');
  await feedToBottom(page);
  await page.mouse.move(0, 0);
  await expectFeedFits(page);
  // The raw addresses carry the mock's random port: masked.
  await checkpoint(page, 'm-chat-canvas-card', { main: true, mask: [page.locator('[data-message-id] a:not([data-testid])')] });
  await cards.first().tap();
  await expect(page.getByTestId('phone-canvas-screen').getByTestId('phone-header')).toContainText('Дорожная карта Q1');
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
  await page.addInitScript(KEYBOARD_STUB);
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: CODE_FIXTURE.long });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: CODE_FIXTURE.js });
  // The feed is virtualised: the 420-line log (the first message) fills the viewport, the js message
  // below it is in the DOM only once the feed is scrolled to the bottom — scroll first, then look for it.
  await feedToBottom(page);
  await expect(page.getByText('Вот обработчик для поиска:')).toBeAttached();
  await feedToBottom(page);
  const js = page.getByTestId('code-block').last();
  await expect(js.locator('.syn-keyword').first()).toBeVisible();
  await expect(js.getByTestId('code-copy')).toHaveCSS('opacity', '1');
  await expect(page.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await checkpoint(page, 'm-chat-code', { main: true });

  // Expanded editor on a phone (#97): the whole screen, the keyboard frame shrinks it from below.
  const field = page.getByTestId('composer').locator('textarea');
  const draft = Array.from({ length: 30 }, (_, i) => `Строка ${i + 1}: черновик длинного сообщения для проверки редактора`).join('\n');
  await field.fill(draft);
  await expect(page.getByTestId('composer-expand')).toBeVisible();
  await checkpoint(page, 'm-chat-expand-button', { main: true });
  await page.getByTestId('composer-expand').tap();
  const editor = page.getByRole('dialog', { name: /Сообщение в/ });
  await expect(editor.getByTestId('editor-field')).toBeFocused();
  await checkpoint(page, 'm-chat-expanded-editor');
  await page.evaluate(() => (window as unknown as KeyboardStub).__keyboard(336));
  await expect(page.locator('html.kb-open')).toHaveCount(1);
  await checkpoint(page, 'm-chat-expanded-editor-keyboard', { keyboard: true });
  await page.evaluate(() => (window as unknown as KeyboardStub).__keyboard(null));
  await editor.getByTestId('editor-collapse').tap();
  await expect(editor).toHaveCount(0);
  await expect(field).toHaveValue(draft);
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

// ADR-0073 §1, §3: the app opens on «Команда» — the room list at full width (no workspace rail; the
// workspace is the switcher in the header, owner 07.10) as a messenger's chats (68 px rows, the
// voice room with people in green), the tab bar.
test('m-home', async ({ page }) => {
  seedCall();
  await signedIn(page);
  const list = page.getByTestId('phone-room-list');
  await expect(list.getByTestId('phone-room-row').first()).toBeVisible();
  await expect(list.getByTestId('room-voice-line')).toContainText('Борис');
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  await expect(page.getByTestId('room-join')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Пространства' })).toHaveCount(0);
  await expect(page.getByTestId('phone-ws-switcher')).toContainText('Команда Calab');
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
  // A left swipe on a room row reveals «Прочитано» · «Тихо» (docs/08 «Свайпы и долгое нажатие»);
  // «Тихо» mutes the room and closes the row, the next swipe offers «Звук».
  const general = list.getByTestId('phone-room-row').filter({ has: page.locator('text=/^общий/') }).first();
  await swipeLeft(general);
  const actions = list.getByTestId('room-swipe-action');
  await expect(actions).toBeVisible();
  const box = await actions.boundingBox();
  expect(box && Math.round(box.width), 'two 88 px actions').toBe(176);
  expect(box && Math.round(box.height), 'the row’s full height').toBe(68);
  await checkpoint(page, 'm-home-swipe');
  await actions.getByTestId('room-swipe-mute').tap();
  await expect(actions).toHaveCount(0);
  await swipeLeft(general);
  await expect(actions.getByTestId('room-swipe-mute')).toHaveText('Звук');
  await actions.getByTestId('room-swipe-mute').tap();
  await expect(actions).toHaveCount(0);
  // A tap on a voice row's avatar stack opens «В голосе» (the rest of the row opens the room).
  await list.locator('[data-voice-stack]').first().tap();
  const card = page.getByTestId('voice-people-card');
  await expect(card.getByTestId('voice-people-row')).toHaveCount(2);
  await expect(page.getByTestId('phone-room-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  // Voice audio recovery (#255) without LiveKit: «in voice» by store state (__calabaVoiceSeat), the
  // recovery signals through the voice service's own paths: the strip above the tab bar and the sound prompt.
  const seat = (phase: 'connected' | 'reconnecting'): Promise<void> =>
    page.evaluate(([roomId, workspaceId, ph]) => (window as unknown as { __calabaVoiceSeat?: (s: object) => void }).__calabaVoiceSeat?.({ roomId, workspaceId, phase: ph }), [IDS.rooms.call, IDS.workspaces.main, phase] as const);
  await seat('connected');
  const strip = page.getByTestId('mobile-voice-strip');
  await expect(strip).toBeVisible();
  // #116: only the voice room I am in is tinted in the list; it follows a switch and clears on leave.
  const current = list.locator('[data-testid="phone-room-row"][data-current]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('data-room', IDS.rooms.call);
  await checkpoint(page, 'm-home-in-voice');
  await page.evaluate(() => {
    const w = window as unknown as { __calabaVoiceRecovery?: (what: string) => void };
    w.__calabaVoiceRecovery?.('recovering');
    w.__calabaVoiceRecovery?.('playback');
  });
  // The mic state is the strip's line only; the refused sound is the one toast, with its action.
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await expect(page.getByTestId('toast').filter({ hasText: 'Вы не слышите собеседников' })).toBeVisible();
  await expect(page.getByTestId('toast').getByRole('button', { name: 'Включить звук' })).toBeVisible();
  await expect(strip.getByTestId('mobile-voice-status')).toHaveText('Вас не слышно'); // yellow: being restored
  // Two lines at this width: the room name gives way instead of a cramped third line.
  await expect(strip.getByTestId('mobile-voice-label')).toHaveCount(0);
  await checkpoint(page, 'm-voice-recovery');
  await page.evaluate(() => (window as unknown as { __calabaVoiceRecovery?: (w: string) => void }).__calabaVoiceRecovery?.('unheard'));
  await expect(strip.getByTestId('mobile-voice-status')).toHaveText('Вас не слышно');
  await expect(page.getByTestId('toast')).toHaveCount(1); // no mic toast
  await checkpoint(page, 'm-voice-recovery-unheard');
});

// Bug #146: a room with an unread @mention carries the count badge, a plainly unread one only the bold name.
test('m-home-mentions', async ({ page }) => {
  await signedIn(page);
  const list = page.getByTestId('phone-room-list');
  await expect(list.getByTestId('phone-room-row').first()).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.call, authorId: IDS.users.vera, content: 'Обычное непрочитанное' });
  mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.vera, content: `@${IDS.users.anna} посмотришь макет?` });
  await expect(page.getByTestId('phone-room-row').filter({ hasText: 'разработка' }).locator('[data-count-badge]')).toBeVisible();
  await page.mouse.move(0, 0);
  await checkpoint(page, 'm-home-mentions');
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
  // «Кто в голосе» (docs/08): the header's stack replaces the icon disc; a tap opens the «В голосе»
  // card — the people (56 px rows) and «Присоединиться». The banner's avatars open the same card.
  const stack = page.getByTestId('room-voice-people');
  await expect(stack).toHaveAttribute('aria-label', 'В голосе: Борис, Вера');
  await stack.tap();
  const card = page.getByTestId('voice-people-card');
  await expect(card).toBeVisible();
  await expectCentredCard(page, card);
  await expect(card.getByTestId('voice-people-title')).toContainText('В голосе · 2');
  const rows = card.getByTestId('voice-people-row');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) expect(Math.round((await row.boundingBox())?.height ?? 0), 'a 56 px person row').toBe(56);
  await expect(card.getByTestId('voice-people-join')).toBeVisible();
  await checkpoint(page, 'm-voice-people');
  // ADR-0150: Вера's connection is lost, her seat is kept: the card row dimmed with «нет связи»,
  // her avatar dimmed in the banner and header stacks.
  mock.setVoiceState({ userId: IDS.users.vera, roomId: IDS.rooms.call, connectionLost: true });
  await expect(rows.nth(1).locator('[data-voice-icon="connection-lost"]')).toBeVisible();
  await checkpoint(page, 'm-voice-people-lost');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(banner.locator('[data-connection-lost]')).toHaveCount(1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(page, 'm-room-voice-banner-lost', { main: true });
  await stack.tap();
  await expect(card).toBeVisible();
  // A tap on a person: their member menu, a level over the card; back closes one level at a time.
  await rows.first().tap();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await banner.getByTestId('room-voice-banner-people').tap();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
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
  // A long press on a member: the member menu as the centred card (the profile does not open).
  await longPress(members.locator('[data-member-row]').first());
  await expectMenuCard(page, 'm-members-menu', true);
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('composer')).toBeVisible();
});

// ADR-0077: a colleague's card — @nick under the name, email and phone with «Скопировать», the phone
// a tel: link. Review shot only (no baseline).
test('m-profile-member', async ({ page }) => {
  await signedInRoom(page);
  mock.seedSipExchange(); // Борис gets the internal number 101 (ADR-0117)
  await page.getByRole('button', { name: 'Участники' }).tap();
  await page.getByTestId('members-page').getByRole('button', { name: /Борис Петров/ }).tap();
  const card = page.getByRole('dialog', { name: 'Борис Петров' });
  await expect(card.getByTestId('user-handle')).toHaveText('@boris_p');
  await expect(card.getByTestId('profile-extension')).toContainText('101');
  await expect(card.getByTestId('profile-email')).toContainText('boris@calaba.test');
  await expect(card.getByTestId('work-hours')).toContainText('10–19'); // docs/09 #85
  await expect(card.getByRole('link', { name: '+7 912 555-02-02' })).toHaveAttribute('href', 'tel:+79125550202');
  await checkpoint(page, 'm-profile-member', { snapshot: false });
});

// ADR-0077: «Профиль» settings — the nickname with its availability line, the phone. Review shot only.
test('m-settings-profile', async ({ page }) => {
  await signedIn(page);
  await openProfile(page);
  await page.getByTestId('phone-profile-profile').tap();
  const settings = page.getByTestId('settings-page');
  await expect(settings.getByTestId('username-input')).toHaveValue('anna');
  await settings.getByTestId('username-input').fill('boris_p');
  await expect(settings.getByTestId('username-hint')).toHaveText('Этот ник уже занят');
  await checkpoint(page, 'm-settings-profile', { snapshot: false });
  // ADR-0153: the last card «Удаление аккаунта» and its dialog (Anna owns a workspace: the blocker).
  const entry = settings.getByTestId('delete-account');
  await entry.scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-settings-delete-entry', { snapshot: false });
  await entry.tap();
  await expect(page.getByRole('dialog', { name: 'Удалить аккаунт?' }).getByTestId('delete-account-blocked')).toBeVisible();
  await checkpoint(page, 'm-settings-delete', { snapshot: false });
});

// ADR-0073 §1: «Профиль» (owner 06.10: the former «Я» tab, now the fifth tab «Профиль» with my avatar, owner 07.10) — the
// profile card, mic / sound, the settings entries, «Выйти».
test('m-profile', async ({ page }) => {
  await signedIn(page);
  await openProfile(page);
  await expect(page.getByTestId('phone-profile-card')).toContainText('Анна');
  await expect(page.getByTestId('phone-profile-logout')).toBeVisible();
  await checkpoint(page, 'm-profile');
  // A tab root: the tab bar stays, no «←»; the avatar button is gone from «Личные».
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  await expect(page.getByTestId('phone-back')).toHaveCount(0);
  await expect(page.getByTestId('phone-tab-more')).toHaveAttribute('aria-current', 'page'); // «Профиль» is behind «Ещё» (ADR-0095)
  await page.getByTestId('phone-tab-dms').tap();
  await expect(page.getByTestId('phone-dms')).toBeVisible();
  await expect(page.getByTestId('phone-profile-button')).toHaveCount(0);
});

// ADR-0095 + addendum 14.10: four pinned tabs + «Ещё», five equal cells. The card lists every section
// (52 px rows, 44 px pins, a drag handle); a pin only pins (no reorder; with four pinned the others are
// disabled with a hint); a section picked from the card shows in the fifth cell like any tab.
test('m-more', async ({ page }) => {
  await signedIn(page);
  const bar = page.getByTestId('phone-tabbar');
  await expect(bar.getByRole('button')).toHaveCount(5);
  await expect(page.getByTestId('phone-tab-more')).toHaveAttribute('aria-label', 'Ещё');
  const widths = await bar.getByRole('button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(new Set(widths).size, `equal cells: ${widths.join(', ')}`).toBe(1);
  const searchX: number[] = [];
  const searchAt = async (): Promise<number> => Math.round((await page.getByTestId('phone-search').boundingBox())?.x ?? -1);
  searchX.push(await searchAt());
  await page.getByTestId('phone-tab-more').tap();
  const card = page.getByTestId('phone-more-card');
  await expect(card).toBeVisible();
  await expectCentredCard(page, card);
  for (const tab of ['chats', 'dms', 'calendar', 'boards', 'disk', 'profile']) {
    const row = card.getByTestId(`more-row-${tab}`);
    await expect(row).toBeVisible();
    expect(Math.round((await row.boundingBox())?.height ?? 0), `a 52 px row: ${tab}`).toBe(52);
    const pin = card.getByTestId(`more-pin-${tab}`);
    const b = await pin.boundingBox();
    expect(Math.round(b?.width ?? 0), `a 44 px pin: ${tab}`).toBeGreaterThanOrEqual(44);
    expect(Math.round(b?.height ?? 0), `a 44 px pin: ${tab}`).toBeGreaterThanOrEqual(44);
  }
  await expect(card.getByTestId('more-pin-chats')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('more-pin-disk')).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByTestId('more-pin-hint')).toBeVisible();
  await checkpoint(page, 'm-more-card');
  // Four pinned: «Диск» cannot be pinned until one is unpinned; unpinning does not reorder the others.
  await card.getByTestId('more-pin-chats').tap();
  await expect(card.getByTestId('more-pin-chats')).toHaveAttribute('aria-checked', 'false');
  await card.getByTestId('more-pin-disk').tap();
  await expect(card.getByTestId('more-pin-disk')).toHaveAttribute('aria-checked', 'true');
  await card.getByTestId('more-pin-disk').tap();
  await card.getByTestId('more-pin-chats').tap();
  // A section from the card: its root, shown like a tab in the fifth cell. The pinned tabs keep their x.
  const pinnedX = async (): Promise<number[]> => {
    const xs: number[] = [];
    for (const id of ['chats', 'dms', 'calendar', 'boards']) xs.push(Math.round((await page.getByTestId(`phone-tab-${id}`).boundingBox())?.x ?? -1));
    return xs;
  };
  const xsBefore = await pinnedX();
  await card.getByTestId('more-row-profile').tap();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('phone-profile')).toBeVisible();
  const more = page.getByTestId('phone-tab-more');
  await expect(more).toHaveAttribute('aria-current', 'page');
  await expect(more).toContainText('Профиль');
  expect(await pinnedX(), 'the pinned tabs keep their x').toEqual(xsBefore);
  await checkpoint(page, 'm-more-active');
  // A pinned tab brings «⋯ Ещё» back.
  await page.getByTestId('phone-tab-dms').tap();
  await expect(page.getByTestId('phone-tab-more')).toHaveAttribute('aria-label', 'Ещё');
  searchX.push(await searchAt());
  // The magnifier sits at one x on every root with one (chats, DMs, boards, calendar, disk).
  for (const name of ['boards', 'disk', 'calendar'] as const) {
    await tab(page, name);
    await expect(page.getByTestId('phone-search')).toBeVisible();
    searchX.push(await searchAt());
  }
  expect(new Set(searchX).size, `the search button x per section: ${searchX.join(', ')}`).toBe(1);
  await page.getByTestId('phone-tab-more').tap();
  await expect(page.getByTestId('phone-more-card')).toBeVisible();
});

// ADR-0073 §1 (owner 06.10): the «Доски» tab — the boards of the open workspace; a board is pushed
// over it, the tab bar returns on «←».
test('m-boards-tab', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'boards');
  await expect(page.getByTestId('phone-boards')).toBeVisible();
  await expect(page.getByTestId('boards-list')).toBeVisible();
  await checkpoint(page, 'm-boards-tab');
  await page.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
  await page.getByTestId('phone-back').first().tap();
  await expect(page.getByTestId('phone-boards')).toBeVisible();
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
  // A long press on a meeting: its menu, not its card (the press under the menu is dropped).
  await longPress(page.getByTestId('event-block').filter({ hasText: 'Планёрка' }));
  await expectMenuCard(page, 'm-calendar-event-menu');
  await expect(page.getByTestId('event-panel')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // ADR-0157: cancelling an occurrence of a series asks «Только эту / Всю серию».
  await page.getByTestId('event-block').filter({ hasText: 'Стендап' }).first().tap();
  await page.getByTestId('event-panel').getByTestId('event-cancel').tap();
  await expect(page.getByTestId('choice-following')).toBeVisible();
  await checkpoint(page, 'm-calendar-series-scope', { snapshot: false });
  await page.getByRole('button', { name: 'Отмена' }).tap();
  await expect(page.getByTestId('choice-following')).toHaveCount(0);
});

// Board #85: two extra zones as narrow muted columns left of the day's scale (compact offsets),
// New York on the previous day until 08:00 MSK; the same list in Profile → Календарь.
test('m-calendar-zones', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedDay(mock);
  mock.setCalendarZones(IDS.users.anna, [{ zone: 'Asia/Kolkata' }, { zone: 'America/New_York', label: 'Нью-Йорк' }]);
  await signedIn(page);
  await tab(page, 'calendar');
  const day = page.getByTestId('day-view');
  await expect(day.getByTestId('zone-scale')).toHaveCount(2);
  await expect(day.getByTestId('zone-head').first()).toHaveText(/Kolkata\s*\+5:30/);
  await day.getByTestId('day-scroller').evaluate((el) => el.scrollTo({ top: 6 * 48 }));
  await checkpoint(page, 'm-calendar-zones');
  await openProfile(page);
  await page.getByTestId('phone-profile-calendar').tap();
  await expect(page.getByTestId('cal-zone-label')).toHaveCount(2);
  // CBF-165: «Первый день недели» sits first in the section.
  await expect(page.getByRole('radio', { name: 'Понедельник' })).toBeChecked();
  await checkpoint(page, 'm-settings-calendar-week');
  await page.getByTestId('cal-zone-label').last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(page, 'm-settings-calendar-zones');
});

// The header's date opens a month card (weekday in the label, today / chosen day marked); a day pick navigates.
test('m-calendar-datepicker', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedDay(mock);
  await signedIn(page);
  await tab(page, 'calendar');
  await expect(page.getByTestId('day-view')).toBeVisible();
  await page.getByTestId('day-date').tap();
  await expect(page.getByTestId('day-date-card')).toBeVisible();
  await checkpoint(page, 'm-calendar-datepicker');
  await page.getByTestId('day-date-card').locator('[data-day="2026-01-20"]').tap();
  await expect(page.getByTestId('day-date-card')).toHaveCount(0);
  await expect(page.getByTestId('day-date')).toContainText('20');
  // A new meeting repeating on working days (ADR-0136): the hint under the repeat.
  await page.getByTestId('day-new-event').tap();
  const dialog = page.getByTestId('event-dialog');
  await dialog.getByTestId('event-repeat').selectOption({ label: 'В рабочие дни' });
  await dialog.getByText('по производственному календарю РФ').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-calendar-dialog-workdays', { snapshot: false });
});

// docs/08 «Свайпы и долгое нажатие»: a sideways swipe over the hours flips the day (left → next).
test('m-calendar-swipe', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedDay(mock);
  await signedIn(page);
  await tab(page, 'calendar');
  const title = page.getByTestId('day-view').getByRole('heading', { level: 1 });
  await expect(title).not.toBeEmpty();
  const today = (await title.textContent()) ?? '';
  const scroller = page.getByTestId('day-scroller');
  await touchSwipe(scroller, { dx: -120, from: 'center' });
  await expect(title).not.toHaveText(today);
  await checkpoint(page, 'm-calendar-swipe', { snapshot: false });
  await touchSwipe(scroller, { dx: 120, from: 'center' });
  await expect(title).toHaveText(today);
  // Too short: the day stays.
  await touchSwipe(scroller, { dx: -40, from: 'center' });
  await expect(title).toHaveText(today);
});

// «Подобрать время» on a phone (ADR-0041 §3): the chips, the duration, «в рабочие часы» and the
// nearest windows as a list — no grid.
test('m-calendar-findtime', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedDay(mock);
  await signedIn(page);
  await tab(page, 'calendar');
  await expect(page.getByTestId('day-view')).toBeVisible();
  await page.getByTestId('day-more').tap();
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

// «Мои задачи» on a phone (T4): the tabs and the completion filter are two pill buttons that open
// a centred option card, not scrolling segments.
test('m-my-tasks', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  await tab(page, 'boards');
  await page.getByTestId('my-tasks').tap();
  const bar = page.getByTestId('my-tasks-tabs');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('my-tasks-scope')).toBeVisible();
  await expect(bar.getByRole('radio')).toHaveCount(0);
  await checkpoint(page, 'm-my-tasks');
  await bar.getByTestId('my-tasks-scope').tap();
  await expect(page.getByRole('menuitemradio')).toHaveCount(6);
  await checkpoint(page, 'm-my-tasks-picker');
  await page.getByTestId('my-tasks-scope-assigned').tap();
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
  await expect(bar.getByTestId('my-tasks-scope')).toContainText('Назначены');
  await checkpoint(page, 'm-my-tasks-assigned');
  await bar.getByTestId('completion-switch').getByRole('button').tap();
  await expect(page.getByRole('menuitemradio')).toHaveCount(3);
  await page.keyboard.press('Escape');
  // ADR-0139: the task search on a phone — the same search and filters, cards instead of a table.
  await bar.getByTestId('my-tasks-scope').tap();
  await page.getByRole('menuitemradio', { name: 'Поиск' }).tap();
  await page.getByTestId('all-tasks-search').fill('доск');
  await expect(page.getByTestId('task-search-row')).toHaveCount(3);
  await page.getByTestId('all-tasks-search').blur();
  await checkpoint(page, 'm-task-search');
});

// Task boards on a phone (ADR-0042 §5): the «Доски» tab, the list by default, the task full screen.
test('m-boards-list', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedAssigneeCounts(mock); // #92: CAL-1 / CAL-2 / CAL-4 with 1 / 2 / 5 assignees
  seedReleases(mock); // board task #101: the task screen at the end (rows do not show them)
  await signedIn(page);
  // The «Доски» tab (ADR-0073, owner 06.10): the list of the open workspace, a board is pushed.
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  // A long press on a board opens its «…» menu.
  await longPress(nav.getByTestId('board-row').filter({ hasText: 'Разработка' }));
  await expectMenuCard(page, 'm-board-row-menu');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
  await expect(page.getByTestId('list-view')).toBeVisible();
  await checkpoint(page, 'm-boards-list');
  await expectAssigneeStacks(page);
  await checkpoint(page, 'm-boards-assignees');
  // «Архив задач» (owner 18.10): archive two tasks from their screens, then the board's «…» → the archive; both are restored after.
  for (const key of ['CAL-2', 'CAL-4']) {
    await page.getByTestId('list-row').filter({ hasText: key }).tap();
    await expect(page.getByTestId('task-panel')).toBeVisible();
    await page.getByTestId('panel-more').tap();
    await page.getByTestId('panel-archive').tap();
    await expect(page.getByTestId('list-row').filter({ hasText: key })).toHaveCount(0);
  }
  await page.getByTestId('board-more').tap();
  await page.getByTestId('board-archive-open').tap();
  await expect(page.getByTestId('archive-row')).toHaveCount(2);
  // The «в архиве» toasts (with «Отменить») stay and sit over the first rows: close them.
  while (await page.getByTestId('toast').count()) await page.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).tap();
  await checkpoint(page, 'm-boards-archive');
  await page.getByTestId('archive-row').first().tap();
  await expect(page.getByTestId('archived-banner')).toBeVisible();
  await checkpoint(page, 'm-boards-archive-task');
  await page.getByTestId('archived-restore').tap();
  await page.getByTestId('task-panel').getByTestId('phone-back').tap();
  await page.getByTestId('archive-row').getByTestId('archive-restore').tap();
  await expect(page.getByTestId('archive-empty')).toBeVisible();
  await page.getByTestId('archive-back').tap();
  await expect(page.getByTestId('list-row').filter({ hasText: 'CAL-4' })).toHaveCount(1);
  // A long press on a task row: the task menu as the centred card; the task does not open.
  await longPress(page.getByTestId('list-row').filter({ hasText: 'CAL-3' }));
  await expect(page.getByTestId('task-context-menu')).toBeVisible();
  await expectMenuCard(page, 'm-task-menu', true);
  await expect(page.getByTestId('task-panel')).toHaveCount(0);
  // Board task #101: the task screen's «Релиз» — one per environment, a tap opens the pipeline.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-context-menu')).toHaveCount(0);
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').tap();
  const panel = page.getByTestId('task-panel');
  await expect(panel.getByTestId('prop-release')).toHaveText(['stage · 1288', 'prod · 4929cf3']);
  await panel.getByTestId('prop-release').last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(page, 'm-boards-task-release');
});

// Board #115: the bot's «act on your behalf» request in the task screen and its window.
test('m-boards-bot-consent', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedBotAuthoredTask(mock);
  await signedIn(page);
  await tab(page, 'boards');
  await page.getByTestId('phone-boards').getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').tap();
  const block = page.getByTestId('task-panel').getByTestId('bot-consent-prompt');
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(block).toBeVisible();
  await checkpoint(page, 'm-boards-bot-consent');
  await block.getByTestId('bot-consent-review').tap();
  await expect(page.getByTestId('bot-consent-dialog')).toBeVisible();
  await checkpoint(page, 'm-boards-bot-consent-dialog');
});

// Owner 07.10: the create dialog has the start date (when the board's dates are on).
test('m-boards-create', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('new-task').tap();
  await expect(page.getByTestId('create-start')).toBeVisible();
  await page.getByTestId('create-task-title').fill('Задача с датой начала');
  await checkpoint(page, 'm-boards-create');
});

// CBF-68: «Создать умную задачу» from the boards tab's «+»: off with the reason, then the dialog.
test('m-boards-smart', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'boards');
  await page.getByTestId('section-create-board').tap();
  // CBF-69: Team (the fixture) — off for the plan; then Business.
  await expect(page.getByTestId('boards-create-smart-hint')).toHaveText('Доступно на тарифе Business');
  await checkpoint(page, 'm-boards-smart-plan');
  await page.keyboard.press('Escape');
  mock.setPlanKind(IDS.workspaces.main, Plan.ENTERPRISE);
  await page.getByTestId('section-create-board').tap();
  await expect(page.getByTestId('boards-create-smart-hint')).toHaveText('Сначала подключите AI в настройках');
  await checkpoint(page, 'm-boards-smart-off');
  await page.keyboard.press('Escape');
  mock.setAiState(IDS.workspaces.main, AiState.READY);
  await page.getByTestId('section-create-board').tap();
  await expect(page.getByTestId('boards-create-smart-hint')).toHaveCount(0);
  await page.getByTestId('boards-create-smart').tap();
  await page.getByTestId('smart-task-text').fill('Оплатить счёт поставщика до пятницы');
  await checkpoint(page, 'm-boards-smart-dialog', { keyboard: true });
  // CBF-75: the model declines (a duplicate of CAL-3): the reason inline, the text stays.
  await page.getByTestId('smart-task-text').fill('Оплатить счёт поставщика — похоже, дубль');
  await page.getByTestId('smart-task-submit').tap();
  await expect(page.getByTestId('smart-task-refusal')).toContainText('Похоже на дубль задачи CAL-3');
  await expect(page.getByTestId('smart-task-text')).toHaveValue('Оплатить счёт поставщика — похоже, дубль');
  await checkpoint(page, 'm-boards-smart-refused', { keyboard: true });
  // Bug #152: no answer in time — the cause and the code / status / request id to quote.
  await page.getByTestId('smart-task-text').fill('Оплатить счёт поставщика — таймаут');
  await page.getByTestId('smart-task-submit').tap();
  await expect(page.getByTestId('smart-task-error-ref')).toHaveText('Для поддержки: UNAVAILABLE · 504 · 7f3c9a1e5b2d4c6f8a0b1c2d');
  await checkpoint(page, 'm-boards-smart-error', { keyboard: true });
});

test('m-boards-task', async ({ page }) => {
  mock.setClock(NOW.getTime());
  const cal4 = mock.boards.taskByKey('CAL-4');
  if (cal4) seedDays(mock, cal4.task.roomId); // #87: CAL-4's comments over several days
  const cal3 = mock.boards.taskByKey('CAL-3');
  if (cal3) {
    cal3.task.attachments = [create(FileMetaSchema, { id: IDS.files.sheet, workspaceId: IDS.workspaces.main, name: 'График отпусков 2026.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 19n })];
    cal3.task.attachmentCount = 1;
  }
  await signedIn(page);
  // The «Доски» tab (ADR-0073, owner 06.10): the list of the open workspace, a board is pushed.
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  // #87: a task whose comments span several days shows the chat's day pills.
  await page.getByTestId('list-row').filter({ hasText: 'CAL-4' }).getByText('Карточки задач').tap();
  const feed = page.getByTestId('activity-feed');
  await expect(feed.getByRole('separator').filter({ hasText: 'Вчера' }).first()).toBeVisible();
  await expect(feed.getByRole('separator').filter({ hasText: '2024' })).toHaveCount(1);
  await feed.getByText('Ок, принято').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-boards-task-days');
  await page.getByTestId('task-panel').getByTestId('phone-back').tap();
  // The title, not the row's centre (that is the due date cell, which opens its menu).
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').tap();
  const panel = page.getByTestId('task-panel');
  await expect(panel.getByTestId('assignee-row')).toHaveCount(2);
  await checkpoint(page, 'm-boards-task');
  // «Скачать» on a description's attachment: always visible on the phone (no hover).
  await expect(panel.getByTestId('task-attachment-download')).toBeVisible();
  await panel.getByTestId('task-attachment').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-boards-task-attachment');
  // Owner 23.10: a tap on the description edits it in place in the wiki's editor («Готово» under it).
  await panel.getByTestId('task-description').tap();
  const prose = panel.getByTestId('task-description-editor').locator('.wiki-prose');
  await expect(prose).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('[] проверить на телефоне');
  await checkpoint(page, 'm-boards-task-desc', { keyboard: true });
});

// Board #107: the read view of a description is the editor's own typography — paragraphs, a list, a link, an emoji, bold.
test('m-boards-task-desc-wysiwyg', async ({ page }) => {
  mock.setClock(NOW.getTime());
  const cal4 = mock.boards.taskByKey('CAL-4');
  if (cal4) cal4.task.description = 'Эхо пропало после правки 🎉 подробности на https://calab.io/docs\n\n\nВторой абзац.\n\n- первый **жирный** пункт\n- второй пункт\n\n| Поле | Тип | Обязательное | Описание |\n| --- | --- | --- | --- |\n| id | **uuid** | да | первичный ключ задачи |\n| имя | text | | |';
  // Board #134: a table is drawn in read mode like in the editor; a wide one scrolls inside the description.
  await signedIn(page);
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('list-row').filter({ hasText: 'CAL-4' }).getByText('Карточки задач').tap();
  const panel = page.getByTestId('task-panel');
  const read = panel.getByTestId('task-description');
  await expect(read.locator('li')).toHaveCount(2);
  await expect(read.locator('table td')).toHaveCount(8);
  // Block geometry relative to the first paragraph (the keyboard may scroll the panel).
  const boxes = async (root: Locator): Promise<number[][]> => {
    const first = await root.locator('p').first().boundingBox();
    const out: number[][] = [];
    for (const sel of ['p >> nth=1', 'li >> nth=0', 'li >> nth=1', '.tableWrapper', 'th >> nth=1', 'td >> nth=4']) {
      const b = await root.locator(sel).boundingBox();
      out.push(b && first ? [b.x - first.x, b.y - first.y, b.width, b.height] : []);
    }
    return out;
  };
  const readBoxes = await boxes(read);
  await checkpoint(page, 'm-boards-task-desc-read');
  // Board #109: opening the editor on this text (it ends in a list) and re-opening it after «Готово» threw
  // «Applying a mismatched transaction» in WebKit. The blocks stay where the read view drew them.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const pass of ['open', 'reopen']) {
    await read.tap();
    const prose = panel.getByTestId('task-description-editor').locator('.wiki-prose');
    await expect(prose, pass).toBeFocused();
    await expect(prose.locator('li')).toHaveCount(2);
    const editBoxes = await boxes(prose);
    for (let i = 0; i < readBoxes.length; i++) for (let j = 0; j < 4; j++) expect(Math.abs((editBoxes[i]?.[j] ?? 1e6) - (readBoxes[i]?.[j] ?? -1e6)), `${pass}: block ${i} coord ${j}: read ${String(readBoxes[i])} edit ${String(editBoxes[i])}`).toBeLessThanOrEqual(1);
    if (pass === 'open') await checkpoint(page, 'm-boards-task-desc-edit', { keyboard: true });
    await panel.getByTestId('task-description-save').tap();
    await expect(panel.getByTestId('task-description-editor')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

// «История» on the phone's task screen (ADR-0091): two tabs as segments, a detail opened.
test('m-boards-task-history', async ({ page }) => {
  mock.setClock(NOW.getTime());
  mock.seedBots();
  await signedIn(page);
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').tap(); // the title: the row's centre is the due date
  const section = page.getByTestId('task-panel').getByTestId('task-activity');
  await section.getByRole('radio', { name: 'История' }).tap();
  const rows = section.getByTestId('history-row');
  await expect(rows.first()).toHaveAttribute('data-kind', 'description');
  await rows.first().getByTestId('history-toggle').tap();
  await expect(section.getByTestId('history-diff')).toBeVisible();
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(page, 'm-boards-task-history');
  // ADR-0156: «(через бота Погода · MCP)» / «(через MCP)» in the history and on the comments.
  seedViaMcp(mock);
  await page.getByTestId('task-panel').getByTestId('phone-back').tap();
  await expect(page.getByTestId('task-panel')).toHaveCount(0);
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').tap();
  await section.getByRole('radio', { name: 'История' }).tap();
  await expect(section.locator('[data-via-mcp]')).toHaveCount(2);
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(page, 'm-boards-task-via-mcp');
  await section.getByRole('radio', { name: 'Комментарии' }).tap();
  const panel = page.getByTestId('task-panel');
  await expect(panel.locator('[data-message-id] [data-via-mcp]')).toHaveCount(3);
  await panel.locator('[data-message-id]').filter({ hasText: 'Взял в работу' }).scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-boards-task-comments-via-mcp');
});

// Board #148: a picture and pipe tables in the comments; the wide table scrolls inside its bubble.
test('m-boards-task-comments-rich', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  seedRichComments(mock);
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('list-row').filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').tap();
  const panel = page.getByTestId('task-panel');
  await expect(panel.locator('table')).toHaveCount(2);
  const wide = panel.locator('.tableWrapper').last();
  await wide.scrollIntoViewIfNeeded();
  expect(await wide.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // axe off: label-content-name-mismatch on the task-list rows behind the panel, not this change (the desktop twin skips it too).
  await checkpoint(page, 'm-boards-task-comments-rich', { axe: false });
});

// The kanban on a phone: columns a screen wide, swiped horizontally with snap (ADR-0042 §5).
test('m-boards-kanban', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  // The «Доски» tab (ADR-0073, owner 06.10): the list of the open workspace, a board is pushed.
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  // The view choice is a radio group in the header «…» (owner 07.10), not a switcher row.
  await expect(page.getByTestId('view-switch')).toHaveCount(0);
  await page.getByTestId('board-more').tap();
  await checkpoint(page, 'm-boards-more', { snapshot: false });
  await page.getByTestId('view-kanban').tap();
  const kanban = page.getByTestId('kanban');
  await expect(kanban.getByTestId('kanban-column').first()).toBeVisible();
  await expect(kanban).toHaveCSS('scroll-snap-type', /x mandatory/);
  await checkpoint(page, 'm-boards-kanban');
  // A long press on a card: the task menu; no drag starts, the task does not open.
  await longPress(kanban.getByTestId('task-card').first());
  await expect(page.getByTestId('task-context-menu')).toBeVisible();
  await expectMenuCard(page, 'm-task-card-menu');
  await expect(page.getByTestId('task-panel')).toHaveCount(0);
});

// Labels past the card width collapse into «+N» (docs/08 «Лейблы»); a tap opens the hidden ones, the task panel does the same.
test('m-boards-labels', async ({ page }) => {
  mock.setClock(NOW.getTime());
  seedLabelOverflow(mock);
  await signedIn(page);
  await tab(page, 'boards');
  await page.getByTestId('phone-boards').getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('board-more').tap();
  await page.getByTestId('view-kanban').tap();
  const kanban = page.getByTestId('kanban');
  const card = kanban.getByTestId('task-card').filter({ hasText: 'CAL-4' });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId('labels-more')).toBeVisible();
  await checkpoint(page, 'm-boards-labels');
  // The card is one touch target (.tap-inert): its «+N» does not catch the tap, the task panel's does.
  await card.getByTestId('card-title').tap();
  const panel = page.getByTestId('task-panel');
  await expect(panel.getByTestId('prop-labels')).toBeVisible();
  await panel.getByTestId('prop-labels').scrollIntoViewIfNeeded();
  await expect(panel.getByTestId('labels-more')).toBeVisible();
  await checkpoint(page, 'm-boards-labels-task');
  await panel.getByTestId('labels-more').tap();
  await expect(page.getByTestId('labels-more-list')).toBeVisible();
  await expect(page.getByTestId('labels-more-list').getByTestId('label-pill')).toHaveCount(await page.getByTestId('labels-more-list').getByTestId('label-pill').count());
  await checkpoint(page, 'm-boards-labels-more', { snapshot: false });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('labels-more-list')).toHaveCount(0);
});

// The status colour picker on a phone (ADR-0093): the shared menu runtime centres it as a card.
test('m-boards-settings-color', async ({ page }) => {
  mock.setClock(NOW.getTime());
  await signedIn(page);
  await tab(page, 'boards');
  const nav = page.getByTestId('phone-boards');
  await nav.getByTestId('board-row').filter({ hasText: 'Разработка' }).getByRole('button').first().tap();
  await page.getByTestId('board-more').tap();
  await page.getByTestId('board-settings').tap();
  await page.getByRole('tab', { name: 'Статусы' }).tap();
  await page.getByTestId('statuses-editor').locator('[data-settings-row]').first().getByRole('button', { name: /^Цвет/ }).tap();
  await expect(page.getByTestId('status-color-picker').getByRole('radio')).toHaveCount(12);
  await checkpoint(page, 'm-boards-settings-color');
});

// The composer's «Стикеры» panel as a centred card (ADR-0030, owner 07.10): the pack strip, my pack, «Эмоции»
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

/**
 * A menu / picker card (owner 07.10: no bottom sheets): centred on the screen (the top card of the
 * stack), at most 360 px wide and 70 % of the screen tall, inside the safe area.
 */
async function expectCentredCard(page: Page, card: Locator): Promise<void> {
  const r = await card.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, top: b.top, bottom: b.bottom };
  });
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  expect.soft(Math.abs(r.x - vp.width / 2), 'card centred horizontally').toBeLessThanOrEqual(1);
  expect.soft(Math.abs(r.y - vp.height / 2), 'card centred vertically').toBeLessThanOrEqual(1);
  expect.soft(r.w, 'card width ≤ min(360, screen − 32)').toBeLessThanOrEqual(Math.min(360, vp.width - 32) + 0.5);
  expect.soft(r.h, 'card height ≤ 70 % of the screen').toBeLessThanOrEqual(vp.height * 0.7 + 0.5);
  expect.soft(r.top, 'card below the notch').toBeGreaterThanOrEqual(INSETS.top);
  expect.soft(r.bottom, 'card above the home indicator').toBeLessThanOrEqual(vp.height - INSETS.bottom);
}

// Owner 07.10: menus are centred cards over a scrim, never bottom sheets — 📎 and a message's long-press menu.
test('m-menu', async ({ page }) => {
  await signedInRoom(page);
  await page.getByRole('button', { name: 'Прикрепить файл' }).tap();
  const attach = page.getByRole('menu');
  await expect(attach.getByRole('menuitem', { name: 'Камера' })).toBeVisible();
  await expectCentredCard(page, attach);
  await checkpoint(page, 'm-menu');
  // A tap on the scrim closes the menu and reaches nothing under it.
  await page.touchscreen.tap(20, 120);
  await expect(attach).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
  // A long-press menu on a message.
  await feedToBottom(page);
  await page.getByText('Готово, выдал.').dispatchEvent('contextmenu', { clientX: 120, clientY: 400 });
  await expect(page.getByRole('menu')).toBeVisible();
  await expectCentredCard(page, page.getByRole('menu'));
  await checkpoint(page, 'm-message-menu');
  // ADR-0140: my message seen by Борис and Вера (✓✓), the next one by nobody (✓); a long press
  // on it: «Прочитали» on top of the menu opens the list in place.
  await page.touchscreen.tap(20, 120);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const seen = mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: 'Посмотрите макет до обеда.' });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: 'И ссылку на прототип.' });
  mock.markRead(IDS.users.boris, IDS.rooms.general, seen.id);
  mock.markRead(IDS.users.vera, IDS.rooms.general, seen.id);
  await feedToBottom(page);
  const bubble = page.getByTestId('message-bubble').filter({ hasText: 'Посмотрите макет' });
  await expect(bubble.getByTestId('read-ticks')).toBeVisible();
  await bubble.getByText('Посмотрите макет').dispatchEvent('contextmenu', { clientX: 120, clientY: 400 });
  await page.getByTestId('message-read-by').tap();
  await expect(page.getByRole('menu').getByTestId('read-by-row')).toHaveCount(2);
  await checkpoint(page, 'm-message-read-by');
  // ADR-0154: «Пожаловаться…» on someone else's message → the report dialog as a centred card.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByText('Готово, выдал.').dispatchEvent('contextmenu', { clientX: 120, clientY: 400 });
  await page.getByTestId('message-report').tap();
  const report = page.getByTestId('report-dialog');
  await expect(report).toBeVisible();
  await report.getByTestId(`report-reason-${ReportReason.SPAM}`).tap();
  await checkpoint(page, 'm-report-dialog');
  // ADR-0162: «Изменить» on a message of my own bot («Погода»).
  await page.keyboard.press('Escape');
  await expect(report).toHaveCount(0);
  mock.seedBots();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.bots.weather, content: 'Завтра +3, без осадков.' });
  await feedToBottom(page);
  await page.getByText('Завтра +3, без осадков.').dispatchEvent('contextmenu', { clientX: 120, clientY: 400 });
  await expect(page.getByTestId('message-edit')).toBeVisible();
  await checkpoint(page, 'm-message-menu-bot');
});

// Owner 07.10: a sub-level («+» → «Создать задачу ▸») opens by a tap only — never on hover — as a
// card over its parent, which zooms back, shifts left and dims; «‹ Создать задачу», a tap on the
// parent card and back (Android / browser) each return one level.
test('m-menu-sub', async ({ page }) => {
  await signedIn(page);
  await page.getByTestId('phone-room-list').getByTestId('sidebar-create').tap();
  const item = page.getByTestId('sidebar-new-task');
  const sub = page.getByTestId('sidebar-task-boards');
  const parentWrap = page.locator('[data-radix-popper-content-wrapper]').filter({ has: item });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-haspopup', 'menu');
  await expect(parentWrap).toHaveAttribute('data-pm-depth', '0');
  // A hovering mouse (Chrome's device emulation) does not open it.
  await item.hover();
  await page.waitForTimeout(400);
  await expect(sub).toHaveCount(0);
  await item.tap();
  await expect(sub).toBeVisible();
  await expect(sub.locator('[role="menuitem"]:not([data-pm-back])')).toHaveCount(2);
  await expect(sub.getByTestId('menu-back')).toHaveText('Создать задачу');
  await expect(parentWrap).toHaveAttribute('data-pm-depth', '1');
  await expectCentredCard(page, sub);
  await checkpoint(page, 'm-menu-sub');
  // «‹ Создать задачу»: one level back.
  await sub.getByTestId('menu-back').tap();
  await expect(sub).toHaveCount(0);
  await expect(parentWrap).toHaveAttribute('data-pm-depth', '0');
  // A tap on the parent card (its edge left of the sub-level) returns to it, and picks nothing.
  await item.tap();
  await expect(sub).toBeVisible();
  const p = await parentWrap.locator(':scope > [role="menu"]').boundingBox();
  if (!p) throw new Error('parent card has no box');
  await page.touchscreen.tap(p.x + 4, p.y + p.height / 2);
  await expect(sub).toHaveCount(0);
  await expect(item).toBeVisible();
  // Back: the sub-level first, then the menu, then nothing more (still the «Команда» root).
  await item.tap();
  await expect(sub).toBeVisible();
  await page.goBack();
  await expect(sub).toHaveCount(0);
  await expect(item).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  // One frame mid-way into a sub-level (the run's reduced motion and stable mode lifted, the 150 ms
  // stretched so the frame can be caught).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    document.documentElement.classList.remove('test-stable');
    document.documentElement.style.setProperty('--motion-card', '4000ms');
  });
  await page.getByTestId('phone-room-list').getByTestId('sidebar-create').tap();
  await expect(item).toBeVisible();
  await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
  await item.tap();
  await expect(sub).toBeVisible();
  await page.evaluate(() =>
    document.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = 1600;
    }),
  );
  const dir = process.env['CALABA_MOBILE_SHOTS'];
  if (dir) await page.screenshot({ path: join(dir, `m-menu-sub-mid-${test.info().project.name}.png`) });
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => a.finish());
    document.documentElement.style.removeProperty('--motion-card');
  });
});

test('m-voice', async ({ page }) => {
  await signedIn(page);
  // Push-to-talk mode: the fullest strip (room line, mute, deafen, PTT hold, hang up).
  await openProfile(page);
  await page.getByTestId('phone-profile-voice').tap();
  const settings = page.getByTestId('settings-page');
  await settings.getByRole('radio', { name: 'Push-to-talk' }).tap();
  await page.getByTestId('phone-back').tap();
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
  // In the call (docs/08 «Кто в голосе»): Борис joins; the header's stack (me first) opens the card
  // with «Вы» at my row and «Выйти».
  // CBF-82: Борис is in push-to-talk mode (mic on, waiting for his key): the pale crossed mic.
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, muted: false, ptt: true, joinedAtMs: NOW.getTime() - 60_000 });
  const stack = page.getByTestId('room-voice-people');
  await expect(stack).toHaveAttribute('aria-label', /^В голосе: .+, Борис$/);
  await stack.tap();
  const card = page.getByTestId('voice-people-card');
  await expect(card.getByTestId('voice-people-row')).toHaveCount(2);
  await expect(card.getByTestId('voice-people-row').first()).toContainText('Вы');
  await expect(card.getByTestId('voice-people-row').nth(1).locator('[data-voice-icon="ptt-idle"]')).toHaveCount(1);
  await expect(card.getByTestId('voice-people-leave')).toBeVisible();
  await expectCentredCard(page, card);
  await checkpoint(page, 'm-voice-people-in-call');
  await card.getByTestId('voice-people-leave').tap();
  await expect(strip).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

// Soundboard (ADR-0036): the strip's «Звуки» opens the island's panel as a centred card (voice
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
  // Owner 13.10: the chat-list geometry of a room row — 68 px rows, 44 px avatar.
  for (const row of await list.getByTestId('dm-row').all()) {
    const box = await row.boundingBox();
    expect(box && Math.round(box.height), 'a 68 px DM row').toBe(68);
  }
  // docs/09 #51: a left swipe on Григорий's row reveals «В архив»; tapping it archives the DM
  // («Архив — 1» at the bottom, collapsed). The list stays (the row keeps the gesture).
  await swipeLeft(list.getByRole('button', { name: /Григорий/ }));
  await expect(nav).toBeVisible();
  await checkpoint(page, 'm-dm-swipe', { snapshot: false });
  await nav.getByTestId('dm-swipe-action').getByText('В архив').tap();
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(nav.getByTestId('dm-archive').getByRole('button', { name: 'Архив — 1' })).toHaveAttribute('aria-expanded', 'false');
  await checkpoint(page, 'm-dm-list');

  // CBF-159: the field at the top of the tab searches the messages of my DMs.
  await nav.getByTestId('dm-search').fill('ре');
  await expect(nav.getByTestId('dm-search-hits').getByTestId('dm-hit').first()).toBeVisible();
  await checkpoint(page, 'm-dm-search');
  await nav.getByTestId('dm-search').fill('qzxw');
  await expect(nav.getByTestId('dm-search-empty')).toBeVisible();
  await checkpoint(page, 'm-dm-search-empty');
});

// Count badges (owner 07.10): 1 and 2 digits are perfect circles, 99+ is a pill; tab bar and DM rows.
test('m-badges', async ({ page }) => {
  const burst = (roomId: string, authorId: string, n: number): void => {
    for (let i = 0; i < n; i++) mock.injectMessage({ roomId, authorId, content: `Сообщение ${i + 1}` });
  };
  burst(IDS.dms.vera, IDS.users.vera, 1);
  burst(IDS.dms.boris, IDS.users.boris, 9);
  burst(IDS.dms.grigory, IDS.users.grigory, 99);
  await signedIn(page);
  await tab(page, 'dms');
  const badges = page.locator('[data-count-badge]');
  await expect(badges.filter({ hasText: '99+' }).first()).toBeVisible();
  await settle(page);
  for (const b of await badges.all()) {
    const box = await b.boundingBox();
    const text = ((await b.textContent()) ?? '').trim();
    if (!box) continue;
    const label = `badge «${text}» ${box.width}x${box.height}`;
    if (text.length <= 2) expect(Math.round(box.width), label).toBe(Math.round(box.height));
    else expect(box.width, label).toBeGreaterThan(box.height);
  }
  await checkpoint(page, 'm-badges');
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
  for (const row of await shelves.all()) {
    const box = await row.boundingBox();
    expect(box && Math.round(box.height), 'a 68 px note row').toBe(68);
  }
  await checkpoint(page, 'm-notes');
  // A long press on a shelf: the shelf menu (the «…» items).
  await longPress(shelves.first());
  await expect(page.getByTestId('notes-rename')).toBeVisible();
  await expectMenuCard(page, 'm-notes-menu');
});

/**
 * A finger swipe over the element: `dx` px sideways in 15 px steps (one frame each), from 20 px
 * inside its right edge or from its centre. Synthetic events: desktop WebKit has neither a touch
 * input API for Playwright nor a Touch constructor, so plain events carry `touches` (what React's
 * touch handlers read). `release: false` holds the finger (touchRelease lifts it).
 */
async function touchSwipe(target: Locator, opts: { dx: number; from?: 'right' | 'center'; release?: boolean }): Promise<void> {
  await target.evaluate(async (el, o) => {
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type: string, x: number): void => {
      const t = { identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(ev, { touches: { value: type === 'touchend' ? [] : [t] }, changedTouches: { value: [t] }, targetTouches: { value: type === 'touchend' ? [] : [t] } });
      el.dispatchEvent(ev);
    };
    const x0 = o.from === 'center' ? r.left + r.width / 2 : r.right - 20;
    fire('touchstart', x0);
    const step = Math.sign(o.dx) * 15;
    for (let d = step; Math.abs(d) < Math.abs(o.dx); d += step) {
      fire('touchmove', x0 + d);
      await new Promise((ok) => requestAnimationFrame(ok));
    }
    fire('touchmove', x0 + o.dx);
    await new Promise((ok) => requestAnimationFrame(ok));
    if (o.release === false) (window as unknown as { liftTouch?: () => void }).liftTouch = () => fire('touchend', x0 + o.dx);
    else fire('touchend', x0 + o.dx);
  }, opts);
}

/** Lifts the finger of a `touchSwipe(…, { release: false })`. */
async function touchRelease(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { liftTouch?: () => void }).liftTouch?.());
}

/** A finger swipe to the left over the element (from near its right edge, 120 px). */
async function swipeLeft(target: Locator): Promise<void> {
  await touchSwipe(target, { dx: -120 });
}

/**
 * A finger held still on the element for 800 ms (synthetic touch pointer events: Radix
 * ContextMenu's own 700 ms long press, lib/longPress, lib/phoneMenus's long-press haptic and the
 * press reset all run as on a phone).
 */
async function longPress(target: Locator): Promise<void> {
  await target.evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    await new Promise((ok) => setTimeout(ok, 800));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  });
}

/**
 * A long-press menu is open as the centred card; Esc closes it. Not a tap on the scrim: in WebKit
 * here the menu goes on the press and the tap's pointer-up / click land on the row under it (a
 * list row would open — m-menu taps the scrim over an empty feed).
 */
async function expectMenuCard(page: Page, name: string, snapshot = false): Promise<void> {
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expectCentredCard(page, menu);
  await checkpoint(page, name, { snapshot });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

test('m-dm-chat', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'dms');
  await page.getByTestId('phone-dms').getByTestId('dm-list').getByRole('button', { name: /Борис Петров/ }).tap();
  await expect(page.getByText('Анна, привет! Посмотришь PR с миграцией')).toBeVisible();
  await expectNoFieldFocus(page, 'dm open');
  await feedToBottom(page);
  await checkpoint(page, 'm-dm-chat', { main: true });
  // ADR-0154: «⋯» → «Заблокировать» → the DM shows the unblock note instead of the composer and
  // Борис's messages collapse.
  await page.getByTestId('dm-actions').tap();
  await page.getByTestId('dm-user-block').tap();
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).tap();
  await expect(page.getByTestId('composer-blocked')).toBeVisible();
  await expect(page.getByTestId('message-hidden').first()).toBeVisible();
  await checkpoint(page, 'm-dm-blocked');
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
  await openProfile(page);
  await page.getByTestId('phone-profile-general').tap();
  // «Профиль → Основное» is a screen of the stack (no sheet, no grab handle): the standard header,
  // «‹» pops it back to the profile (ADR-0073, owner 07.10).
  const settings = page.getByTestId('settings-page');
  await expect(settings).toBeVisible();
  await expect(page.getByTestId('sheet-handle')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoFieldFocus(page, 'settings');
  await checkpoint(page, 'm-settings');
  await page.getByTestId('phone-back').tap();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId('phone-profile')).toBeVisible();
  await page.getByTestId('phone-profile-voice').tap();
  await expect(settings).toBeVisible();
  await checkpoint(page, 'm-settings-voice', { snapshot: false });
  // The section scrolls on its screen (its last control can be reached).
  const panel = settings.locator('[data-settings-panel="voice"]');
  const fits = await panel.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.getBoundingClientRect().bottom <= innerHeight + 1 && el.scrollTop > 0;
  });
  expect(fits, 'settings section scrolls on its screen').toBe(true);
  // Board #114: WebKit keeps its own NS (no `noiseSuppression` constraint) — RNNoise is off and
  // disabled here, with the reason under it.
  const noise = panel.getByRole('switch', { name: 'Шумоподавление' });
  await noise.scrollIntoViewIfNeeded();
  await expect(noise).toBeDisabled();
  await expect(panel.getByText('На этом устройстве шум убирает сама система', { exact: false })).toBeVisible();
  await checkpoint(page, 'm-settings-voice-noise', { snapshot: false });
});

// Owner 07.10: no workspace rail — the header's «Команда Calab ⌄» opens the switcher (the desktop's
// list: workspaces with a badge / «в голосе» / check, «Создать» / «Найти», the workspace's items).
// ADR-0092: rooms with a picture — the picture in the 44 px disc of the list row (a private room
// keeps its lock badge) and in the 32 px disc of the room header; the service line in the feed.
test('m-room-picture', async ({ page }) => {
  mock.setRoomPicture(IDS.rooms.general, { bg: [233, 120, 40], fg: [255, 255, 255] }, IDS.users.boris);
  mock.setRoomPicture(IDS.rooms.longPrivate, { bg: [52, 120, 246], fg: [255, 255, 255] }, IDS.users.anna);
  await signedIn(page);
  const list = page.getByTestId('phone-room-list');
  await expect(list.locator('[data-room-icon="picture"] img')).toHaveCount(2);
  const general = list.getByTestId('phone-room-row').filter({ has: page.locator('text=/^общий/') }).first();
  await expect(general.getByTestId('room-preview')).toContainText('изменил(а) картинку комнаты');
  await checkpoint(page, 'm-room-picture');
  await openRoom(page, /^общий/);
  await expect(page.getByTestId('room-header').locator('[data-room-icon="picture"] img')).toBeVisible();
  await feedToBottom(page);
  await expect(page.getByTestId('room-icon-line')).toContainText('Борис Петров изменил(а) картинку комнаты');
  await checkpoint(page, 'm-room-picture-chat', { main: true });
});

test('m-ws-switcher', async ({ page }) => {
  await signedIn(page);
  await page.getByTestId('phone-ws-switcher').tap();
  const menu = page.getByTestId('workspace-switcher');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('switcher-row').first()).toBeVisible();
  expect(await menu.getByTestId('switcher-row').count(), 'two workspaces').toBeGreaterThanOrEqual(2);
  await expect(menu.getByRole('menuitem', { name: 'Создать пространство' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Найти пространство' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Настройки', exact: true })).toBeVisible();
  await checkpoint(page, 'm-ws-switcher');
  // Board #145: READY leaves the open workspace out while its access lease is pending — «Подключение…»
  // on the tab root, never «Создать пространство».
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  mock.readyPending(IDS.workspaces.main);
  await expect(page.getByTestId('shell-connecting')).toBeVisible();
  await checkpoint(page, 'm-ws-pending');
});

test('m-dialog', async ({ page }) => {
  await signedIn(page);
  await page.getByTestId('phone-ws-switcher').tap();
  await page.getByRole('menuitem', { name: 'Создать пространство' }).tap();
  await expect(page.getByRole('dialog', { name: 'Новое пространство' })).toBeVisible();
  await expect(page.getByTestId('sheet-handle')).toHaveCount(0);
  await expectNoFieldFocus(page, 'dialog');
  // A centred card (owner 07.10), not a bottom sheet: the generic «modal centred» invariant checks it.
  await checkpoint(page, 'm-dialog');
});

// ADR-0097 §3: Settings → «Бывшие» on the phone — the same tab as on the desktop, rows wrap under the name.
test('m-former-tab', async ({ page }) => {
  await signedIn(page);
  mock.state.formerMembers.set(IDS.workspaces.main, [
    { userId: IDS.users.vera, role: WorkspaceRole.MEMBER, reason: FormerMemberReason.REMOVED, leftAt: ts('2026-01-14T09:00:00Z'), removedBy: IDS.users.anna, openTasks: 2 },
    { userId: IDS.users.dina, role: WorkspaceRole.MEMBER, reason: FormerMemberReason.LEFT, leftAt: ts('2026-01-05T09:00:00Z'), openTasks: 0 },
  ]);
  await page.getByTestId('phone-ws-switcher').tap();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).tap();
  const dialog = page.getByTestId('settings-page');
  await dialog.getByRole('tab', { name: 'Бывшие' }).tap();
  await expect(dialog.getByTestId('ws-former-row')).toHaveCount(2);
  await checkpoint(page, 'm-former-tab');
});

// ADR-0031: workspace settings → «Боты» as pushed screens — the create form wraps, the bot rows
// keep «…» in reach, the webhook error line truncates.
test('m-settings-bots', async ({ page }) => {
  await signedIn(page);
  mock.seedBots();
  await page.getByTestId('phone-ws-switcher').tap();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).tap();
  // The list of sections is a screen, a section is one more screen over it; «‹» pops one at a time.
  const dialog = page.getByTestId('settings-page');
  await expect(dialog.getByRole('tab', { name: 'Боты' })).toBeVisible();
  await checkpoint(page, 'm-settings-list', { snapshot: false });
  await dialog.getByRole('tab', { name: 'Боты' }).tap();
  await expect(dialog.getByTestId('bot-row')).toHaveCount(2);
  await expectNoFieldFocus(page, 'bots');
  // The list, not the form: the rows are what the phone shot is about.
  await dialog.getByTestId('bot-row').last().scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-settings-bots');
  await page.getByTestId('phone-back').tap();
  await expect(dialog.getByRole('tab', { name: 'Боты' })).toBeVisible();
  // «Голос и стрим»: the workspace defaults down to the join/leave cue threshold (review shot).
  await dialog.getByRole('tab', { name: 'Голос и стрим' }).tap();
  const joinLeave = dialog.getByRole('spinbutton', { name: 'Звук входа и выхода' });
  await expect(joinLeave).toHaveValue('10');
  await joinLeave.scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-settings-media', { snapshot: false });
  await page.getByTestId('phone-back').tap();
  await expect(dialog.getByRole('tab', { name: 'Боты' })).toBeVisible();
  await page.getByTestId('phone-back').tap();
  await expect(dialog).toHaveCount(0);
});

/**
 * ADR-0137 «Телефония» (T3) on a phone: the section's row in «Ещё» with my missed calls; «Недавние»
 * (a call ringing now, a missed one, an outbound one, a long name with a long company, a number
 * without a contact, a hidden number), the loading and empty states, «Пропущенные», the filter card
 * and its chips, a row's swipe and long-press menu, the detail of a transfer (route unfolded), of a
 * missed call, of an outbound call and of a call from before the journal; the tab pinned to the bar.
 */
async function phoneRecents(page: Page): Promise<void> {
  await toRoot(page);
  await page.getByTestId('phone-tab-more').tap();
  const more = page.getByTestId('more-row-telephony');
  await expect(more).toContainText('2');
  await checkpoint(page, 'm-tel-more');
  await more.tap();
  const root = page.getByTestId('phone-telephony');
  await expect(root.getByTestId('tel-group').first()).toHaveText('Сейчас');
  await expectNoFieldFocus(page, 'telephony recents');
  await checkpoint(page, 'm-tel-recents');
  const segment = (name: string): Locator => root.getByTestId('tel-segment').getByRole('radio', { name });

  // «Пропущенные»: the six static rows while the page loads, then the two missed calls.
  const release = mock.holdSipJournal();
  await segment('Пропущенные').tap();
  await expect(root.getByTestId('tel-skeleton')).toBeVisible();
  await checkpoint(page, 'm-tel-recents-loading');
  release();
  await expect(root.getByTestId('tel-row')).toHaveCount(2);
  await checkpoint(page, 'm-tel-missed');
  await segment('Недавние').tap();
  await expect(root.getByTestId('tel-group').first()).toHaveText('Сейчас');

  // The funnel → the centred card; the set filters as chips under the search.
  await root.getByTestId('tel-filter-open').tap();
  const card = page.getByTestId('tel-filter-card');
  await expect(card).toBeVisible();
  await checkpoint(page, 'm-tel-filter-card');
  await card.getByRole('radio', { name: 'Входящие' }).tap();
  await card.getByRole('radio', { name: '7 дней' }).tap();
  await page.getByTestId('tel-filter-done').tap();
  await expect(card).toHaveCount(0);
  await expect(root.getByTestId('tel-chips')).toBeVisible();
  await checkpoint(page, 'm-tel-filter-chips');
  await root.getByTestId('tel-chip-direction').tap();
  await root.getByTestId('tel-chip-period').tap();
  await expect(root.getByTestId('tel-chips')).toHaveCount(0);

  // A row: the left swipe («Подробнее» · «Копировать»), the long-press menu.
  const lutik = root.getByTestId('tel-row').filter({ hasText: 'ООО Лютик' });
  await swipeLeft(lutik);
  await expect(root.getByTestId('tel-swipe')).toBeVisible();
  await checkpoint(page, 'm-tel-row-swipe');
  await lutik.getByTestId('tel-row-tap').tap();
  await expect(root.getByTestId('tel-swipe')).toHaveCount(0);
  await longPress(lutik.getByTestId('tel-row-tap'));
  await expectMenuCard(page, 'm-tel-row-menu', true);

  // The details (pushed screens, «‹» back to the list).
  const detail = page.getByTestId('tel-detail');
  const openDetail = async (text: string): Promise<void> => {
    await root.getByTestId('tel-row').filter({ hasText: text }).getByTestId('tel-row-info').tap();
    await expect(detail.getByTestId('tel-step').first()).toBeVisible();
  };
  await openDetail('Анна Петрова');
  await expect(detail.getByTestId('tel-detail-name')).toHaveText('Анна Петрова');
  await expect(detail.getByTestId('tel-recording')).toContainText('6:20');
  await expect(detail.getByTestId('tel-detail-recording')).toBeVisible();
  await checkpoint(page, 'm-tel-detail-recording');
  await detail.getByTestId('tel-step-rings').first().tap();
  await expect(detail.getByTestId('tel-step-attempts')).toContainText('Вера Ким');
  await detail.getByTestId('tel-step').filter({ hasText: 'переводит' }).scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-tel-detail-transfer');
  await page.getByTestId('phone-back').tap();
  await openDetail('+7 495 765-43-21');
  await checkpoint(page, 'm-tel-detail-missed');
  await page.getByTestId('phone-back').tap();
  await openDetail('ООО Лютик');
  await checkpoint(page, 'm-tel-detail-outbound');
  await page.getByTestId('phone-back').tap();
  // A call from before the journal: the route parsed, no times (the end of the list).
  await root.locator('[data-virtuoso-scroller]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await openDetail('+7 495 111-22-33');
  await detail.getByTestId('tel-route-legacy').scrollIntoViewIfNeeded();
  await expect(detail.getByTestId('tel-route-legacy')).toBeVisible();
  await checkpoint(page, 'm-tel-detail-legacy');
  await page.getByTestId('phone-back').tap();

  // Nothing yet / nothing missed.
  mock.seedSipJournal({ empty: true });
  await segment('Пропущенные').tap();
  await expect(root.getByTestId('tel-empty')).toContainText('Пропущенных нет');
  await checkpoint(page, 'm-tel-missed-empty');
  await segment('Недавние').tap();
  await expect(root.getByTestId('tel-empty')).toContainText('Звонков пока нет');
  await checkpoint(page, 'm-tel-recents-empty');

}

/** «Телефония» from «Ещё» (the section is not pinned in the fixture): its root. */
async function openTelephony(page: Page): Promise<Locator> {
  await toRoot(page);
  await page.getByTestId('phone-tab-more').tap();
  await page.getByTestId('more-row-telephony').tap();
  const root = page.getByTestId('phone-telephony');
  await expect(root).toBeVisible();
  return root;
}

/** A CSV the import previews: one new contact, a number another contact has, a row with no name. */
const CONTACTS_CSV = 'Имя;Компания;Телефон;Заметка\nИрина Белова;ООО Лютик;8 916 000-11-22;\nДубль Анны;;+7 916 123-45-67;\n;;+7 916 000-99-88;\nПётр;;доб. 12;\n';

/**
 * ADR-0137 T4 on a phone: «Контакты» — the third segment (letters, Cyrillic then Latin then «#»,
 * a company without a person, a very long name and company), the FAB over the list's end, a row's
 * swipe and long-press menu, the card (three numbers, a note, the calls), the number choice, the
 * form (with the keyboard up: «Сохранить» above it), a number another contact has, the empty
 * book with «Импорт CSV», its loading, the import preview.
 */
test('m-telephony-contacts', async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(KEYBOARD_STUB);
  await signedIn(page);
  mock.seedSipExchange();
  mock.seedSipJournal();
  mock.seedSipContacts();
  const root = await openTelephony(page);
  const segment = (name: string): Locator => root.getByTestId('tel-segment').getByRole('radio', { name });
  // The six static rows while the first page loads.
  const release = mock.holdSipContacts();
  await segment('Контакты').tap();
  await expect(root.getByTestId('telc-skeleton')).toBeVisible();
  await checkpoint(page, 'm-tel-contacts-loading');
  release();
  const list = root.getByTestId('telc-list');
  await expect(list.getByTestId('telc-letter').first()).toHaveText('А');
  await expect(list.getByTestId('telc-row').filter({ hasText: 'ООО Лютик' })).toBeVisible();
  await expectNoFieldFocus(page, 'telephony contacts');
  await checkpoint(page, 'm-tel-contacts');
  // The FAB over the end of the list: the last row stays above it.
  await root.locator('[data-virtuoso-scroller]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list.getByTestId('telc-letter').filter({ hasText: '#' })).toBeVisible();
  await expect(root.getByTestId('tel-fab')).toBeVisible();
  await checkpoint(page, 'm-tel-fab');
  await root.locator('[data-virtuoso-scroller]').evaluate((el) => el.scrollTo({ top: 0 }));

  // A row: the left swipe («Позвонить» · «Изменить»), the long-press menu.
  const orlov = list.getByTestId('telc-row').filter({ hasText: 'Дмитрий Орлов' });
  await swipeLeft(orlov);
  await expect(root.getByTestId('telc-swipe')).toBeVisible();
  await checkpoint(page, 'm-tel-contact-swipe');
  await orlov.getByTestId('telc-row-tap').tap();
  await expect(root.getByTestId('telc-swipe')).toHaveCount(0);
  await longPress(orlov.getByTestId('telc-row-tap'));
  await expectMenuCard(page, 'm-tel-contact-menu');

  // The card: three numbers, the note, the calls; «Позвонить» → which number.
  await list.getByTestId('telc-row').filter({ hasText: 'Анна Петрова' }).getByTestId('telc-row-tap').tap();
  const card = page.getByTestId('telc-card');
  await expect(card.getByTestId('telc-number')).toHaveCount(3);
  await expect(card.getByTestId('telc-call').first()).toBeVisible();
  await checkpoint(page, 'm-tel-contact-card');
  await card.getByTestId('telc-card-call').tap();
  await expect(page.getByTestId('telc-number-choice')).toBeVisible();
  await expectMenuCard(page, 'm-tel-contact-number-choice', true);

  // The form: the fields, then the keyboard up with «Сохранить» right above it.
  await card.getByTestId('telc-card-edit').tap();
  const form = page.getByTestId('telc-form');
  await expect(form.getByTestId('telc-f-number')).toHaveCount(3);
  await expectNoFieldFocus(page, 'contact form');
  await checkpoint(page, 'm-tel-contact-edit');
  await form.getByTestId('telc-f-company').tap();
  await page.evaluate(() => (window as unknown as KeyboardStub).__keyboard(336));
  await expect(page.locator('html.kb-open')).toHaveCount(1);
  await checkpoint(page, 'm-tel-contact-edit-keyboard', { keyboard: true });
  await page.evaluate(() => (window as unknown as KeyboardStub).__keyboard(null));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // A number another contact has: the error under the numbers with a link to that contact.
  await form.getByTestId('telc-f-number').last().fill('+7 812 333-44-55');
  await form.getByTestId('telc-f-save').tap();
  await expect(form.getByTestId('telc-f-phones-error')).toContainText('Константин');
  await form.getByTestId('telc-f-phones-error').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-tel-contact-dup-error');
  await toRoot(page);

  // An empty book: «Добавить контакт» and, for MANAGE_INTEGRATIONS, «Импорт CSV».
  mock.seedSipContacts({ empty: true });
  await segment('Недавние').tap();
  await segment('Контакты').tap();
  await expect(root.getByTestId('telc-empty')).toContainText('Контактов пока нет');
  await checkpoint(page, 'm-tel-contacts-empty');
  // «Импорт CSV»: a file → the preview with its skips.
  mock.seedSipContacts();
  await root.getByTestId('telc-empty-import').tap();
  await page.getByTestId('telc-import-file').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(CONTACTS_CSV) });
  await expect(page.getByTestId('telc-import-preview')).toContainText('Будет добавлено: 1');
  await checkpoint(page, 'm-tel-import-preview');
  await page.keyboard.press('Escape');
});

/**
 * ADR-0137 T4 «Набор» on a phone: the FAB's screen — empty, a number typed with the contact it
 * belongs to, a colleague's internal number, «+» from a held «0» (iPhone SE: the keypad fits
 * without scrolling — layout invariants on every phone); the call: «Вызов…» full screen, then
 * the band with the tone keypad; an inbound call from a contact — its name, company, number.
 */
test('m-telephony-dial', async ({ page }) => {
  test.setTimeout(300_000);
  await signedIn(page);
  mock.seedSipExchange();
  mock.seedSipJournal();
  mock.seedSipContacts();
  const root = await openTelephony(page);
  await root.getByTestId('tel-fab').tap();
  const dial = page.getByTestId('tel-dial-screen');
  await expect(dial.getByTestId('tel-keypad')).toBeVisible();
  await expectNoFieldFocus(page, 'dial pad');
  await checkpoint(page, 'm-tel-keypad-empty');
  const press = async (keys: string): Promise<void> => {
    for (const k of keys) await dial.locator(`[data-key="${k}"]`).tap();
  };
  const clear = async (): Promise<void> => {
    await longPress(dial.getByTestId('tel-dial-back'));
    await expect(dial.getByTestId('tel-dial-field')).toHaveValue('');
  };
  await press('89161234567');
  await expect(dial.getByTestId('tel-dial-field')).toHaveValue('8 916 123-45-67');
  await expect(dial.getByTestId('tel-dial-suggestion')).toContainText('Анна Петрова');
  await checkpoint(page, 'm-tel-keypad-typed');
  await clear();
  await press('101');
  await expect(dial.getByTestId('tel-dial-suggestion')).toContainText('Борис Петров');
  await expect(dial.getByTestId('tel-dial-suggestion')).toContainText('вн. 101');
  await checkpoint(page, 'm-tel-keypad-extension');
  await clear();
  await longPress(dial.locator('[data-key="0"]'));
  await press('74957001100');
  await expect(dial.getByTestId('tel-dial-field')).toHaveValue('+7 495 700-11-00');
  await expect(dial.getByTestId('tel-dial-suggestion')).toContainText('«Альфа-Сервис»');
  await checkpoint(page, 'm-tel-keypad-plus');
  await clear();

  // The call: «Вызов…» over everything until the answer, then the band with «Клавиатура».
  await press('89161234567');
  await dial.getByTestId('tel-dial-call').tap();
  const calling = page.getByTestId('sip-outgoing');
  await expect(calling).toContainText('Анна Петрова');
  await checkpoint(page, 'm-tel-calling');
  mock.advanceSipPersonal();
  await expect(calling).toHaveCount(0);
  const strip = page.getByTestId('mobile-voice-strip');
  await expect(strip).toContainText('Анна Петрова');
  // Like the iPhone «Телефон»: the name on one line, the call's timer under it.
  await expect(strip.getByTestId('mobile-voice-status')).toHaveText(/^\d{2}:\d{2}$/, { timeout: 30_000 });
  // WebKit here has no microphone: its toast is not what the frame is about.
  while (await page.getByTestId('toast').count()) await page.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).tap();
  expect(await strip.getByTestId('mobile-voice-label').evaluate((el) => el.getBoundingClientRect().height < 24), 'name on one line').toBe(true);
  await checkpoint(page, 'm-tel-in-call', { mask: [strip.getByTestId('mobile-voice-status')] });
  await strip.getByTestId('dtmf-open').tap();
  const pad = page.getByTestId('dtmf-pad');
  for (const k of '12#') await pad.locator(`[data-key="${k}"]`).tap();
  await expect(page.getByTestId('dtmf-typed')).toHaveText('12#');
  await checkpoint(page, 'm-tel-in-call-dtmf', { mask: [strip.getByTestId('mobile-voice-status')] });
  await page.keyboard.press('Escape');
  await strip.getByRole('button', { name: 'Отключиться' }).tap();
  await expect(strip).toHaveCount(0);

  // An inbound call from a contact's number: the name big, the company, the number under them.
  mock.ringSipInbound(IDS.users.anna, '+78123334455', 'Отдел продаж');
  const ring = page.getByTestId('sip-incoming');
  await expect(ring.getByTestId('call-sheet-title')).toContainText('Константин');
  await expect(ring).toContainText('+7 812 333-44-55');
  await checkpoint(page, 'm-call-incoming-contact');
});

/** «Набор» without PLACE_CALLS (Вера, a member with an internal number): the note; colleagues' numbers still dial. */
test('m-telephony-no-place-calls', async ({ page }) => {
  await open(page, '/');
  await page.getByLabel('Email').fill('vera@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).tap();
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  mock.seedSipExchange();
  const root = await openTelephony(page);
  await root.getByTestId('tel-fab').tap();
  const dial = page.getByTestId('tel-dial-screen');
  await expect(dial.getByTestId('tel-dial-no-place')).toBeVisible();
  await checkpoint(page, 'm-tel-no-place-calls');
  for (const k of '84951') await dial.locator(`[data-key="${k}"]`).tap();
  await expect(dial.getByTestId('tel-dial-suggestion')).toHaveText('Только внутренние номера');
  await expect(dial.getByTestId('tel-dial-call')).toBeDisabled();
  // A colleague's internal number still dials.
  await longPress(dial.getByTestId('tel-dial-back'));
  for (const k of '101') await dial.locator(`[data-key="${k}"]`).tap();
  await expect(dial.getByTestId('tel-dial-suggestion')).toContainText('Борис Петров');
  await expect(dial.getByTestId('tel-dial-call')).toBeEnabled();
});

// ADR-0046 addendum «Тональный набор»: a voice room's answered phone line on a phone — the
// header's «В голосе» card lists it after the people («+7 495 123-45-67 доб. 101», «Клавиатура»,
// «Завершить»); «Клавиатура» opens the shared tone pad as a centred card over it (owner 07.10: no
// bottom sheets), a level the «‹» or a tap on the card beneath takes back.
test('m-telephony-room-keypad', async ({ page }) => {
  await signedIn(page);
  mock.seedSipExchange();
  await openRoom(page, /^Созвон/);
  await page.getByTestId('room-header-join').tap();
  const strip = page.getByTestId('mobile-voice-strip');
  await expect(strip.getByTestId('mobile-voice-status')).toHaveText(/подключ|\d{2}:\d{2}/i, { timeout: 30_000 });
  mock.placeSipCall(IDS.rooms.call, IDS.users.anna, '+74951234567', SipCallStatus.ACTIVE, 65_000, '101');
  // WebKit here has no microphone: its toast is not what the frames are about.
  await page.getByTestId('toast').first().waitFor({ timeout: 5000 }).catch(() => undefined);
  while (await page.getByTestId('toast').count()) await page.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).tap();
  await page.getByTestId('room-voice-people').tap();
  const card = page.getByTestId('voice-people-card');
  const line = card.getByTestId('sip-call-row');
  await expect(line).toHaveAttribute('aria-label', 'Телефон +7 495 123-45-67 доб. 101');
  await expect(line.getByTestId('sip-call-ext')).toHaveText('· доб. 101');
  await expect(line.getByTestId('sip-hangup')).toBeVisible();
  await checkpoint(page, 'm-room-call-line', { mask: [line.getByTestId('sip-status'), strip.getByTestId('mobile-voice-status')] });
  await line.getByTestId('sip-keypad').tap();
  const sheet = page.getByTestId('sip-keypad-popover');
  await expect(sheet.getByTestId('dtmf-for')).toHaveText('Тоновый набор: +7 495 123-45-67 доб. 101');
  for (const k of '2#') await sheet.locator(`[data-key="${k}"]`).tap();
  await expect(sheet.getByTestId('dtmf-typed')).toHaveText('2#');
  await checkpoint(page, 'm-room-call-keypad', { mask: [strip.getByTestId('mobile-voice-status')] });
});

// «Телефония» pinned to the bar (in place of «Календарь»): the tab with my missed calls.
test('m-telephony-pinned', async ({ page }) => {
  await signedIn(page, { phonePinnedTabs: ['chats', 'dms', 'boards', 'telephony'] });
  mock.seedSipExchange();
  mock.seedSipJournal();
  await expect(page.getByTestId('phone-tab-telephony')).toContainText('2');
  await checkpoint(page, 'm-tel-pinned');
});

test('m-telephony-recents', async ({ page }) => {
  test.setTimeout(300_000);
  await signedIn(page);
  mock.seedSipExchange();
  mock.seedSipJournal();
  await phoneRecents(page);
});

/**
 * ADR-0137 §7 (T5): the station's settings on a phone — no tables, a drill-down list. The admin
 * before anything is connected (the empty state, the connection form with a field error); then ⚙ →
 * the list with values, «Входящие» over a registration (registered, then refused) with the entry
 * point's target card, the numbers and a number's form (sticky «Сохранить» above the keyboard), a
 * group with its order handles, the menus and a menu's 3×4 keys with the action card and its
 * second level, the greeting and the notice rows, recording, retention and limits, the working
 * hours (two intervals on Monday, a Friday night shift) and their off-hours action; a profile's
 * internal number — the admin's edit with a taken number, a member's own read-only. Then the
 * incoming call (ADR-0117 step 2) and its transfer (ADR-0132).
 */
test('m-telephony', async ({ page }) => {
  test.setTimeout(600_000);
  await page.addInitScript(KEYBOARD_STUB);
  await signedIn(page);
  mock.seedSipExchange(true);
  mock.setSip(IDS.workspaces.main, null);
  await tab(page, 'telephony');
  const root = page.getByTestId('phone-telephony');
  await expect(root.getByTestId('tel-not-connected')).toContainText('Подключите SIP-провайдера');
  await expectNoFieldFocus(page, 'telephony not connected');
  await checkpoint(page, 'm-tel-not-connected');
  await root.getByTestId('tel-connect').tap();
  const screen = page.getByTestId('tel-phone-settings');
  await expect(screen.getByTestId('sip-form')).toBeVisible();
  await expectNoFieldFocus(page, 'telephony connection');
  await screen.getByTestId('sip-host').fill('sip:bad host');
  await screen.getByTestId('sip-save').tap();
  await expect(screen.getByTestId('sip-err-host')).toBeVisible();
  await checkpoint(page, 'm-tel-settings-connection');
  await page.getByTestId('phone-back').tap();

  // Connected: ⚙ in the root's header → the list with each page's value.
  mock.seedSipExchange();
  mock.setSipRegistration('registered');
  mock.seedSipSchedule();
  // The account the connection screen cached is the never-saved one (the clock is fixed: it never goes stale).
  await page.reload();
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await tab(page, 'telephony');
  await expect(root.getByTestId('tel-settings-open')).toBeVisible();
  await checkpoint(page, 'm-tel-root-admin');
  await root.getByTestId('tel-settings-open').tap();
  const list = page.getByTestId('tset-list');
  await expect(list.getByTestId('tset-row-numbers')).toContainText('4');
  await expect(list.getByTestId('tset-row-schedule')).toContainText('РФ календарь → Выходные');
  await checkpoint(page, 'm-tel-settings');
  const row = async (id: string): Promise<void> => {
    await page.getByTestId(`tset-row-${id}`).tap();
    await expect(screen).toHaveAttribute('data-page', id);
  };

  // «Входящие»: the registration's state, the entry point as a row → the target card.
  await row('inbound');
  await expect(screen.getByTestId('sip-reg-status')).toContainText('Зарегистрировано до 13:39');
  await checkpoint(page, 'm-tel-settings-inbound');
  await screen.getByTestId('sip-inbound-target').tap();
  const card = page.getByTestId('tset-target-card');
  await expect(card).toBeVisible();
  await checkpoint(page, 'm-tel-target-card');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  mock.setSipRegistration('failed');
  await screen.getByTestId('sip-inbound-save').tap();
  await expect(screen.getByTestId('sip-reg-status')).toContainText('Ошибка регистрации');
  // «Сохранено» stays while the clock is fixed and would sit over the next screens: close it.
  await expect(page.getByTestId('toast')).toHaveCount(1);
  while (await page.getByTestId('toast').count()) await page.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).tap();
  await screen.getByTestId('sip-reg-status').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-tel-settings-inbound-failed');
  await page.getByTestId('phone-back').tap();

  // «Внутренние номера»: rows 56 px → a number's form; the field focused with the keyboard up —
  // «Сохранить» stays right above it.
  await row('numbers');
  await expect(screen.getByTestId('sip-ext-row')).toHaveCount(4);
  await checkpoint(page, 'm-telephony');
  await screen.getByTestId('sip-ext-row').filter({ hasText: 'Борис' }).tap();
  await expect(screen.getByTestId('sip-ext-form')).toBeVisible();
  await expectNoFieldFocus(page, 'number form');
  await checkpoint(page, 'm-telephony-number-no-external');
  await screen.getByTestId('sip-ext-number').tap();
  await page.evaluate((h) => (window as unknown as KeyboardStub).__keyboard(h), 300);
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await checkpoint(page, 'm-tel-save-keyboard', { keyboard: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => (window as unknown as KeyboardStub).__keyboard(null));
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-back').tap();

  // «Группы»: «Отдел продаж» — the members as rows with ×; «Изменить порядок» swaps them for handles.
  await row('groups');
  await screen.getByTestId('sip-group-row').filter({ hasText: 'Отдел продаж' }).tap();
  await expect(screen.getByTestId('sip-group-member')).toHaveCount(3);
  await checkpoint(page, 'm-telephony-group');
  await screen.getByTestId('sip-group-reorder').tap();
  await expect(screen.getByTestId('sip-group-drag')).toHaveCount(3);
  await screen.getByTestId('sip-group-members').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-tel-group-reorder');
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-back').tap();

  // «Автоответ»: the menus → «Главное меню»: the keys as a 3×4 tile grid (9 leads to a deleted
  // menu), a tile → the action card, «Группа ›» → the second level.
  await row('ivr');
  await checkpoint(page, 'm-telephony-ivr');
  await screen.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).tap();
  await expect(screen.getByTestId('sip-menu-key-9')).toHaveAttribute('data-value', 'missing');
  await screen.getByTestId('sip-menu-keys').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-telephony-menu');
  await screen.getByTestId('sip-menu-key-1').tap();
  await expect(card).toBeVisible();
  await checkpoint(page, 'm-tel-ivr-key-picker');
  await card.getByTestId('tset-target-groups').tap();
  await expect(card.getByRole('radio', { name: /Отдел продаж/ })).toHaveAttribute('aria-checked', 'true');
  await checkpoint(page, 'm-tel-ivr-key-picker-groups');
  await card.getByRole('radio', { name: /Поддержка/ }).tap();
  await expect(card).toHaveCount(0);
  await expect(screen.getByTestId('sip-menu-key-1')).toContainText('Поддержка');
  // The greeting row on a phone: ▶, the length, «Заменить» / «Удалить запись», a refused file.
  await screen.getByTestId('sip-menu-prompt-file').setInputFiles({ name: 'greeting.docx', mimeType: 'application/msword', buffer: Buffer.from('doc') });
  await expect(screen.getByTestId('sip-menu-prompt-error')).toHaveText('Этот файл не подходит — нужен MP3, WAV или OGG');
  await screen.getByTestId('sip-menu-prompt').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-telephony-prompt');
  await screen.getByTestId('sip-menu-notice').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-telephony-menu-notice');
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-back').tap();

  // «Запись звонков», «Хранение и лимиты».
  await row('recording');
  await expect(screen.getByTestId('sip-recording')).toBeVisible();
  await checkpoint(page, 'm-tel-recording');
  await page.getByTestId('phone-back').tap();
  await row('policy');
  await expect(screen.getByRole('radio', { name: '1 год' })).toHaveAttribute('aria-checked', 'true');
  await checkpoint(page, 'm-tel-retention');
  await page.getByTestId('phone-back').tap();

  // «Рабочие часы» (ADR-0138): Monday's two intervals, the Friday night shift, the off-hours action.
  await row('schedule');
  await expect(screen.getByTestId('tset-day-1').getByTestId('tset-interval')).toHaveCount(2);
  await checkpoint(page, 'm-tel-schedule');
  await screen.getByTestId('tset-day-5').scrollIntoViewIfNeeded();
  await expect(screen.getByTestId('tset-day-5').getByTestId('tset-interval-night')).toHaveText('до утра — Сб');
  await checkpoint(page, 'm-tel-schedule-night');
  await screen.getByTestId('tset-schedule-target').scrollIntoViewIfNeeded();
  await checkpoint(page, 'm-tel-schedule-off-hours');
  await toRoot(page);

  // The internal number in a profile: the admin's pencil, a taken number says whose it is.
  await openRoom(page, /^общий/);
  await page.getByRole('button', { name: 'Участники' }).tap();
  await page.getByTestId('members-page').getByRole('button', { name: /Борис Петров/ }).tap();
  const profile = page.getByRole('dialog', { name: 'Борис Петров' });
  await expect(profile.getByTestId('profile-extension')).toContainText('101');
  await checkpoint(page, 'm-tel-profile-extension');
  await profile.getByTestId('profile-extension-edit').tap();
  await profile.getByTestId('profile-extension-input').fill('102');
  await profile.getByTestId('profile-extension-save').tap();
  await expect(profile.getByTestId('profile-extension-error')).toHaveText('Номер 102 уже у: Вера Ким');
  await checkpoint(page, 'm-tel-profile-extension-conflict');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await toRoot(page);

  // ADR-0117 step 2: an inbound call rings me — the sheet takes the whole screen.
  mock.ringSipInbound(IDS.users.anna, '+79161234567', 'Отдел продаж');
  const ring = page.getByTestId('sip-incoming');
  await expect(ring).toContainText('Входящий на номер · Отдел продаж');
  await checkpoint(page, 'm-sip-incoming');
  await ring.getByRole('button', { name: 'Отклонить' }).tap();
  await expect(ring).toHaveCount(0);
  // ADR-0132: the next call taken — the strip's round «Перевести» (in place of the camera) opens
  // the picker as a centred card; a pick rings Борис: «Переводим: Борис» above the strip.
  await toRoot(page);
  mock.ringSipInbound(IDS.users.anna, '+79161234567', 'Отдел продаж');
  await ring.getByRole('button', { name: 'Принять' }).tap();
  const strip = page.getByTestId('mobile-voice-strip');
  // The transfer does not wait for the media: WebKit's LiveKit link may still be connecting — masked.
  const status = [strip.getByTestId('mobile-voice-status')];
  // ADR-0133: a room parked by the call (WebKit's link cannot connect here to park one for real):
  // «Комната: Созвон — на паузе» · «Выйти» above the strip.
  await expect(strip).toBeVisible();
  await page.evaluate((ids) => (window as unknown as { __calabaParked?: (p: { roomId: string; workspaceId: string } | null) => void }).__calabaParked?.({ roomId: ids[0], workspaceId: ids[1] }), [IDS.rooms.call, IDS.workspaces.main]);
  await expect(strip.getByTestId('voice-parked')).toContainText('Комната: Созвон — на паузе');
  await checkpoint(page, 'm-sip-parked', { mask: status });
  await page.evaluate(() => (window as unknown as { __calabaParked?: (p: null) => void }).__calabaParked?.(null));
  await strip.getByTestId('sip-transfer').tap();
  const picker = page.getByTestId('sip-transfer-picker');
  await expect(picker.getByRole('option', { name: /Борис/ })).toBeVisible();
  await expectNoFieldFocus(page, 'transfer picker');
  await checkpoint(page, 'm-sip-transfer-picker', { mask: status });
  await picker.getByRole('option', { name: /Борис/ }).tap();
  const transferring = strip.getByTestId('sip-transferring');
  await expect(transferring).toContainText('Переводим: Борис');
  await checkpoint(page, 'm-sip-transferring', { mask: status });
  await transferring.getByRole('button', { name: 'Отменить перевод' }).tap();
  await expect(transferring).toHaveCount(0);
  await strip.getByRole('button', { name: 'Отключиться' }).tap();
  await expect(strip).toHaveCount(0);

  // A member sees their own internal number read-only (no pencil): Вера (a member) on her own card.
  await openProfile(page);
  await page.getByTestId('phone-profile-logout').tap();
  await page.getByLabel('Email').fill('vera@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).tap();
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  // «Сессия завершена…» of Анна's logout stays while the clock is fixed: close it.
  await page
    .getByTestId('toast')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  while (await page.getByTestId('toast').count()) await page.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).tap();
  await openRoom(page, /^общий/);
  await page.getByRole('button', { name: 'Участники' }).tap();
  await page.getByTestId('members-page').getByRole('button', { name: /Вера Ким/ }).tap();
  const own = page.getByRole('dialog', { name: 'Вера Ким' });
  await expect(own.getByTestId('profile-extension')).toContainText('102');
  await expect(own.getByTestId('profile-extension-edit')).toHaveCount(0);
  await checkpoint(page, 'm-tel-profile-extension-own');
});

// ADR-0073 (owner 07.10): a pushed screen slides in from the right, a pop slides it out; the copy of
// the outgoing screen is removed when the animation ends (only the top screen stays mounted). The
// run's reduced-motion default is lifted here; the animations are paused mid-way for the shot.
test('m-screen-slide', async ({ page }) => {
  await signedIn(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ghost = page.locator('[data-screen-ghost]');
  const midFrame = async (name: string): Promise<void> => {
    await expect(ghost).toHaveCount(1);
    await page.evaluate(() =>
      document.getAnimations().forEach((a) => {
        a.pause();
        a.currentTime = 125;
      }),
    );
    const dir = process.env['CALABA_MOBILE_SHOTS'];
    if (dir) await page.screenshot({ path: join(dir, `${name}-${test.info().project.name}.png`) });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    await expect(ghost).toHaveCount(0);
  };
  await page.getByTestId('phone-room-list').getByRole('button', { name: /^общий/ }).first().tap();
  await midFrame('m-screen-push-mid');
  await expect(page.getByTestId('composer')).toBeVisible();
  await page.getByTestId('phone-back').tap();
  await midFrame('m-screen-pop-mid');
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  // Back stays one screen per tap while the pop is still running.
  await page.getByTestId('phone-room-list').getByRole('button', { name: /^общий/ }).first().tap();
  await expect(page.getByTestId('composer')).toBeVisible();
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

// docs/09 #55: «Пригласить» from a room's menu (long press) — the guest link first, on a settings screen.
test('m-room-invite', async ({ page }) => {
  await signedIn(page);
  const nav = page.getByTestId('phone-room-list');
  await nav.getByTestId('phone-room-row').filter({ hasText: 'общий' }).first().dispatchEvent('contextmenu', { clientX: 120, clientY: 300 });
  await page.getByRole('menuitem', { name: 'Пригласить' }).tap();
  // «Приглашения» of the workspace settings: a screen of the stack, not a sheet (ADR-0073, owner 07.10).
  const dialog = page.getByTestId('settings-page');
  await expect(dialog.getByText('Пригласить гостя без регистрации')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Ссылка для гостей' })).toHaveValue(/\/r\/general-guest-link$/);
  await expectNoFieldFocus(page, 'room invite');
  // The link carries the mock's (random) port: masked.
  await checkpoint(page, 'm-room-invite', { mask: [dialog.getByRole('textbox', { name: 'Ссылка для гостей' })] });
});

type KeyboardStub = { __keyboard: (px: number | null) => void };

/** The init script of the keyboard stand-in (see m-keyboard): `window.__keyboard(px | null)`. */
const KEYBOARD_STUB = (): void => {
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
};

/**
 * The on-screen keyboard (lib/mobile.ts installVisualViewport). WebKit here has no software
 * keyboard: visualViewport is replaced by a stand-in whose height the test shrinks, as iOS does
 * while the keyboard is up — and keeps shrunk after the field loses focus, as iOS 26 sometimes
 * does (the stale viewport that left an empty band at the bottom).
 */
test('m-keyboard', async ({ page }) => {
  await page.addInitScript(KEYBOARD_STUB);
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

// ADR-0143: an office file on the phone — a full-screen view with a back arrow, view only, no tab
// strip; «Создать» makes a blank file that stays in the Disk with a note (editing is on a computer).
// The editor is on in the mock per test: `pnpm -F @calaba/desktop e2e:visual:mobile -g m-office`.
test('m-office-view', async ({ page }) => {
  mock.setOffice(true);
  await signedIn(page, { diskView: 'list' });
  await tab(page, 'disk');
  const root = page.getByTestId('phone-disk');
  await root.getByTestId('disk-row').filter({ hasText: 'Бюджет 2026.xlsx' }).getByTestId('disk-row-open').tap();
  const view = page.getByTestId('office-view');
  await expect(view).toHaveAttribute('data-mode', 'view');
  await expect(view).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('office-view-badge')).toBeVisible();
  await expect(page.getByTestId('task-tabs')).toHaveCount(0);
  await checkpoint(page, 'm-office-view');
  await page.getByTestId('office-back').tap();
  await expect(view).toHaveCount(0);

  await page.getByTestId('disk-create').tap();
  await expect(page.getByTestId('disk-new-pptx')).toBeVisible();
  await checkpoint(page, 'm-office-create-menu');
  await page.getByTestId('disk-new-xlsx').tap();
  await expect(page.getByText('Править его можно на компьютере')).toBeVisible();
  await expect(root.getByTestId('disk-row').filter({ hasText: 'Новая таблица.xlsx' })).toBeVisible();
  await expect(view).toHaveCount(0);
  await checkpoint(page, 'm-office-created');
});

// ADR-0094 §8: «Диск» on the phone — the tab root (the workspace root as 56 px rows), a folder and
// the trash as pushed screens, the item card, the desktop's dialogs as centred cards.
test('m-disk-root', async ({ page }) => {
  await signedIn(page, { diskView: 'list' });
  await tab(page, 'disk');
  const root = page.getByTestId('phone-disk');
  await expect(root.getByTestId('disk-row')).toHaveCount(9);
  await expect(root.getByTestId('disk-row').first()).toContainText('Дизайн');
  await checkpoint(page, 'm-disk-root');
  // CBF-20: a file without a viewer opens its card (a sheet), not a download.
  await root.getByTestId('disk-row').filter({ hasText: 'Бюджет 2026.xlsx' }).getByTestId('disk-row-open').tap();
  await expect(page.getByTestId('disk-file-card')).toBeVisible();
  await checkpoint(page, 'm-disk-file-card', { snapshot: false });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('disk-file-card')).toHaveCount(0);
  // Tiles: two columns.
  await root.getByTestId('phone-disk-more').tap();
  await page.getByTestId('phone-disk-view-tiles').tap();
  await expect(root.getByTestId('disk-tile')).toHaveCount(9);
  await checkpoint(page, 'm-disk-tiles', { snapshot: false });
  // «⋯» card: view, sort, trash, history, usage.
  await root.getByTestId('phone-disk-more').tap();
  await expect(page.getByTestId('phone-disk-more-menu')).toBeVisible();
  await checkpoint(page, 'm-disk-more', { snapshot: false });
  await page.getByTestId('disk-open-usage').tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkpoint(page, 'm-disk-usage', { snapshot: false });
});

test('m-disk-folder', async ({ page }) => {
  await signedIn(page, { diskView: 'list' });
  await tab(page, 'disk');
  await page.getByTestId('disk-row').filter({ hasText: 'Проекты' }).getByTestId('disk-row-open').tap();
  const folder = page.getByTestId('phone-disk-folder');
  await expect(folder).toBeVisible();
  await expect(folder.getByTestId('phone-header')).toContainText('Проекты');
  await expect(folder.getByTestId('disk-row')).toHaveCount(1);
  await checkpoint(page, 'm-disk-folder');
  // CBF-22: a text file opens the read-only viewer (tap), the type plates read in the rows.
  await folder.getByTestId('disk-row').getByTestId('disk-row-open').tap();
  await expect(folder.getByTestId('disk-row')).toHaveCount(4);
  await checkpoint(page, 'm-disk-type-icons');
  await folder.getByTestId('disk-row').filter({ hasText: 'План релиза.md' }).getByTestId('disk-row-open').tap();
  await expect(page.getByTestId('disk-view-markdown')).toBeVisible();
  await checkpoint(page, 'm-disk-preview-text');
  await page.keyboard.press('Escape');
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('phone-disk')).toBeVisible();
});

test('m-disk-item-menu', async ({ page }) => {
  await signedIn(page, { diskView: 'list' });
  await tab(page, 'disk');
  const row = page.getByTestId('disk-row').filter({ hasText: 'Отчёт за квартал.pdf' });
  await row.getByTestId('disk-item-more').tap();
  const menu = page.getByTestId('disk-item-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('disk-menu-move')).toBeVisible();
  await checkpoint(page, 'm-disk-item-menu');
  // «Переместить» is the desktop's dialog, as a centred card.
  await menu.getByTestId('disk-menu-move').tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkpoint(page, 'm-disk-move', { snapshot: false });
  // CBF-161: «Доступ» of a restricted folder with the third level «Управление».
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('disk-row').filter({ hasText: 'Договоры' }).getByTestId('disk-item-more').tap();
  await page.getByTestId('disk-item-menu').getByTestId('disk-menu-access').tap();
  const boris = page.getByTestId('disk-access-row').filter({ hasText: 'Борис' }).getByTestId('disk-access-level');
  await boris.selectOption('manage');
  await expect(boris).toHaveValue('manage');
  await checkpoint(page, 'm-disk-share-levels', { snapshot: false });
});

test('m-disk-trash', async ({ page }) => {
  await signedIn(page, { diskView: 'list' });
  await tab(page, 'disk');
  await page.getByTestId('phone-disk-more').tap();
  await page.getByTestId('disk-open-trash').tap();
  const trash = page.getByTestId('phone-disk-folder');
  await expect(trash.getByTestId('disk-row')).toHaveCount(2);
  await expect(trash.getByTestId('phone-header')).toContainText('Корзина');
  await checkpoint(page, 'm-disk-trash');
  await trash.getByTestId('phone-disk-more').tap();
  await expect(page.getByTestId('disk-empty-trash')).toBeVisible();
  await checkpoint(page, 'm-disk-trash-menu', { snapshot: false });
});

// ADR-0096 §7: «Вики» on the phone — the tab root (top-level pages as 56 px rows), a page as a pushed
// screen (cover, icon, title, the document, subpages), the toolbar above the keyboard, the public page.
test('m-wiki-root', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'wiki');
  const root = page.getByTestId('phone-wiki');
  await expect(root.getByTestId('phone-wiki-row')).toHaveCount(3);
  await expect(root.getByTestId('phone-wiki-row').first()).toContainText('Справочник команды');
  await checkpoint(page, 'm-wiki-root');
  await root.getByTestId('phone-wiki-more').tap();
  await expect(page.getByTestId('phone-wiki-more-menu')).toBeVisible();
  await checkpoint(page, 'm-wiki-root-menu', { snapshot: false });
});

test('m-wiki-page', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'wiki');
  await page.getByTestId('phone-wiki-row').filter({ hasText: 'Справочник команды' }).getByRole('button').tap();
  const screen = page.getByTestId('phone-wiki-page');
  await expect(screen).toBeVisible();
  await expect(screen.getByTestId('phone-header')).toContainText('Справочник команды');
  await expect(screen.locator('.wiki-prose')).toContainText('Первая неделя');
  await expect(screen.getByTestId('wiki-subpages').getByTestId('phone-wiki-row')).toHaveCount(3);
  await expectNoFieldFocus(page, 'wiki page');
  await checkpoint(page, 'm-wiki-page');
  // «⋯»: the desktop's actions as a centred card; «Доступ» is the desktop's dialog.
  await screen.getByTestId('phone-wiki-page-more').tap();
  await expect(page.getByTestId('phone-wiki-page-menu')).toBeVisible();
  await checkpoint(page, 'm-wiki-page-menu', { snapshot: false });
  await page.getByTestId('wiki-menu-access').tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkpoint(page, 'm-wiki-share', { snapshot: false });
});

test('m-wiki-toolbar', async ({ page }) => {
  await page.addInitScript(KEYBOARD_STUB);
  await signedIn(page);
  await tab(page, 'wiki');
  await page.getByTestId('phone-wiki-row').filter({ hasText: 'Справочник команды' }).getByRole('button').tap();
  const screen = page.getByTestId('phone-wiki-page');
  const prose = screen.locator('.wiki-prose');
  await expect(prose).toContainText('Первая неделя');
  await expect(screen.getByTestId('wiki-phone-toolbar')).toHaveCount(0);
  // Pages open for reading (3.4.1): the pencil in the header switches to editing.
  await expect(prose).toHaveAttribute('contenteditable', 'false');
  await screen.getByTestId('wiki-edit-toggle').tap();
  await expect(prose).toHaveAttribute('contenteditable', 'true');
  await prose.getByText('Зачем этот раздел').tap();
  await page.evaluate((h) => (window as unknown as KeyboardStub).__keyboard(h), 300);
  const bar = screen.getByTestId('wiki-phone-toolbar');
  await expect(bar).toBeVisible();
  const vh = page.viewportSize()?.height ?? 0;
  await expect
    .poll(async () => {
      const box = await bar.boundingBox();
      return box && Math.round(box.y + box.height);
    }, 'toolbar right above the keyboard')
    .toBe(vh - 300);
  await checkpoint(page, 'm-wiki-toolbar', { keyboard: true });
  // «+»: the block menu as a card in the middle of the screen.
  await bar.getByTestId('wiki-tool-add').tap();
  await expect(page.getByTestId('wiki-block-menu')).toBeVisible();
  await checkpoint(page, 'm-wiki-blocks', { snapshot: false, keyboard: true });
  await page.getByTestId('wiki-block-menu').getByRole('option', { name: /Цитата/ }).tap();
  await expect(prose.locator('blockquote')).toHaveCount(2);
});

test('m-wiki-trash', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'wiki');
  await page.getByTestId('phone-wiki-more').tap();
  await page.getByTestId('phone-wiki-open-trash').tap();
  const trash = page.getByTestId('phone-wiki-trash');
  await expect(trash.getByTestId('phone-wiki-trash-row')).toHaveCount(2);
  await checkpoint(page, 'm-wiki-trash', { snapshot: false });
});

// ADR-0126 §5 / ADR-0127 wave 5b: «Холст» on the phone — the section behind «Ещё», the tree as 56 px rows, a
// folder and a canvas as pushed screens; the canvas opens in view mode (pans with a finger, pinches, has the
// zoom bar; no tools or panels) and «Править» in the header turns on the edit mode (m-canvas-edit).
test('m-canvas-root', async ({ page }) => {
  await signedIn(page);
  await toRoot(page);
  // Behind «Ещё» by default (ADR-0095): the card lists the section.
  await page.getByTestId('phone-tab-more').tap();
  await expect(page.getByTestId('more-row-canvas')).toBeVisible();
  await checkpoint(page, 'm-canvas-more', { snapshot: false });
  await page.getByTestId('more-row-canvas').tap();
  const root = page.getByTestId('phone-canvas');
  await expect(root.getByTestId('phone-canvas-row')).toHaveCount(4);
  await expect(root.getByTestId('phone-canvas-row').first()).toContainText('Продукт');
  await expect(root.getByTestId('phone-tabbar')).toHaveCount(0);
  await checkpoint(page, 'm-canvas-root');
  // The magnifier filters by name; nothing to create or to trash on the phone.
  await root.getByTestId('phone-search').tap();
  await root.getByTestId('phone-canvas-search-field').fill('спринт');
  await expect(root.getByTestId('phone-canvas-row')).toHaveCount(1);
  await checkpoint(page, 'm-canvas-search', { snapshot: false });
});

test('m-canvas-folder', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'canvas');
  await page.getByTestId('phone-canvas-row').filter({ hasText: 'Продукт' }).getByRole('button').tap();
  const folder = page.getByTestId('phone-canvas-folder');
  await expect(folder.getByTestId('phone-header')).toContainText('Продукт');
  await expect(folder.getByTestId('phone-canvas-row')).toHaveCount(2);
  await checkpoint(page, 'm-canvas-folder');
});

test('m-canvas-view', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'canvas');
  await page.getByTestId('phone-canvas-row').filter({ hasText: 'Продукт' }).getByRole('button').tap();
  await page.getByTestId('phone-canvas-row').filter({ hasText: 'Дорожная карта Q1' }).getByRole('button').tap();
  const screen = page.getByTestId('phone-canvas-screen');
  await expect(screen.getByTestId('phone-header')).toContainText('Дорожная карта Q1');
  const view = screen.getByTestId('canvas-view');
  await expect(view.getByTestId('canvas-zoom')).toBeVisible();
  // View mode by default, whatever the grant (the owner can write): no tools, no panels, no help, no chip, no note —
  // the way to edit is «Править» in the header.
  for (const id of ['canvas-toolbar', 'canvas-history', 'canvas-props', 'canvas-help', 'canvas-presence', 'canvas-view-only', 'canvas-phone-toolbar', 'canvas-phone-note']) await expect(view.getByTestId(id)).toHaveCount(0);
  await expect(screen.getByTestId('phone-canvas-edit')).toHaveText('Править');
  await expectNoFieldFocus(page, 'canvas view');
  await view.getByTestId('canvas-fit-all').tap();
  await checkpoint(page, 'm-canvas-view');

  // Pinch: two touch pointers moving apart zoom in; one finger pans (synthetic pointer events: Playwright has no multi-touch gesture).
  const pct = async (): Promise<number> => Number(/\d+/.exec((await view.getByTestId('canvas-zoom-pct').textContent()) ?? '')?.[0]);
  const before = await pct();
  await view.getByTestId('canvas-surface').evaluate((el) => {
    const fire = (type: string, id: number, x: number, y: number): void => {
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    fire('pointerdown', 1, cx - 40, cy);
    fire('pointerdown', 2, cx + 40, cy);
    for (let i = 1; i <= 5; i++) {
      fire('pointermove', 1, cx - 40 - i * 15, cy);
      fire('pointermove', 2, cx + 40 + i * 15, cy);
    }
    fire('pointerup', 2, cx + 115, cy);
    fire('pointerup', 1, cx - 115, cy);
  });
  await expect.poll(pct, 'pinch out zooms in').toBeGreaterThan(before);
  // The zoom bar's «100 %» resets; nothing was edited on the way (the canvas has no tools to edit with).
  await view.getByTestId('canvas-zoom-pct').tap();
  await expect.poll(pct).toBe(100);
  await checkpoint(page, 'm-canvas-view-zoom', { snapshot: false });
});

// ADR-0127 wave 5b: the edit mode — the bottom tool bar, the shapes grid, «+», a new sticky with its text editor and
// the format bar, the properties sheet, «Выбрать несколько», and «Готово» back to view mode. Written, not run (no WebKit).
test('m-canvas-edit', async ({ page }) => {
  await signedIn(page);
  await tab(page, 'canvas');
  await page.getByTestId('phone-canvas-row').filter({ hasText: 'Продукт' }).getByRole('button').tap();
  await page.getByTestId('phone-canvas-row').filter({ hasText: 'Дорожная карта Q1' }).getByRole('button').tap();
  const screen = page.getByTestId('phone-canvas-screen');
  const view = screen.getByTestId('canvas-view');
  await expect(view.getByTestId('canvas-zoom')).toBeVisible();
  await screen.getByTestId('phone-canvas-edit').tap();
  await expect(screen.getByTestId('phone-canvas-edit')).toHaveText('Готово');
  // The bar with 44 px targets above the home indicator, the zoom bar moved to the top, the one-time hint.
  const bar = view.getByTestId('canvas-phone-toolbar');
  await expect(bar).toBeVisible();
  for (const btn of await bar.getByRole('button').all()) {
    const box = await btn.boundingBox();
    expect(box?.width ?? 0, 'tool bar target width').toBeGreaterThanOrEqual(43.5);
    expect(box?.height ?? 0, 'tool bar target height').toBeGreaterThanOrEqual(43.5);
  }
  await expect(view.getByTestId('canvas-phone-edit-hint')).toBeVisible();
  await view.getByTestId('canvas-fit-all').tap();
  await checkpoint(page, 'm-canvas-edit');
  await view.getByTestId('canvas-phone-edit-hint-close').tap();
  // The shapes grid.
  await view.getByTestId('canvas-tool-shape').tap();
  await expect(view.getByTestId('canvas-phone-shapes')).toBeVisible();
  await checkpoint(page, 'm-canvas-edit-shapes', { snapshot: false });
  await view.getByTestId('canvas-shape-ellipse').tap();
  // «+»: templates, vote, timer.
  await view.getByTestId('canvas-phone-plus').tap();
  await expect(view.getByTestId('canvas-phone-plus-sheet')).toBeVisible();
  await checkpoint(page, 'm-canvas-edit-plus', { snapshot: false });
  await view.getByTestId('canvas-phone-plus').tap();
  // A sticky: arm the tool, tap the canvas — its text editor opens with the format bar above the keyboard.
  await view.getByTestId('canvas-tool-sticky').tap();
  await expect(view.getByTestId('canvas-phone-armed')).toBeVisible();
  await view.getByTestId('canvas-surface').tap({ position: { x: 180, y: 300 } });
  await expect(view.getByTestId('canvas-format-bar')).toBeVisible();
  await checkpoint(page, 'm-canvas-edit-text', { snapshot: false });
  await view.getByTestId('canvas-format-done').tap();
  // The new object stays selected: its properties sheet is above the tool bar.
  await expect(view.getByTestId('canvas-phone-props')).toBeVisible();
  await checkpoint(page, 'm-canvas-edit-props');
  await view.getByTestId('canvas-prop-sticky-color').tap();
  await expect(view.getByTestId('canvas-phone-panel')).toBeVisible();
  await checkpoint(page, 'm-canvas-edit-color', { snapshot: false });
  await view.getByTestId('canvas-phone-color-pink').tap();
  await view.getByTestId('canvas-phone-multi').tap();
  await expect(view.getByTestId('canvas-phone-multi')).toHaveAttribute('aria-pressed', 'true');
  // «Готово» is back to view mode: the bar and the sheet are gone, the canvas is the same.
  await screen.getByTestId('phone-canvas-edit').tap();
  await expect(screen.getByTestId('phone-canvas-edit')).toHaveText('Править');
  for (const id of ['canvas-phone-toolbar', 'canvas-phone-props']) await expect(view.getByTestId(id)).toHaveCount(0);
  await checkpoint(page, 'm-canvas-edit-done', { snapshot: false });
});

// /c/{code} at 390 px: the header and the canvas in view mode (pan, pinch, the zoom bar); no edit mode.
test('m-canvas-public', async ({ page }) => {
  await open(page, `/c/${CANVAS_PUBLIC_CODE}`);
  await expect(page.getByTestId('canvas-public-title')).toHaveText('Схема навигации');
  await expect(page.getByTestId('canvas-zoom')).toBeVisible();
  for (const id of ['canvas-phone-toolbar', 'phone-canvas-edit', 'canvas-others']) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.getByTestId('canvas-fit-all').tap();
  await checkpoint(page, 'm-canvas-public');
});

// /w/{code} at 390 px: the outline is a «Содержание» disclosure above the text.
test('m-wiki-public', async ({ page }) => {
  await open(page, `/w/${WIKI_PUBLIC_CODE}`);
  await expect(page.getByTestId('wiki-public-title')).toHaveText('Справочник команды');
  await expect(page.locator('.wiki-prose')).toContainText('Первая неделя');
  await expect(page.getByTestId('wiki-public-cover').locator('img')).toBeVisible();
  await expect(page.getByTestId('wiki-public-outline')).toBeHidden();
  await expect(page.getByTestId('wiki-public-footer')).toBeVisible();
  await checkpoint(page, 'm-wiki-public');
  await page.getByTestId('wiki-public-toc-toggle').tap();
  const toc = page.getByTestId('wiki-public-toc');
  await expect(toc.getByTestId('wiki-public-outline-row')).toHaveCount(7);
  await checkpoint(page, 'm-wiki-public-toc', { snapshot: false });
  await toc.getByTestId('wiki-public-outline-row').filter({ hasText: 'Процессы' }).tap();
  await expect(page.getByTestId('wiki-public-title')).toHaveText('Процессы');
});

// Toasts on the phone stay under the top bar (safe area), over the feed, never over the tab bar (owner, 29.10).
test('m-toasts', async ({ page }) => {
  await signedInRoom(page);
  await expect(page.getByTestId('composer')).toBeVisible();
  await page.evaluate(() => {
    const push = (window as unknown as { __calabaToast?: (k: string, t: string) => void }).__calabaToast;
    push?.('info', 'Ссылка-приглашение скопирована');
    push?.('success', 'Файл сохранён в «Загрузки»');
  });
  await expect(page.getByTestId('toast')).toHaveCount(2);
  await checkpoint(page, 'm-toasts', { main: true });
});
