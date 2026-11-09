import { seedInlineButtons } from '../e2e-support/inline-buttons';
import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { AiState, FormerMemberReason, PERMISSION_BITS, PermissionTargetType, Plan, RecordingStatus, ReportReason, RoomPermissionOverrideSchema, UserReportSchema, UserSchema, WorkspaceBanSchema, WorkspacePlanSchema, WorkspaceRole, WorkspaceSuspensionSchema } from '@calaba/protocol';
import type { Locator, Page } from '@playwright/test';
import { FREE_PLAN_LIMITS, defaultSettings, mockPdf, ts } from '../e2e-support/fixtures';
import { CODE_FIXTURE, IDS, MOCK_GPTUNNEL_CODE, MOCK_GPTUNNEL_WEB, PASSWORD, RECORDING_FIXTURE, slowWebpAnimation, type MockServer } from '../e2e-support/mock-server';
import { encodePng } from '../e2e-support/png';
import { expect, test } from './app';
import { NOW, checkpoint, expectAssigneeStacks, expectToolbarHeights, joinVoice, login, seedAssigneeCounts, seedBotAuthoredTask, seedDays, seedLabelOverflow, seedReleases, seedRichComments, seedViaMcp, settle } from './harness';
import { DAY, seedDay } from './calendarWeb';
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
 * The local set (~25): one shot per screen family, no per-menu-item or per-tab shots. Settings
 * (named by tab id): «Основное» (theme, language), «Голос и устройства», «Горячие клавиши»;
 * «О программе» — `settings-about` (an available update, docs/09 #93).
 */
const KEY = new Set([
  'auth-login',
  'auth-login-failed',
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
  'dm-chat-days',
  'chat-inline-buttons',
  'sidebar-drag',
  'chat-hover-actions',
  'chat-hover-actions-bounds',
  'tooltip-lazy',
  'chat-context-menu',
  'room-notify-menu',
  'inbox-popover',
  'inbox-badge-rooms',
  'dm-list',
  'nav-badges',
  'dm-archive',
  'dm-delete-confirm',
  'dm-chat',
  'notes-shelf',
  'voice-room-status',
  'voice-room-recording',
  'voice-room-recording-menu',
  'chat-recording-card',
  'chat-recording-done',
  'chat-recording-reply-permissions',
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
  'voice-room-ptt-idle',
  'voice-room-ptt-remote',
  'voice-room-pending',
  'voice-room-joined',
  'voice-stream',
  'voice-pip',
  'voice-camera-grid',
  'voice-camera-pip',
  'camera-preview',
  'camera-bg-live',
  'voice-noise-popover',
  'voice-soundboard',
  'main-members-toggled',
  'main-members-birthday',
  'main-members-roles',
  'members-menu',
  'members-profile-switch',
  'profile-dialog',
  'settings-profile-delete', // ADR-0153: account deletion (entry, blocker, password step)
  'profile-menu',
  'profile-birthday',
  'chat-birthday-card',
  'chat-lightbox',
  'chat-lightbox-paged',
  'workspace-menu',
  'sidebar-create-menu',
  'self-mic-menu',
  'self-status-menu',
  'self-custom-status',
  'quick-switcher',
  'settings-general',
  'settings-voice',
  'settings-hotkeys',
  'settings-about',
  'update-bar',
  'room-settings-1',
  'room-settings-restricted',
  'room-settings-picture',
  'chat-room-icon-system',
  'sidebar-room-picture',
  'i18n-en-main-chat',
  'settings-plan',
  'settings-gptunnel',
  'settings-members',
  'settings-members-birthday',
  'settings-roles',
  'settings-role-edit',
  'admin-workspaces',
  'admin-plan',
  'admin-suspend',
  'settings-bans',
  // Former members (ADR-0097).
  'former-tab',
  'former-chip',
  'former-task',
  'workspace-suspended',
  'chat-sticker',
  'sticker-picker',
  'chat-sticker-suggest',
  'settings-stickers',
  'settings-stickers-upload',
  'settings-stickers-emoji',
  'settings-bots',
  'settings-bot-token',
  'bot-profile',
  // A member lets a bot act on their behalf (ADR-0111).
  'bot-delegation',
  'chat-bot-commands',
  'chat-forward-dialog',
  'chat-forwarded',
  'settings-badges',
  'settings-backgrounds',
  'settings-sounds',
  'chat-badge',
  // One-to-one calls (ADR-0034).
  'call-outgoing',
  'call-incoming',
  'dm-in-call',
  'members-menu-call',
  // Calendar (ADR-0038 §7).
  'calendar-mini',
  'calendar-day',
  'calendar-week',
  'calendar-dialog',
  'calendar-dialog-picker',
  // Free / busy, find a time, Settings → Календарь (ADR-0041).
  'calendar-filter',
  'calendar-findtime',
  'settings-calendar',
  // Extra time zones of the hour axis (board #85).
  'calendar-zones',
  // External calendar event details (ADR-0045).
  'calendar-external',
  'settings-caldav',
  // Guest admission (ADR-0040).
  'members-admissions',
  // Task boards (ADR-0042 §5).
  'boards-kanban',
  'boards-kanban-assignees',
  'boards-status-menu',
  'boards-create-menu',
  'boards-task',
  'boards-bot-consent',
  // «Комментарии | История» of the task panel (ADR-0091).
  'boards-task-comments',
  'boards-task-comments-days',
  'boards-task-comments-rich',
  'boards-task-history',
  'boards-list',
  'boards-labels-overflow',
  'boards-filter',
  'boards-settings',
  // Status colour and icon pickers (ADR-0093).
  'boards-settings-color',
  'boards-settings-icon',
  // Timeline and task cards in chat (ADR-0042 §5, 1.1.0).
  'boards-timeline',
  'chat-task-card',
  // Temporary rooms (ADR-0044).
  'sidebar-temp-room',
  'temp-room-dialog',
  'temp-room-dialog-expanded',
  'temp-room-dialog-result',
  'temp-room-menu',
  'settings-temp-archive',
  // Toasts at the top right and the join question of a reminder.
  'toasts',
  'toast-single',
  'join-confirm',
  'join-confirm-switch',
  // «Войти через Calab» of a workspace app's site (ADR-0159).
  'app-sign-in',
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

/** App settings tabs in order (AppSettingsDialog); «О программе» (last) is `settings-about`. */
const SETTINGS_TABS = ['general', 'profile', 'voice', 'hotkeys', 'notifications', 'calendar', 'connection', 'sessions'] as const;
/** 1-based position of an app settings tab, for openSettingsTab. */
const appTab = (id: (typeof SETTINGS_TABS)[number]): number => SETTINGS_TABS.indexOf(id) + 1;

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
  // 3.0: a click on a voice room opens it; the voice is joined from its header («Войти в голос»).
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await page.getByRole('region', { name: 'Переговорка' }).getByRole('button', { name: 'Войти в голос', exact: true }).click();
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

/** The call view (ADR-0066 «Галерея», the default) with 3 equal tiles: two cameras + Вера's avatar tile. */
async function cameraGrid(page: Page): Promise<void> {
  await page.getByTestId('camera-pip').getByRole('button', { name: 'Развернуть видео' }).first().click();
  await expect(page.getByTestId('video-grid')).toBeVisible();
  await expect(page.getByTestId('video-grid')).toHaveAttribute('data-view', 'gallery');
  await expect(page.getByRole('button', { name: 'Камера: Борис Петров' })).toBeVisible({ timeout: 30_000 });
  await expectFrames(page, 2);
  await expect(page.getByTestId('video-tile')).toHaveCount(3);
  await expect(page.locator('[data-testid="video-tile"][data-featured]')).toHaveCount(0);
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

/** A wrong password (401): the recovery becomes the error line's action (docs/09 #119). */
test('auth-login-failed', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await win.getByLabel('Email').fill('owner@calaba.test');
  await win.getByLabel('Пароль', { exact: true }).fill('wrong-password');
  await win.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(win.getByTestId('auth-login-failed')).toBeVisible();
  await expect(win.getByRole('button', { name: 'Восстановить пароль?' })).toBeVisible();
  await checkpoint(shot, 'auth-login-failed');
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

/**
 * «Забыли пароль?» → the code step: code field with the resend timer, new password. The address
 * is normalised and shown; a sibling-domain account (owner@calaba.test for .ru) adds the yellow
 * hint with «Изменить адрес» (docs/09 #137).
 */
test('auth-forgot', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await win.getByRole('button', { name: 'Забыли пароль?' }).click();
  await win.getByLabel('Email').fill('  Owner@Calaba.ru ');
  await win.getByRole('button', { name: 'Отправить код' }).click();
  await expect(win.getByTestId('forgot-code')).toBeVisible();
  await expect(win.getByText('Если аккаунт существует, мы отправили код на owner@calaba.ru.')).toBeVisible();
  await expect(win.getByTestId('forgot-similar')).toContainText('есть похожий на другом домене');
  await win.getByRole('textbox', { name: 'Код из письма' }).fill('123456');
  await checkpoint(shot, 'auth-forgot');
  // «Изменить адрес» → back to the field with the sent address; the exact one gets no hint.
  await win.getByRole('button', { name: 'Изменить адрес' }).click();
  await expect(win.getByLabel('Email')).toHaveValue('owner@calaba.ru');
  await win.getByLabel('Email').fill('owner@calaba.test');
  await win.getByRole('button', { name: 'Отправить код' }).click();
  await expect(win.getByText('Если аккаунт существует, мы отправили код на owner@calaba.test.')).toBeVisible();
  await expect(win.getByTestId('forgot-similar')).toHaveCount(0);
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
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
  await win.getByRole('menuitem', { name: 'Пригласить', exact: true }).click();
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
  // Board #145: READY leaves the open workspace out while its access lease is pending — «Подключение…»
  // in its place (the other workspaces stay on the rail), never «Создать пространство».
  mock.readyPending(IDS.workspaces.main);
  await expect(win.getByTestId('shell-connecting')).toBeVisible();
  await checkpoint(shot, 'workspace-pending');
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

  // CBF-159: the message search above the list. «ер» — Вера by name («Чаты») and the messages with it in «Сообщения»; a click opens the chat on the message, the results stay.
  const field = win.getByTestId('dm-search');
  await field.fill('ер');
  const hits = win.getByTestId('dm-search-hits');
  await expect(win.getByTestId('dm-search-chats').getByRole('button', { name: /Вера/ })).toBeVisible();
  await expect(hits.getByTestId('dm-hit').first()).toBeVisible();
  await expect(win.getByTestId('dm-list')).toBeHidden();
  await settle(win);
  await checkpoint(shot, 'dm-search');
  await hits.getByRole('button', { name: /Супер/ }).click();
  await expect(win.getByTestId('dm-search-results')).toBeVisible();
  await expect(win.getByText('Макеты рейла готовы')).toBeVisible();
  await field.fill('ре');
  await expect(hits.getByTestId('dm-hit').first()).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'dm-search-hits');
  await field.fill('qzxw');
  await expect(win.getByTestId('dm-search-empty')).toBeVisible();
  await checkpoint(shot, 'dm-search-empty');
  // Esc clears the query: the list is back.
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(win.getByTestId('dm-list')).toBeVisible();
});

// Count badges (owner 07.10): 1 and 2 digits are perfect circles, 99+ is a pill; the rail tile and the DM rows.
test('nav-badges', async ({ open, win, mock, shot }) => {
  const burst = (roomId: string, authorId: string, n: number): void => {
    for (let i = 0; i < n; i++) mock.injectMessage({ roomId, authorId, content: `Сообщение ${i + 1}` });
  };
  await open(DM_SEED);
  const list = win.getByTestId('dm-list');
  await expect(list.getByRole('button')).toHaveCount(3);
  burst(IDS.dms.vera, IDS.users.vera, 1);
  burst(IDS.dms.boris, IDS.users.boris, 9);
  burst(IDS.dms.grigory, IDS.users.grigory, 99);
  const badges = win.locator('[data-count-badge]');
  await expect(badges.filter({ hasText: '99+' }).first()).toBeVisible();
  await settle(win);
  for (const b of await badges.all()) {
    const box = await b.boundingBox();
    const text = ((await b.textContent()) ?? '').trim();
    if (!box) continue;
    const label = `badge «${text}» ${box.width}x${box.height}`;
    if (text.length <= 2) expect(Math.round(box.width), label).toBe(Math.round(box.height));
    else expect(box.width, label).toBeGreaterThan(box.height);
  }
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'nav-badges');
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
  await win.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
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

test('dm-chat', async ({ open, win, mock, shot }) => {
  await open(DM_SEED);
  const list = await dmHome(win);
  // docs/09 #92: Борис read «Да, после обеда.» (✓✓), not the answer below (✓).
  mock.injectMessage({ roomId: IDS.dms.boris, authorId: IDS.users.anna, content: 'Посмотрела, пара замечаний в PR.' });
  await list.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByTestId('dm-header')).toContainText('Борис Петров');
  await expect(win.locator('[data-message-id]').first()).toBeVisible();
  // The pinned strip (Борис's checklist) and the whole history (4 messages + the answer) are in.
  await expect(win.locator('[data-message-id]')).toHaveCount(5);
  await expect(win.getByLabel('Прочитано').filter({ visible: true })).toHaveCount(1);
  await expect(win.getByLabel('Отправлено').filter({ visible: true })).toHaveCount(1);
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(win);
  await checkpoint(shot, 'dm-chat');
  // #87: day pills in a chat (Сегодня / Вчера / «12 января» / the other year), each once.
  seedDays(mock, IDS.dms.grigory); // a DM not opened yet: its history comes from the mock when opened
  await list.getByRole('button', { name: /Григорий/ }).click();
  await expect(win.getByRole('separator').filter({ hasText: 'Вчера' })).toHaveCount(1);
  await expect(win.getByRole('separator').filter({ hasText: '12 января' })).toHaveCount(1);
  await expect(win.getByRole('separator').filter({ hasText: '2024' })).toHaveCount(1);
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await checkpoint(shot, 'dm-chat-days', { axe: false });
});

/**
 * «Заметки» (ADR-0039): three shelves above the DMs (emoji, name, the last note), «Идеи» open —
 * its header («Только для вас»), a note and a note forwarded from Борис, the shelf's composer.
 */
test('notes-shelf', async ({ open, win, mock, shot }) => {
  await open(DM_SEED);
  await dmHome(win);
  const ideas = mock.addShelf(IDS.users.anna, 'Идеи', '💡');
  const links = mock.addShelf(IDS.users.anna, 'Ссылки', '🔗');
  mock.addShelf(IDS.users.anna, 'Черновики', '');
  mock.injectMessage({ roomId: links, authorId: IDS.users.anna, content: 'https://calab.ru/docs' });
  mock.injectMessage({ roomId: ideas, authorId: IDS.users.anna, content: 'Тёмная тема для лендинга — показать на планёрке' });
  mock.injectMessage({ roomId: ideas, authorId: IDS.users.anna, content: 'Релиз 0.9 — в пятницу, после ревью', forward: { authorId: IDS.users.boris, sentAtMs: Date.parse('2026-01-14T16:05:00Z') } });
  const shelves = win.getByTestId('notes-shelf');
  await expect(shelves).toHaveCount(3);
  await shelves.filter({ hasText: 'Идеи' }).getByRole('button').first().click();
  await expect(win.getByTestId('notes-header-bar')).toContainText('Идеи');
  await expect(win.locator('[data-message-id]')).toHaveCount(2);
  await expect(shelves.filter({ hasText: 'Черновики' })).toContainText('Перетащите сюда сообщения или файлы');
  await settle(win);
  await checkpoint(shot, 'notes-shelf');
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

// ---------------------------------------------------------------- one-to-one calls (ADR-0034)

/** Борис's DM open (the call screens start from it); returns its feed ready. */
async function borisDm(page: Page): Promise<void> {
  const list = await dmHome(page);
  await list.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(page.getByTestId('dm-header')).toContainText('Борис Петров');
  await expect(page.locator('[data-message-id]')).toHaveCount(4);
  await settle(page);
}

test('call-outgoing', async ({ open, win, shot }) => {
  await open(DM_SEED);
  await borisDm(win);
  // The phone left of «⋯» in the DM header → «Вызов…» over the chat.
  await win.getByTestId('dm-call').click();
  const modal = win.getByTestId('call-outgoing');
  await expect(modal).toContainText('Борис Петров');
  await expect(modal.getByRole('button', { name: 'Отменить' })).toBeFocused();
  await settle(win);
  await checkpoint(shot, 'call-outgoing');
  // A click outside collapses it into the top strip; «Отменить» there ends the call → the log line.
  await win.mouse.click(24, 300);
  const strip = win.getByTestId('call-strip');
  await expect(strip).toContainText('Вызов: Борис Петров');
  await strip.getByRole('button', { name: 'Отменить' }).click();
  await expect(strip).toHaveCount(0);
  await expect(win.getByTestId('call-log').last()).toContainText('Отменённый звонок');
});

test('call-incoming', async ({ open, win, mock, shot }) => {
  await open(DM_SEED);
  await borisDm(win);
  mock.ringCall(IDS.users.boris, IDS.users.anna);
  const modal = win.getByTestId('call-incoming');
  await expect(modal).toContainText('Входящий звонок');
  await expect(modal.getByRole('button', { name: 'Принять' })).toBeFocused();
  await settle(win);
  await checkpoint(shot, 'call-incoming');
  // «Отклонить»: the modal closes, the log says so (not red: only a missed call is).
  await modal.getByRole('button', { name: 'Отклонить' }).click();
  await expect(modal).toHaveCount(0);
  await expect(win.getByTestId('call-log').last()).toContainText('Отклонённый звонок');
});

test('dm-in-call', async ({ open, win, mock, shot }) => {
  await open(DM_SEED);
  await borisDm(win);
  mock.ringCall(IDS.users.boris, IDS.users.anna);
  await win.getByTestId('call-accept').click();
  // ACTIVE: the modal is gone, the header shows the call (the page clock is frozen: 00:00), the
  // island «Голос подключён · Звонок · Борис Петров» (dev LiveKit), the mic on voice activation.
  await expect(win.getByTestId('call-incoming')).toHaveCount(0);
  await expect(win.getByTestId('dm-call-active')).toContainText('Звонок · 00:00');
  await expect(win.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole('region', { name: 'Голосовое подключение' })).toContainText('Звонок · Борис Петров');
  await win.keyboard.press(`${MOD}+Shift+m`);
  await expect(win.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(win.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(win);
  await checkpoint(shot, 'dm-in-call');
  // «Завершить»: the call ends for both, the voice session with it, the log line «Входящий звонок».
  await win.getByTestId('dm-call-hangup').click();
  await expect(win.getByTestId('dm-call-active')).toHaveCount(0);
  await expect(win.getByText('Голос подключён')).toHaveCount(0);
  await expect(win.getByTestId('call-log').last()).toContainText('Входящий звонок');
});

test('members-menu-call', async ({ open, win, mock, shot }) => {
  // The owner's request (ADR-0034): «Позвонить» and «Написать» as two equal buttons on top.
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  const top = win.getByRole('menu').getByTestId('member-menu-top');
  await expect(top.getByRole('menuitem')).toHaveCount(2);
  await expect(top.getByRole('menuitem').first()).toHaveText('Позвонить');
  await top.getByRole('menuitem').first().hover();
  await checkpoint(shot, 'members-menu-call', { keepPointer: true });
});

/**
 * docs/09 #125 (owner, 29.09: «обновление слабо видят»): a downloaded update — the 32 px accent bar
 * under the title bar («Доступна версия X — обновление уже загружено · Перезапустить и обновить ·
 * Позже») and the accent dot on the title-bar gear (faked status).
 */
test('update-bar', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.evaluate(() => (window as unknown as { __calabaUpdateStatus?: (s: object) => void }).__calabaUpdateStatus?.({ state: 'downloaded', version: '0.9.1' }));
  const bar = win.getByTestId('update-bar');
  await expect(bar).toContainText('Доступна версия 0.9.1 — обновление уже загружено');
  await expect(bar.getByRole('button', { name: 'Перезапустить Calab и установить версию 0.9.1' })).toHaveText('Перезапустить и обновить');
  await expect(bar.getByRole('button', { name: 'Позже' })).toBeVisible();
  await expect(win.getByTestId('settings-update-dot')).toBeVisible();
  await checkpoint(shot, 'update-bar');
});

/**
 * «О программе» with an available update (docs/09 #93): «Версия X» + «Скачать и установить 0.9.0»
 * (faked status), «Обновление» on the section (docs/09 #125). The real app / Electron versions are
 * masked — they change with every release.
 */
test('settings-about', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await openSettingsTab(win, openAppSettings(win), TABS.settings);
  await win.evaluate(() =>
    (window as unknown as { __calabaUpdateStatus?: (s: object) => void }).__calabaUpdateStatus?.({
      state: 'available',
      version: '0.9.0',
      downloadPage: 'https://releases.calab.ru/',
      installable: true,
    }),
  );
  const dialog = win.getByRole('dialog');
  await expect(dialog.getByTestId('update-install')).toHaveText('Скачать и установить 0.9.0');
  await expect(dialog.getByTestId('settings-section-badge')).toHaveText('Обновление');
  await checkpoint(shot, 'settings-about', {
    mask: [dialog.locator('[data-settings-label]', { hasText: /^Версия / }), dialog.getByText(/^Electron /)],
  });
});

test('main-members-toggled', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Members: a column from 1200 px (open by default), a floating panel below (closed by default).
  await win.getByRole('button', { name: 'Участники' }).click();
  await checkpoint(shot, 'main-members-toggled');
  // ADR-0150: Вера's connection is lost (the seat is kept): dimmed, a crossed wifi instead of her
  // other icons, in the sidebar voice row and the members list; next to Борис (muted). Server-side state only, no LiveKit.
  mock.setVoiceState({ userId: IDS.users.vera, roomId: IDS.rooms.meeting, streaming: false, connectionLost: true });
  const sidebar = win.locator('aside').first();
  await expect(sidebar.getByRole('listitem', { name: /Вера/ }).locator('[data-voice-icon="connection-lost"]')).toHaveCount(1);
  await expect(sidebar.getByRole('listitem', { name: /Борис Петров/ }).locator('[data-voice-icon="muted"]')).toHaveCount(1);
  await expect(win.getByRole('complementary', { name: 'Участники' }).locator('[data-voice-icon="connection-lost"]')).toHaveCount(1);
  await checkpoint(shot, 'main-members-voice-lost');
  // CBF-154: custom roles with light colours (white, pale yellow, mid blue) stay readable in both themes.
  const json = { 'content-type': 'application/json' };
  const login = await fetch(`${mock.url}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'owner@calaba.test', password: PASSWORD }) });
  const auth = { ...json, authorization: `Bearer ${((await login.json()) as { tokens: { accessToken: string } }).tokens.accessToken}` };
  const roleIds: string[] = [];
  for (const [name, color] of [['Белая', 0xffffff], ['Бледно-жёлтая', 0xffeb99], ['Синяя', 0x3a86ff]] as const) {
    const created = await fetch(`${mock.url}/api/workspaces/${IDS.workspaces.main}/roles`, { method: 'POST', headers: auth, body: JSON.stringify({ name, color, permissions: '0' }) });
    expect(created.status, `create role ${name}`).toBe(201);
    roleIds.push(((await created.json()) as { role: { id: string } }).role.id);
  }
  [IDS.users.vera, IDS.users.grigory, IDS.users.dina].forEach((uid, i) => mock.setMemberRoles(IDS.workspaces.main, uid, roleIds.slice(i, i + 1)));
  await checkpoint(shot, 'main-members-roles');
});

test('members-profile', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureBadges(mock);
  mock.seedSipExchange(); // Борис gets the internal number 101 (ADR-0117)
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click();
  const card = win.getByRole('dialog', { name: 'Борис Петров' });
  await expect(card).toBeVisible();
  // docs/09 #108: the badge inline after the name (no text line), its name as the tooltip.
  await expect(card.locator('h3 ~ img[data-member-badge][title="Acme"]')).toBeVisible();
  // ADR-0077: @nick under the name; email and phone of a colleague with «Скопировать».
  await expect(card.getByTestId('user-handle')).toHaveText('@boris_p');
  await expect(card.getByTestId('profile-email')).toContainText('boris@calaba.test');
  await expect(card.getByTestId('profile-phone')).toContainText('+7 912 555-02-02');
  await expect(card.getByTestId('profile-extension')).toContainText('101');
  // docs/09 #85: his local time and working hours (a zone other than mine).
  await expect(card.getByTestId('local-time')).toContainText('UTC+5');
  await expect(card.getByTestId('work-hours')).toContainText('10–19');
  await badgesLoaded(win);
  await checkpoint(shot, 'members-profile');
});

// docs/09 #108: with a card open, a click on another row moves the card there (it used to vanish
// right after switching). Behaviour only, no screenshot — so it runs in the local set.
test('members-profile-switch', async ({ open, win, mock }) => {
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByRole('dialog', { name: 'Борис Петров' })).toBeVisible();
  await members.getByRole('button', { name: /Вера Ким/ }).click();
  const vera = win.getByRole('dialog', { name: 'Вера Ким' });
  await expect(vera).toBeVisible();
  await expect(win.getByRole('dialog', { name: 'Борис Петров' })).toHaveCount(0);
  // Still there after the old card's close settled (the bug closed it within a frame or two).
  await win.waitForTimeout(300);
  await expect(vera).toBeVisible();
  await expect(vera.getByRole('heading', { name: 'Вера Ким' })).toBeVisible();
  // And back: a third click on the first row moves it again; Esc closes.
  await members.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByRole('dialog', { name: 'Борис Петров' })).toBeVisible();
  await expect(vera).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(win.getByRole('dialog', { name: 'Борис Петров' })).toHaveCount(0);
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
  // ADR-0154: «Пожаловаться…» → the report dialog (reason picked, a comment).
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await expect(win.getByRole('menu')).toHaveCount(0);
  const people = await membersList(win); // a second Escape may close the floating members panel
  await people.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByTestId('member-report').click();
  const report = win.getByTestId('report-dialog');
  await expect(report).toBeVisible();
  await report.getByTestId(`report-reason-${ReportReason.HARASSMENT}`).check();
  await report.getByTestId('report-comment').fill('Грубит в общем канале');
  await checkpoint(shot, 'report-dialog');
  await win.getByTestId('report-send').click();
  await expect(report).toHaveCount(0);
  // «Заблокировать» → the confirmation; then Борис's messages in «общий» collapse.
  await (await membersList(win)).getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByTestId('member-block').click();
  await expect(win.getByRole('alertdialog').or(win.getByRole('dialog'))).toContainText('Заблокировать пользователя Борис');
  await checkpoint(shot, 'block-confirm');
  await win.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(win.getByTestId('message-hidden').first()).toBeVisible();
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await checkpoint(shot, 'message-hidden');
  // Settings → «Заблокированные»: Борис with «Разблокировать».
  await openAppSettings(win)();
  await win.getByRole('dialog').getByRole('tab', { name: 'Заблокированные' }).click();
  await expect(win.getByTestId('blocked-row')).toHaveCount(1);
  await checkpoint(shot, 'settings-blocked');
});

/**
 * Guest admission (ADR-0040): a guest knocks on «общий» → the decider gets the toast and the knock
 * counter on the room row; the members panel shows «Ожидают подтверждения — 1» on top (the toast
 * goes: the group is on screen). Then: rename inline, pick a badge, «Пустить» → the row is gone.
 */
test('members-admissions', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureBadges(mock);
  const guest = mock.knock(IDS.rooms.general, 'Гость Ромашка');
  const toast = win.getByTestId('knock-toast');
  await expect(toast).toContainText('Гость Ромашка');
  await expect(toast).toContainText('просит войти в «общий»');
  await expect(toast.getByRole('button', { name: 'Пустить Гость Ромашка' })).toBeVisible();
  const counter = win.locator('aside').first().getByTestId('room-knocks');
  await expect(counter).toHaveAccessibleName('Ожидают подтверждения: 1');
  const members = await membersList(win);
  const group = members.getByTestId('members-admissions');
  await expect(group).toContainText('Ожидают подтверждения — 1');
  // Not in yet: only in the group, not also among the members («Не в сети» as a guest).
  await expect(members.locator('section[aria-labelledby="members-on"], section[aria-labelledby="members-off"]').filter({ hasText: 'Гость Ромашка' })).toHaveCount(0);
  await expect(toast).toHaveCount(0);
  await badgesLoaded(win);
  await checkpoint(shot, 'members-admissions');

  const row = group.getByTestId('admission-row');
  await row.getByRole('button', { name: 'Изменить имя гостя: Гость Ромашка' }).click();
  const field = row.getByRole('textbox', { name: 'Имя гостя' });
  await field.fill('Анна (Ромашка)');
  await field.press('Enter');
  await expect(row.getByRole('button', { name: 'Изменить имя гостя: Анна (Ромашка)' })).toBeVisible();
  await row.getByTestId('admission-badge').click();
  await win.getByRole('menuitemradio', { name: 'Acme' }).click();
  await expect(row.getByTestId('admission-badge')).toHaveAccessibleName('Бейдж: Acme');
  await row.getByRole('button', { name: 'Пустить Анна (Ромашка)' }).click();
  await expect(group).toHaveCount(0);
  await expect(counter).toHaveCount(0);
  await expect.poll(() => mock.state.users.get(guest)?.user.displayName).toBe('Анна (Ромашка)');
  await expect(members.getByRole('button', { name: /Анна \(Ромашка\)/ })).toBeVisible();
});

test('profile-dialog', async ({ open, win, mock, shot }) => {
  // docs/09 #20: «Профиль» from the member menu — banner, member since, role chips, the note saved.
  await open();
  await mainWindow(win, mock);
  giveFixtureBadges(mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Профиль' }).click();
  const dialog = win.getByTestId('profile-dialog');
  await expect(dialog).toBeVisible();
  // docs/09 #108: the 20 px badge right after the name, no text line.
  await expect(dialog.locator('h2 ~ img[data-member-badge][title="Acme"]')).toBeVisible();
  // docs/09 #143: the app of the member's latest session under the local time.
  await expect(dialog.getByTestId('client-version')).toHaveText('Calab 1.1.0 · macOS');
  // ADR-0077: «Контакты» — email and phone.
  await expect(dialog.getByTestId('profile-contacts')).toContainText('boris@calaba.test');
  await badgesLoaded(win);
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

// docs/09 #76: «Профиль → День рождения» — day, month, the optional year, «Скрыть от других».
test('profile-birthday', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await openSettingsTab(win, openAppSettings(win), appTab('profile'));
  const picker = win.getByTestId('birthday-picker');
  await picker.scrollIntoViewIfNeeded();
  await picker.getByRole('combobox', { name: 'Месяц' }).selectOption('3');
  await picker.getByRole('combobox', { name: 'День' }).selectOption('15');
  await picker.getByRole('combobox', { name: 'Год' }).selectOption('1996');
  // Saved (PATCH /api/me): «Скрыть от других» and «Убрать» appear with a saved date.
  await expect(win.getByRole('switch', { name: 'Скрыть от других' })).toBeVisible();
  // «Убрать» sits beside the picker (the admin's dialog reuses the picker without it, #77).
  await expect(picker.locator('..').getByRole('button', { name: 'Убрать' })).toBeVisible();
  await expect(picker.getByRole('combobox', { name: 'День' })).toHaveValue('15');
  await win.getByRole('switch', { name: 'Скрыть от других' }).scrollIntoViewIfNeeded();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'profile-birthday');
});

test('quick-switcher', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.keyboard.press(`${MOD}+k`);
  await expect(win.getByRole('dialog')).toBeVisible();
  // docs/09 #66, #83: the hovered voice room shows «Подключиться» + «Открыть чат»; other rows no hint.
  const voiceRow = win.getByRole('option', { name: /Переговорка/ });
  await voiceRow.hover();
  await expect(win.getByRole('button', { name: 'Подключиться: Переговорка' })).toBeVisible();
  await expect(win.getByRole('button', { name: 'Открыть чат: Переговорка' })).toBeVisible();
  await checkpoint(shot, 'quick-switcher', { keepPointer: true });
  // ADR-0139: the «Задачи» tab — words, a «Доска» condition, the list with its columns.
  mock.setClock(NOW.getTime());
  await win.getByTestId('search-mode-tasks').click();
  await win.keyboard.type('доск');
  await win.getByTestId('task-search-filter').click();
  await win.getByTestId('filter-fields').getByRole('option', { name: 'Доска' }).click();
  await win.getByTestId('filter-values').getByRole('option', { name: /Разработка/ }).click();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('filter-chip')).toHaveCount(1);
  await expect(win.getByTestId('task-search-row')).toHaveCount(2);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'quick-switcher-tasks');
  // CBF-149: ⌘-click on a result is a background tab in the title bar; ⌘K stays open with its text.
  await win.getByTestId('task-search-row').first().click({ modifiers: [MOD] });
  await expect(win.getByTestId('task-tab')).toHaveCount(1);
  await expect(win.getByTestId('quick-switcher')).toBeVisible();
  await expect(win.getByRole('combobox')).toHaveValue('доск');
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'quick-switcher-tasks-tab', { axe: false });
  await win.getByTestId('task-tab-close').dispatchEvent('click');
  await expect(win.getByTestId('task-tab')).toHaveCount(0);
  // CBF-157: «×» empties the text only — focus stays, the «Доска» chip and the list stay, the dialog stays.
  await expect(win.getByTestId('search-clear')).toBeVisible();
  await checkpoint(shot, 'quick-switcher-tasks-clear', { axe: false });
  await win.getByTestId('search-clear').click();
  await expect(win.getByRole('combobox')).toHaveValue('');
  await expect(win.getByRole('combobox')).toBeFocused();
  await expect(win.getByTestId('search-clear')).toHaveCount(0);
  await expect(win.getByTestId('filter-chip')).toHaveCount(1);
  await expect(win.getByTestId('quick-switcher')).toBeVisible();
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'quick-switcher-tasks-cleared');
  await win.keyboard.type('доск');
  // A typed key comes first as «Открыть CAL-3».
  const field = win.getByRole('combobox');
  await field.press(`${MOD}+a`);
  await win.keyboard.type('CAL-3');
  await expect(win.getByTestId('task-search-key')).toContainText('CAL-3');
  // «Сохранить»: the conditions under a name, a row under «Мои задачи».
  await field.press(`${MOD}+a`);
  await win.keyboard.type('доск');
  await win.getByTestId('task-search-save').click();
  await win.getByTestId('task-search-save-name').fill('Доски в разработке');
  await win.getByTestId('task-search-save-submit').click();
  await expect(win.getByTestId('task-search-save-menu')).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('quick-switcher')).toHaveCount(0);
  while (await win.getByTestId('toast').count()) await win.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).click();
  await win.getByTestId('section-boards').click();
  await win.getByTestId('saved-search').filter({ hasText: 'Доски в разработке' }).click();
  await expect(win.getByTestId('task-search-page')).toBeVisible();
  await expect(win.getByTestId('task-search-row')).toHaveCount(2);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-saved-search');
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
  // ADR-0140: my message seen by Борис and Вера (✓✓), the next one by nobody (✓); ✓✓ opens
  // «Прочитали»; the same list on top of the message's menu.
  await win.keyboard.press('Escape');
  await expect(win.getByRole('menu')).toHaveCount(0);
  const seen = mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: 'Посмотрите макет до обеда.' });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.anna, content: 'И ссылку на прототип.' });
  mock.markRead(IDS.users.boris, IDS.rooms.general, seen.id);
  mock.markRead(IDS.users.vera, IDS.rooms.general, seen.id);
  const bubble = win.getByTestId('message-bubble').filter({ hasText: 'Посмотрите макет' });
  await expect(bubble.getByTestId('read-ticks')).toBeVisible();
  await expect(win.getByTestId('message-bubble').filter({ hasText: 'И ссылку' }).getByLabel('Отправлено').last()).toBeVisible();
  await bubble.getByTestId('read-ticks').click();
  await expect(win.getByTestId('read-by-popover').getByTestId('read-by-row')).toHaveCount(2);
  await checkpoint(shot, 'chat-read-by');
  await win.keyboard.press('Escape');
  await bubble.getByText('Посмотрите макет').click({ button: 'right' });
  await win.getByTestId('message-read-by').click();
  await expect(win.getByRole('menu').getByTestId('read-by-row')).toHaveCount(2);
  await checkpoint(shot, 'chat-read-by-menu');
  // ADR-0162: «Изменить» on a message of my own bot («Погода»), not on someone else's («Деплой»).
  await win.keyboard.press('Escape');
  await expect(win.getByRole('menu')).toHaveCount(0);
  mock.seedBots();
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.bots.deploy, content: 'Выкатил ветку на стенд.' });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.bots.weather, content: 'Завтра +3, без осадков.' });
  await win.getByTestId('message-bubble').filter({ hasText: 'Выкатил ветку' }).getByText('Выкатил ветку').click({ button: 'right' });
  await expect(win.getByRole('menu')).toBeVisible();
  await expect(win.getByTestId('message-edit')).toHaveCount(0);
  await win.keyboard.press('Escape');
  await win.getByTestId('message-bubble').filter({ hasText: 'Завтра +3' }).getByText('Завтра +3').click({ button: 'right' });
  await expect(win.getByTestId('message-edit')).toBeVisible();
  await checkpoint(shot, 'chat-context-menu-bot');
  await win.getByTestId('message-edit').click();
  await expect(win.getByTestId('composer')).toContainText('Завтра +3');
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

// «Упоминания» (ADR-0141, #99): chat mentions and task events together, newest first, each with
// its source (room · workspace, KEY · title); unread ones carry a dot.
test('inbox-popover', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // open() rebuilds the mock: a comment of Вера mentioning me in CAL-3 after it — a MENTIONED
  // task notice (live, and in the history the popover reloads).
  const task = mock.boards.taskByKey('CAL-3');
  if (!task) throw new Error('CAL-3 is not seeded');
  mock.injectMessage({ roomId: task.task.roomId, authorId: IDS.users.vera, content: `@${IDS.users.anna} проверишь на Mac?` });
  await win.getByTestId('titlebar').getByRole('button', { name: 'Упоминания', exact: true }).click();
  const pop = win.getByRole('dialog', { name: 'Упоминания' });
  await expect(pop.getByText('CAL-3 · Эхо в звонке при включённых колонках')).toBeVisible();
  await expect(pop.getByText(/разработка · /).first()).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'inbox-popover');
  // CBF-155: the ✕ in a card's corner removes it; the popover stays open, the rest stay.
  const card = pop.getByRole('listitem').filter({ hasText: 'CAL-3 · Эхо в звонке при включённых колонках' }).first();
  const rows = await pop.getByRole('listitem').count();
  await card.getByRole('button', { name: 'Убрать из списка' }).click();
  await expect(pop.getByRole('listitem')).toHaveCount(rows - 1);
  await expect(pop).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'inbox-popover-dismissed');
});

// Bug #146: a room with an unread @mention looks different from plain unread (the count badge), and the
// title-bar inbox badge adds the unread task notice (CAL-3) to the chat mention.
test('inbox-badge-rooms', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const task = mock.boards.taskByKey('CAL-3');
  if (!task) throw new Error('CAL-3 is not seeded');
  mock.injectMessage({ roomId: IDS.rooms.call, authorId: IDS.users.vera, content: 'Обычное непрочитанное' });
  mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.vera, content: `@${IDS.users.anna} посмотришь макет?` });
  mock.injectMessage({ roomId: task.task.roomId, authorId: IDS.users.vera, content: `@${IDS.users.anna} проверишь на Mac?` });
  await expect(win.getByTestId('inbox-badge')).toBeVisible();
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'inbox-badge-rooms');
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
  await expect(win.getByRole('dialog').getByText(/глянь, пожалуйста, ревью/)).toBeVisible();
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
  // Voice audio recovery (#255) without LiveKit: the voice panel is shown from store state alone
  // (__calabaVoiceSeat), the recovery signals come through the voice service's own paths.
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await win.evaluate(([roomId, workspaceId]) => (window as unknown as { __calabaVoiceSeat?: (s: object) => void }).__calabaVoiceSeat?.({ roomId, workspaceId }), [IDS.rooms.meeting, IDS.workspaces.main]);
  await expect(win.getByText('Голос подключён')).toBeVisible();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // no focus ring / tooltip of the mic button
  // The system holds the mic: the panel header says so in place of «Голос подключён», no line under
  // the buttons, no toast. The refused sound is the one toast.
  await win.evaluate(() => {
    const w = window as unknown as { __calabaVoiceRecovery?: (what: string) => void };
    w.__calabaVoiceRecovery?.('recovering');
    w.__calabaVoiceRecovery?.('playback');
  });
  await expect(win.getByTestId('voice-phase')).toHaveText('Ждём микрофон');
  await expect(win.getByRole('region', { name: 'Голосовое подключение' }).getByRole('alert')).toHaveCount(0); // no red line under the buttons
  await expect(win.getByTestId('toast')).toHaveCount(1);
  await expect(win.getByTestId('toast').filter({ hasText: 'Вы не слышите собеседников' })).toBeVisible();
  await expect(win.getByTestId('toast').getByRole('button', { name: 'Включить звук' })).toBeVisible();
  await checkpoint(shot, 'voice-audio-recovery-seat');
  await win.evaluate(() => (window as unknown as { __calabaVoiceRecovery?: (w: string) => void }).__calabaVoiceRecovery?.('unheard'));
  await expect(win.getByTestId('voice-phase')).toHaveText('Вас не слышно');
  await expect(win.getByTestId('toast')).toHaveCount(1); // still only the sound prompt
  await checkpoint(shot, 'voice-audio-recovery-unheard');
  // Outside «Команда» the island is folded (ADR-0146): the avatar's mark carries the state.
  await win.getByTestId('toast').getByRole('button', { name: 'Закрыть' }).click();
  await win.getByTestId('section-calendar').click();
  const mark = win.getByTestId('island-call-mark');
  await expect(mark).toHaveAttribute('data-trouble', 'unheard');
  await checkpoint(shot, 'voice-audio-recovery-folded-unheard');
  await win.evaluate(() => (window as unknown as { __calabaVoiceRecovery?: (w: string) => void }).__calabaVoiceRecovery?.('recovering'));
  await expect(mark).toHaveAttribute('data-trouble', 'recovering');
  await checkpoint(shot, 'voice-audio-recovery-folded');
});

test('workspace-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // «‹ ›» (board #113): left after the traffic lights; a room opened from another — back on, forward off.
  const bar = win.getByTestId('titlebar');
  await win.locator('aside').getByRole('button', { name: /разработка/ }).first().click();
  await expect(win.getByRole('heading', { name: 'разработка' })).toBeVisible();
  await expect(bar.getByTestId('nav-back')).toBeEnabled();
  await expect(bar.getByTestId('nav-forward')).toBeDisabled();
  await expect(win.locator('[data-message-id]').first()).toBeVisible();
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // The picker sits in the right group, before the search.
  const pickerBox = await bar.getByTestId('titlebar-title').boundingBox();
  const searchBox = await bar.getByRole('button', { name: 'Поиск' }).boundingBox();
  const backBox = await bar.getByTestId('nav-back').boundingBox();
  expect((pickerBox?.x ?? 0) + (pickerBox?.width ?? 0), 'picker before the search').toBeLessThanOrEqual(searchBox?.x ?? 0);
  expect(backBox?.x ?? 0, 'back left of the picker').toBeLessThan(pickerBox?.x ?? 0);
  await checkpoint(shot, 'titlebar-history');
  // Back returns to «общий», forward turns on.
  await bar.getByTestId('nav-back').click();
  await expect(win.getByRole('heading', { name: 'общий' })).toBeVisible();
  await expect(bar.getByTestId('nav-forward')).toBeEnabled();
  // The workspace switcher (ADR-0074 §2): every workspace, then create / find, then this one's items.
  await bar.getByTestId('titlebar-title').click();
  await expect(win.getByRole('menu')).toBeVisible();
  await expect(win.getByTestId('switcher-row')).toHaveCount(2);
  await expect(win.getByTestId('switcher-row').first()).toHaveAttribute('aria-current', 'true');
  await expect(win.getByRole('menuitem', { name: 'Создать пространство' })).toBeVisible();
  // Opened from the right: the sheet stays inside the window.
  const menuBox = await win.getByTestId('workspace-switcher').boundingBox();
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0), 'switcher menu inside the window').toBeLessThanOrEqual(shot.viewport.width);
  expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  await checkpoint(shot, 'workspace-menu');
  await win.keyboard.press('Escape');
  await expect(win.getByRole('menu')).toHaveCount(0);
  // Esc returns the focus to the trigger (a keyboard ring): drop it for the shot.
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // A long workspace name truncates in the right group.
  const ws = mock.state.workspaces.get(IDS.workspaces.main);
  if (!ws) throw new Error('no main workspace');
  ws.name = 'Очень длинное название пространства для проверки обрезки';
  mock.dispatch({ event: { case: 'workspaceUpdate', value: { workspace: ws } } });
  await expect(bar.getByTestId('titlebar-title')).toContainText('Очень длинное');
  await checkpoint(shot, 'titlebar-long-name');
});

/** «+» in the room column header (owner, 28.09): «Создать комнату» / «Создать категорию». */
// ADR-0092: pictures loaded with the app (READY snapshot) — a text room, an unread text room,
// a private one (lock badge), an empty voice room and the voice room with people (green ring).
test('sidebar-room-picture', async ({ open, win, mock, shot }) => {
  await open();
  const by = IDS.users.anna;
  mock.setRoomPicture(IDS.rooms.general, { photo: [[255, 170, 110], [70, 60, 170]] }, by);
  mock.setRoomPicture(IDS.rooms.dev, { photo: [[120, 200, 255], [30, 70, 160]] }, by);
  mock.setRoomPicture(IDS.rooms.longPrivate, { photo: [[255, 120, 160], [90, 40, 120]] }, by);
  mock.setRoomPicture(IDS.rooms.call, { photo: [[150, 230, 170], [20, 110, 90]] }, by);
  mock.setRoomPicture(IDS.rooms.meeting, { photo: [[255, 210, 120], [180, 60, 50]] }, by);
  // A reload: the pictures come in the READY snapshot, not in live events.
  await win.reload();
  await expect(win.locator('aside').first()).toBeVisible({ timeout: 30_000 });
  await mainWindow(win, mock);
  await expect(win.locator('aside [data-room-icon="picture"] img')).toHaveCount(5);
  await checkpoint(shot, 'sidebar-room-picture');
});

test('sidebar-create-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('sidebar-create').click();
  const menu = win.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Создать комнату' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Создать категорию' })).toBeVisible();
  // docs/09 #135 / #140: the header's only «+» also adds a meeting, creates a task and, last, invites to the workspace.
  await expect(menu.getByRole('menuitem')).toHaveText(['Создать комнату', 'Создать категорию', 'Временная комната', 'Добавить встречу', 'Создать задачу', 'Пригласить в пространство']);
  await expect(win.locator('aside').getByRole('button', { name: 'Пригласить людей' })).toHaveCount(0);
  await checkpoint(shot, 'sidebar-create-menu');
});

// ---------------------------------------------------------------- temporary rooms (ADR-0044)

/**
 * Two temporary rooms of Анна in «Команда Calab» on the page's clock: «Встреча с клиентом» (1 ч 20 м
 * left) and a private «Демо для партнёров» closing in 9 minutes (attention colour). Returns «now».
 */
async function seedTempRooms(win: Page, mock: MockServer): Promise<number> {
  const nowMs = await win.evaluate(() => Date.now());
  mock.setClock(nowMs);
  mock.addTempRoom({ workspaceId: IDS.workspaces.main, name: 'Встреча с клиентом', expiresAtMs: nowMs + 80 * 60_000 });
  mock.addTempRoom({ workspaceId: IDS.workspaces.main, name: 'Демо для партнёров', expiresAtMs: nowMs + 9 * 60_000, isPrivate: true });
  const group = win.getByTestId('temp-group');
  await expect(group.getByTestId('temp-left')).toHaveText(['9 м', '1 ч 20 м']);
  return nowMs;
}

/** The «Временные» group under the categories: Timer rows, the remaining time, orange under 10 minutes. */
test('sidebar-temp-room', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await seedTempRooms(win, mock);
  const group = win.getByTestId('temp-group');
  await expect(group.getByRole('button', { name: 'Свернуть «Временные»' })).toBeVisible();
  await expect(group.locator('[data-testid="temp-icon"][data-expiring]')).toHaveCount(1);
  await checkpoint(shot, 'sidebar-temp-room');
});
/** «+» → «Временная комната» as it opens (all members): name, lifetime presets, visibility, switches. */
test('temp-room-dialog', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('sidebar-create').click();
  await win.getByRole('menuitem', { name: 'Временная комната' }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Название' })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Название' }).fill('Встреча с клиентом');
  await dialog.getByRole('radio', { name: '3 ч' }).click();
  await expect(dialog.getByRole('switch', { name: 'Пускать гостей по ссылке' })).toBeChecked();
  // 960×600 (docs/09 #147): the default state fits whole — the body does not scroll, no edge hairline.
  await expect(dialog.getByRole('switch', { name: 'Добавить встречу в календарь' })).toBeInViewport({ ratio: 1 });
  const body = dialog.getByTestId('temp-room-dialog').locator('..');
  await expect(body).not.toHaveAttribute('data-scroll-bottom');
  await checkpoint(shot, 'temp-room-dialog');
});

/**
 * «До даты» (the date field in the pills' row) + «Только выбранные» with people: taller than the
 * 600 px window — only the body scrolls, a hairline above the buttons says there is more; the
 * header and «Отмена / Создать» stay (docs/09 #147).
 */
test('temp-room-dialog-expanded', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('sidebar-create').click();
  await win.getByRole('menuitem', { name: 'Временная комната' }).click();
  const dialog = win.getByRole('dialog', { name: 'Временная комната' });
  await dialog.getByRole('textbox', { name: 'Название' }).fill('Встреча с клиентом');
  await dialog.getByRole('radio', { name: 'До даты' }).click();
  await expect(dialog.getByTestId('temp-until')).toBeVisible();
  await dialog.getByRole('radio', { name: 'Только выбранные' }).click();
  await expect(dialog.getByTestId('temp-people-add')).toBeVisible();
  await dialog.getByTestId('temp-people-add').click();
  const picker = win.getByTestId('temp-people-picker');
  await picker.getByRole('option', { name: /Борис/ }).click();
  await picker.getByRole('option', { name: /Вера/ }).click();
  await win.keyboard.press('Escape');
  await expect(dialog.getByTestId('person-chip')).toHaveCount(2);
  const body = dialog.getByTestId('temp-room-dialog').locator('..');
  await expect(body).toHaveAttribute('data-scroll-bottom', '');
  await expect(dialog.getByTestId('temp-create')).toBeInViewport({ ratio: 1 });
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'temp-room-dialog-expanded');
});

/** After «Создать»: the link at once, «Скопировать», «Войти», «Готово»; the room is in the list. */
test('temp-room-dialog-result', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setClock(await win.evaluate(() => Date.now()));
  await win.getByTestId('sidebar-create').click();
  await win.getByRole('menuitem', { name: 'Временная комната' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Название' }).fill('Встреча с клиентом');
  await win.keyboard.press('Enter');
  await expect(dialog.getByTestId('temp-room-result')).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Комната «Встреча с клиентом» готова');
  await expect(win.getByTestId('temp-group')).toContainText('Встреча с клиентом');
  // The link carries the mock's port (per worker): masked.
  await checkpoint(shot, 'temp-room-dialog-result', { mask: [dialog.getByRole('textbox', { name: 'Ссылка на комнату' })] });
});

/** The row menu of my temporary room: the voice room items plus link · extend › · meeting · delete. */
test('temp-room-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await seedTempRooms(win, mock);
  await win.getByTestId('temp-group').getByRole('button', { name: /Встреча с клиентом/ }).first().click({ button: 'right' });
  const menu = win.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Копировать ссылку' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Удалить', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Вверх', exact: true })).toHaveCount(0);
  await checkpoint(shot, 'temp-room-menu');
});

/** Workspace settings → «Общие»: the members' temporary-room switch and the archive of closed rooms. */
test('settings-temp-archive', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const nowMs = await win.evaluate(() => Date.now());
  mock.setClock(nowMs - 2 * 3_600_000);
  const room = mock.addTempRoom({ workspaceId: IDS.workspaces.main, name: 'Созвон с подрядчиком', expiresAtMs: nowMs - 3_600_000, createdBy: IDS.users.vera });
  mock.injectMessage({ roomId: room.id, authorId: IDS.users.vera, content: 'Спасибо, договорились' });
  mock.injectMessage({ roomId: room.id, authorId: IDS.users.anna, content: 'До связи' });
  mock.setClock(nowMs - 3_600_000);
  mock.expireTempRooms();
  mock.setClock(nowMs);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  await expect(win.getByTestId('temp-archive-row')).toHaveCount(1);
  await win.getByTestId('temp-archive').scrollIntoViewIfNeeded();
  await expect(win.getByTestId('temp-archive-row')).toContainText('2 сообщения');
  await checkpoint(shot, 'settings-temp-archive');
  // «Открыть историю»: the read-only chat under «Комната в архиве», no composer.
  await win.getByTestId('temp-archive-row').getByRole('button', { name: 'Открыть историю' }).click();
  await expect(win.getByTestId('archived-banner')).toContainText('Комната в архиве');
  await expect(win.getByTestId('archived-chat')).toContainText('До связи');
  await expect(win.getByTestId('composer')).toHaveCount(0);
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
        await win.getByTestId('titlebar-title').click();
        await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
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

/**
 * «Участники → Дни рождения» (docs/09 #77): the owner's table of every member's date, Борис's
 * hidden by him (marked «скрыто пользователем»), Вера's typed in and saved on Enter.
 */
test('settings-members-birthday', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setBirthday(IDS.users.boris, { day: 3, month: 5, year: 1990 });
  mock.setBirthdayHidden(IDS.users.boris, true);
  mock.setBirthday(IDS.users.grigory, { day: 21, month: 11 });
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Участники' }).click();
  await expect(dialog.getByRole('button', { name: 'Изменить день рождения: Борис Петров' })).toBeVisible();
  await dialog.getByTestId('open-birthdays-table').click();
  await expect(dialog.getByTestId('birthday-hidden')).toHaveText('скрыто пользователем');
  const vera = dialog.getByRole('textbox', { name: 'День рождения: Вера Ким' });
  await vera.fill('7.2.1995');
  await vera.press('Enter');
  await expect(vera).toHaveValue('07.02.1995');
  await expect(dialog.getByRole('textbox', { name: 'День рождения: Борис Петров' })).toHaveValue('03.05.1990');
  await checkpoint(shot, 'settings-members-birthday');
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Роли' }).click();
  await dialog.getByRole('button', { name: 'Дизайн', exact: true }).click();
  await expect(dialog.getByTestId('role-title')).toHaveText('Дизайн');
  await expect(dialog.getByTestId('role-name')).toHaveValue('Дизайн');
  await expect(dialog.getByTestId('role-perm-STREAM')).toBeChecked();
  await expect(dialog.getByTestId('role-perm-MANAGE_ROLES')).not.toBeChecked();
  await expect(dialog.getByTestId('role-member')).toHaveCount(2);
  await checkpoint(shot, 'settings-role-edit');
  // ADR-0087: the «Биллинг» group closes the matrix — the owner's toggles with «что даёт».
  const billing = dialog.getByTestId('role-billing-group');
  await billing.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(billing.getByTestId('role-perm-BILLING_MANAGE')).toBeEnabled();
  await expect(billing.getByTestId('role-perm-BILLING_VIEW')).not.toBeChecked();
  await checkpoint(shot, 'settings-role-edit-billing');
});

/** ADR-0048: «Создать роль» → the draft with «Шаблон» «Менеджер отдела» applied and the preview. */
test('settings-role-new', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Роли' }).click();
  await dialog.getByTestId('role-create').click();
  await dialog.getByTestId('role-template').getByRole('radio', { name: 'Менеджер отдела' }).click();
  await expect(dialog.getByTestId('role-perm-CREATE_BOARDS')).toBeChecked();
  await expect(dialog.getByTestId('role-perm-MANAGE_WORKSPACE')).not.toBeChecked();
  await expect(dialog.getByTestId('role-preview-createBoards')).toHaveAttribute('data-on', '1');
  expect([...(mock.state.roles.get(IDS.workspaces.main) ?? [])].some((r) => r.name === 'Новая роль')).toBe(false);
  await checkpoint(shot, 'settings-role-new');
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  await win.getByRole('dialog').getByRole('tab', { name: 'Тариф' }).click();
  await expect(win.getByTestId('plan-limits')).toBeVisible();
  await expect(win.getByRole('dialog').getByText('Free', { exact: true })).toBeVisible();
  await checkpoint(shot, 'settings-plan');
  // The limits table further down: «Холстов 3» under «Досок» (ADR-0126 addendum, owner 23.10).
  const canvases = win.getByTestId('plan-limits').getByRole('row').filter({ hasText: 'Холстов' });
  await expect(canvases).toContainText('3');
  await canvases.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(shot, 'settings-plan-limits');
});

/**
 * Workspace settings → «AI интеграция» (CBF-60) for the owner: the AI card first (provider tabs,
 * empty state without a key, the key typed masked, model, «Проверить» and its answer), then the
 * GPTunneL connection (ADR-0025) below it, not connected: the code typed through
 * the ABCD-EFGH mask, a wrong code's inline error, the hint with the GPTunneL link. Then the
 * right code connects (device, account, «Открыть в GPTunneL», «Отключить»).
 */
test('settings-gptunnel', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'AI интеграция' }).click();
  // CBF-69: the fixture's main workspace is Team — the form stays visible under the Business lock.
  await expect(dialog.getByTestId('ai-plan-lock')).toContainText('Доступно на тарифе Business и выше');
  await checkpoint(shot, 'settings-gptunnel-ai-plan');
  mock.setPlanKind(IDS.workspaces.main, Plan.ENTERPRISE);
  await expect(dialog.getByTestId('ai-plan-lock')).toHaveCount(0);
  const aiForm = dialog.getByTestId('ai-form');
  await expect(aiForm.getByTestId('ai-status')).toHaveText('Не выбран');
  await expect(aiForm.getByTestId('ai-model')).toHaveValue('gpt-6-astra');
  await expect(aiForm.getByTestId('ai-key')).toHaveValue('');
  await expect(aiForm.getByRole('button', { name: 'Проверить' })).toBeVisible();
  await checkpoint(shot, 'settings-gptunnel-ai-empty');
  await aiForm.getByTestId('ai-key').fill('sk-test-1234567890');
  await expect(aiForm.getByTestId('ai-key')).toHaveAttribute('type', 'password');
  await aiForm.getByRole('button', { name: 'Проверить' }).click();
  await expect(aiForm.getByTestId('ai-check-result')).toContainText('Ответ получен');
  await checkpoint(shot, 'settings-gptunnel-ai-checked');
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
  // «Загрузка файлов» (ADR-0155): the server defaults as placeholders; an edit shows «Сохранить».
  const perHour = admin.getByTestId('admin-upload-perHour');
  await expect(perHour).toHaveAttribute('placeholder', '500');
  await perHour.fill('2000');
  await admin.getByRole('heading', { name: 'Загрузка файлов', exact: true }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(admin.getByTestId('admin-upload-save')).toBeVisible();
  await checkpoint(shot, 'admin-uploads');
  await admin.getByTestId('admin-upload-save').click();
  await expect(admin.getByTestId('admin-upload-save')).toBeHidden();
  await expect(perHour).toHaveValue('2000');
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
  // The counted limits of the custom plan: «Статей в Wiki», «Холстов» (ADR-0126 addendum, owner 23.10).
  await admin.getByRole('textbox', { name: 'Холстов' }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(shot, 'admin-plan-limits');
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  await win.getByRole('dialog').getByRole('tab', { name: 'Забаненные' }).click();
  await expect(win.getByTestId('ws-ban-row')).toHaveCount(1);
  await checkpoint(shot, 'settings-bans');
  // «Жалобы» (ADR-0154): an open report about a message and a resolved one about a person.
  const boris = mock.state.users.get(IDS.users.boris);
  if (!boris) throw new Error('no user');
  mock.state.reports.set(IDS.workspaces.main, [
    create(UserReportSchema, {
      id: '00000000-0000-7000-8fff-000000000002',
      workspaceId: IDS.workspaces.main,
      reporter: vera.user,
      target: boris.user,
      messageId: '00000000-0000-7000-8fff-0000000000aa',
      roomId: IDS.rooms.general,
      messageText: 'Кто опять сломал сборку? Руки бы оторвать.',
      reason: ReportReason.HARASSMENT,
      comment: 'Уже второй раз за неделю',
      createdAt: ts('2026-01-14T11:20:00Z'),
    }),
    create(UserReportSchema, {
      id: '00000000-0000-7000-8fff-000000000001',
      workspaceId: IDS.workspaces.main,
      reporter: boris.user,
      target: vera.user,
      reason: ReportReason.SPAM,
      createdAt: ts('2026-01-12T09:00:00Z'),
      resolvedAt: ts('2026-01-12T10:00:00Z'),
      resolvedBy: IDS.users.anna,
    }),
  ]);
  await win.getByRole('dialog').getByRole('tab', { name: 'Жалобы' }).click();
  await expect(win.getByTestId('ws-report-row')).toHaveCount(2);
  await checkpoint(shot, 'settings-reports');
});

/** Вера left the main workspace (ADR-0097): she keeps her messages, tasks and comments, but is no member. */
async function veraLeaves(win: Page, mock: MockServer): Promise<void> {
  const ws = IDS.workspaces.main;
  mock.state.members = mock.state.members.filter((m) => !(m.workspaceId === ws && (m.userId === IDS.users.vera || m.userId === IDS.users.dina)));
  mock.state.formerMembers.set(ws, [
    { userId: IDS.users.vera, role: WorkspaceRole.MEMBER, reason: FormerMemberReason.REMOVED, leftAt: ts('2026-01-14T09:00:00Z'), removedBy: IDS.users.anna, openTasks: 2 },
    { userId: IDS.users.dina, role: WorkspaceRole.MEMBER, reason: FormerMemberReason.LEFT, leftAt: ts('2026-01-05T09:00:00Z'), openTasks: 0 },
  ]);
  // The app learns it from a fresh snapshot, as after a restart.
  await win.reload();
  await expect(win.locator('aside').first()).toBeVisible({ timeout: 30_000 });
}

/** Settings → «Участники» → «Бывшие» (ADR-0097 §3): who left, why, when, by whom; open tasks; «Пригласить снова». */
test('former-tab', async ({ open, win, mock, shot }) => {
  await open();
  await veraLeaves(win, mock);
  await mainWindow(win, mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  await win.getByRole('dialog').getByRole('tab', { name: 'Бывшие' }).click();
  await expect(win.getByTestId('ws-former-row')).toHaveCount(2);
  await checkpoint(shot, 'former-tab');
});

/** The feed with a message of someone who left: grey avatar, «бывший» next to the name (ADR-0097 §4). */
test('former-chip', async ({ open, win, mock, shot }) => {
  await open();
  await veraLeaves(win, mock);
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: 'Передаю дела, всё описано в задачах' });
  await expect(win.locator('[data-message-id] [data-former-chip]').last()).toBeVisible();
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'former-chip');
});

/** A task of someone who left: chip, grey avatar and «Переназначить» on the assignee row. */
test('former-task', async ({ open, win, mock, shot }) => {
  await open();
  await veraLeaves(win, mock);
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'Тёмная тема' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  await expect(panel.getByTestId('assignee-reassign')).toBeVisible();
  await checkpoint(shot, 'former-task');
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

// ADR-0029, ADR-0048: the owner (Anna) picks «По списку, без администраторов» in a private room;
// «Кто видит» lists Vera.
test('room-settings-restricted', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /очень-длинное-название/ }).first().click();
  await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), 1);
  const level = win.getByRole('dialog').getByRole('radio', { name: /По списку, без администраторов/ });
  await level.click();
  await expect(level).toHaveAttribute('aria-checked', 'true');
  expect(mock.state.rooms.get(IDS.rooms.longPrivate)?.restricted).toBe(true);
  await expect(win.getByTestId('room-who-sees-row')).toHaveCount(1);
  await win.getByTestId('room-who-sees').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'room-settings-restricted');
});

// ADR-0092: «Основное» of the room settings with a picture — the 44 px preview, «Загрузить картинку» and «Убрать».
test('room-settings-picture', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setRoomPicture(IDS.rooms.general, { bg: [52, 120, 246], fg: [255, 255, 255] }, IDS.users.anna);
  await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), 1);
  const row = win.getByTestId('room-picture');
  await expect(row.locator('[data-room-icon="picture"] img')).toBeVisible();
  await expect(win.getByTestId('room-picture-remove')).toBeVisible();
  await checkpoint(shot, 'room-settings-picture');
  // «Голос и стрим» of a voice room (without joining the voice): the join/leave cue threshold
  // overridden to 20 (stepper + «Как в пространстве» reset), its row at the bottom of the card.
  await win.keyboard.press('Escape');
  await expect(win.getByRole('dialog')).toHaveCount(0);
  await win.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), 2);
  const joinLeave = win.getByRole('dialog').getByRole('spinbutton', { name: 'Звук входа и выхода' });
  await joinLeave.fill('20');
  await joinLeave.press('Enter');
  await expect.poll(() => mock.state.rooms.get(IDS.rooms.meeting)?.mediaOverride?.joinLeaveSoundMax).toBe(20);
  await joinLeave.scrollIntoViewIfNeeded();
  await joinLeave.blur();
  await expect(joinLeave).not.toBeFocused();
  await checkpoint(shot, 'room-settings-voice-media');
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

SETTINGS_TABS.forEach((id, i) => {
  // «Календарь» loads its CalDAV state first: its own test below.
  if (id === 'calendar') return;
  test(`settings-${id}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(win, openAppSettings(win), i + 1);
    await checkpoint(shot, `settings-${id}`);
  });
});

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
  await openSettingsTab(win, openAppSettings(win), appTab('profile'));
  await win.getByRole('button', { name: 'Изменить пароль…' }).click();
  await expect(win.getByRole('dialog', { name: 'Смена пароля' })).toBeVisible();
  await checkpoint(shot, 'settings-profile-password');
});

test('settings-profile-delete', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // ADR-0153: Profile → «Удаление аккаунта» (the last card) → the dialog. Anna owns «Команда Calab»:
  // first the blocker, then (the workspace handed to Вера) the password step.
  await openSettingsTab(win, openAppSettings(win), appTab('profile'));
  const entry = win.getByTestId('delete-account');
  await entry.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'settings-profile-delete-entry');
  await entry.click();
  const dialog = win.getByRole('dialog', { name: 'Удалить аккаунт?' });
  await expect(dialog.getByTestId('delete-account-blocked')).toContainText('Команда Calab');
  await expect(dialog.getByRole('button', { name: 'Удалить навсегда' })).toBeDisabled();
  await checkpoint(shot, 'settings-profile-delete-blocked');
  const ws = mock.state.workspaces.get(IDS.workspaces.main);
  if (!ws) throw new Error('no main workspace');
  ws.ownerId = IDS.users.vera;
  mock.dispatch({ event: { case: 'workspaceUpdate', value: { workspace: ws } } });
  await expect(dialog.getByLabel('Текущий пароль')).toBeVisible();
  await checkpoint(shot, 'settings-profile-delete');
});

