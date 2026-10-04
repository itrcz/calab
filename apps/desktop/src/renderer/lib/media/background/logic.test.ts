import { describe, expect, it } from 'vitest';
import {
  backgroundPath,
  backgroundSupported,
  backgroundUnavailable,
  failureFallback,
  failureKind,
  failureStopsEffects,
  blurSigma,
  errorText,
  coverCrop,
  coverUv,
  emaAlpha,
  gaussianKernel,
  hasHardwareBlur,
  maskHoldAllowed,
  MASK_HOLD_MS,
  segmentStep,
  SEG_FPS,
  SEG_FPS_OPTIONS,
  SEG_FPS_SOFTWARE,
  effectiveSegFps,
  normalizeSegFps,
  SEG_MODELS,
  segModel,
  uploadProblem,
  isWorkspaceImage,
  nameFromFile,
  staleWorkspaceChoice,
  workspaceBackgroundOf,
  workspaceImageId,
  type BackgroundEnv,
} from './logic';

const DESKTOP: BackgroundEnv = { breakoutBox: true, webgl2: true, mobile: false, lowEnd: false };

describe('backgroundSupported (ADR-0035 §5)', () => {
  it('Chromium desktop / Electron: shown', () => expect(backgroundSupported(DESKTOP)).toBe(true));
  it('Safari / Firefox (no MediaStreamTrackProcessor): hidden', () => expect(backgroundSupported({ ...DESKTOP, breakoutBox: false })).toBe(false));
  it('phones: hidden', () => expect(backgroundSupported({ ...DESKTOP, mobile: true })).toBe(false));
  it('«Слабый компьютер»: hidden', () => expect(backgroundSupported({ ...DESKTOP, lowEnd: true })).toBe(false));
  it('no WebGL2: hidden', () => expect(backgroundSupported({ ...DESKTOP, webgl2: false })).toBe(false));
});

describe('backgroundPath (hardware / our pipeline / off)', () => {
  const on = { supported: true, hardwareBlur: false };
  const hw = { supported: true, hardwareBlur: true };
  it('none → off', () => expect(backgroundPath({ kind: 'none' }, on)).toBe('off'));
  it('blur without the camera effect → our pipeline', () => {
    expect(backgroundPath({ kind: 'blur-light' }, on)).toBe('pipeline');
    expect(backgroundPath({ kind: 'blur-strong' }, on)).toBe('pipeline');
  });
  it('blur with Windows Studio Effects → hardware (both levels)', () => {
    expect(backgroundPath({ kind: 'blur-light' }, hw)).toBe('hardware');
    expect(backgroundPath({ kind: 'blur-strong' }, hw)).toBe('hardware');
  });
  it('a picture is always our pipeline', () => expect(backgroundPath({ kind: 'image', imageId: 'bg-01' }, hw)).toBe('pipeline'));
  it('a picture without an id → off', () => expect(backgroundPath({ kind: 'image' }, on)).toBe('off'));
  it('hidden → off whatever is chosen', () => {
    expect(backgroundPath({ kind: 'blur-strong' }, { supported: false, hardwareBlur: true })).toBe('off');
    expect(backgroundPath({ kind: 'image', imageId: 'bg-01' }, { supported: false, hardwareBlur: false })).toBe('off');
  });
});

describe('hasHardwareBlur', () => {
  it('needs the constraint and a camera that can turn it on', () => {
    expect(hasHardwareBlur({ backgroundBlur: true }, { backgroundBlur: [false, true] })).toBe(true);
    expect(hasHardwareBlur({ backgroundBlur: true }, { backgroundBlur: [false] })).toBe(false);
    expect(hasHardwareBlur({ backgroundBlur: true }, {})).toBe(false);
    expect(hasHardwareBlur({}, { backgroundBlur: [true] })).toBe(false);
    expect(hasHardwareBlur(undefined, undefined)).toBe(false);
  });
});

