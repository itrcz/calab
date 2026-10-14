/**
 * Client side of the wiki sync socket (ADR-0096 §4; frame layout in lib/wiki/frames.ts).
 *
 * The server only relays and stores Yjs bytes; every merge happens here. One provider per open
 * page (the page mounts one editor); nothing runs for pages that are not on screen.
 *
 * - Connect → text frame with the token → SNAPSHOT (+ UPDATEs) applied; the SNAPSHOT marks the
 *   doc synced. Then «replay»: everything this doc has that the snapshot does not (edits made
 *   offline or lost with the last socket) goes up as one update — Yjs is idempotent, so updates
 *   the server already holds after its snapshot are harmless duplicates.
 * - Local updates are batched for 200 ms and merged; a batch above the 64 KiB frame limit is sent
 *   as several frames packed per transaction; a single transaction above it goes as a snapshot.
 * - Awareness (cursors): only our own state, ≤ 10 frames/s, nothing while the window is hidden.
 *   y-protocols' own 3 s interval is replaced by a 15 s renew/expire tick that runs only while
 *   online and visible.
 * - Compaction: SNAPSHOT_POST on COMPACT_REQUEST, 3 s after our last edit, and on destroy when we
 *   edited since the last snapshot — a silent compaction, the server sends nothing back. Only a post
 *   carrying an edit no UPDATE carried (a transaction above the frame limit) sets `broadcast`, and
 *   the server relays that one to the other sockets. Posts are spaced by SNAPSHOT_GAP_MS (the
 *   server closes 4008 past 2 at once, then 1 per 2 s); a request inside the gap is deferred and
 *   merged. Read-only providers never send updates, awareness or snapshots.
 * - Reconnect: exponential backoff 1 s → 30 s with jitter (the gateway's curve); 4004 refreshes
 *   the token first; 4003 / 4404 stop for good (status «offline»).
 */
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from "y-protocols/awareness";
import { backoffDelay, type SocketLike } from "./gateway/client";
import {
  decodeFrame,
  encodeAwareness,
  encodeSnapshotPost,
  encodeUpdate,
  FRAME_AWARENESS,
  FRAME_COMPACT_REQUEST,
  FRAME_SNAPSHOT,
  FRAME_UPDATE,
  MAX_FRAME,
  MAX_STATE,
  UPDATE_HEADER,
  type SnapshotMeta,
} from "./wiki/frames";
import { docMeta } from "./wiki/plainText";

export type WikiSyncStatus = "connecting" | "online" | "readonly" | "offline";

export const BATCH_MS = 200;
export const AWARENESS_MIN_GAP_MS = 100; // ≤ 10/s
export const IDLE_SNAPSHOT_MS = 3000;
/** Minimum gap between two SNAPSHOT_POSTs (the server's budget: 2 at once, then 1 per 2 s). */
export const SNAPSHOT_GAP_MS = 2000;
export const AWARENESS_RENEW_MS = 15_000;
export const AWARENESS_TIMEOUT_MS = 30_000;

export const CLOSE_AUTH = 4004;
export const CLOSE_FORBIDDEN = 4003;
export const CLOSE_NOT_FOUND = 4404;

const OPEN = 1;

export interface Visibility {
  hidden(): boolean;
  subscribe(cb: () => void): () => void;
}

const documentVisibility: Visibility = {
  hidden: () => typeof document !== "undefined" && document.hidden,
  subscribe: (cb) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", cb);
    return () => document.removeEventListener("visibilitychange", cb);
  },
};

/** Connection details are injected (the app knows the server URL and the auth). */
export interface WikiSyncDeps {
  /** `wss://…/api/wiki/pages/{id}/sync`, built per attempt. */
  url: () => string;
  /** Access token sent as the first (text) frame; null = not signed in (retried with backoff). */
  getToken: () => Promise<string | null>;
  /** Forced refresh after close 4004; null = could not refresh now. */
  refreshToken?: () => Promise<string | null>;
  createSocket: (url: string) => SocketLike;
  /** No WIKI_WRITE: receive only. */
  readOnly?: boolean;
  /** Snapshot meta (plain text, title, preview); defaults to the doc's own text. */
  meta?: () => SnapshotMeta;
  /** The Yjs state outgrew 2 MiB: the server will not take a snapshot; the UI warns. */
  onTooLarge?: (bytes: number) => void;
  /** 4003 / 4404: the page is gone or no longer visible to me. */
  onFatal?: (code: number) => void;
  random?: () => number;
  visibility?: Visibility;
}

