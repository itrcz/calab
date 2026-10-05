import { consentReturnPath } from '../../shared/ssoReturn';
import { create, fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  SSOBeginRequestSchema,
  SSOBeginResponseSchema,
  SSOFinishRequestSchema,
  SSOCompleteResponseSchema,
  SSOClientKind,
  SSOFlowPurpose,
  SessionAuthoritySchema,
  SessionAuthorityKind,
  IdentityRecoverRequestSchema,
} from '@calaba/protocol';
import type { SsoStart, SsoResult } from '../../shared/ipc';
import type {
  ApiErrorJson,
  AppInfo,
  AppSettings,
  AuthSession,
  IpcResult,
  LoginArgs,
  LogoutReason,
  PowerEvent,
  PttBinding,
  PttEvent,
  PttStatus,
  RegisterArgs,
} from '../../shared/ipc';
import { noSession } from '../../shared/ipc';
import { PttGate } from '../../shared/pttGate';
import { mouseName } from '../../shared/pttKeys';
import { logoutReasonFromRefresh } from '../../shared/logoutReason';
import { AUTH_TIMEOUT_MS, refreshGate } from '../../shared/refreshGate';
import type { GuestJoin, Platform } from './types';

/**
 * Web platform (ADR-0015). Same origin as the API (`https://app.<domain>`):
 * - the refresh token lives in an HttpOnly `SameSite=Strict` cookie set by the server
 *   (requests carry `X-Client: web`); the access token only in memory;
 * - if the server answers with the refresh token in the body (no cookie mode), it is
 *   kept in memory only (never in storage) — a reload then asks to log in again;
 * - refreshes are serialised across tabs with the Web Locks API, so two tabs never race
 *   a rotation (reuse detection would revoke the session).
 */

const ssoStorage = typeof sessionStorage === 'undefined' ? null : sessionStorage;
let recovery: { workspaceId: string; token: string; expiresAt: number } | null = null;
let ssoGeneration = 0;
let scopedWorkspace = ssoStorage?.getItem('calab-sso-workspace') ?? '';
const WEB_HEADER = { 'X-Client': 'web' } as const;
const REFRESH_MARGIN_MS = 60_000;

interface TokensJson {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken?: string;
  sessionId: string;
}

let access: { token: string; exp: number; sessionId: string } | null = null;
let bodyRefresh: string | null = null;
/** Single-flight refresh; a transient failure is reused for a few seconds (review N3). */
const refreshes = refreshGate(() => doRefresh());
const loggedOutListeners = new Set<(r: LogoutReason) => void>();

function applyTokens(t: TokensJson): void {
  access = { token: t.accessToken, exp: Date.parse(t.accessExpiresAt), sessionId: t.sessionId };
  if (t.refreshToken) bodyRefresh = t.refreshToken; // server without cookie mode
  refreshes.reset();
}

/** Bumped on every sign-out: a refresh answer that arrives later must not resurrect it. */
let epoch = 0;

function clear(reason: LogoutReason | null, preserveFlow = false): void {
  epoch++;
  recovery = null;
  scopedWorkspace = '';
  ssoStorage?.removeItem('calab-sso-workspace');
  if (!preserveFlow) ssoStorage?.removeItem('calab-sso-flow');
  access = null;
  bodyRefresh = null;
  refreshes.reset();
  clearMediaCache(); // images of the previous account (review M10)
  if (reason) for (const cb of loggedOutListeners) cb(reason);
}

async function readError(res: Response): Promise<ApiErrorJson> {
  try {
    const b = (await res.json()) as Partial<ApiErrorJson>;
    return { code: b.code ?? 'ERROR_CODE_UNSPECIFIED', message: b.message ?? res.statusText, ...(b.field ? { field: b.field } : {}), ...(typeof b.reason === 'string' && b.reason ? { reason: b.reason } : {}), status: res.status };
  } catch {
    return { code: 'ERROR_CODE_UNSPECIFIED', message: res.statusText || `HTTP ${res.status}`, status: res.status };
  }
}

function postAuth(path: string, body: unknown, bearer?: string): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    // Bounded: a black-holed refresh runs inside the cross-tab Web Lock and would block every tab (review N3).
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...WEB_HEADER, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

