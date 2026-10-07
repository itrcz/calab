import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  HelloSchema,
  HeartbeatAckSchema,
  InvalidSessionSchema,
  PresenceStatus,
  ReadySchema,
  ResumedSchema,
  TypingStartSchema,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectBanner, RECONNECT_BANNER_DELAY_MS } from './banner';
import {
  ACK_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  GatewayClient,
  HELLO_TIMEOUT_MS,
  OUT_BURST,
  TOKEN_TIMEOUT_MS,
  WAKE_RESET_MIN_MS,
  backoffDelay,
  gatewayUrl,
  type GatewayStatus,
  type SocketLike,
} from './client';

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: GatewayFrame[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  send(data: ArrayBufferLike | Uint8Array): void {
    this.sent.push(fromBinary(GatewayFrameSchema, data instanceof Uint8Array ? data : new Uint8Array(data)));
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closedWith = code;
  }
  deliver(frame: GatewayFrame): void {
    this.onmessage?.({ data: toBinary(GatewayFrameSchema, frame).buffer } as MessageEvent);
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  ops(): GatewayOpcode[] {
    return this.sent.map((f) => f.op);
  }
}

const hello = (ms = 10_000): GatewayFrame =>
  create(GatewayFrameSchema, { op: GatewayOpcode.HELLO, payload: { case: 'hello', value: create(HelloSchema, { heartbeatIntervalMs: ms }) } });
const ack = (): GatewayFrame =>
  create(GatewayFrameSchema, { op: GatewayOpcode.HEARTBEAT_ACK, payload: { case: 'heartbeatAck', value: create(HeartbeatAckSchema) } });
const dispatch = (seq: number, event: DispatchEvent['event']): GatewayFrame =>
  create(GatewayFrameSchema, {
    op: GatewayOpcode.DISPATCH,
    seq: BigInt(seq),
    payload: { case: 'dispatch', value: create(DispatchEventSchema, { event }) },
  });
const ready = (seq: number, sessionId = 'gs1'): GatewayFrame =>
  dispatch(seq, { case: 'ready', value: create(ReadySchema, { sessionId }) });
const typing = (seq: number): GatewayFrame =>
  dispatch(seq, { case: 'typingStart', value: create(TypingStartSchema, { roomId: 'r', userId: 'u' }) });

function setup(
  opts: {
    refresh?: string | null;
    refreshToken?: () => Promise<string | null>;
    getToken?: () => Promise<string | null>;
    failCreate?: () => boolean;
    onStatus?: (s: GatewayStatus) => void;
    tab?: { id: () => string; renew: () => void; hidden: () => boolean };
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const events: Array<{ seq: bigint; kind: string | undefined }> = [];
  const fatals: string[] = [];
  const statuses: string[] = [];
  const client = new GatewayClient({
    url: () => 'ws://x/gateway?v=1',
    getToken: opts.getToken ?? (() => Promise.resolve('tok')),
    refreshToken: opts.refreshToken ?? (() => Promise.resolve(opts.refresh === undefined ? 'tok2' : opts.refresh)),
    device: { name: 'test', platform: 'darwin', appVersion: '0.0.1' },
    createSocket: (url) => {
      if (opts.failCreate?.()) throw new SyntaxError('bad url');
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onDispatch: (ev, seq) => events.push({ seq, kind: ev.event.case }),
    onStatus: (s) => {
      statuses.push(s);
      opts.onStatus?.(s);
    },
    onFatal: (k, r) => fatals.push(r ? `${k}:${r}` : k),
    random: () => 0.5,
    ...(opts.tab && { tabId: opts.tab.id, renewTabId: opts.tab.renew, isHidden: opts.tab.hidden }),
  });
  const last = (): FakeSocket => {
    const s = sockets[sockets.length - 1];
    if (!s) throw new Error('no socket');
    return s;
  };
  return { client, sockets, events, fatals, statuses, last };
}

/** Opens the latest socket, sends HELLO and lets the async IDENTIFY/RESUME go out. */
async function handshake(t: ReturnType<typeof setup>, ms = 10_000): Promise<FakeSocket> {
  const s = t.last();
  s.open();
  s.deliver(hello(ms));
  await vi.advanceTimersByTimeAsync(0);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayClient', () => {
  it('HELLO → IDENTIFY → READY; heartbeats carry last seq', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    expect(s.binaryType).toBe('arraybuffer');
    expect(s.ops()).toEqual([GatewayOpcode.IDENTIFY]);
    const id = s.sent[0]?.payload;
    expect(id?.case === 'identify' && id.value.token).toBe('tok');

    s.deliver(ready(1));
    s.deliver(typing(2));
    expect(t.client.state.status).toBe('ready');
    expect(t.events.map((e) => e.kind)).toEqual(['ready', 'typingStart']);

    // First beat at interval × jitter (0.5), then every interval.
    await vi.advanceTimersByTimeAsync(5_000);
    const hb = s.sent[1];
    expect(hb?.op).toBe(GatewayOpcode.HEARTBEAT);
    expect(hb?.payload.case === 'heartbeat' && hb.payload.value.lastSeq).toBe(2n);
    s.deliver(ack());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.ops().filter((o) => o === GatewayOpcode.HEARTBEAT)).toHaveLength(2);
  });

  it('ignores duplicate/old seq', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.deliver(typing(2));
    s.deliver(typing(2));
    s.deliver(typing(1));
    s.deliver(typing(3));
    expect(t.events.map((e) => e.seq)).toEqual([1n, 2n, 3n]);
  });

  it('network drop → backoff → RESUME with session id and seq', async () => {
    const t = setup();
    t.client.start();
    const s1 = await handshake(t);
    s1.deliver(ready(1, 'sess'));
    s1.deliver(typing(5));
    s1.serverClose(1006);
    expect(t.client.state.status).toBe('reconnecting');
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(2);
    const s2 = await handshake(t);
    const r = s2.sent[0]?.payload;
    expect(r?.case).toBe('resume');
    if (r?.case === 'resume') {
      expect(r.value.sessionId).toBe('sess');
      expect(r.value.seq).toBe(5n);
    }
    s2.deliver(dispatch(6, { case: 'resumed', value: create(ResumedSchema, { replayed: 1 }) }));
    expect(t.client.state.status).toBe('ready');
    expect(t.client.state.attempts).toBe(0);
  });

  it('backoff grows exponentially up to 30 s', async () => {
    expect(backoffDelay(0, 1)).toBe(1000);
    expect(backoffDelay(3, 1)).toBe(8000);
    expect(backoffDelay(10, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(10, 0)).toBe(BACKOFF_MAX_MS / 2);

    const t = setup();
    t.client.start();
    for (let i = 0; i < 6; i++) {
      t.last().serverClose(1006);
      await vi.advanceTimersByTimeAsync(backoffDelay(i, 0.5) - 1);
      expect(t.sockets).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.sockets).toHaveLength(i + 2);
    }
    expect(t.client.state.attempts).toBe(6);
  });

  it('missing heartbeat ACK for two intervals → reconnect', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t, 1000);
    s.deliver(ready(1));
    await vi.advanceTimersByTimeAsync(500); // first beat, no ACK
    await vi.advanceTimersByTimeAsync(1000); // 2nd beat
    await vi.advanceTimersByTimeAsync(1000); // >2 intervals without ACK
    expect(s.closedWith).toBe(4000);
    expect(t.client.state.status).toBe('reconnecting');
  });

  it('4004 → refresh token and reconnect; refresh failure → backoff, never fatal', async () => {
    const ok = setup();
    ok.client.start();
    await handshake(ok);
    ok.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.sockets).toHaveLength(2);
    expect(ok.fatals).toEqual([]);

    // A failed refresh is not a logout (review H3): back off and retry, never fatal.
    const bad = setup({ refresh: null });
    bad.client.start();
    await handshake(bad);
    bad.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    await vi.advanceTimersByTimeAsync(0);
    expect(bad.client.state.status).toBe('reconnecting');
    expect(bad.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(bad.sockets).toHaveLength(2);
    expect(bad.fatals).toEqual([]);
  });

  it('network cut, then 4004 while refresh keeps failing: retries with backoff, never fatal (docs/09 #89)', async () => {
    const refreshes: Array<string | null> = [null, null, null, 'tok2'];
    const t = setup({ refreshToken: () => Promise.resolve(refreshes.length ? (refreshes.shift() ?? null) : 'tok2') });
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.serverClose(1006); // network drop
    for (let attempt = 0; attempt < 3; attempt++) {
      await vi.advanceTimersByTimeAsync(backoffDelay(attempt, 0.5));
      await handshake(t);
      t.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED); // stale access token
      await vi.advanceTimersByTimeAsync(0);
      expect(t.client.state.status).toBe('reconnecting');
      expect(t.fatals).toEqual([]);
    }
    // Back online: the next attempt resumes the session with a token.
    await vi.advanceTimersByTimeAsync(backoffDelay(3, 0.5));
    const last = await handshake(t);
    expect(last.sent[0]?.payload.case).toBe('resume');
    expect(t.client.state.status).not.toBe('stopped');
    expect(t.fatals).toEqual([]);
  });

  it('repeated 4004 with a fresh token backs off instead of a tight loop', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(2); // first 4004: immediate retry
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(2); // second in a row: backoff
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(3);
  });

  it('getToken → null keeps the client reconnecting (transient), then recovers', async () => {
    const tokens: Array<string | null> = [null, null, 'tok'];
    const t = setup({ getToken: () => Promise.resolve(tokens.length ? (tokens.shift() ?? null) : 'tok') });
    t.client.start();
    await handshake(t);
    expect(t.client.state.status).toBe('reconnecting');
    expect(t.last().closedWith).toBe(4000);
    expect(t.fatals).toEqual([]);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    await handshake(t);
    expect(t.client.state.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(backoffDelay(1, 0.5));
    const s = await handshake(t);
    expect(s.sent[0]?.payload.case).toBe('identify');
    s.deliver(ready(1));
    expect(t.client.state.status).toBe('ready');
    expect(t.fatals).toEqual([]);
  });

  it('no HELLO within the timeout → drop and back off', async () => {
    const t = setup();
    t.client.start();
    t.last().open(); // TCP ok, but the server never says HELLO
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS);
    expect(t.last().closedWith).toBe(4000);
    expect(t.client.state.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(2);
  });

  it('createSocket throwing is retried with backoff, not an unhandled error', async () => {
    let fail = true;
    const t = setup({ failCreate: () => fail });
    t.client.start();
    expect(t.sockets).toHaveLength(0);
    expect(t.client.state.status).toBe('reconnecting');
    fail = false;
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(1);
  });

  it('non-resumable INVALID_SESSION resets seq; READY after a RESUME attempt starts over', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'a'));
    s.deliver(typing(9));
    s.serverClose(1006);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('resume');
    s2.deliver(
      create(GatewayFrameSchema, {
        op: GatewayOpcode.INVALID_SESSION,
        payload: { case: 'invalidSession', value: create(InvalidSessionSchema, { resumable: false }) },
      }),
    );
    expect(t.client.state.seq).toBe(0n);
    expect(t.client.state.sessionId).toBe('');
    await vi.advanceTimersByTimeAsync(3000);
    // The server keeps the socket open after a rejected RESUME: IDENTIFY goes out on it.
    expect(t.sockets).toHaveLength(2);
    expect(s2.sent.map((f) => f.payload.case)).toEqual(['resume', 'identify']);
    s2.deliver(ready(1, 'b')); // seq 1 again is accepted after the reset
    expect(t.events.filter((e) => e.kind === 'ready')).toHaveLength(2);
    expect(t.client.state.sessionId).toBe('b');
  });

  it('4010 → fatal revoked, no reconnect', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.serverClose(GatewayCloseCode.SESSION_REVOKED, 'session revoked');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fatals).toEqual(['revoked:revoked']);
    expect(t.sockets).toHaveLength(1);
  });

  it('4010 reason: REUSE → reset (after a connection loss), LOGOUT_ALL → revoked (docs/09 #123)', async () => {
    for (const [reason, want] of [
      ['session revoked: REUSE', 'revoked:reset'],
      ['session revoked: LOGOUT_ALL', 'revoked:revoked'],
      ['session revoked: GUEST_EXPIRED', 'revoked:expired'],
    ] as const) {
      const t = setup();
      t.client.start();
      const s = await handshake(t);
      s.deliver(ready(1));
      s.serverClose(GatewayCloseCode.SESSION_REVOKED, reason);
      expect(t.fatals).toEqual([want]);
      t.client.stop();
    }
  });

  it('4008 before READY = too many sessions (no retry loop); after READY = backoff + RESUME', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.RATE_LIMITED, 'too many active devices');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fatals).toEqual(['too-many-sessions']);
    expect(t.sockets).toHaveLength(1);

    const u = setup();
    u.client.start();
    const s = await handshake(u);
    s.deliver(ready(1, 'x'));
    s.serverClose(GatewayCloseCode.RATE_LIMITED);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    const s2 = await handshake(u);
    expect(s2.sent[0]?.payload.case).toBe('resume');
    expect(u.fatals).toEqual([]);
  });

  it('4007/4009 and non-resumable INVALID_SESSION → fresh IDENTIFY', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(3, 'old'));
    s.serverClose(GatewayCloseCode.SESSION_TIMED_OUT);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('identify');
    expect(t.client.state.seq).toBe(0n);

    s2.deliver(ready(1, 'new'));
    s2.deliver(
      create(GatewayFrameSchema, {
        op: GatewayOpcode.INVALID_SESSION,
        payload: { case: 'invalidSession', value: create(InvalidSessionSchema, { resumable: false }) },
      }),
    );
    await vi.advanceTimersByTimeAsync(3000); // 1 s + 0.5 × 4 s
    const s3 = await handshake(t);
    expect(s3.sent[0]?.payload.case).toBe('identify');
  });

  it('RECONNECT op and forceReconnect → immediate RESUME', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'z'));
    s.deliver(create(GatewayFrameSchema, { op: GatewayOpcode.RECONNECT, payload: { case: 'reconnect', value: {} as never } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(2);
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('resume');

    t.client.forceReconnect();
    expect(t.sockets).toHaveLength(3);
    expect(s2.closedWith).toBe(4000);
  });

  it('stop() closes and never reconnects', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.client.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.client.state.status).toBe('stopped');
  });

  it('server deploy: RECONNECT → RESUME rejected (INVALID_SESSION resumable=false) → fresh IDENTIFY → READY', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(7, 'before-deploy'));
    s.deliver(create(GatewayFrameSchema, { op: GatewayOpcode.RECONNECT, payload: { case: 'reconnect', value: {} as never } }));
    await vi.advanceTimersByTimeAsync(0);
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('resume');
    s2.deliver(
      create(GatewayFrameSchema, {
        op: GatewayOpcode.INVALID_SESSION,
        payload: { case: 'invalidSession', value: create(InvalidSessionSchema, { resumable: false }) },
      }),
    );
    expect(t.client.state.sessionId).toBe('');
    expect(t.client.state.seq).toBe(0n);
    await vi.advanceTimersByTimeAsync(2999); // re-identify after 1–5 s (jitter 0.5 → 3 s)
    expect(s2.sent.map((f) => f.payload.case)).toEqual(['resume']);
    await vi.advanceTimersByTimeAsync(1);
    expect(s2.sent.map((f) => f.payload.case)).toEqual(['resume', 'identify']); // same socket
    expect(t.sockets).toHaveLength(2);
    s2.deliver(ready(1, 'after-deploy'));
    expect(t.client.state.status).toBe('ready');
    expect(t.events.filter((e) => e.kind === 'ready')).toHaveLength(2);
    expect(t.fatals).toEqual([]);
  });

  it('outgoing rate limit: typing bursts are capped at 10, then 2 per second', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    const typingSent = (): number => s.sent.filter((f) => f.op === GatewayOpcode.TYPING).length;
    for (let i = 0; i < 25; i++) t.client.sendTyping('r');
    expect(typingSent()).toBe(OUT_BURST);
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 25; i++) t.client.sendTyping('r');
    expect(typingSent()).toBe(OUT_BURST + 2);
  });

  it('presence over the limit is deferred and coalesced to the newest value', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    for (let i = 0; i < OUT_BURST; i++) t.client.sendTyping('r'); // use up the burst
    t.client.setPresence(PresenceStatus.IDLE);
    t.client.setPresence(PresenceStatus.DND);
    t.client.setPresence(PresenceStatus.ONLINE);
    const presences = (): PresenceStatus[] =>
      s.sent.flatMap((f) => (f.payload.case === 'setPresence' ? [f.payload.value.status] : []));
    expect(presences()).toEqual([]);
    await vi.advanceTimersByTimeAsync(600); // one token after 0.5 s
    expect(presences()).toEqual([PresenceStatus.ONLINE]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(presences()).toEqual([PresenceStatus.ONLINE]);
  });

  it('a deferred manual status is not coalesced away by an automatic (AFK) one', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    for (let i = 0; i < OUT_BURST; i++) t.client.sendTyping('r');
    t.client.setPresence(PresenceStatus.DND, 5_000);
    t.client.setPresence(PresenceStatus.IDLE);
    await vi.advanceTimersByTimeAsync(2000);
    const sent = s.sent.flatMap((f) => (f.payload.case === 'setPresence' ? [[f.payload.value.status, f.payload.value.until !== undefined]] : []));
    expect(sent).toEqual([
      [PresenceStatus.DND, true],
      [PresenceStatus.IDLE, false],
    ]);
  });

  it('heartbeats are never rate limited', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t, 1000);
    s.deliver(ready(1));
    for (let i = 0; i < 40; i++) t.client.sendTyping('r');
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.sent.some((f) => f.op === GatewayOpcode.HEARTBEAT)).toBe(true);
  });

  it('builds ws/wss URL from the server URL', () => {
    expect(gatewayUrl('https://app.example.com')).toBe('wss://app.example.com/gateway?v=1');
    expect(gatewayUrl('http://localhost:3000')).toBe('ws://localhost:3000/gateway?v=1');
  });
});

