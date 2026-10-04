import { protocol } from 'electron';
import { readBodyUpTo } from '../shared/bodyBuffer';
import { identityOriginPath } from '../shared/identityOrigin';
import { API_SCHEME } from '../shared/ipc';
import { apiSession, resetApiTransport, stall } from './apiTransport';
import { currentServerUrl, forceRefresh, identityAccessToken } from './auth';
import { log } from './logging';

/**
 * `calaba-api://api/<path>` → `<serverUrl>/<path>` with `Authorization: Bearer`.
 *
 * Why a proxy scheme instead of direct fetch from the renderer:
 * - the API has no CORS (desktop-only clients), and the renderer's origin is
 *   http://localhost (dev) or file:// (prod);
 * - <img src> for files/thumbnails needs the bearer header, which an <img>
 *   cannot send; here main attaches it;
 * - tokens stay under main's control (single-flight refresh).
 *
 * Every request goes through the dedicated API session (apiTransport.ts), not the default one.
 *
 * Streamed response bodies MUST be released by aborting the net.fetch signal, not only by
 * cancelling the body reader (docs/09 #146, proven on Electron 44 with an HTTP/2 server — the
 * production Caddy speaks h2): `res.body.getReader().cancel()` does not end the request, the
 * HTTP/2 stream stays open and the bytes Chromium has buffered for it are never acknowledged.
 * A handful of such streams (a <video> seeking through a 15 MB file makes one per range request
 * and drops it) use up the connection's receive window: from then on every response on that
 * connection gets its headers but no body — every REST call hangs until the app restarts, while
 * the gateway WebSocket (its own connection) stays alive. Also, the renderer abandoning a
 * response never aborts `req.signal` here; Electron only calls the body stream's cancel().
 */
export function registerApiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: API_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/**
 * CORS for our renderer only (security review L2): echo the Origin when it is the packaged
 * renderer (`file://`) or the dev server; anything else gets no Access-Control-Allow-Origin,
 * so a stray frame can't read responses that carry our bearer token.
 */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === 'file://') return origin;
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev && origin === new URL(dev).origin) return origin;
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = allowedOrigin(origin);
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, Retry-After',
    'Access-Control-Max-Age': '600',
  };
}

function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const MAX_REDIRECTS = 3;

/**
 * Redirects are followed by hand: to the API origin with the token; to another origin
 * (e.g. object storage) only for GET/HEAD and WITHOUT Authorization; non-GET never.
 */
async function forward(
  req: Request,
  target: string,
  token: string | null,
  body: ReadableStream | Uint8Array | null,
  signal: AbortSignal,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('origin');
  headers.delete('referer');
  if (identityOriginPath(new URL(target).pathname)) headers.set('Origin', new URL(currentServerUrl()).origin);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, redirect: 'manual', signal };
  if (body instanceof Uint8Array) {
    init.body = new Uint8Array(body).buffer;
  } else if (body) {
    init.body = body;
    init.duplex = 'half'; // streamed request body (uploads)
  }
  const ses = apiSession();
  let res = await ses.fetch(target, init);
  const idempotent = req.method === 'GET' || req.method === 'HEAD';
  let url = target;
  for (let hop = 0; hop < MAX_REDIRECTS && idempotent && res.status >= 300 && res.status < 400; hop++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, url);
    const sameOrigin = next.origin === new URL(target).origin;
    const h = new Headers(headers);
    if (!sameOrigin) h.delete('Authorization');
    url = next.toString();
    await discard(res);
    res = await ses.fetch(url, { method: req.method, headers: h, redirect: 'manual', signal });
  }
  return res;
}

/** A response we don't hand over (a redirect hop, a 401 before the replay): read to the end, so
 * its bytes are consumed and the stream closes (see the header comment). Such bodies are tiny. */
async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // the next request reports any real problem
  }
}