/** An Awareness without y-protocols' 3 s interval (the provider renews it while visible). */
export function quietAwareness(awareness: Awareness): Awareness {
  const a = awareness as unknown as {
    _checkInterval?: ReturnType<typeof setInterval>;
  };
  if (a._checkInterval !== undefined) clearInterval(a._checkInterval);
  a._checkInterval = undefined;
  return awareness;
}

type Timer = ReturnType<typeof setTimeout>;

export class WikiSyncProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly deps: WikiSyncDeps;
  private readonly vis: Visibility;
  private ws: SocketLike | null = null;
  private statusValue: WikiSyncStatus = "connecting";
  private readonly listeners = new Set<(s: WikiSyncStatus) => void>();
  private synced = false;
  private stopped = false;
  private attempt = 0;
  private refreshed = false;
  /** Highest seq applied (snapshot through_seq or update seq). */
  private lastSeq = 0;
  private pending: Uint8Array[] = [];
  private batchTimer: Timer | null = null;
  private idleTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private awTimer: Timer | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private lastAwarenessAt = 0;
  private postTimer: Timer | null = null;
  private lastPostAt = Number.NEGATIVE_INFINITY;
  /** The next snapshot post must be relayed to the other sockets (it carries an oversized edit). */
  private postBroadcast = false;
  /** postNow is flushing: a nested request joins the post being built. */
  private posting = false;
  /** Edited since our last snapshot. */
  private dirty = false;
  /**
   * Edited during this or the last session: the next SNAPSHOT is followed by a replay (frames sent
   * just before a drop may be lost; no acks in the protocol). A full diff also carries the whole
   * delete set, so a session without edits replays nothing.
   */
  private replayNeeded = false;
  private readonly unsubVis: () => void;

  constructor(doc: Y.Doc, awareness: Awareness, deps: WikiSyncDeps) {
    this.doc = doc;
    this.awareness = quietAwareness(awareness);
    this.deps = deps;
    this.vis = deps.visibility ?? documentVisibility;
    doc.on("update", this.onDocUpdate);
    awareness.on("update", this.onAwarenessUpdate);
    this.unsubVis = this.vis.subscribe(this.onVisibility);
    this.connect();
  }

  get status(): WikiSyncStatus {
    return this.statusValue;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** For useSyncExternalStore: `subscribe` + `status`. */
  subscribe = (cb: (s: WikiSyncStatus) => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getStatus = (): WikiSyncStatus => this.statusValue;

  private setStatus(s: WikiSyncStatus): void {
    if (s === this.statusValue) return;
    this.statusValue = s;
    for (const l of this.listeners) l(s);
  }

  // ---- connection

  private connect(): void {
    if (this.stopped) return;
    this.retryTimer = null;
    this.setStatus("connecting");
    let ws: SocketLike;
    try {
      ws = this.deps.createSocket(this.deps.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      void this.deps.getToken().then(
        (token) => {
          if (ws !== this.ws) return;
          if (!token) {
            ws.close(4000, "no token");
            return;
          }
          (ws.send as unknown as (d: string) => void).call(ws, token);
        },
        () => ws === this.ws && ws.close(4000, "no token"),
      );
    };
    ws.onmessage = (ev) => {
      if (ws === this.ws)
        this.onMessage(ev.data as ArrayBuffer | Uint8Array | string);
    };
    ws.onclose = (ev) => {
      if (ws === this.ws) this.onClose(ev.code);
    };
    ws.onerror = () => undefined; // onclose follows
  }

  private onClose(code: number): void {
    this.ws = null;
    this.synced = false;
    this.clearSessionTimers();
    // Pending local updates go up again with the replay after the next SNAPSHOT (an oversized one
    // as a broadcast snapshot again).
    this.pending = [];
    this.postBroadcast = false;
    // Remote cursors are stale without a socket.
    const others = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.awareness.clientID,
    );
    if (others.length) removeAwarenessStates(this.awareness, others, this);
    if (this.stopped) return;
    if (code === CLOSE_FORBIDDEN || code === CLOSE_NOT_FOUND) {
      this.stopped = true;
      this.setStatus("offline");
      this.deps.onFatal?.(code);
      return;
    }
    this.setStatus("offline");
    if (code === CLOSE_AUTH && this.deps.refreshToken && !this.refreshed) {
      this.refreshed = true;
      void this.deps.refreshToken().then(
        (t) => (t ? this.connect() : this.scheduleReconnect()),
        () => this.scheduleReconnect(),
      );
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = backoffDelay(
      this.attempt++,
      (this.deps.random ?? Math.random)(),
    );
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private onVisibility = (): void => {
    if (this.vis.hidden()) {
      this.stopRenew();
      if (this.awTimer) clearTimeout(this.awTimer);
      this.awTimer = null;
      return;
    }
    // Back on screen: a pending backoff is cut short, cursors resume.
    if (this.retryTimer && !this.ws) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.connect();
      return;
    }
    if (this.synced) {
      this.sendAwareness();
      this.startRenew();
    }
  };

  // ---- inbound

  private onMessage(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") return;
    const f = decodeFrame(
      data instanceof Uint8Array ? data : new Uint8Array(data),
    );
    if (!f) return;
    switch (f.type) {
      case FRAME_SNAPSHOT:
        Y.applyUpdate(this.doc, f.state, this);
        this.lastSeq = Math.max(this.lastSeq, f.throughSeq);
        this.onSynced(f.state);
        return;
      case FRAME_UPDATE:
        Y.applyUpdate(this.doc, f.update, this);
        this.lastSeq = Math.max(this.lastSeq, f.seq);
        return;
      case FRAME_AWARENESS:
        try {
          applyAwarenessUpdate(this.awareness, f.update, this);
        } catch {
          // a malformed awareness frame from a peer: ignore
        }
        return;
      case FRAME_COMPACT_REQUEST:
        this.postSnapshot();
        return;
      default:
        return;
    }
  }

  private onSynced(snapshotState: Uint8Array): void {
    const first = !this.synced;
    this.synced = true;
    this.attempt = 0;
    this.refreshed = false;
    this.setStatus(this.deps.readOnly ? "readonly" : "online");
    if (!first || this.deps.readOnly) return;
    // Replay what the server's snapshot lacks (offline edits, updates lost with the old socket).
    const diff = this.replayNeeded
      ? Y.encodeStateAsUpdate(
          this.doc,
          Y.encodeStateVectorFromUpdate(snapshotState),
        )
      : null;
    this.replayNeeded = false;
    if (diff && !isEmptyUpdate(diff)) {
      this.dirty = true;
      this.sendUpdates([diff]);
      this.armIdleSnapshot();
    }
    if (!this.vis.hidden()) {
      this.sendAwareness();
      this.startRenew();
    }
  }

  // ---- outbound: document

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.deps.readOnly) return;
    this.dirty = true;
    this.replayNeeded = true;
    // Before the snapshot (or offline) nothing is queued: the replay covers it.
    if (!this.synced) return;
    this.pending.push(update);
    this.batchTimer ??= setTimeout(this.flush, BATCH_MS);
    this.armIdleSnapshot();
  };

  /** Sends the batched local updates now. */
  flush = (): void => {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length) this.sendUpdates(batch);
  };

  /** Packs updates into frames ≤ 64 KiB; a single update above it is sent as a snapshot. */
  private sendUpdates(updates: Uint8Array[]): void {
    const limit = MAX_FRAME - UPDATE_HEADER;
    let group: Uint8Array[] = [];
    let size = 0;
    let oversize = false;
    const emit = (): void => {
      if (!group.length) return;
      const merged =
        group.length === 1 ? (group[0] as Uint8Array) : Y.mergeUpdates(group);
      if (merged.length <= limit) this.send(encodeUpdate(merged));
      else for (const u of group) this.send(encodeUpdate(u)); // each one fits (checked below)
      group = [];
      size = 0;
    };
    for (const u of updates) {
      if (u.length > limit) {
        oversize = true;
        continue;
      }
      if (size + u.length > limit) emit();
      group.push(u);
      size += u.length;
    }
    emit();
    // One transaction too big for a frame (a huge paste): the snapshot carries it; with broadcast
    // the server relays it to the other sockets of the page as a SNAPSHOT.
    if (oversize) this.postSnapshot(true);
  }

  private armIdleSnapshot(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.dirty) this.postSnapshot();
    }, IDLE_SNAPSHOT_MS);
  }

  /**
   * SNAPSHOT_POST with the whole doc (compaction); broadcast: it carries an edit no UPDATE carried.
   * Within SNAPSHOT_GAP_MS of the last post it is deferred (requests merge). No-op when read-only
   * or not synced.
   */
  postSnapshot(broadcast = false): void {
    if (
      this.deps.readOnly ||
      !this.synced ||
      !this.ws ||
      this.ws.readyState !== OPEN
    )
      return;
    this.postBroadcast ||= broadcast;
    if (this.posting) return; // the post being built carries it
    const wait = this.lastPostAt + SNAPSHOT_GAP_MS - Date.now();
    if (wait > 0) {
      this.postTimer ??= setTimeout(this.postNow, wait);
      return;
    }
    this.postNow();
  }

  /** Sends the snapshot now (destroy, or the deferred post). */
  private postNow = (): void => {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = null;
    if (
      this.deps.readOnly ||
      !this.synced ||
      !this.ws ||
      this.ws.readyState !== OPEN
    )
      return;
    this.posting = true;
    try {
      this.flush();
    } finally {
      this.posting = false;
    }
    const broadcast = this.postBroadcast;
    this.postBroadcast = false;
    const state = Y.encodeStateAsUpdate(this.doc);
    if (state.length > MAX_STATE) {
      this.deps.onTooLarge?.(state.length);
      return;
    }
    const meta = this.deps.meta?.() ?? docMeta(this.doc);
    this.send(encodeSnapshotPost(this.lastSeq, meta, state, broadcast));
    this.lastPostAt = Date.now();
    this.dirty = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  };

  // ---- outbound: awareness

  private onAwarenessUpdate = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || this.deps.readOnly) return;
    const me = this.awareness.clientID;
    if (!added.includes(me) && !updated.includes(me) && !removed.includes(me))
      return;
    if (!this.synced || this.vis.hidden()) return; // sent in full on sync / when visible again
    const gap = Date.now() - this.lastAwarenessAt;
    if (gap >= AWARENESS_MIN_GAP_MS) this.sendAwareness();
    else
      this.awTimer ??= setTimeout(
        () => this.sendAwareness(),
        AWARENESS_MIN_GAP_MS - gap,
      );
  };

  private sendAwareness(): void {
    if (this.awTimer) clearTimeout(this.awTimer);
    this.awTimer = null;
    if (this.deps.readOnly) return;
    this.lastAwarenessAt = Date.now();
    this.send(
      encodeAwareness(
        encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      ),
    );
  }

  private startRenew(): void {
    if (this.renewTimer || this.deps.readOnly) return;
    this.renewTimer = setInterval(this.renew, AWARENESS_RENEW_MS);
  }

  private stopRenew(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  /** Keeps our cursor alive for peers and drops peers silent for 30 s (crashed clients). */
  private renew = (): void => {
    const a = this.awareness;
    const local = a.getLocalState();
    if (local !== null) a.setLocalState(local);
    const now = Date.now();
    const stale: number[] = [];
    a.meta.forEach((m, id) => {
      if (
        id !== a.clientID &&
        a.states.has(id) &&
        now - m.lastUpdated >= AWARENESS_TIMEOUT_MS
      )
        stale.push(id);
    });
    if (stale.length) removeAwarenessStates(a, stale, this);
  };

  // ---- plumbing

  private send(frame: Uint8Array): void {
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) ws.send(frame);
  }

  private clearSessionTimers(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awTimer) clearTimeout(this.awTimer);
    if (this.postTimer) clearTimeout(this.postTimer);
    this.batchTimer = this.idleTimer = this.awTimer = this.postTimer = null;
    this.stopRenew();
  }

  /**
   * Closing the page: flush, post a snapshot when we edited, tell peers our cursor is gone, close.
   * The doc and the awareness stay the caller's.
   */
  destroy(): void {
    if (this.stopped && !this.ws) return;
    const ws = this.ws;
    if (ws && ws.readyState === OPEN && this.synced) {
      this.flush();
      // Now, not deferred: the socket closes next (the server allows 2 posts at once).
      if (this.dirty || this.postTimer || this.postBroadcast) this.postNow();
      if (!this.deps.readOnly) {
        const me = this.awareness.clientID;
        this.awareness.off("update", this.onAwarenessUpdate);
        removeAwarenessStates(this.awareness, [me], this);
        ws.send(encodeAwareness(encodeAwarenessUpdate(this.awareness, [me])));
      }
    }
    this.stopped = true;
    this.clearSessionTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.unsubVis();
    this.ws = null;
    this.synced = false;
    if (ws) ws.close(1000, "closed");
    this.setStatus("offline");
    this.listeners.clear();
  }
}

/** An update that carries nothing (no structs, empty delete set). */
function isEmptyUpdate(u: Uint8Array): boolean {
  return u.length <= 2;
}

/** The factory the app wires (connection details injected; tests pass a fake socket). */
export function createWikiSync(
  doc: Y.Doc,
  awareness: Awareness,
  deps: WikiSyncDeps,
): WikiSyncProvider {
  return new WikiSyncProvider(doc, awareness, deps);
}
