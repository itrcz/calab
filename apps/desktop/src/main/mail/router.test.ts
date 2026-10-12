import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailEvent, MailFromEngine, MailToEngine } from '../../shared/mail';
import { LineTail, MailRouter, REQUEST_TIMEOUT_MS, STDERR_LINES, type EngineChild } from './router';

class FakeChild implements EngineChild {
  sent: MailToEngine[] = [];
  killed = false;
  private onMsg: ((m: unknown) => void) | null = null;
  private onExit: ((code: number) => void) | null = null;
  private onErr: ((chunk: Buffer | string) => void) | null = null;
  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void): void => {
      this.onErr = listener;
    },
  };
  writeErr(text: string): void {
    this.onErr?.(text);
  }
  ready(): void {
    this.onMsg?.({ kind: 'ready' });
  }
  postMessage(m: MailToEngine): void {
    this.sent.push(m);
  }
  on(event: 'message', listener: (m: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: string, listener: (v: never) => void): this {
    if (event === 'message') this.onMsg = listener as (m: unknown) => void;
    else this.onExit = listener as (code: number) => void;
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  reply(m: MailFromEngine): void {
    this.onMsg?.(m);
  }
  exit(code = 1): void {
    this.onExit?.(code);
  }
  lastIdOf(kind: 'request'): number {
    const m = [...this.sent].reverse().find((x) => x.kind === kind);
    if (m?.kind !== 'request') throw new Error('nothing sent');
    return m.req.id;
  }
  lastId(): number {
    const last = this.sent[this.sent.length - 1];
    if (last?.kind !== 'request') throw new Error('nothing sent');
    return last.req.id;
  }
}

function setup(): { router: MailRouter; children: FakeChild[]; events: MailEvent[]; logs: Array<[string, Record<string, unknown> | undefined]> } {
  const children: FakeChild[] = [];
  const events: MailEvent[] = [];
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const router = new MailRouter({
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    broadcast: (e) => events.push(e),
    log: (m, meta) => logs.push([m, meta]),
  });
  return { router, children, events, logs };
}

describe('MailRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forks lazily on the first request and matches replies by id', async () => {
    const { router, children } = setup();
    expect(children).toHaveLength(0);
    const a = router.request({ method: 'accounts.list', params: [] });
    const b = router.request({ method: 'settings.get', params: [] });
    expect(children).toHaveLength(1);
    const child = children[0];
    if (!child) throw new Error('no child');
    const [ra, rb] = child.sent.flatMap((m) => (m.kind === 'request' ? [m.req] : []));
    expect(ra?.method).toBe('accounts.list');
    // Out of order: b first.
    child.reply({ kind: 'response', res: { id: rb?.id ?? -1, ok: true, result: 'B' } });
    child.reply({ kind: 'response', res: { id: ra?.id ?? -1, ok: false, error: { code: 'NOT_FOUND', message: 'x' } } });
    await expect(b).resolves.toEqual({ ok: true, result: 'B' });
    await expect(a).resolves.toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } });
    // Unknown / late ids are ignored.
    child.reply({ kind: 'response', res: { id: 999, ok: true, result: null } });
  });

  it('rejects malformed calls without forking', async () => {
    const { router, children } = setup();
    await expect(router.request({ method: 'fs.readFile', params: [] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    await expect(router.request({ method: 'accounts.list' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    await expect(router.request(null)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(children).toHaveLength(0);
  });

  it('times out with TIMEOUT after 30 s (the engine keeps running) and ignores the late reply', async () => {
    const { router, children } = setup();
    const p = router.request({ method: 'sync.now', params: [] });
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    const child = children[0];
    child?.reply({ kind: 'response', res: { id: child.lastId(), ok: true, result: null } });
    expect(child?.killed).toBe(false);
    // The next call goes to the same engine.
    void router.request({ method: 'sync.now', params: [] });
    expect(children).toHaveLength(1);
  });

  it('per-method deadlines: discover 25 s, add / update / send 60 s, others 30 s', async () => {
    const { router } = setup();
    const settledAfter = async (method: string, params: unknown[]): Promise<number> => {
      const state = { done: false };
      const p = router.request({ method, params }).then((r) => {
        state.done = true;
        return r;
      });
      let ms = 0;
      while (!state.done && ms < 120_000) {
        vi.advanceTimersByTime(1000);
        ms += 1000;
        await Promise.resolve();
        await Promise.resolve();
      }
      await expect(p).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
      return ms;
    };
    expect(await settledAfter('accounts.discover', ['a@b.cd'])).toBe(25_000);
    expect(await settledAfter('compose.send', [{}])).toBe(60_000);
    expect(await settledAfter('folders.empty', ['f'])).toBe(60_000);
    expect(await settledAfter('messages.list', [{}])).toBe(30_000);
    let done = false;
    const v = router.internal({ kind: 'verify', input: { email: 'a@b.c', password: 'p' } }).then((r) => ((done = true), r));
    vi.advanceTimersByTime(59_999);
    await Promise.resolve();
    expect(done).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(v).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('logs spawn and exit with the last stderr lines', () => {
    const { router, children, logs } = setup();
    router.start();
    expect(logs.map((l) => l[0])).toContain('mail: engine spawned');
    const c = children[0];
    for (let i = 0; i < 30; i++) c?.writeErr(`line ${String(i)}\n`);
    c?.writeErr("Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './decode' is not defined");
    c?.exit(1);
    const exit = logs.find((l) => l[0] === 'mail: engine exited');
    expect(exit?.[1]?.['code']).toBe(1);
    const tail = exit?.[1]?.['lastStderr'] as string[];
    expect(tail).toHaveLength(STDERR_LINES);
    expect(tail[tail.length - 1]).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(tail[0]).toBe('line 11');
  });

  it('a crash loop (3 exits in a minute) becomes engine: failed with a report; ready ends it', async () => {
    const { router, children, events } = setup();
    router.start();
    children[0]?.writeErr('boom at load\n');
    children[0]?.exit(1);
    vi.advanceTimersByTime(1000);
    children[1]?.exit(1);
    expect(events).toEqual([
      { type: 'engine', state: 'down' },
      { type: 'engine', state: 'down' },
    ]);
    vi.advanceTimersByTime(2000);
    children[2]?.writeErr('boom again');
    children[2]?.exit(1);
    const failed = events[events.length - 1];
    expect(failed).toMatchObject({ type: 'engine', state: 'failed' });
    const report = failed?.type === 'engine' && failed.state === 'failed' ? failed.report : '';
    expect(report).toContain('exit code 1');
    expect(report).toContain('boom at load');
    expect(report).toContain('boom again');
    // Requests fail fast with ENGINE_FAILED + the report while the restart is pending.
    await expect(router.request({ method: 'accounts.list', params: [] })).resolves.toMatchObject({ ok: false, error: { code: 'ENGINE_FAILED', report } });
    expect(router.failure).toBe(report);
    // Restarts go on; the next engine that loads ends the state.
    vi.advanceTimersByTime(4000);
    expect(children).toHaveLength(4);
    children[3]?.ready();
    expect(events[events.length - 1]).toEqual({ type: 'engine', state: 'up' });
    expect(router.failure).toBeNull();
  });

  it('LineTail keeps the last lines, joins chunks split mid-line, caps line length', () => {
    const t = new LineTail(3);
    t.push('a\nb');
    t.push('c\r\nd\n\n');
    t.push(Buffer.from('e'));
    expect(t.all()).toEqual(['bc', 'd', 'e']);
    const long = new LineTail(2);
    long.push(`${'x'.repeat(2000)}\n`);
    expect(long.all()[0]?.length).toBe(500);
  });

  it('fails pending requests on exit and restarts with exponential backoff', async () => {
    const { router, children, events } = setup();
    const p = router.request({ method: 'accounts.list', params: [] });
    children[0]?.exit(1);
    await expect(p).resolves.toMatchObject({ ok: false, error: { code: 'ENGINE_DOWN' } });
    expect(events).toEqual([{ type: 'engine', state: 'down' }]);
    // `up` comes from the engine (`ready`), not from the fork.
    // While the restart is pending, requests fail fast and do not fork.
    await expect(router.request({ method: 'accounts.list', params: [] })).resolves.toMatchObject({ ok: false, error: { code: 'ENGINE_DOWN' } });
    expect(children).toHaveLength(1);

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = children.length;
      let waited = 0;
      while (children.length === before) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
      children[children.length - 1]?.ready();
      children[children.length - 1]?.exit(1);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(events.filter((e) => e.type === 'engine' && e.state === 'up')).toHaveLength(8);
  });

  it('resets the backoff after a stable run', () => {
    const { router, children } = setup();
    router.start();
    children[0]?.exit(1);
    vi.advanceTimersByTime(1000);
    children[1]?.exit(1); // next delay would be 2 s
    vi.advanceTimersByTime(2000);
    expect(children).toHaveLength(3);
    vi.advanceTimersByTime(60_000); // up for a minute
    children[2]?.exit(1);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(4);
  });

  it('fans engine events out and ignores malformed messages', () => {
    const { router, children, events } = setup();
    router.start();
    const ev: MailEvent = { type: 'new_mail', accountId: 'a', messageId: 'm', threadId: 't', from: { name: '', address: 'x@y.z' }, subject: 's' };
    children[0]?.reply({ kind: 'event', event: ev });
    children[0]?.reply({ kind: 'event' } as unknown as MailFromEngine);
    (children[0] as unknown as { reply(m: unknown): void }).reply('garbage');
    expect(events).toEqual([ev]);
  });

  it('shutdown kills the engine, fails pending and never restarts', async () => {
    const { router, children } = setup();
    const p = router.request({ method: 'accounts.list', params: [] });
    router.shutdown();
    await expect(p).resolves.toMatchObject({ ok: false, error: { code: 'ENGINE_DOWN' } });
    expect(children[0]?.killed).toBe(true);
    children[0]?.exit(0);
    vi.advanceTimersByTime(120_000);
    expect(children).toHaveLength(1);
    await expect(router.request({ method: 'accounts.list', params: [] })).resolves.toMatchObject({ ok: false, error: { code: 'ENGINE_DOWN' } });
  });

  it('posts init + accounts on every fork before requests; internal requests share the id space', async () => {
    const children: FakeChild[] = [];
    let spawns = 0;
    const router = new MailRouter({
      fork: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      broadcast: () => undefined,
      onSpawn: (post) => {
        spawns++;
        post({ kind: 'init', dataDir: '/data' });
        post({ kind: 'accounts', accounts: [] });
      },
    });
    const call = router.request({ method: 'accounts.list', params: [] });
    const v = router.internal({ kind: 'verify', input: { email: 'a@b.c', password: 'p' } });
    const child = children[0];
    if (!child) throw new Error('no child');
    expect(child.sent.map((m) => m.kind)).toEqual(['init', 'accounts', 'request', 'verify']);
    const vm = child.sent[3];
    if (vm?.kind !== 'verify') throw new Error('no verify');
    child.reply({ kind: 'response', res: { id: vm.id, ok: false, error: { code: 'AUTH_FAILED', message: 'no' } } });
    await expect(v).resolves.toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    child.reply({ kind: 'response', res: { id: child.lastIdOf('request'), ok: true, result: [] } });
    await expect(call).resolves.toEqual({ ok: true, result: [] });
    expect(router.post({ kind: 'accounts', accounts: [] })).toBe(true);
    child.exit(1);
    expect(router.post({ kind: 'accounts', accounts: [] })).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(spawns).toBe(2);
    expect(children[1]?.sent.map((m) => m.kind)).toEqual(['init', 'accounts']);
  });
});
