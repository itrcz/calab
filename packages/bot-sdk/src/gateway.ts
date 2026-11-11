import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DeviceInfoSchema,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  HeartbeatSchema,
  IdentifySchema,
  ResumeSchema,
  SubscribeSchema,
  TypingSchema,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';
import type { GatewayFatal } from './errors.js';

/**
 * WS gateway client for bots (docs/05-realtime-protocol.md): binary protobuf `GatewayFrame`s,
 * HELLO → IDENTIFY (bot token) → READY, heartbeats, reconnect with exponential backoff and RESUME
 * (the server replays what was missed), re-IDENTIFY after INVALID_SESSION.
 */

/** The subset of the WebSocket API used here (`ws` in Node, or a fake in tests). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type GatewayStatus = 'idle' | 'connecting' | 'resuming' | 'ready' | 'reconnecting' | 'stopped';

export interface GatewayOptions {
  /** ws(s)://host/gateway?v=1 */
  url: string;
  token: string;
  createSocket: (url: string) => SocketLike;
  onDispatch: (ev: DispatchEvent, seq: bigint) => void;
  onStatus?: (s: GatewayStatus) => void;
  onFatal: (kind: GatewayFatal, code: number, reason: string) => void;
  log?: (msg: string) => void;
  device?: { name: string; platform: string; appVersion: string };
  /** Reconnect backoff: base (default 1 s) and cap (default 30 s), ±50 % jitter. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Delay before re-IDENTIFY after INVALID_SESSION: min + random × jitter (default 1 s + 0..4 s). */
  invalidSessionMinMs?: number;
  invalidSessionJitterMs?: number;
  /** HELLO must arrive within this time after the socket is created (default 10 s). */
  helloTimeoutMs?: number;
  random?: () => number;
}

const OPEN = 1;
/** Close 4000 with this reason: another connection with the same token took over (gateway/handler.go). */
const REPLACED_REASON = /replaced/i;
/** Close 4008 before READY with this reason: the per-user device limit. */
const TOO_MANY_DEVICES_REASON = /devices/i;

export function gatewayUrl(server: string): string {
  const u = new URL('/gateway', server);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('v', '1');
  return u.toString();
}

export class Gateway {
  private ws: SocketLike | null = null;
  private status: GatewayStatus = 'idle';
  private sessionId = '';
  private seq = 0n;
  private attempts = 0;
  private heartbeatMs = 41_000;
  private established = false;
  private awaitingAck = false;
  private lastAckAt = 0;
  private stopped = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly rnd: () => number;

  constructor(private readonly o: GatewayOptions) {
    this.rnd = o.random ?? Math.random;
  }

  get state(): { status: GatewayStatus; sessionId: string; seq: bigint } {
    return { status: this.status, sessionId: this.sessionId, seq: this.seq };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Closes with 1000: the server ends the session at once (no RESUME, presence offline). */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.sessionId = '';
    this.seq = 0n;
    this.dropSocket(1000);
    this.setStatus('stopped');
  }

  /** TYPING_START for a room (needs VIEW_ROOM + SEND_MESSAGES; the server drops extras within 3 s). */
  typing(roomId: string): boolean {
    return this.send(GatewayOpcode.TYPING, { case: 'typing', value: create(TypingSchema, { roomId }) });
  }

  /** Replaces the set of rooms whose TYPING_START this session receives (≤ 100). */
  subscribe(roomIds: string[]): boolean {
    return this.send(GatewayOpcode.SUBSCRIBE, { case: 'subscribe', value: create(SubscribeSchema, { roomIds }) });
  }

  // ---- internals ----

  private log(msg: string): void {
    this.o.log?.(`[gateway] ${msg}`);
  }

