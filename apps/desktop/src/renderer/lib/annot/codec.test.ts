import { create, toBinary } from '@bufbuild/protobuf';
import { AnnotKind, AnnotMessageSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_BYTES, MAX_POINTS, decodeAnnot, encodeAnnot, type AnnotWire } from './codec';

const base: AnnotWire = { streamSid: 'TR_screen1', kind: 'stroke', color: 0xff453a, points: [0.1, 0.2, 0.3, 0.4], seq: 7, strokeId: 42, strokeEnd: false, allow: false };

describe('annot codec', () => {
  it('round-trips every kind (float32 points stay within rounding)', () => {
    for (const m of [
      base,
      { ...base, kind: 'pointer' as const, points: [0.5, 0.25] },
      { ...base, kind: 'clear' as const, points: [] },
      { ...base, kind: 'policy' as const, points: [], allow: true },
      { ...base, points: [], strokeEnd: true },
    ]) {
      const bytes = encodeAnnot(m);
      expect(bytes).not.toBeNull();
      const back = decodeAnnot(bytes ?? new Uint8Array());
      expect(back).not.toBeNull();
      expect({ ...back, points: [] }).toEqual({ ...m, points: [] });
      back?.points.forEach((v, i) => expect(v).toBeCloseTo(m.points[i] ?? -1, 6));
    }
  });

  it('keeps a full batch under 1 KiB', () => {
    const points = Array.from({ length: MAX_POINTS * 2 }, (_, i) => (i % 97) / 97);
    const bytes = encodeAnnot({ ...base, points, seq: 0xffffffff, strokeId: 0xffffffff, streamSid: 'TR_' + 'x'.repeat(61) });
    expect(bytes).not.toBeNull();
    expect(bytes?.length).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('refuses to encode invalid messages', () => {
    expect(encodeAnnot({ ...base, points: [0.1] })).toBeNull(); // odd
    expect(encodeAnnot({ ...base, points: [0.1, 1.5] })).toBeNull(); // out of the frame
    expect(encodeAnnot({ ...base, points: [Number.NaN, 0.1] })).toBeNull();
    expect(encodeAnnot({ ...base, points: new Array<number>((MAX_POINTS + 1) * 2).fill(0.5) })).toBeNull();
    expect(encodeAnnot({ ...base, kind: 'pointer', points: [0.1, 0.1, 0.2, 0.2] })).toBeNull();
    expect(encodeAnnot({ ...base, streamSid: '' })).toBeNull();
    expect(encodeAnnot({ ...base, color: 0x1000000 })).toBeNull();
  });

  it('drops malformed and oversized packets', () => {
    expect(decodeAnnot(new Uint8Array())).toBeNull();
    expect(decodeAnnot(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBeNull(); // not protobuf
    expect(decodeAnnot(new Uint8Array(MAX_BYTES + 1))).toBeNull();
    const raw = (m: Parameters<typeof create<typeof AnnotMessageSchema>>[1]): Uint8Array => toBinary(AnnotMessageSchema, create(AnnotMessageSchema, m));
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: AnnotKind.UNSPECIFIED }))).toBeNull();
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: 99 as unknown as AnnotKind }))).toBeNull();
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: AnnotKind.STROKE, points: [0.1, -0.2] }))).toBeNull();
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: AnnotKind.STROKE, points: [0.1, 0.2, 0.3] }))).toBeNull();
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: AnnotKind.POINTER, points: [] }))).toBeNull();
    expect(decodeAnnot(raw({ streamSid: '', kind: AnnotKind.CLEAR }))).toBeNull();
    // 61 points pass protobuf but not the cap.
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: AnnotKind.STROKE, points: new Array<number>(122).fill(0.5) }))).toBeNull();
    expect(decodeAnnot(raw({ streamSid: 'TR_1', kind: AnnotKind.STROKE, points: [0.1, 0.2], strokeId: 1 }))).not.toBeNull();
  });
});