/** The pop-up button itself (owner bug: chevron flush right): a long value ends with «…» before the ↕. */
async function longSelect(page: Page): Promise<Locator> {
  await openSettingsTab(page, openAppSettings(page), appTab('voice'));
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

test('toast-single', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Top right under the title bar (the inbox, settings and help icons stay clear).
  await win.evaluate(() => (window as unknown as { __calabaToast?: (k: string, t: string) => void }).__calabaToast?.('info', 'Ссылка-приглашение скопирована'));
  await expect(win.getByTestId('toast')).toHaveCount(1);
  await checkpoint(shot, 'toast-single');
});

/** A reminder «Через 1 час: Планёрка · Созвон» arrives; its toast action «Перейти в комнату» opens the question. */
async function askJoin(page: Page, mock: MockServer): Promise<void> {
  const ev = mock.addEvent({
    workspaceId: IDS.workspaces.main,
    organizerId: IDS.users.boris,
    title: 'Планёрка по релизу',
    startMs: NOW.getTime() + 3_600_000,
    endMs: NOW.getTime() + 2 * 3_600_000,
    roomId: IDS.rooms.call,
    attendees: [{ userId: IDS.users.anna }],
  });
  mock.emitReminder(ev.id, IDS.users.anna, 60, NOW.getTime() + 3_600_000);
  await page.getByTestId('toast').getByRole('button', { name: 'Перейти в комнату' }).click();
  await expect(page.getByTestId('join-confirm')).toBeVisible();
}

