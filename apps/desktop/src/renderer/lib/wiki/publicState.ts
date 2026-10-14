import { decodeFrame, FRAME_SNAPSHOT, FRAME_UPDATE } from './frames';

/**
 * The body of `GET /api/public/wiki/{code}/state` (ADR-0096 §6, docs/05): records of a uint32
 * big-endian length and one sync frame — a SNAPSHOT first, then an UPDATE per stored update. The
 * result is the Yjs updates in order (the snapshot's state first); Yjs merges them. Anything
 * truncated or unknown throws: a half document must never be shown as the page.
 */
export function stateUpdates(body: Uint8Array): Uint8Array[] {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + 4 > body.length) throw new Error('truncated state record');
    const len = dv.getUint32(at);
    at += 4;
    if (at + len > body.length) throw new Error('truncated state frame');
    const f = decodeFrame(body.subarray(at, at + len));
    at += len;
    if (!f) throw new Error('bad state frame');
    if (f.type === FRAME_SNAPSHOT) {
      if (f.state.length) out.push(f.state);
    } else if (f.type === FRAME_UPDATE) out.push(f.update);
    else throw new Error('unexpected state frame');
  }
  return out;
}
