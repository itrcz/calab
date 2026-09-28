import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { Plan, RecordingStatus, UserSchema, WorkspaceBanSchema, WorkspacePlanSchema, WorkspaceSuspensionSchema } from '@calaba/protocol';
import type { Locator, Page } from '@playwright/test';
import { FREE_PLAN_LIMITS, defaultSettings, ts } from '../e2e-support/fixtures';
import { CODE_FIXTURE, IDS, MOCK_GPTUNNEL_CODE, MOCK_GPTUNNEL_WEB, PASSWORD, RECORDING_FIXTURE, slowWebpAnimation, type MockServer } from '../e2e-support/mock-server';
import { encodePng } from '../e2e-support/png';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';
import { startPublisher } from './publisher';

/**
 * Visual regression of the main screens (docs/08, «Тесты дизайна»): one Playwright project per
 * configuration (playwright.visual.config.ts). Every test is one screen, named like its snapshot,
 * and starts from a clean seeded state (app.ts):
 *
 *   pnpm -F @calaba/desktop e2e:visual -g "voice-camera-grid"                 # dark-960 (local)
 *   CALABA_VISUAL_ALL=1 pnpm -F @calaba/desktop e2e:visual -g "voice-camera-grid" --project light-1440
 *
 * Locally (owner, 26.09) only the KEY screens below run, in dark-960 only; every other screen
 * (each settings tab, every menu variant, toasts…) and the other configurations run only with
 * CALABA_VISUAL_ALL=1 — the nightly CI on Linux. Their code stays here, skipped locally.
 *
 * Each checkpoint = screenshot (≤ 0.2 % differing pixels) + layout invariants + axe (0
 * serious/critical). Update: `pnpm e2e:visual:update -g "<screen>"`.
 */

/** The full matrix: every screen, every configuration (nightly CI). */
const ALL = process.env['CALABA_VISUAL_ALL'] === '1';

/**
 * The local set (~25): one shot per screen family, no per-menu-item or per-tab shots. Settings:
 * 2 = «Голос и устройства», 3 = «Горячие клавиши», 8 = «Приложение» (language).
 */
const KEY = new Set([
  'auth-login',
  'auth-forgot',
  'verify-banner',
  'invite-email',
  'room-invite',
  'room-invite-voice',
  'onboarding-mic',
  'onboarding-screen',
  'onboarding-done',
  'onboarding-join',
  'onboarding-layout',
  'welcome',
  'main-chat',
  'sidebar-drag',
  'chat-hover-actions',
  'chat-hover-actions-bounds',
  'tooltip-lazy',
  'chat-context-menu',
  'room-notify-menu',
  'dm-list',
  'dm-archive',
  'dm-delete-confirm',
  'dm-chat',
  'voice-room-status',
  'voice-room-recording',
  'voice-room-recording-menu',
  'chat-recording-card',
  'chat-recording-done',
  'chat-recording-play',
  'recording-transcript',
  'chat-recording-delete',
  'chat-audio',
  'chat-audio-mini',
  'chat-video',
  'chat-code',
  'chat-voice-recording',
  'chat-voice-recording-narrow',
  'chat-voice-bubble',
  'voice-room-speaking',
  'voice-room-pending',
  'voice-stream',
  'voice-pip',
  'voice-camera-grid',
  'voice-camera-pip',
  'voice-noise-popover',
  'main-members-toggled',
  'members-menu',
  'profile-dialog',
  'profile-menu',
  'chat-lightbox',
  'workspace-menu',
  'self-mic-menu',
  'self-status-menu',
  'self-custom-status',
  'quick-switcher',
  'settings-2',
  'settings-3',
  'settings-8',
  'room-settings-1',
  'room-settings-restricted',
  'i18n-en-main-chat',
  'settings-plan',
  'settings-gptunnel',
  'settings-members',
  'settings-roles',
  'settings-role-edit',
  'admin-workspaces',
  'admin-plan',
  'admin-suspend',
  'settings-bans',
  'workspace-suspended',
  'chat-sticker',
  'sticker-picker',
  'settings-stickers',
  'settings-stickers-upload',
  'settings-bots',
  'settings-bot-token',
  'bot-profile',
  'chat-bot-commands',
]);

// Non-key screens: skipped unless CALABA_VISUAL_ALL=1 (before any fixture, so no app launch).
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(!ALL && !KEY.has(info.title), 'full matrix only (CALABA_VISUAL_ALL=1, nightly CI)');
});

test.describe.configure({ mode: 'parallel' });

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// ---------------------------------------------------------------- helpers

/** Keyboard focus (matches :focus-visible, unlike a bare focus() after a click). */
async function keyboardFocus(target: Locator): Promise<void> {
  await target.focus();
  await target.page().keyboard.press('Tab');
  await target.page().keyboard.press('Shift+Tab');
  await expect(target).toBeFocused();
}

/**
 * The main window as every main-window screen shows it: «общий» open and scrolled to the
 * bottom, a live @-mention in «разработка» (badge 2).
 */
async function mainWindow(page: Page, mock: MockServer): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `@${IDS.users.anna} глянь, пожалуйста, ревью` });
  // Mention badge on «разработка»: 1 from the history loaded at startup + this live one.
  await expect(page.locator('aside').first().getByText('2', { exact: true })).toBeVisible();
  // The room opens at the first unread; that anchor lands ±1 px apart between runs
  // (fractional row heights). Photograph the feed at its bottom, which is exact — only after
  // the history is in and the app placed the first-unread anchor.
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await settle(page);
  await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // Rows below the fold (link preview images) are measured after the scroll: let the feed settle
  // before any focus step scrolls it again (960 px shots came out at different offsets).
  await page.waitForFunction(() => [...document.querySelectorAll('[data-virtuoso-scroller] img')].every((i) => (i as HTMLImageElement).complete));
  await settle(page);
  await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(page);
}

/** Members list visible (a column from 1200 px, a floating panel below). */
async function membersList(page: Page): Promise<Locator> {
  const members = page.getByRole('complementary', { name: 'Участники' });
  if (!(await members.isVisible())) await page.getByRole('button', { name: 'Участники' }).click();
  return members;
}

async function openSettingsTab(page: Page, opener: () => Promise<void>, index: number): Promise<void> {
  await opener();
  await expect(page.getByRole('dialog')).toBeVisible();
  const tab = page.getByRole('dialog').getByRole('tab').nth(index - 1);
  await tab.click();
  await expect(tab).toHaveAttribute('data-state', 'active');
}

/** In «Переговорка» (dev LiveKit), muted (the fake mic beeps), signal bars steady «good». */
async function inVoice(page: Page, mock: MockServer): Promise<void> {
  await mainWindow(page, mock);
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  // Signal bars stay in the shots (docs/08: quality always visible): wait for the loopback
  // LiveKit's steady «good» instead of masking the indicator.
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
}

const STATUS = 'Планёрка по релизу 0.2';

/** «Задать статус комнаты ✎» → the inline field (docs/09 #48); `save` = Enter (focus back on the row). */
async function editRoomStatus(page: Page, save: boolean): Promise<Locator> {
  const sidebar = page.locator('aside').first();
  const statusRow = sidebar.getByTestId('voice-status-row');
  await expect(statusRow).toContainText('Задать статус комнаты');
  await expect(sidebar.getByTestId('voice-invite-row')).toBeVisible();
  await statusRow.click();
  const statusInput = sidebar.getByTestId('voice-status-input');
  await expect(statusInput).toBeFocused();
  await statusInput.fill(STATUS);
  if (save) {
    await statusInput.press('Enter');
    await expect(statusRow).toContainText(STATUS);
    await expect(statusRow).toBeFocused(); // keyboard close returns focus to the row
    // The shots show the room as everyone sees it: no focus ring on the status line.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  return statusRow;
}

/** In voice with the room status set, nothing focused (the state every later voice screen has). */
async function inVoiceWithStatus(page: Page, mock: MockServer): Promise<void> {
  await inVoice(page, mock);
  await editRoomStatus(page, true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Camera pixels (Chromium's fake device) change every run: hidden, the tile chrome stays. */
async function hideCameraPixels(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-testid="camera-video"], [data-testid="camera-preview"] video { visibility: hidden !important; }' });
}

/** My camera on through the first-start sheet «Проверьте камеру». */
async function cameraOn(page: Page): Promise<void> {
  await page.getByTestId('camera-button').click();
  await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('camera-preview-enable').click();
  await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
}

type Publisher = Awaited<ReturnType<typeof startPublisher>>;

/**
 * My camera on + Борис's camera (a LiveKit camera track + VoiceState.camera, as the server
 * would), the PiP showing Борис. Returns the publisher to stop.
 */
async function withBorisCamera(page: Page, mock: MockServer): Promise<Publisher> {
  await inVoiceWithStatus(page, mock);
  await hideCameraPixels(page);
  await cameraOn(page);
  await expect(page.getByTestId('camera-pip')).toHaveAccessibleName('Камера: Анна Смирнова');
  const pub = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.meeting, source: 'camera' });
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: true, camera: true });
  // The PiP prefers a remote camera over the self-view.
  await expect(page.getByTestId('camera-pip')).toHaveAccessibleName('Камера: Борис Петров', { timeout: 30_000 });
  await expectFrames(page, 1);
  return pub;
}

/** The camera grid with 3 tiles (two cameras + Вера's avatar tile), Борис large. */
async function cameraGrid(page: Page): Promise<void> {
  await page.getByTestId('camera-pip').getByRole('button', { name: 'Развернуть видео' }).first().click();
  await expect(page.getByTestId('video-grid')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Камера: Борис Петров' })).toBeVisible({ timeout: 30_000 });
  await expectFrames(page, 2);
  await expect(page.getByTestId('video-tile')).toHaveCount(3);
  // My own camera is never the large tile by default: Борис's is.
  await expect(page.locator('[data-testid="video-tile"][data-featured]')).toHaveAccessibleName('Камера: Борис Петров');
}

/**
 * Вера streams into the voice room with my camera on (the stream is the main picture, my camera
 * in the strip). Empty voice-room chat (docs/09 #56): the stream opens expanded.
 */
async function withStream(page: Page, mock: MockServer): Promise<Publisher> {
  await inVoiceWithStatus(page, mock);
  await hideCameraPixels(page);
  await cameraOn(page);
  // LiveKit creates the room on the first join, so the publisher comes second.
  const pub = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.meeting });
  const video = page.getByTestId('stream-stage').or(page.getByTestId('stream-pip'));
  const chip = page.getByRole('button', { name: 'Вера Ким', exact: true });
  await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
  if ((await video.count()) === 0) await chip.first().click();
  await expectFrames(page, 1);
  // Decoded frames differ run to run: hide the pixels, keep the stage chrome (name, LIVE,
  // controls) in the shots on the stage's black background.
  await page.addStyleTag({ content: 'video { visibility: hidden !important; }' });
  await expect(page.getByTestId('stream-stage')).toBeVisible();
  return pub;
}

/** Stream collapsed to the PiP (remembered for the room) and expanded again. */
async function streamExpandedAgain(page: Page): Promise<void> {
  await page.getByTestId('stream-stage').getByRole('button', { name: 'Свернуть в угол' }).click();
  await expect(page.getByTestId('stream-pip')).toBeVisible();
  await page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
  await expect(page.getByTestId('stream-pip')).toHaveCount(0);
}

/** Two streams (Вера + Борис) + my camera: previews and the camera tile under the stage. */
async function withTwoStreams(page: Page, mock: MockServer): Promise<Publisher[]> {
  const first = await withStream(page, mock);
  await streamExpandedAgain(page);
  const second = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.meeting });
  await expect(page.getByTestId('stream-strip').getByRole('button', { name: /^Стрим: / })).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('stream-strip').getByRole('button', { name: /^Камера: / })).toHaveCount(1);
  await expectFrames(page, 2);
  return [first, second];
}

async function stopAll(pubs: Array<Publisher | null | undefined>): Promise<void> {
  for (const p of pubs) await p?.stop().catch(() => undefined);
}

// ---------------------------------------------------------------- auth

test('auth-login', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await expect(win.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  await checkpoint(shot, 'auth-login');
});

test('auth-server', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  // docs/09 #19: the server field lives under the «Другой сервер» disclosure.
  await win.getByRole('button', { name: 'Другой сервер' }).click();
  await expect(win.getByLabel('Сервер')).toBeVisible();
  await checkpoint(shot, 'auth-server');
});

test('auth-register', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await win.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(win.getByLabel('Имя')).toBeVisible();
  await checkpoint(shot, 'auth-register');
});

// ---------------------------------------------------------------- email (ADR-0023)

/** «Забыли пароль?» → the code step: code field with the resend timer, new password. */
test('auth-forgot', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await win.getByRole('button', { name: 'Забыли пароль?' }).click();
  await win.getByLabel('Email').fill('owner@calaba.test');
  await win.getByRole('button', { name: 'Отправить код' }).click();
  await expect(win.getByTestId('forgot-code')).toBeVisible();
  await expect(win.getByText('Если owner@calaba.test зарегистрирован, мы отправили на него код.')).toBeVisible();
  await win.getByRole('textbox', { name: 'Код из письма' }).fill('123456');
  await checkpoint(shot, 'auth-forgot');
});