test('join-confirm', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const joined = win.waitForRequest((r) => r.url().endsWith(`/api/rooms/${IDS.rooms.call}/join`), { timeout: 1500 }).then(() => true, () => false);
  await askJoin(win, mock);
  await expect(win.getByTestId('join-confirm-warn')).toHaveCount(0);
  await checkpoint(shot, 'join-confirm');
  // The click alone never joined; Esc closes without joining.
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('join-confirm')).toHaveCount(0);
  expect(await joined).toBe(false);
});

test('join-confirm-switch', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await askJoin(win, mock);
  await expect(win.getByTestId('join-confirm-warn')).toContainText('Вы сейчас в комнате «Переговорка»');
  await checkpoint(shot, 'join-confirm-switch');
});

// ADR-0159: the first «Sign in with Calab» of an app's site — main sends what the provider's consent
// request returned, the Calab dialog shows it; «Запретить» has the focus, Esc denies and closes.
test('app-sign-in', async ({ open, win, mock, env, shot }) => {
  await open();
  await mainWindow(win, mock);
  const ask = { id: 'ask-1', client: 'Поддержка', workspace: 'Calab Team', account: 'Анна Смирнова', site: 'support.example.com', scopes: ['openid', 'profile', 'email'] };
  await env.app.evaluate(({ BrowserWindow }, [url, a]) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)?.webContents.send('webapp:sign-in-ask', a);
  }, [win.url(), ask] as const);
  const dialog = win.getByTestId('app-sign-in');
  await expect(dialog).toContainText('support.example.com');
  await expect(win.getByRole('dialog')).toContainText('«Поддержка» просит войти через Calab');
  await expect(win.getByTestId('app-sign-in-deny')).toBeFocused();
  await checkpoint(shot, 'app-sign-in');
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
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
  // Card actions (docs/09 #30): «Войти» and «…»; «…» opens the room menu with «Запись встречи»
  // (ADR-0025: enabled — the room allows recording).
  const card = win.getByTestId('voice-room-card');
  await card.hover();
  await expect(card.getByTestId('room-join')).toBeVisible();
  await card.getByTestId('room-more').click();
  const record = win.getByTestId('room-menu-record');
  await expect(record).toBeVisible();
  await expect(record).not.toHaveAttribute('aria-disabled', 'true');
  await expect(win.getByRole('menuitem', { name: 'Настройки', exact: true })).toBeVisible();
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
  // CBF-71: the mic is on and live (green dot on the island's mic); switched to push-to-talk it
  // waits for the key - a pale crossed mic in my row, no dot.
  await expect(win.getByTestId('mic-live-dot')).toHaveCount(0);
  await win.keyboard.press(`${MOD}+Shift+m`);
  await expect(win.getByTestId('mic-live-dot')).toBeVisible();
  // ADR-0134: the click has not reached the others yet (flaky link) - an amber dot replaces the green one.
  await win.evaluate(() => (window as unknown as { __calabaMicSyncLag?: (on: boolean) => void }).__calabaMicSyncLag?.(true));
  await expect(win.getByTestId('mic-sync-dot')).toBeVisible();
  await expect(win.getByTestId('mic-live-dot')).toHaveCount(0);
  await checkpoint(shot, 'voice-room-mic-sync');
  await win.evaluate(() => (window as unknown as { __calabaMicSyncLag?: (on: boolean) => void }).__calabaMicSyncLag?.(false));
  await expect(win.getByTestId('mic-live-dot')).toBeVisible();
  await win.getByRole('button', { name: 'Выбор микрофона' }).click();
  await win.getByTestId('mic-menu').getByRole('menuitemradio', { name: 'Push-to-talk' }).click();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('mic-menu')).toHaveCount(0);
  await expect(win.getByTestId('mic-live-dot')).toHaveCount(0);
  await expect(win.locator('aside').first().locator('[data-voice-icon="ptt-idle"]')).toHaveCount(1);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'voice-room-ptt-idle');
  // CBF-82: Борис switched to push-to-talk - everyone sees the pale crossed mic in his row while the
  // key is up; with the key held he speaks and the ring replaces it.
  const boris = win.locator('aside').first().getByRole('listitem', { name: /Борис Петров/ });
  await win.evaluate(() => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.([]));
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, ptt: true });
  await expect(boris.locator('[data-voice-icon="ptt-idle"]')).toHaveCount(1);
  await checkpoint(shot, 'voice-room-ptt-remote');
  await win.evaluate((id) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.([id]), IDS.users.boris);
  await expect(boris).toHaveAttribute('data-speaking', 'true');
  await expect(boris.locator('[data-voice-icon="ptt-idle"]')).toHaveCount(0);
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

