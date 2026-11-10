import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { AnnotKind, AnnotMessageSchema, type AnnotMessage } from '@calaba/protocol';
import type { Page } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';
import { startPublisher, type Publisher } from './publisher';

/**
 * Stream UX (docs/09 #17, #18): the source picker with one screen and my own stream on the stage.
 * Project `stream-dark-960` (playwright.visual.config.ts); run one screen with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=40070 MOCK_LIVEKIT_ROOM_PREFIX=str_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "stream-picker-screen|voice-stream-self"
 *
 * Annotations (ADR-0028): -g "stream-annotate" — the viewer's pen and «Очистить» reach the
 * presenter, the presenter's pointer and stroke show on the stage (the shot); the presenter's
 * side (-g "stream-annotate-presenter") — viewers' pointers on my own stream, «X указывает» in my
 * stream's panel (the shot) and the switch.
 */

test.describe.configure({ mode: 'parallel' });

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** «общий» at the bottom, then «Переговорка» (dev LiveKit), muted, signal bars steady. */
async function inVoice(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().hover();
  await page.getByRole('button', { name: 'Войти в голос «Переговорка»' }).click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await settle(page);
}

/** The picker with one synthetic screen: one large centred card, «Весь экран» selected. */
async function openPicker(page: Page, oneScreen: boolean): Promise<void> {
  await page.evaluate((one) => {
    (window as unknown as { __calabaVisualOneScreen?: boolean }).__calabaVisualOneScreen = one;
  }, oneScreen);
  await page.getByRole('button', { name: 'Показать экран' }).first().click();
  await expect(page.getByTestId('stream-source').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Весь экран' })).toHaveAttribute('aria-checked', 'true');
}

test('stream-picker-screen', async ({ open, win, shot }) => {
  await open();
  await inVoice(win);
  await openPicker(win, true);
  const picker = win.getByTestId('stream-picker');
  await expect(picker.locator('[data-layout="single"]')).toBeVisible();
  await expect(picker.getByTestId('stream-source')).toHaveCount(1);
  // Sharp: the thumbnail is drawn at its natural size (fetched for this box × devicePixelRatio).
  const img = picker.getByTestId('stream-source').locator('img').first();
  await expect
    .poll(() =>
      img.evaluate((el: HTMLImageElement) => {
        const r = el.getBoundingClientRect();
        return Math.abs(el.naturalWidth / devicePixelRatio - r.width) <= 1;
      }),
    )
    .toBe(true);
  // The selected card's ring stays inside the card (inset).
  await expect(picker.getByTestId('stream-source').first()).toHaveCSS('box-shadow', /inset/);
  await checkpoint(shot, 'stream-picker-screen');
});

test('voice-stream-self', async ({ open, win, shot }) => {
  await open();
  await inVoice(win);
  await openPicker(win, true);
  await win.getByRole('button', { name: 'Начать стрим' }).click();
  // My own stream shows up like anyone's (docs/09 #18a): on the stage or in the PiP, «Вы стримите».
  const video = win.getByTestId('stream-stage').or(win.getByTestId('stream-pip'));
  await expect(video.first()).toBeVisible({ timeout: 30_000 });
  if ((await win.getByTestId('stream-stage').count()) === 0) {
    await win.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
  }
  await expect(win.getByTestId('stream-stage')).toBeVisible();
  await expect(win.getByTestId('stream-stage').getByTestId('stream-self-badge')).toHaveText('Вы стримите');
  // The captured page (a synthetic source) changes every run: hide the pixels, keep the chrome.
  await win.addStyleTag({ content: 'video { visibility: hidden !important; }' });
  try {
    await checkpoint(shot, 'voice-stream-self');
    // «На весь экран»: the video-only layout (the window's native full screen is not photographed).
    await win.getByTestId('stream-controls').getByRole('button', { name: 'На весь экран' }).focus();
    await win.getByTestId('stream-controls').getByRole('button', { name: 'На весь экран' }).click();
    await expect(win.getByTestId('stream-fullscreen')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('stream-fullscreen')).toHaveCount(0);
  } finally {
    // The voice panel's share button (VoiceBar, «Остановить показ»).
    await win.getByRole('button', { name: 'Остановить показ' }).first().click().catch(() => undefined);
  }
  await expect(win.getByTestId('stream-stage').or(win.getByTestId('stream-pip'))).toHaveCount(0, { timeout: 15_000 });
});

// ---------------------------------------------------------------- annotations (ADR-0028)

/** Annotation packets a LiveKit participant received, decoded. */
async function annotsOf(p: Publisher): Promise<AnnotMessage[]> {
  return (await p.received()).filter((d) => d.topic === 'annot').map((d) => fromBinary(AnnotMessageSchema, new Uint8Array(d.data)));
}

/**
 * Anything drawn on the annotation canvas of `view` at frame point (fx, fy)? Reads the canvas
 * pixel (the frame box is letterbox-aware, like the layer itself).
 */
async function inkAt(page: Page, view: string, fx: number, fy: number): Promise<boolean> {
  return page.locator(`[data-testid="${view}"] [data-testid="annot-layer"]`).evaluate(
    (c: HTMLCanvasElement, [fx, fy]) => {
      const v = c.parentElement?.querySelector('video');
      const vw = v?.videoWidth || c.clientWidth;
      const vh = v?.videoHeight || c.clientHeight;
      const k = Math.min(c.clientWidth / vw, c.clientHeight / vh);
      const x = (c.clientWidth - vw * k) / 2 + fx * vw * k;
      const y = (c.clientHeight - vh * k) / 2 + fy * vh * k;
      const dpr = c.width / Math.max(1, c.clientWidth);
      const px = c.getContext('2d')?.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return (px?.[3] ?? 0) > 0;
    },
    [fx, fy] as const,
  );
}

/** Sends annotations as a LiveKit participant would, with a growing seq. */
interface AnnotInit {
  streamSid: string;
  kind: AnnotKind;
  points?: number[];
  color?: number;
  strokeId?: number;
}

function annotSender(p: Publisher): (m: AnnotInit) => Promise<void> {
  let seq = 0;
  return (m) => p.send(toBinary(AnnotMessageSchema, create(AnnotMessageSchema, { color: 0x30d158, ...m, seq: ++seq })), 'annot');
}

test('stream-annotate', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win);
  // Вера streams (and, as the presenter, points and draws); I watch on the stage.
  const vera = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.meeting, data: true });
  let ping: NodeJS.Timeout | null = null;
  try {
    const stage = win.getByTestId('stream-stage');
    const pip = win.getByTestId('stream-pip');
    await expect(stage.or(pip).first()).toBeVisible({ timeout: 30_000 });
    if ((await stage.count()) === 0) await pip.getByRole('button', { name: 'Развернуть' }).first().click();
    await expect(stage).toBeVisible();
    await expect.poll(() => stage.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await win.addStyleTag({ content: 'video { visibility: hidden !important; }' });
    const sid = await vera.trackSid();
    expect(sid).not.toBe('');

    // Pen: a stroke across the frame is drawn here and reaches the presenter.
    await stage.hover();
    await stage.getByTestId('annot-tools').getByRole('button', { name: 'Карандаш' }).click();
    const layer = stage.getByTestId('annot-layer');
    await expect(layer).toHaveAttribute('data-tool', 'pen');
    const box = await layer.boundingBox();
    if (!box) throw new Error('no annotation layer');
    await win.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await win.mouse.down();
    for (let i = 1; i <= 12; i++) await win.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * 0.6, { steps: 2 });
    await win.mouse.up();
    await expect.poll(async () => (await annotsOf(vera)).some((m) => m.kind === AnnotKind.STROKE && m.strokeEnd && m.streamSid === sid), { timeout: 10_000 }).toBe(true);
    const strokes = (await annotsOf(vera)).filter((m) => m.kind === AnnotKind.STROKE);
    expect(strokes.flatMap((m) => m.points).every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(new Set(strokes.map((m) => m.strokeId)).size).toBe(1);
    // Drawn here too, where the presenter got it (frame coordinates, letterbox-aware).
    const pts = strokes.flatMap((m) => m.points);
    const mid = Math.floor(pts.length / 4) * 2;
    const [mx, my] = [pts[mid] ?? -1, pts[mid + 1] ?? -1];
    expect(await inkAt(win, 'stream-stage', mx, my)).toBe(true);

    // «Очистить»: my strokes go here and for everyone.
    await stage.getByTestId('annot-tools').getByRole('button', { name: 'Очистить' }).click();
    await expect.poll(async () => (await annotsOf(vera)).some((m) => m.kind === AnnotKind.CLEAR && m.streamSid === sid)).toBe(true);
    await expect.poll(() => inkAt(win, 'stream-stage', mx, my)).toBe(false);

    // The presenter points and draws; kept alive (pointer 1 s, stroke 5 s) for a steady shot:
    // the pointer repeats its position, the stroke its last point.
    const send = annotSender(vera);
    const path = [0.18, 0.3, 0.3, 0.22, 0.42, 0.3, 0.54, 0.22];
    await send({ streamSid: sid, kind: AnnotKind.STROKE, points: path, strokeId: 7 });
    const tick = (): void => {
      void send({ streamSid: sid, kind: AnnotKind.POINTER, points: [0.7, 0.45], color: 0xff453a }).catch(() => undefined);
      void send({ streamSid: sid, kind: AnnotKind.STROKE, points: path.slice(-2), strokeId: 7 }).catch(() => undefined);
    };
    tick();
    ping = setInterval(tick, 150);
    await expect.poll(() => inkAt(win, 'stream-stage', 0.7, 0.45)).toBe(true);
    await expect.poll(() => inkAt(win, 'stream-stage', 0.3, 0.22)).toBe(true);
    await checkpoint(shot, 'stream-annotate');

    // Issue #110 setup: one message read (the chat shows once collapsed), so the reopened room has a read marker.
    mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.vera, content: 'Начинаем' });
    // CBF-67: with another chat selected, the LIVE row opens the room and the stream on the stage.
    await stage.getByRole('button', { name: 'Свернуть' }).first().click();
    await expect(stage).toHaveCount(0);
    await win.locator('aside').getByRole('button', { name: /общий/ }).first().click();
    await expect(win.getByRole('heading', { name: 'общий' })).toBeVisible();
    await win.locator('aside').getByRole('listitem', { name: /Вера Ким/ }).first().click();
    await expect(win.getByRole('heading', { name: 'Переговорка', exact: true })).toBeVisible();
    await expect(stage).toBeVisible();
    await checkpoint(shot, 'stream-live-other-chat');

    // Issue #110: a message in this room while the stage hides the feed. The blue banner sits
    // below the streamer chip / «Chat» row (no overlap) and its text opens the chat like «Чат».
    mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.vera, content: 'Видно слайд?' });
    const banner = win.getByTestId('unread-banner');
    await expect(banner).toBeVisible();
    const chatBtn = stage.getByRole('button', { name: /^Чат/ });
    const [bb, cb] = [await banner.boundingBox(), await chatBtn.boundingBox()];
    if (!bb || !cb) throw new Error('banner / Chat button not laid out');
    expect(bb.y).toBeGreaterThanOrEqual(cb.y + cb.height);
    await checkpoint(shot, 'stream-new-message-banner');
    await banner.getByRole('button', { name: /новое сообщение/ }).click();
    await expect(stage).toHaveCount(0);
    await expect(win.getByTestId('stream-pip')).toBeVisible();
    await expect(win.getByTestId('unread-banner')).toHaveCount(0);
    await checkpoint(shot, 'stream-new-message-chat-open');
    await win.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
    await expect(stage).toBeVisible();
  } finally {
    if (ping) clearInterval(ping);
    await vera.stop();
  }
});

