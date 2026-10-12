import type { MailAddress, MailDraftAttachment, MailHeader, MailMessage } from '../../../shared/mail';

/**
 * Reply / Reply all / Forward prefill (Apple Mail rules, ADR-0088 §8), pure. The quote lives in the
 * composer's editor (editor.ts) and is sent as part of `MailDraft.html`; `ref` keeps In-Reply-To /
 * References / `\Answered`.
 */

const RE = /^\s*(re|aw|sv|ответ|отв)\s*(\[\d+\])?\s*:/i;
const FWD = /^\s*(fwd?|fw|wg|пересл\.?|переслано)\s*:/i;

export const replySubject = (s: string): string => (RE.test(s) ? s.trim() : `Re: ${s.trim()}`.trim());
export const forwardSubject = (s: string): string => (FWD.test(s) ? s.trim() : `Fwd: ${s.trim()}`.trim());

const norm = (a: string): string => a.trim().toLowerCase();

function uniq(list: MailAddress[], skip: Set<string>): MailAddress[] {
  const out: MailAddress[] = [];
  for (const a of list) {
    const k = norm(a.address);
    if (!k || skip.has(k)) continue;
    skip.add(k);
    out.push({ name: a.name, address: k });
  }
  return out;
}

/**
 * Recipients of a reply: Reply-To, else the sender; replying to my own message goes to its
 * recipients. «Ответить всем» adds the other To / Cc addresses to Cc, never me.
 */
export function replyRecipients(msg: Pick<MailHeader, 'from' | 'to' | 'cc' | 'replyTo'>, mine: readonly string[], all: boolean): { to: MailAddress[]; cc: MailAddress[] } {
  const me = new Set(mine.map(norm));
  const fromMe = me.has(norm(msg.from.address));
  const base = fromMe ? msg.to : msg.replyTo.length ? msg.replyTo : [msg.from];
  const seen = new Set(fromMe ? [] : me);
  const to = uniq(base, seen);
  if (!all) return { to, cc: [] };
  for (const m of me) seen.add(m);
  const cc = uniq([...(fromMe ? [] : msg.to), ...msg.cc], seen);
  return { to, cc };
}

/** The original's attachments carried by a forward (inline images stay in the quote). */
export function forwardAttachments(msg: Pick<MailMessage, 'id' | 'attachments'>): MailDraftAttachment[] {
  return msg.attachments
    .filter((a) => !a.inline)
    .map((a) => ({ kind: 'message' as const, id: `${msg.id}:${a.id}`, name: a.name, mime: a.mime, size: a.size, messageId: msg.id, attachmentId: a.id }));
}

/** The total size of the draft's attachments, against the 25 MB limit (§6). */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
export const attachmentsSize = (list: readonly MailDraftAttachment[]): number => list.reduce((s, a) => s + a.size, 0);

/** Whether files of these sizes still fit next to the draft's attachments (§6: 25 MB in total). */
export function fitsAttachments(current: readonly MailDraftAttachment[], adding: readonly number[]): { total: number; ok: boolean } {
  const total = attachmentsSize(current) + adding.reduce((s, n) => s + n, 0);
  return { total, ok: total <= MAX_ATTACH_BYTES };
}

/**
 * A forward's inline images by the URL they are shown with in the editor: the ones still in the
 * text on send travel as attachments (the contract has no Content-ID for draft attachments, so they
 * cannot stay inline in the recipient's copy).
 */
export function inlineImages(msg: Pick<MailMessage, 'id' | 'attachments'>, url: (messageId: string, attachmentId: string) => string): Map<string, MailDraftAttachment> {
  const out = new Map<string, MailDraftAttachment>();
  for (const a of msg.attachments) {
    if (!a.inline || !a.mime.startsWith('image/')) continue;
    out.set(url(msg.id, a.id), { kind: 'message', id: `${msg.id}:${a.id}`, name: a.name, mime: a.mime, size: a.size, messageId: msg.id, attachmentId: a.id });
  }
  return out;
}

/** Addresses from a typed chip input: «a@b.c», «Name <a@b.c>»; the rest stays typed. */
export function chipFrom(text: string): MailAddress | null {
  const p = text.trim().replace(/[,;]$/, '').trim();
  const m = /^(.*)<([^>]+)>$/.exec(p);
  const address = norm(m ? (m[2] ?? '') : p);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  return { name: m ? (m[1] ?? '').trim().replace(/^"|"$/g, '') : '', address };
}

/** Autocomplete: addresses whose name or address starts a word with the query, the closest first. */
export function suggest(pool: readonly MailAddress[], query: string, exclude: readonly MailAddress[], limit = 6): MailAddress[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const taken = new Set(exclude.map((a) => norm(a.address)));
  const scored: Array<[number, MailAddress]> = [];
  for (const a of pool) {
    if (taken.has(norm(a.address))) continue;
    const name = a.name.toLowerCase();
    const addr = a.address.toLowerCase();
    const score = addr.startsWith(q) || name.startsWith(q) ? 0 : name.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : addr.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score, a]);
  }
  return scored
    .sort((x, y) => x[0] - y[0] || x[1].address.localeCompare(y[1].address))
    .slice(0, limit)
    .map((x) => x[1]);
}

/** `%EMAILADDRESS%` / `%EMAILLOCALPART%` (autoconfig, §4) → the login for this address. */
export function resolveLogin(template: string, email: string): string {
  return template.replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, email.slice(0, email.lastIndexOf('@')));
}