/**
 * 409 on /api/auth/refresh = another refresh of the same session won the race and the server
 * could not replay it (normally an old cookie gets the same new cookie again while the new one
 * is unused, docs/09 #89, #123): retry, the cookie may already hold the new token. Still 409 →
 * transient.
 */
const REFRESH_CONFLICT_RETRIES = 3;

/**
 * null = no token now. Transient failures (offline, 5xx, 429) keep the session — callers retry
 * (the gateway backs off); only a rejected refresh signs out, via `onLoggedOut` (review H3).
 */
async function doRefresh(): Promise<string | null> {
  const started = epoch;
  const run = async (attempt = 0): Promise<string | null> => {
    try {
      const res = await postAuth(
        scopedWorkspace ? `/api/auth/sso/workspaces/${encodeURIComponent(scopedWorkspace)}/refresh` : '/api/auth/refresh',
        bodyRefresh ? { refreshToken: bodyRefresh } : {},
      );
      if (started !== epoch) return null; // signed out meanwhile
      // 409 = another tab rotated the cookie a moment ago: the cookie already holds the new token.
      if (res.status === 409 && attempt < REFRESH_CONFLICT_RETRIES) {
        await new Promise((r) => setTimeout(r, 150 + Math.round(Math.random() * 250)));
        return await run(attempt + 1);
      }
      if (res.ok) {
        const body = (await res.json()) as { tokens: TokensJson };
        if (started !== epoch) return null;
        applyTokens(body.tokens);
        return access?.token ?? null;
      }
      if (res.status === 401 || res.status === 400 || res.status === 403) {
        const hadSession = access !== null;
        let reason: LogoutReason = 'expired';
        if (res.status === 401) {
          const body = (await res.json().catch(() => ({}))) as { code?: string; reason?: string };
          reason = logoutReasonFromRefresh(body.code, body.reason);
        }
        clear(hadSession ? reason : null, !hadSession && location.pathname === '/sso/complete');
        return null;
      }
      return null; // 5xx / rate limit: keep the session, retry later
    } catch {
      return null; // offline
    }
  };
  // One refresh at a time across tabs (they share the cookie).
  // Web Locks: all current browsers; the guard keeps very old Safari working (single-tab refresh).
  return 'locks' in navigator ? navigator.locks.request('calaba-refresh', () => run()) : run();
}

function refreshOnce(): Promise<string | null> {
  return refreshes.run();
}

async function accessToken(): Promise<string | null> {
  if (access && access.exp - Date.now() > REFRESH_MARGIN_MS) return access.token;
  return refreshOnce();
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /YaBrowser\//.test(ua) ? 'Yandex' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} (web)`;
}