// CBF-172: the sharing speaker mutes / unmutes — the LIVE chip (and the camera / icons next to it)
// must not move: the same bounding boxes with the mic crossed out and without.
test('stream-live-chip-mic', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win);
  const vera = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.meeting });
  try {
    const row = win.locator('aside').getByRole('listitem', { name: /Вера Ким/ }).first();
    const chip = row.getByText('LIVE', { exact: true });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await win.addStyleTag({ content: 'video { visibility: hidden !important; }' });
    const setMuted = async (muted: boolean): Promise<void> => {
      mock.setVoiceState({ userId: IDS.users.vera, roomId: IDS.rooms.meeting, muted });
      if (muted) await expect(row.getByRole('img', { name: 'Микрофон выключен' })).toBeVisible();
      else await expect(row.getByRole('img', { name: 'Микрофон выключен' })).toHaveCount(0);
      await settle(win);
    };
    await setMuted(false);
    const open0 = await chip.boundingBox();
    const name0 = await row.getByTestId('speaker-name').boundingBox();
    await checkpoint(shot, 'stream-live-chip-unmuted', { axe: false });
    await setMuted(true);
    const open1 = await chip.boundingBox();
    const name1 = await row.getByTestId('speaker-name').boundingBox();
    await checkpoint(shot, 'stream-live-chip-muted', { axe: false });
    const mic = await row.getByRole('img', { name: 'Микрофон выключен' }).boundingBox();
    const rb = await row.boundingBox();
    expect(open0).not.toBeNull();
    expect(open1).toEqual(open0);
    expect(name1?.x).toBe(name0?.x);
    // The crossed mic sits right of LIVE, inside the row.
    expect(mic?.x ?? 0).toBeGreaterThanOrEqual((open1?.x ?? 0) + (open1?.width ?? 0));
    expect((mic?.x ?? 0) + (mic?.width ?? 0)).toBeLessThanOrEqual((rb?.x ?? 0) + (rb?.width ?? 0));
  } finally {
    await vera.stop();
  }
});

