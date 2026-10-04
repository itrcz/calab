/**
 * Camera background and appearance worker (ADR-0035 §1–2, §6 and the «эффекты внешности»
 * addendum). Camera frames arrive on a transferred MediaStreamTrackProcessor stream and leave on a
 * transferred MediaStreamTrackGenerator stream; the UI thread takes no part per frame.
 *
 * A frame passes through untouched (no GL, no canvas) unless it needs work: a background (once the
 * model is loaded — multiclass at SEG_FPS, 15/s (every camera frame); the landscape model at 6/s on software GL or the
 * CPU delegate), «Улучшить внешность», or «Низкая освещённость» while the room is dark. The low-light meter reads the frame
 * at 256×144 once a second on the CPU (a histogram, effects.ts); a bright room stays pass-through.
 * The appearance effects need no model: the compositor alone, created on the first frame.
 */
import { Compositor } from './compositor';
import { METER_HEIGHT, METER_INTERVAL_MS, METER_WIDTH, NO_WORKER_EFFECTS, denoiseAmount, exposureDecision, exposureRamp, histogramMean, lumaHistogram, type WorkerEffects } from './effects';
import { FRAME_FAILURES_MAX, MASKLESS_SEGMENTS_MAX, SEG_FPS, SEG_MODELS, blurSigma, effectiveSegFps, emaAlpha, errorText, maskHoldAllowed, MASK_MIN_COVERAGE, segmentStep } from './logic';
import type { BgTune, FromWorker, ToWorker, WorkerMode } from './protocol';
import { createSegmenter, type Segmenter } from './segmenter';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker): void;
  close(): void;
}
const scope = self as unknown as WorkerScope;

let mode: WorkerMode = 'none';
let fx: WorkerEffects = NO_WORKER_EFFECTS;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let comp: Compositor | null = null;
/** No WebGL2 context: nothing can be rendered, every frame passes through. */
let glFailed = false;
let seg: Segmenter | null = null;
let loading: Promise<void> | null = null;
/** The segmenter could not start: no background (the appearance effects still work). */
let failed = false;
/** The user's setting and whether the software / CPU-delegate fallback is in use (it keeps its own rate). */
let segSetting: number = SEG_FPS;
let segFallback = false;
let segFps = SEG_FPS;
function updateSegFps(): void {
  segFps = tune.segFps ?? effectiveSegFps(segSetting, segFallback);
}
let tokens = 0;
let lastFrameTs = -1;
let lastSegTs = -1;
let lastGoodAt: number | null = null;
let pendingImage: ImageBitmap | null = null;
let stopped = false;
/** Frames that threw in a row, segmentations without a mask in a row (logic.ts: never silent). */
let frameFailures = 0;
let masklessSegments = 0;
let segCtx: OffscreenCanvasRenderingContext2D | null = null;
/** Low light: the meter's canvas (CPU-backed, read once a second), its state, the curve in use. */
let meterCtx: OffscreenCanvasRenderingContext2D | null = null;
let lastMeterTs = -Infinity;
let meanLuma = -1;
let exposureOn = false;
let gammaTarget = 1;
let gamma = 1;
/** The model's input size (logic.ts SEG_MODELS), set when the segmenter starts. */
let segWidth = 256;
let segHeight = 256;
let tune: BgTune = {};
const stats = { frames: 0, rendered: 0, segs: 0, ms: 0, since: 0 };

function count(ms: number, rendered: boolean, segmented: boolean): void {
  const now = performance.now();
  if (!stats.since) stats.since = now;
  stats.frames++;
  stats.ms += ms;
  if (rendered) stats.rendered++;
  if (segmented) stats.segs++;
  if (now - stats.since >= 5000) {
    post({ type: 'stats', frames: stats.frames, rendered: stats.rendered, segs: stats.segs, msPerFrame: stats.ms / stats.frames, seconds: (now - stats.since) / 1000, mean: meanLuma, gamma });
    Object.assign(stats, { frames: 0, rendered: 0, segs: 0, ms: 0, since: now });
  }
}

const post = (m: FromWorker): void => scope.postMessage(m);

