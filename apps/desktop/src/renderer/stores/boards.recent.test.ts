import { create } from '@bufbuild/protobuf';
import { TaskNoticeKind, TaskSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unreadReason } from '../services/boards';
import { RECENT_LIMIT, recentIds, useBoards, type LastNotice, type RecentEntry } from './boards';

vi.mock('../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

/** «Недавние» (CBF-179): the server's list, one row per task, a live notice moves its task to the top. */
const notice = (at: number, kind = TaskNoticeKind.APPROVED): LastNotice => ({ kind, actorId: '', text: '', reRequested: false, dueOn: '', daysLeft: 0, at });
const entry = (id: string, at: number): RecentEntry => ({ taskId: id, ref: { workspaceId: 'w1', key: `K-${id}`, title: `T ${id}`, boardId: 'b1' }, notice: notice(at) });

describe('recent tasks', () => {
  beforeEach(() => useBoards.getState().reset());

  it('is null until loaded, then the server order; a bump of a listed task moves it, once', () => {
    const s = useBoards.getState();
    expect(recentIds(s, 'w1')).toBeNull();
    s.bumpRecent('w1', 'x', { workspaceId: 'w1', key: 'K-x', title: 'x', boardId: 'b1' }); // not loaded: the load brings it
    expect(recentIds(useBoards.getState(), 'w1')).toBeNull();
    s.setRecent('w1', [entry('a', 300), entry('b', 200), entry('c', 100)]);
    expect(recentIds(useBoards.getState(), 'w1')).toEqual(['a', 'b', 'c']);
    s.bumpRecent('w1', 'c', { workspaceId: 'w1', key: 'K-c', title: 'renamed', boardId: 'b1' });
    expect(recentIds(useBoards.getState(), 'w1')).toEqual(['c', 'a', 'b']);
    expect(useBoards.getState().recentRefs.c?.title).toBe('renamed');
    const before = recentIds(useBoards.getState(), 'w1');
    s.bumpRecent('w1', 'c', { workspaceId: 'w1', key: 'K-c', title: 'renamed', boardId: 'b1' }); // already on top: same list
    expect(recentIds(useBoards.getState(), 'w1')).toBe(before);
    s.dropRecent('a');
    expect(recentIds(useBoards.getState(), 'w1')).toEqual(['c', 'b']);
  });

  it('keeps at most the limit', () => {
    const s = useBoards.getState();
    s.setRecent('w1', Array.from({ length: RECENT_LIMIT }, (_, i) => entry(`t${i}`, 1000 - i)));
    s.bumpRecent('w1', 'new', { workspaceId: 'w1', key: 'K-new', title: 'new', boardId: 'b1' });
    const ids = recentIds(useBoards.getState(), 'w1') ?? [];
    expect(ids).toHaveLength(RECENT_LIMIT);
    expect(ids[0]).toBe('new');
    expect(ids).not.toContain(`t${RECENT_LIMIT - 1}`);
  });

  it('gives the unread reason after a reload; a newer live notice wins', () => {
    const s = useBoards.getState();
    s.upsertTask(create(TaskSchema, { id: 'a', boardId: 'b1', workspaceId: 'w1', key: 'K-a', title: 'A' }));
    expect(unreadReason(useBoards.getState(), 'a')).toBe('');
    s.setNotice('a', notice(500, TaskNoticeKind.APPROVAL_REQUESTED));
    s.setRecent('w1', [entry('a', 300)]); // older than the live one: kept
    expect(useBoards.getState().notices.a?.at).toBe(500);
    s.setRecent('w1', [entry('a', 900)]);
    expect(useBoards.getState().notices.a?.kind).toBe(TaskNoticeKind.APPROVED);
    expect(unreadReason(useBoards.getState(), 'a')).not.toBe('');
  });

  it('keeps on top a task whose live notice is newer than the loaded list', () => {
    const s = useBoards.getState();
    s.setRecent('w1', [entry('a', 100)]);
    s.setNotice('z', notice(999));
    s.bumpRecent('w1', 'z', { workspaceId: 'w1', key: 'K-z', title: 'z', boardId: 'b1' });
    s.setRecent('w1', [entry('b', 200), entry('a', 100)], 900); // a response that left before z's notice
    expect(recentIds(useBoards.getState(), 'w1')).toEqual(['z', 'b', 'a']);
    s.setRecent('w1', [], 1000); // a later empty answer: nothing came live since
    expect(recentIds(useBoards.getState(), 'w1')).toEqual([]);
  });
});
