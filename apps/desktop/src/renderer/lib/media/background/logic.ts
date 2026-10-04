/**
 * Camera background (ADR-0035): the pure decisions, unit-tested (logic.test.ts). No DOM, no GL —
 * shared by the main thread (path choice, uploads) and the worker (scheduling, mask smoothing).
 */

export type BackgroundKind = 'none' | 'blur-light' | 'blur-strong' | 'image';

/**
 * prefs.cameraBackground: `imageId` is a built-in id (manifest.json), `custom:<id>` (IndexedDB) or
 * `ws:<background id>` (a workspace's background, ADR-0035 addendum).
 */
export interface CameraBackground {
  kind: BackgroundKind;
  imageId?: string;
}

export const NO_BACKGROUND: CameraBackground = { kind: 'none' };

/** `TrackProcessor.name` of ours (checked without loading the lazy chunk). */
export const BACKGROUND_PROCESSOR = 'calab-background';

/** Custom pictures live in IndexedDB under this id prefix. */
export const CUSTOM_PREFIX = 'custom:';
export const isCustomImage = (id: string | undefined): boolean => !!id && id.startsWith(CUSTOM_PREFIX);

/** A workspace's background (the server's list, by its id). */
export const WORKSPACE_PREFIX = 'ws:';
export const isWorkspaceImage = (id: string | undefined): boolean => !!id && id.startsWith(WORKSPACE_PREFIX);
export const workspaceImageId = (backgroundId: string): string => `${WORKSPACE_PREFIX}${backgroundId}`;
/** The background id of a `ws:` choice ('' for any other). */
export const workspaceBackgroundOf = (id: string | undefined): string => (id?.startsWith(WORKSPACE_PREFIX) ? id.slice(WORKSPACE_PREFIX.length) : '');

/**
 * Whether a choice points at a workspace background that is gone (deleted by an admin, the
 * workspace left): it then falls back to none. `exists` looks the id up in the workspaces store.
 */
export function staleWorkspaceChoice(bg: CameraBackground, exists: (backgroundId: string) => boolean): boolean {
  return bg.kind === 'image' && isWorkspaceImage(bg.imageId) && !exists(workspaceBackgroundOf(bg.imageId));
}

// ------------------------------------------------------------------ path (ADR §3, §5)

/** What the runtime offers; `breakoutBox` = MediaStreamTrackProcessor + MediaStreamTrackGenerator. */
export interface BackgroundEnv {
  breakoutBox: boolean;
  webgl2: boolean;
  /** Phone / tablet web: hidden (CPU and battery). */
  mobile: boolean;
  /** «Слабый компьютер» (docs/09 #44): the effect is off and the choice hidden. */
  lowEnd: boolean;
}

/**
 * Why «Фон» cannot be chosen here (null = it can). Owner, 2.1: a background is never «selected but
 * not shown» — the section stays visible but disabled with this reason, checked BEFORE a choice:
 *   browser — Safari / Firefox (no MediaStreamTrackProcessor / Generator, VideoFrame);
 *   mobile  — phone or tablet web (CPU and battery);
 *   lowEnd  — «Слабый компьютер» (docs/09 #44);
 *   webgl   — no WebGL2 context on an OffscreenCanvas (probed once per session, not guessed);
 *   failed  — the pipeline already failed in this session (model, worker, frames): see `failure`.
 */
export type BgUnavailable = 'browser' | 'mobile' | 'lowEnd' | 'webgl' | 'failed';

export function backgroundUnavailable(env: BackgroundEnv & { failed?: boolean }): BgUnavailable | null {
  if (env.mobile) return 'mobile';
  if (!env.breakoutBox) return 'browser';
  if (env.lowEnd) return 'lowEnd';
  if (!env.webgl2) return 'webgl';
  if (env.failed) return 'failed';
  return null;
}

/** The choice can be applied (no reason against it). */
export function backgroundSupported(env: BackgroundEnv & { failed?: boolean }): boolean {
  return backgroundUnavailable(env) === null;
}

/**
 * How a choice is applied: `off` — the raw camera; `hardware` — the camera's own blur
 * (`backgroundBlur` constraint, Windows Studio Effects; both levels are one system blur);
 * `pipeline` — our segmentation + compositing in the worker (pictures always).
 */
