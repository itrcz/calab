import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { BoardStatusType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { migrateCompletion, statusShown, taskShown } from './completion';
import { DEFAULT_PREFS, migratePrefs } from '../../stores/boardsUi';

describe('the completion filter «Незавершённые · Завершённые · Все»', () => {
  const types = [BoardStatusType.BACKLOG, BoardStatusType.UNSTARTED, BoardStatusType.STARTED, BoardStatusType.COMPLETED, BoardStatusType.CANCELLED];
  it('by status type: done = COMPLETED or CANCELLED', () => {
    expect(types.filter((x) => statusShown('open', x))).toEqual([BoardStatusType.BACKLOG, BoardStatusType.UNSTARTED, BoardStatusType.STARTED]);
    expect(types.filter((x) => statusShown('done', x))).toEqual([BoardStatusType.COMPLETED, BoardStatusType.CANCELLED]);
    expect(types.filter((x) => statusShown('all', x))).toEqual(types);
  });
  it('by task (my tasks): completedAt', () => {
    const closed = { completedAt: timestampFromMs(1) };
    const open = { completedAt: undefined };
    expect([taskShown('open', open), taskShown('open', closed)]).toEqual([true, false]);
    expect([taskShown('done', open), taskShown('done', closed)]).toEqual([false, true]);
    expect([taskShown('all', open), taskShown('all', closed)]).toEqual([true, true]);
  });
  it('migrates the old toggle: off → open, on → all; the new field wins; default open', () => {
    expect(migrateCompletion({ showCompleted: false })).toBe('open');
    expect(migrateCompletion({ showCompleted: true })).toBe('all');
    expect(migrateCompletion({ completion: 'done', showCompleted: true })).toBe('done');
    expect(migrateCompletion({ completion: 'bogus' })).toBe('open');
    expect(migrateCompletion(undefined)).toBe('open');
    expect(DEFAULT_PREFS.completion).toBe('open');
  });
  it('migrates stored board prefs and drops the old field', () => {
    const out = migratePrefs({ b1: { kind: 'list', showCompleted: false }, b2: { kind: 'kanban', showCompleted: true, hidden: ['s1'] }, b3: 'junk' });
    expect(out['b1']).toMatchObject({ kind: 'list', completion: 'open' });
    expect(out['b2']).toMatchObject({ kind: 'kanban', completion: 'all', hidden: ['s1'] });
    expect('showCompleted' in (out['b1'] ?? {})).toBe(false);
    expect(out['b3']).toBeUndefined();
    expect(migratePrefs(null)).toEqual({});
  });
});
