import { create } from '@bufbuild/protobuf';
import { DiskItemSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../lib/disk';
import { ApiError } from '../lib/api/client';
import { uploadInto } from '../lib/api/endpoints';
import { limitWaitMs, onDiskItemRemove, onDiskItemUpsert, uploadErrorText, uploadFiles } from '../services/disk';
import { useDisk, useDiskUploads } from './disk';
import { useDiskUi } from './diskUi';
import { useUi } from './ui';

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
vi.mock('../components/Confirm', () => ({ confirmAction: vi.fn() }));
vi.mock('../lib/api/endpoints', async (orig) => ({ ...(await orig<typeof import('../lib/api/endpoints')>()), uploadInto: vi.fn() }));

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

  it('a 429 of the upload limit waits for Retry-After and sends the file again (ADR-0155)', async () => {
    vi.useFakeTimers();
    try {
      const ok = item('f');
      vi.mocked(uploadInto)
        .mockReturnValueOnce({ promise: Promise.reject(new ApiError('ERROR_CODE_RATE_LIMITED', 'slow down', 429, undefined, { retryAfter: 7 })), abort: () => undefined })
        .mockReturnValueOnce({ promise: Promise.resolve(ok), abort: () => undefined });
      uploadFiles('w', '', [new File(['x'], 'a.txt')]);
      await vi.advanceTimersByTimeAsync(0);
      const id = useDiskUploads.getState().order[0] ?? '';
      expect(useDiskUploads.getState().byId[id]?.waiting).toBe(true);
      expect(useDiskUploads.getState().byId[id]?.error).toBeNull();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(uploadInto).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_600);
      expect(uploadInto).toHaveBeenCalledTimes(2);
      expect(useDiskUploads.getState().order).toEqual([]);
      expect(useDisk.getState().items['f']?.name).toBe('f');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the wait after a 429 follows Retry-After within 1 s .. 1 h, 30 s without it', () => {
    expect(limitWaitMs(7, 0)).toBe(7_000);
    expect(limitWaitMs(undefined, 0)).toBe(30_000);
    expect(limitWaitMs(99_999, 0)).toBe(3_600_000);
    expect(limitWaitMs(7, 1)).toBe(7_500);
  });

  it('413 FILE_TOO_LARGE names the limit', () => {
    expect(uploadErrorText(new ApiError('ERROR_CODE_FILE_TOO_LARGE', 'file exceeds 1024 MB', 413, undefined, { limit: 1 << 30 }))).toBe('Больше лимита 1,00 ГБ на файл');
    // An administrator's limit is the hard cap (ADR-0164): the row names the uploader's own limit from the API.
    expect(uploadErrorText(new ApiError('ERROR_CODE_FILE_TOO_LARGE', 'file exceeds 4096 MB', 413, undefined, { limit: 4096 * 2 ** 20 }))).toBe('Больше лимита 4,00 ГБ на файл');
    expect(uploadErrorText(new ApiError('ERROR_CODE_UNSPECIFIED', 'Request Entity Too Large', 413))).not.toBe('');
  });
});

