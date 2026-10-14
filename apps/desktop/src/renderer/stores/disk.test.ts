import { create } from '@bufbuild/protobuf';
import { DiskItemSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../lib/disk';
import { onDiskItemRemove, onDiskItemUpsert } from '../services/disk';
import { useDisk, useDiskUploads } from './disk';
import { useDiskUi } from './diskUi';
import { useUi } from './ui';

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
vi.mock('../components/Confirm', () => ({ confirmAction: vi.fn() }));

const item = (id: string, parentId = '') => create(DiskItemSchema, { id, workspaceId: 'w', parentId, name: id });

describe('disk store', () => {
  beforeEach(() => {
    useDisk.setState({ items: {}, lists: {}, load: {}, usage: {}, paths: {} });
    useDiskUploads.setState({ byId: {}, order: [] });
    useDiskUi.setState({ active: false, folderOf: {}, trashOf: {} });
  });

  it('upload progress is stored at whole percents only', () => {
    const s = useDiskUploads.getState();
    s.add({ id: 'u', wsId: 'w', parentId: '', name: 'a', progress: 0, error: null, abort: () => undefined });
    const before = useDiskUploads.getState().byId;
    s.progress('u', 0.001);
    expect(useDiskUploads.getState().byId).toBe(before);
    s.progress('u', 0.42);
    expect(useDiskUploads.getState().byId['u']?.progress).toBe(0.42);
    s.done('u');
    expect(useDiskUploads.getState().order).toEqual([]);
  });

  it('an event for a hidden section drops its stale listings instead of applying', () => {
    useDisk.getState().setListing(folderKey('w', ''), [item('a')]);
    onDiskItemUpsert({ workspaceId: 'w', item: item('b') } as never);
    expect(useDisk.getState().lists[folderKey('w', '')]).toBeUndefined();
  });

  it('a removed folder that is open (or an ancestor of it) sends the view to the root', () => {
    useUi.setState({ activeWorkspaceId: 'w' });
    useDiskUi.setState({ folderOf: { w: 'c' } });
    useDisk.getState().setPath('c', [item('p'), item('c', 'p')]);
    onDiskItemRemove({ workspaceId: 'w', itemId: 'p', parentId: '' } as never);
    expect(useDiskUi.getState().folderOf['w']).toBe('');
    expect(useDisk.getState().items['p']).toBeUndefined();
  });
});
