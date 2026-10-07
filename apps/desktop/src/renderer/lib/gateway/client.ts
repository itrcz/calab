import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  DeviceInfoSchema,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  HeartbeatSchema,
  IdentifySchema,
  PresenceStatus,
  ResumeSchema,
  SetPresenceSchema,
  SubscribeSchema,
  TypingSchema,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';
import type { LogoutReason } from '../../../shared/ipc';
import { logoutReasonFromClose } from '../../../shared/logoutReason';

/**
 * WS gateway client (docs/05-realtime-protocol.md). Pure logic with injected
 * socket factory, token source and clock so it can be unit-tested with fake
 * timers. Binary protobuf frames (`GatewayFrame`).
 */

export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type GatewayStatus =
  | 'idle'
  | 'connecting' // socket opening / IDENTIFY sent
  | 'resuming'
  | 'ready'
  | 'reconnecting' // waiting for the backoff timer
  | 'stopped';

/** Unrecoverable gateway states. An auth failure is not one: it backs off and retries, and a real
 *  logout arrives through platform.auth.onLoggedOut (review H3/N9). */
export type GatewayFatal = 'revoked' | 'too-many-sessions';

export interface GatewayDeps {
  /** ws(s)://host/gateway?v=1 */
  url(): string;
  /**
   * Current access JWT. `null` = no token right now (offline, 5xx, rate limit) → retried with
   * backoff. A real logout never shows up here: it arrives separately (platform
   * `auth.onLoggedOut`) and the owner calls `stop()` (review H3).
   */
  getToken(): Promise<string | null>;
  /** Forced refresh after close 4004; `null` = could not refresh now → retried with backoff. */
  refreshToken(): Promise<string | null>;
  device: { name: string; platform: string; appVersion: string };
  createSocket(url: string): SocketLike;
  onDispatch(ev: DispatchEvent, seq: bigint): void;
  onStatus(s: GatewayStatus): void;
  /**
   * `revoked` comes with the logout reason from the 4010 close reason (REUSE → 'reset', …,
   * shared/logoutReason.ts); `too-many-sessions` without one.
   */
  onFatal(kind: GatewayFatal, reason?: LogoutReason): void;
  log?(msg: string): void;
  /** Random source for jitter (tests inject a constant). */
  random?: () => number;
  /**
   * Web only (#40): this tab's id for Identify.tab_id, so tabs sharing the auth session keep
   * their own gateway sessions; `renewTabId` is called when another tab took the id over (close
   * 4000 «replaced by a new session», a duplicated tab). Desktop: absent (one window = one device).
   */
  tabId?: () => string;
  renewTabId?: () => void;
  /** Tab / window hidden now: an evicted session (4011) waits for wake() instead of a timer. */
  isHidden?: () => boolean;
}

const OPEN = 1;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** Socket open + HELLO must arrive within this time, else the connect is treated as a drop. */
export const HELLO_TIMEOUT_MS = 10_000;
/** A heartbeat (or a wake-up probe) without ACK for this long means the socket is dead. */
export const ACK_TIMEOUT_MS = 10_000;
/** getToken / refreshToken that never settle (a stuck IPC or fetch) count as «no token now». */
export const TOKEN_TIMEOUT_MS = 15_000;
/** Delay before re-IDENTIFY after INVALID_SESSION (Discord-style 1–5 s, spreads a deploy herd). */
export const INVALID_SESSION_MIN_MS = 1000;
export const INVALID_SESSION_JITTER_MS = 4000;
/**
 * wake() may cut a pending backoff short (and restart it from 1 s) at most this often:
 * alt-tabbing while the server is down must not turn into a reconnect storm.
 */
export const WAKE_RESET_MIN_MS = 30_000;
/**
 * Close 4008 before READY with this reason = the device limit (server: gateway/handler.go
 * «too many active devices»); any other 4008 (rate limit, send queue overflow) is transient.
 */
export const TOO_MANY_DEVICES_REASON = /devices/i;
/** Close 4000 with this reason = another IDENTIFY of the same tab id replaced this session. */
export const REPLACED_REASON = /replaced by a new session/i;
/**
 * A visible tab evicted by the tab cap (4011) retries after backoffDelay(evictions + this): 4 s,
 * 8 s, … 30 s, never reset by READY, so two visible windows above the cap cannot ping-pong fast.
 */
export const EVICTED_BACKOFF_SHIFT = 2;

/** Exponential backoff 1 s → 30 s with ±50 % jitter (full attempts counter). */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + random * 0.5));
}

