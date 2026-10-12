import { isMailError, isMailMethod, type MailCall, type MailEvent, type MailReply, type MailToEngine } from '../../shared/mail';

/** The engine process as main sees it: Electron's UtilityProcess satisfies this (tests use a fake). */
export interface EngineChild {
  postMessage(message: MailToEngine): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface MailRouterDeps {
  /** Start a new engine process. */
  fork(): EngineChild;
  /** Deliver an event to every app window. */
  broadcast(event: MailEvent): void;
  log?(message: string, meta?: Record<string, unknown>): void;
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number;
  /**
   * Called right after every fork, before any request is posted: main sends `init` and the account
   * list (T1). Messages are delivered in order, so the engine has them before the first request.
   */
  onSpawn?(post: (message: MailToEngine) => void): void;
}

/** main's own engine requests (not renderer calls): answered like requests, by id. */
export type MailInternal = { kind: 'verify'; input: Extract<MailToEngine, { kind: 'verify' }>['input'] } | { kind: 'attachment'; messageId: string; attachmentId: string };

/** Restart delays after a crash: 1 s, doubling, capped at 60 s (ADR-0088 §2). */
export const RESTART_MIN_MS = 1000;
export const RESTART_MAX_MS = 60_000;
/** An engine that stayed up this long counts as healthy: the next crash starts from 1 s again. */
export const STABLE_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(reply: MailReply): void;
  timer: ReturnType<typeof setTimeout>;
}

const down = (message: string): MailReply => ({ ok: false, error: { code: 'ENGINE_DOWN', message } });

/**
 * main ↔ mail engine relay (ADR-0088 §2, §7): forks the engine on demand, correlates requests by id
 * with a deadline, fans events out to the windows, restarts a crashed engine with exponential backoff.
 * No Electron imports: index.ts wires it to utilityProcess / BrowserWindow.
 */
export class MailRouter {
  private child: EngineChild | null = null;
  private startedAt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restartDelay = RESTART_MIN_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private crashed = false;
  private stopped = false;

  constructor(private readonly deps: MailRouterDeps) {}

  /** Whether an engine process is running. */
  get running(): boolean {
    return this.child !== null;
  }

  /** Start the engine now if it is not running and no restart is pending (idempotent). */
  start(): void {
    if (this.child || this.restartTimer || this.stopped) return;
    this.spawn();
  }

  /** Relay one renderer call. Never rejects: failures are `{ ok: false }`. */
  request(call: unknown): Promise<MailReply> {
    const c = parseCall(call);
    if (!c) return Promise.resolve({ ok: false, error: { code: 'INVALID', message: 'malformed mail request' } });
    if (this.stopped) return Promise.resolve(down('the app is quitting'));
    // Crash loop protection: while a restart is pending, fail fast instead of forking again.
    if (this.restartTimer) return Promise.resolve(down('the mail engine is restarting'));
    if (!this.child) this.spawn();
    const child = this.child;
    if (!child) return Promise.resolve(down('the mail engine did not start'));
    const id = this.nextId++;
    return this.await(id, c.method, undefined, () => child.postMessage({ kind: 'request', req: { id, method: c.method, params: c.params } }));
  }

  /** A main-side request (`verify`, `attachment`): forks the engine if needed, same deadline as calls. */
  internal(msg: MailInternal, timeoutMs?: number): Promise<MailReply> {
    if (this.stopped) return Promise.resolve(down('the app is quitting'));
    if (this.restartTimer) return Promise.resolve(down('the mail engine is restarting'));
    if (!this.child) this.spawn();
    const child = this.child;
    if (!child) return Promise.resolve(down('the mail engine did not start'));
    const id = this.nextId++;
    return this.await(id, msg.kind, timeoutMs, () => child.postMessage({ ...msg, id }));
  }

  /** Posts a one-way message (`accounts`) to a running engine; false when none is running. */
  post(message: MailToEngine): boolean {
    if (!this.child) return false;
    try {
      this.child.postMessage(message);
      return true;
    } catch (e) {
      this.deps.log?.('mail: post to engine failed', { error: String(e) });
      return false;
    }
  }

  private await(id: number, what: string, timeoutMs: number | undefined, send: () => void): Promise<MailReply> {
    const ms = timeoutMs ?? this.timeoutMs;
    return new Promise<MailReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.deps.log?.('mail: request timed out', { method: what });
        resolve(down(`no answer to ${what} in ${Math.round(ms / 1000)} s`));
      }, ms);
      this.pending.set(id, { resolve, timer });
      try {
        send();
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(down(`cannot reach the mail engine: ${String(e)}`));
      }
    });
  }

  /** On quit: kill the engine, fail what is pending, never restart. */
  shutdown(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.failPending('the app is quitting');
    if (child) child.kill();
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private spawn(): void {
    let child: EngineChild;
    try {
      child = this.deps.fork();
    } catch (e) {
      this.deps.log?.('mail: engine fork failed', { error: String(e) });
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    try {
      this.deps.onSpawn?.((m) => child.postMessage(m));
    } catch (e) {
      this.deps.log?.('mail: engine init failed', { error: String(e) });
    }
    child.on('message', (m) => {
      if (this.child === child) this.onMessage(m);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.onExit(code);
    });
    if (this.crashed) {
      this.crashed = false;
      this.deps.broadcast({ type: 'engine', state: 'up' });
    }
  }

  private onMessage(m: unknown): void {
    if (typeof m !== 'object' || m === null) return;
    // Untrusted shape until checked: the engine is ours, but a bug there must not break main.
    const msg = m as { kind?: unknown; event?: { type?: unknown }; res?: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown } };
    if (msg.kind === 'event') {
      if (typeof msg.event?.type === 'string') this.deps.broadcast(msg.event as MailEvent);
      return;
    }
    const res = msg.kind === 'response' ? msg.res : undefined;
    if (typeof res?.id !== 'number') return;
    const p = this.pending.get(res.id);
    if (!p) return; // answered after its deadline
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok === true) p.resolve({ ok: true, result: res.result });
    else p.resolve({ ok: false, error: isMailError(res.error) ? res.error : { code: 'INVALID', message: 'malformed engine error' } });
  }

  private onExit(code: number): void {
    this.child = null;
    this.deps.log?.('mail: engine exited', { code });
    this.failPending(`the mail engine exited (code ${code})`);
    if (this.stopped) return;
    if (Date.now() - this.startedAt >= STABLE_MS) this.restartDelay = RESTART_MIN_MS;
    this.crashed = true;
    this.deps.broadcast({ type: 'engine', state: 'down' });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this.spawn();
    }, delay);
  }

  private failPending(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(down(message));
    }
    this.pending.clear();
  }
}

/** Validates the renderer's call: a known method and a positional argument list. */
export function parseCall(v: unknown): MailCall | null {
  if (typeof v !== 'object' || v === null) return null;
  const { method, params } = v as { method?: unknown; params?: unknown };
  if (!isMailMethod(method) || !Array.isArray(params) || params.length > 4) return null;
  return { method, params: params as unknown[] };
}
