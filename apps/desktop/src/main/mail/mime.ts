/**
 * MIME helpers of the engine: body-structure inspection and list snippets (header sync), and the
 * full body parse with mailparser on `messages.get` (§5).
 */
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { MailAddress, MailAttachment } from '../../shared/mail';
import type { StoredBody } from './store';

/** The subset of imapflow's MessageStructureObject we read. */
export interface BodyStructure {
  part?: string | undefined;
  type: string;
  parameters?: Record<string, string> | undefined;
  encoding?: string | undefined;
  size?: number | undefined;
  disposition?: string | undefined;
  dispositionParameters?: Record<string, string> | undefined;
  childNodes?: BodyStructure[] | undefined;
}

export const SNIPPET_MAX = 200;
/** Bytes of the text part fetched for a snippet. */
export const SNIPPET_FETCH = 2048;

/** The part to build a snippet from: the first text/plain, else the first text/html (not attachments). */
export function snippetPart(bs: BodyStructure | undefined): { part: string; type: string; encoding: string; charset: string } | null {
  if (!bs) return null;
  let html: { part: string; type: string; encoding: string; charset: string } | null = null;
  const walk = (n: BodyStructure, path: string): { part: string; type: string; encoding: string; charset: string } | null => {
    const type = n.type.toLowerCase();
    if (n.childNodes?.length) {
      if (type === 'message/rfc822') return null;
      for (const c of n.childNodes) {
        const r = walk(c, c.part ?? path);
        if (r) return r;
      }
      return null;
    }
    if ((n.disposition ?? '').toLowerCase() === 'attachment') return null;
    const info = { part: n.part ?? path, type, encoding: (n.encoding ?? '7bit').toLowerCase(), charset: n.parameters?.['charset'] ?? 'utf-8' };
    if (type === 'text/plain') return info;
    if (type === 'text/html' && !html) html = info;
    return null;
  };
  return walk(bs, '1') ?? html;
}

/** Real attachments (not inline body parts): drives the paper clip before the body is downloaded. */
export function hasAttachments(bs: BodyStructure | undefined): boolean {
  if (!bs) return false;
  const walk = (n: BodyStructure): boolean => {
    if (n.childNodes?.length) return n.childNodes.some(walk);
    const disp = (n.disposition ?? '').toLowerCase();
    const type = n.type.toLowerCase();
    if (disp === 'attachment') return true;
    if (disp === 'inline') return false;
    return !type.startsWith('text/') && !type.startsWith('multipart/') && !!(n.parameters?.['name'] ?? n.dispositionParameters?.['filename']);
  };
  return walk(bs);
}

function decodeQp(s: string): Buffer {
  const bytes: number[] = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

export function decodeCharset(buf: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** Decodes a (possibly truncated) transfer-encoded part to text. */
export function decodePart(raw: Uint8Array, encoding: string, charset: string): string {
  const s = Buffer.from(raw).toString('latin1');
  let bytes: Uint8Array;
  if (encoding === 'base64') {
    const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
    bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  } else if (encoding === 'quoted-printable') bytes = decodeQp(s);
  else bytes = Buffer.from(raw);
  return decodeCharset(bytes, charset);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

/** Crude HTML → text for snippets (not for display): drops head / style / script, tags, decodes entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith('#')) {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** List preview: quoted lines dropped, whitespace collapsed, ≤ 200 chars. */
export function makeSnippet(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*>/.test(l));
  const s = lines.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : s;
}

export function snippetFrom(raw: Uint8Array, part: { type: string; encoding: string; charset: string }): string {
  const text = decodePart(raw, part.encoding, part.charset);
  return makeSnippet(part.type === 'text/html' ? htmlToText(text) : text);
}

/** `<a@b> <c@d>` → ['<a@b>', '<c@d>'] (Message-IDs keep their brackets, as in the headers). */
export function parseMessageIds(v: string): string[] {
  return [...v.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]).slice(0, 100);
}

/** The References header out of a raw header block (folded lines joined). */
export function referencesFromHeaders(headers: Uint8Array | undefined): string[] {
  if (!headers) return [];
  const text = Buffer.from(headers).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  const m = /^references:(.*)$/im.exec(text);
  return m?.[1] ? parseMessageIds(m[1]) : [];
}

const REMOTE = /\b(src|background|poster)\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\//i;

export function hasRemoteImages(html: string | null): boolean {
  return !!html && REMOTE.test(html);
}

export interface ParsedBody {
  body: StoredBody;
  attachments: Array<MailAttachment & { data: Uint8Array }>;
  bcc: MailAddress[];
}

function addresses(a: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  const out: MailAddress[] = [];
  for (const o of list) for (const v of o.value) if (v.address) out.push({ name: v.name, address: v.address.toLowerCase() });
  return out;
}

/** Full parse of an RFC 822 source (mailparser): raw HTML (cid: links kept), text, attachments. */
export async function parseBody(source: Buffer): Promise<ParsedBody> {
  const p: ParsedMail = await simpleParser(source, { keepCidLinks: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const html = typeof p.html === 'string' ? p.html : null;
  const text = p.text ?? (html ? htmlToText(html).replace(/[ \t]+/g, ' ').trim() : null);
  const attachments = p.attachments.map((a, i) => {
    const att: MailAttachment & { data: Uint8Array } = {
      id: String(i),
      name: a.filename ?? (a.contentType.startsWith('image/') ? `image-${String(i + 1)}` : `attachment-${String(i + 1)}`),
      mime: a.contentType.toLowerCase(),
      size: a.size,
      inline: a.contentDisposition === 'inline' || (!!a.cid && !!html?.includes(`cid:${a.cid}`)),
      data: new Uint8Array(a.content.buffer, a.content.byteOffset, a.content.byteLength),
    };
    if (a.cid) att.cid = a.cid.replace(/^<|>$/g, '');
    return att;
  });
  const refs = Array.isArray(p.references) ? p.references : p.references ? parseMessageIds(p.references) : [];
  return {
    body: { html, text, inReplyTo: p.inReplyTo ?? '', references: refs, remoteImages: hasRemoteImages(html) },
    attachments,
    bcc: addresses(p.bcc),
  };
}
