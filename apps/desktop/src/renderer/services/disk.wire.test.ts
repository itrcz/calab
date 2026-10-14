import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  DiskActivityKind,
  DiskActivityPageSchema,
  DiskItemKind,
  DiskItemResponseSchema,
  DiskLinkResponseSchema,
  DiskPathResponseSchema,
  DiskPermissionsResponseSchema,
  DiskSettingsSchema,
  DiskUsageSchema,
  ListDiskItemsResponseSchema,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { describeActivity } from '../lib/disk';

/**
 * Responses captured from the real Go server (task D6, tools/disk-walk.sh stack): the client's
 * schemas must read them as they are, without fallbacks.
 */
const files = import.meta.glob('./__fixtures__/disk/*.json', { eager: true, import: 'default' });
const read = (name: string): JsonValue => files[`./__fixtures__/disk/${name}.json`] as JsonValue;

describe('Disk wire format of the server', () => {
  it('reads an upload and a listing', () => {
    const up = fromJson(DiskItemResponseSchema, read('upload')).item;
    expect(up?.kind).toBe(DiskItemKind.FILE);
    expect(up?.file?.size).toBe(5n);
    expect(up?.myBits).toBeGreaterThan(0n);
    const list = fromJson(ListDiskItemsResponseSchema, read('list-root'));
    expect(list.items[0]?.kind).toBe(DiskItemKind.FOLDER);
    expect(list.nextCursor).toBe('');
  });

  it('reads the trash, the path, the link, the access and the usage', () => {
    expect(fromJson(ListDiskItemsResponseSchema, read('trashed')).items[0]?.trashedRoot).toBe(true);
    expect(fromJson(DiskPathResponseSchema, read('path')).items.length).toBeGreaterThan(0);
    expect(fromJson(DiskLinkResponseSchema, read('link')).link?.code).toHaveLength(43);
    expect(fromJson(DiskPermissionsResponseSchema, read('perms-put')).restricted).toBe(true);
    expect(fromJson(DiskUsageSchema, read('usage')).diskBytes).toBe(5n);
  });

  it('reads DiskSettings as {trashDays}', () => {
    expect(fromJson(DiskSettingsSchema, read('settings')).trashDays).toBe(30);
  });

  it('describes the journal from the real snapshots', () => {
    const page = fromJson(DiskActivityPageSchema, read('activity'));
    const move = page.activities.find((a) => a.kind === DiskActivityKind.MOVE);
    expect(move && describeActivity(move)).toEqual({ key: 'disk.act.move', params: { name: 'f.txt', to: 'Other' } });
    const upload = page.activities.find((a) => a.kind === DiskActivityKind.UPLOAD);
    expect(upload && describeActivity(upload)).toEqual({ key: 'disk.act.upload', params: { name: 'f.txt' } });
  });
});
