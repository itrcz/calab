/**
 * `calaba-mail://attachment/<messageId>/<attachmentId>` (ADR-0088 §7, §10): attachment bytes from the
 * engine, served by main. Inline answers only for raster `image/*` (the message body's `<img>`,
 * `cid:` rewritten by the renderer); everything else is answered as a download, and a download
 * happens only when main itself starts it (the app window navigating to the URL → frameGuard →
 * `webContents.downloadURL`) — saved into Downloads with quarantine / Mark-of-the-Web like
 * downloads.ts, then revealed. Ids are validated strictly before anything reaches the engine.
 */
import { app, protocol, session, shell, type DownloadItem, type Session } from 'electron';
import type { MailAttachmentData, MailReply } from '../../shared/mail';
import { MAIL_ATTACHMENT_URL, MAIL_REMOTE_URL } from '../../shared/mail';
import { markFromInternet, uniquePath } from '../downloads';
import { log } from '../logging';
import { ATTACHMENT_ID_RE, MESSAGE_ID_RE } from './ids';
import { MAIL_SCHEME } from './scheme';


/** Raster images shown inline; SVG (scriptable) and everything else only as a download. */
const INLINE = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|heic|heif)$/;

export function parseAttachmentUrl(url: string): { messageId: string; attachmentId: string } | null {
  if (!url.startsWith(MAIL_ATTACHMENT_URL)) return null;
  const rest = url.slice(MAIL_ATTACHMENT_URL.length).split(/[?#]/)[0] ?? '';
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  let messageId: string;
  let attachmentId: string;
  try {
    messageId = decodeURIComponent(parts[0] ?? '');
    attachmentId = decodeURIComponent(parts[1] ?? '');
  } catch {
    return null;
  }
  if (!MESSAGE_ID_RE.test(messageId) || !ATTACHMENT_ID_RE.test(attachmentId)) return null;
  return { messageId, attachmentId };
}

export function isInlineMime(mime: string): boolean {
  return INLINE.test(mime.toLowerCase());
}

/** RFC 5987 filename for Content-Disposition (no quotes / CR / LF can break out). */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=3600' };

/** `download`: main's own download request (`?download=1`): always an attachment with its name. */
export function attachmentResponse(a: MailAttachmentData, download = false): Response {
  const body = new Uint8Array(a.data);
  if (!download && isInlineMime(a.mime)) return new Response(body, { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': a.mime.toLowerCase() } });
  return new Response(body, { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Disposition': contentDisposition(a.name) } });
}

export type FetchAttachment = (messageId: string, attachmentId: string) => Promise<MailReply>;

// ---------------------------------------------------------------- remote images (§10)

export const REMOTE_MAX_BYTES = 10 * 1024 * 1024;
export const REMOTE_TIMEOUT_MS = 10_000;

/** `calaba-mail://remote/<base64url>` → the http(s) URL it carries, or null. */
export function parseRemoteUrl(url: string): string | null {
  if (!url.startsWith(MAIL_REMOTE_URL)) return null;
  const b64 = url.slice(MAIL_REMOTE_URL.length).split(/[?#]/)[0] ?? '';
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(b64)) return null;
  const target = Buffer.from(b64, 'base64url').toString('utf8');
  try {
    const u = new URL(target);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

let remoteSession: Session | null = null;

/** In-memory, cookie-less, separate from the app's sessions: a tracker learns nothing about the user. */
function remoteSes(): Session {
  remoteSession ??= session.fromPartition('calab-mail-remote', { cache: true });
  return remoteSession;
}

/** Reads a body up to `max` bytes; null when it is larger. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export async function fetchRemoteImage(target: string, fetcher: (url: string, init: RequestInit) => Promise<Response> = (u, i) => remoteSes().fetch(u, i)): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetcher(target, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', headers: { Accept: 'image/*' } });
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!res.ok || !res.body || !/^https?:/.test(res.url || target)) return new Response(null, { status: 502 });
    if (!isInlineMime(mime)) {
      void res.body.cancel();
      return new Response(null, { status: 415 });
    }
    const data = await readCapped(res.body, REMOTE_MAX_BYTES);
    if (!data) return new Response(null, { status: 413 });
    return new Response(new Uint8Array(data), { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': mime } });
  } catch {
    return new Response(null, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}

export function handleMailScheme(fetchAttachment: FetchAttachment): void {
  protocol.handle(MAIL_SCHEME, async (req) => {
    if (req.method !== 'GET') return new Response(null, { status: 405 });
    if (req.url.startsWith(MAIL_REMOTE_URL)) {
      const target = parseRemoteUrl(req.url);
      return target ? fetchRemoteImage(target) : new Response(null, { status: 400 });
    }
    const ids = parseAttachmentUrl(req.url);
    if (!ids) return new Response(null, { status: 400 });
    const r = await fetchAttachment(ids.messageId, ids.attachmentId);
    if (!r.ok) return new Response(null, { status: r.error.code === 'NOT_FOUND' ? 404 : 503 });
    const a = r.result as MailAttachmentData;
    return attachmentResponse(a, new URL(req.url).searchParams.get('download') === '1');
  });
}

function onWillDownload(_e: Electron.Event, item: DownloadItem): void {
  const url = item.getURLChain()[0] ?? item.getURL();
  if (!url.startsWith(MAIL_ATTACHMENT_URL)) return;
  const path = uniquePath(app.getPath('downloads'), item.getFilename() || 'attachment');
  item.setSavePath(path); // no save dialog, like downloads.ts
  item.once('done', (_ev, state) => {
    if (state !== 'completed') {
      log.warn('[mail] attachment download not completed', state);
      return;
    }
    void markFromInternet(path, 'calaba-mail://attachment').then(() => shell.showItemInFolder(path));
  });
}

let downloadsOn: Session | null = null;

/** Mail attachment downloads on a session (main's own `downloadURL` calls only). */
export function installMailDownloads(ses: Session): void {
  if (downloadsOn === ses) return;
  ses.on('will-download', onWillDownload);
  downloadsOn = ses;
}
