import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';
import { mailRemoteImageUrl } from '../../../shared/mail';

/**
 * HTML of a mail message → what the sandboxed iframe shows (ADR-0088 §10). The message HTML is
 * hostile input: DOMPurify with a strict HTML-only profile, then our own rules on top —
 * - no scripts, forms, frames, objects, external CSS, `<base>`, `<meta>`, media elements;
 * - `cid:` images → the attachment URL (`MailApi.attachmentUrl`), unknown cids dropped;
 * - remote (http/https) images and CSS `url()` only when the user allowed them — then through main
 *   (`calaba-mail://remote/…`, cookie-less, no referrer), else removed (so a tracking pixel never
 *   loads), and counted;
 * - links keep http(s) / mailto only, lose `target` (a click navigates the frame itself, main
 *   cancels it and opens the browser, §10) and get `rel=noopener noreferrer`.
 * The result goes into `srcdoc` behind a CSP meta (`mailSrcdoc`) and `sandbox=""` — the second
 * and third walls; this is the first.
 */

export interface SanitizeOptions {
  /** Remote images allowed for this message / sender. */
  remote: boolean;
  /** `cid:` → URL of the inline attachment, null = unknown (dropped). */
  cid: (contentId: string) => string | null;
}

export interface Sanitized {
  html: string;
  /** Remote resources removed because they were not allowed (the «Картинки скрыты» bar). */
  blocked: number;
  /**
   * The message sets its own text or background colours (inline styles, `<style>`, `bgcolor`,
   * `<font color>`): it keeps the white page. Otherwise it is shown in the app's theme (§8, like
   * Apple Mail in dark mode).
   */
  styled: boolean;
}

const FORBID_TAGS = [
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'option',
  'textarea', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track', 'portal', 'template', 'dialog', 'svg', 'math',
];
const FORBID_ATTR = ['srcset', 'ping', 'formaction', 'action', 'xmlns', 'autofocus', 'http-equiv'];

const REMOTE = /^https?:\/\//i;
const CID = /^cid:/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
/** CSS that can fetch or execute: never kept, remote images allowed or not. */
const CSS_DANGER = /@import[^;]*;?|expression\s*\(|-moz-binding|behavior\s*:|javascript:/gi;

/** A URL for an image, or null when it has to go. Counts blocked remote ones in `state`. */
function imageUrl(raw: string, opts: SanitizeOptions, state: { blocked: number }): string | null {
  const url = raw.trim();
  if (CID.test(url)) return opts.cid(decodeCid(url.slice(4)));
  if (REMOTE.test(url) || url.startsWith('//')) {
    if (opts.remote && REMOTE.test(url)) return mailRemoteImageUrl(url);
    state.blocked++;
    return null;
  }
  if (SAFE_DATA_IMAGE.test(url)) return url;
  return null;
}

function decodeCid(v: string): string {
  try {
    return decodeURIComponent(v).replace(/^<|>$/g, '');
  } catch {
    return v.replace(/^<|>$/g, '');
  }
}

/** A CSS declaration of a text / background colour (`border-color` and the like do not count). */
const CSS_COLOUR = /(?:^|[\s;{"'])(?:color|background(?:-color|-image)?)\s*:\s*(?!\s*(?:transparent|inherit|initial|unset|none)\s*(?:!important\s*)?(?:;|}|$))/i;

/** CSS text with `url()`s rewritten (cid → attachment, remote → kept only when allowed) and dangerous constructs removed. */
export function sanitizeCss(css: string, opts: SanitizeOptions, state: { blocked: number } = { blocked: 0 }): string {
  return css.replace(CSS_DANGER, '').replace(CSS_URL, (_m, _q: string, inner: string) => {
    const url = imageUrl(inner, opts, state);
    return url ? `url("${url.replace(/["\\\n\r]/g, '')}")` : 'none';
  });
}

let shared: Purifier | null = null;

/** One DOMPurify per window (the renderer's, or a test window). */
export function purifierFor(win?: Window): Purifier {
  if (!win) return (shared ??= DOMPurify);
  return DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]);
}

const CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS,
  FORBID_ATTR,
  WHOLE_DOCUMENT: true,
  // Keep <style> elements (newsletters live on them); their text is rewritten by the hook below.
  ADD_TAGS: ['style'],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  SAFE_FOR_TEMPLATES: false,
  RETURN_DOM: true,
};

/**
 * Sanitizes a message's HTML: the body content with the document's `<style>` elements first (a
 * newsletter's CSS sits in `<head>`). `purify` defaults to the renderer's DOMPurify.
 */
export function sanitizeMailHtml(html: string, opts: SanitizeOptions, purify: Purifier = purifierFor()): Sanitized {
  const state = { blocked: 0 };
  let styled = false;
  purify.removeAllHooks();
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'style') return;
    const css = node.textContent ?? '';
    // Judged on the CSS as sent: showing the remote images must not flip the page's colours.
    if (!styled && CSS_COLOUR.test(css)) styled = true;
    node.textContent = sanitizeCss(css, opts, state);
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node;
    if (typeof el.getAttribute !== 'function') return;
    const tag = el.tagName.toLowerCase();
    if (!styled) {
      const raw = el.getAttribute('style');
      styled = el.hasAttribute('bgcolor') || el.hasAttribute('background') || (tag === 'font' && el.hasAttribute('color')) || (raw !== null && CSS_COLOUR.test(raw));
    }
    for (const attr of ['src', 'background', 'poster']) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      const url = attr === 'poster' ? null : imageUrl(v, opts, state);
      if (url) el.setAttribute(attr, url);
      else el.removeAttribute(attr);
    }
    const style = el.getAttribute('style');
    if (style !== null) {
      const clean = sanitizeCss(style, opts, state);
      if (clean.trim()) el.setAttribute('style', clean);
      else el.removeAttribute('style');
    }
    if (tag === 'a' || tag === 'area') {
      el.removeAttribute('target');
      const href = (el.getAttribute('href') ?? '').trim();
      if (href && !/^(https?:|mailto:)/i.test(href)) el.removeAttribute('href');
      if (el.hasAttribute('href')) el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  try {
    // WHOLE_DOCUMENT + RETURN_DOM: the <html> element of DOMPurify's own document.
    const root = purify.sanitize(html, CONFIG) as unknown as HTMLElement;
    const body = root.querySelector('body');
    const styles = Array.from(root.querySelectorAll('head style'))
      .map((s) => `<style>${s.textContent.replace(/<\/style/gi, '')}</style>`)
      .join('');
    const bodyStyle = body?.getAttribute('style');
    const bg = body?.getAttribute('bgcolor');
    const wrapStyle = [bg && /^#?[0-9a-z]+$/i.test(bg) ? `background-color:${bg}` : '', bodyStyle ?? ''].filter(Boolean).join(';');
    const content = body ? body.innerHTML : root.innerHTML;
    return { html: `${styles}${wrapStyle ? `<div style="${escapeAttr(wrapStyle)}">${content}</div>` : content}`, blocked: state.blocked, styled };
  } finally {
    purify.removeAllHooks();
  }
}

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The iframe's CSP (§10): nothing but images (data:, our attachments and — only when the user
 * allowed them — remote images, both served by main under `calaba-mail:`) and inline styles. Never
 * `https:`: a remote image goes through main or not at all (the srcdoc also inherits the app's CSP,
 * which has no `https:` in `img-src`). The remote proxy is a separate host source, not the whole
 * scheme: the CSS rewrite above is a regex, and CSS has ways to name an image it does not see
 * (`image-set("…")`, escapes like `\75rl(…)`) — the CSP is what keeps a tracker out before consent.
 */
