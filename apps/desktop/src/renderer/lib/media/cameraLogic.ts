import { ScreenSharePreset } from '@calaba/protocol';

/**
 * Pure webcam rules (unit-tested; docs/02 «Камера», docs/05 «Камеры», ADR-0018). No LiveKit,
 * no stores: the engine (services/camera.ts) and the UI call these.
 */

/** Chromium-based runtime (Electron, Chrome, Edge): user agent has `Chrome/` or `Chromium/`. */
export function isChromium(userAgent: string): boolean {
  return /\bChrom(e|ium)\//.test(userAgent) && !/\b(Firefox|FxiOS)\//.test(userAgent);
}

/** Capture: 720p30. The encoder gets three rid layers from it (CAMERA_LAYERS). */
export const CAMERA_CAPTURE = { width: 1280, height: 720, fps: 30 } as const;

/** Capture when the encoder is CPU-bound (`qualityLimitationReason: cpu`). */
export const CAMERA_CPU_CAPTURE = { width: 640, height: 360, fps: 24 } as const;

export interface CameraLayer {
  width: number;
  height: number;
  /** Ceiling, bits per second (the encoder spends less on a still picture). */
  maxBitrate: number;
  fps: number;
}

/** Simulcast ladder 180p / 360p / 720p, ceilings 0.15 / 0.5 / 1.5 Mbps (docs/09 #41). */
export const CAMERA_LAYERS: readonly [CameraLayer, CameraLayer, CameraLayer] = [
  { width: 320, height: 180, maxBitrate: 150_000, fps: 24 },
  { width: 640, height: 360, maxBitrate: 500_000, fps: 30 },
  { width: 1280, height: 720, maxBitrate: 1_500_000, fps: 30 },
];

/**
 * Webcam quality (camera ▾ «Качество», ADR-0024): the capture height and the frame-rate cap the
 * server granted in /camera/request (0 = none). 720p is the default and the free plan's maximum.
 */
export interface CameraQuality {
  height: 720 | 1080;
  fps: number;
}

export const CAMERA_DEFAULT_QUALITY: CameraQuality = { height: 720, fps: 0 };

/** 1080p30 capture: the same two lower layers, the top one 1080p at 2.5 Mbps. */
const CAMERA_1080_TOP: CameraLayer = { width: 1920, height: 1080, maxBitrate: 2_500_000, fps: 30 };

const capped = (fps: number, cap: number): number => (cap > 0 ? Math.min(fps, cap) : fps);

/** Capture constraints for a quality: 1280×720 or 1920×1080, ≤ 30 fps and ≤ the granted fps. */
export function cameraCapture(q: CameraQuality): { width: number; height: number; fps: number } {
  const base = q.height === 1080 ? CAMERA_1080_TOP : CAMERA_CAPTURE;
  return { width: base.width, height: base.height, fps: capped(CAMERA_CAPTURE.fps, q.fps) };
}

/** Simulcast ladder for a quality: 180p / 360p / top (720p or 1080p), every layer ≤ the granted fps. */
export function cameraLayers(q: CameraQuality): readonly [CameraLayer, CameraLayer, CameraLayer] {
  const [low, mid, top720] = CAMERA_LAYERS;
  const top = q.height === 1080 ? CAMERA_1080_TOP : top720;
  const cap = (l: CameraLayer): CameraLayer => ({ ...l, fps: capped(l.fps, q.fps) });
  return [cap(low), cap(mid), cap(top)];
}

/**
 * What /camera/request granted → the quality to capture and publish: its preset (≥ H1080 =
 * 1080p) and fps; UNSPECIFIED / 0 keep what was asked (no cap).
 */
export function grantedCameraQuality(wanted: ScreenSharePreset, granted: { preset: ScreenSharePreset; fps: number } | undefined): CameraQuality {
  const p = granted?.preset || wanted;
  return { height: p >= ScreenSharePreset.H1080 ? 1080 : 720, fps: granted?.fps ?? 0 };
}

// ---------------------------------------------------------------- state machine

/**
 * My camera: off → starting (POST …/camera/request, wait for the grant, publish) → on →
 * stopping (unpublish, POST …/camera/stop) → off. A server stop (limit / moderator) and
 * leaving the call go straight to off; the engine releases the capture.
 */
export type CameraPhase = 'off' | 'starting' | 'on' | 'stopping';

export type CameraEvent =
  | 'request' // the user turns the camera on
  | 'published' // the track is live
  | 'failed' // 409, no grant, capture / publish error
  | 'stop' // the user turns it off
  | 'stopped' // unpublished and released
  | 'server-stop' // VOICE_CAMERA_STOP for me, or the grant was withdrawn
  | 'left'; // left / lost the call