const invalidSession = (): GatewayFrame =>
  create(GatewayFrameSchema, {
    op: GatewayOpcode.INVALID_SESSION,
    payload: { case: 'invalidSession', value: create(InvalidSessionSchema, { resumable: false }) },
  });
const reconnectOp = (): GatewayFrame =>
  create(GatewayFrameSchema, { op: GatewayOpcode.RECONNECT, payload: { case: 'reconnect', value: {} as never } });
const resumed = (seq: number): GatewayFrame => dispatch(seq, { case: 'resumed', value: create(ResumedSchema, { replayed: 0 }) });

/** The machine may sleep: wall clock jumps, timers do not fire (throttled / frozen). */
function sleepWallClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('GatewayClient.wake (window visible / online / unlock)', () => {
  it('heartbeat ACK overdue → reconnect at once with RESUME', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'w'));
    await vi.advanceTimersByTimeAsync(5_000); // first beat, never ACKed
    expect(s.ops()).toContain(GatewayOpcode.HEARTBEAT);
    sleepWallClock(ACK_TIMEOUT_MS + 1);
    t.client.wake();
    expect(s.closedWith).toBe(4000);
    expect(t.sockets).toHaveLength(2);
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('resume');
  });

  it('a quiet socket gets a probe heartbeat; no ACK in time → reconnect, ACK → keep it', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t, 30_000);
    s.deliver(ready(1, 'p'));
    await vi.advanceTimersByTimeAsync(15_000); // first beat
    s.deliver(ack());
    sleepWallClock(40_000);
    const beats = s.ops().filter((o) => o === GatewayOpcode.HEARTBEAT).length;
    t.client.wake();
    expect(s.ops().filter((o) => o === GatewayOpcode.HEARTBEAT)).toHaveLength(beats + 1);
    expect(t.sockets).toHaveLength(1);
    s.deliver(ack());
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
    expect(t.sockets).toHaveLength(1);
    expect(t.client.state.status).toBe('ready');

    sleepWallClock(40_000);
    t.client.wake();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1); // probe unanswered
    expect(t.sockets).toHaveLength(2);
    expect(s.closedWith).toBe(4000);
  });

  it('a recently ACKed socket is left alone', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    await vi.advanceTimersByTimeAsync(5_000);
    s.deliver(ack());
    const sent = s.sent.length;
    t.client.wake();
    expect(s.sent).toHaveLength(sent);
    expect(t.sockets).toHaveLength(1);
  });

  it('waiting for a long backoff → reconnect now', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'b'));
    for (let i = 0; i < 5; i++) {
      t.last().serverClose(1006);
      await vi.advanceTimersByTimeAsync(backoffDelay(i, 0.5));
      t.last().open();
    }
    t.last().serverClose(1006); // next wait: 16 s
    const n = t.sockets.length;
    t.client.wake();
    expect(t.sockets).toHaveLength(n + 1);
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('resume');
    s2.deliver(resumed(2));
    expect(t.client.state.status).toBe('ready');
  });

  it('wake cuts a backoff short at most once per 30 s (alt-tabbing while the server is down)', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'st'));
    s.serverClose(1006);
    t.client.wake(); // first: reconnect now, backoff restarts
    expect(t.sockets).toHaveLength(2);
    expect(t.client.state.attempts).toBe(0);
    for (let i = 0; i < 5; i++) {
      t.last().serverClose(1006); // server still down
      t.client.wake(); // within 30 s: the pending backoff keeps running
    }
    expect(t.sockets).toHaveLength(2);
    expect(t.client.state.attempts).toBe(1);
    expect(t.client.state.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(3); // the backoff still fires
    t.last().serverClose(1006);
    expect(t.client.state.attempts).toBe(2);
    sleepWallClock(WAKE_RESET_MIN_MS);
    t.client.wake(); // 30 s later: allowed again
    expect(t.sockets).toHaveLength(4);
    expect(t.client.state.attempts).toBe(0);
  });

  it('within the 30 s window a dead socket is still replaced, without resetting the backoff', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'dz'));
    s.serverClose(1006);
    t.client.wake(); // uses the reset
    const s2 = t.last();
    s2.serverClose(1006);
    await vi.advanceTimersByTimeAsync(backoffDelay(1, 0.5));
    const s3 = t.last();
    expect(t.sockets).toHaveLength(3);
    const attempts = t.client.state.attempts;
    s3.readyState = 3; // closed, onclose never fired
    t.client.wake();
    expect(t.sockets).toHaveLength(4);
    expect(t.client.state.attempts).toBe(attempts);
  });

  it('a closed socket whose onclose never fired → reconnect now', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.readyState = 3;
    t.client.wake();
    expect(t.sockets).toHaveLength(2);
  });
});