export function mailCsp(remote: boolean): string {
  return `default-src 'none'; img-src data: calaba-mail://attachment${remote ? ' calaba-mail://remote' : ''}; style-src 'unsafe-inline'`;
}

/** The CSP of a message whose remote images are not allowed. */
export const MAIL_CSP = mailCsp(false);

/**
 * The app theme a plain message is drawn in: resolved colours (`rgb(…)` / `#hex`), not variables —
 * the frame is another document and cannot see the app's CSS.
 */
export interface MailTheme {
  scheme: 'dark' | 'light';
  fg: string;
  muted: string;
  link: string;
  line: string;
}

const LAYOUT_CSS =
  'body{margin:0;padding:16px 20px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;overflow-wrap:anywhere;overflow-y:auto;overflow-x:auto}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:2px solid}';

/** A styled message: Apple Mail's white page whatever the app theme (its own colours assume it). */
const PAPER_CSS = 'html{color-scheme:light}body{color:#1d1d1f;background:#fff}a{color:#0066cc}blockquote{border-left-color:#c7c7cc;color:#555}';

const SAFE_COLOUR = /^(?:#[0-9a-f]{3,8}|rgba?\([0-9.,\s/%]+\))$/i;

/** Theme colours for the frame (only literal colours get through: they are written into CSS). */
function themeCss(th: MailTheme): string {
  const c = (v: string, fallback: string): string => (SAFE_COLOUR.test(v.trim()) ? v.trim() : fallback);
  const dark = th.scheme === 'dark';
  // Transparent page over the message card: the frame's colour scheme equals the app's, so Chromium
  // does not paint an opaque canvas behind it.
  return `html{color-scheme:${dark ? 'dark' : 'light'}}body{color:${c(th.fg, dark ? '#ececf0' : '#1d1d1f')};background:transparent}a{color:${c(th.link, dark ? '#409cff' : '#0066cc')}}blockquote{border-left-color:${c(th.line, dark ? '#48484a' : '#c7c7cc')};color:${c(th.muted, dark ? '#b4b4b9' : '#555')}}`;
}

/**
 * The iframe document: the CSP meta first (before any content can be parsed), then the sanitized
 * body. `theme` = draw it in the app's colours (a message without its own); null = the white page.
 * `remote` = the user allowed remote images for this message (the same flag the sanitizer got).
 */
export function mailSrcdoc(sanitizedHtml: string, theme: MailTheme | null = null, remote = false): string {
  const css = LAYOUT_CSS + (theme ? themeCss(theme) : PAPER_CSS);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${mailCsp(remote)}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>${css}</style></head><body>${sanitizedHtml}</body></html>`;
}

// ---------------------------------------------------------------- plain text

export type TextPart = { text: string } | { href: string; text: string };

const LINK = /\b(?:https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

/** Splits plain text into text and links (http(s), mailto, bare addresses); trailing punctuation stays text. */
export function linkify(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    let raw = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(raw)?.[0] ?? '';
    if (trail) raw = raw.slice(0, -trail.length);
    const at = m.index;
    if (at > last) out.push({ text: text.slice(last, at) });
    const href = /^(https?:|mailto:)/i.test(raw) ? raw : `mailto:${raw}`;
    out.push({ href, text: raw });
    last = at + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------- cache (§9)

/** Sanitized HTML per message id and remote flag, the last 20 (re-opening a message costs nothing). */
const CACHE_MAX = 20;
const cache = new Map<string, Sanitized>();

export function cachedSanitize(messageId: string, html: string, opts: SanitizeOptions): Sanitized {
  const key = `${messageId}\n${opts.remote ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const v = sanitizeMailHtml(html, opts);
  cache.set(key, v);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return v;
}