  private setStatus(s: GatewayStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus?.(s);
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private cancel(t: ReturnType<typeof setTimeout> | null): void {
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.helloTimer = this.heartbeatTimer = null;
  }

  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  private dropSocket(code: number): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    // Keep a no-op error listener: closing a socket that is still CONNECTING makes `ws` emit 'error'
    // on the next tick, and an EventEmitter 'error' with no listener crashes the process.
    ws.onerror = () => undefined;
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.established = false;
    this.awaitingAck = false;
    this.setStatus(this.sessionId ? 'resuming' : 'connecting');
    let ws: SocketLike;
    try {
      ws = this.o.createSocket(this.o.url);
    } catch (err) {
      this.log(`socket create failed: ${String(err)}`);
      this.backoff();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => {
      this.onMessage(ws, ev.data);
    };
    ws.onclose = (ev) => {
      this.onClose(ws, ev.code, ev.reason);
    };
    ws.onerror = () => {
      // onclose follows
    };
    this.helloTimer = this.later(() => {
      if (ws !== this.ws) return;
      this.log('no HELLO in time, reconnecting');
      this.reconnect(true);
    }, this.o.helloTimeoutMs ?? 10_000);
  }

  private send(op: GatewayOpcode, payload: GatewayFrame['payload']): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op, payload })));
    return true;
  }

  private onMessage(ws: SocketLike, data: unknown): void {
    if (ws !== this.ws) return;
    let frame: GatewayFrame;
    try {
      const bytes =
        data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? concat(data as Uint8Array[]) : null;
      if (!bytes) throw new Error(`unexpected frame type ${typeof data}`);
      frame = fromBinary(GatewayFrameSchema, bytes);
    } catch (err) {
      this.log(`bad frame: ${String(err)}`);
      return;
    }
    switch (frame.payload.case) {
      case 'hello':
        this.cancel(this.helloTimer);
        this.helloTimer = null;
        this.heartbeatMs = frame.payload.value.heartbeatIntervalMs || this.heartbeatMs;
        this.startHeartbeat();
        this.authenticate();
        return;
      case 'heartbeatAck':
        this.awaitingAck = false;
        this.lastAckAt = Date.now();
        return;
      case 'reconnect':
        this.log('server asked to reconnect');
        this.reconnect(false, 0);
        return;
      case 'invalidSession': {
        this.log(`invalid session (resumable=${frame.payload.value.resumable})`);
        if (!frame.payload.value.resumable) {
          this.sessionId = '';
          this.seq = 0n;
        }
        const delay = (this.o.invalidSessionMinMs ?? 1000) + Math.round(this.rnd() * (this.o.invalidSessionJitterMs ?? 4000));
        if (this.established) {
          // a server-side resync after READY: the server closes the socket itself; start over
          this.reconnect(false, delay);
        } else {
          // a rejected RESUME keeps the socket open: IDENTIFY on it
          this.setStatus('connecting');
          this.later(() => {
            if (ws === this.ws && !this.stopped) this.authenticate();
          }, delay);
        }
        return;
      }
      case 'dispatch': {
        if (frame.seq !== 0n) {
          if (frame.seq <= this.seq) return; // already seen (replay after RESUME)
          this.seq = frame.seq;
        }
        const ev = frame.payload.value;
        if (ev.event.case === 'ready') this.sessionId = ev.event.value.sessionId;
        if (ev.event.case === 'ready' || ev.event.case === 'resumed') {
          this.established = true;
          this.attempts = 0;
          this.setStatus('ready');
        }
        this.o.onDispatch(ev, frame.seq);
        return;
      }
      default:
        return;
    }
  }

  private authenticate(): void {
    if (this.sessionId) {
      this.send(GatewayOpcode.RESUME, { case: 'resume', value: create(ResumeSchema, { token: this.o.token, sessionId: this.sessionId, seq: this.seq }) });
      return;
    }
    const device = this.o.device ?? { name: 'bot', platform: typeof process !== 'undefined' ? process.platform : 'unknown', appVersion: 'calab-bot-sdk/0.1' };
    this.send(GatewayOpcode.IDENTIFY, {
      case: 'identify',
      value: create(IdentifySchema, { token: this.o.token, device: create(DeviceInfoSchema, device), capabilities: 0n }),
    });
  }

  private startHeartbeat(): void {
    this.cancel(this.heartbeatTimer);
    this.awaitingAck = false;
    this.lastAckAt = Date.now();
    // first beat after interval × jitter, so reconnecting clients do not beat in lockstep
    this.heartbeatTimer = this.later(() => {
      this.beat();
    }, Math.round(this.heartbeatMs * this.rnd()));
  }

  private beat(): void {
    if (!this.ws) return;
    if (this.awaitingAck && Date.now() - this.lastAckAt > 2 * this.heartbeatMs) {
      this.log('heartbeat ACK missing, reconnecting');
      this.reconnect(false, 0);
      return;
    }
    this.awaitingAck = true;
    this.send(GatewayOpcode.HEARTBEAT, { case: 'heartbeat', value: create(HeartbeatSchema, { lastSeq: this.seq }) });
    this.heartbeatTimer = this.later(() => {
      this.beat();
    }, this.heartbeatMs);
  }

  /** Drops the socket and connects again: with backoff, or after `delay`. */
  private reconnect(withBackoff: boolean, delay = 0): void {
    this.clearTimers();
    this.dropSocket(4000);
    if (withBackoff) this.backoff();
    else this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    this.later(() => {
      this.connect();
    }, delay);
  }

  private backoff(): void {
    const base = Math.min(this.o.backoffMaxMs ?? 30_000, (this.o.backoffBaseMs ?? 1000) * 2 ** this.attempts);
    const d = Math.round(base * (0.5 + this.rnd() * 0.5));
    this.attempts++;
    this.log(`reconnect in ${d} ms (attempt ${this.attempts})`);
    this.schedule(d);
  }

  private fatal(kind: GatewayFatal, code: number, reason: string): void {
    this.stopped = true;
    this.sessionId = '';
    this.seq = 0n;
    this.setStatus('stopped');
    this.o.onFatal(kind, code, reason);
  }

  private onClose(ws: SocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    const wasEstablished = this.established;
    this.established = false;
    this.log(`closed ${code}${reason ? ` ${reason}` : ''}`);
    if (this.stopped) return;
    // numeric WebSocket close code narrowed to the protocol enum
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
    const closeCode: GatewayCloseCode = code;
    switch (closeCode) {
      case GatewayCloseCode.AUTHENTICATION_FAILED:
        this.fatal('auth-failed', code, reason);
        return;
      case GatewayCloseCode.SESSION_REVOKED:
        this.fatal('revoked', code, reason);
        return;
      case GatewayCloseCode.UNKNOWN_ERROR:
        if (REPLACED_REASON.test(reason)) {
          this.fatal('replaced', code, reason);
          return;
        }
        this.backoff();
        return;
      case GatewayCloseCode.RATE_LIMITED:
        if (!wasEstablished && !this.sessionId && TOO_MANY_DEVICES_REASON.test(reason)) {
          this.fatal('too-many-sessions', code, reason);
          return;
        }
        this.backoff();
        return;
      case GatewayCloseCode.NOT_AUTHENTICATED:
      case GatewayCloseCode.INVALID_SEQ:
      case GatewayCloseCode.SESSION_TIMED_OUT:
        this.sessionId = '';
        this.seq = 0n;
        this.backoff();
        return;
      default:
        this.backoff(); // network drop, 1006, 4001/4002: RESUME
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