export type BackgroundPath = 'off' | 'hardware' | 'pipeline';

export function backgroundPath(bg: CameraBackground, o: { supported: boolean; hardwareBlur: boolean }): BackgroundPath {
  if (!o.supported || bg.kind === 'none') return 'off';
  if (bg.kind === 'image') return bg.imageId ? 'pipeline' : 'off';
  return o.hardwareBlur ? 'hardware' : 'pipeline';
}

/** `backgroundBlur` is a known constraint and this camera can switch it on. */
export function hasHardwareBlur(supported: Record<string, unknown> | undefined, caps: Record<string, unknown> | undefined): boolean {
  if (supported?.['backgroundBlur'] !== true) return false;
  const c = caps?.['backgroundBlur'];
  return Array.isArray(c) && c.includes(true);
}

// ------------------------------------------------------------------ failures (never silent)

/**
 * The worker gives up on the background — state `failed`, frames pass through, the reason goes to
 * the app log and the UI shows «Фон недоступен» — when frames keep throwing (`FRAME_FAILURES_MAX`
 * in a row, 2 s at 15 fps) or the segmenter keeps returning no mask (`MASKLESS_SEGMENTS_MAX` runs in
 * a row, ≈ 3 s at 8/s). Before 2.1 both passed the raw camera on with the state `ready`.
 */
export const FRAME_FAILURES_MAX = 30;
export const MASKLESS_SEGMENTS_MAX = 24;

/**
 * A runtime failure, by the worker's `detail` prefix (worker.ts): `webgl` (no GL context — nothing
 * can render), `worker` (the worker script died), `effects` (the GL passes keep throwing without a
 * background), `model` (MediaPipe / WASM / model did not start), `frames` (frames keep throwing or
 * no mask comes). The first three take the appearance effects down too.
 */
export type BgFailure = 'webgl' | 'worker' | 'effects' | 'model' | 'frames';

export function failureKind(detail: string | undefined): BgFailure {
  const d = detail ?? '';
  if (d.startsWith('webgl2:')) return 'webgl';
  if (d.startsWith('worker:')) return 'worker';
  if (d.startsWith('effects:')) return 'effects';
  if (d.startsWith('frames:')) return 'frames';
  return 'model';
}

/** Whether a failure also takes «Улучшить внешность» / «Низкая освещённость» down (same GL / worker). */
export const failureStopsEffects = (f: BgFailure): boolean => f === 'webgl' || f === 'worker' || f === 'effects';

/**
 * The fallback after a runtime failure (owner, 2.1): the camera goes on plain, and the choice that
 * cannot be shown is reset — the background to «Нет», the effects off too when they died with it.
 * Returns only what changes (null = nothing chosen that failed).
 */
export function failureFallback<Fx extends { touchUp: boolean; lowLight: boolean }>(
  failure: BgFailure,
  bg: CameraBackground,
  fx: Fx,
): { cameraBackground?: CameraBackground; cameraEffects?: Fx } | null {
  const out: { cameraBackground?: CameraBackground; cameraEffects?: Fx } = {};
  if (bg.kind !== 'none') out.cameraBackground = NO_BACKGROUND;
  if (failureStopsEffects(failure) && (fx.touchUp || fx.lowLight)) out.cameraEffects = { ...fx, touchUp: false, lowLight: false };
  return out.cameraBackground || out.cameraEffects ? out : null;
}

/** An error as one log line (MediaPipe throws Errors, strings and Events). */
export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'type' in err) return `event ${String(err.type)}`;
  return String(err);
}

// ------------------------------------------------------------------ budget (ADR §2)

/**
 * Segmentation rate with the GPU delegate, and without it (software WebGL / CPU delegate). 20 (owner,
 * 03.10, after the 2.1 previews): at 8/s the mask lagged a turning head by ≈ 125 ms and patches of
 * the real background showed; 15 was better but not enough. Capped by the camera's own rate.
 */
