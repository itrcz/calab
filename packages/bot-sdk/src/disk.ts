// The Disk (ADR-0094; bots like members since the §2 addendum of 2026-10-14): a bot works within
// the disk bits of its roles and the items' overrides, exactly like a person.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  CreateDiskFolderRequestSchema,
  CreateDiskLinkRequestSchema,
  DiskActivityPageSchema,
  DiskItemResponseSchema,
  DiskLinkResponseSchema,
  DiskPathResponseSchema,
  DiskPermissionsResponseSchema,
  DiskSettingsSchema,
  DiskUsageSchema,
  EmptyDiskTrashResponseSchema,
  ListDiskItemsResponseSchema,
  UpdateDiskItemRequestSchema,
  UpdateDiskPermissionsRequestSchema,
  type DiskItem,
  type DiskLinkResponse,
  type DiskPermissionEntry,
  type DiskPermissionsResponse,
  type ListDiskItemsResponse,
} from '@calaba/protocol';
import { Rest } from './rest.js';

const enc = encodeURIComponent;

/** File bytes, or a local path (read from disk; its base name is the default name). */
export type DiskUploadData = Uint8Array | ArrayBuffer | Blob | string;

export interface DiskListOptions {
  /** Folder id; omitted = the root. */
  parentId?: string;
  /** The trash (its roots) instead of a folder. */
  trashed?: boolean;
  /** next_cursor of the previous page. */
  cursor?: string;
  limit?: number;
  sort?: string;
}

/** A download: the item and its bytes as a stream (read it once). */
export interface DiskDownload {
  item: DiskItem;
  name: string;
  mime: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

const item = (r: { item?: DiskItem | undefined }): DiskItem => {
  if (!r.item) throw new Error('empty item in the response');
  return r.item;
};

function toBlob(data: Uint8Array | ArrayBuffer | Blob, type?: string): Blob {
  if (data instanceof Blob) return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], type ? { type } : {});
}