/** Connect + response-headers deadline for a request whose body (if any) is small enough to be
 * buffered up front (readBodyUpTo). This is the dead/changed-connection bug (docs/12 "net.fetch
 * has no timeout"): net.fetch's promise itself never settles. Armed only until a response is in
 * hand, then permanently disarmed — it never threatens a body that is already streaming. */
export const HEADERS_TIMEOUT_MS = 20_000;

/** No bytes — request or response, either direction — for this long → abort. Reset on every
 * chunk, so an upload or a large file/image download (served through this same scheme, see the
 * doc comment above) that is still making progress is never cut off by a fixed deadline. It also
 * ends a streamed response the renderer stopped reading (a paused / abandoned <video>). */
export const IDLE_TIMEOUT_MS = 30_000;

/**
 * Requests the server answers only after a long wait by design: the SIP connection test (ADR-0046,
 * `POST /api/workspaces/{id}/sip/test`) places a real call and replies within ~25 s. Both
 * deadlines stretch to this for them (the fixed 20 s headers deadline would cut every slow test).
 */
export const SLOW_REQUEST_MS = 45_000;
const SLOW_PATHS = [/^\/api\/workspaces\/[^/]+\/sip\/test$/];

/** The headers / idle deadline of a request to `pathname`. */
export function deadlinesFor(pathname: string): { headers: number; idle: number } {
  return SLOW_PATHS.some((re) => re.test(pathname)) ? { headers: SLOW_REQUEST_MS, idle: SLOW_REQUEST_MS } : { headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS };
}

function timeoutError(message: string): DOMException {
  return new DOMException(message, 'TimeoutError');
}

interface BodyHooks {
  /** Every chunk (the caller's idle-timeout reset). */
  onChunk: () => void;
  /** The consumer cancelled the stream (the renderer dropped the response). */
  onCancel?: (reason: unknown) => void;
  /** The stream is over: finished, failed or cancelled. */
  onEnd?: () => void;
}

/**
 * Wraps a request or response body stream so main never awaits a chunk forever. If `stop` aborts
 * while a read is outstanding (idle timeout), the wrapped stream ends in an error instead of
 * silently closing with a truncated body.
 */
function watchBody(source: ReadableStream<Uint8Array>, stop: AbortSignal, hooks: BodyHooks): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  const onAbort = (): void => {
    void reader.cancel(stop.reason).catch(() => undefined);
  };
  const end = (): void => {
    stop.removeEventListener('abort', onAbort);
    if (ended) return;
    ended = true;
    hooks.onEnd?.();
  };
  stop.addEventListener('abort', onAbort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          end();
          // A cancel triggered by our own timeout surfaces as a normal EOF from the reader's
          // point of view (per the Streams spec) — treat it as an error, not a truncated success.
          if (stop.aborted) controller.error(stop.reason);
          else controller.close();
          return;
        }
        hooks.onChunk();
        controller.enqueue(result.value);
      } catch (err) {
        end();
        controller.error(stop.aborted ? stop.reason : err);
      }
    },
    cancel(reason) {
      end();
      hooks.onCancel?.(reason);
      return reader.cancel(reason);
    },
  });
}

