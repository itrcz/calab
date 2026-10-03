import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { errorText, segModel, type SegModel } from './logic';
// Bundled with the app and the web build (ADR-0035 §1, addendum 2.1): no CDN, the renderer has no
// external network. Only the chosen model is fetched, when a background is first enabled. The
// ES-module loader variant: a module worker cannot importScripts, MediaPipe then uses import().
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import multiclassUrl from '../../../../../resources/mediapipe/selfie_multiclass_256x256.tflite?url';
import landscapeUrl from '../../../../../resources/mediapipe/selfie_segmenter_landscape.tflite?url';

const MODEL_URL: Record<SegModel, string> = { multiclass: multiclassUrl, landscape: landscapeUrl };

/**
 * MediaPipe Image Segmenter in the worker (ADR-0035, addendum 2.1): selfie_multiclass_256x256 on
 * the GPU delegate, the selfie landscape model (256×144) on software GL and on the CPU delegate.
 * With the GPU delegate it runs in the given canvas's WebGL2 context — the compositor's — and hands
 * the mask as a texture of that context.
 */
export interface Segmenter {
  /** false = the CPU delegate: segment less often (with a software GL too, the caller knows). */
  readonly gpu: boolean;
  /** Why the GPU delegate was not used ('' = it was): for the app log. */
  readonly gpuError: string;
  /** The model in use (logic.ts SEG_MODELS: its input size and mask edge). */
  readonly model: SegModel;
  /** The segmenter takes a model-size input without resizing the shared canvas. */
  readonly small: boolean;
  /**
   * Segments `frame`; `onMask` gets confidence mask 0 as a texture valid only inside it — the person
   * (landscape) or the background (multiclass, SEG_MODELS[model].invert).
   */
  segment(frame: TexImageSource, timestampMs: number, onMask: (tex: WebGLTexture, w: number, h: number) => void): void;
  close(): void;
}

export interface SegmenterOptions {
  /** The compositor's WebGL is software (SwiftShader / WARP / llvmpipe): the light model. */
  software: boolean;
  /** Benchmarks (scripts/bg-quality.mjs): force a model on the GPU delegate. */
  model?: SegModel;
  /** Diagnostics (scripts/bg-probe.mjs): the GPU attempt gets a missing model, the CPU fallback runs. */
  failGpu?: boolean;
}

export async function createSegmenter(canvas: OffscreenCanvas, opts: SegmenterOptions): Promise<Segmenter> {
  const abs = (u: string): string => new URL(u, self.location.href).href;
  const fileset = { wasmLoaderPath: abs(wasmLoaderUrl), wasmBinaryPath: abs(wasmBinaryUrl) };
  // MediaPipe loads the WASM loader with import() and then takes (and clears) the global
  // `ModuleFactory` it sets. A module is evaluated once per worker, so a second attempt — the CPU
  // delegate after a failed GPU one — found no factory («ModuleFactory not set») and the background
  // failed instead of falling back (2.0.x). Import it ourselves and hand the factory to every attempt.
  const loader = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default?: unknown };
  const g = globalThis as unknown as { ModuleFactory?: unknown };
  const make = (delegate: 'GPU' | 'CPU', model: SegModel): Promise<ImageSegmenter> => {
    g.ModuleFactory ??= loader.default ?? g.ModuleFactory;
    const url = abs(MODEL_URL[model]);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.failGpu && delegate === 'GPU' ? `${url}.missing` : url, delegate },
      canvas,
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  };
  let gpu = true;
  let gpuError = '';
  let model = segModel({ delegate: 'GPU', software: opts.software, ...(opts.model ? { override: opts.model } : {}) });
  let seg: ImageSegmenter;
  try {
    seg = await make('GPU', model);
  } catch (err) {
    console.warn('camera background: GPU delegate failed, using the CPU one', err);
    gpu = false;
    gpuError = errorText(err);
    model = segModel({ delegate: 'CPU', software: opts.software });
    seg = await make('CPU', model);
  }
  // Our input is the model-size picture, the canvas is the compositor's full-size output:
  // MediaPipe must not resize it to the input (GraphRunner.setAutoResizeCanvas, `g` in 1.0.1 — pinned).
  const resize = (seg as unknown as { g?: { setAutoResizeCanvas?: (on: boolean) => void } }).g?.setAutoResizeCanvas;
  const small = typeof resize === 'function';
  if (small) resize.call((seg as unknown as { g: unknown }).g, false);
  return {
    gpu,
    gpuError,
    model,
    small,
    segment(frame, ts, onMask) {
      seg.segmentForVideo(frame, ts, (result) => {
        const mask = result.confidenceMasks?.[0];
        if (!mask) return;
        onMask(mask.getAsWebGLTexture(), mask.width, mask.height);
      });
    },
    close() {
      seg.close();
    },
  };
}
