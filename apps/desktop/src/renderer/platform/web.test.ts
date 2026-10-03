import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Web platform auth + media cache (review H3, L1-style race, L6, M10). */

const listeners = new Map<string, Array<(e: unknown) => void>>();
vi.stubGlobal('window', Object.assign(globalThis, {
  addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
}));
vi.stubGlobal('document', { addEventListener: () => undefined });
vi.stubGlobal('navigator', { userAgent: 'Chrome/150', onLine: true });
vi.stubGlobal('location', { origin: 'https://app.example.com', pathname: '/', search: '' });

type Handler = (url: string, init: RequestInit) => Promise<Response>;
let handler: Handler = () => Promise.reject(new Error('no handler'));
const fetchSpy = vi.fn((url: string, init: RequestInit = {}) => handler(url, init));
vi.stubGlobal('fetch', fetchSpy);

const created: string[] = [];
const revoked: string[] = [];
let n = 0;
vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
  const u = `blob:${++n}`;
  created.push(u);
  return u;
});
vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));

const { REFRESH_COOLDOWN_MS } = await import('../../shared/refreshGate');

const tokens = (i: number) => ({ tokens: { accessToken: `a${i}`, accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), sessionId: 's' } });
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let platform: ReturnType<(typeof import('./web'))['createWebPlatform']>;

beforeEach(async () => {
  vi.resetModules();
  fetchSpy.mockClear();
  created.length = 0;
  revoked.length = 0;
  platform = (await import('./web')).createWebPlatform();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('web auth', () => {
  it('a transient refresh failure is not a logout (review H3)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const out: string[] = [];
    platform.auth.onLoggedOut((r) => out.push(r));
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : Promise.resolve(json(503, {})));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(out).toEqual([]);
    vi.setSystemTime(Date.now() + REFRESH_COOLDOWN_MS);
    handler = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(out).toEqual([]);
  });

  it('refresh is bounded by a timeout, and a transient failure is not retried for a few seconds (review N3)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const out: string[] = [];
    platform.auth.onLoggedOut((r) => out.push(r));
    const signals: Array<AbortSignal | null | undefined> = [];
    handler = (url, init) => {
      if (url.endsWith('/login')) return Promise.resolve(json(200, { ...tokens(1), me: {} }));
      signals.push(init.signal);
      // What an aborted (timed-out) fetch does.
      return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    };
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(out).toEqual([]);
    // An outage: more callers within the cooldown do not POST again.
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(signals).toHaveLength(1);
    vi.setSystemTime(Date.now() + REFRESH_COOLDOWN_MS);
    handler = () => Promise.resolve(json(200, tokens(2)));
    expect(await platform.auth.forceRefresh()).toBe('a2');
  });

  it('401 on refresh signs out once', async () => {
    const out: string[] = [];
    platform.auth.onLoggedOut((r) => out.push(r));
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : Promise.resolve(json(401, {})));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(out).toEqual(['expired']);
  });

  it('409 (another tab rotated the cookie) is retried and succeeds', async () => {
    let calls = 0;
    handler = (url) => {
      if (url.endsWith('/login')) return Promise.resolve(json(200, { ...tokens(1), me: {} }));
      calls++;
      return Promise.resolve(calls === 1 ? json(409, {}) : json(200, tokens(2)));
    };
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBe('a2');
  });

  it('a refresh answer arriving after logout does not resurrect the session', async () => {
    let release!: (r: Response) => void;
    handler = (url) => {
      if (url.endsWith('/login')) return Promise.resolve(json(200, { ...tokens(1), me: {} }));
      if (url.endsWith('/logout')) return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise<Response>((r) => (release = r));
    };
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    const p = platform.auth.forceRefresh();
    await platform.auth.logout(false);
    release(json(200, tokens(9)));
    expect(await p).toBeNull();
    // Still signed out: nothing to refresh, no token was adopted.
    expect(await platform.auth.forceRefresh()).toBeNull();
  });

  it('apiFetch replays only replayable bodies after a 401', async () => {
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : url.endsWith('/refresh') ? Promise.resolve(json(200, tokens(2))) : Promise.resolve(json(401, {})));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    fetchSpy.mockClear();
    await platform.apiFetch('/api/x', { method: 'POST', body: '{"a":1}' });
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/x')).toHaveLength(2);
    fetchSpy.mockClear();
    await platform.apiFetch('/api/upload', { method: 'POST', body: new FormData() });
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/upload')).toHaveLength(1);
  });
});

describe('web media cache (review M10)', () => {
  it('logout revokes every cached blob URL', async () => {
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : url.endsWith('/logout') ? Promise.resolve(new Response(null, { status: 204 })) : Promise.resolve(new Response(new Blob(['x']), { status: 200 })));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    const a = await platform.mediaUrl('/api/files/1');
    const again = await platform.mediaUrl('/api/files/1');
    expect(again).toBe(a);
    await platform.mediaUrl('/api/files/2');
    await platform.auth.logout(false);
    expect(revoked.sort()).toEqual([...created].sort());
  });

  it('evicted entries are revoked (after a grace period), not leaked', async () => {
    vi.useFakeTimers();
    handler = () => Promise.resolve(new Response(new Blob(['x']), { status: 200 }));
    for (let i = 0; i < 305; i++) await platform.mediaUrl(`/api/files/${i}`);
    expect(revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoked).toHaveLength(5);
    expect(revoked).toContain(created[0]);
  });

  it('an entry evicted while still loading is revoked after it resolves and never counted', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    handler = (url) =>
      url === '/api/files/slow'
        ? new Promise<Response>((r) => (release = r))
        : Promise.resolve(new Response(new Blob(['x']), { status: 200 }));
    const slow = platform.mediaUrl('/api/files/slow');
    // 300 newer entries push the loading one out of the LRU.
    for (let i = 0; i < 300; i++) await platform.mediaUrl(`/api/files/${i}`);
    expect(revoked).toEqual([]);
    release(new Response(new Blob(['y']), { status: 200 }));
    const u = await slow;
    expect(u).toMatch(/^blob:/);
    expect(revoked).not.toContain(u); // the caller still gets a usable URL for a moment
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoked).toContain(u);
    // Not cached any more: asking again fetches it anew.
    fetchSpy.mockClear();
    handler = () => Promise.resolve(new Response(new Blob(['z']), { status: 200 }));
    const again = await platform.mediaUrl('/api/files/slow');
    expect(again).not.toBe(u);
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/files/slow')).toHaveLength(1);
  });
});

describe('web openExternal (ADR-0045 amendment 1: «Подключиться» of an external event)', () => {
  it('opens http(s) links whatever the case of the scheme, refuses other schemes', async () => {
    const opened: string[] = [];
    vi.stubGlobal('open', (u: string) => {
      opened.push(u);
      return null;
    });
    await platform.app.openExternal('https://telemost.yandex.ru/j/1');
    await platform.app.openExternal('HTTPS://Zoom.us/j/9');
    await platform.app.openExternal('  https://meet.google.com/abc-defg-hij ');
    await platform.app.openExternal('javascript:alert(1)');
    await platform.app.openExternal('file:///etc/passwd');
    expect(opened).toEqual(['https://telemost.yandex.ru/j/1', 'HTTPS://Zoom.us/j/9', 'https://meet.google.com/abc-defg-hij']);
  });
});
