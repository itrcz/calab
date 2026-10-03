import type { LocalVideoTrack } from 'livekit-client';
import { isWeb } from '../platform';
import { log } from '../lib/log';
import { isMobileNow } from '../lib/mobile';
import { cameraSource } from '../lib/media/camera';
import type { BackgroundProcessor } from '../lib/media/background';
import { loadBackgroundBitmap } from '../lib/media/background/images';
import { DEFAULT_CAMERA_EFFECTS, NO_WORKER_EFFECTS, effectsActive, workerEffects, type CameraEffects } from '../lib/media/background/effects';
import {
  BACKGROUND_PROCESSOR,
  NO_BACKGROUND,
  backgroundPath,
  backgroundUnavailable,
  failureFallback,
  failureKind,
  failureStopsEffects,
  hasHardwareBlur,
  normalizeSegFps,
  staleWorkspaceChoice,
  type BackgroundEnv,
  type BgFailure,
  type BgUnavailable,
  type CameraBackground,
} from '../lib/media/background/logic';
import type { MessageKey } from '../i18n';
import { usePrefs } from '../stores/prefs';
import { setCameraBg, useCameraBg } from '../stores/cameraBg';
import { toast } from '../stores/toasts';
import { t } from '../i18n';
import type { BackgroundStatus } from '../lib/media/background';
import { findBackground } from '../stores/workspaces';

/**
 * Applies the camera background (ADR-0035) and the appearance effects (its addendum) to a camera
 * track — the preview's or the published one:
 *   off      → no processor, the camera's own blur off;
 *   hardware → `backgroundBlur: true` on the capture (Windows Studio Effects), no processor;
 *   pipeline → our processor (lazy chunk lib/media/background), its mode switched in place.
 * «Улучшить внешность» / «Низкая освещённость» always run in our processor (no system API does
 * touch-up), with the background «Нет» or the system blur too. No background and no effect: no
 * processor at all — the camera passes untouched.
 * Calls are serialized: quick clicks in the picker apply in order, the last one wins.
 */

/** «Слабый компьютер» (docs/09 #44) is not built yet: when it is, it returns its switch here. */
function lowEndMode(): boolean {
  return false;
}

let webgl2Probe: boolean | null = null;

/**
 * A real WebGL2 context on an OffscreenCanvas — what the worker needs — probed once per session
 * (the constructors exist even where the GPU is blocklisted and no context can be made).
 */
function probeWebgl2(): boolean {
  if (webgl2Probe !== null) return webgl2Probe;
  try {
    const gl = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('webgl2') : null;
    webgl2Probe = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2Probe = false;
  }
  if (!webgl2Probe) log.warn('camera background: no WebGL2 on OffscreenCanvas, the section is disabled');
  return webgl2Probe;
}

