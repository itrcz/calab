import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskActivitySchema, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_DATA, appendActivity, removeTask, setBoardTasks, upsertTask, type BoardsData } from './reducers';

const task = (id: string, statusId: string, position: number, p: MessageInitShape<typeof TaskSchema> = {}): Task =>
  create(TaskSchema, { id, boardId: 'b1', workspaceId: 'w1', statusId, position, key: `CAL-${id}`, title: id, roomId: `r-${id}`, ...p });

function loaded(): BoardsData {
  return { ...EMPTY_DATA, ...setBoardTasks(EMPTY_DATA, 'b1', [task('a', 's1', 1024), task('b', 's1', 2048), task('c', 's2', 1024)]) };
}

describe('board reducers', () => {
  it('builds ordered columns and the room → task map', () => {
    const d = loaded();
    expect(d.columns['b1']).toEqual({ s1: ['a', 'b'], s2: ['c'] });
    expect(d.roomTask['r-a']).toBe('a');
  });

  it('a title change replaces one task and keeps every column by reference', () => {
    const d = loaded();
    const next = { ...d, ...upsertTask(d, { ...(d.tasks['a'] as Task), title: 'renamed' }) };
    expect(next.columns).toBe(d.columns);
    expect(next.tasks['b']).toBe(d.tasks['b']);
    expect(next.tasks['a']?.title).toBe('renamed');
  });

  it('a move re-sorts only the touched columns', () => {
    const d = loaded();
    const moved = { ...d, ...upsertTask(d, { ...(d.tasks['b'] as Task), position: 512 }) };
    expect(moved.columns['b1']?.['s1']).toEqual(['b', 'a']);
    expect(moved.columns['b1']?.['s2']).toBe(d.columns['b1']?.['s2']);
    const across = { ...d, ...upsertTask(d, { ...(d.tasks['a'] as Task), statusId: 's2', position: 2048 }) };
    expect(across.columns['b1']).toEqual({ s1: ['b'], s2: ['c', 'a'] });
  });

  it('archived / deleted tasks leave the columns; viewer state survives broadcasts', () => {
    const d = loaded();
    const arch = { ...d, ...upsertTask(d, { ...(d.tasks['a'] as Task), archivedAt: timestampFromMs(1) }) };
    expect(arch.columns['b1']?.['s1']).toEqual(['b']);
    expect(arch.tasks['a']).toBeDefined();
    const gone = { ...d, ...removeTask(d, 'c') };
    expect(gone.columns['b1']?.['s2']).toEqual([]);
    expect(gone.tasks['c']).toBeUndefined();
    const mine = { ...d, ...upsertTask(d, { ...(d.tasks['a'] as Task), subscribed: true, unread: true, viewerState: true }) };
    expect(mine.unread['a']).toBe('w1');
    const broadcast = { ...mine, ...upsertTask(mine, { ...(mine.tasks['a'] as Task), subscribed: false, unread: false, viewerState: false, title: 'x' }) };
    expect(broadcast.tasks['a']?.subscribed).toBe(true);
    expect(broadcast.tasks['a']?.unread).toBe(true);
    expect(broadcast.unread['a']).toBe('w1');
  });

  it('the badge counts open unread tasks only: a closed one leaves it and keeps its own mark', () => {
    const d = loaded();
    const mine = { ...d, ...upsertTask(d, { ...(d.tasks['a'] as Task), subscribed: true, unread: true, viewerState: true }) };
    expect(mine.unread['a']).toBe('w1');
    const done = { ...mine, ...upsertTask(mine, { ...(mine.tasks['a'] as Task), viewerState: false, unread: false, completedAt: timestampFromMs(1) }) };
    expect(done.unread['a']).toBeUndefined();
    expect(done.tasks['a']?.unread).toBe(true);
    const notice = { ...d, ...upsertTask(d, { ...(d.tasks['b'] as Task), unread: true, viewerState: true, completedAt: timestampFromMs(1) }) };
    expect(notice.unread['b']).toBeUndefined();
    expect(notice.tasks['b']?.unread).toBe(true);
  });

  it('TASK_ACTIVITY appends once, a merged row supersedes its predecessor, a removal hides it (ADR-0081)', () => {
    const act = (id: string) => create(TaskActivitySchema, { id, taskId: 't1', kind: 'status' });
    let d: BoardsData = { ...EMPTY_DATA, ...appendActivity(EMPTY_DATA, act('01')) };
    expect(appendActivity(d, act('01'))).toEqual({});
    // Merged: the old row leaves the live list and is remembered as gone (it may be in the loaded page).
    d = { ...d, ...appendActivity(d, act('02'), '01') };
    expect(d.activity['t1']?.map((a) => a.id)).toEqual(['02']);
    expect(d.activityGone['t1']).toEqual(['01']);
    // Cancelled out: no row, only the removal (the task id comes from the event).
    const other = d.activity;
    d = { ...d, ...appendActivity(d, undefined, '02', 't1') };
    expect(d.activity['t1']).toEqual([]);
    expect(d.activityGone['t1']).toEqual(['01', '02']);
    expect(other['t1']?.length).toBe(1);
    // A removal of a row never seen live (the loaded page): only remembered.
    const before = d.activity;
    d = { ...d, ...appendActivity(d, undefined, '00', 't1') };
    expect(d.activity).toBe(before);
    expect(d.activityGone['t1']).toEqual(['01', '02', '00']);
    expect(appendActivity(d, undefined, '', '')).toEqual({});
  });
});
