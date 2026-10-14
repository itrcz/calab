import { describe, expect, it } from 'vitest';
import { encodeSnapshot, encodeUpdate } from './frames';
import { stateUpdates } from './publicState';

const rec = (frame: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + frame.length);
  new DataView(out.buffer).setUint32(0, frame.length);
  out.set(frame, 4);
  return out;
};
const cat = (...a: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of a) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

describe('stateUpdates', () => {
  it('returns the snapshot state and the updates in order', () => {
    const body = cat(rec(encodeSnapshot(3, Uint8Array.of(1, 2))), rec(encodeUpdate(Uint8Array.of(3), 4)), rec(encodeUpdate(Uint8Array.of(4, 5), 5)));
    expect(stateUpdates(body).map((u) => [...u])).toEqual([[1, 2], [3], [4, 5]]);
  });
  it('skips the empty state of a page without a snapshot', () => {
    expect(stateUpdates(rec(encodeSnapshot(0, new Uint8Array())))).toEqual([]);
    expect(stateUpdates(new Uint8Array())).toEqual([]);
  });
  it('throws on a truncated body', () => {
    const body = cat(rec(encodeSnapshot(0, Uint8Array.of(1, 2, 3))));
    expect(() => stateUpdates(body.subarray(0, body.length - 1))).toThrow();
    expect(() => stateUpdates(Uint8Array.of(0, 0))).toThrow();
  });
});
