import { describe, expect, it } from 'vitest';
import type { InboundVideoStats, OutboundVideoLayer } from './stats';
import { MINOR_LOG_MS, MISMATCH_GRACE_MS, PublisherDiag, VIEWER_LOG_MS, ViewerDiag, requestedRids } from './streamDiag';

function layer(rid: string, o: Partial<OutboundVideoLayer> = {}): OutboundVideoLayer {
  return {
    rid,
    codec: 'H264',
    profile: 'High',
    encoder: 'VideoToolbox',
    powerEfficient: true,
    width: rid === 'q' ? 552 : 1104,
    height: rid === 'q' ? 360 : 720,
    fps: 15,
    kbps: 100,
    targetKbps: rid === 'q' ? 250 : 1800,
    qualityLimitation: 'none',
    scalabilityMode: null,
    active: true,
    rttMs: 20,
    ...o,
  };
}

describe('requestedRids', () => {
  it('maps the first codec\'s enabled qualities to rids', () => {
    const codecs = [{ codec: 'h264', qualities: [{ quality: 0, enabled: true }, { quality: 1, enabled: true }, { quality: 2, enabled: false }] }];
    expect(requestedRids(codecs)).toEqual(['h', 'q']);
    expect(requestedRids([{ codec: 'h264', qualities: [{ quality: 0, enabled: false }] }])).toEqual([]);
    expect(requestedRids(undefined)).toEqual([]);
  });
});

describe('PublisherDiag', () => {
  it('logs the first state, then only changes', () => {
    const d = new PublisherDiag();
    const line = d.tick([layer('q'), layer('h')], 0);
    expect(line).toBe('stream out: h:on 1104x720@15 t1800k | q:on 552x360@15 t250k | lim=none | sfu=?');
    expect(d.tick([layer('q'), layer('h', { fps: 14.6, targetKbps: 1750 })], 2000)).toBeNull();
  });

  it('logs a layer switching off or a new limitation at once', () => {
    const d = new PublisherDiag();
    d.tick([layer('q'), layer('h')], 0);
    expect(d.tick([layer('q'), layer('h', { active: false })], 2000)).toBe('stream out: h:off | q:on 552x360@15 t250k | lim=none | sfu=?');
    expect(d.tick([layer('q', { qualityLimitation: 'bandwidth' }), layer('h', { active: false })], 4000)).toContain('lim=bandwidth');
  });

  it('logs fps / target changes at most every MINOR_LOG_MS', () => {
    const d = new PublisherDiag();
    d.tick([layer('q'), layer('h')], 0);
    expect(d.tick([layer('q'), layer('h', { targetKbps: 600 })], 2000)).toBeNull();
    expect(d.tick([layer('q'), layer('h', { targetKbps: 600 })], MINOR_LOG_MS)).toContain('h:on 1104x720@15 t600k');
  });

  it('records the SFU request (deduped) and flags a persistent mismatch with the encoder', () => {
    const d = new PublisherDiag();
    expect(d.request(['h', 'q'], 0)).toBe('stream: SFU requests h,q');
    expect(d.request(['h', 'q'], 100)).toBeNull();
    const stuck = [layer('q'), layer('h', { active: false })];
    expect(d.tick(stuck, 2000)).toBe('stream out: h:off | q:on 552x360@15 t250k | lim=none | sfu=h,q');
    expect(d.tick(stuck, MISMATCH_GRACE_MS)).toBe('stream out: h:off | q:on 552x360@15 t250k | lim=none | sfu=h,q | MISMATCH');
    expect(d.tick(stuck, MISMATCH_GRACE_MS + 2000)).toBeNull();
    expect(d.request([], 10_000)).toBe('stream: SFU requests none');
  });

  it('starts over after reset', () => {
    const d = new PublisherDiag();
    d.tick([layer('q')], 0);
    d.reset();
    expect(d.tick([layer('q')], 100)).not.toBeNull();
    expect(d.tick([], 200)).toBeNull();
  });
});

describe('ViewerDiag', () => {
  const rx = (width: number, height: number): InboundVideoStats => ({
    kbps: 900,
    codec: 'H264',
    profile: 'High',
    decoder: 'VideoToolbox',
    powerEfficient: true,
    width,
    height,
    fps: 15,
    packetsLost: 0,
    framesDropped: 0,
    jitterMs: 5,
  });

  it('logs the received size on change, rate-limited, catching up after the window', () => {
    const d = new ViewerDiag();
    expect(d.tick('TR_a', rx(552, 360), 0)).toBe('stream in: TR_a 552x360@15 H264 900k');
    expect(d.tick('TR_a', rx(552, 360), 2000)).toBeNull();
    expect(d.tick('TR_a', rx(1104, 720), 4000)).toBeNull(); // inside the window
    expect(d.tick('TR_a', rx(1104, 720), VIEWER_LOG_MS)).toBe('stream in: TR_a 1104x720@15 H264 900k (was 552x360)');
  });

  it('starts over for another stream and ignores ticks without stats', () => {
    const d = new ViewerDiag();
    d.tick('TR_a', rx(552, 360), 0);
    expect(d.tick('TR_b', null, 1000)).toBeNull();
    expect(d.tick('TR_b', rx(552, 360), 2000)).toBe('stream in: TR_b 552x360@15 H264 900k');
  });
});
