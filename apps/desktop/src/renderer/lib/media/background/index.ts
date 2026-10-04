import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import type { WorkerEffects } from './effects';
import { BACKGROUND_PROCESSOR, SEG_FPS, type BackgroundKind } from './logic';
import type { BgTune, FromWorker, ToWorker, WorkerState } from './protocol';

/**
 * The camera background and appearance effects as a LiveKit track processor (ADR-0035 §1 and the
 * «эффекты внешности» addendum): `LocalVideoTrack.setProcessor`
 * swaps the published and the locally shown track for `processedTrack`. This module is a lazy
 * chunk (services/cameraBackground.ts imports it on the first effect); the worker, MediaPipe, the
 * WASM and the model load only when a frame needs the effect.
 *
 * Electron 44 / Chromium 152 have MediaStreamTrackProcessor and MediaStreamTrackGenerator on the
 * window only (not in workers, and a MediaStreamTrack is not transferable): both are made here and
 * their streams are transferred — Chromium then moves frames to the worker without the UI thread.
 */

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<T>;
}
declare class MediaStreamTrackGenerator<T> extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<T>;
}

export interface BackgroundStatus {
  /** `idle`: the processor was destroyed (the track stopped). */
  state: WorkerState | 'idle';
  /** No GPU delegate / software WebGL: 6 fps and the «нагружает процессор» hint. */
  software: boolean;
  /** `failed`: why (for the log; the UI shows a generic hint). `ready`: delegate and GL renderer. */
  detail?: string;
}

export class BackgroundProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  readonly name = BACKGROUND_PROCESSOR;
  processedTrack?: MediaStreamTrack;
  private worker: Worker | null = null;
  private generator: MediaStreamTrackGenerator<VideoFrame> | null = null;
  /** The worker's last 5 s report (frames, segmentations, ms per frame): e2e and benchmarks. */
  lastStats: Extract<FromWorker, { type: 'stats' }> | null = null;
  /** Quality knobs for prototypes and benchmarks (protocol.ts), set before `init`. */
  tune: BgTune | undefined;
  /** prefs.cameraBgFps (logic.ts SEG_FPS_OPTIONS); the worker's fallback keeps its own rate. */
  segFps = SEG_FPS;

  constructor(
    private mode: BackgroundKind,
    private image: ImageBitmap | null,
    private effects: WorkerEffects,
    private readonly onStatus: (s: BackgroundStatus) => void,
    /** The picture's id for `image` (services/cameraBackground.ts: an effect change does not reload it). */
    private picture: string | null = null,
  ) {}

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  init(opts: VideoProcessorOptions): Promise<void> {
    const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: 'video' });
    // Faces and gestures: keep the frame rate under congestion (like the raw camera, lib/media/camera.ts).
    generator.contentHint = 'motion';
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'camera-background' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type === 'state') this.onStatus({ state: e.data.state, software: e.data.software ?? false, ...(e.data.detail ? { detail: e.data.detail } : {}) });
      else this.lastStats = e.data;
    };
    // The worker script itself failed (load, syntax, an uncaught throw): never silent.
    worker.onerror = (e) => {
      e.preventDefault();
      this.onStatus({ state: 'failed', software: false, detail: `worker: ${e.message || 'script error'}` });
    };
    this.worker = worker;
    this.generator = generator;
    this.processedTrack = generator;
    const readable = new MediaStreamTrackProcessor<VideoFrame>({ track: opts.track, maxBufferSize: 2 }).readable;
    const image = this.image;
    this.image = null; // transferred
    this.send({ type: 'init', readable, writable: generator.writable, mode: this.mode, image, effects: this.effects, segFps: this.segFps, ...(this.tune ? { tune: this.tune } : {}) }, image ? [readable, generator.writable, image] : [readable, generator.writable]);
    return Promise.resolve();
  }

  /** The camera was restarted (another device): same output track, a new source. */
  restart(opts: VideoProcessorOptions): Promise<void> {
    if (!this.worker) return this.init(opts);
    const readable = new MediaStreamTrackProcessor<VideoFrame>({ track: opts.track, maxBufferSize: 2 }).readable;
    this.send({ type: 'source', readable }, [readable]);
    return Promise.resolve();
  }

  /** Another background or picture, without restarting anything. */
  setMode(mode: BackgroundKind, image: ImageBitmap | null, picture: string | null = null): void {
    this.mode = mode;
    this.picture = mode === 'image' ? picture : null;
    this.send({ type: 'mode', mode, image }, image ? [image] : []);
  }

  /** «Улучшить внешность» / «Низкая освещённость» (the slider sends many: nothing reloads). */
  setEffects(effects: WorkerEffects): void {
    this.effects = effects;
    this.send({ type: 'effects', effects });
  }

  /** «Плавность»: the segmentation rate, without restarting anything. */
  setSegFps(fps: number): void {
    if (fps === this.segFps) return;
    this.segFps = fps;
    this.send({ type: 'segFps', fps });
  }

  get currentMode(): BackgroundKind {
    return this.mode;
  }

  /** The id of the picture in use (`image` mode), else null. */
  get currentPicture(): string | null {
    return this.picture;
  }

  destroy(): Promise<void> {
    if (this.worker) this.onStatus({ state: 'idle', software: false });
    this.send({ type: 'stop' });
    const w = this.worker;
    this.worker = null;
    // Let the worker close its streams, then make sure it is gone.
    if (w) setTimeout(() => w.terminate(), 1000);
    this.generator?.stop();
    this.generator = null;
    this.image?.close();
    this.image = null;
    return Promise.resolve();
  }
}

export function createBackgroundProcessor(mode: BackgroundKind, image: ImageBitmap | null, effects: WorkerEffects, onStatus: (s: BackgroundStatus) => void, picture: string | null = null): BackgroundProcessor {
  return new BackgroundProcessor(mode, image, effects, onStatus, picture);
}