export const SEG_FPS = 20;
export const SEG_FPS_SOFTWARE = 6;
/** The user's choice (owner, 03.10): smoothness vs CPU; prefs.cameraBgFps, default SEG_FPS. */
export const SEG_FPS_OPTIONS = [8, 16, 20, 25] as const;
export type SegFpsOption = (typeof SEG_FPS_OPTIONS)[number];
/** Anything unknown (a stale or hand-edited pref) is the default. */
export function normalizeSegFps(v: unknown): SegFpsOption {
  return SEG_FPS_OPTIONS.find((o) => o === v) ?? SEG_FPS;
}
/**
 * The rate the worker segments at: the setting, but the software / CPU-delegate fallback keeps its
 * own lower rate whatever is chosen. (The camera's real frame rate caps it further: segmentStep.)
 */
export function effectiveSegFps(setting: number, fallback: boolean): number {
  return fallback ? SEG_FPS_SOFTWARE : setting;
}

/**
 * Segmentation models (ADR-0035 addendum 2.1, both MediaPipe, Apache-2.0, bundled):
 *   multiclass — selfie_multiclass_256x256 (16 MB, float32): the default on the GPU delegate. Clean
 *     contour, hair and ears kept. The person is 1 − the background class: it counts every person
 *     class at once, accessories (headset, glasses) included, and is one texture — summing hair,
 *     body, face and clothes would drop accessories and cost three more mask reads.
 *   landscape — selfie_segmenter_landscape (256×144, 0.25 MB): software GL or the CPU delegate,
 *     at SEG_FPS_SOFTWARE; the larger model would cost too much there.
 * `edge`: smoothstep over the person confidence (below — background, above — person). Multiclass is
 * confident; 0.3–0.95 gives a soft feathered edge (owner, 03.10: 0.5–0.85 looked cut out); landscape is
 * softer, 0.3–0.7 (2.0).
 */
export type SegModel = 'multiclass' | 'landscape';
export interface SegModelSpec {
  input: [number, number];
  edge: [number, number];
  /** The model's mask 0 is the background (person = 1 − it). */
  invert: boolean;
}
export const SEG_MODELS: Record<SegModel, SegModelSpec> = {
  multiclass: { input: [256, 256], edge: [0.3, 0.95], invert: true },
  landscape: { input: [256, 144], edge: [0.3, 0.7], invert: false },
};

/** The model for a delegate: multiclass only on the GPU delegate over a hardware GL. */
export function segModel(o: { delegate: 'GPU' | 'CPU'; software: boolean; override?: SegModel }): SegModel {
  if (o.delegate === 'CPU') return 'landscape';
  return o.override ?? (o.software ? 'landscape' : 'multiclass');
}
/** Token bucket cap: after a pause at most one extra segmentation, no burst. */
const SEG_TOKENS_MAX = 2;

/**
 * Whether this camera frame is segmented: a token bucket filled at `fps` per second, so a
 * 15 fps camera at 12 fps segments 4 frames of 5 (a plain «every n-th frame» gives 7.5) and at
 * 8 fps 8 frames of 15.
 */
export function segmentStep(tokens: number, dtMs: number, fps: number): { run: boolean; tokens: number } {
  const t = Math.min(SEG_TOKENS_MAX, tokens + (Math.max(0, dtMs) * fps) / 1000);
  return t >= 1 ? { run: true, tokens: t - 1 } : { run: false, tokens: t };
}

/**
 * Temporal smoothing of the mask: the weight of the new mask for `dtMs` since the previous one
 * (time constant `tauMs`). 12 fps → ≈ 0.75, 8 fps → ≈ 0.88: flicker on the edge fades, a moving
 * hand lags ≈ 1 frame.
 */
export const EMA_TAU_MS = 60;
export function emaAlpha(dtMs: number, tauMs = EMA_TAU_MS): number {
  if (!(dtMs > 0)) return 1;
  return Math.min(1, Math.max(0.2, 1 - Math.exp(-dtMs / tauMs)));
}

/** ADR §6: a mask under 3 % of the frame is «person lost»; the last mask is held for 500 ms. */
export const MASK_MIN_COVERAGE = 0.03;
export const MASK_HOLD_MS = 500;