/** The unverified account: the bar over the main window, a wrong code answered inline. */
test('verify-banner', async ({ open, win, mock, shot }) => {
  await open();
  mock.setEmailState(IDS.users.anna, { verified: false });
  const bar = win.getByTestId('verify-banner');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('мы отправили код на owner@calaba.test');
  await mainWindow(win, mock);
  await bar.getByRole('textbox', { name: 'Код из письма' }).fill('000000'); // 6 digits submit by themselves
  await expect(bar.getByRole('alert')).toHaveText('Неверный код. Осталось 4 попытки');
  await checkpoint(shot, 'verify-banner');
});

/** Workspace settings → «Приглашения»: a found account with «Добавить» and one sent invitation. */
test('invite-email', async ({ open, win, mock, shot }) => {
  await open();
  // A verified account outside «Команда Calab» (found by the exact address).
  const egor = 'mock-egor-0001';
  mock.state.users.set(egor, {
    user: create(UserSchema, { id: egor, displayName: 'Егор Лебедев' }),
    email: 'egor@example.com',
    password: PASSWORD,
    settings: defaultSettings(),
    emailVerified: true,
    pendingEmail: '',
    locale: '',
  });
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  // By name: the tab's position depends on the plan («Тариф» comes before it, ADR-0024).
  await win.getByRole('dialog').getByRole('tab', { name: 'Приглашения' }).click();
  // Not opened from a room: no guest-link block (docs/09 #55).
  await expect(win.getByText('Пригласить гостя без регистрации')).toHaveCount(0);
  const field = win.getByRole('textbox', { name: 'Email для приглашения' });
  await field.fill('new.colleague@example.com');
  await win.getByRole('button', { name: 'Отправить приглашение на почту' }).click();
  await expect(win.getByText('Отправленные приглашения')).toBeVisible();
  // The toast sits outside the modal (inert for pointer and a11y): close it by a DOM click.
  await win.getByTestId('toast').locator('button[aria-label="Закрыть уведомление"]').evaluate((b) => (b as HTMLButtonElement).click());
  await expect(win.getByTestId('toast')).toHaveCount(0);
  await field.fill('egor@example.com');
  await expect(win.getByTestId('invite-email-found')).toContainText('Егор Лебедев');
  await expect(win.getByRole('button', { name: 'Добавить', exact: true })).toBeVisible();
  await checkpoint(shot, 'invite-email');
});

/** «Пригласить» from a room (docs/09 #55): the room's guest link first, the workspace invites below. */
test('room-invite', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: 'Пригласить в «общий»' }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: 'Приглашения' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByText('Пригласить гостя без регистрации')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Ссылка для гостей' })).toHaveValue(/\/r\/general-guest-link$/);
  await expect(dialog.getByRole('button', { name: 'Настроить срок и права…' })).toBeVisible();
  // The link carries the mock's port: masked (like onboarding-join).
  await checkpoint(shot, 'room-invite', { mask: [dialog.getByRole('textbox', { name: 'Ссылка для гостей' })] });
});

/** «Пригласить в комнату» (voice room menu, MANAGE_ROOM): the guest link card above the member picker (docs/09 #55). */
test('room-invite-voice', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Созвон/ }).first().click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Пригласить в комнату' }).click();
  const dialog = win.getByTestId('room-invite');
  await expect(dialog.getByText('Пригласить гостя без регистрации')).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Ссылка для гостей' });
  await expect(field).toHaveValue(/\/r\/call-guest-link$/);
  // One link field: the card replaces «Или отправьте ссылку».
  await expect(dialog.getByRole('textbox', { name: 'Или отправьте ссылку' })).toHaveCount(0);
  await expect(dialog.getByTestId('picker-option').first()).toBeVisible();
  await checkpoint(shot, 'room-invite-voice', { mask: [field] });
});

// ---------------------------------------------------------------- onboarding

/**
 * The onboarding steps in order (docs/09 #36: settings first — microphone, screen on macOS,
 * notifications, push-to-talk; the account has a workspace, so no join step); `to` walks there
 * from the first one.
 */
const mac = process.platform === 'darwin';
async function toNotifications(p: Page): Promise<void> {
  await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
  await p.getByRole('button', { name: 'Слышно хорошо' }).click();
  if (mac) await p.getByRole('button', { name: 'Позже' }).click();
}
async function toMode(p: Page): Promise<void> {
  await toNotifications(p);
  await p.getByRole('button', { name: 'Позже' }).click();
}
const ONBOARDING: Array<{ name: string; to: (page: Page) => Promise<void> }> = [
  { name: 'onboarding-mic', to: () => Promise.resolve() },
  {
    name: 'onboarding-mic-ok',
    to: async (p) => {
      await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await expect(p.getByTestId('mic-meter')).toBeVisible();
    },
  },
  ...(mac
    ? [
        {
          name: 'onboarding-screen',
          to: async (p: Page) => {
            await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
            await p.getByRole('button', { name: 'Слышно хорошо' }).click();
          },
        },
      ]
    : []),
  { name: 'onboarding-notifications', to: toNotifications },
  { name: 'onboarding-mode', to: toMode },
  {
    name: 'onboarding-mode-ptt',
    to: async (p) => {
      await toMode(p);
      await p.getByRole('radio', { name: 'Push-to-talk' }).click();
    },
  },
  {
    name: 'onboarding-done',
    to: async (p) => {
      await toMode(p);
      await p.getByRole('button', { name: 'Продолжить' }).click();
    },
  },
];

for (const step of ONBOARDING) {
  test(step.name, async ({ open, win, shot }) => {
    await open({ onboarded: false });
    await step.to(win);
    const id = step.name === 'onboarding-mode-ptt' ? 'onboarding-mode' : step.name === 'onboarding-mic-ok' ? 'onboarding-mic' : step.name;
    await expect(win.getByTestId(id)).toBeVisible();
    await checkpoint(shot, step.name);
  });
}

/**
 * «Присоединиться к пространству» (docs/09 #36): only for an account without any workspace, last
 * before «Готово».
 */
test('onboarding-join', async ({ open, win, shot }) => {
  await open({ scenario: 'empty', onboarded: false });
  await toMode(win);
  await win.getByRole('button', { name: 'Продолжить' }).click();
  const step = win.getByTestId('onboarding-join');
  await expect(step).toBeVisible();
  await expect(step.getByRole('button', { name: 'Присоединиться' })).toBeDisabled();
  // The placeholder carries the mock's port (a real-looking link on this server): masked.
  await checkpoint(shot, 'onboarding-join', { mask: [step.getByRole('textbox')] });
});

/** Owner's rule for onboarding (docs/09 #55): the same geometry on every step, no snapshot. */
test('onboarding-layout', async ({ open, win, size: viewport }) => {
  await open({ onboarded: false });
  const onb: OnbGeometry[] = [];
  for (const step of ONBOARDING) {
    await open({ onboarded: false });
    await step.to(win);
    const id = step.name === 'onboarding-mode-ptt' ? 'onboarding-mode' : step.name === 'onboarding-mic-ok' ? 'onboarding-mic' : step.name;
    await expect(win.getByTestId(id)).toBeVisible();
    onb.push(await onboardingGeometry(win, step.name));
  }
  expectStableOnboarding(onb, viewport.height);
});

// ---------------------------------------------------------------- main window

test('main-chat', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await checkpoint(shot, 'main-chat');
});

/**
 * Room drag & drop (docs/09 P1 #19): «разработка» held by the pointer over the top half of
 * «общий» — the room chip follows the pointer, the row fades, the accent line marks the place.
 * Esc cancels: the line goes and nothing moves.
 */
test('sidebar-drag', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const list = win.getByTestId('room-list');
  const from = await list.locator(`[data-room-slot="${IDS.rooms.dev}"]`).boundingBox();
  const to = await list.locator(`[data-room-slot="${IDS.rooms.general}"]`).boundingBox();
  if (!from || !to) throw new Error('room rows are not laid out');
  await win.mouse.move(from.x + 60, from.y + from.height / 2);
  await win.mouse.down();
  await win.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 4 });
  await win.mouse.move(to.x + 60, to.y + 6, { steps: 8 });
  await expect(win.getByTestId('drop-line')).toBeVisible();
  // The line marks the place before «общий» (not the end of the list under the voice participants).
  const line = await win.getByTestId('drop-line').boundingBox();
  expect(Math.abs((line?.y ?? -100) - to.y)).toBeLessThanOrEqual(3);
  await settle(win, true);
  // The pointer stays put (the drag chip follows it). axe off: the dragged row is dimmed on purpose
  // (Discord's drag source); main-chat covers the list.
  await checkpoint(shot, 'sidebar-drag', { axe: false, keepPointer: true });
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('drop-line')).toHaveCount(0);
  await win.mouse.up();
  const after = await list.locator('[data-room-slot]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['roomSlot']));
  expect(after.indexOf(IDS.rooms.general)).toBeLessThan(after.indexOf(IDS.rooms.dev));
});

// ---------------------------------------------------------------- localization (ADR-0022)

/**
 * The baselines are Russian; English gets one shot per main screen (`-g "i18n-en"`), dark 960
 * only (the narrowest window, where longer strings would break first) — overflow in other
 * locales is caught by the string-length unit test.
 */
test('i18n-en-main-chat', async ({ open, win, mock, shot, theme, size: viewport }) => {
  test.skip(theme !== 'dark' || viewport.width !== 960, 'English is checked in dark 960 only');
  await open({ prefs: { locale: 'en' } });
  await expect(win.locator('html')).toHaveAttribute('lang', 'en');
  await mainWindow(win, mock);
  await checkpoint(shot, 'i18n-en-main-chat');
});

// ---------------------------------------------------------------- direct messages (ADR-0020)

/**
 * «Личные» (started there: no workspace room is opened and read first, so the rail badges are
 * the READY ones): the DM list — Борис 2 unread, Вера yesterday, Григорий a week ago.
 */
const DM_SEED = { ui: { activeWorkspaceId: '@me' } };
async function dmHome(page: Page): Promise<Locator> {
  await expect(page.getByTestId('rail-home').getByRole('button')).toHaveAttribute('aria-current', 'page');
  const list = page.getByTestId('dm-list');
  await expect(list.getByRole('button')).toHaveCount(3);
  // Previews are fetched when the list opens: wait for all three.
  await expect(list).toContainText('Закрепил, чтобы не потерялся');
  await expect(list).toContainText('Супер, спасибо');
  await expect(list).toContainText('Да, подготовлю пару слайдов');
  return list;
}

/** docs/09 #51: Григорий goes to the archive through the row's context menu («Архив — 1», collapsed). */
async function archiveGrigory(page: Page, list: Locator): Promise<Locator> {
  await list.getByRole('button', { name: /Григорий/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'В архив' }).click();
  await expect(list.getByRole('button')).toHaveCount(2);
  const archive = page.getByTestId('dm-archive');
  await expect(archive.getByRole('button', { name: 'Архив — 1' })).toHaveAttribute('aria-expanded', 'false');
  return archive;
}

test('dm-list', async ({ open, win, shot }) => {
  await open(DM_SEED);
  const list = await dmHome(win);
  await archiveGrigory(win, list);
  await expect(win.getByTestId('dm-pick')).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'dm-list');
});

test('dm-archive', async ({ open, win, shot }) => {
  await open(DM_SEED);
  const archive = await archiveGrigory(win, await dmHome(win));
  // Expanded: the archived DM, its menu offers «Вернуть из архива».
  await archive.getByRole('button', { name: 'Архив — 1' }).click();
  const row = win.getByTestId('dm-archive-list').getByRole('button', { name: /Григорий/ });
  await expect(row).toContainText('Да, подготовлю пару слайдов');
  await row.click({ button: 'right' });
  await expect(win.getByRole('menuitem', { name: 'Вернуть из архива' })).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'dm-archive');
});

test('dm-delete-confirm', async ({ open, win, shot }) => {
  await open(DM_SEED);
  const list = await dmHome(win);
  await list.getByRole('button', { name: /Вера/ }).click();
  await expect(win.getByTestId('dm-header')).toContainText('Вера');
  await win.getByTestId('dm-actions').click();
  await win.getByRole('menuitem', { name: 'Удалить чат' }).click();
  const dialog = win.getByRole('dialog', { name: 'Удалить чат?' });
  await expect(dialog).toContainText('История будет удалена только у вас');
  await settle(win);
  await checkpoint(shot, 'dm-delete-confirm');
  // «Удалить»: the chat closes, the DM leaves the list; opened again, its feed is empty.
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(win.getByTestId('dm-pick')).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByRole('button', { name: /Вера/ })).toHaveCount(0);
  await win.getByRole('button', { name: 'Новое сообщение' }).first().click();
  await win.getByRole('dialog', { name: 'Новое сообщение' }).getByRole('option', { name: /Вера/ }).click();
  await expect(win.getByTestId('dm-header')).toContainText('Вера');
  await expect(win.locator('[data-message-id]')).toHaveCount(0);
});

test('dm-chat', async ({ open, win, shot }) => {
  await open(DM_SEED);
  const list = await dmHome(win);
  await list.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByTestId('dm-header')).toContainText('Борис Петров');
  await expect(win.locator('[data-message-id]').first()).toBeVisible();
  // The pinned strip (Борис's checklist) and the whole history (4 messages) are in.
  await expect(win.locator('[data-message-id]')).toHaveCount(4);
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(win);
  await checkpoint(shot, 'dm-chat');
});

