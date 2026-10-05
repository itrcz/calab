/// <reference lib="dom" />
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, safeStorage, session, shell, type Session } from 'electron';
import log from 'electron-log/main';
import {
  IPC,
  noSession,
  verificationOf,
  type ApiErrorJson,
  type AuthSession,
  type IpcResult,
  type LoginArgs,
  type RegisterArgs,
} from '../shared/ipc';
import { INSECURE_SERVER_CODE, serverUrlProblem } from '../shared/serverUrl';
import { AUTH_TIMEOUT_MS } from '../shared/refreshGate';
import { apiSession } from './apiTransport';
import { getSettings, normalizeServerUrl, updateSettings } from './settings';
import { create, fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  SSOBeginRequestSchema,
  SSOBeginResponseSchema,
  SSOExchangeRequestSchema,
  SSOClientKind,
  SSOFlowPurpose,
  SessionAuthoritySchema,
  SessionAuthorityKind,
  IdentityRecoverRequestSchema,
} from '@calaba/protocol';
import { SSOCompleteResponseSchema } from '@calaba/protocol';
import type { SsoStart } from '../shared/ipc';
import { SsoHandoffBroker } from './ssoHandoff';
import { setSsoDeepLinkHandler } from './deeplink';
import { TokenBroker, toTokens, type Tokens, type TokensJson } from './tokenBroker';

/**
 * Token broker (docs/04-data-model.md, "Auth").
 *
 * - The refresh token lives only in main, persisted with `safeStorage` (OS
 *   keychain / DPAPI / libsecret). If the OS offers no encryption it is kept
 *   in memory only — never written in plain text, never given to the renderer.
 * - The short-lived access token is refreshed here (single-flight, so several
 *   windows or parallel requests never race a rotation → reuse detection).
 */

interface StoredSession {
  serverUrl: string;
  refreshToken: string;
  sessionId: string;
  workspaceId?: string;
}

/** CALABA_ALLOW_INSECURE_HTTP=1: accept a plain-http server outside loopback (LAN tests only). */
const ALLOW_INSECURE = process.env['CALABA_ALLOW_INSECURE_HTTP'] === '1';

function storeFile(): string {
  return join(app.getPath('userData'), 'session.bin');
}

let authEpoch = 0;
let scopedWorkspace = '';
let recovery: { workspaceId: string; token: string; expiresAt: number } | null = null;

function persist(serverUrl: string, tokens: Tokens | null): void {
  if (!tokens) {
    rmSync(storeFile(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('safeStorage unavailable: refresh token kept in memory only (login required after restart)');
    return;
  }
  const data: StoredSession = {
    serverUrl,
    refreshToken: tokens.refreshToken,
    sessionId: tokens.sessionId,
    ...(scopedWorkspace ? { workspaceId: scopedWorkspace } : {}),
  };
  // Atomic: a quit / crash mid-write must leave the previous token, not a truncated file
  // (an unreadable file = a login screen on the next start).
  const tmp = `${storeFile()}.tmp`;
  writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)));
  renameSync(tmp, storeFile());
}

function loadStored(): StoredSession | null {
  try {
    if (!existsSync(storeFile()) || !safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(readFileSync(storeFile()))) as StoredSession;
  } catch (err) {
    log.warn('stored session unreadable, ignoring', err);
    return null;
  }
}

