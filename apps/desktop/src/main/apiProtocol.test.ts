import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
let handler: ((req: Request) => Promise<Response>) | undefined;

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (_scheme: string, h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  },
}));

const { StallDetector } = await import('./apiStall');
let stall = new StallDetector();
const resetApiTransport = vi.fn((_reason: string) => Promise.resolve());
vi.mock('./apiTransport', () => ({
  apiSession: () => ({ fetch: (url: string, init: RequestInit) => fetchMock(url, init) }),
  get stall() {
    return stall;
  },
  resetApiTransport,
}));

vi.mock('./auth', () => ({
  currentServerUrl: () => 'https://api.calab.test',
  identityAccessToken: vi.fn(() => Promise.resolve('token')),
  forceRefresh: vi.fn(() => Promise.resolve(null)),
}));

const warn = vi.fn();
vi.mock('./logging', () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

// Imported after the mocks above (docs/12 "net.fetch has no timeout").
const { handleApiScheme, deadlinesFor, AI_REQUEST_MS, HEADERS_TIMEOUT_MS, IDLE_TIMEOUT_MS, SLOW_REQUEST_MS } = await import('./apiProtocol');

function apiRequest(path: string, init?: RequestInit): Request {
  return new Request(`calaba-api://api${path}`, init);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  warn.mockReset();
  resetApiTransport.mockClear();
  stall = new StallDetector();
  handler = undefined;
  handleApiScheme();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleApiScheme deadlines', () => {
  it('a dead connection (net.fetch never resolves) times out at 504 within the headers deadline', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          });
        }),
    );
    const pending = handler?.(apiRequest('/api/messages'));
    await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS);
    const res = await pending;
    expect(res?.status).toBe(504);
    expect(((await res?.json()) as { code?: string }).code).toBe('ERROR_CODE_UNAVAILABLE');
    // The 504 names the request id the server got, so a person can report it (bug #152).
    const sent = new Headers(fetchMock.mock.calls[0]?.[1].headers).get('X-Request-ID');
    expect(sent).toMatch(/^[0-9a-f]{32}$/);
    expect(res?.headers.get('X-Request-ID')).toBe(sent);
    expect(warn).toHaveBeenCalledWith(`api request timeout GET /api/messages request_id=${sent}`);
  });

  it('a body that stalls mid-stream is aborted with 504 after the idle timeout', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
          resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }),
    );
    const pending = handler?.(apiRequest('/api/messages'));
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    const res = await pending;
    expect(res?.status).toBe(504);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^api request timeout GET \/api\/messages request_id=[0-9a-f]{32}$/));
  });

  it('a normal response passes through unchanged', async () => {
    fetchMock.mockImplementation(
      () => new Promise((resolve) => resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    );
    const res = await handler?.(apiRequest('/api/messages'));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

/** A 2 MB+ body (over the 1 MB buffering threshold) that yields `chunks` 256 KB chunks, then
 * waits forever; `signal` is the one handed to the upstream fetch. */
function bigUpstream(chunks = 8): { signal: () => AbortSignal | undefined } {
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementation((_url, init) => {
    signal = init.signal ?? undefined;
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: (c) => {
        if (n++ < chunks) c.enqueue(new Uint8Array(256 * 1024));
        else return new Promise<void>(() => undefined);
      },
    });
    return Promise.resolve(new Response(stream, { status: 206, headers: { 'Content-Type': 'video/mp4' } }));
  });
  return { signal: () => signal };
}

describe('streamed responses release the upstream request (docs/09 #146)', () => {
  it('the renderer cancelling a streamed body aborts the upstream fetch (HTTP/2 stream reset), not just its reader', async () => {
    const up = bigUpstream();
    const res = await handler?.(apiRequest('/api/files/f1'));
    expect(res?.status).toBe(206);
    const reader = res?.body?.getReader();
    await reader?.read();
    expect(up.signal()?.aborted).toBe(false);
    await reader?.cancel();
    expect(up.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // the idle timer is gone with the stream
  });

  it('a streamed body the renderer stops reading (without cancelling) is aborted after the idle timeout', async () => {
    // Exactly the buffered prefix, then silence: no chunk after the hand-over re-arms the timer
    // (before the fix the idle timer was dropped at the hand-over — the stream lived forever).
    const up = bigUpstream(5);
    const res = await handler?.(apiRequest('/api/files/f1'));
    expect(res?.status).toBe(206); // handed over, never read (a <video> that moved on)
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(up.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(up.signal()?.aborted).toBe(true);
    // Not a request timeout: nothing counts towards a transport reset.
    expect(warn).not.toHaveBeenCalled();
    expect(resetApiTransport).not.toHaveBeenCalled();
  });

  it('a streamed body read to the end leaves no timer behind', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 })));
    const res = await handler?.(apiRequest('/api/files/f1'));
    expect((await res?.arrayBuffer())?.byteLength).toBe(3 * 1024 * 1024);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a buffered JSON response leaves no timer behind', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    await handler?.(apiRequest('/api/messages'));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('transport reset on repeated timeouts', () => {
  function stalledBodies(): void {
    // The production symptom: headers arrive, the body never does (connection window exhausted).
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), { status: 200 })),
    );
  }

  it('one timeout alone does not reset; the second within a minute does, once', async () => {
    stalledBodies();
    const a = handler?.(apiRequest('/api/rooms/r1/messages'));
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    await a;
    expect(resetApiTransport).not.toHaveBeenCalled();
    const b = handler?.(apiRequest('/api/boards/b1'));
    const c = handler?.(apiRequest('/api/tasks/t1'));
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    await Promise.all([b, c]);
    expect(resetApiTransport).toHaveBeenCalledTimes(1);
    expect(resetApiTransport).toHaveBeenCalledWith('2 timeouts in 60 s');
  });

  it('a timeout while another request has waited for its headers for a while resets at once', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
    const a = handler?.(apiRequest('/api/rooms/r1/messages'));
    await vi.advanceTimersByTimeAsync(10_000);
    const b = handler?.(apiRequest('/api/rooms/r1/pins'));
    await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS - 10_000);
    expect((await a)?.status).toBe(504);
    expect(resetApiTransport).toHaveBeenCalledWith('timeout while another request has no response');
    await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS);
    await b;
  });
});