test('dm-new', async ({ open, win, shot }) => {
  await open(DM_SEED);
  await dmHome(win);
  await win.getByRole('button', { name: 'Новое сообщение' }).first().click();
  const dialog = win.getByRole('dialog', { name: 'Новое сообщение' });
  await expect(dialog.getByRole('option')).toHaveCount(3);
  await settle(win);
  // docs/09 #52: the list runs down to the dialog's bottom padding (20 px) — no empty band under it.
  const [d, l] = await Promise.all([dialog.boundingBox(), dialog.getByRole('listbox').boundingBox()]);
  if (!d || !l) throw new Error('no dialog / list box');
  expect(Math.abs(d.y + d.height - (l.y + l.height) - 20)).toBeLessThanOrEqual(1);
  await checkpoint(shot, 'dm-new');
});

test('update-banner', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Auto-update: «Calab X готова · Перезапустить ✕» in the bottom island (faked status).
  await win.evaluate(() => (window as unknown as { __calabaUpdateStatus?: (s: object) => void }).__calabaUpdateStatus?.({ state: 'downloaded', version: '0.1.1' }));
  await expect(win.getByTestId('update-banner')).toBeVisible();
  await checkpoint(shot, 'update-banner');
});

test('main-members-toggled', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Members: a column from 1200 px (open by default), a floating panel below (closed by default).
  await win.getByRole('button', { name: 'Участники' }).click();
  await checkpoint(shot, 'main-members-toggled');
});

test('members-profile', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByRole('dialog', { name: 'Борис Петров' })).toBeVisible();
  await checkpoint(shot, 'members-profile');
});

test('members-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await expect(win.getByRole('menu')).toBeVisible();
  // «Роли ›» (ADR-0026): a checkbox per role the owner may give — admin (checked), «Дизайн», «Модератор».
  await win.getByRole('menuitem', { name: 'Роли' }).hover();
  const roles = win.getByTestId('member-roles-menu');
  await expect(roles.getByRole('menuitemcheckbox')).toHaveCount(3);
  await expect(roles.getByRole('menuitemcheckbox', { name: 'Администратор' })).toBeChecked();
  await checkpoint(shot, 'members-menu', { keepPointer: true });
});

test('profile-dialog', async ({ open, win, mock, shot }) => {
  // docs/09 #20: «Профиль» from the member menu — banner, member since, role chips, the note saved.
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Профиль' }).click();
  const dialog = win.getByTestId('profile-dialog');
  await expect(dialog).toBeVisible();
  const note = dialog.getByTestId('profile-note');
  await expect(note).toBeEditable();
  await note.fill('Ведёт релизы, спросить про стенд');
  await note.blur();
  await expect(dialog.getByTestId('note-status')).toHaveText('Сохранено');
  await checkpoint(shot, 'profile-dialog');
});

// Issue #8: the profile's «…» opens the member menu above the sheet and its scrim (not under it).
test('profile-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Профиль' }).click();
  const dialog = win.getByTestId('profile-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('profile-more').click();
  const menu = win.getByRole('menu');
  await expect(menu).toBeVisible();
  // Topmost: the point under the first and the last item hits the menu, not the sheet.
  for (const item of [menu.getByRole('menuitem').first(), menu.getByRole('menuitem', { name: 'Копировать ID' })]) {
    const hit = await item.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(hit, `${await item.textContent()} is on top`).toBe(true);
  }
  await checkpoint(shot, 'profile-menu', { keepPointer: true });
});

test('quick-switcher', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.keyboard.press(`${MOD}+k`);
  await expect(win.getByRole('dialog')).toBeVisible();
  // docs/09 #66: the hovered voice room shows «Подключиться» + chat; other rows the Enter hint.
  const voiceRow = win.getByRole('option', { name: /Переговорка/ });
  await voiceRow.hover();
  await expect(win.getByRole('button', { name: 'Подключиться: Переговорка' })).toBeVisible();
  await expect(win.getByRole('button', { name: 'Открыть чат: Переговорка' })).toBeVisible();
  await checkpoint(shot, 'quick-switcher', { keepPointer: true });
});

test('quick-switcher-filtered', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.keyboard.press(`${MOD}+k`);
  await expect(win.getByRole('dialog')).toBeVisible();
  await win.keyboard.type('раз');
  await checkpoint(shot, 'quick-switcher-filtered');
});

test('chat-context-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' }).click({ button: 'right' });
  await expect(win.getByRole('menu')).toBeVisible();
  await checkpoint(shot, 'chat-context-menu');
});

test('chat-emoji-picker', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Эмодзи' }).click();
  await expect(win.getByRole('dialog', { name: 'Эмодзи' })).toBeVisible();
  await checkpoint(shot, 'chat-emoji-picker');
});

test('chat-search', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Поиск в #общий' }).click();
  await win.keyboard.type('релиз');
  await expect(win.getByText('1 из 3')).toBeVisible();
  await checkpoint(shot, 'chat-search');
});

/**
 * Message action bar (docs/09 #47): checkpoint() parks the pointer, so keyboard focus (Tab /
 * Shift+Tab: :focus-visible, like a real Tab walk); toBeVisible() passes at opacity 0.
 */
async function focusDoneBubble(page: Page): Promise<void> {
  await settle(page);
  const doneBubble = page.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' });
  // A mouse press never focuses the bubble (only the keyboard draws its focus ring).
  await doneBubble.click();
  await expect(doneBubble).not.toBeFocused();
  await keyboardFocus(doneBubble);
  const actions = page.getByTestId('message-actions');
  await expect(actions).toHaveCount(1);
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(actions.getByRole('button', { name: 'Ответить' })).toBeVisible();
}

test('chat-hover-actions', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await focusDoneBubble(win);
  await checkpoint(shot, 'chat-hover-actions');
});

/**
 * Action bar geometry and hover (docs/09 #74), no screenshot: at 960 px a long message of
 * another member, a code block and a long message of mine keep the bar inside the feed and the
 * feed never scrolls sideways; the pointer travels from a bubble to its bar through the gap and
 * the bar stays; once the pointer is gone the bar goes ~200 ms later.
 */
test('chat-hover-actions-bounds', async ({ open, win, mock }) => {
  await open();
  await mainWindow(win, mock);
  const long = 'Длинное сообщение без переносов, чтобы пузырь занял всю ширину ленты: '.repeat(6);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: CODE_FIXTURE.js });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: `${long}конец-чужого` });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: `${long}конец-моего` });
  await expect(win.getByText('конец-моего')).toBeVisible();
  await feedAtBottom(win);
  const scroller = win.locator('[data-virtuoso-scroller]').first();
  const actions = win.getByTestId('message-actions');
  const noSideScroll = async (): Promise<void> => {
    const s = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, x: getComputedStyle(el).overflowX }));
    expect(s.sw).toBe(s.cw);
    expect(s.x).toBe('hidden');
  };
  await noSideScroll();
  for (const text of ['Вот обработчик для поиска:', 'конец-чужого', 'конец-моего']) {
    const bubble = win.getByTestId('message-bubble').filter({ hasText: text });
    await win.mouse.move(0, 0);
    await expect(actions).toHaveCount(0);
    await bubble.hover({ position: { x: 40, y: 12 } });
    await expect(actions).toHaveCount(1);
    const [bar, feed] = await Promise.all([actions.boundingBox(), scroller.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.left + el.clientWidth };
    })]);
    if (!bar) throw new Error('no bar');
    expect(bar.x, text).toBeGreaterThanOrEqual(feed.left + 8 - 0.5);
    expect(bar.x + bar.width, text).toBeLessThanOrEqual(feed.right - 8 + 0.5);
    await noSideScroll();
    // A full-width bubble has no room beside it at 960: the bar sits over its top edge.
    if (text !== 'Вот обработчик для поиска:') await expect(win.locator('[data-message-actions]')).toHaveAttribute('data-place', 'corner');
  }
  // A short message of another member: the bar is beside it; bubble → gap → bar keeps it.
  await win.mouse.move(0, 0);
  const done = win.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' });
  await done.scrollIntoViewIfNeeded();
  await settle(win);
  const b = await done.boundingBox();
  if (!b) throw new Error('no bubble');
  await win.mouse.move(b.x + b.width - 6, b.y + b.height - 4);
  await expect(actions).toHaveCount(1);
  const bar = await actions.boundingBox();
  if (!bar) throw new Error('no bar');
  expect(bar.x).toBeGreaterThan(b.x + b.width);
  await expect(win.locator('[data-message-actions]')).toHaveAttribute('data-place', 'beside');
  await win.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2, { steps: 12 });
  await win.waitForTimeout(400);
  await expect(actions).toHaveCount(1);
  await expect(actions.getByRole('button', { name: 'Ответить' })).toBeVisible();
  // Gone ~200 ms after the pointer leaves (not at once, not never).
  await win.mouse.move(0, 0);
  const left = Date.now();
  await win.waitForTimeout(100);
  await expect(actions).toHaveCount(1, { timeout: 1 });
  await expect(actions).toHaveCount(0, { timeout: 1000 });
  expect(Date.now() - left).toBeGreaterThanOrEqual(190);
});

/**
 * Lazy Tip (components/ui.tsx, docs/18 step 6): Radix mounts on the first hover / keyboard focus and
 * the tooltip behaves as an always-mounted one — opens after one mouse move, the first click still
 * lands, keyboard focus stays put and gets the tooltip with aria-describedby. No screenshot.
 */
test('tooltip-lazy', async ({ open, win, mock }) => {
  await open();
  await mainWindow(win, mock);
  // By name: the real OS cursor may rest over another Tip of the Electron window.
  const tip = (name: string) => win.getByRole('tooltip', { name });
  // Hover: one move over an untouched Tip (a Dropdown trigger inside) opens it after the delay.
  const attach = win.getByRole('button', { name: 'Прикрепить файл' });
  await attach.hover();
  await expect(tip('Прикрепить файл')).toBeAttached();
  const id = await tip('Прикрепить файл').getAttribute('id');
  await expect(attach).toHaveAttribute('aria-describedby', id ?? '');
  // The first click after the wake reaches the (remounted) trigger: the menu opens.
  await attach.click();
  await expect(win.getByRole('menu')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.getByRole('menu')).toHaveCount(0);
  await win.mouse.move(0, 0);
  // Keyboard: focus lands on an untouched Tip, stays there after the remount, tooltip at once.
  const help = win.getByRole('button', { name: 'Горячие клавиши' });
  await keyboardFocus(help);
  await expect(tip('Горячие клавиши')).toBeAttached();
  await expect(help).toHaveAttribute('aria-describedby', (await tip('Горячие клавиши').getAttribute('id')) ?? '');
  await expect(help).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(win.getByRole('dialog', { name: 'Горячие клавиши' })).toBeVisible();
});

test('chat-link-preview', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await focusDoneBubble(win);
  // The owner has MANAGE_MESSAGES: «Скрыть превью» on Вера's preview (site colour bar on the left).
  const hidePreview = win.getByTestId('link-preview-hide').first();
  await keyboardFocus(hidePreview);
  await expect(hidePreview).toHaveCSS('opacity', '1');
  // Focus scrolls the feed only «enough», by an amount that varies with row measuring: pin the
  // button 160 px above the feed's bottom edge, re-aligning until the feed stops moving.
  await expect(async () => {
    const off = await hidePreview.evaluate((el) => {
      const feed = el.closest('[data-virtuoso-scroller]') as HTMLElement;
      const d = el.getBoundingClientRect().bottom - (feed.getBoundingClientRect().bottom - 160);
      feed.scrollTop += d;
      return d;
    });
    await settle(win);
    expect(Math.abs(off)).toBeLessThan(1);
  }).toPass({ timeout: 10_000 });
  await expect(hidePreview).toBeFocused();
  await checkpoint(shot, 'chat-link-preview');
});

test('chat-mention-popover', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const composer = win.getByPlaceholder('Сообщение в #общий');
  await composer.click();
  await composer.pressSequentially('@');
  const list = win.getByRole('listbox', { name: 'Упомянуть' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await checkpoint(shot, 'chat-mention-popover');
});

// The room bell (docs/09 item 22): «Как в пространстве (Только упоминания)» by default, the
// explicit levels, and «Заглушить: 1 ч · 8 ч · до утра · навсегда».
test('room-notify-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Уведомления:/ }).click();
  await expect(win.getByRole('menuitemradio', { name: 'Как в пространстве (Только упоминания)' })).toHaveAttribute('aria-checked', 'true');
  await expect(win.getByRole('menuitem', { name: 'До утра' })).toBeVisible();
  await checkpoint(shot, 'room-notify-menu');
});

test('shell-shortcuts', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Горячие клавиши' }).click();
  await expect(win.getByText('Назад по комнатам')).toBeVisible();
  await checkpoint(shot, 'shell-shortcuts');
});

test('shell-mentions', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Упоминания/ }).click();
  // The same text is also in the feed behind the popover: look inside the popover.
  await expect(win.getByRole('dialog').getByText(/посмотришь макет настроек/)).toBeVisible();
  await checkpoint(shot, 'shell-mentions');
});

/** Status menu (docs/09 #29): «Не беспокоить» hovered — its duration submenu open to the right. */
test('self-status-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Мой статус/ }).click();
  const menu = win.getByTestId('status-menu');
  await expect(menu).toBeVisible();
  // Keyboard: the submenu stays open (a parked pointer would close it).
  await menu.getByRole('menuitem', { name: /^Не беспокоить/ }).focus();
  await win.keyboard.press('ArrowRight');
  await expect(win.getByRole('menuitem', { name: '15 минут' })).toBeFocused();
  await checkpoint(shot, 'self-status-menu');
});

/**
 * «Свой статус» sheet: the emoji picker opens over the sheet, under the emoji button — not behind
 * the scrim (it did: --z-popover < --z-modal). A pick fills the button; Esc closes only the picker.
 */