describe('segmentStep: the rate budget of a 15 fps camera', () => {
  const run = (fps: number, cameraFps: number, frames: number): number => {
    let tokens = 0;
    let n = 0;
    for (let i = 0; i < frames; i++) {
      const s = segmentStep(tokens, 1000 / cameraFps, fps);
      tokens = s.tokens;
      if (s.run) n++;
    }
    return n;
  };
  it('15 fps camera, 12 fps budget → 12 segmentations a second', () => expect(run(12, 15, 150)).toBeGreaterThanOrEqual(118));
  it('never above the budget', () => expect(run(12, 15, 150)).toBeLessThanOrEqual(121));
  it('the default (20) at 30 fps → 20 a second; a 15 fps camera caps it at 15', () => {
    expect(SEG_FPS).toBe(20);
    expect(run(SEG_FPS, 30, 300)).toBeGreaterThanOrEqual(SEG_FPS * 10 - 2);
    expect(run(SEG_FPS, 15, 150)).toBeLessThanOrEqual(151);
  });
  it('30 fps camera → still the budget', () => expect(run(SEG_FPS, 30, 300)).toBeLessThanOrEqual(SEG_FPS * 10 + 1));
  it('software fallback → 6', () => expect(run(SEG_FPS_SOFTWARE, 15, 150)).toBeLessThanOrEqual(61));
  it('a long pause gives at most one extra frame, not a burst', () => {
    const a = segmentStep(0, 10_000, SEG_FPS);
    expect(a.run).toBe(true);
    const b = segmentStep(a.tokens, 1, SEG_FPS);
    expect(b.run).toBe(true);
    expect(segmentStep(b.tokens, 1, SEG_FPS).run).toBe(false);
  });
});

describe('segModel: multiclass on the GPU, landscape where it would cost too much (2.1)', () => {
  it('GPU delegate on a hardware GL → multiclass', () => expect(segModel({ delegate: 'GPU', software: false })).toBe('multiclass'));
  it('software GL (SwiftShader / WARP) → landscape', () => expect(segModel({ delegate: 'GPU', software: true })).toBe('landscape'));
  it('CPU delegate → landscape, whatever was asked', () => expect(segModel({ delegate: 'CPU', software: false, override: 'multiclass' })).toBe('landscape'));
  it('benchmark override on the GPU', () => expect(segModel({ delegate: 'GPU', software: false, override: 'landscape' })).toBe('landscape'));
  it('multiclass mask 0 is the background, soft edge 0.3–0.95', () => {
    expect(SEG_MODELS.multiclass).toEqual({ input: [256, 256], edge: [0.3, 0.95], invert: true });
    expect(SEG_MODELS.landscape.invert).toBe(false);
  });
});

describe('mask EMA', () => {
  it('12 fps → the new mask weighs ≈ 0.75', () => expect(emaAlpha(1000 / 12)).toBeCloseTo(0.75, 1));
  it('bounded: never frozen, never above 1', () => {
    expect(emaAlpha(1)).toBe(0.2);
    expect(emaAlpha(10_000)).toBe(1);
    expect(emaAlpha(0)).toBe(1);
    expect(emaAlpha(Number.NaN)).toBe(1);
  });
  it('converges to a steady mask', () => {
    let m = 0;
    for (let i = 0; i < 6; i++) m += (1 - m) * emaAlpha(83);
    expect(m).toBeGreaterThan(0.99);
  });
});

describe('person lost: hold the last mask 500 ms (ADR §6)', () => {
  it('holds right after a good mask', () => expect(maskHoldAllowed(1000, 1000 + MASK_HOLD_MS - 1)).toBe(true));
  it('lets go after 500 ms', () => expect(maskHoldAllowed(1000, 1000 + MASK_HOLD_MS)).toBe(false));
  it('never held before the first good mask', () => expect(maskHoldAllowed(null, 1000)).toBe(false));
});