export function handleApiScheme(): void {
  protocol.handle(API_SCHEME, async (req) => {
    const origin = req.headers.get('origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    const url = new URL(req.url);
    const base = currentServerUrl();
    if (!base) return withCors(Response.json({ code: 'ERROR_CODE_UNAVAILABLE', message: 'server URL not set' }, { status: 503 }), origin);
    const target = `${base}${url.pathname}${url.search}`;
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    const deadline = deadlinesFor(url.pathname);

    const idleController = new AbortController();
    const headersController = new AbortController();
    // The renderer dropped the (streamed) response: end the upstream request itself, see the
    // header comment — cancelling the body reader alone leaves the HTTP/2 stream open.
    const releaseController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idleController.abort(timeoutError('idle timeout')), deadline.idle);
    };
    const disarmHeaders = (): void => {
      clearTimeout(headersTimer);
      headersTimer = undefined;
    };
    const disarmAll = (): void => {
      clearTimeout(idleTimer);
      idleTimer = undefined;
      disarmHeaders();
    };
    // `req.signal` is kept for completeness: Electron 44 never aborts it when the renderer
    // cancels (only the body stream's cancel() is called — handled by releaseController).
    const bodySignal = AbortSignal.any([idleController.signal, req.signal]);
    const fetchSignal = AbortSignal.any([idleController.signal, headersController.signal, releaseController.signal, req.signal]);
    const stallId = stall.started(deadline.headers > HEADERS_TIMEOUT_MS);
    const onRequestChunk = (): void => {
      armIdle();
      stall.progress(stallId); // an upload still sending is not a stuck request
    };
    const onResponseChunk = (): void => {
      armIdle();
      stall.progress();
    };
    let streaming = false;

    try {
      armIdle();
      // Small bodies (JSON) are buffered so a POST/PATCH/DELETE can be replayed once after a 401
      // (clock skew / expired token → spurious send failures, review L6). A 401 means the server
      // did nothing, so the replay is safe. Big bodies (uploads) stream and are never replayed.
      const read = idempotent ? null : await readBodyUpTo(req.body ? watchBody(req.body, bodySignal, { onChunk: onRequestChunk }) : null);
      const streamed = read?.kind === 'stream';
      const body = read ? (read.kind === 'bytes' ? read.bytes : read.stream) : null;
      const replayable = !read || read.kind === 'bytes';

      // Only the plain (buffered-body) path gets the fixed connect+headers deadline; a streamed
      // upload is already covered end to end by the idle timer above.
      if (!streamed) headersTimer = setTimeout(() => headersController.abort(timeoutError('connect/headers timeout')), deadline.headers);

      let res = await forward(req, target, await identityAccessToken(new URL(target).pathname), body, fetchSignal);
      if (res.status === 401 && replayable) {
        const t = await forceRefresh();
        if (t) {
          await discard(res);
          res = await forward(req, target, t, body, fetchSignal);
        }
      }
      stall.answered(stallId);
      disarmHeaders();
      armIdle(); // fresh idle window for the response body, whatever was spent on the request

      let finalRes = res;
      if (res.body) {
        // Buffer small responses (same threshold as request bodies) so a stall while we're still
        // assembling an ordinary JSON reply can still end in a clean 504. Large ones (file /
        // image / audio / video previews served through this same scheme) exceed the limit and
        // stream straight through from here on — never cut by a fixed deadline (docs/12), but the
        // idle timer stays armed: a stream the renderer stops reading without cancelling it is
        // aborted after IDLE_TIMEOUT_MS, which releases its HTTP/2 stream (header comment).
        const watched = watchBody(res.body, bodySignal, {
          onChunk: onResponseChunk,
          onCancel: (reason) => releaseController.abort(reason ?? new DOMException('response dropped', 'AbortError')),
          onEnd: disarmAll,
        });
        const readRes = await readBodyUpTo(watched);
        streaming = readRes.kind === 'stream';
        finalRes =
          readRes.kind === 'bytes'
            ? new Response(new Uint8Array(readRes.bytes).buffer, { status: res.status, statusText: res.statusText, headers: res.headers })
            : new Response(readRes.stream, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      if (!streaming) disarmAll();
      return withCors(finalRes, origin);
    } catch (err) {
      disarmAll();
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        log.warn(`api request timeout ${req.method} ${url.pathname.replace(/^(\/api\/(?:public\/)?forms)\/[^/]+/, '$1/{code}')}`);
        // Several of these at once = the connection, not the request (apiStall.ts).
        const reason = stall.timedOut(stallId);
        if (reason) void resetApiTransport(reason);
        return withCors(Response.json({ code: 'ERROR_CODE_UNAVAILABLE', message: 'request timed out' }, { status: 504 }), origin);
      }
      return withCors(
        Response.json(
          { code: 'ERROR_CODE_UNAVAILABLE', message: err instanceof Error ? err.message : String(err) },
          { status: 503 },
        ),
        origin,
      );
    } finally {
      stall.answered(stallId);
    }
  });
}
