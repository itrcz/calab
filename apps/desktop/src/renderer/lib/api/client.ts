import { identityRequestBlocked, identityRequestVersion } from './identityGate';
import { create, fromJson, toJson, type DescMessage, type JsonValue, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf';
import { PlanLimitViolationsSchema, type PlanLimitViolation } from '@calaba/protocol';
import { platform } from '../../platform';

/**
 * Typed REST client. Bodies are protojson (lowerCamelCase, enum names,
 * uint64 as strings — docs/05, "REST"); conversion goes through the generated
 * schemas only, never hand-written types (CLAUDE.md).
 *
 * Requests go to `calaba-api://api/...`; the main process attaches the bearer
 * token, refreshes it and forwards to the configured server.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
    /**
     * Why, when a code has several causes (ApiError.reason): "PLAN_LIMIT" = a limit of the
     * workspace plan (ADR-0024; ROOM_FULL, FILE_QUOTA_EXCEEDED). `used` / `limit`: the counter
     * that was hit (ROOM_FULL — users; FILE_QUOTA_EXCEEDED — bytes). `retryAfter`: seconds from
     * a 429's `Retry-After` header (ADR-0023: code resend, mail limits).
     */
    readonly extra: { reason?: string; used?: number; limit?: number; retryAfter?: number; planViolations?: readonly PlanLimitViolation[] } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get reason(): string | undefined {
    return this.extra.reason;
  }

  get retryAfter(): number | undefined {
    return this.extra.retryAfter;
  }

  is(code: string): boolean {
    return this.code === code;
  }
}

/** `Retry-After` in seconds (delta form only, as the server sends it); undefined when absent. */
export function retryAfterSeconds(res: Response): number | undefined {
  const v = Number(res.headers.get('Retry-After') ?? '');
  return Number.isFinite(v) && v > 0 ? Math.ceil(v) : undefined;
}

export async function toApiError(res: Response): Promise<ApiError> {
  const retry = retryAfterSeconds(res);
  try {
    const b = (await res.json()) as { code?: string; message?: string; field?: string; reason?: string; used?: unknown; limit?: unknown; planLimitsExceeded?: unknown };
    // protojson: uint64 as a string.
    const num = (v: unknown): number | undefined => (typeof v === 'string' || typeof v === 'number') && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const used = num(b.used);
    const limit = num(b.limit);
    // PLAN_LIMITS_EXCEEDED (ADR-0086): what the target plan would exceed, through the generated schema.
    const planViolations = b.planLimitsExceeded ? fromJson(PlanLimitViolationsSchema, b.planLimitsExceeded as JsonValue, { ignoreUnknownFields: true }).violations : undefined;
    const extra = {
      ...(planViolations ? { planViolations } : {}),
      ...(b.reason ? { reason: b.reason } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(retry !== undefined ? { retryAfter: retry } : {}),
    };
    const err = new ApiError(b.code ?? 'ERROR_CODE_UNSPECIFIED', b.message ?? res.statusText, res.status, b.field || undefined, extra);
    for (const h of errorHooks) h(err);
    return err;
  } catch {
    return new ApiError('ERROR_CODE_UNSPECIFIED', res.statusText || `HTTP ${res.status}`, res.status, undefined, retry !== undefined ? { retryAfter: retry } : {});
  }
}

const errorHooks = new Set<(e: ApiError) => void>();

/**
 * Observes every API error (e.g. 403 EMAIL_NOT_VERIFIED → the «Подтвердите почту» bar asks for
 * attention, ADR-0023) without each caller handling it. Returns the unsubscribe function.
 */
export function onApiError(h: (e: ApiError) => void): () => void {
  errorHooks.add(h);
  return () => errorHooks.delete(h);
}

/** Absolute URL of an API path for the current platform (Electron: calaba-api://, web: same origin). */
export const apiUrl = (path: string): string => `${platform.apiBase}${path}`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const JSON_OPTS = { ignoreUnknownFields: true } as const;

async function send(method: Method, path: string, body?: JsonValue, signal?: AbortSignal): Promise<Response> {
  const version = identityRequestVersion(path);
  if (identityRequestBlocked(path)) throw new ApiError('ERROR_CODE_SSO_REQUIRED', '', 403);
  let res: Response;
  try {
    res = await platform.apiFetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('ERROR_CODE_UNAVAILABLE', err instanceof Error ? err.message : String(err), 0);
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (['ERROR_CODE_SSO_REQUIRED', 'ERROR_CODE_DIRECTORY_ACCESS_DENIED', 'ERROR_CODE_RECOVERY_ONLY'].includes(err.code))
      for (const h of identityDenials) h(err, path);
    // ADR-0044: a room closed meanwhile answers 410 ROOM_ARCHIVED to anything but its history.
    if (err.code === 'ERROR_CODE_ROOM_ARCHIVED') {
      const id = archivedRoomOf(path);
      if (id) for (const h of archivedHooks) h(id);
    }
    throw err;
  }
  if (identityRequestBlocked(path, version)) throw new ApiError('ERROR_CODE_SSO_REQUIRED', '', 403);
  return res;
}

/** The room id of a `/api/rooms/{id}…` path (the one a 410 ROOM_ARCHIVED is about). */
export function archivedRoomOf(path: string): string | null {
  return /^\/api\/rooms\/([^/?#]+)/.exec(path)?.[1] ?? null;
}

const archivedHooks = new Set<(roomId: string) => void>();

/**
 * A request about a room answered 410 ROOM_ARCHIVED (ADR-0044: a temporary room closed by its
 * owner or by expiry): services/tempRooms drops it from the live list with a toast.
 */
export function onRoomArchived(h: (roomId: string) => void): () => void {
  archivedHooks.add(h);
  return () => archivedHooks.delete(h);
}

/** Request with a typed protobuf response. */
export async function call<Res extends DescMessage>(
  method: Method,
  path: string,
  resSchema: Res,
  body?: JsonValue,
  signal?: AbortSignal,
): Promise<MessageShape<Res>> {
  const version = identityRequestVersion(path);
  const res = await send(method, path, body, signal);
  // An older server may still answer 204 for an endpoint that grew a body (e.g. password/forgot).
  if (res.status === 204) return create(resSchema);
  const json = (await res.json()) as JsonValue;
  if (identityRequestBlocked(path, version)) throw new ApiError('ERROR_CODE_SSO_REQUIRED', '', 403);
  return fromJson(resSchema, json, JSON_OPTS);
}

/** Request without a response body (204). */
export async function callEmpty(method: Method, path: string, body?: JsonValue): Promise<void> {
  await send(method, path, body);
}

/** Serialises a request message (unset optional fields are omitted → "leave unchanged"). */
export function body<Req extends DescMessage>(schema: Req, init: MessageInitShape<Req>): JsonValue {
  return toJson(schema, create(schema, init));
}

export function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const identityDenials = new Set<(e: ApiError, path: string) => void>();
export function onIdentityDenied(h: (e: ApiError, path: string) => void): void {
  identityDenials.add(h);
}
