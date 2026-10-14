/**
 * A short-lived connection to a wiki page's sync socket (ADR-0096 §4; frames in
 * @calaba/wiki-doc/frames) for one read or one write: connect, send the bot token as the first
 * text frame, apply the SNAPSHOT and the UPDATEs after it, then (write) send our change as
 * UPDATE frames, wait for the server to relay them back with their seq, post a snapshot so the
 * server has the page's text, title and preview, and close.
 *
 * The server sends the catch-up (SNAPSHOT + stored UPDATEs) back to back right after the token;
 * there is no end marker, so the session counts as synced once no frame came for `settleMs`
 * after the SNAPSHOT.
 */
import {
  decodeFrame,
  encodeSnapshotPost,
  encodeUpdate,
  FRAME_COMPACT_REQUEST,
  FRAME_SNAPSHOT,
  FRAME_UPDATE,
  MAX_FRAME,
  MAX_STATE,
  UPDATE_HEADER,
  type SnapshotMeta,
} from '@calaba/wiki-doc/frames';
import * as Y from 'yjs';

/** The socket the session needs (`ws` and the WHATWG WebSocket both fit). */
export interface SyncSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export interface WikiSyncOptions {
  /** Socket factory (tests, proxies). Default: `ws`. */
  createSocket?: (url: string) => SyncSocket;
  /** Quiet time after the SNAPSHOT that counts as «caught up», ms (default 150). */
  settleMs?: number;
  /** Bound of every wait (connect, catch-up, relay of our update, close), ms (default 15 000). */
  timeoutMs?: number;
}

/** The sync socket closed or refused us: 4003 no access / no WIKI_WRITE, 4004 bad token, 4404 no page. */
export class WikiSyncError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`wiki sync closed ${code}${reason ? `: ${reason}` : ''}`);
    this.name = 'WikiSyncError';
  }
}

const OPEN = 1;
const REMOTE = Symbol('remote');

