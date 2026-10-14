import { describe, expect, it, vi } from 'vitest';
import { ACH_MAX_BYTES, hasTransparentBackground, prepareAchievementImage, sidesOk, type AlphaCodec } from './achievementPrepare';

/** A PNG header with the given size (IHDR width / height at 16 / 20, big-endian). */
function png(width: number, height: number, total = 1000): Blob & { name: string } {
  const b = new Uint8Array(Math.max(total, 32));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return Object.assign(new Blob([b], { type: 'image/png' }), { name: 'medal.png' });
}

const rgba = (alphas: number[]): Uint8ClampedArray => new Uint8ClampedArray(alphas.flatMap((a) => [10, 20, 30, a]));

function codec(width: number, height: number, alphas: number[] | null) {
  const close = vi.fn();
  const c: AlphaCodec = { decode: () => Promise.resolve({ width, height, pixels: () => (alphas ? rgba(alphas) : null), close }) };
  return { c, close };
}

describe('hasTransparentBackground', () => {
  it('needs a visible share of transparent pixels', () => {
    expect(hasTransparentBackground(rgba([255, 255, 255, 255]))).toBe(false);
    expect(hasTransparentBackground(rgba([0, 255, 255, 255]))).toBe(true);
    expect(hasTransparentBackground(rgba([...Array<number>(999).fill(255), 0]))).toBe(false); // 0.1 %
    expect(hasTransparentBackground(rgba([]))).toBe(false);
  });
});

describe('sidesOk', () => {
  it('128..2048 each side', () => {
    expect(sidesOk(512, 512)).toBe(true);
    expect(sidesOk(127, 512)).toBe(false);
    expect(sidesOk(512, 2049)).toBe(false);
  });
});

describe('prepareAchievementImage', () => {
  it('accepts a transparent PNG as is', async () => {
    const { c, close } = codec(1254, 1254, [0, 0, 255, 255]);
    const f = png(1254, 1254);
    expect(await prepareAchievementImage(f, c)).toMatchObject({ ok: true, file: f, name: 'medal.png', opaque: false });
    expect(close).toHaveBeenCalled();
  });
  it('warns about an opaque background, still lets the server decide', async () => {
    expect(await prepareAchievementImage(png(512, 512), codec(512, 512, [255, 255]).c)).toMatchObject({ ok: true, opaque: true });
  });
  it('refuses JPEG / other, too heavy, wrong sides, broken', async () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0])]);
    expect(await prepareAchievementImage(jpeg, codec(512, 512, [0]).c)).toEqual({ ok: false, reason: 'unsupported' });
    expect(await prepareAchievementImage(png(512, 512, ACH_MAX_BYTES + 1), codec(512, 512, [0]).c)).toEqual({ ok: false, reason: 'tooHeavy' });
    expect(await prepareAchievementImage(png(100, 100), codec(100, 100, [0]).c)).toEqual({ ok: false, reason: 'sides' });
    expect(await prepareAchievementImage(png(512, 512), { decode: () => Promise.resolve(null) })).toEqual({ ok: false, reason: 'broken' });
  });
});