test('self-custom-status', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Мой статус/ }).click();
  await win.getByTestId('status-custom').click();
  const dialog = win.getByRole('dialog', { name: 'Свой статус' });
  await expect(dialog).toBeVisible();
  const button = dialog.getByTestId('custom-status-emoji');
  const picker = win.getByTestId('emoji-picker');
  await button.click();
  await expect(picker).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(dialog).toBeVisible();
  await button.click();
  await picker.getByRole('button', { name: '😀', exact: true }).first().click();
  await expect(picker).toBeHidden();
  await expect(button).toHaveText('😀');
  await dialog.locator('#custom-status-text').fill('Пишу ADR');
  await button.click();
  await expect(picker).toBeVisible();
  // On top: the picker itself takes a click at its centre (not the sheet's scrim).
  const box = await picker.boundingBox();
  if (!box) throw new Error('picker has no box');
  const topmost = await win.evaluate(([x, y]) => !!document.elementFromPoint(x ?? 0, y ?? 0)?.closest('[data-testid="emoji-picker"]'), [box.x + box.width / 2, box.y + box.height / 2]);
  expect(topmost).toBe(true);
  await checkpoint(shot, 'self-custom-status');
});

/** Mic ▾ (docs/09 #28): «Режим» switched to push-to-talk in the menu — key pill, «Изменить…», release delay. */
test('self-mic-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Выбор микрофона' }).click();
  const menu = win.getByTestId('mic-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: 'Push-to-talk' }).click();
  // The menu stays open and shows the PTT controls in place.
  await expect(menu.getByTestId('mic-ptt-key')).toBeVisible();
  await expect(menu.getByTestId('ptt-release-compact')).toBeVisible();
  await checkpoint(shot, 'self-mic-menu');
});

test('workspace-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await expect(win.getByRole('menu')).toBeVisible();
  await checkpoint(shot, 'workspace-menu');
});

/** Settings windows: one test per section (left list = role «tab»), numbered like the snapshots. */
const TABS = { 'workspace-settings': 6, 'room-settings': 3, settings: 9, 'voice-room-settings': 4 } as const;

for (let i = 1; i <= TABS['workspace-settings']; i++) {
  test(`workspace-settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(
      win,
      async () => {
        await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
        await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
      },
      i,
    );
    await checkpoint(shot, `workspace-settings-${i}`);
  });
}

/**
 * Workspace settings → «Участники» (docs/09 #26): search + role filter, names in role colours
 * with the crown / shield, Бориса's nickname open for inline editing (the owner may rename).
 */
test('settings-members', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Участники' }).click();
  await expect(dialog.getByRole('radiogroup', { name: 'Роль' })).toBeVisible();
  await dialog.getByRole('button', { name: /^Изменить ник: Борис/ }).click();
  await expect(dialog.getByTestId('nick-input')).toBeFocused();
  await checkpoint(shot, 'settings-members');
  // Esc closes only the field (restoring the name), not the settings window.
  await win.keyboard.press('Escape');
  await expect(dialog.getByTestId('nick-input')).toHaveCount(0);
  await expect(dialog.getByRole('tab', { name: 'Участники' })).toBeVisible();
});

/** The fixture's custom roles (ADR-0026) given out: «Дизайн» to Вера and Григорий, «Модератор» to Григорий. */
function giveFixtureRoles(mock: MockServer): void {
  mock.setMemberRoles(IDS.workspaces.main, IDS.users.vera, [IDS.roles.design]);
  mock.setMemberRoles(IDS.workspaces.main, IDS.users.grigory, [IDS.roles.design, IDS.roles.moderator]);
}

/**
 * Workspace settings → «Роли» (ADR-0026, docs/08 «Роли»): owner / admin / member / guest marked
 * «встроенная», the custom «Дизайн» (blue) above «Модератор» (green) with drag handles and counts.
 */
test('settings-roles', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureRoles(mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Роли' }).click();
  await expect(dialog.getByTestId('role-row')).toHaveCount(6);
  await expect(dialog.getByTestId('role-row').filter({ hasText: 'Дизайн' })).toContainText('2 участника');
  await checkpoint(shot, 'settings-roles');
});

/** The role card of «Дизайн»: name, palette (blue picked), «Упоминаемая», the permission matrix, members. */
test('settings-role-edit', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureRoles(mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Роли' }).click();
  await dialog.getByRole('button', { name: 'Дизайн', exact: true }).click();
  await expect(dialog.getByTestId('role-title')).toHaveText('Дизайн');
  await expect(dialog.getByTestId('role-name')).toHaveValue('Дизайн');
  await expect(dialog.getByTestId('role-perm-STREAM')).toBeChecked();
  await expect(dialog.getByTestId('role-perm-MANAGE_ROLES')).not.toBeChecked();
  await expect(dialog.getByTestId('role-member')).toHaveCount(2);
  await checkpoint(shot, 'settings-role-edit');
});

/** Workspace settings → «Тариф» (ADR-0024) on the Free plan: limits against the usage, the contact. */
test('settings-plan', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // The fixture's main workspace is Team (no video caps for the voice shots): Free here.
  const ws = mock.state.workspaces.get(IDS.workspaces.main);
  if (!ws) throw new Error('no main workspace');
  ws.plan = create(WorkspacePlanSchema, { plan: Plan.FREE, limits: FREE_PLAN_LIMITS, expired: false });
  mock.dispatch({ event: { case: 'workspaceUpdate', value: { workspace: ws } } });
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  await win.getByRole('dialog').getByRole('tab', { name: 'Тариф' }).click();
  await expect(win.getByTestId('plan-limits')).toBeVisible();
  await expect(win.getByRole('dialog').getByText('Free', { exact: true })).toBeVisible();
  await checkpoint(shot, 'settings-plan');
});

/**
 * Workspace settings → «GPTunneL» (ADR-0025) for the owner, not connected: the code typed through
 * the ABCD-EFGH mask, a wrong code's inline error, the hint with the GPTunneL link. Then the
 * right code connects (device, account, «Открыть в GPTunneL», «Отключить»).
 */
test('settings-gptunnel', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'GPTunneL' }).click();
  await expect(dialog.getByTestId('gptunnel-status')).toHaveText('Не подключено');
  const code = dialog.getByTestId('gptunnel-code');
  await code.pressSequentially('wxyz1234');
  await expect(code).toHaveValue('WXYZ-1234');
  await dialog.getByRole('button', { name: 'Подключить' }).click();
  await expect(dialog.getByTestId('gptunnel-error')).toHaveText('Неверный или устаревший код — получите новый в GPTunneL');
  await checkpoint(shot, 'settings-gptunnel');
  await code.fill(MOCK_GPTUNNEL_CODE);
  await dialog.getByRole('button', { name: 'Подключить' }).click();
  await expect(dialog.getByTestId('gptunnel-status')).toHaveText('Подключено');
  await expect(dialog.getByText('Calab · Команда Calab')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Отключить' })).toBeVisible();
});

/** «Администрирование» (superadmin, ADR-0024): the search and the workspace cards. */
async function openAdmin(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Мой статус/ }).click();
  await page.getByRole('menuitem', { name: 'Администрирование' }).click();
  const admin = page.getByTestId('admin-window');
  await expect(admin.getByTestId('admin-workspace')).toHaveCount(3);
  return admin;
}

test('admin-workspaces', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const admin = await openAdmin(win);
  await admin.getByTestId('admin-workspace').filter({ hasText: 'Команда Calab' }).click();
  await expect(admin.getByTestId('admin-detail')).toBeVisible();
  await expect(admin.getByTestId('admin-log')).toBeAttached();
  await checkpoint(shot, 'admin-workspaces');
});

/** The plan form on «Индивидуальный» (Custom): the limits, the term, the note. */
test('admin-plan', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const admin = await openAdmin(win);
  await admin.getByTestId('admin-workspace').filter({ hasText: 'Сообщество' }).click();
  await expect(admin.getByRole('textbox', { name: 'Человек в голосовой комнате' })).toHaveValue('12');
  await expect(admin.getByTestId('admin-log')).toBeAttached();
  await admin.getByRole('heading', { name: 'Тариф', exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(shot, 'admin-plan');
});

/** Suspends a workspace in the mock and tells the clients (docs/09 #32). */
function suspendInMock(mock: MockServer, wsId: string, reason: string): void {
  const ws = mock.state.workspaces.get(wsId);
  if (!ws) throw new Error('no workspace');
  ws.suspension = create(WorkspaceSuspensionSchema, { at: ts('2026-01-14T09:30:00Z'), reason });
  mock.state.suspendedBy.set(wsId, IDS.users.anna);
  // Calls end with the suspension (the server removes every participant).
  for (const [userId, v] of mock.state.voiceStates) if (v.workspaceId === wsId && v.roomId) mock.setVoiceState({ userId, roomId: '' });
  mock.dispatch({ event: { case: 'workspaceUpdate', value: { workspace: ws } } });
}

/** «Приостановка» in the admin card of a suspended workspace: the switch, the reason, who / when. */
test('admin-suspend', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  suspendInMock(mock, IDS.workspaces.community, 'Неоплата счёта за январь');
  const admin = await openAdmin(win);
  await admin.getByTestId('admin-workspace').filter({ hasText: 'Сообщество' }).click();
  await expect(admin.getByTestId('admin-suspend-reason')).toHaveValue('Неоплата счёта за январь');
  await admin.getByRole('heading', { name: 'Приостановка', exact: true }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(shot, 'admin-suspend');
});

/** Workspace settings → «Забаненные» (docs/09 #32): who, why, when, by whom, «Разбанить». */
test('settings-bans', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const vera = mock.state.users.get(IDS.users.vera);
  if (!vera) throw new Error('no user');
  mock.state.bans.set(IDS.workspaces.main, [
    create(WorkspaceBanSchema, {
      workspaceId: IDS.workspaces.main,
      user: vera.user,
      email: vera.email,
      reason: 'Спам в общем канале',
      bannedBy: IDS.users.anna,
      createdAt: ts('2026-01-12T16:05:00Z'),
    }),
  ]);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  await win.getByRole('dialog').getByRole('tab', { name: 'Забаненные' }).click();
  await expect(win.getByTestId('ws-ban-row')).toHaveCount(1);
  await checkpoint(shot, 'settings-bans');
});

/** A suspended workspace as its owner sees it: the bar with the reason and «Связаться», the read-only composer. */
test('workspace-suspended', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  suspendInMock(mock, IDS.workspaces.main, 'Неоплата счёта за январь');
  await expect(win.getByTestId('suspended-banner')).toBeVisible();
  await expect(win.getByTestId('suspended-reason')).toBeVisible();
  await expect(win.getByTestId('composer-suspended')).toBeVisible();
  await checkpoint(shot, 'workspace-suspended');
});

test('room-create', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Создать комнату' }).first().click();
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'room-create');
});

for (let i = 1; i <= TABS['room-settings']; i++) {
  test(`room-settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), i);
    await checkpoint(shot, `room-settings-${i}`);
  });
}

// ADR-0029: the owner (Anna) turns on «Только по списку» in a private room; «Кто видит» lists Vera.
test('room-settings-restricted', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /очень-длинное-название/ }).first().click();
  await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), 1);
  const toggle = win.getByRole('dialog').getByRole('switch', { name: 'Только по списку' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(mock.state.rooms.get(IDS.rooms.longPrivate)?.restricted).toBe(true);
  await expect(win.getByTestId('room-who-sees-row')).toHaveCount(1);
  await win.getByTestId('room-who-sees').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'room-settings-restricted');
});

test('confirm-delete-room', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), 1);
  await win.getByRole('button', { name: 'Удалить…' }).click();
  await expect(win.getByRole('alertdialog').or(win.getByRole('dialog').last())).toBeVisible();
  await checkpoint(shot, 'confirm-delete-room');
});

const openAppSettings = (page: Page) => async (): Promise<void> => {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
};