describe('blur', () => {
  it('kernel is normalized and bounded', () => {
    for (const s of [0.5, 1, 3, 10]) {
      const k = gaussianKernel(s);
      const sum = k.reduce((a, b, i) => a + (i === 0 ? b : 2 * b), 0);
      expect(sum).toBeCloseTo(1, 6);
      expect(k.length).toBeLessThanOrEqual(13);
    }
  });
  it('σ in downscaled pixels: 720p strong = 3, light = 1; 360p halves it', () => {
    expect(blurSigma('blur-strong', 720)).toBe(3);
    expect(blurSigma('blur-light', 720)).toBe(1);
    expect(blurSigma('blur-strong', 360)).toBe(1.5);
  });
});

describe('uploads: 16:9 crop and limits', () => {
  it('a 4:3 photo loses top and bottom', () => expect(coverCrop(4000, 3000)).toEqual({ sx: 0, sy: 375, sw: 4000, sh: 2250 }));
  it('a panorama loses the sides', () => expect(coverCrop(3000, 1000)).toEqual({ sx: 611, sy: 0, sw: 1778, sh: 1000 }));
  it('16:9 as is', () => expect(coverCrop(1920, 1080)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 }));
  it('a broken image', () => expect(coverCrop(0, 10)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 }));
  it('type, size, count', () => {
    expect(uploadProblem({ type: 'image/png', size: 1000 }, 0)).toBeNull();
    expect(uploadProblem({ type: 'image/gif', size: 1000 }, 0)).toBe('type');
    expect(uploadProblem({ type: 'image/jpeg', size: 11 * 1024 * 1024 }, 0)).toBe('size');
    expect(uploadProblem({ type: 'image/webp', size: 1000 }, 5)).toBe('limit');
  });
  it('cover texture coordinates', () => {
    expect(coverUv(16 / 9, 16 / 9)).toEqual({ scale: [1, 1], offset: [0, 0] });
    const narrow = coverUv(16 / 9, 4 / 3);
    expect(narrow.scale[0]).toBeCloseTo(0.75);
    expect(narrow.offset[0]).toBeCloseTo(0.125);
  });
});

describe('workspace backgrounds (ADR-0035 addendum)', () => {
  it('ids round-trip through the ws: prefix', () => {
    const id = workspaceImageId('0190-abc');
    expect(isWorkspaceImage(id)).toBe(true);
    expect(workspaceBackgroundOf(id)).toBe('0190-abc');
    expect(isWorkspaceImage('custom:1')).toBe(false);
    expect(isWorkspaceImage('bg-01')).toBe(false);
    expect(workspaceBackgroundOf('bg-01')).toBe('');
  });

  it('only a chosen workspace background that is gone is stale', () => {
    const known = new Set(['a']);
    const exists = (id: string): boolean => known.has(id);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'ws:a' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'ws:b' }, exists)).toBe(true);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'bg-01' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'custom:x' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'blur-light' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'none' }, exists)).toBe(false);
  });
});

describe('nameFromFile', () => {
  it('drops the extension and control characters, keeps 40 characters', () => {
    expect(nameFromFile('Office.jpg')).toBe('Office');
    expect(nameFromFile('  logo.final.png ')).toBe('logo.final');
    expect(nameFromFile('a\u0001b.webp')).toBe('a b');
    expect(nameFromFile(`${'я'.repeat(50)}.png`)).toBe('я'.repeat(40));
  });
});

describe('errorText', () => {
  it('formats Errors, strings and events as one line', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('TypeError: Failed to fetch');
    expect(errorText('abort')).toBe('abort');
    expect(errorText({ type: 'error' })).toBe('event error');
    expect(errorText(42)).toBe('42');
  });
});

