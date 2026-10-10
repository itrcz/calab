import type { CheckoutWindowOutcome } from '../shared/ipc';

/**
 * Pure policy of the in-app checkout window (main/checkoutWindow.ts, ADR-0084): where the window
 * may START, where its page may go, which links leave for the OS and which navigation means «the
 * payer is back». No Electron imports: unit-tested in checkoutPolicy.test.ts.
 *
 * The window only ever starts on a provider host from this allowlist (the URL comes from our
 * server's POST …/topups); after that the page may navigate anywhere over https (card 3DS: the
 * issuer's ACS pages are arbitrary bank hosts), never to http, file, data, javascript or custom
 * schemes. SBP bank-app links are handed to the OS after a scheme / host check.
 */

/** Hosted checkout pages the window may start on: Stripe Checkout, Tochka payment links. */
export const CHECKOUT_START_HOSTS: readonly string[] = ['checkout.stripe.com', 'merch.securepaytb.ru', 'merch.tochka.com'];

/** The server's return page (BILLING_PUBLIC_RETURN_URL, success + cancel of every checkout). */
export const SERVER_RETURN_PATH = '/api/billing/return';
/** The landing's return pages set in the Tochka merchant settings (calab.io/onpay/success|fail). */
const LANDING_RETURN = /^\/onpay\/(success|fail)\/?$/;

const MAX_URL = 4096;

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** https, default port, no credentials, nothing a parser could read two ways. */
function cleanHttps(raw: string): URL | null {
  if (raw.length > MAX_URL || /[\s\\]/.test(raw)) return null;
  const url = parse(raw);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url;
}

/**
 * Extra start hosts from the environment (`CALABA_CHECKOUT_HOSTS`, comma-separated hostnames: a
 * provider sandbox, a test stand). Anything that is not a plain lowercase hostname is dropped.
 */
export function extraStartHosts(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h));
}

/**
 * The URL the renderer asks to open (IPC input): a string, https, exactly an allowlisted host.
 * null = refuse (the renderer then falls back to the system browser).
 */
export function parseCheckoutStart(raw: unknown, extraHosts: readonly string[] = []): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const url = cleanHttps(s);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  return CHECKOUT_START_HOSTS.includes(host) || extraHosts.includes(host) ? url.href : null;
}

/** A navigation of the page (main frame or a frame) the window lets happen in place. */
export function mayNavigateCheckout(raw: string): boolean {
  if (raw === 'about:blank' || raw === 'about:srcdoc') return true;
  return cleanHttps(raw) !== null;
}

/**
 * SBP: a bank-app link (`bank100000000111://…`, the NSPK registry scheme) or an NSPK QR / sub link
 * (`https://qr.nspk.ru/…`, `https://sub.nspk.ru/…`). On the desktop there is no bank app: the payer
 * scans the QR of Tochka's page with the phone (owner, 2026-10-10), so such a navigation or new
 * window is refused and the window stays on the QR page — never handed to the OS.
 */
export function isSbpAppLink(raw: string): boolean {
  const url = parse(raw);
  if (!url) return false;
  if (/^bank\d{9,12}:$/.test(url.protocol)) return true;
  return url.protocol === 'https:' && (url.hostname === 'qr.nspk.ru' || url.hostname === 'sub.nspk.ru');
}

/**
 * What the window does with a main-frame navigation: `return` (the payer is back — close),
 * `stay` (an SBP app link on the desktop, or anything not https — refused, the page stays),
 * `load` (in place: the checkout, 3DS pages).
 */
export function checkoutNavigation(raw: string, serverUrl: string): { kind: 'return'; outcome: Exclude<CheckoutWindowOutcome, 'closed' | 'external'> } | { kind: 'stay' } | { kind: 'load' } {
  const outcome = returnOutcome(raw, serverUrl);
  if (outcome) return { kind: 'return', outcome };
  if (isSbpAppLink(raw) || !mayNavigateCheckout(raw)) return { kind: 'stay' };
  return { kind: 'load' };
}

/**
 * Hosts whose return pages end the checkout: the server's own host (BILLING_PUBLIC_RETURN_URL is
 * `https://<app host>/api/billing/return`) and its parent domain (the landing, `calab.io` for
 * `app.calab.io`). Derived from the server the app talks to — no host is written in code.
 */
export function returnHosts(serverUrl: string): { serverOrigin: string; landingHosts: string[] } | null {
  const url = parse(serverUrl);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  const host = url.hostname.toLowerCase();
  const labels = host.split('.');
  const parent = labels.length > 2 ? labels.slice(1).join('.') : host;
  return { serverOrigin: url.origin, landingHosts: [...new Set([host, parent, `www.${parent}`])] };
}

/**
 * The page reached a return URL: the payer is back. `returned` = our return page (success and
 * cancel share it: the server polls the provider for the truth); `success` / `fail` = the landing
 * pages of the Tochka merchant settings. null = not a return URL.
 */
export function returnOutcome(raw: string, serverUrl: string): Exclude<CheckoutWindowOutcome, 'closed' | 'external'> | null {
  const hosts = returnHosts(serverUrl);
  const url = parse(raw);
  if (!hosts || !url || url.username || url.password) return null;
  if (url.origin === hosts.serverOrigin && url.pathname === SERVER_RETURN_PATH) return 'returned';
  if (url.protocol !== 'https:' || url.port || !hosts.landingHosts.includes(url.hostname.toLowerCase())) return null;
  const m = LANDING_RETURN.exec(url.pathname);
  return m ? (m[1] === 'success' ? 'success' : 'fail') : null;
}

/** What the title bar shows: the host of the page, and whether it is https (the lock). */
export function addressOf(raw: string): { host: string; secure: boolean } {
  const url = parse(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return { host: '', secure: false };
  return { host: url.hostname, secure: url.protocol === 'https:' };
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/**
 * The URL the title bar's «Отмена» link navigates to: caught by main in `will-navigate` and never
 * loaded (`.invalid` is a reserved TLD; an https link always raises `will-navigate`).
 */
export const CANCEL_URL = 'https://calab-checkout.invalid/cancel';
/** Height of the title bar view, in DIP. */
export const BAR_HEIGHT = 44;

/**
 * The title bar page: lock + host + «Отмена». Static HTML, no script (the view runs with
 * JavaScript off); the cancel button is a link main intercepts. Rebuilt on every host change.
 */
export function barHtml(address: { host: string; secure: boolean }, cancel: string): string {
  const lock = address.secure
    ? '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="currentColor"/></svg>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>
:root{--bg:#f5f5f7;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--btn:#e8e8ed}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#ececf0;--muted:#b4b4b9;--line:#3a3a3c;--btn:#2c2c2e}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-user-select:none;user-select:none;overflow:hidden}
.bar{box-sizing:border-box;height:${BAR_HEIGHT}px;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;border-bottom:1px solid var(--line);}
.addr{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--muted)}
.host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lock{width:12px;height:12px;flex:none;color:var(--muted)}
a{flex:none;padding:6px 12px;border-radius:9999px;background:var(--btn);color:var(--fg);text-decoration:none;font-weight:500}
a:hover{filter:brightness(.97)}
</style></head><body><div class="bar"><div class="addr">${lock}<span class="host">${esc(address.host)}</span></div><a href="${CANCEL_URL}">${esc(cancel)}</a></div></body></html>`;
}