describe('GatewayClient robustness', () => {
  it('a token refresh that never settles does not leave the client stuck', async () => {
    const t = setup({ refreshToken: () => new Promise<string | null>(() => undefined) });
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    expect(t.client.state.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS + backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(2);
  });

  it('4008 «send queue overflow» before READY is a slow consumer, not the device limit', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.RATE_LIMITED, 'send queue overflow');
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.fatals).toEqual([]);
    expect(t.sockets).toHaveLength(2);
    t.last().serverClose(GatewayCloseCode.RATE_LIMITED, 'too many active devices');
    expect(t.fatals).toEqual(['too-many-sessions']);
  });

  it('4008 before READY with «rate limited» or no reason is transient, not the device limit', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.RATE_LIMITED, 'rate limited');
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(2);
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.RATE_LIMITED);
    await vi.advanceTimersByTimeAsync(backoffDelay(1, 0.5));
    expect(t.sockets).toHaveLength(3);
    expect(t.fatals).toEqual([]);
  });
});

describe('GatewayClient tabs of one auth session (#40)', () => {
  function webTab(hidden = false) {
    const st = { id: 'tab-1', hidden, renewed: 0 };
    const t = setup({
      tab: {
        id: () => st.id,
        renew: () => {
          st.renewed++;
          st.id = `tab-${st.renewed + 1}`;
        },
        hidden: () => st.hidden,
      },
    });
    return { ...t, st };
  }
  const identifyOf = (s: FakeSocket) => s.sent.find((f) => f.payload.case === 'identify')?.payload.value as { tabId: string } | undefined;

  it('IDENTIFY carries the tab id on the web and none on the desktop', async () => {
    const w = webTab();
    w.client.start();
    expect(identifyOf(await handshake(w))?.tabId).toBe('tab-1');
    const d = setup();
    d.client.start();
    expect(identifyOf(await handshake(d))?.tabId).toBe('');
  });

  it('4000 «replaced by a new session» (a duplicated tab took the id): new id, fresh IDENTIFY, no loop', async () => {
    const w = webTab();
    w.client.start();
    const s1 = await handshake(w);
    s1.deliver(ready(1));
    s1.serverClose(GatewayCloseCode.UNKNOWN_ERROR, 'replaced by a new session');
    expect(w.st.renewed).toBe(1);
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    const s2 = await handshake(w);
    expect(s2.ops()).toContain(GatewayOpcode.IDENTIFY);
    expect(s2.ops()).not.toContain(GatewayOpcode.RESUME);
    expect(identifyOf(s2)?.tabId).toBe('tab-2');
  });

  it('desktop: 4000 «replaced» keeps the old behaviour (RESUME attempt, no tab id)', async () => {
    const d = setup();
    d.client.start();
    const s1 = await handshake(d);
    s1.deliver(ready(1));
    s1.serverClose(GatewayCloseCode.UNKNOWN_ERROR, 'replaced by a new session');
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect((await handshake(d)).ops()).toContain(GatewayOpcode.RESUME);
  });

  it('4011 evicted while hidden: no timer, reconnects with IDENTIFY only once shown', async () => {
    const w = webTab(true);
    w.client.start();
    const s1 = await handshake(w);
    s1.deliver(ready(1));
    s1.serverClose(GatewayCloseCode.SESSION_EVICTED, 'evicted by a newer tab');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * BACKOFF_MAX_MS);
    expect(w.sockets).toHaveLength(1);
    w.client.wake(); // e.g. `online` while still hidden
    expect(w.sockets).toHaveLength(1);
    w.st.hidden = false;
    w.client.wake();
    expect(w.sockets).toHaveLength(2);
    const s2 = await handshake(w);
    expect(s2.ops()).toContain(GatewayOpcode.IDENTIFY);
    expect(identifyOf(s2)?.tabId).toBe('tab-1');
  });

  it('a genuine incoming call wakes a parked hidden host without changing ordinary tab wake', async () => {
    const w = webTab(true);
    w.client.start();
    const first = await handshake(w);
    first.deliver(ready(1));
    first.serverClose(GatewayCloseCode.SESSION_EVICTED, 'evicted by a newer tab');
    w.client.wake();
    expect(w.sockets).toHaveLength(1);
    w.client.wake('incoming-call');
    expect(w.sockets).toHaveLength(2);
    expect((await handshake(w)).ops()).toContain(GatewayOpcode.IDENTIFY);
  });

  it('4011 evicted while visible: slow backoff that READY does not reset', async () => {
    const w = webTab(false);
    w.client.start();
    let s = await handshake(w);
    s.deliver(ready(1));
    s.serverClose(GatewayCloseCode.SESSION_EVICTED, 'evicted by a newer tab');
    await vi.advanceTimersByTimeAsync(backoffDelay(2, 0.5) - 1);
    expect(w.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sockets).toHaveLength(2);
    s = await handshake(w);
    s.deliver(ready(1, 'gs2'));
    s.serverClose(GatewayCloseCode.SESSION_EVICTED, 'evicted by a newer tab');
    await vi.advanceTimersByTimeAsync(backoffDelay(3, 0.5) - 1);
    expect(w.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sockets).toHaveLength(3);
  });
});

