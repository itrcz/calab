import { PublicWikiPageSchema } from '@calaba/protocol';
import { call, callBytes, qs } from '../lib/api/client';

/**
 * The public wiki page `/w/{code}` (ADR-0096 §6): anonymous reads of `GET /api/public/wiki/{code}`
 * (meta and the visible outline), `…/state` (the document: lib/wiki/publicState) and `…/files/{id}`
 * (pictures). No sockets, no auth; `page` picks a subpage of the linked branch.
 */
const base = (code: string): string => `/api/public/wiki/${encodeURIComponent(code)}`;

export const wikiPublic = {
  page: (code: string, page?: string, signal?: AbortSignal) => call('GET', `${base(code)}${qs({ page })}`, PublicWikiPageSchema, undefined, signal),
  state: (code: string, page?: string, signal?: AbortSignal): Promise<Uint8Array> => callBytes(`${base(code)}/state${qs({ page })}`, signal),
  filePath: (code: string, fileId: string): string => `${base(code)}/files/${encodeURIComponent(fileId)}`,
};

/** The code of a `/w/{code}` page in the web build (null elsewhere). */
export const wikiPageCode = (): string | null =>
  import.meta.env.VITE_PLATFORM === 'web' ? (/^\/w\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null) : null;