export function cameraNext(phase: CameraPhase, ev: CameraEvent): CameraPhase {
  if (ev === 'left' || ev === 'server-stop') return 'off';
  switch (phase) {
    case 'off':
      return ev === 'request' ? 'starting' : 'off';
    case 'starting':
      if (ev === 'published') return 'on';
      if (ev === 'failed') return 'off';
      if (ev === 'stop') return 'stopping';
      return 'starting';
    case 'on':
      if (ev === 'stop') return 'stopping';
      if (ev === 'failed') return 'off';
      return 'on';
    case 'stopping':
      return ev === 'stopped' || ev === 'failed' ? 'off' : 'stopping';
  }
}

/** Why the camera button is unavailable (tooltip), or null when it can be pressed. */
export type CameraBlock = 'not-connected' | 'no-permission' | 'room-off' | null;

/**
 * The button gate. `canVideo` is `JoinVoiceResponse.can_video` (VIDEO and camera_limit > 0);
 * `limit` is the room's effective camera_limit (0 = cameras off). The client only hides UI, the
 * server re-checks (409 on /camera/request).
 */
export function cameraBlock(i: { connected: boolean; canVideo: boolean; limit: number; phase: CameraPhase }): CameraBlock {
  if (i.phase !== 'off') return null; // a live camera can always be turned off
  if (!i.connected) return 'not-connected';
  if (i.limit === 0) return 'room-off';
  if (!i.canVideo) return 'no-permission';
  return null;
}

/** Room at its camera limit (the server decides; this only changes the button's tooltip). */
export function camerasFull(camerasOn: number, limit: number, mineOn: boolean): boolean {
  return !mineOn && limit > 0 && camerasOn >= limit;
}

/** VoiceStreamStopReason of VOICE_CAMERA_STOP → toast (MessageKey suffix). */
export function cameraStopText(reason: 'limit' | 'moderator' | 'other'): 'video.stop.limit' | 'video.stop.moderator' | 'video.stop.other' {
  return reason === 'limit' ? 'video.stop.limit' : reason === 'moderator' ? 'video.stop.moderator' : 'video.stop.other';
}

/**
 * Which remote cameras to subscribe to: the ones on screen (`shown`, lib/media/cameraShown.ts —
 * ADR-0066 §4: the gallery page, the large tile, the PiP) except «Не показывать видео»; with
 * «Экономить трафик» only the primary one (the featured / PiP camera). Without `shown`: everyone's.
 */
export function cameraWanted(
  cameras: readonly string[],
  o: { hidden: Readonly<Record<string, true>>; saveTraffic: boolean; primary: string | null; me?: string; shown?: ReadonlySet<string> },
): Set<string> {
  return new Set(cameras.filter((id) => id !== o.me && !o.hidden[id] && (!o.saveTraffic || id === o.primary) && (!o.shown || o.shown.has(id))));
}

/** Consecutive CPU-limited stats samples (2 s apart) before dropping the capture to 360p. */
export const CPU_LIMIT_SAMPLES = 3;

/** Counts CPU-limited samples; true once the camera should drop to 360p (once per session). */
export function cpuLimitStep(count: number, cpuLimited: boolean): { count: number; limit: boolean } {
  const next = cpuLimited ? count + 1 : 0;
  return { count: next, limit: next === CPU_LIMIT_SAMPLES };
}

/** Which way a phone camera looks: `user` = front (selfie), `environment` = back. */
export type CameraFacing = 'user' | 'environment';

export const otherFacing = (f: CameraFacing | null): CameraFacing => (f === 'environment' ? 'user' : 'environment');

/** The self-view is mirrored except for the back camera (the picture must read like the room). */
export const cameraMirrored = (f: CameraFacing | null): boolean => f !== 'environment';

/** «Переключить камеру» is for touch devices that report two or more video inputs (front + back). */
export const canFlipCamera = (videoInputs: number, touch: boolean): boolean => touch && videoInputs >= 2;

/**
 * getUserMedia video constraint for the chosen device or, on a phone, the chosen side. An explicit
 * device wins over the side; no choice at all adds nothing (desktop behaviour is unchanged).
 */
export function cameraTarget(deviceId: string | null, facing: CameraFacing | null): { deviceId: { exact: string } } | { facingMode: CameraFacing } | Record<string, never> {
  if (deviceId) return { deviceId: { exact: deviceId } };
  if (facing) return { facingMode: facing };
  return {};
}