// Soundboard (ADR-0036, docs/08 «Саундборд»): Борис pressed «Ба-дум-тсс» — the chip under the
// island's header for 2 s; then «Звуки» (the island's 4th button) opens the popover over the chat:
// search, «Избранное» (one starred), «Звуки пространства» (two), «Стандартные» (the six built-in).
test('voice-soundboard', async ({ open, win, mock, shot }) => {
  await open();
  mock.addSound(IDS.workspaces.main, 'Фанфары', '🎺');
  mock.addSound(IDS.workspaces.main, 'Ну и ну', '😮');
  await inVoiceWithStatus(win, mock);
  mock.playSound(IDS.rooms.meeting, IDS.users.boris, 'builtin:ba_dum_tss');
  const chip = win.getByTestId('sound-chip');
  await expect(chip).toHaveText(/Ба-дум-тсс · Борис Петров/);
  await expect(chip).toHaveCount(0, { timeout: 5000 });
  await win.getByTestId('soundboard-button').click();
  const board = win.getByTestId('soundboard');
  await expect(board).toBeVisible();
  await expect(board.getByRole('region', { name: 'Звуки пространства' }).getByTestId('sound-tile')).toHaveCount(2);
  await expect(board.getByRole('region', { name: 'Стандартные' }).getByTestId('sound-tile')).toHaveCount(6);
  await board.getByRole('button', { name: 'В избранное: «Клаксон»' }).click();
  await expect(board.getByRole('region', { name: 'Избранное' }).getByTestId('sound-tile')).toHaveCount(1);
  // Search narrows to one «Результаты» section.
  await board.getByTestId('soundboard-search').fill('кряк');
  await expect(board.getByRole('region', { name: 'Результаты' }).getByTestId('sound-tile')).toHaveCount(1);
  await board.getByTestId('soundboard-search').fill('');
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'voice-soundboard');
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
  await sidebar.getByRole('button', { name: /^Созвон/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Войти в голос «Созвон»' }).click();
  await expect(win.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await win.keyboard.press(`${MOD}+Shift+m`);
  await expect(win.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(win.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const preview = win.getByTestId('voice-preview');
  await expect(preview).not.toContainText('Вы не в голосе');
  await expect(preview.getByRole('button', { name: 'Войти в голос' })).toBeVisible();
  await expect(win.getByRole('region', { name: 'Голосовое подключение' })).toContainText('Созвон');
  await expect(win.getByText('Показываю экран с макетами')).toBeVisible();
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'voice-room-chat-preview');
});

// Meeting recording cards (ADR-0025) in «Переговорка»'s chat: done (42 мин; no «Открыть в GPTunneL», #80),
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
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const cards = win.getByTestId('recording-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('Встреча записана · 42 мин');
  // No «Готово» row (owner, 28.09, docs/09 #88): the status shows only while it matters.
  await expect(cards.nth(0).getByTestId('recording-card-status')).toHaveCount(0);
  // Across the feed (docs/09 #47): as wide as the message column, not a centred 440 px card.
  const feed = await win.locator('[data-virtuoso-scroller]').first().boundingBox();
  const box = await cards.nth(0).boundingBox();
  expect(feed && box && box.width).toBeGreaterThan((feed?.width ?? 0) - 48);
  await expect(cards.nth(1)).toContainText('Обработка: расшифровка и саммари…');
  await expect(cards.nth(2)).toContainText('Ошибка: на балансе GPTunneL не хватает средств');
  await expect(win.getByRole('button', { name: 'Открыть в GPTunneL' })).toHaveCount(0);
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

// docs/09 #76, #100: the birthday plate at the top of the members panel — Борис today (avatar,
// name, «Поздравить», and — at 06:30 MSK = 08:30 in his Yekaterinburg — «Открытка в
// чате появится в 07:00» of my Moscow clock), Вера in 3 days under the opened «Скоро» (the mock's clock = the page
// clock, 15 January).
test('main-members-birthday', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const morning = new Date('2026-01-15T06:30:00+03:00');
  await win.clock.setFixedTime(morning);
  mock.setClock(morning.getTime());
  mock.setBirthday(IDS.users.boris, { day: 15, month: 1, year: 1990 });
  mock.setBirthday(IDS.users.vera, { day: 18, month: 1 });
  const members = await membersList(win);
  const section = members.getByTestId('members-birthdays');
  const plate = section.getByTestId('members-birthday-plate');
  await expect(plate.getByRole('heading')).toContainText('Сегодня день рождения!');
  await expect(plate.getByRole('button', { name: 'Профиль Борис Петров' })).toBeVisible();
  await expect(plate.getByTestId('members-birthday-congratulate')).toHaveText('Поздравить');
  await expect(plate.getByTestId('members-birthday-hint')).toHaveText('Открытка в чате появится в 07:00');
  await section.getByTestId('members-birthdays-soon').click();
  await expect(section.getByRole('button', { name: /Вера Ким · 18 янв\./ })).toBeVisible();
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'main-members-birthday');
});

// docs/09 #76: Борис's birthday is today (the page clock: 15 January) — the server's card in
// «общий» and 🎂 after his name in the members column; «15 января · 36 лет» in his profile card.
// ADR-0092: Борис changes the picture of «общий» — the service line with the 40 px picture in the
// feed, the picture in the room list and in the header instead of «#».
test('chat-room-icon-system', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setRoomPicture(IDS.rooms.general, { bg: [233, 120, 40], fg: [255, 255, 255] }, IDS.users.boris);
  const line = win.getByTestId('room-icon-line');
  await expect(line).toContainText('Борис Петров изменил(а) картинку комнаты');
  await expect(line.locator('img')).toBeVisible();
  await expect(win.locator('aside [data-room-icon="picture"] img').first()).toBeVisible();
  await checkpoint(shot, 'chat-room-icon-system');
});

test('chat-birthday-card', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setBirthday(IDS.users.boris, { day: 15, month: 1, year: 1990 }, { roomId: IDS.rooms.general });
  const card = win.getByTestId('birthday-card');
  await expect(card).toHaveAttribute('aria-label', '🎂 Борис Петров — сегодня день рождения!');
  await expect(card).toContainText('Сегодня день рождения!');
  await expect(card).toContainText('Борис Петров');
  await expect(card).toContainText('15 января');
  const members = await membersList(win);
  const boris = members.getByRole('button', { name: /Борис Петров/ });
  await expect(boris.getByTestId('birthday-mark')).toBeVisible();
  await boris.click();
  await expect(win.getByTestId('birthday')).toHaveText('🎂 15 января · 36 лет');
  await win.keyboard.press('Escape');
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'chat-birthday-card');
});

/** Two badges of «Команда Calab» (docs/09 #82): «Acme» on Борис and Вера, «Globex» on Анна. */
function giveFixtureBadges(mock: MockServer): void {
  const acme = mock.addBadge(IDS.workspaces.main, 'Acme', { bg: [255, 159, 10], fg: [255, 255, 255] });
  const globex = mock.addBadge(IDS.workspaces.main, 'Globex', { bg: [48, 209, 88], fg: [0, 64, 32] });
  mock.setMemberBadge(IDS.workspaces.main, IDS.users.boris, acme);
  mock.setMemberBadge(IDS.workspaces.main, IDS.users.vera, acme);
  mock.setMemberBadge(IDS.workspaces.main, IDS.users.anna, globex);
}

/** Badge pictures loaded (they come from the file API like avatars). */
async function badgesLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-member-badge]')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
}

// docs/09 #82: workspace settings → «Бейджи» — the library (picture 36, name, holders), «Добавить бейдж».
test('settings-badges', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureBadges(mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Бейджи' }).click();
  await expect(dialog.getByTestId('badge-row')).toHaveCount(2);
  await expect(dialog.getByTestId('badge-row').first()).toContainText('У 2 участников');
  await badgesLoaded(win);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'settings-badges');
});

/** Two camera backgrounds of «Команда Calab» (ADR-0035 addendum): «Офис» and «Логотип». */
function giveFixtureBackgrounds(mock: MockServer): void {
  mock.addBackground(IDS.workspaces.main, 'Офис', { from: [44, 62, 80], to: [189, 195, 199] });
  mock.addBackground(IDS.workspaces.main, 'Логотип', { from: [10, 132, 255], to: [94, 92, 230] });
}

/** Workspace background thumbnails loaded (from the file API like avatars). */
async function backgroundThumbsLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-wsbg-thumb]')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
}