/** The GL half, once (no model): the appearance effects need only this. */
function compositor(): Compositor | null {
  if (comp || glFailed) return comp;
  try {
    comp = new Compositor(new OffscreenCanvas(16, 16));
    comp.setImage(pendingImage);
  } catch (err) {
    glFailed = true;
    console.warn('camera effects: WebGL2 unavailable', err);
    post({ type: 'state', state: 'failed', detail: `webgl2: ${errorText(err)}` });
  }
  return comp;
}

/** MediaPipe, once, on the first frame that needs a background. */
function load(): Promise<void> {
  loading ??= (async () => {
    post({ type: 'state', state: 'loading' });
    try {
      const c = compositor();
      if (!c) throw new Error('webgl2 unavailable');
      const software = c.software;
      seg = await createSegmenter(c.canvas, { software, ...(tune.model ? { model: tune.model } : {}), ...(tune.failGpu ? { failGpu: true } : {}) });
      if (stopped) return;
      const spec = SEG_MODELS[seg.model];
      [segWidth, segHeight] = spec.input;
      c.setMaskSpec(spec);
      segFallback = !seg.gpu || software;
      updateSegFps();
      const delegate = `${seg.model}, ${seg.gpu ? 'gpu delegate' : `cpu delegate (gpu: ${seg.gpuError})`}, ${segFps}/s`;
      post({ type: 'state', state: 'ready', software: !seg.gpu || software, detail: `${delegate}; ${c.renderer}` });
    } catch (err) {
      fail(`segmenter: ${errorText(err)}`);
    }
  })();
  return loading;
}

/** The background gives up (frames pass through, effects go on): the state and the reason, once. */
function fail(detail: string): void {
  if (failed) return;
  failed = true;
  console.warn('camera background: unavailable', detail);
  post({ type: 'state', state: 'failed', detail });
}

function setImage(image: ImageBitmap | null): void {
  if (pendingImage && pendingImage !== image) pendingImage.close();
  pendingImage = image;
  comp?.setImage(image);
}

/** Low light (effects.ts): the frame's mean luma at 256×144, once a second → the curve's target. */
function meter(frame: VideoFrame, ts: number): void {
  if (ts - lastMeterTs < METER_INTERVAL_MS && ts >= lastMeterTs) return;
  lastMeterTs = ts;
  try {
    meterCtx ??= new OffscreenCanvas(METER_WIDTH, METER_HEIGHT).getContext('2d', { alpha: false, willReadFrequently: true });
    if (!meterCtx) return;
    meterCtx.drawImage(frame, 0, 0, METER_WIDTH, METER_HEIGHT);
    meanLuma = histogramMean(lumaHistogram(meterCtx.getImageData(0, 0, METER_WIDTH, METER_HEIGHT).data));
    const d = exposureDecision(meanLuma, exposureOn);
    exposureOn = d.active;
    gammaTarget = d.gamma;
  } catch (err) {
    console.warn('camera effects: low-light meter failed', err);
  }
}

