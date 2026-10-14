import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { SocketLike } from "./gateway/client";
import {
  decodeFrame,
  encodeAwareness,
  encodeCompactRequest,
  encodeSnapshot,
  encodeSnapshotPost,
  encodeUpdate,
  FRAME_AWARENESS,
  FRAME_SNAPSHOT_POST,
  FRAME_UPDATE,
  MAX_FRAME,
  type Frame,
} from "./wiki/frames";
import { docPlainText } from "./wiki/plainText";
import {
  BATCH_MS,
  IDLE_SNAPSHOT_MS,
  SNAPSHOT_GAP_MS,
  WikiSyncProvider,
  type Visibility,
  type WikiSyncDeps,
} from "./wikiSync";

class FakeSocket implements SocketLike {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: Array<Uint8Array | string> = [];
  closed: number | null = null;
  constructor(readonly url: string) {}
  send(data: ArrayBufferLike | Uint8Array | string): void {
    this.sent.push(
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? data.slice()
          : new Uint8Array(data),
    );
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(frame: Uint8Array): void {
    this.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ),
    } as MessageEvent);
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  frames(): Frame[] {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== "string")
      .map((d) => decodeFrame(d) as Frame);
  }
}

function fakeVisibility(): Visibility & { set(h: boolean): void } {
  let hidden = false;
  const subs = new Set<() => void>();
  return {
    hidden: () => hidden,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(h) {
      hidden = h;
      for (const s of subs) s();
    },
  };
}

function setup(over: Partial<WikiSyncDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const vis = fakeVisibility();
  const provider = new WikiSyncProvider(doc, awareness, {
    url: () => "wss://x/api/wiki/pages/p/sync",
    getToken: () => Promise.resolve("tok"),
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0,
    visibility: vis,
    ...over,
  });
  const last = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket;
  return { doc, awareness, provider, sockets, last, vis };
}

/** A server-side doc with some text, as a snapshot state (memoized: same text → same bytes). */
const states = new Map<string, Uint8Array>();
function serverState(text: string): Uint8Array {
  const have = states.get(text);
  if (have) return have;
  const d = new Y.Doc();
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  d.getXmlFragment("default").insert(0, [p]);
  const out = Y.encodeStateAsUpdate(d);
  states.set(text, out);
  return out;
}

function type(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [p]);
}

async function connect(
  s: FakeSocket,
  state = serverState(""),
  seq = 0,
): Promise<void> {
  s.open();
  await Promise.resolve();
  await Promise.resolve();
  s.receive(encodeSnapshot(seq, state));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("wiki frames", () => {
  it("round-trips every frame type", () => {
    const u = Uint8Array.of(1, 2, 3);
    expect(decodeFrame(encodeSnapshot(42, u))).toEqual({
      type: 0,
      throughSeq: 42,
      state: u,
    });
    expect(decodeFrame(encodeUpdate(u, 7))).toEqual({
      type: 1,
      seq: 7,
      update: u,
    });
    expect(decodeFrame(encodeAwareness(u))).toEqual({ type: 2, update: u });
    expect(decodeFrame(encodeCompactRequest())).toEqual({ type: 3 });
    const meta = { plain_text: "Привет", title: "T", preview: "P" };
    expect(decodeFrame(encodeSnapshotPost(9_000_000_000, meta, u))).toEqual({
      type: 4,
      throughSeq: 9_000_000_000,
      meta,
      broadcast: false,
      state: u,
    });
    expect(decodeFrame(encodeSnapshotPost(1, meta, u, true))).toEqual({
      type: 4,
      throughSeq: 1,
      meta,
      broadcast: true,
      state: u,
    });
    // broadcast travels only when set (the layout of a plain post is unchanged)
    const plain = encodeSnapshotPost(1, meta, u);
    expect(
      new TextDecoder().decode(plain.subarray(13, plain.length - u.length)),
    ).not.toContain("broadcast");
  });

  it("rejects truncated and unknown frames", () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(Uint8Array.of(1, 0, 0))).toBeNull();
    expect(decodeFrame(Uint8Array.of(9))).toBeNull();
    const post = encodeSnapshotPost(
      1,
      { plain_text: "x", title: "", preview: "" },
      Uint8Array.of(1),
    );
    expect(decodeFrame(post.subarray(0, 14))).toBeNull();
  });
});