// ADR-0035 addendum: workspace settings → «Фоны камеры» — the list (16:9 thumbnail, name, delete), «Добавить фон».
test('settings-backgrounds', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureBackgrounds(mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Фоны камеры' }).click();
  await expect(dialog.getByTestId('wsbg-row')).toHaveCount(2);
  await backgroundThumbsLoaded(win);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'settings-backgrounds');
});

// Workspace settings → «Звуки» (ADR-0036, MANAGE_STICKERS): two sounds with ▶, emoji, name in
// place, duration, «Заменить файл», up / down, delete; «Добавить звук» at the top.
test('settings-sounds', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.addSound(IDS.workspaces.main, 'Фанфары', '🎺');
  mock.addSound(IDS.workspaces.main, 'Ну и ну', '😮');
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Звуки' }).click();
  await expect(dialog.getByTestId('sound-row')).toHaveCount(2);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'settings-sounds');
});

// docs/09 #82: a 16 px badge after the author's name in the feed and after the names in the
// members column (Борис and Вера — «Acme», Анна — «Globex»).
test('chat-badge', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  giveFixtureBadges(mock);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: 'Логотипы партнёров теперь видны рядом с именем' });
  const members = await membersList(win);
  await expect(members.locator('img[data-member-badge]')).not.toHaveCount(0);
  await expect(win.locator('[data-message-id] img[data-member-badge][title="Acme"]').last()).toBeVisible();
  await badgesLoaded(win);
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'chat-badge');
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
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const card = win.getByTestId('recording-card');
  await expect(card).toHaveCount(1);
  return card;
}

type WithAudio = { __calabaAudio?: HTMLMediaElement };

/** Keeps the chat player's `<audio>` (it is not in the DOM) so a test can put it at an exact second. */
const catchPlayerAudio = (win: Page): Promise<void> =>
  win.evaluate(() => {
    const proto = HTMLMediaElement.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with `.call(this)` below
    const play = proto.play;
    proto.play = function (this: HTMLMediaElement) {
      (window as unknown as WithAudio).__calabaAudio = this;
      return play.call(this);
    };
  });

/** The chat player's (paused) `<audio>` at `sec`: the store follows its `timeupdate`. */
const playerAt = (win: Page, sec: number): Promise<void> =>
  win.evaluate((at) => {
    const el = (window as unknown as WithAudio).__calabaAudio;
    if (el) el.currentTime = at;
  }, sec);

// A done recording (docs/09 #47, #88): GPTunneL's summary folded to 6 lines («Показать всё»),
// «Полный транскрипт», no «Готово» row; the REC circle plays our AAC-in-MP4 copy through the chat's
// player — a progress ring on it and «0:02 / 0:06» in the title, no player in the card.
test('chat-recording-done', async ({ open, win, mock, shot }) => {
  await open();
  const card = await doneCard(win, mock);
  const summary = card.getByTestId('recording-card-summary');
  await expect(summary).toContainText('Релиз 0.7');
  await expect(summary.locator('strong, b').first()).toHaveText('0.7');
  await expect(card.getByTestId('recording-card-more')).toHaveText('Показать всё');
  await expect(card.getByRole('button', { name: 'Полный транскрипт' })).toBeVisible();
  await expect(card.getByTestId('recording-card-status')).toHaveCount(0);
  await expect(card).toContainText('Встреча записана · 42 мин');
  const reply = card.getByRole('button', { name: 'Ответить', exact: true });
  await reply.focus();
  await win.keyboard.press('Enter');
  const composer = win.getByTestId('composer');
  await expect(composer).toContainText('Встреча записана · 42 мин');
  await expect(composer.getByRole('textbox')).toBeFocused();
  await composer.getByRole('button', { name: 'Отмена', exact: true }).click();
  await catchPlayerAudio(win);
  const play = card.getByTestId('recording-card-play');
  await card.getByRole('button', { name: 'Слушать запись' }).click();
  await expect(play).toHaveAttribute('data-playing', 'true');
  await expect(card.getByTestId('audio-player')).toHaveCount(0);
  // AAC in MP4 decodes: the element reports the file's 6 s.
  const time = card.getByTestId('recording-card-time');
  await expect(time).toContainText('/ 0:06');
  await card.getByRole('button', { name: 'Пауза' }).click();
  await expect(play).not.toHaveAttribute('data-playing');
  // Keyboard: Space / Enter on the circle.
  await play.focus();
  await win.keyboard.press('Space');
  await expect(play).toHaveAttribute('data-playing', 'true');
  await win.keyboard.press('Enter');
  await expect(play).not.toHaveAttribute('data-playing');
  await playerAt(win, 2);
  await expect(time).toHaveText('0:02 / 0:06');
  // The card is on screen: its circle is the control, no mini-player.
  await expect(win.getByTestId('mini-player')).toHaveCount(0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await feedAtBottom(win);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'chat-recording-done');
  await card.getByTestId('recording-card-more').click();
  await expect(summary).toContainText('Сколько дней хранить аудио');
  await expect(card.getByTestId('recording-card-more')).toHaveText('Свернуть');
  // «Копировать самари» (#80): the corner button shows on the card's hover; the «…» menu item too.
  const copy = card.getByTestId('recording-card-summary-copy');
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.mouse.move(0, 0);
  await expect(copy).toHaveCSS('opacity', '0');
  await card.hover();
  await expect(copy).toHaveCSS('opacity', '1');
  await copy.click();
  // The text itself: summaryPlainText's unit test (the renderer may not read the clipboard).
  await expect(win.getByText('Скопировано')).toBeVisible();
  await card.getByTestId('recording-card-menu').click();
  await expect(win.getByRole('menuitem', { name: 'Копировать самари' })).toBeVisible();
  await win.keyboard.press('Escape');
  await reply.click();
  await composer.getByRole('textbox').fill('Draft the meeting tasks');
  await composer.getByRole('textbox').press('Enter');
  const cardID = await card.evaluate((el) => el.closest('[data-message-id]')?.getAttribute('data-message-id'));
  expect(cardID).toBeTruthy();
  await expect.poll(() => mock.state.messages.get(IDS.rooms.meeting)?.find((m) => m.content === 'Draft the meeting tasks')?.replyToId).toBe(cardID);
  suspendInMock(mock, IDS.workspaces.main, 'Read only');
  await expect(reply).toHaveCount(0);
});

test('chat-recording-reply-permissions', async ({ open, win, mock }) => {
  await open({ auth: 'out' });
  const room = mock.state.rooms.get(IDS.rooms.general);
  if (!room) throw new Error('missing room');
  room.permissionOverrides.push(create(RoomPermissionOverrideSchema, {
    targetType: PermissionTargetType.USER, targetId: IDS.users.vera, deny: PERMISSION_BITS.SEND_MESSAGES,
  }));
  mock.injectRecordingCard({ roomId: room.id, byUserId: IDS.users.boris, durationSec: 60, status: RecordingStatus.DONE });
  await login(win, 'vera@calaba.test');
  await win.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  const card = win.getByTestId('recording-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ответить', exact: true })).toHaveCount(0);
  // The Electron token broker survives fixture resets: restore the signed-out state so
  // later screens use their normal owner account.
  await open({ auth: 'out' });
});

// docs/09 #57: «Слушать запись» (the REC circle, #88) really plays — the chat's player is installed at startup, not by
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
  await card.getByRole('button', { name: 'Слушать запись' }).click();
  await expect(card.getByTestId('recording-card-play')).toHaveAttribute('data-playing', 'true');
  const time = card.getByTestId('recording-card-time');
  await expect(time).toContainText('/ 1:04');
  const seconds = async (): Promise<number> => {
    const [m, s] = ((await time.textContent()) ?? '').split(' / ')[0]?.split(':').map(Number) ?? [];
    return (m ?? 0) * 60 + (s ?? 0);
  };
  await expect.poll(seconds, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
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
  await expect(card.getByTestId('recording-card-play')).toHaveAttribute('data-playing', 'true');
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

// «Удалить запись» (docs/09 #50): «…» → confirmation «Запись, транскрипт и саммари будут удалены у
// всех» → the card becomes «Запись встречи удалена · Удалил: …».
test('chat-recording-delete', async ({ open, win, mock, shot }) => {
  await open();
  const card = await doneCard(win, mock);
  // The feed pinned to the bottom: the shot must not depend on where the virtualized list settled.
  await feedAtBottom(win);
  await card.getByTestId('recording-card-menu').click();
  await win.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
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
// ADR-0033: «Переслать» in the message menu → the target picker: «Личные» (people) and the rooms
// with the right to send; a pick becomes a chip and a check mark, «Переслать» sends and toasts.
test('chat-forward-dialog', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Переслать' }).click();
  const dialog = win.getByRole('dialog', { name: 'Переслать…' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Личные')).toBeVisible();
  await dialog.getByRole('option', { name: /#разработка/ }).click();
  await expect(dialog.getByTestId('forward-chips')).toContainText('#разработка');
  await expect(dialog.getByTestId('forward-send')).toBeEnabled();
  await settle(win);
  await checkpoint(shot, 'chat-forward-dialog');
  await dialog.getByTestId('forward-send').click();
  await expect(dialog).toHaveCount(0);
  await expect(win.getByText('Переслано в 1 чат')).toBeVisible();
  const copy = (mock.state.messages.get(IDS.rooms.dev) ?? []).at(-1);
  expect(copy?.forward?.authorId).toBeTruthy();
});

// ADR-0033: copies in the feed — «↪ Переслано от <имя> · <дата>» over a text message and over a
// forwarded recording card (no retry / delete there: they belong to the recording's own room).
test('chat-forwarded', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const sentAtMs = Date.parse('2026-01-14T16:05:00Z');
  mock.injectMessage({
    roomId: IDS.rooms.general,
    authorId: IDS.users.vera,
    content: 'Итоги релиза: всё выкатили, мониторинг зелёный.',
    forward: { authorId: IDS.users.boris, sentAtMs, roomId: IDS.rooms.dev },
  });
  mock.injectRecordingCard({
    roomId: IDS.rooms.general,
    byUserId: IDS.users.boris,
    durationSec: 42 * 60 + 10,
    status: RecordingStatus.DONE,
    result: true,
    forward: { by: IDS.users.vera, authorId: IDS.users.boris, sentAtMs, roomId: IDS.rooms.meeting },
  });
  const lines = win.getByTestId('forward-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toContainText('Переслано от Борис');
  // The line's date is the copy's created_at (the forward time); the original's is in the tooltip.
  await expect(lines.first().locator('span[title]')).toHaveAttribute('title', /\nОригинал: /);
  const card = win.getByTestId('recording-card');
  await expect(card.getByRole('button', { name: 'Полный транскрипт' })).toBeVisible();
  await feedAtBottom(win);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'chat-forwarded');
  await card.getByTestId('recording-card-menu').click();
  await expect(win.getByRole('menuitem', { name: 'Переслать' })).toBeVisible();
  await expect(win.getByRole('menuitem', { name: 'Удалить', exact: true })).toHaveCount(0);
  await win.keyboard.press('Escape');
});

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

  // Owner 28.10: a PNG stored with a wrong type and no thumbnail is a picture too (the original is
  // drawn in a box of the picture's size), next to a normal PNG (above) and a plain file (a chip).
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.grigory, content: '', attachments: [IDS.files.pdf] });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.vera, content: '', attachments: [IDS.files.untypedPng] });
  const untyped = win.getByRole('button', { name: 'Открыть изображение «image.png»' });
  await expect.poll(() => untyped.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth === 960)).toBe(true);
  await expect(win.getByRole('button', { name: /^Скачать load-test-report\.pdf/ }).last()).toBeVisible();
  await feedAtBottom(win);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'chat-image-untyped');
  await untyped.click();
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await expect(box.getByRole('heading', { name: 'image.png' })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Скачать' })).toBeVisible();
  await checkpoint(shot, 'chat-lightbox-untyped');
  // Board #118: ←/→ page through the chat's photos in message order (the other message's photo
  // first), and stop at the ends (no wrap).
  const counter = box.locator('span.tabular-nums');
  await expect(counter).toHaveText('3 / 3'); // the chat's three photos; this is the last
  await win.keyboard.press('ArrowRight');
  await expect(counter).toHaveText('3 / 3');
  await win.keyboard.press('ArrowLeft');
  await expect(box.getByRole('heading', { name: 'IMG_2041.png' })).toBeVisible();
  await expect(counter).toHaveText('2 / 3');
  await expect(frame).toHaveAttribute('data-state', 'loaded');
  await checkpoint(shot, 'chat-lightbox-paged');
  await win.keyboard.press('ArrowLeft');
  await expect(counter).toHaveText('1 / 3');
  await win.keyboard.press('ArrowLeft');
  await expect(counter).toHaveText('1 / 3');
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

  // Expanded editor (#97): the corner button on a long draft; the editor shares the draft with the
  // field (formatting, Enter = newline, Esc keeps the text), «Удалить» asks, ⌘Enter sends.
  const longDraft = Array.from({ length: 30 }, (_, i) => `Строка ${i + 1}: черновик длинного сообщения для проверки редактора`).join('\n');
  await expect(win.getByTestId('composer-expand')).toHaveCount(0);
  for (const b of await win.getByTestId('toast').locator('button[aria-label="Закрыть уведомление"]').all()) await b.evaluate((x) => (x as HTMLButtonElement).click());
  await expect(win.getByTestId('toast')).toHaveCount(0);
  await field.fill(longDraft);
  const expand = win.getByTestId('composer-expand');
  await expect(expand).toBeVisible();
  await checkpoint(shot, 'chat-expand-button');
  await expand.click();
  const editor = win.getByRole('dialog', { name: /Сообщение в/ });
  const ed = editor.getByTestId('editor-field');
  await expect(ed).toHaveValue(longDraft);
  await ed.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 6));
  await editor.getByTestId('editor-bold').click();
  await expect(ed).toHaveValue(longDraft.replace('Строка', '**Строка**'));
  await ed.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await ed.press('Enter');
  await expect(ed).toHaveValue(`${longDraft.replace('Строка', '**Строка**')}\n`);
  await checkpoint(shot, 'chat-expanded-editor');
  await win.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(field).toHaveValue(`${longDraft.replace('Строка', '**Строка**')}\n`);
  await field.focus();
  await win.keyboard.press(`${MOD}+Shift+E`);
  await expect(editor).toBeVisible();
  await editor.getByTestId('editor-delete').click();
  await win.getByRole('dialog', { name: 'Удалить черновик?' }).getByRole('button', { name: 'Удалить' }).click();
  await expect(editor).toHaveCount(0);
  await expect(field).toHaveValue('');
  await field.fill(longDraft);
  await win.keyboard.press(`${MOD}+Shift+E`);
  await expect(ed).toBeFocused();
  await ed.press(`${MOD}+Enter`);
  await expect(editor).toHaveCount(0);
  await expect(field).toHaveValue('');
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

// «Только вошёл» (owner, 29.09; docs/08): Вера (already in the room, the row above the voice
// panel) gets joined_at 2 s ago by the page's fixed clock — a 6 px muted-accent dot left of her
// avatar (10 s window; the frozen clock keeps it in the shot). Борис has no joined_at: no dot.
test('voice-room-joined', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  const now = await win.evaluate(() => Date.now());
  mock.setVoiceState({ userId: IDS.users.vera, roomId: IDS.rooms.meeting, joinedAtMs: now - 2_000 });
  const sidebar = win.locator('aside').first();
  await expect(sidebar.getByRole('listitem', { name: /Вера/ }).getByTestId('just-joined-dot')).toHaveAttribute('data-shown', 'true');
  await expect(sidebar.getByRole('listitem', { name: /Борис Петров/ }).getByTestId('just-joined-dot')).toHaveCount(0);
  await checkpoint(shot, 'voice-room-joined');
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
  // Back from the background: the mic is being restored (the panel header) and the remote audio
  // waits for a tap («Вы не слышите собеседников»).
  await win.evaluate(() => {
    const w = window as unknown as { __calabaVoicePhase?: (p: string) => void; __calabaVoiceRecovery?: (what: string) => void };
    w.__calabaVoicePhase?.('connected');
    w.__calabaVoiceRecovery?.('recovering');
    w.__calabaVoiceRecovery?.('playback');
  });
  await expect(win.getByTestId('voice-phase')).toHaveText('Ждём микрофон');
  await expect(win.getByTestId('toast').filter({ hasText: 'Вы не слышите собеседников' })).toBeVisible();
  await checkpoint(shot, 'voice-audio-recovery');
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
  // ADR-0035 addendum: «Фоны пространства» above the built-in pictures.
  giveFixtureBackgrounds(mock);
  // First start: the «Проверьте камеру» sheet with the mirrored preview.
  await win.getByTestId('camera-button').click();
  await expect(win.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await expect(win.getByTestId('camera-bg-workspace').getByRole('radio')).toHaveCount(2);
  await backgroundThumbsLoaded(win);
  await checkpoint(shot, 'camera-preview');
});