describe('backgroundUnavailable (owner 2.1: disabled with a reason, never hidden)', () => {
  it('a working desktop: available', () => expect(backgroundUnavailable(DESKTOP)).toBeNull());
  it('phone web first, then the browser, low-end, WebGL2, a failure in this session', () => {
    expect(backgroundUnavailable({ ...DESKTOP, mobile: true, breakoutBox: false })).toBe('mobile');
    expect(backgroundUnavailable({ ...DESKTOP, breakoutBox: false, webgl2: false })).toBe('browser');
    expect(backgroundUnavailable({ ...DESKTOP, lowEnd: true })).toBe('lowEnd');
    expect(backgroundUnavailable({ ...DESKTOP, webgl2: false })).toBe('webgl');
    expect(backgroundUnavailable({ ...DESKTOP, failed: true })).toBe('failed');
    expect(backgroundSupported({ ...DESKTOP, failed: true })).toBe(false);
  });
});

describe('runtime failure → fallback (owner 2.1: never «selected but not shown»)', () => {
  const fx = { touchUp: true, touchUpStrength: 40, lowLight: true };
  const off = { touchUp: false, touchUpStrength: 40, lowLight: false };
  it('classifies the worker detail', () => {
    expect(failureKind('webgl2: Error: webgl2 unavailable')).toBe('webgl');
    expect(failureKind('worker: script error')).toBe('worker');
    expect(failureKind('effects: Error: x')).toBe('effects');
    expect(failureKind('frames: Error: no mask from the segmenter after 24 runs')).toBe('frames');
    expect(failureKind('segmenter: TypeError: Failed to fetch')).toBe('model');
    expect(failureKind(undefined)).toBe('model');
  });
  it('a model / frames failure resets the background only', () => {
    expect(failureFallback('model', { kind: 'image', imageId: 'bg-01' }, fx)).toEqual({ cameraBackground: { kind: 'none' } });
    expect(failureFallback('frames', { kind: 'blur-strong' }, off)).toEqual({ cameraBackground: { kind: 'none' } });
    expect(failureStopsEffects('model')).toBe(false);
  });
  it('a GL / worker failure resets the effects too', () => {
    expect(failureFallback('webgl', { kind: 'blur-light' }, fx)).toEqual({ cameraBackground: { kind: 'none' }, cameraEffects: off });
    expect(failureFallback('worker', { kind: 'none' }, fx)).toEqual({ cameraEffects: off });
  });
  it('nothing chosen that failed: nothing to reset', () => {
    expect(failureFallback('model', { kind: 'none' }, fx)).toBeNull();
    expect(failureFallback('webgl', { kind: 'none' }, off)).toBeNull();
  });
});

describe('segmentation rate setting', () => {
  it('options are 8 / 16 / 20 / 25, default 20', () => {
    expect([...SEG_FPS_OPTIONS]).toEqual([8, 16, 20, 25]);
    expect(SEG_FPS).toBe(20);
  });
  it('normalizeSegFps: valid kept, anything else → 20', () => {
    for (const o of SEG_FPS_OPTIONS) expect(normalizeSegFps(o)).toBe(o);
    for (const bad of [undefined, null, 0, 15, 30, '20', NaN, {}]) expect(normalizeSegFps(bad)).toBe(20);
  });
  it('effectiveSegFps: the setting on the GPU, always 6 on the fallback', () => {
    for (const o of SEG_FPS_OPTIONS) {
      expect(effectiveSegFps(o, false)).toBe(o);
      expect(effectiveSegFps(o, true)).toBe(SEG_FPS_SOFTWARE);
    }
  });
  it('the camera rate still caps the setting (token bucket)', () => {
    const run = (fps: number, cameraFps: number, frames: number): number => {
      let tokens = 0;
      let n = 0;
      for (let i = 0; i < frames; i++) {
        const st = segmentStep(tokens, 1000 / cameraFps, fps);
        tokens = st.tokens;
        if (st.run) n++;
      }
      return n;
    };
    expect(run(25, 15, 150)).toBeLessThanOrEqual(151);
    expect(run(8, 30, 300)).toBeLessThanOrEqual(8 * 10 + 1);
  });
});