for (let i = 1; i <= TABS.settings; i++) {
  test(`settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(win, openAppSettings(win), i);
    await checkpoint(shot, `settings-${i}`);
  });
}

async function settingsSearch(page: Page): Promise<Locator> {
  await openSettingsTab(page, openAppSettings(page), TABS.settings);
  // docs/09 #18: search over section titles and row labels; Enter jumps to the first row.
  const search = page.getByRole('dialog').getByRole('searchbox', { name: 'Поиск настроек' });
  await search.fill('клав');
  const nav = page.getByRole('navigation', { name: 'Результаты поиска' });
  await expect(nav).toBeVisible();
  // Results are harvested from the (hidden) sections as they render: wait until the list stops
  // growing, or Enter would jump to a partial list.
  let last = -1;
  await expect
    .poll(async () => {
      const n = await nav.getByRole('button').count();
      const stable = n === last;
      last = n;
      return stable && n > 1;
    }, { intervals: [300] })
    .toBe(true);
  return search;
}

test('settings-search', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await settingsSearch(win);
  await checkpoint(shot, 'settings-search');
});

test('settings-search-jump', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const search = await settingsSearch(win);
  await search.press('Enter');
  await expect(win.locator('[data-settings-hit="true"]')).toBeVisible();
  await checkpoint(shot, 'settings-search-jump');
});

test('settings-profile-password', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Profile → «Изменить пароль…»: the sheet over the settings window (current password required).
  await openSettingsTab(win, openAppSettings(win), 1);
  await win.getByRole('button', { name: 'Изменить пароль…' }).click();
  await expect(win.getByRole('dialog', { name: 'Смена пароля' })).toBeVisible();
  await checkpoint(shot, 'settings-profile-password');
});

/** The pop-up button itself (owner bug: chevron flush right): a long value ends with «…» before the ↕. */
async function longSelect(page: Page): Promise<Locator> {
  await openSettingsTab(page, openAppSettings(page), 2);
  const select = page.getByRole('dialog').getByRole('combobox', { name: 'Микрофон' });
  await select.evaluate((el: HTMLSelectElement) => {
    // The value is React-controlled: change the text of the selected option instead.
    const o = el.options[el.selectedIndex];
    if (o) o.text = 'Внешний USB-микрофон с очень длинным названием (Built-in Audio Device)';
  });
  return select;
}

test('select-long', async ({ open, win, mock, theme, size: viewport }) => {
  await open();
  await mainWindow(win, mock);
  const select = await longSelect(win);
  await win.mouse.move(0, 0);
  await expect.soft(select, 'screenshot: select-long').toHaveScreenshot(`select-long-${theme}-${viewport.width}.png`);
});

test('select-hover', async ({ open, win, mock, theme, size: viewport }) => {
  await open();
  await mainWindow(win, mock);
  const select = await longSelect(win);
  await select.hover();
  await expect.soft(select, 'screenshot: select-hover').toHaveScreenshot(`select-hover-${theme}-${viewport.width}.png`);
});

test('toasts', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // docs/09 #16: glass stack bottom-right; visual-test mode keeps them on screen.
  await win.evaluate(() => {
    type Push = (kind: string, text: string, action?: { label: string; run: () => void }) => void;
    const push = (window as unknown as { __calabaToast?: Push }).__calabaToast;
    push?.('info', 'Ссылка-приглашение скопирована');
    push?.('success', 'Файл сохранён в «Загрузки»');
    push?.('error', 'Не удалось загрузить сообщения. Нет связи с сервером. Проверьте интернет', { label: 'Повторить', run: () => undefined });
  });
  await expect(win.getByTestId('toast')).toHaveCount(3);
  await checkpoint(shot, 'toasts');
});

// ---------------------------------------------------------------- voice (needs the dev LiveKit)

test('voice-room-status-edit', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, false);
  await checkpoint(shot, 'voice-room-status-edit');
});

test('voice-room-status', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, true);
  // Just joined (docs/09 #10): the invite row is in its 30 s window.
  await expect(win.getByTestId('voice-invite-row')).toBeVisible();
  // Card actions (docs/09 #30): only «чат» and «…»; «…» opens the room menu with «Запись встречи»
  // (ADR-0025: enabled — the room allows recording).
  const card = win.getByTestId('voice-room-card');
  await card.hover();
  await expect(card.getByRole('button', { name: /^Чат комнаты/ })).toBeVisible();
  await card.getByTestId('room-more').click();
  const record = win.getByTestId('room-menu-record');
  await expect(record).toBeVisible();
  await expect(record).not.toHaveAttribute('aria-disabled', 'true');
  await expect(win.getByRole('menuitem', { name: 'Настройки комнаты' })).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(record).toHaveCount(0);
  // Closing returns focus to «…» (a tick later); the shot shows no focus ring.
  const more = card.getByTestId('room-more');
  await expect(more).toBeFocused();
  await more.blur();
  // The shot: the card hovered — the two actions stand where the timer was.
  await card.hover();
  await expect(card.getByTestId('room-more')).toBeVisible();
  await checkpoint(shot, 'voice-room-status', { keepPointer: true });
});

// Meeting recording (docs/09 #30, ADR-0025): Борис started it 12:34 ago — the server's
// ROOM_RECORDING — «● REC 12:34» on the room card next to the call timer, the red «● Запись ·
// 12:34» pill in «Голос подключён» (who started it: tooltip / accessible name), the toast «Началась
// запись встречи». The pointer rests away from the card, so the timer side shows.
test('voice-room-recording', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // The page clock is fixed under test: «since» is counted from it.
  const nowMs = await win.evaluate(() => Date.now());
  mock.setRecording(RECORDING_FIXTURE.roomId, { byUserId: RECORDING_FIXTURE.byUserId, agoMs: RECORDING_FIXTURE.agoMs, nowMs });
  await expect(win.getByTestId('toast')).toContainText('Началась запись встречи (начал: Борис Петров)');
  const card = win.getByTestId('voice-room-card');
  await win.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
  await expect(win.getByTestId('voice-invite-row')).toHaveCount(0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.mouse.move(0, 0);
  await expect(card.getByTestId('room-rec')).toHaveAccessibleName('Идёт запись, 12:34. Запись включена: Борис Петров');
  await expect(win.getByTestId('voice-rec-pill')).toHaveAccessibleName(/Запись включена: Борис Петров/);
  await checkpoint(shot, 'voice-room-recording');
  // «…» now offers to stop it (after the shot: the timer must read 12:34 there).
  await card.hover();
  await card.getByTestId('room-more').click();
  await expect(win.getByTestId('room-menu-record')).toHaveText('Остановить запись');
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('room-menu-record')).toHaveCount(0);
});

// The REC pill is a menu (docs/09 #64): «Идёт запись · 12:34», «Начал: Борис Петров» (a label,
// not an item) and «Остановить запись» for a member (not a guest). The shot: the menu open from
// the keyboard. Then the one-line confirmation («Остановить запись? · Остановить») takes the
// focus, Escape backs out, and the second choice stops it — the pill goes.
test('voice-room-recording-menu', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  const nowMs = await win.evaluate(() => Date.now());
  mock.setRecording(RECORDING_FIXTURE.roomId, { byUserId: RECORDING_FIXTURE.byUserId, agoMs: RECORDING_FIXTURE.agoMs, nowMs });
  await expect(win.getByTestId('toast')).toContainText('Началась запись встречи');
  await win.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
  await expect(win.getByTestId('voice-invite-row')).toHaveCount(0);
  const pill = win.getByTestId('voice-rec-pill');
  await expect(pill).toHaveAccessibleName(/Запись включена: Борис Петров/);
  await pill.focus();
  await win.keyboard.press('Enter');
  const menu = win.getByTestId('rec-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('rec-menu-title')).toContainText('Идёт запись · 12:34');
  await expect(menu.getByTestId('rec-menu-title')).toContainText('Начал: Борис Петров');
  const stop = menu.getByRole('menuitem', { name: 'Остановить запись' });
  await expect(stop).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(1); // the header is not an item
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'voice-room-recording-menu');
  // First choice: the same line asks; the menu stays open, the focus on the question.
  await stop.focus();
  await win.keyboard.press('Enter');
  const confirm = menu.getByTestId('rec-menu-stop-confirm');
  await expect(confirm).toHaveText(/Остановить запись\?\s*Остановить/);
  await expect(confirm).toBeFocused();
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(pill).toBeFocused();
  // Reopened, the confirmation is gone; stop for real.
  await win.keyboard.press('Enter');
  await menu.getByRole('menuitem', { name: 'Остановить запись' }).click();
  await menu.getByTestId('rec-menu-stop-confirm').click();
  await expect(pill).toHaveCount(0);
});

// Speaking indication (docs/08): Борис talks — green ring + bright name in the sidebar row
// and the members column; Вера (silent) stays muted. Fixture members have no LiveKit audio, so
// the speaking set is injected (VoiceBar's visual-test hook).
test('voice-room-speaking', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, true);
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: false });
  await win.evaluate((id) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.([id]), IDS.users.boris);
  const row = win.locator('aside').first().getByRole('listitem', { name: /Борис Петров/ });
  await expect(row).toHaveAttribute('data-speaking', 'true');
  await expect(win.locator('aside').first().getByRole('listitem', { name: /Вера/ })).not.toHaveAttribute('data-speaking', 'true');
  // Joined 60 s ago (docs/09 #10): past the invite row's 30 s window, so both states land in the
  // committed baselines — this screen with it gone, voice-room-status above with it visible.
  await win.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
  await expect(win.getByTestId('voice-invite-row')).toHaveCount(0);
  await checkpoint(shot, 'voice-room-speaking');
});

// Noise suppression popover (docs/09 #12): the wave button in the «Голос подключён» header opens
// it to the right of the island (over the chat, growing upward); the toggle is the same pref as
// Settings → «Голос и устройства». The mic check stays idle in the shot (24 dark segments).
test('voice-noise-popover', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  const button = win.getByTestId('noise-button');
  // RNNoise is off by default (migration 00025 + prefs v3, owner 27.09): Chromium's own
  // noiseSuppression stays on, RNNoise costs CPU. The toggle is the same pref as
  // Settings → «Голос и устройства».
  await expect(button).toHaveAccessibleName('Шумодав выключен');
  await button.click();
  const popover = win.getByTestId('noise-popover');
  await expect(popover).toBeVisible();
  const toggle = popover.getByRole('switch', { name: 'Шумоподавление' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(button).toHaveAccessibleName('Шумодав включён');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(popover.getByTestId('noise-meter')).toHaveAttribute('aria-valuenow', '0');
  // Never over the island: the popover starts right of it.
  const island = await win.getByRole('region', { name: 'Голосовое подключение' }).boundingBox();
  const box = await popover.boundingBox();
  expect(island && box && box.x >= island.x + island.width).toBe(true);
  await checkpoint(shot, 'voice-noise-popover');
});

// A voice room's chat without joining it (docs/09 #14): in a call in «Созвон», the «чат» hover
// action on «Переговорка» (Борис, Вера inside) opens its feed with «Вы не в голосе» + «Войти в
// голос»; the call in «Созвон» stays. (Not the other way round: «Созвон»'s history has an inline
// link, and inline links fail axe link-in-text-block — docs/09.)
test('voice-room-chat-preview', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.boris, content: 'Заходите, обсуждаем план релиза' });
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.vera, content: 'Показываю экран с макетами' });
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Созвон/ }).first().click();
  await expect(win.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await win.keyboard.press(`${MOD}+Shift+m`);
  await expect(win.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(win.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Чат комнаты «Переговорка»' }).click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const preview = win.getByTestId('voice-preview');
  await expect(preview).toContainText('Вы не в голосе');
  await expect(preview.getByRole('button', { name: 'Войти в голос' })).toBeVisible();
  await expect(win.getByRole('region', { name: 'Голосовое подключение' })).toContainText('Созвон');
  await expect(win.getByText('Показываю экран с макетами')).toBeVisible();
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'voice-room-chat-preview');
});

// Meeting recording cards (ADR-0025) in «Переговорка»'s chat: done (42 мин, «Открыть в GPTunneL»),
// still processing, failed for lack of balance before the upload («Отправить снова»), failed on
// GPTunneL's side after it («Проверить снова», docs/09 #40) — system messages across the whole
// feed (docs/09 #47), no bubble; «…» (the owner may delete, #50).
test('chat-recording-card', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.boris, content: 'Спасибо всем, запись будет в чате' });
  const web = `${MOCK_GPTUNNEL_WEB}/meetings/1`;
  mock.injectRecordingCard({ roomId: IDS.rooms.meeting, byUserId: IDS.users.boris, durationSec: 42 * 60 + 10, status: RecordingStatus.DONE, webUrl: web });
  mock.injectRecordingCard({ roomId: IDS.rooms.meeting, byUserId: IDS.users.vera, durationSec: 65 * 60, status: RecordingStatus.PROCESSING, webUrl: web });
  mock.injectRecordingCard({ roomId: IDS.rooms.meeting, byUserId: IDS.users.anna, durationSec: 18 * 60, status: RecordingStatus.FAILED, error: 'insufficient_balance', notUploaded: true });
  mock.injectRecordingCard({ roomId: IDS.rooms.meeting, byUserId: IDS.users.boris, durationSec: 27 * 60, status: RecordingStatus.FAILED, error: 'internal', webUrl: web });
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Чат комнаты «Переговорка»' }).click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const cards = win.getByTestId('recording-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('Встреча записана · 42 мин');
  await expect(cards.nth(0)).toContainText('Готово');
  // Across the feed (docs/09 #47): as wide as the message column, not a centred 440 px card.
  const feed = await win.locator('[data-virtuoso-scroller]').first().boundingBox();
  const box = await cards.nth(0).boundingBox();
  expect(feed && box && box.width).toBeGreaterThan((feed?.width ?? 0) - 48);
  await expect(cards.nth(1)).toContainText('Обработка: расшифровка и саммари…');
  await expect(cards.nth(2)).toContainText('Ошибка: на балансе GPTunneL не хватает средств');
  await expect(cards.nth(0).getByRole('button', { name: 'Открыть в GPTunneL' })).toBeVisible();
  await expect(cards.nth(2).getByRole('button', { name: 'Отправить снова' })).toBeVisible();
  await expect(cards.nth(2).getByRole('button', { name: 'Проверить снова' })).toHaveCount(0);
  await expect(cards.nth(3)).toContainText('Ошибка: сбой на стороне GPTunneL');
  await expect(cards.nth(3).getByRole('button', { name: 'Проверить снова' })).toBeVisible();
  await expect(cards.nth(3).getByRole('button', { name: 'Отправить снова' })).toHaveCount(0);
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'chat-recording-card');
});

/** «Переговорка»'s chat with a done recording card carrying its result (docs/09 #47). */
async function doneCard(win: Page, mock: MockServer): Promise<Locator> {
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.boris, content: 'Спасибо всем, запись будет в чате' });
  mock.injectRecordingCard({
    roomId: IDS.rooms.meeting,
    byUserId: IDS.users.boris,
    durationSec: 42 * 60 + 10,
    status: RecordingStatus.DONE,
    webUrl: `${MOCK_GPTUNNEL_WEB}/meetings/1`,
    result: true,
  });
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Чат комнаты «Переговорка»' }).click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const card = win.getByTestId('recording-card');
  await expect(card).toHaveCount(1);
  return card;
}

// A done recording (docs/09 #47): GPTunneL's summary folded to 6 lines («Показать всё»), «Послушать
// запись» (our AAC-in-MP4 copy, the chat's player: it plays and seeks), «Полный транскрипт».
test('chat-recording-done', async ({ open, win, mock, shot }) => {
  await open();
  const card = await doneCard(win, mock);
  const summary = card.getByTestId('recording-card-summary');
  await expect(summary).toContainText('Релиз 0.7');
  await expect(summary.locator('strong, b').first()).toHaveText('0.7');
  await expect(card.getByTestId('recording-card-more')).toHaveText('Показать всё');
  await expect(card.getByRole('button', { name: 'Полный транскрипт' })).toBeVisible();
  await card.getByRole('button', { name: 'Послушать запись' }).click();
  const player = card.getByTestId('audio-player');
  await expect(player).toHaveAttribute('data-playing', 'true');
  await expect(player).toContainText('Запись встречи');
  // AAC in MP4 decodes: the element reports the file's 6 s.
  await expect(player).toContainText('0:06');
  await player.getByRole('button', { name: 'Пауза' }).click();
  await expect(player).not.toHaveAttribute('data-playing');
  const seek = player.getByRole('slider', { name: 'Перемотка' });
  await seek.focus();
  await win.keyboard.press('Home');
  await win.keyboard.press('ArrowRight');
  await expect(seek).toHaveAttribute('aria-valuetext', '0:05 из 0:06');
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await feedAtBottom(win);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'chat-recording-done');
  await card.getByTestId('recording-card-more').click();
  await expect(summary).toContainText('Сколько дней хранить аудио');
  await expect(card.getByTestId('recording-card-more')).toHaveText('Свернуть');
});

// docs/09 #57: «Послушать запись» really plays — the chat's player is installed at startup, not by
// the first audio attachment on screen (the card's player mounts only once the track is active,
// so the click used to go nowhere: «playing», no sound, the time stuck at 0:00). The audio is a
// 64 s AAC with `moov` after `mdat`, like LiveKit Egress writes: Range requests for the tail first.
test('chat-recording-play', async ({ open, win, mock }) => {
  await open();
  const f = mock.state.files.get(IDS.files.meeting);
  if (!f) throw new Error('fixture: no meeting file');
  // Its own file id: the app's HTTP cache keeps the 6 s fixture under the usual one (immutable).
  const bytes = readFileSync(new URL('../e2e-support/fixtures/egress-recording.m4a', import.meta.url));
  const meta = { ...f.meta, id: '00000000-0000-7000-8005-0000000000e1', size: BigInt(bytes.length) };
  mock.state.files.set(IDS.files.meeting, { meta, bytes });
  mock.state.files.set(meta.id, { meta, bytes });
  const card = await doneCard(win, mock);
  await card.getByRole('button', { name: 'Послушать запись' }).click();
  const player = card.getByTestId('audio-player');
  await expect(player).toHaveAttribute('data-playing', 'true');
  await expect(player).toContainText('1:04');
  const seek = player.getByRole('slider', { name: 'Перемотка' });
  await expect.poll(async () => Number(await seek.getAttribute('aria-valuenow')), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
});

// «Полный транскрипт» (docs/09 #47): speakers, times, search that keeps the matching remarks, a
// click plays the recording from that remark (the chat's player), «Копировать», «Скачать .txt».
test('recording-transcript', async ({ open, win, mock, shot }) => {
  await open();
  const card = await doneCard(win, mock);
  await card.getByRole('button', { name: 'Полный транскрипт' }).click();
  const dialog = win.getByRole('dialog', { name: 'Транскрипт встречи' });
  await expect(dialog).toBeVisible();
  const rows = dialog.getByTestId('recording-transcript-row');
  await expect(rows.first()).toContainText('Спикер 1');
  await expect(rows.first()).toContainText('Коллеги, начнём');
  await dialog.getByRole('textbox', { name: 'Поиск по транскрипту' }).fill('эталоны');
  await expect(rows).toHaveCount(2);
  await expect(dialog).toContainText('Найдено: 2');
  await expect(dialog.getByRole('button', { name: 'Скачать .txt' })).toBeEnabled();
  await settle(win);
  await checkpoint(shot, 'recording-transcript');
  // A click plays the recording from that remark and marks it (the fixture audio is 6 s: the
  // first remark, 0:01–0:06).
  await dialog.getByRole('textbox', { name: 'Поиск по транскрипту' }).fill('');
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(card.getByTestId('audio-player')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

// «Удалить запись» (docs/09 #50): «…» → confirmation «Запись, транскрипт и саммари будут удалены у
// всех» → the card becomes «Запись встречи удалена · Удалил: …».
test('chat-recording-delete', async ({ open, win, mock, shot }) => {
  await open();
  const card = await doneCard(win, mock);
  await card.getByTestId('recording-card-menu').click();
  await win.getByRole('menuitem', { name: 'Удалить запись' }).click();
  const dialog = win.getByRole('dialog', { name: 'Удалить запись встречи?' });
  await expect(dialog).toContainText('Запись, транскрипт и саммари будут удалены у всех.');
  await settle(win);
  await checkpoint(shot, 'chat-recording-delete');
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(card).toHaveAttribute('data-status', 'deleted');
  await expect(card).toContainText('Запись встречи удалена');
  await expect(card).toContainText('Удалил: Анна');
  await expect(card.getByRole('button')).toHaveCount(0);
});

// Chat media (docs/09 #41, docs/08 «Медиа в чате»): Вера posts an audio / a video in «общий».
async function postMedia(win: Page, mock: MockServer, kind: 'audio' | 'video'): Promise<Locator> {
  await mainWindow(win, mock);
  const content = kind === 'audio' ? 'Джингл для релиза' : 'И ролик с анимацией';
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content, attachments: [IDS.files[kind]] });
  const player = win.getByTestId(`${kind}-player`);
  await expect(player).toBeVisible();
  return player;
}

const feedTo = (win: Page, where: 'top' | 'bottom'): Promise<void> =>
  win.locator('[data-virtuoso-scroller]').first().evaluate((el, w) => el.scrollTo({ top: w === 'top' ? 0 : el.scrollHeight }), where);

/** The feed at its bottom and at rest (the floating date pill faded out). */
async function feedAtBottom(win: Page): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await feedTo(win, 'bottom');
    await settle(win);
  }
  await expect(win.locator('[data-virtuoso-scroller][data-scrolling]')).toHaveCount(0);
  await settle(win);
}

// Audio: duration from the metadata probe; played, paused, set to 0:05 at 1.5×; the mini-player
// shows only while the message is scrolled away, and «close» stops the track.
test('chat-audio', async ({ open, win, mock, shot }) => {
  await open();
  const player = await postMedia(win, mock, 'audio');
  await expect(player).toContainText('Джингл релиза');
  await expect(player).toContainText('0:06 · Команда Calab');
  await player.getByRole('button', { name: 'Воспроизвести' }).click();
  await expect(player).toHaveAttribute('data-playing', 'true');
  await player.getByRole('button', { name: 'Пауза' }).click();
  await expect(player).not.toHaveAttribute('data-playing');
  await player.getByRole('button', { name: 'Скорость: 1×' }).click();
  const seek = player.getByRole('slider', { name: 'Перемотка' });
  await seek.focus();
  await win.keyboard.press('Home');
  await win.keyboard.press('ArrowRight');
  await expect(seek).toHaveAttribute('aria-valuetext', '0:05 из 0:06');
  await expect(win.getByTestId('mini-player')).toHaveCount(0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await feedAtBottom(win);
  await checkpoint(shot, 'chat-audio');
  // Space on the focused player toggles playback.
  await player.focus();
  await win.keyboard.press('Space');
  await expect(player).toHaveAttribute('data-playing', 'true');
  // Another room: the track keeps playing in the mini-player over that feed; «close» stops it.
  await win.locator('aside').getByRole('button', { name: /разработка/ }).first().click();
  await expect(win.getByRole('heading', { name: 'разработка' })).toBeVisible();
  const mini = win.getByTestId('mini-player');
  await expect(mini).toContainText('Джингл релиза');
  await expect(mini.getByRole('button', { name: 'Пауза' })).toBeVisible();
  await mini.getByRole('button', { name: 'Закрыть плеер' }).click();
  await expect(mini).toHaveCount(0);
});

// docs/09 #57: the mini-player shows whenever the playing message is off screen — above (newer
// messages pushed it up) or below (scrolled back into history) — over the top of the feed, and
// hides once the message is back in view.
test('chat-audio-mini', async ({ open, win, mock, shot }) => {
  await open();
  const player = await postMedia(win, mock, 'audio');
  await player.getByRole('button', { name: 'Воспроизвести' }).click();
  await expect(player).toHaveAttribute('data-playing', 'true');
  await player.getByRole('button', { name: 'Пауза' }).click();
  const seek = player.getByRole('slider', { name: 'Перемотка' });
  await seek.focus();
  await win.keyboard.press('Home');
  await win.keyboard.press('ArrowRight');
  await expect(seek).toHaveAttribute('aria-valuetext', '0:05 из 0:06');
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const mini = win.getByTestId('mini-player');
  await expect(mini).toHaveCount(0);
  // Newer messages push the message above the viewport.
  for (let i = 1; i <= 16; i++) mock.injectMessage({ roomId: IDS.rooms.general, authorId: i % 2 ? IDS.users.anna : IDS.users.grigory, content: `Сообщение после джингла №${i}` });
  await expect(win.getByText('Сообщение после джингла №16')).toBeVisible();
  await feedAtBottom(win);
  await expect(mini).toBeVisible();
  await expect(mini).toContainText('Джингл релиза');
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'chat-audio-mini');
  // Scrolled back past it into history: the message is below the viewport — still shown.
  await feedTo(win, 'top');
  await expect(win.getByTestId('audio-player')).toHaveCount(0);
  await expect(mini).toBeVisible();
  // «Показать сообщение»: the message comes into view and the strip goes.
  await mini.getByRole('button', { name: /Джингл релиза/ }).click();
  await expect(player).toBeInViewport();
  await expect(mini).toHaveCount(0);
});

// Video: the first frame as the poster with a play button and the duration; plays in place with
// the native controls; Escape leaves full screen.
test('chat-video', async ({ open, win, mock, shot }) => {
  await open();
  const player = await postMedia(win, mock, 'video');
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await expect(player).toContainText('0:03');
  await expect(player.getByRole('button', { name: 'На весь экран' })).toBeAttached();
  await feedAtBottom(win);
  await checkpoint(shot, 'chat-video');
  await player.getByRole('button', { name: 'Воспроизвести demo-clip.mp4' }).click();
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => v.controls && !v.paused)).toBe(true);
  await player.getByRole('button', { name: 'На весь экран' }).click();
  await expect.poll(() => win.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await win.keyboard.press('Escape');
  await expect.poll(() => win.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

// Issue #7: the lightbox opens at once with the thumbnail and a spinner (the full file held back by
// the mock), then shows the full image fitted whole into the window; ←/→ none (one image), Esc closes.
test('chat-lightbox', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.portrait] });
  const thumb = win.getByRole('button', { name: 'Открыть изображение «IMG_2041.png»' });
  await expect.poll(() => thumb.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // A mouse hover still opens the action bar (touch does not: MessageBubble useActionBar).
  await thumb.hover();
  await expect(win.locator('[data-message-actions]')).toBeVisible();
  mock.holdFiles();
  await thumb.click();
  const box = win.getByTestId('lightbox');
  const frame = box.getByTestId('lightbox-frame');
  await expect(frame).toHaveAttribute('data-state', 'loading');
  await expect(box.getByRole('status', { name: 'Загрузка изображения' })).toBeVisible();
  await expect.poll(() => frame.locator('img').first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // The top bar keeps clear of the macOS traffic lights (80 px, like the title bar).
  const title = await box.getByRole('heading', { name: 'IMG_2041.png' }).boundingBox();
  if (process.platform === 'darwin') expect(title?.x ?? 0).toBeGreaterThanOrEqual(80);
  await checkpoint(shot, 'chat-lightbox');
  mock.releaseFiles();
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await expect(box.getByRole('status')).toHaveCount(0);
  // Fitted, not zoomed: whole inside the window, the photo's proportions, as tall as the stage allows.
  const r = await frame.boundingBox();
  const vp = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  expect(r).not.toBeNull();
  if (r) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(vp.w);
    expect(r.y + r.height).toBeLessThanOrEqual(vp.h);
    expect(Math.abs(r.width / r.height - 720 / 1280)).toBeLessThan(0.01);
    expect(r.height).toBeGreaterThan(vp.h - 12 - 48 - 24 - 2);
  }
  await win.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
});

// Code blocks (docs/09 #45, docs/08 «Код в сообщениях»): Вера's 420-line log collapsed at 400
// lines (unknown language: plain), my js block highlighted; «Копировать» shows the toast; Enter
// inside an unclosed ``` adds a line instead of sending.
test('chat-code', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: CODE_FIXTURE.long });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: CODE_FIXTURE.js });
  await expect(win.getByText('Вот обработчик для поиска:')).toBeVisible();
  await feedAtBottom(win);
  const blocks = win.getByTestId('code-block');
  const js = blocks.last();
  await expect(js.locator('.syn-keyword').first()).toBeVisible();
  await expect(js).toContainText('js');
  await expect(win.getByRole('button', { name: 'Показать всё — 420 строк' })).toBeVisible();
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await feedAtBottom(win);
  await checkpoint(shot, 'chat-code');
  await js.hover();
  await js.getByTestId('code-copy').click();
  await expect(win.getByText('Скопировано')).toBeVisible();
  const field = win.getByTestId('composer').locator('textarea');
  await field.fill('```js');
  await field.press('Enter');
  await expect(field).toHaveValue('```js\n');
  await field.fill('');
});