// docs/09 #121: a workspace background added while the app runs shows up at once — in the open
// preview (BACKGROUND_CREATE → store → «Фоны пространства») and in camera ▾ «Фоны пространства ▸»;
// choosing it there checks it. Assertions only, no screenshot.
test('camera-bg-live', async ({ open, win, mock }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await hideCameraPixels(win);
  await win.getByTestId('camera-button').click();
  await expect(win.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await expect(win.getByTestId('camera-bg-workspace')).toHaveCount(0);
  mock.addBackground(IDS.workspaces.main, 'Офис', { from: [44, 62, 80], to: [189, 195, 199] });
  await expect(win.getByTestId('camera-bg-workspace').getByRole('radio', { name: 'Офис' })).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('camera-preview-enable')).toBeHidden();
  mock.addBackground(IDS.workspaces.main, 'Логотип', { from: [10, 132, 255], to: [94, 92, 230] });
  await win.getByRole('button', { name: 'Выбор камеры' }).click();
  await win.getByTestId('camera-bg-workspace-menu').hover();
  const logo = win.getByRole('menuitemradio', { name: 'Логотип' });
  await expect(logo).toBeVisible();
  await expect(win.getByRole('menuitemradio', { name: 'Офис' })).toBeVisible();
  await logo.click();
  await win.getByRole('button', { name: 'Выбор камеры' }).click();
  await win.getByTestId('camera-bg-workspace-menu').hover();
  await expect(win.getByRole('menuitemradio', { name: 'Логотип' })).toHaveAttribute('aria-checked', 'true');
  await expect(win.getByRole('menuitemradio', { name: 'Офис' })).toHaveAttribute('aria-checked', 'false');
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
    // «Спикер»: Борис large (my own camera never is by default). Pin my tile: accent ring + pin
    // badge, it goes large, «Открепить» in the header; Esc unpins.
    await win.getByRole('radio', { name: 'Спикер' }).click();
    await expect(win.locator('[data-testid="video-tile"][data-featured]')).toHaveAccessibleName('Камера: Борис Петров');
    const meTile = win.getByRole('button', { name: 'Камера: Анна Смирнова' });
    await meTile.click();
    await expect(meTile).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('[data-testid="video-tile"][data-featured]')).toHaveAccessibleName('Камера: Анна Смирнова');
    await expect(win.getByRole('button', { name: 'Открепить' })).toBeVisible();
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

// Stickers by emoji above the field (docs/08 «Композер — подсказка стикеров», like Telegram): 😂
// typed → the three 😂 of «Смех» in 64 px tiles; → highlights the first, Enter sends it and
// clears the field; typing more text or Esc hides the strip.
test('chat-sticker-suggest', async ({ open, win, mock, shot }) => {
  await open(); // resets the mock: the pack is seeded after it, before the client loads its packs
  await win.emulateMedia({ reducedMotion: 'reduce' });
  mock.seedLaughStickers();
  await mainWindow(win, mock);
  const field = win.getByRole('textbox', { name: /^Сообщение в/ });
  await field.fill('😂');
  const strip = win.getByTestId('sticker-suggest');
  await expect(strip.locator('[data-sticker-suggest]')).toHaveCount(3);
  await field.press('ArrowRight');
  await expect(strip.getByRole('option', { selected: true })).toHaveCount(1);
  await stillStickers(win, 1);
  await checkpoint(shot, 'chat-sticker-suggest');
  await field.press('Escape');
  await expect(strip).toHaveCount(0);
  await field.fill('😂 ок');
  await expect(strip).toHaveCount(0);
  await field.fill('😂');
  await field.press('ArrowRight');
  await field.press('Enter');
  await expect(win.getByTestId('sticker-message')).toHaveCount(1);
  await expect(field).toHaveValue('');
  await expect(strip).toHaveCount(0);
});

// Workspace settings → «Стикеры» → the pack «Calab»: name, the drop zone, the stickers with their
// emoji (the first is the cover) and the «⋯» menu of one of them open.
test('settings-stickers', async ({ open, win, mock, shot }) => {
  await open();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await mainWindow(win, mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
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
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
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

// The pack «Calab», the emoji chip of the last sticker clicked (docs/09 #79): the shared emoji
// picker opens above the chip, over the settings sheet (--z-modal-popover).
test('settings-stickers-emoji', async ({ open, win, mock, shot }) => {
  await open();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await mainWindow(win, mock);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Стикеры' }).click();
  await dialog.getByTestId('sticker-pack-row').filter({ hasText: 'Calab' }).click();
  await expect(dialog.getByTestId('sticker-pack-stickers').locator('[data-sticker]')).toHaveCount(3);
  await stillStickers(win, 1);
  const chip = dialog.getByTestId('sticker-cell').last().getByTestId('sticker-emoji');
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  const picker = win.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('textbox')).toBeFocused();
  await checkpoint(shot, 'settings-stickers-emoji');
});

// ---------------------------------------------------------------- bots (ADR-0031)

/** Workspace settings → «Боты» with the two seeded bots (mock.seedBots()). */
async function botsTab(win: Page, mock: MockServer): Promise<Locator> {
  mock.seedBots();
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Боты' }).click();
  await expect(dialog.getByTestId('bot-row')).toHaveCount(2);
  return dialog;
}

// «Боты»: create form, add by @username, the plan line, the list — «Погода» (webhook delivering)
// and «Деплой» (webhook failing since 12:12, 7 queued), each with «…»; «Погода» has a picture
// avatar (docs/09 #87: set from this tab — the avatar is a button).
test('settings-bots', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const dialog = await botsTab(win, mock);
  mock.setBotAvatar(IDS.bots.weather, { bg: [56, 132, 214], fg: [250, 204, 21] });
  await expect(dialog.getByTestId('bot-row').filter({ hasText: 'Погода' }).locator('img')).toBeVisible();
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
  // ADR-0111: «Делегировать права» from the bot's menu in the members column — my own row
  // («Разрешить»), Борис who allowed it, Вера whom Анна (me) suggested it to (× to cancel).
  await win.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  mock.seedBotDelegations(IDS.bots.weather);
  await members.getByRole('button', { name: /Погода/ }).click({ button: 'right' });
  await win.getByTestId('member-bot-delegate').click();
  const dlg = win.getByRole('dialog', { name: /Делегировать права/ });
  await expect(dlg.getByTestId('bot-delegation-grant')).toBeVisible();
  await expect(dlg.getByTestId('bot-delegation-row')).toHaveCount(2);
  await checkpoint(shot, 'bot-delegation');
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

// ---------------------------------------------------------------- calendar (ADR-0038 §7)

/**
 * Free / busy of the calendar screens (ADR-0041): Борис's meeting with Григорий (no room — Анна
 * cannot see it) 16:00–17:00, Вера's external calendar 17:00–18:00 MSK.
 */
function freeBusyDay(mock: MockServer): void {
  const at = (iso: string): number => Date.parse(iso);
  mock.addEvent({ workspaceId: IDS.workspaces.main, organizerId: IDS.users.boris, title: 'Секрет', startMs: at('2026-01-15T13:00:00Z'), endMs: at('2026-01-15T14:00:00Z'), attendees: [{ userId: IDS.users.grigory }] });
  mock.setBusy(IDS.users.vera, [{ startMs: at('2026-01-15T14:00:00Z'), endMs: at('2026-01-15T15:00:00Z') }]);
}

/**
 * ADR-0045: Анна's CalDAV account and one external event of hers, 11:00–12:00 MSK, with a place,
 * a link and attendees — Борис (a member) and an outside address.
 */
function externalEvent(mock: MockServer): void {
  mock.setCalDav(IDS.users.anna);
  mock.setBusy(IDS.users.anna, [
    {
      startMs: Date.parse('2026-01-15T08:00:00Z'),
      endMs: Date.parse('2026-01-15T09:00:00Z'),
      uid: 'ext-podryadchik',
      summary: 'Созвон с подрядчиком',
      location: 'Zoom',
      url: 'https://zoom.us/j/123456',
      organizer: 'pm@partner.org',
      attendees: [{ email: 'boris@calaba.test', name: 'Борис Петров' }, { email: 'pm@partner.org', name: 'Ольга' }],
    },
  ]);
}

/** The calendar screens: a full day of meetings (calendarWeb.seedDay), the mock's clock at NOW. */
/** Seeds the day (seedDay) and opens the calendar; returns the id of «Планёрка». */
async function calendarDay(win: Page, mock: MockServer): Promise<string> {
  mock.setClock(NOW.getTime());
  const planerka = seedDay(mock);
  await win.getByTestId('section-calendar').click();
  await expect(win.getByTestId('mini-calendar')).toBeVisible();
  return planerka;
}

/** The header icon with today's count: today's day view at once, the mini month under the header (ADR-0041 §3). */
test('calendar-mini', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await calendarDay(win, mock);
  await expect(win.getByTestId('day-view')).toBeVisible();
  await expect(win.getByTestId('section-calendar-count')).toHaveText('3');
  await expect(win.locator('[data-cal-day="2026-01-20"]')).toHaveAccessibleName(/есть встречи/);
  await checkpoint(shot, 'calendar-mini');
});

/**
 * The day view with the red «now» line, overlapping blocks, the all-day row and the selected meeting's
 * card; then the card's comments (ADR-0104): the thread, a comment of mine sent from the field.
 */
test('calendar-day', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  externalEvent(mock);
  const planerka = await calendarDay(win, mock);
  mock.addEventComment(planerka, IDS.users.boris, 'Повестка: релиз 1.0 и **ретро** спринта. Ссылки — в описании.', NOW.getTime() - 3 * 3_600_000);
  mock.addEventComment(planerka, IDS.users.vera, 'Опоздаю минут на пять', NOW.getTime() - 20 * 60_000);
  await win.locator(`[data-cal-day="${DAY}"]`).click();
  await expect(win.getByTestId('day-view')).toBeVisible();
  await expect(win.getByTestId('now-line')).toBeVisible();
  await win.getByTestId('event-block').filter({ hasText: 'Планёрка' }).click();
  const card = win.getByTestId('event-panel');
  await expect(card.getByTestId('event-title')).toHaveText('Планёрка');
  await expect(card.getByTestId('event-attendee')).toHaveCount(5);
  // My external calendar's event (ADR-0045 §3): a dashed card with its title and place.
  await expect(win.getByTestId('external-block')).toContainText('Созвон с подрядчиком');
  await checkpoint(shot, 'calendar-day');

  const comments = card.getByTestId('event-comments');
  await comments.scrollIntoViewIfNeeded();
  await expect(comments.getByTestId('event-comment')).toHaveCount(2);
  await comments.getByTestId('event-comment-input').fill('Подготовлю демо');
  await comments.getByTestId('event-comment-input').press('Enter');
  await expect(comments.getByTestId('event-comment')).toHaveCount(3);
  await expect(comments.getByRole('heading')).toHaveText('Комментарии — 3');
  await expect(comments.getByTestId('event-comment-input')).toBeInViewport();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await comments.getByTestId('event-comment').last().hover();
  await checkpoint(shot, 'calendar-comments', { keepPointer: true });

  // ADR-0157: a repeating meeting dragged asks «Только эту / Всю серию»; «Только эту» moves that
  // occurrence alone (the series keeps its 10:00 on the other days).
  const standup = win.getByTestId('event-block').filter({ hasText: 'Стендап' });
  await standup.scrollIntoViewIfNeeded();
  const box = await standup.boundingBox();
  if (!box) throw new Error('no stand-up block');
  const x = box.x + 40; // the block's left part: the meeting card floats over its right side
  await win.mouse.move(x, box.y + 4);
  await win.mouse.down();
  const ghostAt = (): Promise<string> => win.evaluate(() => document.querySelector('[data-testid="drag-ghost"]')?.textContent ?? '');
  for (let i = 1; i <= 60 && !(await ghostAt()).startsWith('12:00'); i++) await win.mouse.move(x, box.y + 4 + i * 4);
  await expect(win.getByTestId('drag-ghost')).toContainText('12:00 – 12:15');
  await win.mouse.up();
  await expect(win.getByTestId('choice-this')).toBeVisible();
  await checkpoint(shot, 'calendar-series-scope');
  await win.getByTestId('choice-this').click();
  await expect(win.getByTestId('choice-this')).toHaveCount(0);
  await expect(win.getByTestId('event-block').filter({ hasText: 'Стендап' })).toContainText('12:00');
  // The card closed: the moved occurrence at 12:00 next to «Обед с командой», nothing left at 10:00.
  await win.getByTestId('event-panel').getByRole('button', { name: 'Закрыть встречу' }).click();
  await expect(win.getByTestId('event-panel')).toHaveCount(0);
  await win.mouse.move(1, 1);
  await checkpoint(shot, 'calendar-series-moved');
});

/**
 * Week view (bug board #6, Yandex Calendar): «День / Неделя» in the header, Monday-first week of
 * 12–18 January with today (Thursday 15) in an accent circle and a shaded column, the «now» line in
 * it, the daily stand-up in every column from Tuesday, «Планёрка» and «Ревью дизайна» side by side,
 * «Релиз 1.0» in the «весь день» band, the ISO week number and the UTC offset (at 960 the narrow
 * columns cascade the overlapping pair). Then a block opens its card; ‹ › step a week.
 */
test('calendar-week', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await calendarDay(win, mock);
  await win.locator(`[data-cal-day="${DAY}"]`).click();
  await win.getByTestId('cal-view').getByRole('radio', { name: /Неделя|Week/ }).click();
  const week = win.getByTestId('week-view');
  await expect(week).toBeVisible();
  await expect(week.getByTestId('week-today')).toHaveText('15');
  await expect(week.getByTestId('week-number')).toHaveText('3 нед.');
  await expect(week.getByTestId('week-zone')).toHaveText('UTC+3');
  await expect(week.getByTestId('now-line')).toBeVisible();
  await expect(week.getByTestId('event-block').filter({ hasText: 'Стендап' })).toHaveCount(6);
  await expect(week.getByTestId('allday-row')).toContainText('Релиз 1.0');
  await checkpoint(shot, 'calendar-week');
  await week.getByTestId('event-block').filter({ hasText: 'Ревью дизайна' }).click();
  await expect(win.getByTestId('event-panel').getByTestId('event-title')).toHaveText('Ревью дизайна');
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('event-panel')).toHaveCount(0);
  await win.getByTestId('cal-next').click();
  await expect(week.getByTestId('cal-title')).toHaveText(/январь 2026/i);
  await expect(week.getByTestId('week-today')).toHaveCount(0);
  await expect(week.getByTestId('event-block').filter({ hasText: 'Ретро' })).toHaveCount(1);
});

/**
 * «Люди» (ADR-0041 §3): Борис and Вера chosen — their meetings, grey «Занято · Борис Петров» for his
 * meeting Анна cannot see, Вера's external calendar hatched; my own meetings without them hidden.
 */
test('calendar-filter', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  freeBusyDay(mock);
  await calendarDay(win, mock);
  await win.getByTestId('people-filter-add').click();
  const picker = win.getByTestId('people-filter-picker');
  await picker.getByRole('option', { name: /Борис/ }).click();
  await picker.getByRole('option', { name: /Вера/ }).click();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('person-chip')).toHaveCount(2);
  await expect(win.getByTestId('busy-block')).toHaveCount(2);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expectToolbarHeights(win.locator('[data-bar]').filter({ has: win.getByTestId('cal-prev') }), 'calendar toolbar');
  await checkpoint(shot, 'calendar-filter');
});

/** «Подобрать время»: columns of Анна, Борис, Вера (work hours grey, external hatched), green windows, «Ближайшие окна». */
test('calendar-findtime', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  freeBusyDay(mock);
  await calendarDay(win, mock);
  await win.getByTestId('day-find').click();
  const pane = win.getByTestId('find-time');
  await pane.getByTestId('find-people-add').click();
  const picker = win.getByTestId('find-people-picker');
  await picker.getByRole('option', { name: /Борис/ }).click();
  await picker.getByRole('option', { name: /Вера/ }).click();
  await win.keyboard.press('Escape');
  await expect(pane.getByTestId('busy-column')).toHaveCount(3);
  // 960: «Ближайшие окна» is the toolbar's popover (the grid keeps the width); «Следующее окно» outlines one.
  await pane.getByTestId('find-slots-toggle').click();
  await expect(win.getByTestId('find-slot')).not.toHaveCount(0);
  await win.getByTestId('find-next').click();
  await expect(pane.getByTestId('find-selection')).toBeVisible();
  // No focus ring from the mouse: the toolbar's last pressed control loses the focus before the shot.
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'calendar-findtime');
});

/** Settings → Календарь: work hours, the reminders link, the CalDAV connect form with the providers' addresses. */
test('settings-calendar', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await openSettingsTab(win, openAppSettings(win), appTab('calendar'));
  await expect(win.getByTestId('caldav-connect')).toBeVisible();
  await checkpoint(shot, 'settings-calendar');
  // CBF-165: «Первый день недели» — Monday by default, Sunday on choice (the work days follow).
  await expect(win.getByRole('radio', { name: 'Понедельник' })).toBeChecked();
  await win.getByRole('radio', { name: 'Воскресенье' }).click();
  await expect(win.getByTestId('wh-days').getByRole('button').first()).toHaveText(/вс/i);
  await checkpoint(shot, 'settings-calendar-sunday');
});

/**
 * Board #85 (Yandex Calendar's «ещё один часовой пояс»): Калькутта (UTC+5:30) as a muted hour
 * column left of the main scale in the day and the week, its label over the offset, the axis «now»
 * line; then Settings → Календарь adds New York by search (the picker shows offset and time now)
 * and labels it; the week and the day with both (New York on the previous day until 08:00 MSK).
 */
test('calendar-zones', async ({ open, win, mock, shot }) => {
  await open();
  // Me is read at start: the zone is set after the mock's reset, then the window reloads.
  mock.setCalendarZones(IDS.users.anna, [{ zone: 'Asia/Kolkata' }]);
  await win.reload();
  await expect(win.locator('aside').first()).toBeVisible({ timeout: 30_000 });
  await mainWindow(win, mock);
  await calendarDay(win, mock);
  await win.locator(`[data-cal-day="${DAY}"]`).click();
  const day = win.getByTestId('day-view');
  await expect(day.getByTestId('zone-scale')).toHaveCount(1);
  await expect(day.getByTestId('zone-head')).toHaveText(/Kolkata\s*UTC\+5:30/);
  await expect(day.getByTestId('zone-now')).toBeVisible();
  await checkpoint(shot, 'calendar-day-zone1');
  await win.getByTestId('cal-view').getByRole('radio', { name: /Неделя|Week/ }).click();
  const week = win.getByTestId('week-view');
  await expect(week.getByTestId('zone-scale')).toHaveCount(1);
  await expect(week.getByTestId('zone-now')).toBeVisible();
  await checkpoint(shot, 'calendar-week-zone1');

  await openSettingsTab(win, openAppSettings(win), appTab('calendar'));
  await win.getByTestId('cal-zone-add').click();
  await win.getByPlaceholder('Город или пояс').fill('New York');
  await expect(win.getByTestId('cal-zone-list').getByRole('option').first()).toContainText('UTC−5');
  await checkpoint(shot, 'settings-calendar-zones-picker');
  await win.getByPlaceholder('Город или пояс').press('Enter');
  const labels = win.getByTestId('cal-zone-label');
  await expect(labels).toHaveCount(2);
  await labels.nth(1).fill('Нью-Йорк');
  await labels.nth(1).press('Enter');
  await expect(win.getByRole('dialog').getByText('Нью-Йорк', { exact: true })).toBeVisible();
  await expect(win.getByTestId('cal-zone-add')).toHaveCount(0);
  await checkpoint(shot, 'settings-calendar-zones');
  await win.keyboard.press('Escape');
  await expect(win.getByRole('dialog')).toHaveCount(0);

  await expect(week.getByTestId('zone-scale')).toHaveCount(2);
  await week.getByTestId('week-scroller').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(week.getByTestId('zone-newday').first()).toBeVisible();
  await checkpoint(shot, 'calendar-week-zones');
  await win.getByTestId('cal-view').getByRole('radio', { name: /День|Day/ }).click();
  await expect(day.getByTestId('zone-scale')).toHaveCount(2);
  await day.getByTestId('day-scroller').evaluate((el) => el.scrollTo({ top: 6 * 48 }));
  await checkpoint(shot, 'calendar-day-zones');
});

/** ADR-0045 §3: a click on my external event — its attendees (Борис by avatar and name, the rest by address), «Открыть», «Создать встречу в Calab». */
test('calendar-external', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  externalEvent(mock);
  await calendarDay(win, mock);
  await win.locator(`[data-cal-day="${DAY}"]`).click();
  await win.getByTestId('external-block').click();
  const pop = win.getByTestId('external-popover');
  await expect(pop.getByTestId('external-title')).toHaveText('Созвон с подрядчиком');
  await expect(pop.getByTestId('external-attendee')).toHaveCount(2);
  await expect(pop.locator(`[data-user="${IDS.users.boris}"]`)).toBeVisible();
  await expect(pop.getByTestId('external-create')).toBeVisible();
  await checkpoint(shot, 'calendar-external');
  // «Создать встречу в Calab»: the dialog with the title, the time, Борис; the address listed apart.
  await pop.getByTestId('external-create').click();
  const dialog = win.getByTestId('event-dialog');
  await expect(dialog.getByTestId('event-title-input')).toHaveValue('Созвон с подрядчиком');
  await expect(dialog.getByTestId('event-chip')).toHaveCount(1);
  await expect(dialog.getByTestId('event-outside')).toHaveText('Не в пространстве: pm@partner.org');
});

/** Settings → Календарь with a connected account: «Что видят коллеги» at «Название и участники». */
test('settings-caldav', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setCalDav(IDS.users.anna, { shareLevel: 'details' });
  await openSettingsTab(win, openAppSettings(win), appTab('calendar'));
  const share = win.getByTestId('caldav-share');
  await expect(share.getByRole('radio', { name: 'Название и участники' })).toHaveAttribute('aria-checked', 'true');
  await share.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'settings-caldav');
});

/** «+ Встреча»: the dialog filled in — attendee chips (one optional, one external), a room, a repeat. */
test('calendar-dialog', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await calendarDay(win, mock);
  await win.locator(`[data-cal-day="${DAY}"]`).click();
  await win.getByTestId('section-create-event').click(); // the sidebar «+» (the header has no «Встреча», CBF-18)
  const dialog = win.getByTestId('event-dialog');
  await dialog.getByTestId('event-title-input').fill('Разбор релиза');
  await dialog.getByTestId('event-room').click(); // the room picker with a search (CBF-18)
  await win.getByRole('option', { name: 'Переговорка' }).click();
  await dialog.getByTestId('event-add-people').click();
  // docs/09 #85: colleagues in other zones show their local time, zone and working hours.
  await expect(win.getByTestId('event-member-picker').getByRole('option', { name: /Борис/ })).toContainText('UTC+5 · 10–19');
  await checkpoint(shot, 'calendar-dialog-picker');
  // The picker stays open for several people.
  await win.getByTestId('event-member-picker').getByRole('option', { name: /Борис/ }).click();
  await win.getByTestId('event-member-picker').getByRole('option', { name: /Вера/ }).click();
  await win.keyboard.press('Escape');
  await dialog.getByRole('button', { name: /Сделать необязательным: Вера/ }).click();
  await dialog.getByTestId('event-email').fill('ext@example.com');
  await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
  await dialog.getByTestId('event-repeat').selectOption({ label: 'Каждую неделю' });
  await expect(dialog.getByTestId('event-chip')).toHaveCount(3);
  await dialog.getByTestId('event-title-input').blur();
  await checkpoint(shot, 'calendar-dialog');
  // ADR-0136: «В рабочие дни» with the calendar it follows as the field's hint.
  await dialog.getByTestId('event-repeat').selectOption({ label: 'В рабочие дни' });
  await dialog.getByText('по производственному календарю РФ').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'calendar-dialog-workdays');
});

// ---------------------------------------------------------------- task boards (ADR-0042 §5)

