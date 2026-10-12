/**
 * `calaba-mail://attachment/<messageId>/<attachmentId>` (ADR-0080 §7, §10): attachment bytes from the
 * engine, served by main. Inline answers only for raster `image/*` (the message body's `<img>`,
 * `cid:` rewritten by the renderer); everything else is answered as a download, and a download
 * happens only when main itself starts it (the app window navigating to the URL → frameGuard →
 * `webContents.downloadURL`) — saved into Downloads with quarantine / Mark-of-the-Web like
 * downloads.ts, then revealed. Ids are validated strictly before anything reaches the engine.
 */
import { app, protocol, shell, type DownloadItem, type Session } from 'electron';
import type { MailAttachmentData, MailReply } from '../../shared/mail';
import { MAIL_ATTACHMENT_URL } from '../../shared/mail';
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

export function handleMailScheme(fetchAttachment: FetchAttachment): void {
  protocol.handle(MAIL_SCHEME, async (req) => {
    if (req.method !== 'GET') return new Response(null, { status: 405 });
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
