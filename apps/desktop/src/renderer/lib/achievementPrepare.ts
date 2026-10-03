/**
 * An achievement picture before the upload (ADR-0061 §2, superadmin «Ачивки»): the server takes a
 * PNG or WebP with a transparent background, ≤ 4 MB, each side 128..2048, and makes the 512×512
 * WebP itself. The client checks the same before sending — the type by the header, the size, the
 * sides — and reads the picture into a small canvas to see whether any of it is transparent: an
 * opaque background is only a warning («фон не прозрачный»), the server decides (422
 * IMAGE_NEEDS_ALPHA). The decisions are pure and unit-tested; decoding is the thin `browserAlpha`.
 */
import { sniffImage } from './stickerPrepare';

export const ACH_MAX_BYTES = 4 * 1024 * 1024;
export const ACH_MIN_SIDE = 128;
export const ACH_MAX_SIDE = 2048;
/** `accept` of the file dialog. */
export const ACH_ACCEPT = '.png,.webp,image/png,image/webp';
/** The probe canvas: the longer side (enough to see a transparent background). */
export const PROBE_SIDE = 128;
/** A pixel counts as transparent below this alpha (0..255). */
export const ALPHA_CUTOFF = 16;
/** …and the picture has a transparent background when at least this share of pixels is. */
export const TRANSPARENT_SHARE = 0.01;

export type AchievementReject = 'unsupported' | 'tooHeavy' | 'sides' | 'broken';

export type AchievementPrepareResult =
  | { ok: true; file: Blob; name: string; width: number; height: number; /** No transparent pixels: warn. */ opaque: boolean }
  | { ok: false; reason: AchievementReject };

/** RGBA pixels: is a visible share of them transparent? */
export function hasTransparentBackground(rgba: ArrayLike<number>, cutoff = ALPHA_CUTOFF, share = TRANSPARENT_SHARE): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return false;
  let clear = 0;
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 255) < cutoff) clear++;
  return clear / n >= share;
}

export const sidesOk = (w: number, h: number): boolean => w >= ACH_MIN_SIDE && h >= ACH_MIN_SIDE && w <= ACH_MAX_SIDE && h <= ACH_MAX_SIDE;

export interface AlphaImage {
  width: number;
  height: number;
  /** RGBA of the picture scaled to ≤ `side` on the longer side; null when it cannot be read. */
  pixels(side: number): Uint8ClampedArray | null;
  close(): void;
}

export interface AlphaCodec {
  decode(file: Blob): Promise<AlphaImage | null>;
}

export const browserAlpha: AlphaCodec = {
  async decode(file) {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file, { premultiplyAlpha: 'none' });
    } catch {
      return null;
    }
    return {
      width: bmp.width,
      height: bmp.height,
      pixels(side) {
        const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * k));
        const h = Math.max(1, Math.round(bmp.height * k));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(bmp, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
      },
      close: () => bmp.close(),
    };
  },
};

/** Checks a picked / dropped file; the file itself is sent as is (the server re-encodes it). */
export async function prepareAchievementImage(file: Blob & { name?: string }, codec: AlphaCodec = browserAlpha): Promise<AchievementPrepareResult> {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const sniff = sniffImage(head);
  if (sniff.kind !== 'png' && sniff.kind !== 'webp') return { ok: false, reason: 'unsupported' };
  if (sniff.animated) return { ok: false, reason: 'unsupported' };
  if (file.size > ACH_MAX_BYTES) return { ok: false, reason: 'tooHeavy' };
  const img = await codec.decode(file);
  if (!img) return { ok: false, reason: 'broken' };
  try {
    if (!img.width || !img.height) return { ok: false, reason: 'broken' };
    if (!sidesOk(img.width, img.height)) return { ok: false, reason: 'sides' };
    const px = img.pixels(PROBE_SIDE);
    const opaque = px ? !hasTransparentBackground(px) : false;
    const name = file.name || (sniff.kind === 'png' ? 'achievement.png' : 'achievement.webp');
    return { ok: true, file, name, width: img.width, height: img.height, opaque };
  } finally {
    img.close();
  }
}
