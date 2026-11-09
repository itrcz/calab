import { validateAppUrl } from '../shared/appUrl';

/**
 * The pure decisions of the web app views (ADR-0050 §4–§5), kept free of Electron so they are
 * unit-tested: what a site may ask for, where a navigation may go, what window.open opens, and
 * which views stay alive.
 */

// ---------------------------------------------------------------- permissions

/** A permission the user is asked about once per app (a Calab dialog); the answer is remembered. */
export type AskKind = 'camera' | 'microphone' | 'notifications' | 'geolocation' | 'clipboard-read';

export type PermissionDecision = { kind: 'allow' } | { kind: 'deny' } | { kind: 'ask'; ask: AskKind[] };

const ALLOW = { kind: 'allow' } as const;
const DENY = { kind: 'deny' } as const;

/**
 * setPermissionRequestHandler of an app session. Camera / microphone / notifications /
 * geolocation / clipboard-read are asked; a sanitized clipboard write (a «Copy» button) is
 * allowed as in any browser; everything else — HID, serial, USB, MIDI (sysex too), pointer lock,
 * full screen, screen capture, idle detection, window management, storage access, opening
 * external apps, protected media — is refused.
 */
export function permissionDecision(permission: string, mediaTypes: readonly string[] = []): PermissionDecision {
  switch (permission) {
    case 'media': {
      const ask: AskKind[] = [];
      if (mediaTypes.includes('video')) ask.push('camera');
      if (mediaTypes.includes('audio')) ask.push('microphone');
      // No media type named (an old enumerate path): refuse rather than grant both unseen.
      return ask.length ? { kind: 'ask', ask } : DENY;
    }
    case 'notifications':
      return { kind: 'ask', ask: ['notifications'] };
    case 'geolocation':
      return { kind: 'ask', ask: ['geolocation'] };
    case 'clipboard-read':
      return { kind: 'ask', ask: ['clipboard-read'] };
    case 'clipboard-sanitized-write':
      return ALLOW;
    default:
      return DENY;
  }
}

/** Remembered answers of one app: kind → granted. */
export type Remembered = Partial<Record<AskKind, boolean>>;

/**
 * setPermissionCheckHandler: a synchronous «is it granted?» — true only for what the request
 * handler would grant without asking (allow, or every asked kind remembered as granted).
 */
export function permissionCheck(permission: string, mediaType: string | undefined, remembered: Remembered): boolean {
  const d = permissionDecision(permission, mediaType ? [mediaType] : permission === 'media' ? ['audio', 'video'] : []);
  if (d.kind === 'allow') return true;
  if (d.kind === 'deny') return false;
  return d.ask.every((k) => remembered[k] === true);
}

/** What the request handler does with the remembered answers: grant, refuse, or ask about the rest. */
export function resolveWithRemembered(ask: readonly AskKind[], remembered: Remembered): { grant: true } | { grant: false } | { ask: AskKind[] } {
  if (ask.some((k) => remembered[k] === false)) return { grant: false };
  const open = ask.filter((k) => remembered[k] === undefined);
  return open.length ? { ask: open } : { grant: true };
}

// ---------------------------------------------------------------- navigation

/**
 * A top-level navigation inside a view (ADR-0050 §4): any https (sites go to SSO and back),
 * http only to a private host (the address rule, shared/appUrl.ts). Every other scheme — file:,
 * javascript:, data:, calab:, calaba-api:, custom app schemes — is refused. Unlike the saved
 * address, a navigation has no length limit (SAML / OAuth redirects carry long queries) and its
 * host is whatever Chromium resolved (underscores, punycode).
 */