export function createDiskApi(rest: Rest) {
  const itemPath = (id: string): string => `/api/disk/items/${enc(id)}`;
  const update = async (id: string, req: MessageInitShape<typeof UpdateDiskItemRequestSchema>): Promise<DiskItem> =>
    item(await rest.call(DiskItemResponseSchema, 'PATCH', itemPath(id), { json: Rest.body(UpdateDiskItemRequestSchema, req) }));
  return {
    /** Items of a folder (or the trash) the bot sees, folders first; one page (see `next_cursor`). */
    list: (workspaceId: string, o: DiskListOptions = {}): Promise<ListDiskItemsResponse> =>
      rest.call(ListDiskItemsResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/disk/items`, {
        query: { parent: o.parentId, trashed: o.trashed ? 1 : undefined, cursor: o.cursor, limit: o.limit, sort: o.sort },
      }),
    get: async (itemId: string): Promise<DiskItem> => item(await rest.call(DiskItemResponseSchema, 'GET', itemPath(itemId))),
    /** The folders from the root down to the item. */
    path: async (itemId: string): Promise<DiskItem[]> => (await rest.call(DiskPathResponseSchema, 'GET', `${itemPath(itemId)}/path`)).items,
    /** A folder (DISK_WRITE on the parent; omitted parent = the root). A taken name gets « (2)». */
    createFolder: async (workspaceId: string, name: string, parentId?: string): Promise<DiskItem> =>
      item(
        await rest.call(DiskItemResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/disk/folders`, {
          json: Rest.body(CreateDiskFolderRequestSchema, { name, parentId: parentId ?? '' }),
        }),
      ),
    /** Uploads a file into a folder (DISK_WRITE; counts toward the workspace's storage). */
    upload: async (workspaceId: string, data: DiskUploadData, name?: string, parentId?: string, type?: string): Promise<DiskItem> => {
      const bytes = typeof data === 'string' ? await readFile(data) : data;
      const fileName = name ?? (typeof data === 'string' ? basename(data) : 'file');
      return item(
        await rest.call(DiskItemResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/disk/upload`, {
          query: { parent: parentId },
          form: () => {
            const f = new FormData();
            f.append('file', toBlob(bytes, type), fileName);
            return f;
          },
        }),
      );
    },
    /** The file's bytes as a stream (DISK_VIEW). */
    download: async (itemId: string): Promise<DiskDownload> => {
      const it = item(await rest.call(DiskItemResponseSchema, 'GET', itemPath(itemId)));
      if (!it.file) throw new Error('not a file');
      const res = await rest.response('GET', `/api/files/${enc(it.file.id)}`);
      if (!res.body) throw new Error('empty file body');
      return { item: it, name: it.name, mime: it.file.mime, size: Number(it.file.size), stream: res.body };
    },
    /** Renames (the owner or DISK_MANAGE). */
    rename: (itemId: string, name: string): Promise<DiskItem> => update(itemId, { name }),
    /** Moves into a folder ('' = the root); needs DISK_WRITE there. */
    move: (itemId: string, parentId: string): Promise<DiskItem> => update(itemId, { parentId }),
    /** The «Только выбранные» switch (the owner or DISK_MANAGE). */
    setRestricted: (itemId: string, restricted: boolean): Promise<DiskItem> => update(itemId, { restricted }),
    trash: async (itemId: string): Promise<DiskItem> => item(await rest.call(DiskItemResponseSchema, 'POST', `${itemPath(itemId)}/trash`)),
    restore: async (itemId: string): Promise<DiskItem> => item(await rest.call(DiskItemResponseSchema, 'POST', `${itemPath(itemId)}/restore`)),
    /** Deletes a trashed item forever. */
    delete: async (itemId: string): Promise<void> => {
      await rest.request('DELETE', itemPath(itemId));
    },
    /** Empties the trash: the bot's own items, or everyone's with DISK_MANAGE. */
    emptyTrash: (workspaceId: string) => rest.call(EmptyDiskTrashResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/disk/trash/empty`),
    /** The item's overrides and its «Только выбранные» flag. */
    permissions: (itemId: string): Promise<DiskPermissionsResponse> => rest.call(DiskPermissionsResponseSchema, 'GET', `${itemPath(itemId)}/permissions`),
    /**
     * Replaces the item's overrides (the owner or DISK_MANAGE): «Просмотр» = DISK_BITS.VIEW,
     * «Правка» = DISK_BITS.VIEW | DISK_BITS.WRITE; `restricted` omitted = unchanged.
     */
    share: (itemId: string, entries: MessageInitShape<typeof UpdateDiskPermissionsRequestSchema>['entries'], restricted?: boolean): Promise<DiskPermissionsResponse> =>
      rest.call(DiskPermissionsResponseSchema, 'PUT', `${itemPath(itemId)}/permissions`, {
        json: Rest.body(UpdateDiskPermissionsRequestSchema, { entries: entries ?? [], ...(restricted !== undefined ? { restricted } : {}) }),
      }),
    /** The public link of a file (anyone with the URL downloads it). */
    link: {
      on: (itemId: string, expiresAt?: Date): Promise<DiskLinkResponse> =>
        rest.call(DiskLinkResponseSchema, 'POST', `${itemPath(itemId)}/link`, {
          json: Rest.body(CreateDiskLinkRequestSchema, expiresAt ? { expiresAt: { seconds: BigInt(Math.floor(expiresAt.getTime() / 1000)), nanos: 0 } } : {}),
        }),
      off: async (itemId: string): Promise<void> => {
        await rest.request('DELETE', `${itemPath(itemId)}/link`);
      },
    },
    /** The item's history (DISK_VIEW). */
    activity: (itemId: string, cursor?: string) => rest.call(DiskActivityPageSchema, 'GET', `${itemPath(itemId)}/activity`, { query: { cursor } }),
    usage: (workspaceId: string) => rest.call(DiskUsageSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/disk/usage`),
    settings: (workspaceId: string) => rest.call(DiskSettingsSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/disk/settings`),
  };
}

export type DiskApi = ReturnType<typeof createDiskApi>;
export type { DiskPermissionEntry };