// Voice messages (docs/09 #43, docs/08 «Голосовые сообщения»): recording with the fake mic
// (CALABA_FAKE_MEDIA) through the real Opus encoder and the mock's Ogg/Opus check.
async function holdMic(win: Page): Promise<Locator> {
  const mic = win.getByTestId('voice-button');
  const box = await mic.boundingBox();
  if (!box) throw new Error('no mic button');
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await expect(win.getByTestId('voice-recording')).toBeVisible();
  return mic;
}

// Hold → lock (slide up) → the locked strip (timer, live bars, «Отмена», send); send it; hold +
// release sends; hold + Esc and hold + slide left cancel.
test('chat-voice-recording', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const composer = win.getByTestId('composer');
  await expect(composer.getByRole('button', { name: 'Голосовое сообщение: удерживайте, чтобы записать' })).toBeVisible();
  const voices = win.locator('[data-own] [data-testid="voice-player"]');
  await expect(voices).toHaveCount(0);

  await holdMic(win);
  await expect(win.getByTestId('voice-lock')).toBeVisible();
  const box = await win.getByTestId('voice-button').boundingBox();
  if (!box) throw new Error('no mic button');
  await win.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 4 });
  await win.mouse.up();
  await expect(win.getByTestId('voice-lock')).toHaveCount(0);
  await expect(win.getByTestId('voice-recording').getByRole('button', { name: 'Отмена' })).toBeVisible();
  await win.evaluate(() => ((window as unknown as { __calabaVoiceElapsedMs?: number }).__calabaVoiceElapsedMs = 7400));
  await expect(win.getByTestId('voice-timer')).toHaveText('0:07,4');
  await checkpoint(shot, 'chat-voice-recording');
  await win.waitForTimeout(1200); // ≥ VOICE_MIN_MS of real audio
  await composer.getByRole('button', { name: 'Отправить' }).click();
  await expect(win.getByTestId('voice-recording')).toHaveCount(0);
  await expect(voices).toHaveCount(1);
  await expect(voices.first()).toContainText(/0:0[12]/);

  // Hold and release: sent at once.
  await holdMic(win);
  await win.waitForTimeout(1200);
  await win.mouse.up();
  await expect(voices).toHaveCount(2);
  // Hold + Esc, hold + slide left: dropped.
  await holdMic(win);
  await win.waitForTimeout(800);
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('voice-recording')).toHaveCount(0);
  await win.mouse.up();
  const mic = await holdMic(win);
  const b2 = await mic.boundingBox();
  if (!b2) throw new Error('no mic button');
  await win.mouse.move(b2.x - 150, b2.y + b2.height / 2, { steps: 6 });
  await expect(win.getByTestId('voice-recording')).toHaveCount(0);
  await win.mouse.up();
  await win.waitForTimeout(500);
  await expect(voices).toHaveCount(2);
});