/**
 * Client → server rate limit (server closes with 4008 on inbound flood): a token bucket of
 * 10 frames refilled at 2/s for the «chatty» ops. HEARTBEAT / IDENTIFY / RESUME are exempt.
 */
export const OUT_BURST = 10;
export const OUT_PER_SEC = 2;

export class GatewayClient {
  private ws: SocketLike | null = null;
  private status: GatewayStatus = 'idle';
  private sessionId = '';
  private seq = 0n;
  private attempts = 0;
  private heartbeatMs = 41_000;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-IDENTIFY on the same socket after INVALID_SESSION. */
  private identifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** ACK deadline of a wake-up probe heartbeat. */
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current socket was created / got HELLO (0 = not yet). */
  private connectAt = 0;
  private helloAt = 0;
  private lastBeatAt = 0;
  /** Consecutive 4004 closes without READY in between (the first one reconnects at once). */
  private authFailures = 0;
  private lastAckAt = 0;
  private awaitingAck = false;
  /** READY/RESUMED received on the current socket. */
  private established = false;
  private stopped = true;
  /** Evicted (4011) while hidden: no timer, the next wake() while shown reconnects. */
  private parked = false;
  /** 4011 closes so far (see EVICTED_BACKOFF_SHIFT). */
  private evictions = 0;
  private readonly rnd: () => number;
  private tokens = OUT_BURST;
  private tokensAt = Date.now();
  /**
   * Latest presence / subscription waiting for a token (coalesced per slot: only the newest
   * matters). A manual status and this session's automatic (AFK) one have separate slots.
   */
  private deferred = new Map<string, { op: GatewayOpcode; payload: GatewayFrame['payload'] }>();
  private deferTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: GatewayDeps) {
    this.rnd = deps.random ?? (() => Math.random());
  }

  get state(): { status: GatewayStatus; sessionId: string; seq: bigint; attempts: number } {
    return { status: this.status, sessionId: this.sessionId, seq: this.seq, attempts: this.attempts };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Stop for good (logout). */
  stop(): void {
    this.stopped = true;
    this.parked = false;
    this.evictions = 0;
    this.clearTimers();
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    this.deferred.clear();
    this.sessionId = '';
    this.seq = 0n;
    this.dropSocket(1000);
    this.setStatus('stopped');
  }

  /** Immediate reconnect with RESUME (e.g. after the laptop wakes up). */
  forceReconnect(reason = 'force reconnect'): void {
    this.reconnectNow(reason, true);
  }

  private reconnectNow(reason: string, resetAttempts: boolean): void {
    if (this.stopped) return;
    this.log(reason);
    this.clearTimers();
    this.dropSocket(4000);
    if (resetAttempts) this.attempts = 0;
    this.connect();
  }

  /** Last time wake() cut a backoff short / restarted it from the first step. */
  private wakeResetAt = Number.NEGATIVE_INFINITY;

  /**
   * The window became visible / the network came back / the screen was unlocked: timers may
   * have been throttled or frozen meanwhile, so do not trust them. Reconnect at once when the
   * socket is gone or dead (no socket, a pending backoff, closed without onclose, HELLO or a
   * heartbeat ACK overdue); a quiet but possibly healthy socket gets a probe heartbeat that
   * must be ACKed within ACK_TIMEOUT_MS.
   */
  wake(reason: 'visibility' | 'incoming-call' = 'visibility'): void {
    if (this.stopped) return;
    if (this.parked) {
      // Evicted by the tab cap while hidden: reconnect only once the tab is shown (an `online`
      // event in a background tab must not evict another tab in turn). A fresh
      // native incoming call is an explicit foreground-equivalent reason to reconnect.
      if (this.deps.isHidden?.() && reason !== 'incoming-call') return;
      this.parked = false;
      this.reconnectNow(`wake: evicted tab ${reason}, reconnecting`, false);
      return;
    }
    const now = Date.now();
    const ws = this.ws;
    // At most one backoff reset per WAKE_RESET_MIN_MS: within it, a pending backoff keeps
    // running, and a dead socket is replaced without restarting the backoff from 1 s.
    const mayReset = now - this.wakeResetAt >= WAKE_RESET_MIN_MS;
    const reconnect = (why: string): void => {
      if (mayReset) this.wakeResetAt = now;
      this.reconnectNow(`wake: ${why}, reconnecting now`, mayReset);
    };
    if (!ws) {
      if (mayReset || reason === 'incoming-call') reconnect('no socket');
      return;
    }
    if (ws.readyState > OPEN) {
      reconnect('socket closed');
      return;
    }
    if (!this.helloAt) {
      if (now - this.connectAt > HELLO_TIMEOUT_MS) reconnect('HELLO overdue');
      return;
    }
    if (this.awaitingAck) {
      if (now - this.lastBeatAt > ACK_TIMEOUT_MS) reconnect('heartbeat ACK overdue');
      return;
    }
    if (now - this.lastAckAt > this.heartbeatMs) this.probe(ws);
  }

  // ---- outgoing ops ----

  /** Best effort: dropped when over the rate limit (the next keystroke sends it again). */
  sendTyping(roomId: string): void {
    if (this.takeToken()) this.sendFrame(GatewayOpcode.TYPING, { case: 'typing', value: create(TypingSchema, { roomId }) });
  }

  /**
   * `untilMs` given = a manual choice kept by the server for all devices until then (0 = no
   * end; ONLINE clears it); omitted = this session's automatic status (AFK). docs/05.
   */
  setPresence(status: PresenceStatus, untilMs?: number): void {
    const until = untilMs === undefined ? undefined : timestampFromMs(untilMs);
    this.sendLimited(GatewayOpcode.PRESENCE_UPDATE, { case: 'setPresence', value: create(SetPresenceSchema, { status, until }) }, until ? 'presence:manual' : 'presence');
  }

  subscribe(roomIds: string[]): void {
    this.sendLimited(GatewayOpcode.SUBSCRIBE, { case: 'subscribe', value: create(SubscribeSchema, { roomIds }) });
  }

  // ---- outgoing rate limit ----

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(OUT_BURST, this.tokens + ((now - this.tokensAt) / 1000) * OUT_PER_SEC);
    this.tokensAt = now;
  }

  private takeToken(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Sends now if a token is free, else keeps only the newest frame of this op and flushes later. */
  private sendLimited(op: GatewayOpcode, payload: GatewayFrame['payload'], slot: string = String(op)): void {
    if (!this.deferred.has(slot) && this.takeToken()) {
      this.sendFrame(op, payload);
      return;
    }
    this.deferred.set(slot, { op, payload });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.deferTimer || this.deferred.size === 0) return;
    this.refill();
    const wait = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / OUT_PER_SEC) * 1000);
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      for (const [slot, { op, payload }] of this.deferred) {
        if (!this.takeToken()) break;
        this.deferred.delete(slot);
        this.sendFrame(op, payload);
      }
      this.scheduleFlush();
    }, wait);
  }

  // ---- internals ----

  private log(msg: string): void {
    this.deps.log?.(`[gateway] ${msg}`);
  }

  private setStatus(s: GatewayStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.deps.onStatus(s);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.identifyTimer) clearTimeout(this.identifyTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.helloTimer = null;
    this.identifyTimer = null;
    this.probeTimer = null;
  }

  private dropSocket(code: number): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.parked = false;
    this.established = false;
    this.awaitingAck = false;
    this.connectAt = Date.now();
    this.helloAt = 0;
    this.setStatus(this.sessionId ? 'resuming' : 'connecting');
    let ws: SocketLike;
    try {
      ws = this.deps.createSocket(this.deps.url());
    } catch (err) {
      // Bad URL / blocked by CSP: the constructor throws synchronously. Retry like a drop.
      this.log(`socket create failed: ${String(err)}`);
      this.backoff();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ws, ev);
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
    // A black-holed connect would otherwise wait for the OS TCP timeout (minutes).
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (ws !== this.ws) return;
      this.log('no HELLO in time, reconnecting');
      this.clearTimers();
      this.dropSocket(4000);
      this.backoff();
    }, HELLO_TIMEOUT_MS);
  }

  private sendFrame(op: GatewayOpcode, payload: GatewayFrame['payload']): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op, payload })));
    return true;
  }

  private onMessage(ws: SocketLike, ev: MessageEvent): void {
    if (ws !== this.ws) return;
    let frame: GatewayFrame;
    try {
      const data = ev.data as ArrayBuffer | Uint8Array;
      frame = fromBinary(GatewayFrameSchema, data instanceof Uint8Array ? data : new Uint8Array(data));
    } catch (err) {
      this.log(`bad frame: ${String(err)}`);
      return;
    }
    switch (frame.payload.case) {
      case 'hello':
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.helloAt = Date.now();
        this.heartbeatMs = frame.payload.value.heartbeatIntervalMs || this.heartbeatMs;
        this.startHeartbeat();
        void this.authenticate();
        return;
      case 'heartbeatAck':
        this.awaitingAck = false;
        this.lastAckAt = Date.now();
        if (this.probeTimer) clearTimeout(this.probeTimer);
        this.probeTimer = null;
        return;
      case 'reconnect':
        this.log('server asked to reconnect');
        this.reconnectSoon(0);
        return;
      case 'invalidSession':
        this.log(`invalid session (resumable=${String(frame.payload.value.resumable)})`);
        if (!frame.payload.value.resumable) {
          this.sessionId = '';
          this.seq = 0n;
        }
        {
          const delay = INVALID_SESSION_MIN_MS + Math.round(this.rnd() * INVALID_SESSION_JITTER_MS);
          // A rejected RESUME keeps the socket open and the server waits for IDENTIFY on it
          // (docs/05): re-authenticate here instead of paying a new TCP/TLS/HELLO round. After
          // READY (a server-side resync) the server closes the socket itself: start over.
          if (this.established) this.reconnectSoon(delay);
          else this.reauthSoon(ws, delay);
        }
        return;
      case 'dispatch':
        this.onDispatch(frame);
        return;
      default:
        return;
    }
  }

  private onDispatch(frame: GatewayFrame): void {
    if (frame.payload.case !== 'dispatch') return;
    if (frame.seq !== 0n) {
      if (frame.seq <= this.seq) return; // duplicate after RESUME
      this.seq = frame.seq;
    }
    const ev = frame.payload.value;
    if (ev.event.case === 'ready') {
      this.sessionId = ev.event.value.sessionId;
      this.markEstablished();
    } else if (ev.event.case === 'resumed') {
      this.markEstablished();
    }
    this.deps.onDispatch(ev, frame.seq);
  }

  private markEstablished(): void {
    this.established = true;
    this.attempts = 0;
    this.authFailures = 0;
    this.setStatus('ready');
  }

  private reauthSoon(ws: SocketLike, delay: number): void {
    if (this.identifyTimer) clearTimeout(this.identifyTimer);
    this.setStatus(this.sessionId ? 'resuming' : 'connecting');
    this.identifyTimer = setTimeout(() => {
      this.identifyTimer = null;
      if (ws !== this.ws || this.stopped) return; // stale: that socket is gone
      void this.authenticate();
    }, delay);
  }

  /** Heartbeat now; no ACK within ACK_TIMEOUT_MS → the socket is a zombie. */
  private probe(ws: SocketLike): void {
    this.log('wake: probing the socket');
    this.awaitingAck = true;
    this.lastBeatAt = Date.now();
    this.sendFrame(GatewayOpcode.HEARTBEAT, { case: 'heartbeat', value: create(HeartbeatSchema, { lastSeq: this.seq }) });
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (ws !== this.ws || !this.awaitingAck) return;
      this.log('probe ACK missing, reconnecting');
      this.attempts = 0;
      this.reconnectSoon(0);
    }, ACK_TIMEOUT_MS);
  }

  private async authenticate(): Promise<void> {
    const ws = this.ws;
    const token = await withTimeout(this.deps.getToken(), TOKEN_TIMEOUT_MS);
    if (ws !== this.ws) return; // socket replaced meanwhile
    if (this.stopped) return;
    if (!token) {
      // Transient (offline / 5xx / rate limit): keep the session and retry. A real logout is
      // signalled separately and stops this client (review H3).
      this.log('no access token now, retrying');
      this.clearTimers();
      this.dropSocket(4000);
      this.backoff();
      return;
    }
    if (this.sessionId) {
      this.sendFrame(GatewayOpcode.RESUME, {
        case: 'resume',
        value: create(ResumeSchema, { token, sessionId: this.sessionId, seq: this.seq }),
      });
    } else {
      this.sendFrame(GatewayOpcode.IDENTIFY, {
        case: 'identify',
        value: create(IdentifySchema, {
          token,
          device: create(DeviceInfoSchema, this.deps.device),
          capabilities: 0n,
          tabId: this.deps.tabId?.() ?? '',
        }),
      });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.awaitingAck = false;
    this.lastAckAt = Date.now();
    // First beat after interval × jitter so reconnecting clients don't beat in lockstep.
    const first = Math.round(this.heartbeatMs * this.rnd());
    this.heartbeatTimer = setTimeout(() => this.beat(), first);
  }

  private beat(): void {
    if (!this.ws) return;
    // No ACK within two intervals → the connection is a zombie.
    if (this.awaitingAck && Date.now() - this.lastAckAt > 2 * this.heartbeatMs) {
      this.log('heartbeat ACK missing, reconnecting');
      this.reconnectSoon(0);
      return;
    }
    this.awaitingAck = true;
    this.lastBeatAt = Date.now();
    this.sendFrame(GatewayOpcode.HEARTBEAT, { case: 'heartbeat', value: create(HeartbeatSchema, { lastSeq: this.seq }) });
    this.heartbeatTimer = setTimeout(() => this.beat(), this.heartbeatMs);
  }

  private reconnectSoon(delay: number): void {
    this.clearTimers();
    this.dropSocket(4000);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private backoff(): void {
    const d = backoffDelay(this.attempts, this.rnd());
    this.attempts++;
    this.log(`reconnect in ${d} ms (attempt ${this.attempts})`);
    this.scheduleReconnect(d);
  }

  private onClose(ws: SocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    const wasEstablished = this.established;
    this.established = false;
    this.log(`closed ${code}`);
    if (this.stopped) return;

    const closeCode: GatewayCloseCode = code;
    switch (closeCode) {
      case GatewayCloseCode.AUTHENTICATION_FAILED:
        this.authFailures++;
        this.setStatus('reconnecting');
        // Bounded: a refresh that never settles would otherwise leave the client in
        // 'reconnecting' with neither a socket nor a timer — the banner forever.
        void withTimeout(this.deps.refreshToken(), TOKEN_TIMEOUT_MS).then((t) => {
          if (this.stopped || this.ws || this.reconnectTimer) return;
          // Fresh token: reconnect at once, but back off if the server keeps rejecting it.
          if (t && this.authFailures <= 1) this.scheduleReconnect(0);
          else this.backoff(); // refresh failed now (offline / 5xx): not a logout (review H3)
        });
        return;
      case GatewayCloseCode.SESSION_REVOKED:
        this.stopped = true;
        this.setStatus('stopped');
        this.log(`revoked: ${reason || '(no reason)'}`);
        this.deps.onFatal('revoked', logoutReasonFromClose(reason));
        return;
      case GatewayCloseCode.RATE_LIMITED:
        // 4008 also means «send queue overflow» / «rate limited» (a slow consumer, e.g. a big
        // READY after a deploy): only the IDENTIFY rejection «too many active devices» is fatal.
        // Matched positively: an unknown or reworded reason retries with backoff rather than
        // wrongly telling the user about the device limit.
        if (!wasEstablished && !this.sessionId && TOO_MANY_DEVICES_REASON.test(reason)) {
          // Rejected before READY: too many sessions. Do not retry in a loop.
          this.stopped = true;
          this.setStatus('stopped');
          this.deps.onFatal('too-many-sessions');
          return;
        }
        this.backoff(); // slow consumer / rate limit → RESUME after backoff
        return;
      case GatewayCloseCode.SESSION_EVICTED: {
        // Too many tabs of this auth session; this one was claimed longest ago (#40). The
        // session is gone: the next connect IDENTIFYs. Hidden → park until shown (no timer);
        // visible → a slow backoff that READY does not reset.
        this.sessionId = '';
        this.seq = 0n;
        const n = this.evictions++;
        if (this.deps.isHidden?.()) {
          this.log('evicted by a newer tab, waiting until shown');
          this.parked = true;
          this.setStatus('reconnecting');
          return;
        }
        const d = backoffDelay(n + EVICTED_BACKOFF_SHIFT, this.rnd());
        this.log(`evicted by a newer tab, reconnect in ${d} ms`);
        this.scheduleReconnect(d);
        return;
      }
      case GatewayCloseCode.NOT_AUTHENTICATED:
      case GatewayCloseCode.INVALID_SEQ:
      case GatewayCloseCode.SESSION_TIMED_OUT:
        this.sessionId = '';
        this.seq = 0n;
        this.backoff();
        return;
      default:
        if (closeCode === GatewayCloseCode.UNKNOWN_ERROR && this.deps.renewTabId && REPLACED_REASON.test(reason)) {
          // Another tab IDENTIFYed with this tab's id (a duplicated tab copies sessionStorage):
          // take a new id and IDENTIFY with it, so the two tabs coexist instead of replacing
          // each other (#40). The old session is gone, a RESUME would only be rejected.
          this.deps.renewTabId();
          this.sessionId = '';
          this.seq = 0n;
        }
        this.backoff(); // network drop, 4000–4002, 1006: RESUME
    }
  }
}

/** Resolves `null` if `p` does not settle within `ms` (or rejects). */
function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

export function gatewayUrl(serverUrl: string): string {
  const u = new URL('/gateway', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('v', '1');
  return u.toString();
}