/** Boards mode on «Разработка» (CAL, the mock's seeded board), the clock at NOW. */
async function boardsMode(win: Page, mock: MockServer): Promise<void> {
  mock.setClock(NOW.getTime());
  await win.getByTestId('section-boards').click();
  await expect(win.getByTestId('kanban')).toBeVisible();
  await expect(win.getByTestId('task-card').filter({ hasText: 'CAL-3' })).toBeVisible();
}

/** The kanban: the boards column, statuses with counts, cards with every chip (overdue CAL-3). */
test('boards-kanban', async ({ open, win, mock, shot }) => {
  await open();
  seedAssigneeCounts(mock); // #92: CAL-1 / CAL-2 / CAL-4 with 1 / 2 / 5 assignees (after open(): it resets the mock)
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await checkpoint(shot, 'boards-kanban');
  // Board #117: one control height in the toolbar (search, filter, sort, display, view switch, new task, more).
  await expectToolbarHeights(win.getByTestId('board-header'), 'boards toolbar');
  // The third column («В работе», CAL-4 with five people) is past the 960 px edge: scroll the board sideways.
  await win.getByTestId('kanban').evaluate((el) => [el, ...el.querySelectorAll<HTMLElement>('*')].forEach((e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth && (e.scrollLeft = 320)));
  await expect(win.getByTestId('task-card').filter({ hasText: 'Карточки задач' })).toBeVisible();
  await expectAssigneeStacks(win);
  await checkpoint(shot, 'boards-kanban-assignees', { axe: false });

  // Status picker on a task waiting for approval: the statuses it may not reach carry a second
  // line («нужно согласование»); one-line and two-line rows keep the same padding and rhythm.
  await win.getByTestId('task-card').filter({ hasText: 'Ревью: права досок' }).getByTestId('card-status').click();
  const statusMenu = win.getByTestId('status-menu');
  await expect(statusMenu.getByTestId('picker-option').first()).toBeVisible();
  await expect(statusMenu).toContainText('нужно согласование');
  await checkpoint(shot, 'boards-status-menu', { axe: false });
  await win.keyboard.press('Escape');
  await expect(statusMenu).toBeHidden();

  // CBF-58: the column's «+» — «Создать задачу», the boards to create in, a separator, category / board.
  await win.getByTestId('section-create-board').click();
  const createMenu = win.getByTestId('boards-create-menu');
  await expect(createMenu).toBeVisible();
  await expect(createMenu.getByTestId('boards-create-task')).toBeVisible();
  await expect(createMenu.getByTestId('boards-create-board')).toBeVisible();
  await checkpoint(shot, 'boards-create-menu');
  await win.keyboard.press('Escape');
  await expect(createMenu).toHaveCount(0);

  // Needs the dev LiveKit: in voice, the boards screen folds the island into my avatar with the
  // call mark (ADR-0146); hovering it opens the full island over the board, its mic mutes the call
  // while the board stays on screen; the avatar then shows the red crossed mic.
  await joinVoice(win);
  await boardsMode(win, mock);
  const dock = win.getByTestId('bottom-island');
  await expect(dock).toBeHidden();
  await win.getByTestId('island-avatar').hover();
  await expect(dock).toContainText('Голос подключён');
  await dock.getByRole('button', { name: /^Выключить микрофон/ }).click();
  await expect(dock.getByRole('button', { name: /^Включить микрофон/ })).toBeVisible();
  await expect(win.getByTestId('kanban')).toBeVisible();
  await checkpoint(shot, 'boards-voice-island', { keepPointer: true });
  await win.mouse.move(600, 300);
  await expect(dock).toBeHidden();
  await expect(win.getByTestId('island-call-mark')).toHaveAttribute('data-muted', 'true');
  await checkpoint(shot, 'boards-voice-avatar');

  // The setting off (Settings → Основное): the old full island on every screen.
  await win.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = win.getByRole('dialog');
  await settings.getByRole('tab', { name: 'Основное' }).click();
  const fold = settings.getByRole('switch', { name: /^Островок: сворачивать в аватар/ });
  await expect(fold).toBeChecked();
  await fold.click();
  await expect(fold).not.toBeChecked();
  await win.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(dock).toBeVisible();
  await expect(win.getByTestId('island-avatar')).toHaveCount(0);
});

/**
 * CBF-68: «Создать умную задачу» in the column's «+». Without a checked AI connection the item is
 * off with the reason under it; once READY it opens the dialog (text, priority, files); «Создать»
 * creates the task and opens it.
 */
test('boards-smart-task', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('section-create-board').click();
  const menu = win.getByTestId('boards-create-menu');
  // CBF-69: on Team (the fixture) the item is off for the plan, whatever the AI state.
  await expect(menu.getByTestId('boards-create-smart-hint')).toHaveText('Доступно на тарифе Business');
  await expect(menu.getByTestId('boards-create-smart')).toHaveAttribute('data-disabled', '');
  await checkpoint(shot, 'boards-smart-plan');
  await win.keyboard.press('Escape');
  mock.setPlanKind(IDS.workspaces.main, Plan.ENTERPRISE);
  await win.getByTestId('section-create-board').click();
  await expect(menu.getByTestId('boards-create-smart-hint')).toHaveText('Сначала подключите AI в настройках');
  await expect(menu.getByTestId('boards-create-smart')).toHaveAttribute('data-disabled', '');
  await checkpoint(shot, 'boards-smart-off');
  await win.keyboard.press('Escape');

  mock.setAiState(IDS.workspaces.main, AiState.READY);
  await win.getByTestId('section-create-board').click();
  await expect(menu.getByTestId('boards-create-smart-hint')).toHaveCount(0);
  await menu.getByTestId('boards-create-smart').click();
  const dialog = win.getByTestId('smart-task');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('smart-task-text').fill('Оплатить счёт поставщика до пятницы\nСумма 120 000 ₽, реквизиты в письме бухгалтерии.');
  await checkpoint(shot, 'boards-smart-dialog');
  // CBF-75: the model declines (a duplicate): the reason and the task inline, the text stays.
  const text = dialog.getByTestId('smart-task-text');
  await text.fill('Оплатить счёт поставщика — похоже, дубль\nСумма 120 000 ₽.');
  await win.getByTestId('smart-task-submit').click();
  await expect(dialog.getByTestId('smart-task-refusal')).toContainText('Похоже на дубль задачи CAL-3');
  await expect(dialog.getByTestId('smart-task-duplicate')).toHaveText('Открыть CAL-3');
  await expect(text).toHaveValue('Оплатить счёт поставщика — похоже, дубль\nСумма 120 000 ₽.');
  await checkpoint(shot, 'boards-smart-refused');
  // Bug #152: no answer in time — the cause in words and the code / status / request id to quote.
  await text.fill('Оплатить счёт поставщика — таймаут\nСумма 120 000 ₽.');
  await win.getByTestId('smart-task-submit').click();
  await expect(dialog.getByTestId('smart-task-error')).toContainText('Сервер не ответил вовремя');
  await expect(dialog.getByTestId('smart-task-error-ref')).toHaveText('Для поддержки: UNAVAILABLE · 504 · 7f3c9a1e5b2d4c6f8a0b1c2d');
  await checkpoint(shot, 'boards-smart-error');
  await text.fill('Оплатить счёт поставщика до пятницы\nСумма 120 000 ₽, реквизиты в письме бухгалтерии.');
  await expect(dialog.getByTestId('smart-task-error')).toHaveCount(0);
  await expect(dialog.getByTestId('smart-task-refusal')).toHaveCount(0);
  await win.getByTestId('smart-task-submit').click();
  await expect(dialog).toHaveCount(0);
  await expect(win.getByTestId('task-panel')).toContainText('Оплатить счёт поставщика до пятницы');
});

/** The task full screen over the board: properties, two assignees, relations, comments. */
/** Board #115: the bot's «act on your behalf» request in the task: a warn block, one button, a window with «Разрешить» / «Отклонить». */
test('boards-bot-consent', async ({ open, win, mock, shot }) => {
  await open();
  seedBotAuthoredTask(mock);
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  const block = panel.getByTestId('bot-consent-prompt');
  await expect(block).toBeVisible();
  await expect(block.getByRole('button')).toHaveCount(1);
  await checkpoint(shot, 'boards-bot-consent');
  await block.getByTestId('bot-consent-review').click();
  const dlg = win.getByTestId('bot-consent-dialog');
  await expect(dlg).toBeVisible();
  await checkpoint(shot, 'boards-bot-consent-dialog');
  // «Отклонить» closes the window and removes the block.
  await win.getByTestId('bot-consent-deny').click();
  await expect(dlg).toHaveCount(0);
  await expect(block).toHaveCount(0);
});

/** Board #115: «Разрешить» in the window closes it and the block goes. */
test('boards-bot-consent-allow', async ({ open, win, mock }) => {
  await open();
  seedBotAuthoredTask(mock);
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  await panel.getByTestId('bot-consent-review').click();
  await win.getByTestId('bot-consent-allow').click();
  await expect(win.getByTestId('bot-consent-dialog')).toHaveCount(0);
  await expect(panel.getByTestId('bot-consent-prompt')).toHaveCount(0);
});

test('boards-task', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  await expect(panel.getByTestId('assignee-row')).toHaveCount(2);
  await expect(panel.locator('[data-message-id]')).toHaveCount(2);
  await checkpoint(shot, 'boards-task');

  // ADR-0103 (owner 15.10: a click on a task attachment did nothing): attach a PDF, click its
  // chip — the PDF viewer, not a dead link; Esc brings the task back.
  const upload = win.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(r.url()));
  await panel.locator('input[type=file]').first().setInputFiles({ name: 'load-test-report.pdf', mimeType: 'application/pdf', buffer: mockPdf(245_760) });
  expect((await upload).ok()).toBe(true);
  await panel.getByTestId('task-attachment-open').filter({ hasText: 'load-test-report.pdf' }).click();
  const viewer = win.getByTestId('pdf-viewer');
  await expect(viewer).toHaveAttribute('data-state', 'ready');
  await expect(viewer.getByRole('heading', { name: 'load-test-report.pdf' })).toBeVisible();
  // Chromium's viewer paints in its own process: give it a moment past the frame's load.
  await viewer.getByTestId('pdf-frame').evaluate((f) => new Promise<void>((done) => ((f as HTMLIFrameElement).contentDocument?.readyState === 'complete' ? done() : f.addEventListener('load', () => done(), { once: true }))));
  await win.waitForTimeout(1500);
  await checkpoint(shot, 'boards-task-pdf');
  await win.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(panel).toBeVisible();

  // Owner 23.10: the description edits in place in the wiki's editor — the `/` blocks (only what the
  // task view shows), the selection bar; CBF-59: «/Картинка» attaches the picture and shows it inline.
  await panel.getByTestId('task-description').click();
  const editor = panel.getByTestId('task-description-editor');
  const prose = editor.locator('.wiki-prose');
  await expect(prose).toBeFocused();
  await win.keyboard.press('Enter');
  await win.keyboard.type('Проверить экспорт');
  await win.keyboard.press('Enter');
  await win.keyboard.type('/');
  const blocks = win.getByRole('listbox', { name: 'Блоки' });
  await expect(blocks.getByRole('option')).toHaveCount(6);
  await checkpoint(shot, 'boards-task-desc-slash');
  const shotPng = encodePng(640, 360, (u, v) => (v < 0.15 ? [58, 124, 246] : u < 0.3 ? [235, 238, 245] : [250, 251, 253]));
  const attached = win.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(r.url()));
  const chooser = win.waitForEvent('filechooser');
  await blocks.getByRole('option', { name: 'Картинка' }).click();
  await (await chooser).setFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: shotPng });
  expect((await attached).ok()).toBe(true);
  await expect(prose.locator('.wiki-image img')).toBeVisible();
  // The selection bar over «Проверить экспорт»: marks and «Превратить в», no highlight colours.
  await prose.getByText('Проверить экспорт').dblclick();
  await expect(win.getByRole('toolbar', { name: 'Форматирование' })).toBeVisible();
  await checkpoint(shot, 'boards-task-desc-bubble');
  await panel.getByTestId('task-description-save').click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByTestId('task-description-img')).toBeVisible();
  await expect(panel.getByTestId('task-description')).toContainText('Проверить экспорт');
  await checkpoint(shot, 'boards-task-inline-image');

  // Board #107: reading and editing the description look the same — one text with a heading, paragraphs,
  // a list, a link and an emoji is shot in both modes and the blocks must sit on the same pixels.
  await panel.getByTestId('task-description').locator('p').first().click({ position: { x: 8, y: 8 } });
  await expect(prose).toBeFocused();
  await win.keyboard.press('ControlOrMeta+a');
  await win.keyboard.press('Backspace');
  await win.keyboard.type('# Итоги звонка');
  await win.keyboard.press('Enter');
  await win.keyboard.type('Эхо пропало после правки 🎉 подробности на https://calab.io/docs ');
  // Board #150: Enter twice leaves an empty line between paragraphs; it must survive «Готово» and keep its height.
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  await win.keyboard.type('Второй абзац с **жирным** словом.');
  await win.keyboard.press('Enter');
  await win.keyboard.type('- первый пункт');
  await win.keyboard.press('Enter');
  await win.keyboard.type('второй пункт');
  // Board #134: a pasted markdown table is a table in edit mode and stays one after saving.
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  await prose.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '| Поле | Тип | Заметка |\n| --- | --- | --- |\n| id | **uuid** | первичный ключ |\n| имя | text | |');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(prose.locator('table th')).toHaveCount(3);
  await panel.getByTestId('task-description-save').click();
  await expect(editor).toHaveCount(0);
  const read = panel.getByTestId('task-description');
  await expect(read.locator('h1')).toHaveText('Итоги звонка');
  await expect(read.locator('table th')).toHaveCount(3);
  await expect(read.locator('table td')).toHaveCount(6);
  await expect(read.locator('table td strong')).toHaveText('uuid');
  const boxes = async (root: Locator): Promise<number[][]> => {
    const out: number[][] = [];
    for (const sel of ['h1', 'p >> nth=0', 'p >> nth=1', 'li >> nth=1', 'table', 'th >> nth=1', 'td >> nth=4']) {
      const b = await root.locator(sel).boundingBox();
      out.push(b ? [b.x, b.y, b.width, b.height] : []);
    }
    return out;
  };
  await expect(read.locator('p').nth(1)).toHaveText('');
  const readBoxes = await boxes(read);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-task-desc-read');
  await read.locator('h1').click();
  await expect(prose).toBeFocused();
  const editBoxes = await boxes(prose);
  for (let i = 0; i < readBoxes.length; i++) for (let j = 0; j < 4; j++) expect(Math.abs((editBoxes[i]?.[j] ?? 1e6) - (readBoxes[i]?.[j] ?? -1e6)), `block ${i} coord ${j}: read ${String(readBoxes[i])} edit ${String(editBoxes[i])}`).toBeLessThanOrEqual(1);
  await checkpoint(shot, 'boards-task-desc-edit');
  await win.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  // #89 / #93: «×» closes the card; Ctrl/⌘-click on cards adds background tabs; a click on a tab
  // opens it; a half-typed comment survives the trip to another tab and back.
  await panel.getByTestId('task-close').click();
  await expect(panel).toBeHidden();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  for (const key of ['CAL-1', 'CAL-2', 'CAL-4']) await win.getByTestId('task-card').filter({ hasText: key }).getByTestId('card-title').click({ modifiers: [mod] });
  const tabs = win.getByTestId('task-tabs').getByTestId('task-tab');
  await expect(tabs).toHaveCount(3);
  await expect(panel).toBeHidden();
  await tabs.nth(0).getByRole('button').first().click();
  await expect(panel).toBeVisible();
  const draft = panel.getByTestId('task-composer').getByRole('textbox');
  await draft.fill('Черновик, который не должен пропасть');
  await tabs.nth(1).getByRole('button').first().click();
  await expect(win.getByTestId('task-tab').nth(1)).toHaveAttribute('data-active', 'true');
  await expect(panel.getByTestId('task-composer').getByRole('textbox')).toHaveValue('');
  await tabs.nth(0).getByRole('button').first().click();
  await expect(panel.getByTestId('task-composer').getByRole('textbox')).toHaveValue('Черновик, который не должен пропасть');
  await panel.getByTestId('task-composer').getByRole('textbox').blur();
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-task-tabs');

  // #93 follow-up: the strip lives in the title bar, so it stays in other sections; no tab is
  // highlighted there, and a click brings the task back with the draft.
  await win.getByTestId('section-calendar').click();
  await expect(win.getByTestId('titlebar').getByTestId('task-tabs')).toBeVisible();
  await expect(tabs).toHaveCount(3);
  await expect(win.getByTestId('task-tab').and(win.locator('[data-active]'))).toHaveCount(0);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-task-tabs-calendar');
  await tabs.nth(0).getByRole('button').first().click();
  await expect(panel.getByTestId('task-composer').getByRole('textbox')).toHaveValue('Черновик, который не должен пропасть');
  await expect(win.getByTestId('task-tab').nth(0)).toHaveAttribute('data-active', 'true');
  await panel.getByTestId('task-composer').getByRole('textbox').blur();

  // #89: from the «Поиск» tab (ADR-0139) the path starts with the query; «×» returns to the same list.
  await win.getByTestId('my-tasks').click();
  await win.getByTestId('my-tasks-scope').getByRole('radio', { name: 'Поиск' }).click();
  await win.getByTestId('all-tasks-search').fill('эхо');
  await win.getByTestId('task-search-row').first().click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('panel-crumb-search')).toContainText('эхо');
  // #137: a plain open never adds a tab (here the strip keeps its three ⌘-tabs).
  await expect(tabs).toHaveCount(3);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-task-from-search');
  await panel.getByTestId('task-close').click();
  await expect(win.getByTestId('all-tasks-search')).toHaveValue('эхо');
});

/** CAL-3's panel at its lower section: the «Комментарии» tab (the default) with the composer. */
test('boards-task-comments', async ({ open, win, mock, shot }) => {
  await open();
  const cal4 = mock.boards.taskByKey('CAL-4');
  if (cal4) seedDays(mock, cal4.task.roomId); // #87: CAL-4's comments over several days (after open(): it resets the mock)
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  const section = panel.getByTestId('task-activity');
  await expect(section).toHaveAttribute('data-tab', 'comments');
  await expect(panel.locator('[data-message-id]')).toHaveCount(2);
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(shot, 'boards-task-comments');
  // ADR-0140: my comment seen by Борис — ✓✓ in the card's corner opens «Прочитали».
  const cal3 = mock.boards.taskByKey('CAL-3');
  if (cal3) {
    const c = mock.injectMessage({ roomId: cal3.task.roomId, authorId: IDS.users.anna, content: 'Проверила на macOS, эха нет.' });
    mock.markRead(IDS.users.boris, cal3.task.roomId, c.id);
  }
  const ticks = panel.locator('[data-message-id]').filter({ hasText: 'Проверила на macOS' }).getByTestId('read-ticks');
  await expect(ticks).toBeVisible();
  await ticks.scrollIntoViewIfNeeded();
  await ticks.click();
  await expect(win.getByTestId('read-by-popover').getByTestId('read-by-row')).toHaveCount(1);
  await checkpoint(shot, 'boards-task-comment-read-by');
  await win.keyboard.press('Escape');
  // #87: another task whose comments span several days: the same pills as in the chat.
  await win.getByTestId('boards-list').getByTestId('board-row').first().click(); // the board again: the panel closes
  await expect(panel).toHaveCount(0);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-4' }).getByTestId('card-title').click();
  const feed = win.getByTestId('activity-feed');
  await expect(feed.getByRole('separator').filter({ hasText: 'Вчера' }).first()).toBeVisible();
  await expect(feed.getByRole('separator').filter({ hasText: '2024' })).toHaveCount(1);
  await feed.getByText('Ок, принято').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'boards-task-comments-days', { axe: false });
});

/**
 * «История» (ADR-0091 §2): newest first, «Сегодня» / «Вчера», a bot and a rule among the actors;
 * the newest row (the description edit) opened — its word diff.
 */
