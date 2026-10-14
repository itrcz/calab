import { create } from '@bufbuild/protobuf';
import { DiskItemKind, DiskItemSchema, ListDiskItemsResponseSchema } from '@calaba/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../lib/disk';
import { useDisk } from '../stores/disk';
import { diskApi, loadListing } from './disk';

vi.mock('../platform', () => ({ platform: { kind: 'web' } }));

const item = (id: string) => create(DiskItemSchema, { id, workspaceId: 'w1', kind: DiskItemKind.FILE, name: id });

describe('disk listing paging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows next_cursor until the last page', async () => {
    const list = vi
      .spyOn(diskApi, 'list')
      .mockResolvedValueOnce(create(ListDiskItemsResponseSchema, { items: [item('a'), item('b')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(create(ListDiskItemsResponseSchema, { items: [item('c')] }));
    await loadListing('w1', '', false);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[1]).not.toHaveProperty('cursor');
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c1' });
    expect(useDisk.getState().lists[folderKey('w1', '')]).toEqual(['a', 'b', 'c']);
  });
});
