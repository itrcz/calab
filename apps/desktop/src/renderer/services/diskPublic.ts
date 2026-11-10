import { OfficeConfigResponseSchema, PublicDiskFileSchema, PublicDiskFolderSchema, UnlockDiskLinkRequestSchema } from '@calaba/protocol';
import { body, call, callEmpty, qs } from '../lib/api/client';
import { platform } from '../platform';

/**
 * The public Disk link `/d/{code}` (ADR-0094 §3, ADR-0165): anonymous reads of
 * `GET /api/public/disk/{code}` (the linked file or folder), `…/items?parent=` (a folder of the
 * link, read-only), the bytes and thumbnails of a file (`…/content` for a file link,
 * `…/items/{id}/content` inside a folder link), «Скачать всё» (`…/archive?parent=`) and the
 * office viewer's view-only configuration (`…/office?item=`). No auth, no sockets. A link with a
 * password (ADR-0167) is opened by `unlock`: the server sets an HttpOnly cookie scoped to the
 * link's path, which every later request of the page (fetches, <img>, <video>) carries.
 */
const base = (code: string): string => `/api/public/disk/${encodeURIComponent(code)}`;

/** The item a path points at: the linked file itself (`''`) or a file inside a folder link. */
const of = (code: string, itemId: string): string => (itemId ? `${base(code)}/items/${encodeURIComponent(itemId)}` : base(code));

export const diskPublic = {
  meta: (code: string, signal?: AbortSignal) => call('GET', base(code), PublicDiskFileSchema, undefined, signal),
  /** 204 + the unlock cookie; a wrong password is 403 LINK_PASSWORD_REQUIRED, too many tries 429. */
  unlock: (code: string, password: string) => callEmpty('POST', `${base(code)}/unlock`, body(UnlockDiskLinkRequestSchema, { password })),
  folder: (code: string, parent: string, cursor: string, signal?: AbortSignal) =>
    call('GET', `${base(code)}/items${qs({ parent, cursor })}`, PublicDiskFolderSchema, undefined, signal),
  office: (code: string, itemId: string, p: { theme: 'dark' | 'light'; phone: boolean; lang: string }, signal?: AbortSignal) =>
    call('GET', `${base(code)}/office${qs({ item: itemId, theme: p.theme, phone: p.phone ? 1 : undefined, lang: p.lang })}`, OfficeConfigResponseSchema, undefined, signal),
  /** API paths (for MediaImg and fetches). */
  contentPath: (code: string, itemId: string): string => `${of(code, itemId)}/content`,
  thumbPath: (code: string, itemId: string, w: 512 | 1024 = 512): string => `${of(code, itemId)}/thumbnail?w=${w}`,
  /** Absolute URLs (a download link, a <video>/<audio> source). */
  contentUrl: (code: string, itemId: string): string => `${platform.apiBase}${of(code, itemId)}/content`,
  archiveUrl: (code: string, parent: string): string => `${platform.apiBase}${base(code)}/archive${qs({ parent })}`,
  /** Whether «Скачать всё» fits (`ok`), is over the ceiling (`large`) or asked too often (`busy`); a network failure says ok. */
  archiveCheck: async (code: string, parent: string): Promise<'ok' | 'large' | 'busy' | 'gone'> => {
    try {
      // same-origin: the unlock cookie of a protected link goes along (ADR-0167).
      const res = await fetch(`${platform.apiBase}${base(code)}/archive${qs({ parent, check: 1 })}`, { cache: 'no-store', credentials: 'same-origin' });
      return res.status === 413 ? 'large' : res.status === 429 ? 'busy' : res.status === 404 ? 'gone' : 'ok';
    } catch {
      return 'ok';
    }
  },
};

/** The code of a `/d/{code}` page in the web build (null elsewhere). */
export const diskPageCode = (): string | null =>
  import.meta.env.VITE_PLATFORM === 'web' ? (/^\/d\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null) : null;

/** Starts a download of an absolute URL (the server answers `Content-Disposition: attachment`). */
export function downloadUrl(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
