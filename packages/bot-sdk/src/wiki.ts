// The Wiki (ADR-0096; bots like members since the §2 addendum of 2026-10-14): pages over REST,
// their content over the sync socket as Markdown (@calaba/wiki-doc: the editor's schema, the
// Markdown bridge and the Yjs binding the desktop editor uses).
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  CreateWikiLinkRequestSchema,
  CreateWikiPageRequestSchema,
  EmptyWikiTrashResponseSchema,
  ListWikiPagesResponseSchema,
  UpdateWikiPageRequestSchema,
  UpdateWikiPermissionsRequestSchema,
  UploadFileResponseSchema,
  WikiActivityPageSchema,
  WikiLinkResponseSchema,
  WikiPageResponseSchema,
  WikiPathResponseSchema,
  WikiPermissionsResponseSchema,
  WikiSettingsSchema,
  WikiVersionsResponseSchema,
  type FileMeta,
  type ListWikiPagesResponse,
  type WikiLinkResponse,
  type WikiPage,
  type WikiPermissionsResponse,
  type WikiVersionsResponse,
} from '@calaba/protocol';
import { docMeta } from '@calaba/wiki-doc/plainText';
import { appendDocMarkdown, docToMarkdown, setDocMarkdown } from '@calaba/wiki-doc/ydoc';
import type { FromMarkdownOptions, ToMarkdownOptions } from '@calaba/wiki-doc/markdown';
import * as Y from 'yjs';
import { Rest } from './rest.js';
import { WikiSyncSession, wikiSyncUrl, type SyncSocket, type WikiSyncOptions } from './wikiSync.js';

const enc = encodeURIComponent;

export interface WikiListOptions {
  /** Parent page id; omitted = the top level. */
  parentId?: string;
  /** The trash (its roots) instead of a level. */
  trashed?: boolean;
  cursor?: string;
  limit?: number;
}

export interface WikiWriteOptions {
  /** Also set the page's title (posted with the content, as the editor does); omitted = unchanged. */
  title?: string;
  /** Label stored with an `@<user id>` mention. */
  mentionLabel?: FromMarkdownOptions['mentionLabel'];
}

export interface WikiPageContent {
  title: string;
  markdown: string;
}

/** One page's content: each call opens the sync socket, does its work and closes it. */
export interface WikiPageHandle {
  /** The page's title (REST) and its content as Markdown (the sync socket; WIKI_VIEW). */
  read(opts?: ToMarkdownOptions): Promise<WikiPageContent>;
  /** Replaces the content with Markdown (WIKI_WRITE). Unchanged blocks keep their identity, so co-authors' cursors survive. */
  write(markdown: string, opts?: WikiWriteOptions): Promise<void>;
  /** Appends Markdown blocks at the end (WIKI_WRITE). */
  append(markdown: string, opts?: WikiWriteOptions): Promise<void>;
}

const page = (r: { page?: WikiPage | undefined }): WikiPage => {
  if (!r.page) throw new Error('empty page in the response');
  return r.page;
};

function toBlob(data: Uint8Array | ArrayBuffer | Blob, type?: string): Blob {
  if (data instanceof Blob) return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], type ? { type } : {});
}