/** Main-side reactions to the end of the Calab session (workspace web apps clear their site data). */
const sessionEndHooks = new Set<() => void>();
export function onSessionEnd(cb: () => void): void {
  sessionEndHooks.add(cb);
}
function sessionEnded(): void {
  for (const h of sessionEndHooks) {
    try {
      h();
    } catch (e) {
      log.warn('session end hook failed', e);
    }
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

/** Token state + refresh policy (tokenBroker.ts: single-flight, 401 / repeated 409 end, rest transient). */
const broker = new TokenBroker({
  refresh: async (base, refreshToken, fresh) => {
    const res = await postJson(
      base,
      scopedWorkspace ? `/api/auth/sso/workspaces/${encodeURIComponent(scopedWorkspace)}/refresh` : '/api/auth/refresh',
      { refreshToken },
      undefined,
      fresh ? await freshSession() : undefined,
    );
    if (res.ok) {
      const result = fromJson(SSOCompleteResponseSchema, (await res.json()) as JsonValue, { ignoreUnknownFields: true });
      const t = result.tokens;
      if (
        !t ||
        (scopedWorkspace && (t.authority?.kind !== SessionAuthorityKind.WORKSPACE_SSO || t.authority.workspaceId !== scopedWorkspace)) ||
        (!scopedWorkspace && t.authority && t.authority.kind !== SessionAuthorityKind.LOCAL_ACCOUNT)
      )
        return { status: 401 };
      return {
        status: res.status,
        tokens: {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          sessionId: t.sessionId,
          accessExpiresAt: t.accessExpiresAt ? timestampDate(t.accessExpiresAt).toISOString() : '',
        },
      };
    }
    const err = await readError(res);
    return { status: res.status, code: err.code, ...(err.reason ? { reason: err.reason } : {}) };
  },
  persist,
  onLoggedOut: (reason) => {
    scopedWorkspace = ''; recovery = null; ++authEpoch; ssoBroker.invalidateForAccountSwitch();
    broadcast(IPC.authLoggedOut, reason);
    sessionEnded();
  },
  log,
});

async function readError(res: Response): Promise<ApiErrorJson> {
  try {
    const body = (await res.json()) as Partial<ApiErrorJson>;
    return {
      code: body.code ?? 'ERROR_CODE_UNSPECIFIED',
      message: body.message ?? res.statusText,
      ...(body.field ? { field: body.field } : {}),
      ...(typeof body.reason === 'string' && body.reason ? { reason: body.reason } : {}),
      status: res.status,
    };
  } catch {
    return { code: 'ERROR_CODE_UNSPECIFIED', message: res.statusText || `HTTP ${res.status}`, status: res.status };
  }
}

function networkError(err: unknown): ApiErrorJson {
  return { code: 'ERROR_CODE_UNAVAILABLE', message: err instanceof Error ? err.message : String(err), status: 0 };
}

/**
 * The retry of a refresh that failed on the network (incident 29.09: two refreshes aborted by
 * AUTH_TIMEOUT_MS while reading the answer, while the gateway socket stayed alive — a stalled
 * pooled connection). Chromium keeps a socket pool per session and `net.fetch` has no
 * per-request "new connection" switch, so the retry goes through a separate in-memory session
 * (own network context, own pool; system proxy / VPN settings as the default one) whose pooled
 * connections are closed first: it always opens a new TCP/TLS connection. Only the auth POST
 * uses it; the API session (apiTransport.ts: API calls, the first refresh try, `/api/me`) is left
 * alone — its own stall detector resets it.
 */
let authRetrySession: Session | null = null;
async function freshSession(): Promise<Session> {
  authRetrySession ??= session.fromPartition('calaba-auth-retry', { cache: false });
  await authRetrySession.closeAllConnections();
  return authRetrySession;
}

async function postJson(base: string, path: string, body: unknown, access?: string, via?: Session): Promise<Response> {
  return (via ?? apiSession()).fetch(`${base}${path}`, {
    method: 'POST',
    // Bounded: a black-holed refresh would otherwise hang every API call behind the broker (review N3).
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function fetchMe(): Promise<unknown> {
  const t = await getAccessToken();
  if (!t) throw new Error('not authenticated');
  const res = await apiSession().fetch(`${broker.serverUrl}/api/me`, {
    headers: { Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /api/me: ${res.status}`);
  const body = (await res.json()) as { me: unknown };
  return body.me;
}

function deviceName(): string {
  return `${hostname()} (${process.platform})`;
}

/** A valid access token (refreshed if it expires within a minute); null = none right now (logged out / offline). */
export function getAccessToken(): Promise<string | null> {
  return broker.getAccessToken();
}

/**
 * Waits (≤ timeoutMs) for a refresh in flight: quitting for an update in the middle of one
 * would lose its answer — the next start then relies on the server's replay (docs/04 «Auth»).
 */
export function refreshSettled(timeoutMs: number): Promise<void> {
  return broker.settled(timeoutMs);
}

/** Forced refresh (gateway close 4004 / an API 401); null = could not refresh now. */
export function forceRefresh(): Promise<string | null> {
  return broker.forceRefresh();
}

export function currentServerUrl(): string {
  return broker.serverUrl || getSettings().serverUrl;
}

/**
 * The server the renderer page talks to (its CSP connect-src, csp.ts). The page loads before
 * restore() runs, so without a live session the stored one decides, then the settings default.
 * Incident 2.0.0: 1.7 builds defaulted to app.calab.ru without writing it to settings.json, 2.0
 * builds default to app.calab.io — a CSP built from the settings blocked the gateway socket of
 * the restored app.calab.ru session (endless «Подключение…» while REST, proxied by main, worked).
 */
export function rendererServerUrl(): string {
  if (broker.serverUrl) return broker.serverUrl;
  const stored = loadStored();
  if (stored?.serverUrl && !insecure(stored.serverUrl)) return stored.serverUrl;
  return getSettings().serverUrl;
}

function insecure(base: string): IpcResult<never> | null {
  const problem = serverUrlProblem(base, ALLOW_INSECURE);
  if (!problem) return null;
  return {
    ok: false,
    error: {
      code: problem === 'insecure' ? INSECURE_SERVER_CODE : 'ERROR_CODE_INVALID_ARGUMENT',
      message: problem === 'insecure' ? 'plain http is allowed only for localhost' : 'invalid server URL',
      field: 'serverUrl',
      status: 0,
    },
  };
}

export async function restore(): Promise<AuthSession | null> {
  const stored = loadStored();
  if (!stored) return null;
  if (insecure(stored.serverUrl)) {
    // A session saved for a plain-http server (before review L11): don't send its token again.
    log.warn('stored session for an insecure server URL dropped', stored.serverUrl);
    broker.clear('logout', false);
    return null;
  }
  const started = ++authEpoch;
  ssoBroker.invalidateForAccountSwitch();
  recovery = null;
  scopedWorkspace = stored.workspaceId ?? '';
  broker.set(
    stored.serverUrl,
    { accessToken: '', accessExpiresAt: 0, refreshToken: stored.refreshToken, sessionId: stored.sessionId },
    false,
  );
  const t = await broker.refreshOnce();
  if (started !== authEpoch) return null;
  if (!t) {
    // Either rejected (the broker cleared the session) or offline (session kept).
    if (!broker.hasSession) return null;
    throw new Error('offline');
  }
  const me = await fetchMe();
  if (started !== authEpoch) return null;
  return {
    serverUrl: broker.serverUrl,
    sessionId: t.sessionId,
    me,
    ...(scopedWorkspace
      ? {
          authority: toJson(
            SessionAuthoritySchema,
            create(SessionAuthoritySchema, { kind: SessionAuthorityKind.WORKSPACE_SSO, workspaceId: scopedWorkspace }),
          ),
        }
      : {}),
  };
}

async function authenticate(args: LoginArgs, path: string, body: Record<string, unknown>): Promise<IpcResult<AuthSession>> {
  const started = ++authEpoch;
  ssoBroker.invalidateForAccountSwitch();
  const base = normalizeServerUrl(args.serverUrl);
  const bad = insecure(base);
  if (bad) return bad;
  try {
    const res = await postJson(base, path, body);
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as {
      tokens?: TokensJson;
      me: unknown;
      similarAccount?: boolean;
      emailVerificationOptional?: boolean;
      emailInvitePending?: boolean;
    };
    if (!data.tokens) return { ok: false, error: noSession(data.similarAccount, res.status) };
    const tokens = toTokens(data.tokens);
    if (started !== authEpoch) throw new Error('Account changed');
    scopedWorkspace = '';
    recovery = null;
    broker.set(base, tokens);
    if (getSettings().serverUrl !== base) updateSettings({ serverUrl: base });
    return { ok: true, data: { serverUrl: base, sessionId: tokens.sessionId, me: data.me, ...verificationOf(data) } };
  } catch (e) {
    return { ok: false, error: networkError(e) };
  }
}

export function login(args: LoginArgs): Promise<IpcResult<AuthSession>> {
  return authenticate(args, '/api/auth/login', {
    email: args.email,
    password: args.password,
    deviceName: deviceName(),
  });
}

export function register(args: RegisterArgs): Promise<IpcResult<AuthSession>> {
  return authenticate(args, '/api/auth/register', {
    email: args.email,
    password: args.password,
    displayName: args.displayName,
    inviteCode: args.inviteCode,
    locale: args.locale ?? '',
    deviceName: deviceName(),
    ...(args.checkSimilar ? { checkSimilarAccount: true } : {}),
  });
}

/**
 * Guest sign-in from a room link (ADR-0016, `calaba://r/<code>` or a pasted https link):
 * POST /api/room-invites/{code}/join {nickname} without a session → the server creates a
 * guest account and returns tokens like a login; the refresh token is kept in main as usual.
 */
export async function guestJoin(
  code: string,
  nickname: string,
): Promise<IpcResult<{ session: AuthSession; roomId: string; workspaceId: string; admission?: unknown }>> {
  const started = ++authEpoch;
  ssoBroker.invalidateForAccountSwitch();
  const base = normalizeServerUrl(currentServerUrl());
  const bad = insecure(base);
  if (bad) return bad;
  try {
    const res = await postJson(base, `/api/room-invites/${encodeURIComponent(code)}/join`, { nickname, deviceName: deviceName() });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { roomId: string; workspaceId: string; tokens?: TokensJson; me?: unknown; admission?: unknown };
    if (!data.tokens) return { ok: false, error: { code: 'ERROR_CODE_INTERNAL', message: 'no guest session in the response', status: res.status } };
    const tokens = toTokens(data.tokens);
    let me = data.me;
    if (!me) {
      const profile = await apiSession().fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
      if (!profile.ok) throw new Error('Guest profile unavailable');
      me = (await profile.json() as { me: unknown }).me;
    }
    if (started !== authEpoch) throw new Error('Account changed');
    scopedWorkspace = ''; recovery = null;
    broker.set(base, tokens);
    // ADR-0040: a knock that waits for the organizer travels to the renderer as JSON.
    return { ok: true, data: { session: { serverUrl: base, sessionId: tokens.sessionId, me }, roomId: data.roomId, workspaceId: data.workspaceId, ...(data.admission ? { admission: data.admission } : {}) } };
  } catch (e) {
    return { ok: false, error: networkError(e) };
  }
}

export async function logout(allSessions: boolean): Promise<void> {
  const started = ++authEpoch;
  recovery = null;
  ssoBroker.invalidateForAccountSwitch();
  const access = await getAccessToken();
  if (started !== authEpoch) return;
  if (access) {
    try {
      await postJson(
        broker.serverUrl,
        scopedWorkspace ? `/api/auth/sso/workspaces/${encodeURIComponent(scopedWorkspace)}/logout` : '/api/auth/logout',
        { allSessions },
        access,
      );
    } catch (e) {
      log.warn('logout request failed (session cleared locally anyway)', e);
    }
  }
  if (started === authEpoch) { broker.clear('logout', true); scopedWorkspace = ''; }
}

/** Called when the gateway reports the session revoked (4010). */
export function revoked(): void {
  ++authEpoch;
  recovery = null;
  ssoBroker.invalidateForAccountSwitch();
  broker.clear('revoked', false);
  scopedWorkspace = '';
  sessionEnded();
}

const ssoPurposes = {
  login: SSOFlowPurpose.SSO_FLOW_PURPOSE_LOGIN,
  step_up: SSOFlowPurpose.SSO_FLOW_PURPOSE_STEP_UP,
  link: SSOFlowPurpose.SSO_FLOW_PURPOSE_LINK,
  test: SSOFlowPurpose.SSO_FLOW_PURPOSE_TEST,
} as const;
const ssoBroker = new SsoHandoffBroker({
  openExternal: (url) => shell.openExternal(url),
  exchange: async (request) => {
    const { signal, workspaceId, purpose, serverOrigin } = request;
    try {
      const access = await getAccessToken();
      signal.throwIfAborted();
      const res = await apiSession().fetch(`${serverOrigin}/api/auth/sso/exchange`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(AUTH_TIMEOUT_MS)]),
        headers: { 'Content-Type': 'application/json', Origin: serverOrigin, ...(access ? { Authorization: `Bearer ${access}` } : {}) },
        body: JSON.stringify(
          toJson(
            SSOExchangeRequestSchema,
            create(SSOExchangeRequestSchema, { flowId: request.flowId, ticket: request.ticket, verifier: request.verifier }),
          ),
        ),
      });
      if (!res.ok) {
        const error = await readError(res);
        signal.throwIfAborted();
        broadcast(IPC.authSsoResult, { workspaceId, purpose, ok: false, error });
        return;
      }
      const result = fromJson(SSOCompleteResponseSchema, (await res.json()) as JsonValue);
      signal.throwIfAborted();
      let installed: AuthSession | undefined;
      if (purpose === 'login') {
        if (
          broker.hasSession ||
          !result.tokens ||
          result.tokens.authority?.kind !== SessionAuthorityKind.WORKSPACE_SSO ||
          result.tokens.authority.workspaceId !== workspaceId
        )
          throw new Error('Unexpected SSO authority');
        const t = result.tokens;
        if (!t.authority) throw new Error('Missing authority');
        const meResponse = await apiSession().fetch(`${serverOrigin}/api/me`, {
          headers: { Authorization: `Bearer ${t.accessToken}` },
          signal,
        });
        if (!meResponse.ok) throw new Error('SSO profile unavailable');
        const me = ((await meResponse.json()) as { me: unknown }).me;
        signal.throwIfAborted();
        scopedWorkspace = workspaceId;
        broker.set(serverOrigin, {
          accessToken: t.accessToken,
          accessExpiresAt: t.accessExpiresAt ? timestampDate(t.accessExpiresAt).getTime() : 0,
          refreshToken: t.refreshToken,
          sessionId: t.sessionId,
        });
        installed = { serverUrl: serverOrigin, sessionId: t.sessionId, me, authority: toJson(SessionAuthoritySchema, t.authority) };
      } else if (result.tokens || (purpose === 'test' ? !result.tested : result.assurance?.workspaceId !== workspaceId))
        throw new Error('Unexpected SSO result');
      signal.throwIfAborted();
      broadcast(IPC.authSsoResult, { workspaceId, purpose, ok: true, ...(installed ? { session: installed } : {}) });
    } catch (e) {
      if (!signal.aborted) broadcast(IPC.authSsoResult, { workspaceId, purpose, ok: false, error: networkError(e) });
      throw e;
    }
  },
});

export function installSsoHandoff(): void {
  setSsoDeepLinkHandler((url) => ssoBroker.handleCallback(url));
}
export function cancelSso(id: string): void {
  if (id === 'pending') ssoBroker.invalidateForAccountSwitch();
  else ssoBroker.cancel(id);
}
export function invalidateSsoServer(): void {
  ++authEpoch;
  recovery = null;
  ssoBroker.invalidateForServerSwitch();
}
export async function beginSso(args: SsoStart): Promise<IpcResult<{ attemptId: string; expiresAt: number }>> {
  let id = '';
  try {
    if (args.purpose === 'login' && broker.hasSession) throw new Error('Local session already active');
    const serverOrigin = new URL(currentServerUrl()).origin;
    const challenge = ssoBroker.prepare({ ...args, serverOrigin });
    id = challenge.attemptId;
    const access = await getAccessToken();
    const path =
      args.purpose === 'test'
        ? `/api/workspaces/${encodeURIComponent(args.workspaceId)}/identity/test`
        : `/api/auth/sso/workspaces/${encodeURIComponent(args.workspaceId)}/begin`;
    const res = await apiSession().fetch(`${serverOrigin}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Origin: serverOrigin, ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: JSON.stringify(
        toJson(
          SSOBeginRequestSchema,
          create(SSOBeginRequestSchema, {
            purpose: ssoPurposes[args.purpose],
            clientKind: SSOClientKind.SSO_CLIENT_KIND_DESKTOP,
            desktopChallenge: challenge.challenge,
          }),
        ),
      ),
    });
    if (!res.ok) {
      ssoBroker.cancel(id);
      return { ok: false, error: await readError(res) };
    }
    const result = fromJson(SSOBeginResponseSchema, (await res.json()) as JsonValue);
    const expiresAt = result.expiresAt ? timestampDate(result.expiresAt).getTime() : 0;
    await ssoBroker.associateAndOpen(id, result.flowId, result.browserStartUrl, expiresAt);
    return { ok: true, data: { attemptId: id, expiresAt } };
  } catch (e) {
    if (id) ssoBroker.cancel(id);
    return { ok: false, error: networkError(e) };
  }
}

export async function identityAccessToken(path: string): Promise<string | null> {
  if (recovery && recovery.expiresAt > Date.now() && path === `/api/workspaces/${encodeURIComponent(recovery.workspaceId)}/identity/policy`)
    return recovery.token;
  return getAccessToken();
}
export async function recoverIdentity(workspaceId: string, code: string): Promise<IpcResult<{ expiresAt: number }>> {
  try {
    const started = authEpoch;
    const base = currentServerUrl();
    const original = broker.current?.sessionId;
    const token = await getAccessToken();
    if (!token || scopedWorkspace) throw new Error('Independent local sign-in required');
    const res = await apiSession().fetch(`${base}/api/auth/sso/workspaces/${encodeURIComponent(workspaceId)}/recover`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin, Authorization: `Bearer ${token}` },
      body: JSON.stringify(toJson(IdentityRecoverRequestSchema, create(IdentityRecoverRequestSchema, { recoveryCode: code }))),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const result = fromJson(SSOCompleteResponseSchema, (await res.json()) as JsonValue);
    const t = result.tokens;
    if (
      started !== authEpoch ||
      original !== broker.current?.sessionId ||
      base !== currentServerUrl() ||
      !t?.accessExpiresAt ||
      t.authority?.kind !== SessionAuthorityKind.RECOVERY ||
      t.authority.workspaceId !== workspaceId
    )
      throw new Error('Recovery unavailable');
    const expiresAt = timestampDate(t.accessExpiresAt).getTime();
    recovery = { workspaceId, token: t.accessToken, expiresAt };
    return { ok: true, data: { expiresAt } };
  } catch {
    return { ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE', message: 'Recovery unavailable', status: 0 } };
  }
}