export function backgroundEnv(): BackgroundEnv {
  const w = globalThis as unknown as Record<string, unknown>;
  const breakoutBox = typeof w['MediaStreamTrackProcessor'] === 'function' && typeof w['MediaStreamTrackGenerator'] === 'function' && typeof w['VideoFrame'] === 'function';
  const mobile = isWeb && (isMobileNow() || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
  return { breakoutBox, mobile, lowEnd: lowEndMode(), webgl2: breakoutBox && !mobile && probeWebgl2() };
}

/** Why «Фон» cannot be chosen now (null = it can): checked before the choice, never hidden. */
export function backgroundBlocked(failure: BgFailure | null = useCameraBg.getState().failure): BgUnavailable | null {
  return backgroundUnavailable({ ...backgroundEnv(), failed: failure !== null });
}

/** The same for «Внешний вид»: a model failure leaves the effects working. */
export function effectsBlocked(failure: BgFailure | null = useCameraBg.getState().failure): BgUnavailable | null {
  return backgroundUnavailable({ ...backgroundEnv(), failed: failure !== null && failureStopsEffects(failure) });
}

/** The «Фон» choice can be made on this device now. */
export function backgroundAvailable(): boolean {
  return backgroundBlocked() === null;
}

const FAILURE_TEXT: Record<BgFailure, MessageKey> = {
  webgl: 'video.bg.reason.webgl',
  worker: 'video.bg.reason.worker',
  effects: 'video.bg.reason.worker',
  model: 'video.bg.reason.model',
  frames: 'video.bg.reason.frames',
};

/** The disabled section's explanation (docs/08: disabled with a hint). */
export function blockedText(reason: BgUnavailable, failure: BgFailure | null): string {
  switch (reason) {
    case 'browser':
      return t('video.bg.unavailableBrowser');
    case 'mobile':
      return t('video.bg.unavailableMobile');
    case 'lowEnd':
      return t('video.bg.unavailableLowEnd');
    case 'webgl':
      return t('video.bg.unavailableReason', { reason: t('video.bg.reason.webgl') });
    case 'failed':
      return t('video.bg.unavailableReason', { reason: t(FAILURE_TEXT[failure ?? 'model']) });
  }
}

/**
 * A chosen workspace background that is gone — deleted by an admin (BACKGROUND_DELETE), the
 * workspace left or deleted, missing after a reload (READY) — falls back to «Нет» (ADR-0035
 * addendum); the live camera follows the preference.
 */
export function dropStaleWorkspaceBackground(): void {
  const bg = usePrefs.getState().cameraBackground;
  if (staleWorkspaceChoice(bg, (id) => !!findBackground(id))) usePrefs.getState().setPrefs({ cameraBackground: NO_BACKGROUND });
}

let chain: Promise<void> = Promise.resolve();
/** «Фон недоступен» is toasted once per run of the app (the preview also shows it as a hint). */
let failureToasted = false;

/**
 * The processor's state → the UI store, and every transition with its reason → the app log:
 * a background that cannot run must never fail silently (2.0.x on Windows did).
 */
function onStatus(s: BackgroundStatus): void {
  if (s.state === 'failed') {
    onFailure(failureKind(s.detail), s.detail ?? 'no detail');
    return;
  }
  if (s.state === 'ready' && s.detail) log.info('camera background ready', s.detail);
  setCameraBg({ state: s.state, software: s.software });
}

/**
 * A runtime failure (owner, 2.1: never «selected but not shown»): logged with its reason, the
 * section disabled for this run, the choice reset — prefs follow to every camera (preview, live),
 * which then goes on plain — and one toast with the reason.
 */
export function onFailure(kind: BgFailure, detail: string): void {
  log.warn('camera background failed, falling back to the plain camera', { kind, detail });
  setCameraBg({ state: 'failed', software: false, failure: kind });
  const p = usePrefs.getState();
  const reset = failureFallback(kind, p.cameraBackground, p.cameraEffects);
  if (reset) p.setPrefs(reset);
  if (!failureToasted) {
    failureToasted = true;
    toast.info(t('video.bg.fellBack', { reason: t(FAILURE_TEXT[kind]) }));
  }
}

export function applyCameraBackground(track: LocalVideoTrack, bg: CameraBackground, fx: CameraEffects = DEFAULT_CAMERA_EFFECTS): Promise<void> {
  chain = chain.then(
    () => apply(track, bg, fx),
    () => apply(track, bg, fx),
  );
  return chain.catch((err: unknown) => log.warn('camera background failed', err));
}

async function apply(track: LocalVideoTrack, bg: CameraBackground, fx: CameraEffects): Promise<void> {
  const src = cameraSource(track);
  if (src.readyState === 'ended') return;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  const hw = hasHardwareBlur(md?.getSupportedConstraints() as Record<string, unknown> | undefined, src.getCapabilities() as Record<string, unknown> | undefined);
  const supported = backgroundBlocked() === null;
  const path = backgroundPath(bg, { supported, hardwareBlur: hw });
  if (hw) await src.applyConstraints({ backgroundBlur: path === 'hardware' }).catch((e: unknown) => log.warn('backgroundBlur constraint failed', e));
  const effects = effectsBlocked() === null && effectsActive(fx) ? workerEffects(fx) : null;
  const current = track.getProcessor();
  const ours = current?.name === BACKGROUND_PROCESSOR ? (current as BackgroundProcessor) : null;
  const stop = async (): Promise<void> => {
    if (ours) await track.stopProcessor(false);
    setCameraBg({ state: 'idle', software: false, hardware: path === 'hardware' });
  };
  let kind = path === 'pipeline' ? bg.kind : 'none';
  if (kind === 'none' && !effects) return stop();
  const fps = normalizeSegFps(usePrefs.getState().cameraBgFps);
  ours?.setSegFps(fps);
  const picture = kind === 'image' ? (bg.imageId ?? null) : null;
  const fxOut = effects ?? NO_WORKER_EFFECTS;
  // Only the effects changed (a slider drag): nothing to reload.
  if (ours && ours.currentMode === kind && ours.currentPicture === picture) {
    ours.setEffects(fxOut);
    setCameraBg({ hardware: path === 'hardware' });
    return;
  }
  let image = kind === 'image' ? await loadBackgroundBitmap(bg.imageId, (id) => findBackground(id)?.fileId) : null;
  if (kind === 'image' && !image) {
    // The picture is gone (removed upload, a replaced built-in set): the raw camera (with the effects).
    if (!effects) return stop();
    kind = 'none';
    image = null;
  }
  setCameraBg({ hardware: path === 'hardware' });
  if (ours) {
    ours.setMode(kind, image, picture);
    ours.setEffects(fxOut);
    if (kind === 'none') setCameraBg({ state: 'ready', software: false });
    return;
  }
  const { createBackgroundProcessor } = await import('../lib/media/background');
  // The preview may have closed meanwhile (its capture stopped).
  if ((src.readyState as MediaStreamTrackState) === 'ended') {
    image?.close();
    return;
  }
  // The appearance effects need no model: nothing to wait for («Загружаем фон…» only for a background).
  setCameraBg({ state: kind === 'none' ? 'ready' : 'loading', software: false });
  const processor = createBackgroundProcessor(kind, image, fxOut, onStatus, picture);
  processor.segFps = fps;
  await track.setProcessor(processor, true);
}
