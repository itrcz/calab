import { describe, expect, it } from 'vitest';
import { isUploading, MAX_TASK_FILES, readyIds, roomLeft, type PendingFile } from './pendingFiles';

const f = (key: string, p: Partial<PendingFile> = {}): PendingFile => ({ key, name: key, id: '', progress: 0, failed: false, ...p });

describe('pendingFiles', () => {
  it('takes only finished uploads, in order', () => {
    expect(readyIds([f('a', { id: 'A' }), f('b'), f('c', { id: 'C' }), f('d', { failed: true })])).toEqual(['A', 'C']);
  });
  it('is uploading while any file has no id and has not failed', () => {
    expect(isUploading([f('a', { id: 'A' })])).toBe(false);
    expect(isUploading([f('a', { id: 'A' }), f('b')])).toBe(true);
    expect(isUploading([f('b', { failed: true })])).toBe(false);
  });
  it('caps at 20, failed files free their slot', () => {
    const all = Array.from({ length: MAX_TASK_FILES }, (_, i) => f(String(i), { id: String(i) }));
    expect(roomLeft(all)).toBe(0);
    expect(roomLeft([...all.slice(1), f('x', { failed: true })])).toBe(1);
  });
});