/** `https://host` → `wss://host/api/wiki/pages/{id}/sync`. */
export function wikiSyncUrl(server: string, pageId: string): string {
  const u = new URL(`/api/wiki/pages/${encodeURIComponent(pageId)}/sync`, server.replace(/\/+$/, '') + '/');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const bytesOf = (data: unknown): Uint8Array | null => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data) && data.every((d) => d instanceof Uint8Array)) {
    const parts = data;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  return null;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export class WikiSyncSession {
  readonly doc = new Y.Doc();
  /** Highest seq applied (the snapshot's through_seq or an update's seq). */
  lastSeq = 0;
  private ws: SyncSocket | null = null;
  private readonly settleMs: number;
  private readonly timeoutMs: number;
  private synced = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private onSynced: (() => void) | null = null;
  /** Our UPDATE frames' payloads not yet relayed back. */
  private pending: Uint8Array[] = [];
  private onRelayed: (() => void) | null = null;
  private closed: { code: number; reason: string } | null = null;
  private readonly closeWaiters = new Set<(c: { code: number; reason: string }) => void>();
  private failWaiters = new Set<(e: Error) => void>();

  private constructor(o: WikiSyncOptions) {
    this.settleMs = o.settleMs ?? 150;
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  /** Connects with the token and resolves once the page's state has arrived. */
  static async open(url: string, token: string, createSocket: (url: string) => SyncSocket, o: WikiSyncOptions = {}): Promise<WikiSyncSession> {
    const s = new WikiSyncSession(o);
    try {
      await s.connect(url, token, createSocket);
    } catch (e) {
      s.abort();
      throw e;
    }
    return s;
  }

  private async connect(url: string, token: string, createSocket: (url: string) => SyncSocket): Promise<void> {
    await this.wait<true>('catch-up', (resolve) => {
      const ws = createSocket(url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(token);
      };
      ws.onmessage = (ev) => {
        this.onFrame(ev.data);
      };
      ws.onerror = () => undefined; // the close follows
      ws.onclose = (ev) => {
        this.closed = { code: ev.code, reason: ev.reason };
        for (const w of this.closeWaiters) w(this.closed);
        this.closeWaiters.clear();
        const err = new WikiSyncError(ev.code, ev.reason);
        for (const f of this.failWaiters) f(err);
        this.failWaiters.clear();
      };
      this.onSynced = () => {
        resolve(true);
      };
    });
  }

  /** A wait bounded by timeoutMs that fails when the socket closes. */
  private wait<T>(what: string, start: (resolve: (v: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fail = (e: Error): void => {
        clearTimeout(timer);
        reject(e);
      };
      const timer = setTimeout(() => {
        this.failWaiters.delete(fail);
        reject(new Error(`wiki sync: ${what} timed out`));
      }, this.timeoutMs);
      if (this.closed) {
        fail(new WikiSyncError(this.closed.code, this.closed.reason));
        return;
      }
      this.failWaiters.add(fail);
      start((v) => {
        clearTimeout(timer);
        this.failWaiters.delete(fail);
        resolve(v);
      });
    });
  }

  private onFrame(data: unknown): void {
    const bytes = bytesOf(data);
    const f = bytes ? decodeFrame(bytes) : null;
    if (!f) return;
    switch (f.type) {
      case FRAME_SNAPSHOT:
        Y.applyUpdate(this.doc, f.state, REMOTE);
        this.lastSeq = Math.max(this.lastSeq, f.throughSeq);
        this.synced = true;
        break;
      case FRAME_UPDATE: {
        Y.applyUpdate(this.doc, f.update, REMOTE);
        this.lastSeq = Math.max(this.lastSeq, f.seq);
        const i = this.pending.findIndex((p) => sameBytes(p, f.update));
        if (i >= 0) {
          this.pending.splice(i, 1);
          if (this.pending.length === 0) this.onRelayed?.();
        }
        break;
      }
      case FRAME_COMPACT_REQUEST:
      default:
        // Compaction requests are answered by write() itself; awareness is not used.
        return;
    }
    if (this.synced && this.onSynced) {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        const done = this.onSynced;
        this.onSynced = null;
        done?.();
      }, this.settleMs);
    }
  }

  private send(f: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== OPEN) throw new WikiSyncError(this.closed?.code ?? 1006, this.closed?.reason ?? 'socket not open');
    this.ws.send(f);
  }

  /**
   * Applies `change` to the doc and sends what it changed. Frames ≤ 64 KiB go as UPDATEs (and
   * are awaited back from the server); a bigger change goes as a broadcast SNAPSHOT_POST. Then a
   * snapshot is posted with `meta(doc)` so the page's text, title and preview are current.
   */
  async write(change: (doc: Y.Doc) => void, meta: (doc: Y.Doc) => SnapshotMeta): Promise<void> {
    const before = Y.encodeStateVector(this.doc);
    change(this.doc);
    const update = Y.encodeStateAsUpdate(this.doc, before);
    const state = Y.encodeStateAsUpdate(this.doc);
    if (state.length > MAX_STATE) throw new Error(`wiki page too large: ${state.length} bytes (the limit is ${MAX_STATE})`);
    if (update.length + UPDATE_HEADER <= MAX_FRAME) {
      if (update.length > 2) {
        // An empty Yjs update is 2 bytes: nothing changed, nothing to relay.
        await this.wait<true>('relay of the update', (resolve) => {
          this.pending.push(update);
          this.onRelayed = () => {
            resolve(true);
          };
          this.send(encodeUpdate(update));
        });
        this.onRelayed = null;
      }
      this.send(encodeSnapshotPost(this.lastSeq, meta(this.doc), state, false));
      return;
    }
    this.send(encodeSnapshotPost(this.lastSeq, meta(this.doc), state, true));
  }

  /** Closes the socket (1000) and waits for the close: the server has handled every frame we sent. */
  async close(): Promise<void> {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.closed || !this.ws) return;
    const ws = this.ws;
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.timeoutMs);
      this.closeWaiters.add(() => {
        clearTimeout(t);
        resolve();
      });
    });
    ws.close(1000, '');
    await done;
  }

  private abort(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    try {
      this.ws?.close(1000, '');
    } catch {
      // already closed
    }
  }
}
