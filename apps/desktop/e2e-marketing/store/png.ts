import { deflateSync, inflateSync, crc32 } from 'node:zlib';

/** Minimal PNG helpers for the store assets (8-bit, non-interlaced, as Chromium writes them): no image library needed. */
export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: number;
  interlace: number;
  /** A tRNS chunk makes a palette / RGB image transparent. */
  hasTrns: boolean;
}

export function pngInfo(buf: Buffer): PngInfo {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let hasTrns = false;
  for (let o = 8; o + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'tRNS') hasTrns = true;
    o += 12 + len;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24] ?? 0, colorType: buf[25] ?? 0, interlace: buf[28] ?? 0, hasTrns };
}

export const hasAlpha = (i: PngInfo): boolean => i.colorType === 4 || i.colorType === 6 || i.hasTrns;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA → RGB (8-bit): the alpha is composited over `bg` (opaque input stays byte-identical). */
export function stripAlpha(buf: Buffer, bg: [number, number, number] = [0, 0, 0]): Buffer {
  const info = pngInfo(buf);
  if (info.bitDepth !== 8 || info.interlace !== 0) throw new Error('stripAlpha: only 8-bit non-interlaced PNGs');
  if (info.colorType === 2 && !info.hasTrns) return buf;
  if (info.colorType !== 6 && info.colorType !== 2) throw new Error(`stripAlpha: color type ${info.colorType} is not supported`);
  const bpp = info.colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let o = 8; o + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = info.width * bpp;
  const px = Buffer.alloc(stride * info.height);
  for (let y = 0; y < info.height; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= bpp ? (px[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (px[(y - 1) * stride + x - bpp] ?? 0) : 0;
      let v = cur;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const out = Buffer.alloc((info.width * 3 + 1) * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = y * stride + x * bpp;
      const al = bpp === 4 ? (px[i + 3] ?? 255) / 255 : 1;
      for (let ch = 0; ch < 3; ch++) out[y * (info.width * 3 + 1) + 1 + x * 3 + ch] = Math.round((px[i + ch] ?? 0) * al + (bg[ch] ?? 0) * (1 - al));
    }
  }
  const ihdr = Buffer.from(buf.subarray(16, 29));
  ihdr[9] = 2;
  return Buffer.concat([buf.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