test('stream-annotate-presenter', async ({ open, win, shot }) => {
  await open();
  await inVoice(win);
  await openPicker(win, true);
  await win.getByRole('button', { name: 'Начать стрим' }).click();
  const video = win.getByTestId('stream-stage').or(win.getByTestId('stream-pip'));
  await expect(video.first()).toBeVisible({ timeout: 30_000 });
  if ((await win.getByTestId('stream-stage').count()) === 0) await win.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
  // Борис watches my stream and points at it (a member with SPEAK).
  const boris = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.meeting, source: 'none', data: true });
  let ping: NodeJS.Timeout | null = null;
  try {
    await expect.poll(() => boris.remoteScreenSid(), { timeout: 30_000 }).not.toBe('');
    const sid = await boris.remoteScreenSid();
    const send = annotSender(boris);
    // No tools on my own stream; the viewers' pointer shows on my self-preview (the overlay over
    // the real screen is off in visual tests: synthetic source).
    await expect(win.getByTestId('stream-stage').getByTestId('annot-tools')).toHaveCount(0);
    await expect
      .poll(async () => {
        await send({ streamSid: sid, kind: AnnotKind.POINTER, points: [0.5, 0.5] });
        return inkAt(win, 'stream-stage', 0.5, 0.5);
      }, { timeout: 10_000 })
      .toBe(true);
    // Issue #102: the panel says who points and, with no overlay here (visual tests), offers the
    // preview; kept alive for a steady shot. The hint under the switch comes back when quiet.
    const status = win.getByTestId('my-stream-annot-status');
    ping = setInterval(() => void send({ streamSid: sid, kind: AnnotKind.POINTER, points: [0.5, 0.5] }).catch(() => undefined), 300);
    await expect(status).toContainText('указывает на экран');
    await expect(status.getByRole('button', { name: 'Показать' })).toBeVisible();
    await checkpoint(shot, 'stream-annotate-presenter');
    clearInterval(ping);
    ping = null;
    await expect(status).toHaveText('Рисунки видны в превью вашего стрима', { timeout: 10_000 });
    // Not a live stream / malformed: ignored.
    await send({ streamSid: 'TR_gone', kind: AnnotKind.POINTER, points: [0.2, 0.2] });
    // The switch in my stream's panel: off → Борис is told, his pointer is ignored.
    const toggle = win.getByTestId('my-stream-annot').getByRole('switch', { name: 'Зрители могут рисовать' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect.poll(async () => (await annotsOf(boris)).some((m) => m.kind === AnnotKind.POLICY && !m.allow && m.streamSid === sid)).toBe(true);
    await expect.poll(() => inkAt(win, 'stream-stage', 0.5, 0.5), { timeout: 5_000 }).toBe(false);
    for (let i = 0; i < 5; i++) await send({ streamSid: sid, kind: AnnotKind.POINTER, points: [0.25, 0.25] });
    await win.waitForTimeout(500);
    expect(await inkAt(win, 'stream-stage', 0.25, 0.25)).toBe(false);
    await toggle.click();
    await expect.poll(async () => (await annotsOf(boris)).some((m) => m.kind === AnnotKind.POLICY && m.allow)).toBe(true);
  } finally {
    if (ping) clearInterval(ping);
    await boris.stop();
    await win.getByRole('button', { name: 'Остановить показ' }).first().click().catch(() => undefined);
  }
});