// docs/09 #49: the strip and the lock are on the popover layer (portalled to <body>), over the
// feed's «вниз» button and the floating members panel of a narrow window; the lock is centred
// on the mic button.
test('chat-voice-recording-narrow', async ({ open, win, mock, shot, size: viewport }) => {
  test.skip(viewport.width >= 1200, 'the members panel floats below 1200 px');
  await open();
  await mainWindow(win, mock);
  await feedTo(win, 'top');
  await settle(win);
  await expect(win.getByRole('button', { name: 'К новым' })).toBeVisible();
  await membersList(win);
  await holdMic(win);
  const lock = win.getByTestId('voice-lock');
  await expect(lock).toBeVisible();
  const [l, m] = await Promise.all([lock.boundingBox(), win.getByTestId('voice-button').boundingBox()]);
  if (!l || !m) throw new Error('no lock / mic box');
  expect(Math.abs(l.x + l.width / 2 - (m.x + m.width / 2))).toBeLessThanOrEqual(1);
  // Topmost: the point in the middle of the lock and of the strip hits them, not a panel.
  for (const el of [lock, win.getByTestId('voice-recording')]) {
    const hit = await el.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(hit, `${await el.getAttribute('data-testid')} is on top`).toBe(true);
  }
  await win.evaluate(() => ((window as unknown as { __calabaVoiceElapsedMs?: number }).__calabaVoiceElapsedMs = 2300));
  await expect(win.getByTestId('voice-timer')).toHaveText('0:02,3');
  await checkpoint(shot, 'chat-voice-recording-narrow', { keepPointer: true });
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('voice-recording')).toHaveCount(0);
  await win.mouse.up();
});

// The bubble: waveform, duration, play / pause through the chat player, seek on the waveform
// (played part in the accent), time left, speed chip.
test('chat-voice-bubble', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.voice] });
  const player = win.getByTestId('voice-player');
  await expect(player).toBeVisible();
  await expect(player).toContainText('0:05');
  await player.getByRole('button', { name: 'Воспроизвести' }).click();
  await expect(player).toHaveAttribute('data-playing', 'true');
  await player.getByRole('button', { name: 'Пауза' }).click();
  await expect(player).not.toHaveAttribute('data-playing');
  const wave = player.getByRole('slider', { name: 'Перемотка' });
  const wb = await wave.boundingBox();
  if (!wb) throw new Error('no waveform');
  await win.mouse.click(wb.x + wb.width * 0.4, wb.y + wb.height / 2);
  await expect(wave).toHaveAttribute('aria-valuetext', '0:02 из 0:05');
  await expect(player).toContainText('0:03');
  await expect(player.getByRole('button', { name: 'Скорость: 1×' })).toBeVisible();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await feedAtBottom(win);
  await checkpoint(shot, 'chat-voice-bubble');
});

// Optimistic join (docs/05, docs/08): Григорий is in the room list at once but still connecting
// (VoiceState.pending) for more than 3 s — the «Подключается…» ring around his avatar (static
// under test-stable) in the sidebar row and the members column.
test('voice-room-pending', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  mock.setVoiceState({ userId: IDS.users.grigory, roomId: IDS.rooms.meeting, pending: true });
  const row = win.locator('aside').first().getByRole('listitem', { name: /Григорий/ });
  await expect(row).toHaveAttribute('data-pending', 'true');
  await expect(row.getByTestId('connect-ring')).toBeVisible({ timeout: 6000 }); // after 3 s
  await checkpoint(shot, 'voice-room-pending');
});

test('toast-device', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, true);
  // The OS switched the audio device (docs/09 #49): green toast with «Изменить» (faked switch).
  await win.evaluate(() => (window as unknown as { __calabaDeviceToast?: (k: string, l: string) => void }).__calabaDeviceToast?.('input', 'AirPods Pro'));
  await expect(win.getByTestId('toast')).toHaveCount(1);
  await expect(win.getByTestId('toast')).toContainText('Микрофон: AirPods Pro');
  await checkpoint(shot, 'toast-device');
  await win.getByTestId('toast').getByRole('button', { name: 'Изменить' }).click();
  await expect(win.getByRole('dialog').getByRole('tab', { name: 'Голос и устройства' })).toHaveAttribute('data-state', 'active');
});

test('stream-picker', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // Stream picker (docs/09 #13): synthetic sources from main (CALABA_VISUAL_TEST), no real screens.
  await win.getByRole('button', { name: 'Показать экран' }).first().click();
  await expect(win.getByTestId('stream-source').first()).toBeVisible();
  await checkpoint(shot, 'stream-picker');
});

test('stream-picker-screens', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await win.getByRole('button', { name: 'Показать экран' }).first().click();
  await expect(win.getByTestId('stream-source').first()).toBeVisible();
  await win.getByRole('radio', { name: 'Весь экран' }).click();
  await win.getByRole('button', { name: 'Дополнительно' }).click();
  await expect(win.getByTestId('stream-advanced')).toBeVisible();
  await checkpoint(shot, 'stream-picker-screens');
});

test('voice-reconnecting', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // Connection lost (docs/09 #15): the yellow notice in the voice panel.
  await win.evaluate(() => (window as unknown as { __calabaVoicePhase?: (p: string) => void }).__calabaVoicePhase?.('reconnecting'));
  await expect(win.getByTestId('voice-reconnecting')).toBeVisible();
  await checkpoint(shot, 'voice-reconnecting');
});

test('voice-member-menu', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // Member menu of someone in MY voice room (docs/09 #12): per-user volume + «Заглушить для меня».
  await win.locator('aside').getByRole('listitem', { name: /^Борис Петров/ }).click({ button: 'right' });
  await expect(win.getByRole('menu').getByRole('menuitem', { name: /^Громкость: / })).toBeVisible();
  await checkpoint(shot, 'voice-member-menu');
});

// ---- webcam (docs/09 #41–43)

test('voice-camera-menu', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await hideCameraPixels(win);
  await win.getByRole('button', { name: 'Выбор камеры' }).click();
  await expect(win.getByRole('menu').getByRole('menuitem', { name: 'Проверить камеру' })).toBeVisible();
  await checkpoint(shot, 'voice-camera-menu');
});

test('camera-preview', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await hideCameraPixels(win);
  // First start: the «Проверьте камеру» sheet with the mirrored preview.
  await win.getByTestId('camera-button').click();
  await expect(win.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await checkpoint(shot, 'camera-preview');
});

test('voice-camera-pip', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await checkpoint(shot, 'voice-camera-pip');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-camera-grid', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await cameraGrid(win);
    await checkpoint(shot, 'voice-camera-grid');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-camera-focus', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await cameraGrid(win);
    // Pin a tile: accent ring + pin badge, «Вернуться к сетке» in the header; Esc unpins.
    const meTile = win.getByRole('button', { name: 'Камера: Анна Смирнова' });
    await meTile.click();
    await expect(meTile).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('[data-testid="video-tile"][data-featured]')).toHaveAccessibleName('Камера: Анна Смирнова');
    await expect(win.getByRole('button', { name: 'Вернуться к сетке' })).toBeVisible();
    await checkpoint(shot, 'voice-camera-focus');
    await win.mouse.move(0, 0);
    await win.keyboard.press('Escape');
    await expect(meTile).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-camera-member-menu', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await cameraGrid(win);
    // Member menu on a tile: local «Не показывать видео», moderator «Выключить камеру».
    await win.getByRole('button', { name: 'Камера: Борис Петров' }).click({ button: 'right' });
    await expect(win.getByRole('menu').getByRole('menuitem', { name: 'Выключить камеру' })).toBeVisible();
    await expect(win.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Не показывать видео' })).toBeVisible();
    await checkpoint(shot, 'voice-camera-member-menu');
  } finally {
    await stopAll([pub]);
  }
});

// ---- stream (the room's chat is empty: docs/09 #56)

test('voice-stream-empty-room', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    // The stream opens expanded, the welcome becomes one row under the stage (still visible).
    await expect(win.getByTestId('empty-room')).toHaveAttribute('data-compact', 'true');
    await expect(win.getByTestId('empty-room').getByRole('heading')).toBeInViewport();
    await checkpoint(shot, 'voice-stream-empty-room');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-pip', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    // Collapsing to the PiP is remembered for this room; the welcome returns, centred.
    await win.getByTestId('stream-stage').getByRole('button', { name: 'Свернуть в угол' }).click();
    await expect(win.getByTestId('stream-pip')).toBeVisible();
    await expectWelcomeCentred(win);
    await checkpoint(shot, 'voice-pip');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-pip-hover', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    await win.getByTestId('stream-stage').getByRole('button', { name: 'Свернуть в угол' }).click();
    // PiP controls (expand / close): shown on hover or keyboard focus. checkpoint() parks the
    // pointer, so the shot uses focus; toBeVisible() passes at opacity 0 — check the opacity.
    const stopWatching = win.getByTestId('stream-pip').getByRole('button', { name: 'Не смотреть' });
    await stopWatching.focus();
    await expect(stopWatching.locator('..')).toHaveCSS('opacity', '1');
    await checkpoint(shot, 'voice-pip-hover');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-stream', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    await streamExpandedAgain(win);
    await checkpoint(shot, 'voice-stream');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-stream-controls', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    await streamExpandedAgain(win);
    // Control bar (docs/09 #14): shows on hover / keyboard focus.
    await win.getByTestId('stream-controls').getByRole('button', { name: /^Качество:/ }).focus();
    await checkpoint(shot, 'voice-stream-controls');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-streams-strip', async ({ open, win, mock, shot }) => {
  await open();
  const pubs = await withTwoStreams(win, mock);
  try {
    await checkpoint(shot, 'voice-streams-strip');
  } finally {
    await stopAll(pubs);
  }
});