describe('reconnect banner driven by the real client', () => {
  function withBanner() {
    const shown: boolean[] = [];
    const banner = new ReconnectBanner((v) => shown.push(v));
    const t = setup({ onStatus: (s) => banner.update(s) });
    return { t, banner, shown };
  }

  it('not shown on the first connect, nor for a drop shorter than 3 s', async () => {
    const { t, banner } = withBanner();
    t.client.start();
    await vi.advanceTimersByTimeAsync(RECONNECT_BANNER_DELAY_MS + 1_000); // slow first connect
    expect(banner.shown).toBe(false);
    const s = await handshake(t);
    s.deliver(ready(1, 'a'));
    s.serverClose(1006);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5)); // 750 ms
    const s2 = await handshake(t);
    s2.deliver(resumed(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(banner.shown).toBe(false);
  });

  it('shown after 3 s down, removed at once on RESUMED', async () => {
    const { t, banner } = withBanner();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'a'));
    s.serverClose(1006);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    t.last().serverClose(1006); // still down
    await vi.advanceTimersByTimeAsync(RECONNECT_BANNER_DELAY_MS);
    expect(banner.shown).toBe(true);
    await vi.advanceTimersByTimeAsync(backoffDelay(1, 0.5));
    const s3 = await handshake(t);
    expect(banner.shown).toBe(true); // socket open, RESUME sent, not yet RESUMED
    s3.deliver(resumed(2));
    expect(banner.shown).toBe(false);
  });

  it('deploy: RECONNECT → INVALID_SESSION → IDENTIFY → READY clears the banner', async () => {
    const { t, banner } = withBanner();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(5, 'before'));
    s.deliver(reconnectOp());
    await vi.advanceTimersByTimeAsync(0);
    const s2 = t.last();
    await vi.advanceTimersByTimeAsync(2_000); // new instance slow to answer
    s2.open();
    s2.deliver(hello());
    await vi.advanceTimersByTimeAsync(0);
    s2.deliver(invalidSession());
    await vi.advanceTimersByTimeAsync(3_000); // re-IDENTIFY on the same socket
    expect(banner.shown).toBe(true); // > 3 s without the gateway
    expect(s2.sent.map((f) => f.payload.case)).toEqual(['resume', 'identify']);
    s2.deliver(ready(1, 'after'));
    expect(t.client.state.status).toBe('ready');
    expect(banner.shown).toBe(false);
    s2.deliver(ack());
    await vi.advanceTimersByTimeAsync(RECONNECT_BANNER_DELAY_MS * 2); // no stale timer resurfaces
    expect(banner.shown).toBe(false);
  });
});
