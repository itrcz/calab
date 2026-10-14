import { isMailError, isMailMethod, MAIL_DEFAULT_TIMEOUT_MS, MAIL_METHOD_TIMEOUT_MS, type MailCall, type MailEvent, type MailReply, type MailToEngine } from '../../shared/mail';

/** The engine process as main sees it: Electron's UtilityProcess satisfies this (tests use a fake). */
export interface EngineChild {
  postMessage(message: MailToEngine): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
  /** The engine's stderr (`stdio: 'pipe'`): its last lines go to the log when it exits. */
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
}

export interface MailRouterDeps {
  /** Start a new engine process. */
  fork(): EngineChild;
  /** Deliver an event to every app window. */
  broadcast(event: MailEvent): void;
  log?(message: string, meta?: Record<string, unknown>, level?: 'info' | 'warn'): void;
  /** Overrides every deadline (tests); default: `MAIL_METHOD_TIMEOUT_MS`, else 30 s. */
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
export const REQUEST_TIMEOUT_MS = MAIL_DEFAULT_TIMEOUT_MS;
/** This many exits within `CRASH_WINDOW_MS` = the engine does not start: `engine: failed`. */
export const CRASH_LOOP_EXITS = 3;
export const CRASH_WINDOW_MS = 60_000;
/** stderr lines kept per engine process (a ring buffer) and their length cap. */
export const STDERR_LINES = 20;
const STDERR_LINE_MAX = 500;

/** The deadline of a method / internal request. */
export function deadlineOf(what: string): number {
  return (MAIL_METHOD_TIMEOUT_MS as Record<string, number | undefined>)[what] ?? REQUEST_TIMEOUT_MS;
}

/** The last `max` lines of a stream, as they come (partial last line kept apart). */
export class LineTail {
  private lines: string[] = [];
  private partial = '';
  constructor(private readonly max = STDERR_LINES) {}
  push(chunk: Buffer | string): void {
    const text = this.partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const parts = text.split(/\r?\n/);
    this.partial = (parts.pop() ?? '').slice(-STDERR_LINE_MAX * 4);
    for (const l of parts) if (l.trim()) this.lines.push(l.slice(0, STDERR_LINE_MAX));
    if (this.lines.length > this.max) this.lines = this.lines.slice(-this.max);
  }
  all(): string[] {
    const out = this.partial.trim() ? [...this.lines, this.partial.slice(0, STDERR_LINE_MAX)] : [...this.lines];
    return out.slice(-this.max);
  }
}

interface Pending {
  resolve(reply: MailReply): void;
  timer: ReturnType<typeof setTimeout>;
}

const down = (message: string): MailReply => ({ ok: false, error: { code: 'ENGINE_DOWN', message } });
const timedOut = (message: string): MailReply => ({ ok: false, error: { code: 'TIMEOUT', message } });

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
  private tail = new LineTail();
  /** Exit times within the crash window, and the crash-loop report while failed. */
  private exits: number[] = [];
  private failedReport: string | null = null;
  private readonly reportLines: string[] = [];

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
    const child = this.ensureChild();
    if ('ok' in child) return Promise.resolve(child);
    const id = this.nextId++;
    return this.await(id, c.method, undefined, () => child.postMessage({ kind: 'request', req: { id, method: c.method, params: c.params } }));
  }

  /** A main-side request (`verify`, `attachment`): forks the engine if needed; deadline by kind. */
  internal(msg: MailInternal, timeoutMs?: number): Promise<MailReply> {
    const child = this.ensureChild();
    if ('ok' in child) return Promise.resolve(child);
    const id = this.nextId++;
    return this.await(id, msg.kind, timeoutMs, () => child.postMessage({ ...msg, id }));
  }

  /** The running engine (forked if needed), or the reply for why there is none. */
  private ensureChild(): EngineChild | MailReply {
    if (this.stopped) return down('the app is quitting');
    // Crash loop protection: while a restart is pending, fail fast instead of forking again.
    if (this.restartTimer) return this.failedReport !== null ? this.failedReply() : down('the mail engine is restarting');
    if (!this.child) this.spawn();
    return this.child ?? (this.failedReport !== null ? this.failedReply() : down('the mail engine did not start'));
  }

  private failedReply(): MailReply {
    return { ok: false, error: { code: 'ENGINE_FAILED', message: 'the mail engine keeps exiting', report: this.failedReport ?? '' } };
  }

  /** Whether the engine is in a crash loop (`engine: failed`), and its report. */
  get failure(): string | null {
    return this.failedReport;
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
    const ms = timeoutMs ?? this.deps.timeoutMs ?? deadlineOf(what);
    return new Promise<MailReply>((resolve) => {
      const timer = setTimeout(() => {
        // The engine is alive (or its exit fails this first): a slow server, not a dead process.
        this.pending.delete(id);
        this.deps.log?.('mail: request timed out', { method: what, seconds: Math.round(ms / 1000) });
        resolve(timedOut(`no answer to ${what} in ${Math.round(ms / 1000)} s`));
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

  private spawn(): void {
    let child: EngineChild;
    try {
      child = this.deps.fork();
    } catch (e) {
      this.deps.log?.('mail: engine fork failed', { error: String(e) });
      this.noteExit(`fork failed: ${String(e)}`, []);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    const tail = new LineTail();
    this.tail = tail;
    try {
      child.stderr?.on('data', (chunk) => tail.push(chunk));
    } catch {
      // no stderr: exits are logged without it
    }
    this.deps.log?.('mail: engine spawned', {}, 'info');
    try {
      this.deps.onSpawn?.((m) => child.postMessage(m));
    } catch (e) {
      this.deps.log?.('mail: engine init failed', { error: String(e) });
    }
    child.on('message', (m) => {
      if (this.child === child) this.onMessage(m);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.onExit(code, tail);
    });
  }

  /** The engine loaded and listens (`ready`, or any answer): end a `down` / `failed` state. */
  private onUp(): void {
    if (!this.crashed && this.failedReport === null) return;
    this.crashed = false;
    this.failedReport = null;
    this.reportLines.length = 0;
    this.deps.broadcast({ type: 'engine', state: 'up' });
  }

  private onMessage(m: unknown): void {
    if (typeof m !== 'object' || m === null) return;
    // Untrusted shape until checked: the engine is ours, but a bug there must not break main.
    const msg = m as { kind?: unknown; event?: { type?: unknown }; res?: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown } };
    if (msg.kind === 'ready') {
      this.onUp();
      return;
    }
    this.onUp();
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

  private onExit(code: number, tail: LineTail): void {
    this.child = null;
    const lastStderr = tail.all();
    // The engine never writes secrets to stderr (engine.ts `log`); a crash prints its stack there.
    this.deps.log?.('mail: engine exited', { code, lastStderr });
    this.failPending(`the mail engine exited (code ${code})`);
    if (this.stopped) return;
    if (Date.now() - this.startedAt >= STABLE_MS) this.restartDelay = RESTART_MIN_MS;
    this.crashed = true;
    if (!this.noteExit(`exit code ${code}`, lastStderr)) this.deps.broadcast({ type: 'engine', state: 'down' });
    this.scheduleRestart();
  }

  /**
   * Counts an exit / failed fork; true when it made (or keeps) the crash-loop state, which is then
   * announced with its report instead of another `down`.
   */
  private noteExit(what: string, lastStderr: string[]): boolean {
    const now = Date.now();
    this.exits = [...this.exits.filter((t) => now - t < CRASH_WINDOW_MS), now];
    this.reportLines.push(`${new Date(now).toISOString()} mail engine: ${what}`, ...lastStderr.map((l) => `  ${l}`));
    if (this.reportLines.length > 4 * STDERR_LINES) this.reportLines.splice(0, this.reportLines.length - 4 * STDERR_LINES);
    if (this.exits.length < CRASH_LOOP_EXITS && this.failedReport === null) return false;
    this.crashed = true;
    this.failedReport = this.reportLines.join('\n');
    this.deps.broadcast({ type: 'engine', state: 'failed', report: this.failedReport });
    return true;
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
