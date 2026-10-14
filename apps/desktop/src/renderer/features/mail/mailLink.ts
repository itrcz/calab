import type { MailAddress } from '../../../shared/mail';

/**
 * Mail links (ADR-0088 §8, §12), pure — services/links.ts calls it before anything else:
 * - `calab://mail/<payload>`, `payload = base64url("email[:password]")` (the password may contain
 *   `:`, the first one separates) → the add-account form, prefilled, never submitted by itself;
 * - `calab://mail/<accountId>/<messageId>` → open the message (a notification, §8);
 * - `calab://mail/compose?to=…&cc=…&subject=…&body=…` and `mailto:` → a new message.
 * `calaba://` is the old scheme alias. The URL and the payload carry a password: never log them.
 */
export type MailLink =
  | { kind: 'add'; email: string; password: string }
  | { kind: 'open'; accountId: string; messageId: string }
  | { kind: 'compose'; to: MailAddress[]; cc: MailAddress[]; subject: string; body: string }
  /** A `mail/` link that does not decode (a damaged payload). */
  | { kind: 'invalid' };

const PREFIX = /^calaba?:\/\/mail\/(.*)$/i;
const EMAIL = /^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/;

/** A plausible mailbox address (the engine checks the rest). */
export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL.test(s);

/** base64url (padding optional) → UTF-8 text; null when malformed. */
export function decodeBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (b64.length % 4 === 1) return null;
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The add-account payload: `email[:password]`, the first `:` separates. */
export function parseAddPayload(payload: string): { email: string; password: string } | null {
  const text = decodeBase64Url(payload);
  if (text === null) return null;
  const at = text.indexOf(':');
  const email = (at < 0 ? text : text.slice(0, at)).trim().toLowerCase();
  const password = at < 0 ? '' : text.slice(at + 1);
  return isEmail(email) ? { email, password } : null;
}

/** «Имя <a@b>, c@d» → addresses (bad ones dropped). */
export function parseAddressList(s: string): MailAddress[] {
  const out: MailAddress[] = [];
  for (const part of s.split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(.*)<([^>]+)>$/.exec(p);
    const address = (m ? (m[2] ?? '') : p).trim().toLowerCase();
    const name = m ? (m[1] ?? '').trim().replace(/^"|"$/g, '') : '';
    if (isEmail(address)) out.push({ name, address });
  }
  return out;
}

function decodeParam(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, '%20'));
  } catch {
    return v;
  }
}

/** `mailto:a@b?cc=…&subject=…&body=…` (RFC 6068); null when not a mailto URL. */
export function parseMailto(url: string): Extract<MailLink, { kind: 'compose' }> | null {
  if (!/^mailto:/i.test(url)) return null;
  const rest = url.slice(7);
  const q = rest.indexOf('?');
  return composeFrom(q < 0 ? rest : rest.slice(0, q), q < 0 ? '' : rest.slice(q + 1));
}

function composeFrom(toPart: string, query: string): Extract<MailLink, { kind: 'compose' }> {
  const link = { kind: 'compose' as const, to: parseAddressList(decodeParam(toPart)), cc: [] as MailAddress[], subject: '', body: '' };
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? '' : decodeParam(pair.slice(eq + 1));
    if (key === 'to') link.to.push(...parseAddressList(value));
    else if (key === 'cc') link.cc.push(...parseAddressList(value));
    else if (key === 'subject') link.subject = value.slice(0, 998);
    else if (key === 'body') link.body = value.slice(0, 100_000);
  }
  return link;
}

/** A mail deep link (or `mailto:`), null when the URL is not one of ours. */
export function parseMailLink(url: string): MailLink | null {
  const s = url.trim();
  const mailto = parseMailto(s);
  if (mailto) return mailto;
  const m = PREFIX.exec(s);
  if (!m) return null;
  const path = (m[1] ?? '').replace(/\/+$/, '');
  if (/^compose(?:\?|$)/i.test(path)) {
    const q = path.indexOf('?');
    return composeFrom('', q < 0 ? '' : path.slice(q + 1));
  }
  const parts = path.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    try {
      return { kind: 'open', accountId: decodeURIComponent(parts[0]), messageId: decodeURIComponent(parts[1]) };
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (parts.length === 1 && parts[0]) {
    const add = parseAddPayload(parts[0]);
    return add ? { kind: 'add', ...add } : { kind: 'invalid' };
  }
  return { kind: 'invalid' };
}