/** The worker may keep the previous mask for a nearly empty one (decided per pixel on the GPU). */
export function maskHoldAllowed(lastGoodAt: number | null, now: number): boolean {
  return lastGoodAt !== null && now - lastGoodAt < MASK_HOLD_MS;
}

/** Background blur in 720p pixels (ADR §2) and the working scale of the blur. */
export const BLUR_SIGMA_720: Record<'blur-light' | 'blur-strong', number> = { 'blur-light': 4, 'blur-strong': 12 };
export const BLUR_DOWNSCALE = 4;
export const BLUR_MAX_RADIUS = 12;

/**
 * One side of a normalized Gaussian (weights for offsets 0..r, the centre counted once) for σ in
 * pixels of the downscaled frame. The radius is ⌈3σ⌉, at most BLUR_MAX_RADIUS.
 */
export function gaussianKernel(sigma: number): number[] {
  const s = Math.max(0.5, sigma);
  const r = Math.min(BLUR_MAX_RADIUS, Math.ceil(3 * s));
  const w: number[] = [];
  for (let i = 0; i <= r; i++) w.push(Math.exp(-(i * i) / (2 * s * s)));
  const sum = w.reduce((a, b, i) => a + (i === 0 ? b : 2 * b), 0);
  return w.map((x) => x / sum);
}

/** σ in downscaled pixels for a frame of `height` (the ADR numbers are for 720p). */
export function blurSigma(kind: 'blur-light' | 'blur-strong', height: number): number {
  return (BLUR_SIGMA_720[kind] * (height / 720)) / BLUR_DOWNSCALE;
}

/**
 * Texture coordinates of a background picture filling a frame of another aspect («cover», centred):
 * `uv_image = uv_frame * scale + offset`.
 */
export function coverUv(imageAspect: number, frameAspect: number): { scale: [number, number]; offset: [number, number] } {
  if (!(imageAspect > 0) || !(frameAspect > 0)) return { scale: [1, 1], offset: [0, 0] };
  if (frameAspect > imageAspect) {
    const sy = imageAspect / frameAspect; // the frame is wider: crop the picture's top and bottom
    return { scale: [1, sy], offset: [0, (1 - sy) / 2] };
  }
  const sx = frameAspect / imageAspect;
  return { scale: [sx, 1], offset: [(1 - sx) / 2, 0] };
}

// ------------------------------------------------------------------ custom pictures (ADR §4)

export const BG_WIDTH = 1280;
export const BG_HEIGHT = 720;
export const BG_THUMB_WIDTH = 320;
export const BG_THUMB_HEIGHT = 180;
export const MAX_CUSTOM_BACKGROUNDS = 5;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type UploadProblem = 'type' | 'size' | 'limit' | null;

export function uploadProblem(file: { type: string; size: number }, customCount: number): UploadProblem {
  if (customCount >= MAX_CUSTOM_BACKGROUNDS) return 'limit';
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size > MAX_UPLOAD_BYTES) return 'size';
  return null;
}

/** The centred 16:9 part of a `w × h` picture («cover»), in source pixels. */
export function coverCrop(w: number, h: number, aspect = BG_WIDTH / BG_HEIGHT): { sx: number; sy: number; sw: number; sh: number } {
  if (w <= 0 || h <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  if (w / h > aspect) {
    const sw = Math.round(h * aspect);
    return { sx: Math.floor((w - sw) / 2), sy: 0, sw, sh: h };
  }
  const sh = Math.round(w / aspect);
  return { sx: 0, sy: Math.floor((h - sh) / 2), sw: w, sh };
}

// ------------------------------------------------------------------ workspace backgrounds (addendum)

/** A workspace background's name: 1..40 characters (server workspaces.maxBackgroundNameLen). */
export const WORKSPACE_BACKGROUND_NAME_MAX = 40;

/** A default name from the file name: without the extension and control characters, at most 40 characters. */
export function nameFromFile(fileName: string): string {
  const base = Array.from(fileName.replace(/\.[^.]+$/, ''))
    .map((c) => (c.charCodeAt(0) < 0x20 || c === '\u007f' ? ' ' : c))
    .join('')
    .trim();
  return Array.from(base).slice(0, WORKSPACE_BACKGROUND_NAME_MAX).join('').trim();
}
