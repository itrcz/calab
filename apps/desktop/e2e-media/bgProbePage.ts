/**
 * Camera background diagnostic page (scripts/bg-probe.mjs): the app's own processor (worker + MediaPipe +
 * WebGL, bundled by Vite like the app) on Chromium's fake camera, no LiveKit. Reports what the
 * runtime offers (breakout box, WebGL2 renderer, `backgroundBlur`), the processor's state and error,
 * the worker's stats, and whether the output frames differ from the input (the fake camera has no
 * person: the whole frame is background, so blur flattens it and a picture replaces it).
 */
import { createBackgroundProcessor, type BackgroundStatus } from '../src/renderer/lib/media/background';
import { BUILTIN_BACKGROUNDS, loadBackgroundBitmap } from '../src/renderer/lib/media/background/images';
import { NO_WORKER_EFFECTS } from '../src/renderer/lib/media/background/effects';
import type { BackgroundKind } from '../src/renderer/lib/media/background/logic';
import type { BgTune } from '../src/renderer/lib/media/background/protocol';

function env(): Record<string, unknown> {
  const w = globalThis as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    breakoutBox: typeof w['MediaStreamTrackProcessor'] === 'function' && typeof w['MediaStreamTrackGenerator'] === 'function',
    videoFrame: typeof w['VideoFrame'] === 'function',
    offscreen: typeof w['OffscreenCanvas'] === 'function',
    supportedBackgroundBlur: (navigator.mediaDevices.getSupportedConstraints() as Record<string, unknown>)['backgroundBlur'] ?? null,
  };
  try {
    const gl = new OffscreenCanvas(4, 4).getContext('webgl2');
    if (!gl) out['webgl2'] = 'null context';
    else {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out['webgl2'] = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      out['floatRT'] = !!gl.getExtension('EXT_color_buffer_float');
    }
  } catch (err) {
    out['webgl2'] = `throws: ${String(err)}`;
  }
  return out;
}

/** 160×90 luma of a track's current frame. */
async function grab(track: MediaStreamTrack): Promise<Float32Array> {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = new MediaStream([track]);
  await v.play();
  await new Promise((r) => setTimeout(r, 400));
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 90;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('no 2d');
  g.drawImage(v, 0, 0, 160, 90);
  v.srcObject = null;
  const d = g.getImageData(0, 0, 160, 90).data;
  const y = new Float32Array(160 * 90);
  for (let i = 0; i < y.length; i++) y[i] = 0.299 * (d[i * 4] ?? 0) + 0.587 * (d[i * 4 + 1] ?? 0) + 0.114 * (d[i * 4 + 2] ?? 0);
  return y;
}

function compare(a: Float32Array, b: Float32Array): { meanIn: number; meanOut: number; diff: number; edgesIn: number; edgesOut: number } {
  let diff = 0;
  let mi = 0;
  let mo = 0;
  let ei = 0;
  let eo = 0;
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    mi += a[i] ?? 0;
    mo += b[i] ?? 0;
    if (i % 160 < 159 && i + 160 < a.length) {
      ei += Math.abs((a[i] ?? 0) - (a[i + 1] ?? 0)) + Math.abs((a[i] ?? 0) - (a[i + 160] ?? 0));
      eo += Math.abs((b[i] ?? 0) - (b[i + 1] ?? 0)) + Math.abs((b[i] ?? 0) - (b[i + 160] ?? 0));
    }
  }
  const n = a.length;
  return { meanIn: mi / n, meanOut: mo / n, diff: diff / n, edgesIn: ei / n, edgesOut: eo / n };
}

async function run(kind: BackgroundKind, waitMs = 30_000, tune: BgTune | null = null): Promise<Record<string, unknown>> {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 15 } });
  const raw = s.getVideoTracks()[0];
  if (!raw) throw new Error('no camera');
  const caps = raw.getCapabilities() as Record<string, unknown>;
  const states: BackgroundStatus[] = [];
  const image = kind === 'image' ? await loadBackgroundBitmap(BUILTIN_BACKGROUNDS[2]?.id ?? BUILTIN_BACKGROUNDS[0]?.id) : null;
  const t0 = performance.now();
  const proc = createBackgroundProcessor(kind, image, NO_WORKER_EFFECTS, (st) => states.push({ ...st }));
  if (tune) proc.tune = tune;
  await proc.init({ track: raw, kind: 'video' } as unknown as Parameters<typeof proc.init>[0]);
  const until = performance.now() + waitMs;
  while (performance.now() < until && !states.some((x) => x.state === 'ready' || x.state === 'failed')) await new Promise((r) => setTimeout(r, 200));
  const readyMs = Math.round(performance.now() - t0);
  // A full 5 s stats window after ready.
  await new Promise((r) => setTimeout(r, 6000));
  const out = proc.processedTrack;
  const cmp = out ? compare(await grab(raw), await grab(out)) : null;
  const res = { kind, tune, readyMs, states, stats: proc.lastStats, compare: cmp, cameraBackgroundBlur: caps['backgroundBlur'] ?? null, settings: raw.getSettings() };
  await proc.destroy();
  raw.stop();
  return res;
}

/** A picture as a 15 fps camera; `sway` px of slow sideways motion (a person on a call), 0 = still. */
async function pictureTrack(url: string, sway: number): Promise<MediaStreamTrack> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d');
  // A picture of another aspect (a square avatar): centred at full height over its own stretched
  // copy, so the person keeps their proportions and the sides still look like a room.
  const w = Math.round((720 * img.naturalWidth) / img.naturalHeight);
  let n = 0;
  setInterval(() => {
    n++;
    const dx = sway ? Math.sin(n / 10) * sway : 0;
    g.drawImage(img, dx - sway, 0, 1280 + 2 * sway, 720);
    if (Math.abs(w - 1280) > 8) g.drawImage(img, dx + (1280 - w) / 2, 0, w, 720);
  }, 66);
  const t = c.captureStream(15).getVideoTracks()[0];
  if (!t) throw new Error('no canvas track');
  return t;
}

/**
 * Edge quality (ADR-0035 addendum 2.1, scripts/bg-quality.mjs): `kind` over a picture of a person with `tune`; after
 * `settleMs` returns the processed 1280×720 output as PNG and the worker's stats.
 */
async function shoot(kind: BackgroundKind, picture: string, tune: BgTune | null, sway = 0, settleMs = 7000): Promise<{ png: string; stats: unknown; states: BackgroundStatus[] }> {
  const raw = await pictureTrack(picture, sway);
  const states: BackgroundStatus[] = [];
  const image = kind === 'image' ? await loadBackgroundBitmap(BUILTIN_BACKGROUNDS[2]?.id ?? BUILTIN_BACKGROUNDS[0]?.id) : null;
  const proc = createBackgroundProcessor(kind, image, NO_WORKER_EFFECTS, (st) => states.push({ ...st }));
  if (tune) proc.tune = tune;
  await proc.init({ track: raw, kind: 'video' } as unknown as Parameters<typeof proc.init>[0]);
  await new Promise((r) => setTimeout(r, settleMs));
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = new MediaStream(proc.processedTrack ? [proc.processedTrack] : []);
  await v.play();
  await new Promise((r) => setTimeout(r, 300));
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')?.drawImage(v, 0, 0);
  v.srcObject = null;
  const res = { png: c.toDataURL('image/png'), stats: proc.lastStats, states };
  await proc.destroy();
  raw.stop();
  return res;
}

(window as unknown as { __probe: unknown }).__probe = { env, run, shoot };