async function authenticate(path: string, body: Record<string, unknown>): Promise<IpcResult<AuthSession>> {
  const started = ++epoch;
  ssoStorage?.removeItem('calab-sso-flow');
  try {
    const res = await postAuth(path, { ...body, deviceName: deviceName() });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { tokens?: TokensJson; me: unknown; similarAccount?: boolean };
    if (!data.tokens) return { ok: false, error: noSession(data.similarAccount, res.status) };
    if (started !== epoch) throw new Error('Account changed');
    clear(null);
    applyTokens(data.tokens);
    return { ok: true, data: { serverUrl: location.origin, sessionId: data.tokens.sessionId, me: data.me } };
  } catch (e) {
    return { ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE', message: e instanceof Error ? e.message : String(e), status: 0 } };
  }
}

/** Guest account from a room link (ADR-0016): the server sets the refresh cookie like on login. */
async function guestJoin(code: string, nickname: string): Promise<IpcResult<GuestJoin>> {
  const started = ++epoch; ++ssoGeneration;
  ssoStorage?.removeItem('calab-sso-flow');
  try {
    const res = await postAuth(`/api/room-invites/${encodeURIComponent(code)}/join`, { nickname, deviceName: deviceName() });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { roomId: string; workspaceId: string; tokens?: TokensJson; me?: unknown; admission?: unknown };
    if (!data.tokens)
      return { ok: false, error: { code: 'ERROR_CODE_INTERNAL', message: 'no guest session in the response', status: res.status } };
    if (started !== epoch) throw new Error('Account changed');
    clear(null);
    applyTokens(data.tokens);
    return {
      ok: true,
      data: {
        session: { serverUrl: location.origin, sessionId: data.tokens.sessionId, me: data.me },
        roomId: data.roomId,
        workspaceId: data.workspaceId,
        ...(data.admission ? { admission: data.admission } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE', message: e instanceof Error ? e.message : String(e), status: 0 } };
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = async (token: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(path, { ...init, headers, credentials: 'same-origin' });
  };
  const recoveryToken =
    recovery && recovery.expiresAt > Date.now() && path === `/api/workspaces/${encodeURIComponent(recovery.workspaceId)}/identity/policy`
      ? recovery.token
      : null;
  let res = await go(recoveryToken ?? (await accessToken()));
  // Retry once after a forced refresh if the body can be replayed (not a stream).
  const replayable = init.body === undefined || init.body === null || typeof init.body === 'string';
  if (res.status === 401 && replayable && access && !recoveryToken) {
    const t = await refreshOnce();
    if (t) res = await go(t);
  }
  return res;
}

// ---------------------------------------------------------------- media URLs (blob cache)

/**
 * LRU of blob: URLs for authenticated media (review M10). Evicted blobs are revoked — before,
 * eviction only dropped the map entry and the blob stayed alive until the tab closed.
 * Consumers hold the URL string only (no release call), so the revoke waits a grace period:
 * an element that got the URL just before eviction has loaded it by then (a loaded <img> keeps
 * its decoded image after the revoke; a remount asks `mediaUrl` again and refetches).
 */
interface MediaEntry {
  url: Promise<string>;
  objectUrl: string | null;
  bytes: number;
  evicted: boolean;
  protectedEviction?: boolean;
}
const MEDIA_MAX_ENTRIES = 300;
const MEDIA_MAX_BYTES = 150 * 1024 * 1024;
const MEDIA_REVOKE_GRACE_MS = 60_000;
const mediaCache = new Map<string, MediaEntry>(); // Map order = LRU order (re-inserted on hit)
let mediaBytes = 0;

function evictMedia(path: string, e: MediaEntry, graceMs: number): void {
  if (mediaCache.get(path) === e) mediaCache.delete(path);
  if (e.evicted) return;
  e.evicted = true;
  const u = e.objectUrl;
  if (!u) return; // still loading: revoked when it resolves
  mediaBytes -= e.bytes;
  if (graceMs > 0) window.setTimeout(() => URL.revokeObjectURL(u), graceMs);
  else URL.revokeObjectURL(u);
}

function trimMedia(): void {
  while (mediaCache.size > 1 && (mediaCache.size > MEDIA_MAX_ENTRIES || mediaBytes > MEDIA_MAX_BYTES)) {
    const oldest = mediaCache.entries().next().value;
    if (!oldest) break;
    evictMedia(oldest[0], oldest[1], MEDIA_REVOKE_GRACE_MS);
  }
}

function clearMediaCache(): void {
  for (const [path, e] of [...mediaCache]) {
    e.protectedEviction = true;
    evictMedia(path, e, 0);
  }
  mediaBytes = 0;
}

function mediaUrl(path: string): Promise<string> {
  const hit = mediaCache.get(path);
  if (hit) {
    mediaCache.delete(path);
    mediaCache.set(path, hit);
    return hit.url;
  }
  const e: MediaEntry = { url: Promise.resolve(''), objectUrl: null, bytes: 0, evicted: false };
  e.url = apiFetch(path).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    if (e.evicted) {
      if (e.protectedEviction) {
        URL.revokeObjectURL(u);
        throw new Error('Protected media evicted');
      }
      window.setTimeout(() => URL.revokeObjectURL(u), MEDIA_REVOKE_GRACE_MS);
      return u;
    }
    e.objectUrl = u;
    e.bytes = blob.size;
    mediaBytes += blob.size;
    trimMedia();
    return u;
  });
  e.url.catch(() => {
    if (mediaCache.get(path) === e) mediaCache.delete(path);
  });
  mediaCache.set(path, e);
  trimMedia();
  return e.url;
}

// ---------------------------------------------------------------- PTT (focused tab only)

let binding: PttBinding | null = null;
let gate: PttGate | null = null;
const pttListeners = new Set<(e: PttEvent) => void>();
let capture: { id: number; resolve: (b: PttBinding) => void; reject: (e: Error) => void } | null = null;
const MAC = /Mac OS X|Macintosh/.test(navigator.userAgent);

function pttEmit(talking: boolean, immediate: boolean): void {
  for (const cb of pttListeners) cb({ down: talking, immediate, at: Date.now() });
}

/** Browsers on macOS report Caps Lock as lock-state flips (down = on, up = off): toggle only. */
function isLockCode(code: string): boolean {
  return MAC && code === 'CapsLock';
}

function setWebBinding(b: PttBinding | null): void {
  gate?.reset();
  binding = b?.kind === 'dom' ? b : null;
  gate = binding ? new PttGate(isLockCode(binding.code) ? 'toggle' : (binding.mode ?? 'hold'), isLockCode(binding.code), pttEmit) : null;
}

function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function keyLabel(e: KeyboardEvent): string {
  if (e.code === 'Space') return 'Space';
  if (e.code === 'CapsLock') return '⇪ Caps Lock';
  return e.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}

window.addEventListener('keydown', (e) => {
  if (capture) {
    e.preventDefault();
    const c = capture;
    capture = null;
    if (e.code === 'Escape') c.reject(new Error('cancelled'));
    else c.resolve({ kind: 'dom', code: e.code, label: keyLabel(e), mode: isLockCode(e.code) ? 'toggle' : 'hold' });
    return;
  }
  if (binding?.kind === 'dom' && binding.code === e.code && !isTyping(e)) {
    e.preventDefault();
    gate?.input(true);
  }
});
window.addEventListener('keyup', (e) => {
  if (binding?.kind === 'dom' && binding.code === e.code) gate?.input(false);
});
window.addEventListener('mousedown', (e) => {
  // DOM buttons: 1 middle, 3 back, 4 forward (uiohook numbering is +1).
  const code = `Mouse${e.button}`;
  if (capture && (e.button === 1 || e.button >= 3)) {
    const c = capture;
    capture = null;
    c.resolve({ kind: 'dom', code, label: mouseName(e.button + 1), mode: 'hold' });
    return;
  }
  if (binding?.kind === 'dom' && binding.code === code) gate?.input(true);
});
window.addEventListener('mouseup', (e) => {
  if (binding?.kind === 'dom' && binding.code === `Mouse${e.button}`) gate?.input(false);
});
// Losing focus releases a held key (keyup never arrives in another app); a toggle stays.
window.addEventListener('blur', () => {
  if (binding && !isLockCode(binding.code as string) && (binding.mode ?? 'hold') === 'hold') gate?.reset();
});

/**
 * Closing / reloading the tab during a call asks first (the browser's own «Leave site?»; docs/09
 * #31 — the desktop equivalent is the quit confirmation). Outside a call: no prompt.
 */
let webInVoice = false;
window.addEventListener('beforeunload', (e) => {
  if (!webInVoice) return;
  // preventDefault() alone triggers the prompt in Chromium 119+, Firefox and Safari.
  e.preventDefault();
});

function pttStatus(): PttStatus {
  return { active: binding !== null, binding, trusted: true, error: null, capsRemap: 'unsupported', wayland: false, hid: 'unsupported' };
}

// ---------------------------------------------------------------- downloads

async function download(args: { fileId: string; name: string }): Promise<string> {
  const res = await apiFetch(`/api/files/${args.fileId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = args.name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return args.name;
}

// ---------------------------------------------------------------- app

function info(): AppInfo {
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '';
  return {
    version: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
    platform: 'web',
    hostname: location.host,
    electron: '',
    chrome,
    packaged: true,
    fakeMedia: false,
    forceRelay: false,
    visualTest: new URLSearchParams(location.search).has('visual-test'),
    // Browsers can offer tab/system audio in their own picker; own-audio exclusion is not guaranteed.
    systemAudioLoopback: 'experimental',
    micAccess: 'n/a',
    screenAccess: 'n/a',
    locales: [...navigator.languages],
  };
}

const settings = (): AppSettings => ({ serverUrl: location.origin, updateUrl: '', autostart: false, autoUpdate: false, autoCheckUpdates: false, closeToTray: false, trayHintShown: false });

/**
 * Links on the web: https://<domain>/join/<code> (workspace invite) and https://<domain>/r/<code>
 * (room link, ADR-0016), https://<domain>/dm/<id> (a DM, ADR-0020), https://<domain>/e/<id> (a meeting, ADR-0038) — the same URLs the app shares. Handed on as the https link; the address
 * bar keeps the path while the link card is shown (docs/09 #53, services/linkLanding.ts).
 */
function takeDeepLink(): Promise<string | null> {
  const msg = /^\/m\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})\/?$/.exec(location.pathname);
  if (msg?.[1] && msg[2]) return Promise.resolve(`${location.origin}/m/${msg[1]}/${msg[2]}`);
  const m = /^\/(join|r|dm|e|b|t)\/([A-Za-z0-9_-]{4,64})\/?$/.exec(location.pathname);
  if (!m?.[1] || !m[2]) return Promise.resolve(null);
  return Promise.resolve(`${location.origin}/${m[1]}/${m[2]}`);
}

const noop = (): (() => void) => () => undefined;

export function createWebPlatform(): Platform {
  return {
    kind: 'web',
    canShareScreen: () => typeof navigator !== 'undefined' && typeof (navigator.mediaDevices as MediaDevices | undefined)?.getDisplayMedia === 'function',
    apiBase: '',
    apiFetch,
    authHeaders: async (): Promise<Record<string, string>> => {
      const t = await accessToken();
      return t ? { Authorization: `Bearer ${t}` } : {};
    },
    mediaUrl,
    directMedia: false,
    guestJoin,
    clearProtectedMedia: clearMediaCache,
    finishSso: finishWebSso,
    auth: {
      clearProtectedCache: () => {
        clearMediaCache();
        return Promise.resolve();
      },
      recover: async (workspaceId, code) => {
        const started = epoch;
        try {
          if (scopedWorkspace) throw new Error('Local sign-in required');
          const token = await accessToken();
          const res = await postAuth(
            `/api/auth/sso/workspaces/${encodeURIComponent(workspaceId)}/recover`,
            toJson(IdentityRecoverRequestSchema, create(IdentityRecoverRequestSchema, { recoveryCode: code })),
            token ?? undefined,
          );
          if (!res.ok) return { ok: false, error: await readError(res) };
          const result = fromJson(SSOCompleteResponseSchema, (await res.json()) as JsonValue);
          const t = result.tokens;
          if (
            started !== epoch ||
            !t?.accessExpiresAt ||
            t.authority?.kind !== SessionAuthorityKind.RECOVERY ||
            t.authority.workspaceId !== workspaceId
          )
            throw new Error('Invalid recovery authority');
          const expiresAt = timestampDate(t.accessExpiresAt).getTime();
          recovery = { workspaceId, token: t.accessToken, expiresAt };
          return { ok: true, data: { expiresAt } };
        } catch {
          return { ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE', message: 'Recovery unavailable', status: 0 } };
        }
      },
      ssoBegin: beginWebSso,
      ssoCancel: () => {
        ++ssoGeneration;
        ssoStorage?.removeItem('calab-sso-flow');
        return Promise.resolve();
      },
      onSsoResult: () => () => undefined,
      restore: async () => {
        const started = epoch;
        const t = await refreshOnce();
        if (started !== epoch) return null;
        if (!t) {
          if (!navigator.onLine) throw new Error('offline');
          return null;
        }
        const res = await apiFetch('/api/me');
        if (!res.ok) return null;
        const body = (await res.json()) as { me: unknown };
        if (started !== epoch) return null;
        return {
          serverUrl: location.origin,
          sessionId: access?.sessionId ?? '',
          me: body.me,
          ...(scopedWorkspace
            ? {
                authority: toJson(
                  SessionAuthoritySchema,
                  create(SessionAuthoritySchema, { kind: SessionAuthorityKind.WORKSPACE_SSO, workspaceId: scopedWorkspace }),
                ),
              }
            : {}),
        };
      },
      login: (a: LoginArgs) => authenticate('/api/auth/login', { email: a.email, password: a.password }),
      register: (a: RegisterArgs) =>
        authenticate('/api/auth/register', {
          email: a.email,
          password: a.password,
          displayName: a.displayName,
          inviteCode: a.inviteCode,
          locale: a.locale ?? '',
          ...(a.checkSimilar ? { checkSimilarAccount: true } : {}),
        }),
      guestJoin,
      logout: async (allSessions) => {
        const started = ++epoch; ++ssoGeneration;
        ssoStorage?.removeItem('calab-sso-flow');
        const t = access?.token;
        try {
          await postAuth(
            scopedWorkspace ? `/api/auth/sso/workspaces/${encodeURIComponent(scopedWorkspace)}/logout` : '/api/auth/logout',
            { allSessions, ...(bodyRefresh ? { refreshToken: bodyRefresh } : {}) },
            t,
          );
        } catch {
          // cleared locally anyway
        }
        if (started === epoch) clear('logout');
      },
      accessToken,
      forceRefresh: () => (access || bodyRefresh ? refreshOnce() : Promise.resolve(null)),
      revoked: () => {
        clear(null);
        return Promise.resolve();
      },
      onLoggedOut: (cb) => {
        loggedOutListeners.add(cb);
        return () => loggedOutListeners.delete(cb);
      },
    },
    app: {
      info: () => Promise.resolve(info()),
      // Served next to the web client (copied by `pnpm build:web`).
      legal: async () => {
        const get = async (path: string): Promise<string> => {
          try {
            const r = await fetch(path);
            return r.ok ? await r.text() : '';
          } catch {
            return '';
          }
        };
        const [license, notice, commercial, thirdParty] = await Promise.all([
          get('/LICENSE.txt'),
          get('/NOTICE.txt'),
          get('/COMMERCIAL-LICENSE.txt'),
          get('/THIRD-PARTY-NOTICES.txt'),
        ]);
        return { license, notice, commercial, thirdParty };
      },
      getSettings: () => Promise.resolve(settings()),
      setSettings: () => Promise.resolve(settings()),
      takeDeepLink,
      onDeepLink: noop,
      onPower: (cb: (e: PowerEvent) => void) => {
        const online = (): void => cb('resume');
        window.addEventListener('online', online);
        return () => window.removeEventListener('online', online);
      },
      onApiReset: noop,
      checkUpdates: () => Promise.resolve({ state: 'disabled' }),
      onUpdateStatus: noop,
      updateStatus: () => Promise.resolve({ state: 'disabled' }),
      installUpdate: () => Promise.resolve(false),
      downloadUpdate: () => Promise.resolve(false),
      // No restart for an update on the web (docs/09 #126 is desktop only).
      onPrepareRestart: noop,
      setResumeVoice: () => Promise.resolve(),
      takeResumeVoice: () => Promise.resolve(null),
      networkOnline: () => undefined,
      log: (level, message) => {
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(message);
      },
      openExternal: (raw) => {
        // Synchronously, within the click (popup blockers); the scheme in any case, like main's
        // IPC check (ADR-0045 amendment 1: «HTTPS://…» links of calendars did nothing here).
        const url = raw.trim();
        if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
        // mailto: (the plan contact, ADR-0024) hands over to the mail client, the page stays.
        else if (/^mailto:[^\s/]+@/i.test(url)) location.href = url;
        return Promise.resolve();
      },
      attention: () => undefined,
      // Installed PWA: the app icon badge (Badging API, where supported).
      setBadge: (n) => {
        if (!('setAppBadge' in navigator)) return;
        void (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => undefined);
      },
      setTheme: () => undefined,
      setStrings: () => undefined,
    },
    tray: {
      // No tray on the web: the voice state only arms the «leave the page?» prompt.
      setState: (s) => {
        webInVoice = s.inVoice;
      },
      onAction: noop,
    },
    menu: { setState: () => undefined, onAction: noop },
    files: { download, onProgress: noop, pathOf: (f) => f.name, decodeImage: () => Promise.resolve(null) },
    capture: {
      // The browser shows its own picker on getDisplayMedia().
      listSources: () => Promise.resolve([]),
      selectSource: () => Promise.resolve(),
    },
    ptt: {
      setBinding: (b) => {
        setWebBinding(b);
        return Promise.resolve(pttStatus());
      },
      captureNext: (id) =>
        new Promise<PttBinding>((resolve, reject) => {
          capture?.reject(new Error('superseded'));
          capture = { id, resolve, reject };
        }),
      cancelCapture: (id) => {
        // Only the binder that started the capture may cancel it (review N6).
        const c = capture;
        if (!c || c.id !== id) return;
        capture = null;
        c.reject(new Error('cancelled'));
      },
      status: () => Promise.resolve(pttStatus()),
      onEvent: (cb) => {
        pttListeners.add(cb);
        return () => pttListeners.delete(cb);
      },
      // No global hook in the browser: nothing to diagnose.
      onRawKey: () => () => undefined,
    },
    system: {
      openPrivacySettings: () => Promise.resolve(),
      metrics: () => Promise.resolve({ rendererCpu: null, gpuCpu: null, mainCpu: null, rendererPid: 0 }),
      permissions: async () => {
        const q = async (name: string): Promise<string> => {
          try {
            const s = await navigator.permissions.query({ name: name as PermissionName });
            return s.state === 'prompt' ? 'not-determined' : s.state;
          } catch {
            return 'n/a';
          }
        };
        return {
          microphone: await q('microphone'),
          camera: await q('camera'),
          screen: 'n/a',
          accessibility: true,
          notifications: typeof Notification === 'undefined' ? 'n/a' : Notification.permission,
        };
      },
      requestMic: async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          return true;
        } catch {
          return false;
        }
      },
      idleSeconds: () => Promise.resolve(webIdleSeconds()),
      // The browser asks at getDisplayMedia() itself; the onboarding screen step is macOS desktop only.
      screenAccess: () => Promise.resolve({ status: 'n/a', canCapture: true }),
      requestScreenAccess: () => Promise.resolve({ status: 'n/a', canCapture: true }),
      relaunch: () => {
        window.location.reload();
        return Promise.resolve();
      },
    },
    // No overlay over the screen in a browser (ADR-0028): annotations stay on the stream tile.
    annotOverlay: {
      open: () => Promise.resolve(false),
      send: () => undefined,
      close: () => undefined,
    },
    // The Fullscreen API on the whole page (the stream stage puts its own video container in full
    // screen instead: features/voice/fullscreen.ts).
    window: {
      setFullScreen: async (on) => {
        try {
          if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
          if (!on && document.fullscreenElement) await document.exitFullscreen();
        } catch {
          // no user activation / not allowed: stays as it is
        }
        return document.fullscreenElement !== null;
      },
      isFullScreen: () => Promise.resolve(document.fullscreenElement !== null),
      onFullScreenChange: (cb) => {
        const listener = (): void => cb(document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', listener);
        return () => document.removeEventListener('fullscreenchange', listener);
      },
      // A browser's Page Visibility API is truthful: nothing to add.
      isShown: () => Promise.resolve(true),
      onShownChange: () => () => undefined,
    },
  };
}

// ---------------------------------------------------------------- AFK (web)

/**
 * A browser only sees input inside its own tab: activity = keyboard/pointer/wheel events here
 * and the tab becoming visible again. A hidden tab accumulates idle time.
 */
let lastInput = Date.now();
let idleTracking = false;

function webIdleSeconds(): number {
  if (!idleTracking) {
    idleTracking = true;
    const bump = (): void => {
      lastInput = Date.now();
    };
    for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) {
      window.addEventListener(ev, bump, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') bump();
    });
  }
  return Math.floor((Date.now() - lastInput) / 1000);
}

async function beginWebSso(args: SsoStart): Promise<IpcResult<{ attemptId: string; expiresAt: number }>> {
  const generation = ++ssoGeneration;
  try {
    if (args.purpose === 'login' && access) throw new Error('Local session active');
    const token = await accessToken();
    const purpose = {
      login: SSOFlowPurpose.SSO_FLOW_PURPOSE_LOGIN,
      step_up: SSOFlowPurpose.SSO_FLOW_PURPOSE_STEP_UP,
      link: SSOFlowPurpose.SSO_FLOW_PURPOSE_LINK,
      test: SSOFlowPurpose.SSO_FLOW_PURPOSE_TEST,
    }[args.purpose];
    const path =
      args.purpose === 'test'
        ? `/api/workspaces/${encodeURIComponent(args.workspaceId)}/identity/test`
        : `/api/auth/sso/workspaces/${encodeURIComponent(args.workspaceId)}/begin`;
    const res = await postAuth(
      path,
      toJson(SSOBeginRequestSchema, create(SSOBeginRequestSchema, { purpose, clientKind: SSOClientKind.SSO_CLIENT_KIND_WEB })),
      token ?? undefined,
    );
    if (!res.ok) return { ok: false, error: await readError(res) };
    const result = fromJson(SSOBeginResponseSchema, (await res.json()) as JsonValue);
    const expiresAt = result.expiresAt ? timestampDate(result.expiresAt).getTime() : 0;
    if (!result.flowId || expiresAt <= Date.now()) throw new Error('Invalid SSO response');
    if (generation !== ssoGeneration) throw new Error('Cancelled');
    const target = new URL(result.authorizationUrl);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Invalid authorization URL');
    // Only public context survives navigation. Credentials remain in memory/HttpOnly cookies.
    ssoStorage?.setItem(
      'calab-sso-flow',
      JSON.stringify({ ...args, flowId: result.flowId, expiresAt, sessionId: access?.sessionId ?? '',
        ...(args.purpose === 'step_up' ? { returnTo: consentReturnPath(`${location.origin}${location.pathname}${location.search}`, location.origin) } : {}) }),
    );
    location.assign(target.href);
    return { ok: true, data: { attemptId: result.flowId, expiresAt } };
  } catch {
    return { ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE', message: 'SSO unavailable', status: 0 } };
  }
}

async function finishWebSso(): Promise<IpcResult<SsoResult>> {
  const started = epoch;
  try {
    const saved = JSON.parse(ssoStorage?.getItem('calab-sso-flow') ?? 'null') as
      | (SsoStart & { flowId: string; expiresAt: number; sessionId: string; returnTo?: string })
      | null;
    ssoStorage?.removeItem('calab-sso-flow');
    if (!saved || saved.expiresAt <= Date.now() || !['login', 'step_up', 'link', 'test'].includes(saved.purpose))
      throw new Error('SSO expired');
    const token = saved.purpose === 'login' ? null : await accessToken();
    if (saved.purpose !== 'login' && saved.sessionId !== access?.sessionId) throw new Error('Account changed');
    if (saved.purpose === 'login' && access) throw new Error('Account changed');
    const res = await postAuth(
      '/api/auth/sso/finish',
      toJson(SSOFinishRequestSchema, create(SSOFinishRequestSchema, { flowId: saved.flowId })),
      token ?? undefined,
    );
    if (!res.ok) return { ok: false, error: await readError(res) };
    const result = fromJson(SSOCompleteResponseSchema, (await res.json()) as JsonValue);
    if (started !== epoch) throw new Error('Account changed');
    let installed: AuthSession | undefined;
    if (saved.purpose === 'login') {
      const t = result.tokens;
      if (!t || t.authority?.kind !== SessionAuthorityKind.WORKSPACE_SSO || t.authority.workspaceId !== saved.workspaceId)
        throw new Error('Unexpected authority');
      const profile = await fetch('/api/me', { headers: { Authorization: `Bearer ${t.accessToken}` }, credentials: 'same-origin' });
      if (!profile.ok) throw new Error('Profile unavailable');
      const me = ((await profile.json()) as { me: unknown }).me;
      if (started !== epoch) throw new Error('Account changed');
      scopedWorkspace = saved.workspaceId;
      ssoStorage?.setItem('calab-sso-workspace', scopedWorkspace);
      applyTokens({
        accessToken: t.accessToken,
        accessExpiresAt: t.accessExpiresAt ? timestampDate(t.accessExpiresAt).toISOString() : '',
        refreshToken: t.refreshToken,
        sessionId: t.sessionId,
      });
      installed = { serverUrl: location.origin, sessionId: t.sessionId, me, authority: toJson(SessionAuthoritySchema, t.authority) };
    } else if (result.tokens || (saved.purpose === 'test' ? !result.tested : result.assurance?.workspaceId !== saved.workspaceId))
      throw new Error('Unexpected SSO result');
    const returnTo = saved.purpose === 'step_up' && saved.sessionId === access?.sessionId ? consentReturnPath(saved.returnTo ?? '', location.origin) : undefined;
    return { ok: true, data: { workspaceId: saved.workspaceId, purpose: saved.purpose, ok: true, ...(returnTo ? { returnTo } : {}), ...(installed ? { session: installed } : {}) } };
  } catch {
    return { ok: false, error: { code: 'ERROR_CODE_IDENTITY_CONFIG_CHANGED', message: 'Restart SSO', status: 409 } };
  }
}