test('boards-task-history', async ({ open, win, mock, shot }) => {
  mock.seedBots();
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  const section = panel.getByTestId('task-activity');
  await section.getByRole('radio', { name: 'История' }).click();
  await expect(section).toHaveAttribute('data-tab', 'history');
  const rows = section.getByTestId('history-row');
  await expect(rows.first()).toHaveAttribute('data-kind', 'description');
  await expect(section.getByTestId('history-day')).toHaveCount(2);
  await rows.first().getByTestId('history-toggle').click();
  await expect(section.getByTestId('history-diff')).toBeVisible();
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(shot, 'boards-task-history');
  // ADR-0156: through MCP — «(через бота Погода · MCP)» after a person, «(через MCP)» after a bot's
  // own change, in the history and on the comments (the panel reopened to reload both).
  mock.seedBots(); // open() reset the mock: the bots again, now known to the app by their events
  seedViaMcp(mock);
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  await section.getByRole('radio', { name: 'История' }).click();
  await expect(section.locator('[data-via-mcp]')).toHaveCount(2);
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await checkpoint(shot, 'boards-task-via-mcp');
  await section.getByRole('radio', { name: 'Комментарии' }).click();
  const viaMcp = panel.locator('[data-message-id]').filter({ hasText: 'Взял в работу' });
  await expect(panel.locator('[data-message-id] [data-via-mcp]')).toHaveCount(3);
  await viaMcp.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'boards-task-comments-via-mcp');
});

/** Board #148: a picture and pipe tables in the task's comments (a wide table scrolls inside the bubble). */
test('boards-task-comments-rich', async ({ open, win, mock, shot }) => {
  await open();
  seedRichComments(mock);
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('task-card').filter({ hasText: 'CAL-3' }).getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  await expect(panel.locator('table')).toHaveCount(2);
  const wide = panel.locator('.tableWrapper').last();
  await wide.scrollIntoViewIfNeeded();
  // The wide table scrolls itself; the page does not grow sideways.
  expect(await wide.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // axe off: light theme flags aria-labels of the panel's avatars / mention button (label-content-name-mismatch), none of this change; dark ran with it on.
  await checkpoint(shot, 'boards-task-comments-rich', { axe: false });
});

/** The list grouped by status, two rows selected: the bulk actions bar. */
test('boards-list', async ({ open, win, mock, shot }) => {
  await open();
  seedReleases(mock); // board task #101: not on the rows — the grouping and the task panel at the end
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('view-list').click();
  const rows = win.getByTestId('list-row');
  await rows.filter({ hasText: 'CAL-2' }).getByTestId('row-select').click();
  await rows.filter({ hasText: 'CAL-4' }).getByTestId('row-select').click();
  await expect(win.getByTestId('bulk-bar')).toBeVisible();
  await checkpoint(shot, 'boards-list');
  // «Архив задач» (owner 18.10): archive the two selected tasks, open the board's archive, then a task in it.
  await win.getByTestId('bulk-bar').getByRole('button', { name: 'Архивировать' }).click();
  await expect(rows.filter({ hasText: 'CAL-2' })).toHaveCount(0);
  await win.getByTestId('board-more').click();
  await win.getByTestId('board-archive-open').click();
  const archived = win.getByTestId('archive-row');
  await expect(archived).toHaveCount(2);
  await expect(win.getByTestId('archive-title')).toHaveText('Архив · 2');
  // The «в архиве» toasts (with «Отменить») stay: close them.
  while (await win.getByTestId('toast').count()) await win.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).click();
  await archived.first().hover();
  await checkpoint(shot, 'boards-archive');
  await archived.filter({ hasText: 'CAL-2' }).click();
  await expect(win.getByTestId('archived-banner')).toBeVisible();
  await checkpoint(shot, 'boards-archive-task');
  // Restore from the banner: the task leaves the archive list; the other row restores in place.
  await win.getByTestId('archived-restore').click();
  await expect(win.getByTestId('archived-banner')).toHaveCount(0);
  await win.getByTestId('panel-crumb-board').click();
  await expect(archived).toHaveCount(1);
  await archived.first().hover();
  await archived.first().getByTestId('archive-restore').click();
  await expect(win.getByTestId('archive-empty')).toBeVisible();
  await win.getByTestId('archive-back').click();
  await expect(rows.filter({ hasText: 'CAL-2' })).toHaveCount(1);
  // Board task #101: grouped by release — the newest first, «Без релиза» last; then a task's «Релиз».
  await win.getByTestId('display-menu').click();
  await win.getByTestId('group-by').selectOption('release');
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('list-group').first()).toContainText('stage · 1288');
  await expect(win.getByTestId('list-group').last()).toContainText('Без релиза');
  while (await win.getByTestId('toast').count()) await win.getByTestId('toast').first().getByRole('button', { name: 'Закрыть' }).click();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-list-release');
  await rows.filter({ hasText: 'CAL-3' }).getByText('Эхо в звонке').click();
  const panel = win.getByTestId('task-panel');
  await expect(panel.getByTestId('prop-release')).toHaveText(['stage · 1288', 'prod · 4929cf3']);
  await panel.getByTestId('prop-release').last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await checkpoint(shot, 'boards-task-release');
});

/**
 * Labels past the card width collapse into «+N» (docs/08 «Лейблы»): one row (CAL-1), two rows
 * (CAL-2), the group on CAL-4; the hover list; the same in the list view and the task panel.
 */
test('boards-labels-overflow', async ({ open, win, mock, shot }) => {
  await open();
  seedLabelOverflow(mock);
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  const card = (key: string): Locator => win.getByTestId('task-card').filter({ hasText: key });
  await expect(card('CAL-4').getByTestId('labels-more')).toBeVisible();
  await expect(card('CAL-1').getByTestId('labels-more')).toHaveCount(0);
  await expect(card('CAL-2').getByTestId('labels-more')).toHaveCount(0);
  await checkpoint(shot, 'boards-labels-card');
  await card('CAL-4').getByTestId('labels-more').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'boards-labels-card-group');
  // Hover opens the hidden labels and leaving closes them; Enter on the focused pill opens them, Esc closes.
  const more = card('CAL-4').getByTestId('labels-more');
  const list = win.getByTestId('labels-more-list');
  await more.hover();
  await expect(list).toBeVisible();
  await win.mouse.move(0, 0);
  await expect(list).toHaveCount(0);
  await more.focus();
  await win.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('label-pill')).toHaveCount(6);
  await checkpoint(shot, 'boards-labels-more', { axe: false });
  await win.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(win.getByTestId('kanban')).toBeVisible(); // the board's own Esc did not fire

  // The task panel: the labels row with the «+» after them; the group opens the same list.
  await card('CAL-4').getByTestId('card-title').click();
  const panel = win.getByTestId('task-panel');
  await expect(panel.getByTestId('prop-labels')).toBeVisible();
  await expect(panel.getByTestId('labels-more')).toBeVisible();
  await checkpoint(shot, 'boards-labels-task');
  await panel.getByTestId('labels-more').click();
  await expect(list).toBeVisible();
  await checkpoint(shot, 'boards-labels-task-more', { axe: false });
  await win.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // The list view: one row of labels, the rest in «+N».
  await win.getByTestId('view-list').click();
  await expect(win.getByTestId('list-row').filter({ hasText: 'CAL-4' }).getByTestId('labels-more')).toBeVisible();
  await checkpoint(shot, 'boards-labels-list', { axe: false });
});

/** «Фильтр» open over a filtered board: a label condition, the field list. */
test('boards-filter', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('filter-button').click();
  await win.getByTestId('filter-fields').getByRole('option', { name: 'Лейблы' }).click();
  await win.getByTestId('filter-values').getByRole('option', { name: /Фича/ }).click();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('filter-chip')).toHaveCount(1);
  await win.getByTestId('filter-button').click();
  await expect(win.getByTestId('filter-fields')).toBeVisible();
  await checkpoint(shot, 'boards-filter');
  // ADR-0139: the board's search field — the same search over this board, under the same filter.
  await win.keyboard.press('Escape');
  await win.getByTestId('board-search-open').click();
  await win.getByTestId('board-search-input').fill('доск');
  await expect(win.getByTestId('task-search-board')).toBeVisible();
  await expect(win.getByTestId('task-search-row')).toHaveCount(1);
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-search');
});

/** Board settings → «Статусы»: the development template's six statuses. */
test('boards-settings', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('board-more').click();
  await win.getByTestId('board-settings').click();
  // CBF-68: «Основное» → «Инструкция для ИИ», typed and saved. CBF-69: on Team (the fixture) it
  // is writable with the Business line under the label.
  const instr = win.getByTestId('board-ai-instruction-text');
  await expect(instr).toHaveValue('');
  await expect(win.getByTestId('board-ai-instruction-plan')).toHaveText('Умные задачи работают на тарифе Business — инструкцию можно написать заранее');
  await win.getByTestId('board-ai-instruction').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'boards-settings-ai-plan');
  mock.setPlanKind(IDS.workspaces.main, Plan.ENTERPRISE);
  await expect(win.getByTestId('board-ai-instruction-plan')).toHaveCount(0);
  await instr.fill('Заголовок — «Баг: где и что». В описании — шаги воспроизведения и ожидаемое поведение. Метка «Баг», приоритет высокий, если сломан вход.');
  // CBF-75: «Искать дубли за 2 недели» under the instruction, off by default.
  const dup = win.getByRole('switch', { name: 'Искать дубли за 2 недели' });
  await expect(dup).toHaveAttribute('aria-checked', 'false');
  await dup.click();
  await expect(dup).toHaveAttribute('aria-checked', 'true');
  await dup.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'boards-settings-ai');
  await win.getByTestId('board-ai-instruction-save').click();
  await expect(win.getByTestId('board-ai-instruction-save')).toBeDisabled();
  await win.getByRole('tab', { name: 'Статусы' }).click();
  await expect(win.getByTestId('statuses-editor').locator('[data-settings-row]')).toHaveCount(6);
  await checkpoint(shot, 'boards-settings');
  // CBF-73: an editor (EDIT_TASKS without MANAGE_BOARD) — «Настройки» opens on «Статусы» with only
  // the statuses, labels and milestones; no «Доступ» in the menu.
  await win.keyboard.press('Escape');
  const dev = [...mock.boards.boards.values()].find((r) => r.board.key === 'CAL');
  if (!dev) throw new Error('board CAL');
  mock.boards.setViewerBits(dev.board.id, IDS.users.anna, PERMISSION_BITS.VIEW_BOARD | PERMISSION_BITS.CREATE_TASKS | PERMISSION_BITS.EDIT_TASKS);
  await win.getByTestId('board-more').click();
  await expect(win.getByRole('menuitem', { name: 'Доступ' })).toHaveCount(0);
  await win.getByTestId('board-settings').click();
  await expect(win.getByRole('tablist', { name: 'Разработка' }).getByRole('tab')).toHaveText(['Статусы', 'Лейблы', 'Вехи']);
  await expect(win.getByRole('tab', { name: 'Статусы' })).toHaveAttribute('aria-selected', 'true');
  await checkpoint(shot, 'boards-settings-editor');
  mock.boards.setViewerBits(dev.board.id, IDS.users.anna, null);
  // CBF-51: «Доступ» of @Участник — without «Видеть доску» «Править любые задачи» ✓ does nothing
  // (the row says so, danger), «Создавать задачи» ✓ is create-only.
  await win.keyboard.press('Escape');
  await win.getByTestId('board-more').click();
  await win.getByTestId('board-settings').click();
  await win.getByRole('tab', { name: 'Доступ' }).click();
  await win.getByRole('radio', { name: 'Видеть доску: запрещено' }).click();
  await win.getByRole('radio', { name: 'Создавать задачи: разрешено' }).click();
  await win.getByRole('radio', { name: 'Править любые задачи: разрешено' }).click();
  await expect(win.getByTestId('board-access-needs-view')).toHaveText('Не действует без «Видеть доску»');
  await expect(win.getByTestId('board-access-create-only')).toHaveText('Создаёт и видит только свои карточки');
  // «Инструкция сохранена» from above covers the last row: closed by a DOM click (outside the modal).
  for (const b of await win.getByTestId('toast').locator('button[aria-label="Закрыть уведомление"]').all()) await b.evaluate((x) => (x as HTMLButtonElement).click());
  await expect(win.getByTestId('toast')).toHaveCount(0);
  await checkpoint(shot, 'boards-settings-access');
  // Board task #101: a Git rule — the new events, «Целевая ветка», the Git template variables.
  await win.getByRole('tab', { name: 'Автоматизации' }).click();
  await expect(win.getByTestId('rules-empty')).toBeVisible();
  await win.getByTestId('rule-add').click();
  await win.getByTestId('rule-name').fill('MR влит в main → готово');
  await win.getByTestId('rule-trigger').selectOption('git');
  const ev = win.getByTestId('rule-git-event');
  await expect(ev.locator('option')).toHaveText(['Любое событие', 'Создана ветка', 'Открыт черновик PR', 'Открыт PR', 'Черновик PR готов к ревью', 'Запрошено ревью', 'PR одобрен', 'PR смержен', 'PR закрыт без слияния', 'Новый коммит']);
  await ev.selectOption({ label: 'Новый коммит' });
  await expect(win.getByTestId('rule-git-branches')).toHaveCount(0); // a push has no target branch
  await ev.selectOption({ label: 'PR смержен' });
  await win.getByTestId('rule-git-branches').fill('main, release/*');
  await win.getByTestId('rule-action-kind').selectOption('comment');
  await expect(win.getByTestId('rule-git-vars')).toHaveText('Git: {pr_url} {pr_number} {pr_title} {branch} {target_branch} {git_author}');
  await win.getByLabel('Текст').fill('Влит MR !{pr_number}: {pr_title} → {target_branch}');
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-rules-git-vars');
  await win.getByTestId('rule-when').scrollIntoViewIfNeeded();
  await win.getByTestId('rule-name').focus();
  await checkpoint(shot, 'boards-rules-git');
  // Board task #101 stage B: «Задача вошла в релиз» (prod by default) with the status condition of
  // DEV's «Ready to Deploy → Deployed»; {release} under the template.
  await win.getByTestId('rule-name').fill('Вошла в релиз prod → готово');
  await win.getByTestId('rule-trigger').selectOption('release');
  await expect(win.getByTestId('rule-release-envs')).toHaveValue('prod');
  await win.getByTestId('rule-release-envs').fill('prod, stage');
  await expect(win.getByTestId('rule-release-vars')).toHaveText('Релиз: {release}');
  await win.getByLabel('Текст').fill('Выкачено в {release}');
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.getByTestId('rule-when').scrollIntoViewIfNeeded();
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-rules-release');
  await win.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  // The GitLab backlink: off by default, the title-visibility help, the address and a write-only token.
  await win.getByRole('tab', { name: 'Git' }).click();
  await win.getByTestId('git-provider').selectOption({ label: 'GitLab' });
  await win.getByTestId('git-save').click();
  const backlink = win.getByTestId('git-backlink');
  await expect(backlink.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await backlink.getByRole('switch').click();
  await expect(win.getByTestId('git-backlink-error')).toHaveText('Заметки не пишутся: нет токена API.');
  await win.getByTestId('git-backlink-url').fill('https://git.example.com');
  await win.getByTestId('git-backlink-token').fill('glpat-0123456789abcdefghij');
  await win.getByTestId('git-backlink-save').click();
  await expect(win.getByTestId('git-backlink-error')).toHaveCount(0);
  await expect(win.getByTestId('git-backlink-forget')).toBeVisible();
  await backlink.scrollIntoViewIfNeeded();
  await win.mouse.move(0, 0);
  await checkpoint(shot, 'boards-settings-backlink');
});

/** Board settings → «Статусы», the colour picker of the first status open (ADR-0093): a 6-wide grid over the rows. */
test('boards-settings-color', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('board-more').click();
  await win.getByTestId('board-settings').click();
  await win.getByRole('tab', { name: 'Статусы' }).click();
  await win.getByTestId('statuses-editor').locator('[data-settings-row]').first().getByRole('button', { name: /^Цвет/ }).click();
  const grid = win.getByTestId('status-color-picker');
  await expect(grid.getByRole('radio')).toHaveCount(12);
  await expect(grid.getByRole('radio', { name: 'Серый', exact: true })).toBeFocused();
  await checkpoint(shot, 'boards-settings-color');
});

/** Board settings → «Статусы»: «Три четверти» picked for Backlog, the icon grid reopened (ADR-0093). */
test('boards-settings-icon', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('board-more').click();
  await win.getByTestId('board-settings').click();
  await win.getByRole('tab', { name: 'Статусы' }).click();
  const row = win.getByTestId('statuses-editor').locator('[data-settings-row]').first();
  await row.getByRole('button', { name: /^Иконка/ }).click();
  const grid = win.getByTestId('status-icon-picker');
  await expect(grid.getByRole('radio')).toHaveCount(19);
  await grid.getByRole('radio', { name: 'Три четверти' }).click();
  await expect(row.locator('[data-status-icon="three-quarters"]')).toBeVisible();
  await row.getByRole('button', { name: /^Иконка/ }).click();
  await expect(grid.getByRole('radio', { name: 'Три четверти' })).toHaveAttribute('aria-checked', 'true');
  await checkpoint(shot, 'boards-settings-icon');
});

/** Board settings, the features tab (owner 07.10): every optional feature has a switch, 16 in all. */
test('boards-features', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.getByTestId('board-more').click();
  await win.getByTestId('board-settings').click();
  await win.getByRole('tab', { name: 'Фичи' }).click();
  await expect(win.getByTestId('board-features').getByRole('switch')).toHaveCount(16);
  await checkpoint(shot, 'boards-features');
  // CBF-156 (ADR-0160): «Согласование держит переходы» in the approvals card, on by default; off,
  // a task waiting for approval moves to any status — no disabled rows in its status menu.
  const gate = win.getByRole('switch', { name: 'Согласование держит переходы' });
  await gate.scrollIntoViewIfNeeded();
  await expect(gate).toBeChecked();
  await checkpoint(shot, 'boards-features-approval-gate');
  await gate.click();
  await expect(gate).not.toBeChecked();
  await checkpoint(shot, 'boards-features-approval-gate-off');
  await win.keyboard.press('Escape');
  await win.getByTestId('task-card').filter({ hasText: 'Ревью: права досок' }).getByTestId('card-status').click();
  const statusMenu = win.getByTestId('status-menu');
  await expect(statusMenu.getByTestId('picker-option').first()).toBeVisible();
  await expect(statusMenu).not.toContainText('нужно согласование');
  await expect(statusMenu.locator('[data-testid="picker-option"][aria-disabled="true"]')).toHaveCount(0);
  await checkpoint(shot, 'boards-status-menu-gate-off', { axe: false });
  await win.keyboard.press('Escape');
});

/** Create-task dialog (owner 07.10): the start date next to the due date. */
test('boards-create', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.keyboard.press('c');
  await expect(win.getByTestId('create-task')).toBeVisible();
  await win.getByTestId('create-task-title').fill('Задача с датой начала');
  await win.getByTestId('create-start').click();
  await win.getByRole('button', { name: /Сегодня/ }).first().click();
  await expect(win.getByTestId('create-start')).not.toContainText('Начало');
  await checkpoint(shot, 'boards-create');

  // Owner 23.10: the description is the wiki's editor here too (compact); `/` opens the blocks
  // inside the sheet, Esc closes the list, not the sheet.
  const desc = win.getByTestId('create-task').locator('.wiki-prose');
  await desc.click();
  await win.keyboard.type('Шаги:');
  await win.keyboard.press('Enter');
  await win.keyboard.type('- воспроизвести');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  await win.keyboard.type('/');
  const blocks = win.getByRole('listbox', { name: 'Блоки' });
  await expect(blocks).toBeVisible();
  await checkpoint(shot, 'boards-create-desc');
  await win.keyboard.press('Escape');
  await expect(blocks).toHaveCount(0);
  await expect(win.getByTestId('create-task')).toBeVisible();
});

/** The timeline (3), month scale: today line, weekends, CAL-3 → CAL-4 late-blocker marker, «Без дат». */
test('boards-timeline', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await boardsMode(win, mock);
  await win.keyboard.press('3');
  const tl = win.getByTestId('timeline');
  await expect(tl.getByTestId('timeline-row')).toHaveCount(4);
  await expect(tl.locator('[data-testid=timeline-row]').filter({ hasText: 'CAL-4' }).getByTestId('bar-blocked')).toBeVisible();
  await expect(tl.getByTestId('timeline-today-line')).toBeVisible();
  await checkpoint(shot, 'boards-timeline');
});

/** A /t/CAL-3 link in chat: the task card (key, title, status, assignees, overdue due date). */
test('chat-task-card', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.setClock(NOW.getTime());
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: 'Кто возьмёт? https://calab.test/t/CAL-3' });
  const card = win.getByTestId('task-link-card');
  await expect(card).toContainText('CAL-3');
  await expect(card).toContainText('В работе');
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(win);
  await checkpoint(shot, 'chat-task-card');
});


test('chat-inline-buttons', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  seedInlineButtons(mock);
  await expect(win.getByTestId('inline-keyboard')).toBeVisible();
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(win);
  await checkpoint(shot, 'chat-inline-buttons');
});