export function createWikiApi(rest: Rest, token: string, createSocket: (url: string) => SyncSocket, syncOpts: WikiSyncOptions = {}) {
  const pagePath = (id: string): string => `/api/wiki/pages/${enc(id)}`;
  const update = async (id: string, req: MessageInitShape<typeof UpdateWikiPageRequestSchema>): Promise<WikiPage> =>
    page(await rest.call(WikiPageResponseSchema, 'PATCH', pagePath(id), { json: Rest.body(UpdateWikiPageRequestSchema, req) }));
  const get = async (id: string): Promise<WikiPage> => page(await rest.call(WikiPageResponseSchema, 'GET', pagePath(id)));
  const open = (id: string): Promise<WikiSyncSession> => WikiSyncSession.open(wikiSyncUrl(rest.server, id), token, syncOpts.createSocket ?? createSocket, syncOpts);

  const write = async (id: string, change: (doc: Y.Doc) => void, opts: WikiWriteOptions): Promise<void> => {
    const s = await open(id);
    try {
      const title = opts.title?.trim() ?? '';
      await s.write(change, (doc) => ({ ...docMeta(doc), title }));
    } finally {
      await s.close();
    }
  };

  const handle = (id: string): WikiPageHandle => ({
    read: async (opts = {}) => {
      const p = await get(id);
      const s = await open(id);
      try {
        return { title: p.title, markdown: docToMarkdown(s.doc, opts) };
      } finally {
        await s.close();
      }
    },
    write: (markdown, opts = {}) =>
      write(id, (doc) => {
        setDocMarkdown(doc, markdown, mdOpts(opts));
      }, opts),
    append: (markdown, opts = {}) =>
      write(id, (doc) => {
        appendDocMarkdown(doc, markdown, mdOpts(opts));
      }, opts),
  });

  return {
    pages: {
      /** Pages of a level (or the trash) the bot sees, by position; one page (see `next_cursor`). */
      list: (workspaceId: string, o: WikiListOptions = {}): Promise<ListWikiPagesResponse> =>
        rest.call(ListWikiPagesResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/wiki/pages`, {
          query: { parent: o.parentId, trashed: o.trashed ? 1 : undefined, cursor: o.cursor, limit: o.limit },
        }),
      get,
      /** The pages from the top level down to this one. */
      path: async (pageId: string): Promise<WikiPage[]> => (await rest.call(WikiPathResponseSchema, 'GET', `${pagePath(pageId)}/path`)).pages,
      /** A page (WIKI_WRITE on the parent, or in the workspace for a top-level page). */
      create: async (workspaceId: string, p: { title?: string; parentId?: string; icon?: string } = {}): Promise<WikiPage> =>
        page(
          await rest.call(WikiPageResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/wiki/pages`, {
            json: Rest.body(CreateWikiPageRequestSchema, { title: p.title ?? '', parentId: p.parentId ?? '', icon: p.icon ?? '' }),
          }),
        ),
      /** Title, icon, cover, the restricted switch (the owner or WIKI_MANAGE). */
      update,
      /** Moves under another page ('' = the top level) at a position. */
      move: (pageId: string, parentId: string, position?: number): Promise<WikiPage> =>
        update(pageId, { parentId, ...(position !== undefined ? { position } : {}) }),
      trash: async (pageId: string): Promise<WikiPage> => page(await rest.call(WikiPageResponseSchema, 'POST', `${pagePath(pageId)}/trash`)),
      restore: async (pageId: string): Promise<WikiPage> => page(await rest.call(WikiPageResponseSchema, 'POST', `${pagePath(pageId)}/restore`)),
      /** Deletes a trashed page forever. */
      delete: async (pageId: string): Promise<void> => {
        await rest.request('DELETE', pagePath(pageId));
      },
      emptyTrash: (workspaceId: string) => rest.call(EmptyWikiTrashResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/wiki/trash/empty`),
      activity: (pageId: string, cursor?: string) => rest.call(WikiActivityPageSchema, 'GET', `${pagePath(pageId)}/activity`, { query: { cursor } }),
    },
    permissions: {
      get: (pageId: string): Promise<WikiPermissionsResponse> => rest.call(WikiPermissionsResponseSchema, 'GET', `${pagePath(pageId)}/permissions`),
      /** Replaces the page's overrides (the owner or WIKI_MANAGE): VIEW = WIKI_BITS.VIEW, edit = VIEW | WRITE. */
      set: (pageId: string, entries: MessageInitShape<typeof UpdateWikiPermissionsRequestSchema>['entries'], restricted?: boolean): Promise<WikiPermissionsResponse> =>
        rest.call(WikiPermissionsResponseSchema, 'PUT', `${pagePath(pageId)}/permissions`, {
          json: Rest.body(UpdateWikiPermissionsRequestSchema, { entries: entries ?? [], ...(restricted !== undefined ? { restricted } : {}) }),
        }),
    },
    /** The public read-only link of a page (and optionally its subpages). */
    link: {
      on: (pageId: string, o: { expiresAt?: Date; includeChildren?: boolean } = {}): Promise<WikiLinkResponse> =>
        rest.call(WikiLinkResponseSchema, 'POST', `${pagePath(pageId)}/link`, {
          json: Rest.body(CreateWikiLinkRequestSchema, {
            includeChildren: o.includeChildren ?? false,
            ...(o.expiresAt ? { expiresAt: { seconds: BigInt(Math.floor(o.expiresAt.getTime() / 1000)), nanos: 0 } } : {}),
          }),
        }),
      off: async (pageId: string): Promise<void> => {
        await rest.request('DELETE', `${pagePath(pageId)}/link`);
      },
    },
    versions: {
      list: (pageId: string, cursor?: string): Promise<WikiVersionsResponse> =>
        rest.call(WikiVersionsResponseSchema, 'GET', `${pagePath(pageId)}/versions`, { query: { cursor } }),
      /** A version's content as Markdown. */
      read: async (pageId: string, versionId: string, opts: ToMarkdownOptions = {}): Promise<string> => {
        const res = await rest.response('GET', `${pagePath(pageId)}/versions/${enc(versionId)}`);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
        return docToMarkdown(doc, opts);
      },
    },
    files: {
      /** A picture or attachment of the page (WIKI_WRITE); returns the file (its id goes into an image block). */
      upload: async (pageId: string, file: { name: string; data: Uint8Array | ArrayBuffer | Blob; type?: string }): Promise<FileMeta> => {
        const r = await rest.call(UploadFileResponseSchema, 'POST', `${pagePath(pageId)}/files`, {
          form: () => {
            const f = new FormData();
            f.append('file', toBlob(file.data, file.type), file.name);
            return f;
          },
        });
        if (!r.file) throw new Error('empty file in the response');
        return r.file;
      },
    },
    settings: (workspaceId: string) => rest.call(WikiSettingsSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/wiki/settings`),
    /** A page's content as Markdown: `read()`, `write(md)`, `append(md)`. */
    page: handle,
  };
}

const mdOpts = (o: WikiWriteOptions): FromMarkdownOptions => (o.mentionLabel ? { mentionLabel: o.mentionLabel } : {});

export type WikiApi = ReturnType<typeof createWikiApi>;
