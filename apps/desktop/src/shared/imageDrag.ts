import { safeFileName } from './fileName';

/**
 * Dragging a chat image out of the app into Finder / Explorer / the desktop (docs/01 «Файлы» п. 5).
 * Pure helpers shared by main (main/dragOut.ts: the Electron path, `webContents.startDrag`) and
 * the renderer (the web path, Chromium's `DownloadURL` drag type), unit-tested.
 */

/** An attachment id as the API issues it (UUID). Anything else never reaches a URL. */
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFileId(v: unknown): v is string {
  return typeof v === 'string' && FILE_ID.test(v);
}

/**
 * Upper bound of a file fetched for a drag. Images only, and the server's own upload limit
 * (MAX_FILE_SIZE_MB, 50 MB by default) is far below it; this only stops a runaway body.
 */
export const DRAG_MAX_BYTES = 512 * 1024 * 1024;

/** The response is a picture (`image/png`, `image/heic`…): only those are written for a drag. */
export function isImageContentType(ct: string | null | undefined): boolean {
  const mime = (ct ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^image\/[a-z0-9.+-]+$/.test(mime);
}

const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

/**
 * The value of Chromium's `DownloadURL` drag type: `mime:filename:url`. The first two colons are
 * the separators, so the name must not contain one (safeFileName turns `:` into `_`) and the
 * MIME type must be a plain `type/subtype`. Only an absolute `blob:` URL of this page (the web
 * client's authenticated media cache) or an http(s) URL is accepted; null otherwise.
 */
export function downloadUrlData(mime: string | undefined, name: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'blob:' && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const type = mime && MIME.test(mime.trim()) ? mime.trim().toLowerCase() : 'application/octet-stream';
  return `${type}:${safeFileName(name)}:${url}`;
}
