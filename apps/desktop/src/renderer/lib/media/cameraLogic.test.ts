import { ScreenSharePreset } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { cameraCapture, cameraLayers, grantedCameraQuality } from './cameraLogic';
import { CAMERA_LAYERS, canFlipCamera, cameraMirrored, cameraTarget, otherFacing, CPU_LIMIT_SAMPLES, isChromium, cameraBlock, cameraWanted, cameraNext, camerasFull, cpuLimitStep, type CameraEvent, type CameraPhase } from './cameraLogic';

describe('camera layers (docs/09 #41)', () => {
  it('180p / 360p / 720p with 0.15 / 0.5 / 1.5 Mbps ceilings at 24–30 fps', () => {
    expect(CAMERA_LAYERS.map((l) => `${l.width}x${l.height}`)).toEqual(['320x180', '640x360', '1280x720']);
    expect(CAMERA_LAYERS.map((l) => l.maxBitrate)).toEqual([150_000, 500_000, 1_500_000]);
    for (const l of CAMERA_LAYERS) {
      expect(l.fps).toBeGreaterThanOrEqual(24);
      expect(l.fps).toBeLessThanOrEqual(30);
    }
  });
});

describe('camera quality (ADR-0024)', () => {
  it('1080p: 1920×1080 capture, the top layer 1080p; the granted fps caps every layer', () => {
    expect(cameraCapture({ height: 1080, fps: 0 })).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(cameraCapture({ height: 720, fps: 15 })).toEqual({ width: 1280, height: 720, fps: 15 });
    expect(cameraLayers({ height: 1080, fps: 0 }).map((l) => l.height)).toEqual([180, 360, 1080]);
    expect(cameraLayers({ height: 720, fps: 15 }).map((l) => l.fps)).toEqual([15, 15, 15]);
  });

  it('the server grant wins; UNSPECIFIED / 0 keeps what was asked', () => {
    const { H720, H1080, UNSPECIFIED } = ScreenSharePreset;
    expect(grantedCameraQuality(H1080, { preset: H720, fps: 15 })).toEqual({ height: 720, fps: 15 });
    expect(grantedCameraQuality(H1080, { preset: UNSPECIFIED, fps: 0 })).toEqual({ height: 1080, fps: 0 });
    expect(grantedCameraQuality(H720, undefined)).toEqual({ height: 720, fps: 0 });
  });
});

describe('isChromium', () => {
  it('Electron / Chrome yes, Firefox / Safari no', () => {
    expect(isChromium('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Electron/44.4.5 Safari/537.36')).toBe(true);
    expect(isChromium('Mozilla/5.0 (Macintosh; rv:143.0) Gecko/20100101 Firefox/143.0')).toBe(false);
    expect(isChromium('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15')).toBe(false);
  });
});

describe('cameraNext', () => {
  const run = (from: CameraPhase, ...evs: CameraEvent[]): CameraPhase => evs.reduce(cameraNext, from);

  it('happy path: off → starting → on → stopping → off', () => {
    expect(run('off', 'request')).toBe('starting');
    expect(run('off', 'request', 'published')).toBe('on');
    expect(run('off', 'request', 'published', 'stop')).toBe('stopping');
    expect(run('off', 'request', 'published', 'stop', 'stopped')).toBe('off');
  });

  it('409 / publish failure returns to off', () => {
    expect(run('off', 'request', 'failed')).toBe('off');
  });

  it('turning it off while it is starting waits for the stop', () => {
    expect(run('off', 'request', 'stop')).toBe('stopping');
    // A late «published» must not bring it back on.
    expect(run('off', 'request', 'stop', 'published')).toBe('stopping');
    expect(run('off', 'request', 'stop', 'published', 'stopped')).toBe('off');
  });

  it('server stop and leaving the call win from any phase', () => {
    for (const p of ['off', 'starting', 'on', 'stopping'] as const) {
      expect(cameraNext(p, 'server-stop')).toBe('off');
      expect(cameraNext(p, 'left')).toBe('off');
    }
  });

  it('ignores events that do not apply', () => {
    expect(cameraNext('off', 'published')).toBe('off');
    expect(cameraNext('off', 'stop')).toBe('off');
    expect(cameraNext('on', 'request')).toBe('on');
  });
});