for (let i = 1; i <= TABS['voice-room-settings']; i++) {
  test(`voice-room-settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    const pubs = await withTwoStreams(win, mock);
    try {
      await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), i);
      await checkpoint(shot, `voice-room-settings-${i}`);
    } finally {
      await stopAll(pubs);
    }
  });
}

// ---------------------------------------------------------------- first run (no workspaces)

async function firstRun(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Создать пространство' }).first()).toBeVisible();
}

test('welcome', async ({ open, win, shot }) => {
  await open({ scenario: 'empty' });
  await firstRun(win);
  await checkpoint(shot, 'welcome');
});

test('workspace-create', async ({ open, win, shot }) => {
  await open({ scenario: 'empty' });
  await firstRun(win);
  await win.getByRole('button', { name: 'Создать пространство' }).first().click();
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'workspace-create');
});

test('workspace-join', async ({ open, win, shot }) => {
  await open({ scenario: 'empty' });
  await firstRun(win);
  await win.getByRole('button', { name: 'Присоединиться' }).first().click();
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'workspace-join');
});

// ---------------------------------------------------------------- geometry helpers

interface OnbGeometry {
  step: string;
  dots: number;
  title: number;
  card: { top: number; bottom: number; height: number };
  footer: number;
  /** Body centre minus the centre of the space between header and footer (null: no body). */
  bodyOffset: number | null;
  /** Gap above / below the whole composition inside the content area. */
  above: number;
  below: number;
}

async function onboardingGeometry(page: Page, step: string): Promise<OnbGeometry> {
  return page.evaluate((stepName) => {
    const col = document.querySelector('[data-testid^="onboarding-"]');
    const scroller = col?.parentElement;
    const card = col?.querySelector('[data-onb-card]');
    const dots = col?.querySelector('ol');
    const title = col?.querySelector('h1');
    if (!col || !scroller || !card || !dots || !title) throw new Error(`onboarding layout not found (${stepName})`);
    const r = (e: Element): DOMRect => e.getBoundingClientRect();
    const box = r(col);
    const area = r(scroller);
    return {
      step: stepName,
      dots: Math.round(r(dots).top),
      title: Math.round(r(title).top),
      card: { top: Math.round(r(card).top), bottom: Math.round(r(card).bottom), height: Math.round(r(card).height) },
      footer: Math.round(r(col.querySelector('[data-onb-footer]') ?? card).top),
      bodyOffset: (() => {
        const a = col.querySelector('[data-onb-area]');
        const b = col.querySelector('[data-onb-body]');
        if (!a || !b) return null;
        const ra = r(a);
        const rb = r(b);
        return Math.round(rb.top + rb.height / 2 - (ra.top + ra.height / 2));
      })(),
      above: Math.round(box.top - area.top),
      below: Math.round(area.bottom - box.bottom),
    };
  }, step);
}

/**
 * Owner's rule for onboarding: the composition is centred in the window, and on windows ≥ 600 px
 * tall the dots, the title and the card edges (Back/Continue sit on its bottom) stay put between
 * steps — the card is as tall as the tallest step (488 px) and no step outgrows it.
 */
function expectStableOnboarding(steps: OnbGeometry[], windowHeight: number): void {
  for (const g of steps) {
    expect(Math.abs(g.above - g.below), `onboarding centred: ${g.step}`).toBeLessThanOrEqual(2);
    // docs/09 #55: every step has a body, centred between the header and the footer.
    expect(g.bodyOffset, `onboarding body present: ${g.step}`).not.toBeNull();
    expect(Math.abs(g.bodyOffset ?? 99), `onboarding body centred: ${g.step}`).toBeLessThanOrEqual(4);
  }
  if (windowHeight < 600) return;
  const [first] = steps;
  if (!first) return;
  for (const g of steps) {
    expect(g.card.height, `onboarding card height: ${g.step}`).toBe(488);
    expect({ dots: g.dots, title: g.title, card: g.card, footer: g.footer }, `onboarding geometry: ${g.step}`).toEqual({
      dots: first.dots,
      title: first.title,
      card: first.card,
      footer: first.footer,
    });
  }
}

/** Waits until `n` <video> elements show decoded frames (before that a tile shows its placeholder). */
async function expectFrames(page: Page, n: number): Promise<void> {
  await expect
    .poll(() => page.locator('video').evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth > 0).length), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(n);
  await settle(page);
}

/** docs/09 #56: in an empty room the welcome block sits in the vertical centre of the message area. */
async function expectWelcomeCentred(page: Page): Promise<void> {
  const off = await page.getByTestId('empty-room').evaluate((area) => {
    const w = area.querySelector('[data-testid="empty-room-welcome"]');
    if (!w) return null;
    const a = area.getBoundingClientRect();
    const b = w.getBoundingClientRect();
    return Math.round(b.top + b.height / 2 - (a.top + a.height / 2));
  });
  expect(off, 'empty-room welcome present').not.toBeNull();
  expect(Math.abs(off ?? 99), 'empty-room welcome centred').toBeLessThanOrEqual(4);
}

// ---------------------------------------------------------------- stickers (ADR-0030)

/**
 * Stickers stand still for the shots: reduced motion shows an animated one's first frame
 * (the playback rule itself, docs/08 «Стикеры»), drawn on a canvas.
 */
async function stillStickers(win: Page, n: number): Promise<void> {
  await expect(win.locator('[data-sticker-still][data-drawn]')).toHaveCount(n);
}

// A sticker message from Вера (animated, standing still) and my own: 160 px, no bubble, the time
// on a pill; a click on a sticker opens its pack («Убрать из моих»: «Calab» is installed).
test('chat-sticker', async ({ open, win, mock, shot }) => {
  await open();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', stickerId: IDS.stickers.orbit });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: '', stickerId: IDS.stickers.sun });
  await expect(win.getByTestId('sticker-message')).toHaveCount(2);
  await stillStickers(win, 1);
  await feedAtBottom(win);
  await checkpoint(shot, 'chat-sticker');
  await win.getByRole('button', { name: 'Стикер 🌀' }).click();
  const dialog = win.getByRole('dialog', { name: 'Calab' });
  await expect(dialog.getByTestId('sticker-pack-grid').locator('[data-sticker]')).toHaveCount(3);
  await expect(dialog.getByTestId('sticker-pack-action')).toHaveText('Убрать из моих');
});

// The composer's «Стикеры» panel (Telegram Desktop): search, the strip of pack covers, my pack
// «Calab» in 104 px tiles (4 a row), the workspace's «Эмоции» to add; a pick sends the sticker and closes it.
test('sticker-picker', async ({ open, win, mock, shot }) => {
  await open();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await mainWindow(win, mock);
  await win.getByTestId('sticker-button').click();
  const panel = win.getByTestId('sticker-panel');
  await expect(panel.getByTestId('sticker-packs').locator('[aria-current="true"]')).toHaveAccessibleName('Calab');
  const grid = panel.getByTestId('sticker-grid');
  await expect(grid.locator('button[data-sticker-pick]')).toHaveCount(3);
  await expect(grid.getByRole('button', { name: 'Добавить' })).toBeVisible();
  await stillStickers(win, 1); // the animated 🌀 in the grid (covers are the static ☀️)
  await checkpoint(shot, 'sticker-picker');
  await grid.getByRole('button', { name: 'Стикер 💎' }).click();
  await expect(panel).toHaveCount(0);
  await expect(win.getByTestId('sticker-message')).toHaveCount(1);
});

// Workspace settings → «Стикеры» → the pack «Calab»: name, the drop zone, the stickers with their
// emoji (the first is the cover) and the «⋯» menu of one of them open.
test('settings-stickers', async ({ open, win, mock, shot }) => {
  await open();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Стикеры' }).click();
  await expect(dialog.getByTestId('sticker-pack-row')).toHaveCount(2);
  await dialog.getByTestId('sticker-pack-row').filter({ hasText: 'Calab' }).click();
  await expect(dialog.getByTestId('sticker-pack-title')).toHaveText('Calab');
  await expect(dialog.getByTestId('sticker-pack-stickers').locator('[data-sticker]')).toHaveCount(3);
  await stillStickers(win, 1);
  // «⋯» of the second sticker: «Заменить файл», «Изменить эмодзи», «Сделать обложкой», «Удалить».
  await dialog.getByTestId('sticker-cell').nth(1).hover();
  await dialog.getByTestId('sticker-cell').nth(1).getByTestId('sticker-actions').click();
  await expect(win.getByRole('menuitem', { name: 'Заменить файл' })).toBeVisible();
  await checkpoint(shot, 'settings-stickers');
});

// The pack «Calab» with two files staged and «Загрузить» pressed: a 1024×1024 PNG prepared on the
// client (512×512 WebP, «уменьшено до 512») and an animated WebP the server refused (12 s long) —
// the reason on its card, the prepared one stays staged.
test('settings-stickers-upload', async ({ open, win, mock, shot }) => {
  await open();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Стикеры' }).click();
  await dialog.getByTestId('sticker-pack-row').filter({ hasText: 'Calab' }).click();
  await expect(dialog.getByTestId('sticker-pack-title')).toHaveText('Calab');
  const big = encodePng(1024, 1024, (u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.38 ? [255, 196, 45] : [58, 124, 246]));
  const slow = slowWebpAnimation(readFileSync(new URL('../e2e-support/fixtures/sticker-orbit.webp', import.meta.url)), 2000);
  await dialog.getByTestId('sticker-file-input').setInputFiles([
    { name: 'sun-1024.png', mimeType: 'image/png', buffer: big },
    { name: 'orbit-slow.webp', mimeType: 'image/webp', buffer: slow },
  ]);
  const items = dialog.getByTestId('sticker-staged-item');
  await expect(items.and(win.locator('[data-state="ready"]'))).toHaveCount(2);
  await expect(items.first().getByTestId('sticker-scaled')).toHaveText('уменьшено до 512');
  await dialog.getByTestId('sticker-upload').click();
  await expect(items.nth(1).getByTestId('sticker-item-error')).toHaveText('Анимация дольше 10 секунд');
  await expect(items.first()).toHaveAttribute('data-state', 'ready');
  await stillStickers(win, 2);
  await checkpoint(shot, 'settings-stickers-upload');
});

// ---------------------------------------------------------------- bots (ADR-0031)

/** Workspace settings → «Боты» with the two seeded bots (mock.seedBots()). */
async function botsTab(win: Page, mock: MockServer): Promise<Locator> {
  mock.seedBots();
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Боты' }).click();
  await expect(dialog.getByTestId('bot-row')).toHaveCount(2);
  return dialog;
}

// «Боты»: create form, add by @username, the plan line, the list — «Погода» (webhook delivering)
// and «Деплой» (webhook failing since 12:12, 7 queued), each with «…».
test('settings-bots', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const dialog = await botsTab(win, mock);
  await expect(dialog.getByTestId('bot-status').filter({ hasText: 'HTTP 502' })).toBeVisible();
  await checkpoint(shot, 'settings-bots');
});

// «Создать бота» → the token once: read-only field with «Копировать» and the warning.
test('settings-bot-token', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const dialog = await botsTab(win, mock);
  await dialog.getByTestId('bot-name').fill('Эхо');
  await dialog.getByTestId('bot-username').fill('echo_bot');
  await dialog.getByTestId('bot-create').click();
  const token = win.getByTestId('bot-token-dialog');
  await expect(token).toBeVisible();
  await expect(token.getByTestId('bot-token')).toHaveValue(/^calab_bot_/);
  await checkpoint(shot, 'settings-bot-token');
  await win.getByTestId('bot-token-done').click();
  await expect(token).toHaveCount(0);
  // The settings sheet was aria-hidden under the token dialog; the new bot is in the list.
  await expect(dialog.getByTestId('bot-row')).toHaveCount(3);
});

// A bot's card from the members list («Боты — 2» section): «БОТ», @username, description,
// «Команды», «Добавить в пространство…» (where I manage and it is not yet) and «Заблокировать».
test('bot-profile', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.seedBots();
  const members = await membersList(win);
  await expect(members.getByRole('heading', { name: /Боты — 2/ })).toBeVisible();
  await members.getByRole('button', { name: /Погода/ }).click();
  const card = win.getByRole('dialog', { name: 'Погода' });
  await expect(card.getByTestId('bot-commands').getByRole('listitem')).toHaveCount(4);
  await expect(card.getByTestId('bot-block')).toBeVisible();
  await checkpoint(shot, 'bot-profile');
});

// «/» at the start of the field: the room's bot commands («/cmd — описание · @bot»); a sent
// «/weather Москва» shows the command as inline code, the bot's answer carries «БОТ».
test('chat-bot-commands', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.seedBots();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: '/weather Москва' });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.bots.weather, content: 'Москва: −3 °C, облачно, ветер 4 м/с. Вечером снег.' });
  await expect(win.getByText('Москва: −3 °C', { exact: false })).toBeVisible();
  await feedAtBottom(win);
  // Under the popover in the shot: the command as inline code, «БОТ» on the answer's author line.
  const feed = win.locator('[data-virtuoso-scroller]').first();
  await expect(feed.locator('code', { hasText: '/weather' })).toBeVisible();
  await expect(feed.locator('[data-bot-badge]')).toHaveCount(1);
  const field = win.getByRole('textbox', { name: /Сообщение в/ });
  await field.click();
  await field.pressSequentially('/');
  const popover = win.getByTestId('bot-command-popover');
  await expect(popover.getByRole('option')).toHaveCount(4);
  await field.press('ArrowDown');
  await expect(popover.getByRole('option', { selected: true })).toContainText('/help');
  await checkpoint(shot, 'chat-bot-commands');
  await field.press('Enter');
  await expect(field).toHaveValue('/help ');
  await expect(popover).toHaveCount(0);
});
