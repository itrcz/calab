import { create, fromJson, toJson, type DescMessage, type JsonValue, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf';
import { apiErrorFrom } from './errors.js';

/** Options of the REST client (normally set through `new Bot(token, options)`). */
export interface RestOptions {
  /** Server origin, e.g. `https://app.calab.io`. */
  server: string;
  token: string;
  /** Custom fetch (tests, proxies). Default: global fetch. */
  fetch?: typeof fetch;
  /** How many times a 429 is retried after `Retry-After` (default 3; 0 = never). */
  maxRetries?: number;
  /** Upper bound of one `Retry-After` wait, ms (default 60 000). */
  maxRetryAfterMs?: number;
  /** Sleep used between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestInit {
  query?: Query;
  /** Plain JSON body (already protojson). */
  json?: unknown;
  /** Multipart body (files, stickers). Rebuilt on retry by the factory. */
  form?: () => FormData;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parses `Retry-After` (seconds or an HTTP date) into ms; undefined when absent or invalid. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The REST API of the server (docs/05 «REST»): protojson bodies, `Authorization: Bearer <bot token>`.
 * 429 is retried after `Retry-After`; every other non-2xx becomes an `ApiError`.
 */
export class Rest {
  readonly server: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(o: RestOptions) {
    this.server = o.server.replace(/\/+$/, '');
    this.token = o.token;
    this.fetchFn = o.fetch ?? ((input, init) => fetch(input, init));
    this.maxRetries = o.maxRetries ?? 3;
    this.maxRetryAfterMs = o.maxRetryAfterMs ?? 60_000;
    this.sleep = o.sleep ?? defaultSleep;
    this.userAgent = o.userAgent ?? 'calab-bot-sdk/0.1';
  }

  url(path: string, query?: Query): string {
    const u = new URL(path, this.server + '/');
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Raw request: the parsed JSON body (undefined for 204). */
  async request(method: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.response(method, path, init);
    return parseBody(await res.text());
  }

  /**
   * The successful Response itself, body unread (downloads). 429 is retried after `Retry-After`;
   * any other non-2xx becomes an `ApiError`.
   */
  async response(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'User-Agent': this.userAgent };
      let body: string | FormData | undefined;
      if (init.form) body = init.form();
      else if (init.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
      }
      const res = await this.fetchFn(this.url(path, init.query), { method, headers, ...(body !== undefined ? { body } : {}) });
      if (res.ok) return res;
      const parsed = parseBody(await res.text());
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(Math.min(retryAfter ?? 1000, this.maxRetryAfterMs));
        continue;
      }
      throw apiErrorFrom(res.status, parsed, method, path, retryAfter);
    }
  }

  /** Request with a typed protojson response. */
  async call<S extends DescMessage>(schema: S, method: string, path: string, init: RequestInit = {}): Promise<MessageShape<S>> {
    const json = await this.request(method, path, init);
    return fromJson(schema, (json ?? {}) as JsonValue, { ignoreUnknownFields: true });
  }

  /** protojson of a request message built from its init shape. */
  static body<S extends DescMessage>(schema: S, init: MessageInitShape<S>): JsonValue {
    return toJson(schema, create(schema, init));
  }
}