async function handle(frame: VideoFrame): Promise<void> {
  const w = writer;
  if (!w) {
    frame.close();
    return;
  }
  const t0 = performance.now();
  const ts = frame.timestamp / 1000; // µs → ms
  const dt = lastFrameTs < 0 ? 1000 / 15 : ts - lastFrameTs;
  lastFrameTs = ts;
  if (fx.lowLight) meter(frame, ts);
  gamma = exposureRamp(gamma, fx.lowLight ? gammaTarget : 1, dt);

  const wantBg = mode !== 'none' && !failed && !glFailed;
  if (wantBg && !seg) void load();
  const bgOn = wantBg && !!seg;
  const lift = gamma < 1;
  const effectsOn = fx.touchUp > 0 || lift;
  const c = (bgOn || effectsOn) && !glFailed ? compositor() : null;
  if (!c) {
    // Passes through; the sink owns (and closes) it.
    count(performance.now() - t0, false, false);
    await w.write(frame);
    return;
  }

  let segmented = false;
  let out: VideoFrame | null = null;
  try {
    c.resize(frame.displayWidth, frame.displayHeight);
    c.upload(frame);
    if (bgOn && seg) {
      const step = segmentStep(tokens, dt, segFps);
      tokens = step.tokens;
      if (step.run || !c.ready) {
        const coverage = c.takeCoverage();
        const now = performance.now();
        if (coverage !== null && coverage >= MASK_MIN_COVERAGE) lastGoodAt = now;
        const segTs = Math.max(ts, lastSegTs + 1);
        const alpha = emaAlpha(lastSegTs < 0 ? 0 : segTs - lastSegTs);
        lastSegTs = segTs;
        segmented = true;
        // The model's own input size (ADR §2): scaled once here instead of MediaPipe uploading
        // the full frame and scaling its mask back up to it.
        if (seg.small) segCtx ??= new OffscreenCanvas(segWidth, segHeight).getContext('2d', { alpha: false, desynchronized: true });
        segCtx?.drawImage(frame, 0, 0, segWidth, segHeight);
        if (++masklessSegments > MASKLESS_SEGMENTS_MAX) throw new Error(`no mask from the segmenter after ${MASKLESS_SEGMENTS_MAX} runs`);
        seg.segment(segCtx ? segCtx.canvas : frame, segTs, (tex, mw, mh) => {
          masklessSegments = 0;
          c.pushMask(tex, mw, mh, alpha, maskHoldAllowed(lastGoodAt, now));
        });
      }
    }
    const bg = bgOn && c.ready ? (mode === 'image' ? ({ kind: 'image' } as const) : ({ kind: 'blur', sigma: blurSigma(mode === 'blur-light' ? 'blur-light' : 'blur-strong', frame.displayHeight) } as const)) : null;
    // A background still waiting for its first mask and no effect: the camera as is.
    if (bg || effectsOn) {
      c.render({ bg, touchUp: fx.touchUp, touchRange: fx.touchRange, gamma, denoise: denoiseAmount(gamma) });
      out = new VideoFrame(c.canvas, { timestamp: frame.timestamp, alpha: 'discard' });
    }
    frameFailures = 0;
  } catch (err) {
    // Passes through; a persistent failure turns the background off with its reason (never silent).
    out?.close();
    out = null;
    if (++frameFailures === 1) console.warn('camera background: frame failed, passing through', err);
    if (frameFailures >= FRAME_FAILURES_MAX || masklessSegments > MASKLESS_SEGMENTS_MAX) {
      if (bgOn) fail(`frames: ${errorText(err)}`);
      else {
        glFailed = true;
        post({ type: 'state', state: 'failed', detail: `effects: ${errorText(err)}` });
      }
      frameFailures = 0;
    }
  }
  count(performance.now() - t0, !!out, segmented);
  if (out) {
    frame.close();
    await w.write(out);
  } else {
    await w.write(frame);
  }
}

async function pump(readable: ReadableStream<VideoFrame>): Promise<void> {
  const r = readable.getReader();
  reader = r;
  for (;;) {
    let res: ReadableStreamReadResult<VideoFrame>;
    try {
      res = await r.read();
    } catch {
      return;
    }
    if (res.done || reader !== r) {
      res.value?.close();
      return;
    }
    try {
      await handle(res.value);
    } catch {
      return; // the output was closed (track stopped)
    }
  }
}

function switchSource(readable: ReadableStream<VideoFrame>): void {
  const old = reader;
  reader = null;
  void old?.cancel().catch(() => undefined);
  lastFrameTs = -1;
  lastMeterTs = -Infinity;
  void pump(readable);
}

function setEffects(next: WorkerEffects): void {
  // Low light switched on: measure on the next frame, not up to a second later.
  if (next.lowLight && !fx.lowLight) lastMeterTs = -Infinity;
  if (!next.lowLight) {
    exposureOn = false;
    gammaTarget = 1;
  }
  fx = next;
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      tune = m.tune ?? {};
      if (m.segFps) segSetting = m.segFps;
      updateSegFps();
      writer = m.writable.getWriter();
      mode = m.mode;
      setEffects(m.effects);
      setImage(m.image);
      if (mode !== 'none') void load();
      switchSource(m.readable);
      break;
    case 'source':
      switchSource(m.readable);
      break;
    case 'mode':
      mode = m.mode;
      setImage(m.image);
      if (mode !== 'none') void load();
      break;
    case 'effects':
      setEffects(m.effects);
      break;
    case 'segFps':
      segSetting = m.fps;
      updateSegFps();
      break;
    case 'stop':
      stopped = true;
      void reader?.cancel().catch(() => undefined);
      reader = null;
      void writer?.close().catch(() => undefined);
      writer = null;
      seg?.close();
      comp?.destroy();
      pendingImage?.close();
      scope.close();
      break;
  }
};
