/**
 * Wiki sync frames (ADR-0096 §4): binary WebSocket messages on `GET /api/wiki/pages/{id}/sync`.
 * The first byte is the type; integers are big-endian.
 *
 *   0 SNAPSHOT        server → client  u8 0 | u64 through_seq | state (Y.encodeStateAsUpdate)
 *   1 UPDATE          both ways        u8 1 | u64 seq | update   (client → server: seq = 0, the server assigns it)
 *   2 AWARENESS       both ways        u8 2 | y-protocols awareness update (ephemeral, never stored)
 *   3 COMPACT_REQUEST server → client  u8 3
 *   4 SNAPSHOT_POST   client → server  u8 4 | u64 through_seq | u32 meta_len | meta (UTF-8 JSON
 *                                      {plain_text, title, preview, broadcast?}) | state
 *
 * A SNAPSHOT_POST is a silent compaction: the server stores it and sends nothing back. Only with
 * `broadcast: true` — the state carries an edit no UPDATE carried (one transaction above the
 * frame limit) — does the server relay the state as a SNAPSHOT to the page's other sockets (a
 * stale broadcast post: relayed with through_seq 0, not stored, and the poster gets
 * COMPACT_REQUEST). The server takes ≤ 2 posts at once, then one per 2 s per socket (over: 4008);
 * the client spaces its posts by SNAPSHOT_GAP_MS.
 *
 * On connect the server always sends one SNAPSHOT first (through_seq 0 and an empty state for a
 * page without one), then every UPDATE after it; the client treats the SNAPSHOT as «synced».
 * Auth (like the gateway, in-band): the client's first message is a text frame with the access
 * token; the server closes 4004 when it is bad, 4003 without WIKI_VIEW, 4404 for no page.
 * Frames other than SNAPSHOT/SNAPSHOT_POST are ≤ 64 KiB; a snapshot is ≤ 2 MiB (+ meta).
 */

export const FRAME_SNAPSHOT = 0;
export const FRAME_UPDATE = 1;
export const FRAME_AWARENESS = 2;
export const FRAME_COMPACT_REQUEST = 3;
export const FRAME_SNAPSHOT_POST = 4;

/** Inbound frame limit of the server for UPDATE / AWARENESS (whole frame, header included). */
export const MAX_FRAME = 64 * 1024;
/** Largest Yjs state a snapshot may carry (the server rejects bigger ones; the client warns). */
export const MAX_STATE = 2 * 1024 * 1024;
/** Bytes before the update in an UPDATE frame. */
export const UPDATE_HEADER = 9;

export interface SnapshotMeta {
  plain_text: string;
  title: string;
  preview: string;
}

export type Frame =
  | { type: typeof FRAME_SNAPSHOT; throughSeq: number; state: Uint8Array }
  | { type: typeof FRAME_UPDATE; seq: number; update: Uint8Array }
  | { type: typeof FRAME_AWARENESS; update: Uint8Array }
  | { type: typeof FRAME_COMPACT_REQUEST }
  | {
      type: typeof FRAME_SNAPSHOT_POST;
      throughSeq: number;
      meta: SnapshotMeta;
      broadcast: boolean;
      state: Uint8Array;
    };

function withSeq(type: number, seq: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + body.length);
  out[0] = type;
  new DataView(out.buffer).setBigUint64(
    1,
    BigInt(Math.max(0, Math.floor(seq))),
  );
  out.set(body, 9);
  return out;
}

export function encodeUpdate(update: Uint8Array, seq = 0): Uint8Array {
  return withSeq(FRAME_UPDATE, seq, update);
}

export function encodeSnapshot(
  throughSeq: number,
  state: Uint8Array,
): Uint8Array {
  return withSeq(FRAME_SNAPSHOT, throughSeq, state);
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + update.length);
  out[0] = FRAME_AWARENESS;
  out.set(update, 1);
  return out;
}

export function encodeCompactRequest(): Uint8Array {
  return Uint8Array.of(FRAME_COMPACT_REQUEST);
}

/** broadcast: the state carries an edit no UPDATE carried; the server relays it to the other sockets. */
export function encodeSnapshotPost(
  throughSeq: number,
  meta: SnapshotMeta,
  state: Uint8Array,
  broadcast = false,
): Uint8Array {
  const body: Record<string, unknown> = {
    plain_text: meta.plain_text,
    title: meta.title,
    preview: meta.preview,
  };
  if (broadcast) body["broadcast"] = true;
  const json = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(13 + json.length + state.length);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_SNAPSHOT_POST;
  dv.setBigUint64(1, BigInt(Math.max(0, Math.floor(throughSeq))));
  dv.setUint32(9, json.length);
  out.set(json, 13);
  out.set(state, 13 + json.length);
  return out;
}

/** Decodes one frame; null for an unknown type or a truncated frame (the caller ignores it). */
export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < 1) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = data[0];
  const seqAt = (): number => Number(dv.getBigUint64(1));
  switch (type) {
    case FRAME_SNAPSHOT:
      return data.length < 9
        ? null
        : { type, throughSeq: seqAt(), state: data.subarray(9) };
    case FRAME_UPDATE:
      return data.length < 9
        ? null
        : { type, seq: seqAt(), update: data.subarray(9) };
    case FRAME_AWARENESS:
      return { type, update: data.subarray(1) };
    case FRAME_COMPACT_REQUEST:
      return { type };
    case FRAME_SNAPSHOT_POST: {
      if (data.length < 13) return null;
      const len = dv.getUint32(9);
      if (13 + len > data.length) return null;
      let meta: SnapshotMeta;
      let broadcast: boolean;
      try {
        const m = JSON.parse(
          new TextDecoder().decode(data.subarray(13, 13 + len)),
        ) as Record<string, unknown>;
        const s = (v: unknown): string => (typeof v === "string" ? v : "");
        meta = {
          plain_text: s(m["plain_text"]),
          title: s(m["title"]),
          preview: s(m["preview"]),
        };
        broadcast = m["broadcast"] === true;
      } catch {
        return null;
      }
      return {
        type,
        throughSeq: seqAt(),
        meta,
        broadcast,
        state: data.subarray(13 + len),
      };
    }
    default:
      return null;
  }
}

/** The public state stream (`GET /api/public/wiki/{code}/state`): `u32 length | frame` records — one SNAPSHOT then UPDATEs; null when malformed. */
export function decodeStateStream(body: Uint8Array): Uint8Array[] | null {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + 4 > body.length) return null;
    const len = dv.getUint32(at);
    at += 4;
    if (at + len > body.length) return null;
    const f = decodeFrame(body.subarray(at, at + len));
    at += len;
    if (f?.type === FRAME_SNAPSHOT) out.push(f.state);
    else if (f?.type === FRAME_UPDATE) out.push(f.update);
    else return null;
  }
  return out;
}
