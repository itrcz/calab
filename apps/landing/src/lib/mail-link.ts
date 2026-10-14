// "Add mail to Calab" link payload (ADR-0088 §12): `#mail=<base64url("email[:password]")>`.
// Pure and side-effect free. The password is never returned: the card only needs the address and the
// original payload string to forward to the app untouched. Only the fragment is read — a `?mail=` query
// is deliberately ignored (it would reach server logs).

export type MailLink = { email: string; hasPassword: boolean; payload: string };
export type MailLinkResult = MailLink | { error: 'malformed' };

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;

/** The raw `mail` value of a location hash (`#mail=…`, optionally among `&`-separated parts), or null. */
export function payloadFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    if (part.startsWith('mail=')) return part.slice(5);
  }
  return null;
}

function decodeBase64(payload: string): string | null {
  // base64url or plain base64, with or without `=` padding.
  const s = payload.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s === '' || !/^[A-Za-z0-9+/]+$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseMailPayload(payload: string): MailLinkResult {
  const text = decodeBase64(payload);
  if (text === null) return { error: 'malformed' };
  const i = text.indexOf(':');
  const rawEmail = (i === -1 ? text : text.slice(0, i)).trim();
  if (!EMAIL_RE.test(rawEmail)) return { error: 'malformed' };
  const at = rawEmail.lastIndexOf('@');
  const email = `${rawEmail.slice(0, at)}@${rawEmail.slice(at + 1).toLowerCase()}`;
  return { email, hasPassword: i !== -1 && text.length > i + 1, payload };
}

/** Reads and parses the payload from a location hash; null when the hash carries no `mail=`. */
export function parseMailHash(hash: string): MailLinkResult | null {
  const payload = payloadFromHash(hash);
  return payload === null ? null : parseMailPayload(payload);
}

/** Deep link into the desktop app; the payload goes in the path exactly as received. */
export const mailDeepLink = (payload: string): string => `calab://mail/${payload}`;