describe("WikiSyncProvider", () => {
  it("authenticates with a text frame and applies the snapshot", async () => {
    const { doc, provider, last } = setup();
    expect(provider.status).toBe("connecting");
    await connect(last(), serverState("hello"), 5);
    expect(last().sent[0]).toBe("tok");
    expect(provider.status).toBe("online");
    expect(docPlainText(doc)).toBe("hello");
  });

  it("batches local edits for 200 ms into one update", async () => {
    const { doc, last } = setup();
    await connect(last());
    const before = last()
      .frames()
      .filter((f) => f.type === FRAME_UPDATE).length;
    type(doc, "a");
    type(doc, "b");
    vi.advanceTimersByTime(BATCH_MS - 1);
    expect(
      last()
        .frames()
        .filter((f) => f.type === FRAME_UPDATE).length,
    ).toBe(before);
    vi.advanceTimersByTime(1);
    const ups = last()
      .frames()
      .filter((f) => f.type === FRAME_UPDATE);
    expect(ups.length).toBe(before + 1);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, serverState(""));
    for (const f of ups) Y.applyUpdate(peer, f.update);
    expect(docPlainText(peer)).toBe("a\nb");
  });

  it("splits a batch above 64 KiB into frames that fit", async () => {
    const { doc, last } = setup();
    await connect(last());
    for (let i = 0; i < 4; i++) type(doc, String(i).repeat(25_000));
    vi.advanceTimersByTime(BATCH_MS);
    const ups = last().sent.filter(
      (d): d is Uint8Array => typeof d !== "string" && d[0] === FRAME_UPDATE,
    );
    expect(ups.length).toBeGreaterThan(1);
    for (const u of ups) expect(u.length).toBeLessThanOrEqual(MAX_FRAME);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, serverState(""));
    for (const u of ups) {
      const f = decodeFrame(u);
      if (f?.type === FRAME_UPDATE) Y.applyUpdate(peer, f.update);
    }
    expect(docPlainText(peer)).toBe(docPlainText(doc));
  });

  it("sends a single transaction above 64 KiB as a snapshot", async () => {
    const { doc, last } = setup();
    await connect(last(), serverState(""), 3);
    type(doc, "x".repeat(70_000));
    vi.advanceTimersByTime(BATCH_MS);
    const posts = last()
      .frames()
      .filter((f) => f.type === FRAME_SNAPSHOT_POST);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ broadcast: true });
    expect(
      last().sent.every(
        (d) =>
          typeof d === "string" ||
          d[0] !== FRAME_UPDATE ||
          d.length <= MAX_FRAME,
      ),
    ).toBe(true);
  });

  it("applies remote updates without echoing them", async () => {
    const { doc, last } = setup();
    await connect(last());
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    let up: Uint8Array | null = null;
    peer.on("update", (u: Uint8Array) => (up = u));
    type(peer, "remote");
    last().receive(encodeUpdate(up as unknown as Uint8Array, 11));
    vi.advanceTimersByTime(BATCH_MS + IDLE_SNAPSHOT_MS);
    expect(docPlainText(doc)).toBe("remote");
    expect(
      last()
        .frames()
        .filter(
          (f) => f.type === FRAME_UPDATE || f.type === FRAME_SNAPSHOT_POST,
        ),
    ).toHaveLength(0);
  });

  it("posts a snapshot on COMPACT_REQUEST with the last seq and plain text", async () => {
    const { last } = setup();
    await connect(last(), serverState("page text"), 17);
    last().receive(encodeUpdate(Y.encodeStateAsUpdate(new Y.Doc()), 23));
    last().receive(encodeCompactRequest());
    const post = last()
      .frames()
      .find((f) => f.type === FRAME_SNAPSHOT_POST);
    expect(post).toMatchObject({
      throughSeq: 23,
      broadcast: false,
      meta: { plain_text: "page text", preview: "page text" },
    });
  });

  it("spaces snapshot posts by 2 s and merges requests made meanwhile", async () => {
    const { doc, last } = setup();
    await connect(last(), serverState(""), 3);
    const posts = (): Frame[] =>
      last()
        .frames()
        .filter((f) => f.type === FRAME_SNAPSHOT_POST);
    last().receive(encodeCompactRequest());
    expect(posts()).toHaveLength(1);
    last().receive(encodeCompactRequest());
    type(doc, "y".repeat(70_000)); // an oversized edit inside the gap: deferred, then broadcast
    vi.advanceTimersByTime(BATCH_MS);
    expect(posts()).toHaveLength(1);
    vi.advanceTimersByTime(SNAPSHOT_GAP_MS - BATCH_MS);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toMatchObject({ broadcast: true });
    vi.advanceTimersByTime(IDLE_SNAPSHOT_MS * 2);
    expect(posts()).toHaveLength(2); // the idle post found nothing new
  });

  it("posts a snapshot 3 s after the last own edit and on destroy", async () => {
    const { doc, provider, last } = setup();
    await connect(last());
    type(doc, "one");
    vi.advanceTimersByTime(IDLE_SNAPSHOT_MS - 1);
    expect(
      last()
        .frames()
        .filter((f) => f.type === FRAME_SNAPSHOT_POST),
    ).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(
      last()
        .frames()
        .filter((f) => f.type === FRAME_SNAPSHOT_POST),
    ).toHaveLength(1);
    type(doc, "two");
    const s = last();
    provider.destroy();
    expect(
      s.frames().filter((f) => f.type === FRAME_SNAPSHOT_POST),
    ).toHaveLength(2);
    expect(s.closed).toBe(1000);
    expect(provider.status).toBe("offline");
  });

  it("does not post a snapshot on destroy without own edits", async () => {
    const { provider, last } = setup();
    await connect(last(), serverState("x"));
    const s = last();
    provider.destroy();
    expect(
      s.frames().filter((f) => f.type === FRAME_SNAPSHOT_POST),
    ).toHaveLength(0);
  });

  it("reconnects with backoff and replays edits made while offline", async () => {
    const { doc, provider, sockets, last } = setup();
    await connect(last(), serverState("base"));
    last().drop(1006);
    expect(provider.status).toBe("offline");
    type(doc, "offline edit");
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); // attempt 0, random 0 → 500 ms
    expect(sockets).toHaveLength(2);
    expect(provider.status).toBe("connecting");
    await connect(last(), serverState("base"));
    expect(provider.status).toBe("online");
    const ups = last()
      .frames()
      .filter((f) => f.type === FRAME_UPDATE);
    expect(ups).toHaveLength(1);
    const server = new Y.Doc();
    Y.applyUpdate(server, serverState("base"));
    for (const f of ups) Y.applyUpdate(server, f.update);
    expect(docPlainText(server)).toBe("base\noffline edit");
  });

  it("does not replay after a reconnect without edits", async () => {
    const { last } = setup();
    await connect(last(), serverState("base"));
    last().drop(1006);
    vi.advanceTimersByTime(500);
    await connect(last(), serverState("base"));
    expect(
      last()
        .frames()
        .filter((f) => f.type === FRAME_UPDATE),
    ).toHaveLength(0);
  });

  it("refreshes the token after 4004 and stops for good on 4003", async () => {
    const refresh = vi.fn(() => Promise.resolve("new"));
    const onFatal = vi.fn();
    const { provider, sockets, last } = setup({
      refreshToken: refresh,
      onFatal,
    });
    last().open();
    last().drop(4004);
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
    last().drop(4003);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    expect(provider.status).toBe("offline");
    expect(onFatal).toHaveBeenCalledWith(4003);
  });

  it("read-only: applies but never sends updates, awareness or snapshots", async () => {
    const { doc, awareness, provider, last } = setup({ readOnly: true });
    await connect(last(), serverState("ro"));
    expect(provider.status).toBe("readonly");
    type(doc, "local");
    awareness.setLocalStateField("user", { name: "A" });
    last().receive(encodeCompactRequest());
    vi.advanceTimersByTime(10_000);
    provider.destroy();
    expect(last().sent).toEqual(["tok"]);
  });

  it("throttles awareness to 10/s and stops it while hidden", async () => {
    const { awareness, vis, last } = setup();
    await connect(last());
    const count = (): number =>
      last()
        .frames()
        .filter((f) => f.type === FRAME_AWARENESS).length;
    vi.advanceTimersByTime(100);
    const base = count();
    awareness.setLocalStateField("cursor", 1);
    awareness.setLocalStateField("cursor", 2);
    awareness.setLocalStateField("cursor", 3);
    expect(count()).toBe(base + 1);
    vi.advanceTimersByTime(100);
    expect(count()).toBe(base + 2);
    vis.set(true);
    awareness.setLocalStateField("cursor", 4);
    vi.advanceTimersByTime(60_000);
    expect(count()).toBe(base + 2);
    vis.set(false);
    expect(count()).toBe(base + 3);
  });

  it("applies peer awareness and forgets it when the socket drops", async () => {
    const { awareness, last } = setup();
    await connect(last());
    const peerDoc = new Y.Doc();
    const peer = new Awareness(peerDoc);
    peer.setLocalStateField("user", { name: "Peer" });
    const { encodeAwarenessUpdate } = await import("y-protocols/awareness");
    last().receive(
      encodeAwareness(encodeAwarenessUpdate(peer, [peer.clientID])),
    );
    expect(awareness.getStates().get(peer.clientID)).toEqual({
      user: { name: "Peer" },
    });
    last().drop(1006);
    expect(awareness.getStates().has(peer.clientID)).toBe(false);
    peer.destroy();
  });
});