describe('cameraBlock / camerasFull (limits)', () => {
  const base = { connected: true, canVideo: true, limit: 6, phase: 'off' as const };
  it('enabled in a call with VIDEO and a non-zero limit', () => {
    expect(cameraBlock(base)).toBeNull();
  });
  it('reasons: not connected, cameras off in the room, no VIDEO', () => {
    expect(cameraBlock({ ...base, connected: false })).toBe('not-connected');
    expect(cameraBlock({ ...base, limit: 0, canVideo: false })).toBe('room-off');
    expect(cameraBlock({ ...base, canVideo: false })).toBe('no-permission');
  });
  it('a live camera can always be turned off', () => {
    expect(cameraBlock({ ...base, canVideo: false, limit: 0, phase: 'on' })).toBeNull();
  });
  it('full when the others already use every slot', () => {
    expect(camerasFull(6, 6, false)).toBe(true);
    expect(camerasFull(5, 6, false)).toBe(false);
    expect(camerasFull(6, 6, true)).toBe(false);
    expect(camerasFull(3, 0, false)).toBe(false);
  });
});

describe('cameraWanted (subscriptions)', () => {
  it('all cameras but the hidden ones', () => {
    expect([...cameraWanted(['a', 'b', 'c'], { hidden: { b: true }, saveTraffic: false, primary: null })]).toEqual(['a', 'c']);
  });
  it('save traffic: only the primary, never a hidden one', () => {
    expect([...cameraWanted(['a', 'b'], { hidden: {}, saveTraffic: true, primary: 'b' })]).toEqual(['b']);
    expect([...cameraWanted(['a', 'b'], { hidden: { b: true }, saveTraffic: true, primary: 'b' })]).toEqual([]);
    expect([...cameraWanted(['a'], { hidden: {}, saveTraffic: true, primary: null })]).toEqual([]);
  });
  it('never my own camera from another device (review L9)', () => {
    expect([...cameraWanted(['me', 'a'], { hidden: {}, saveTraffic: false, primary: null, me: 'me' })]).toEqual(['a']);
  });
});

describe('cpuLimitStep', () => {
  it(`drops to 360p after ${CPU_LIMIT_SAMPLES} CPU-limited samples in a row, once`, () => {
    let c = 0;
    const out: boolean[] = [];
    for (const cpu of [true, true, false, true, true, true, true]) {
      const r = cpuLimitStep(c, cpu);
      c = r.count;
      out.push(r.limit);
    }
    expect(out).toEqual([false, false, false, false, false, true, false]);
  });
});

describe('phone camera side', () => {
  it('offers the flip only on touch with two or more inputs', () => {
    expect(canFlipCamera(2, true)).toBe(true);
    expect(canFlipCamera(1, true)).toBe(false);
    expect(canFlipCamera(3, false)).toBe(false);
  });
  it('flips front <-> back and mirrors only the front one', () => {
    expect(otherFacing(null)).toBe('environment');
    expect(otherFacing('environment')).toBe('user');
    expect(otherFacing('user')).toBe('environment');
    expect(cameraMirrored(null)).toBe(true);
    expect(cameraMirrored('user')).toBe(true);
    expect(cameraMirrored('environment')).toBe(false);
  });
  it('a chosen device wins over the side; no choice adds nothing', () => {
    expect(cameraTarget('d1', 'environment')).toEqual({ deviceId: { exact: 'd1' } });
    expect(cameraTarget(null, 'environment')).toEqual({ facingMode: 'environment' });
    expect(cameraTarget(null, null)).toEqual({});
  });
});