describe('deadlines', () => {
  it('the SIP connection test (a real call, ~25 s) waits longer; everything else keeps the defaults', () => {
    expect(deadlinesFor('/api/workspaces/w1/sip/test')).toEqual({ headers: SLOW_REQUEST_MS, idle: SLOW_REQUEST_MS });
    expect(SLOW_REQUEST_MS).toBeGreaterThan(25_000);
    expect(deadlinesFor('/api/workspaces/w1/sip')).toEqual({ headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS });
    expect(deadlinesFor('/api/workspaces/w1/sip/test/x')).toEqual({ headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS });
    expect(deadlinesFor('/api/workspaces/w1/sip/ivr')).toEqual({ headers: SLOW_REQUEST_MS, idle: SLOW_REQUEST_MS });
    expect(deadlinesFor('/api/workspaces/w1/sip/ivr/m1')).toEqual({ headers: SLOW_REQUEST_MS, idle: SLOW_REQUEST_MS });
    expect(SLOW_REQUEST_MS).toBeGreaterThan(60_000);
  });

  it('a smart task outlives the server SmartBudget (100 s) — the 20 s deadline cut it (bug #152)', () => {
    expect(deadlinesFor('/api/workspaces/w1/smart-tasks')).toEqual({ headers: AI_REQUEST_MS, idle: AI_REQUEST_MS });
    expect(AI_REQUEST_MS).toBeGreaterThan(100_000);
    expect(deadlinesFor('/api/workspaces/w1/smart-tasks/x')).toEqual({ headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS });
  });
});