export function mayNavigate(url: string): boolean {
  const m = /^(https?):\/\/([^/?#\\]*)/i.exec(url);
  const authority = (m?.[2] ?? '').slice((m?.[2] ?? '').lastIndexOf('@') + 1);
  if (!m || !authority) return false;
  if (m[1]?.toLowerCase() === 'https') return true;
  return validateAppUrl(`http://${authority}/`).ok;
}

/** The permission key of a page: its origin («https://meet.example.com:8443»); '' if not http(s). */
export function originOf(url: string): string {
  const m = /^(https?):\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url);
  return m ? `${(m[1] ?? '').toLowerCase()}://${(m[2] ?? '').toLowerCase()}` : '';
}

/**
 * A sub-frame navigation: web content only (an embedded player, a captcha…) — http(s), blob:,
 * data: (Chromium gives it an opaque origin) and about:blank / about:srcdoc; never file:,
 * javascript: or an app scheme.
 */
export function mayNavigateFrame(url: string): boolean {
  return /^(https?:|blob:|data:|about:(blank|srcdoc)$)/i.test(url);
}

// ---------------------------------------------------------------- window.open

export type OpenDecision = 'child' | 'external' | 'deny';

/**
 * window.open / target=_blank from a view (ADR-0050 §4):
 * - a popup (`disposition: new-window`, i.e. window.open with features — OAuth / SSO sign-in
 *   windows) or a page of the same site → a child window of Calab with the app's session and
 *   the same restrictions (`about:blank` popups too: sign-in scripts open one and navigate it);
 * - another site in a new tab → the system browser;
 * - any other scheme → refused.
 */
export function windowOpenDecision(openerUrl: string, url: string, disposition: string): OpenDecision {
  const popup = disposition === 'new-window';
  if (url === 'about:blank' || url === '') return popup ? 'child' : 'deny';
  if (!/^https?:\/\//i.test(url)) return 'deny';
  if (!mayNavigate(url)) return 'external';
  if (popup || sameSite(openerUrl, url)) return 'child';
  return 'external';
}

/** Two http(s) URLs of one site (registrable domain, approximated; IPs and single labels whole). */
export function sameSite(a: string, b: string): boolean {
  const sa = siteOf(a);
  return sa !== '' && sa === siteOf(b);
}

/** Second-level labels under which registrations are one level deeper (co.uk, com.ru, …). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'msk', 'spb']);

export function siteOf(url: string): string {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  const host = (m?.[1] ?? '').toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || /^[0-9.]+$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1] ?? '';
  const sld = labels[labels.length - 2] ?? '';
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

// ---------------------------------------------------------------- sign-in with the Calab session

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a code request must carry to be one the provider can answer (OIDC, PKCE S256). */
const REQUIRED = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];

export interface WorkspaceSignIn {
  /** The site's request with `prompt=none` added: answered silently or with consent_required. */
  silent: string;
  /** The site's request as it is: opens a consent request when none is remembered. */
  interactive: string;
  /** Where the answer may go: the client's redirect_uri (the app's own origin). */
  redirectUri: string;
}

function parseUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/**
 * A top-level navigation of app `workspaceId`'s view to «Sign in with Calab» of the same
 * workspace on our own server (ADR-0159): Calab answers it with the session it already has.
 * Anything else — another server, another workspace, a client whose redirect_uri is not the
 * app's own origin (a site must not sign in as another app), a request the site shaped itself
 * (prompt, max_age, hints) or a malformed one — returns null and loads as before.
 */
export function workspaceSignIn(target: string, serverUrl: string, workspaceId: string, home: string): WorkspaceSignIn | null {
  const url = parseUrl(target);
  const server = parseUrl(serverUrl);
  const app = parseUrl(home);
  if (!url || !server || !app || !UUID.test(workspaceId)) return null;
  if (url.protocol !== 'https:' || url.origin !== server.origin || url.username || url.password || url.hash) return null;
  if (url.pathname !== `/oidc/workspaces/${workspaceId}/authorize`) return null;
  const q = url.searchParams;
  const keys = [...q.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (!REQUIRED.every((k) => q.get(k))) return null;
  if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') return null;
  if (['prompt', 'max_age', 'id_token_hint', 'login_hint', 'request', 'request_uri'].some((k) => q.has(k))) return null;
  const redirect = parseUrl(q.get('redirect_uri') ?? '');
  if (!redirect || redirect.origin !== app.origin || redirect.username || redirect.password || redirect.hash) return null;
  if (redirect.protocol !== 'https:' && !validateAppUrl(`http://${redirect.host}/`).ok) return null;
  const silent = new URL(url);
  silent.searchParams.set('prompt', 'none');
  return { silent: silent.toString(), interactive: url.toString(), redirectUri: redirect.toString() };
}

export type SignInAnswer = { kind: 'code'; url: string } | { kind: 'consent' } | { kind: 'fallback' };

/**
 * The provider's answer to the silent request (its Location): a code for the app's redirect_uri
 * goes to the view, `consent_required` asks the user once; anything else (signed out, not a
 * member, a guest, a policy refusal) leaves the site's own sign-in path in place.
 */
export function signInAnswer(location: string | null, serverUrl: string, redirectUri: string): SignInAnswer {
  const to = location ? parseUrl(location, serverUrl) : null;
  if (!to || !sameEndpoint(to.toString(), redirectUri)) return { kind: 'fallback' };
  if (to.searchParams.get('code') && !to.searchParams.has('error')) return { kind: 'code', url: to.toString() };
  return to.searchParams.get('error') === 'consent_required' ? { kind: 'consent' } : { kind: 'fallback' };
}

/** The consent request a non-silent authorize opened: its handle, only on our own server. */
export function consentRequest(location: string | null, serverUrl: string): string | null {
  const to = location ? parseUrl(location, serverUrl) : null;
  const server = parseUrl(serverUrl);
  if (!to || !server || to.origin !== server.origin || to.pathname !== '/oauth/consent' || to.hash) return null;
  const handles = to.searchParams.getAll('request');
  const handle = handles.length === 1 ? (handles[0] ?? '') : '';
  return /^calab_oh_[A-Za-z0-9_-]{32,128}$/.test(handle) ? handle : null;
}

/** A decision's redirect goes to the view only if it is the app's own redirect_uri. */
export function sameEndpoint(a: string, b: string): boolean {
  const x = parseUrl(a);
  const y = parseUrl(b);
  return !!x && !!y && x.origin === y.origin && x.pathname === y.pathname && !x.username && !x.password && !x.hash;
}

/** At most this many sign-ins per app a minute: a site that loops back to sign-in falls back. */
export const SIGN_IN_PER_MINUTE = 3;

export function signInAllowed(recent: readonly number[], now: number): boolean {
  return recent.filter((t) => now - t < 60_000).length < SIGN_IN_PER_MINUTE;
}

// ---------------------------------------------------------------- LRU of live views

/** Views kept alive at most (ADR-0050 §5): the open app and the one before it. */
export const MAX_LIVE_VIEWS = 2;

/**
 * `id` becomes the most recent (first); returns the new order and the ids to destroy (beyond
 * `max`, least recent last).
 */
export function touchLru(order: readonly string[], id: string, max = MAX_LIVE_VIEWS): { order: string[]; evicted: string[] } {
  const next = [id, ...order.filter((x) => x !== id)];
  return { order: next.slice(0, max), evicted: next.slice(max) };
}

/** `id` is gone (deleted, crashed): the order without it. */
export function dropLru(order: readonly string[], id: string): string[] {
  return order.filter((x) => x !== id);
}

// ---------------------------------------------------------------- IPC arguments

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Validates renderer bounds (CSS px of the main window) and scales them to window DIPs. */
export function parseBounds(v: unknown, zoom = 1): ViewBounds {
  if (typeof v !== 'object' || v === null) throw new Error('invalid bounds');
  const r = v as Record<string, unknown>;
  const n = (k: string): number => {
    const x = r[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 100_000) throw new Error('invalid bounds');
    return x;
  };
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { x: Math.round(n('x') * z), y: Math.round(n('y') * z), width: Math.round(n('width') * z), height: Math.round(n('height') * z) };
}

/** An app id from the renderer: a UUID (it names the session partition `persist:app-<id>`). */
export function parseAppId(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('invalid app id');
  return v.toLowerCase();
}

export const partitionOf = (appId: string): string => `persist:app-${appId}`;
