import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskMilestoneProgressSchema, TaskMilestoneSchema, TaskSchema, type TaskMilestone } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { addRowKey, isAuto, mergeMilestones, milestoneChip, milestoneHint, milestonePosition, milestoneState, progressOf, subtaskProgress, withMilestone } from './milestones';
import { upsertTask, EMPTY_DATA } from './reducers';

const ms = (id: string, init: MessageInitShape<typeof TaskMilestoneSchema> = {}): TaskMilestone => create(TaskMilestoneSchema, { id, name: id.toUpperCase(), ...init });

describe('task milestones: the section (ADR-0063 §5)', () => {
  it('state: filled when completed, red when the date passed, else open', () => {
    const today = '2026-10-04';
    expect(milestoneState(ms('a', { dueOn: '2026-10-01' }), today)).toBe('overdue');
    expect(milestoneState(ms('a', { dueOn: '2026-10-04' }), today)).toBe('open');
    expect(milestoneState(ms('a', { dueOn: '' }), today)).toBe('open');
    expect(milestoneState(ms('a', { dueOn: '2026-10-01', completedAt: timestampFromMs(1) }), today)).toBe('done');
  });

  it('progress: subtasks «3/5» on a row, completed of all on the card', () => {
    expect(subtaskProgress(ms('a', { done: 3, total: 5 }))).toBe('3/5');
    expect(subtaskProgress(ms('a'))).toBe('');
    expect(isAuto(ms('a', { total: 2 }))).toBe(true);
    expect(isAuto(ms('a'))).toBe(false);
    expect(milestoneChip(create(TaskSchema, { milestoneProgress: create(TaskMilestoneProgressSchema, { done: 2, total: 4 }) }))).toBe('2/4');
    expect(milestoneChip(create(TaskSchema, {}))).toBe('');
    expect(progressOf([ms('a', { completedAt: timestampFromMs(1) }), ms('b')])).toEqual({ done: 1, total: 2 });
  });

  it('the add row: Enter saves a name, Esc cancels', () => {
    expect(addRowKey('Enter', 'Бета')).toBe('save');
    expect(addRowKey('Enter', '   ')).toBeNull();
    expect(addRowKey('Escape', 'Бета')).toBe('cancel');
    expect(addRowKey('a', '')).toBeNull();
  });

  it('drag: a position between the new neighbours; a local change keeps the order', () => {
    const list = [ms('a', { position: 0 }), ms('b', { position: 1 }), ms('c', { position: 2 })];
    expect(milestonePosition(list, 'c', 0)).toBe(-1024);
    expect(milestonePosition(list, 'a', 1)).toBe(1.5);
    expect(withMilestone(list, { ...ms('c'), position: 0.5 }).map((m) => m.id)).toEqual(['a', 'c', 'b']);
  });

  it('hint: name, date, progress', () => {
    expect(milestoneHint(ms('a', { name: 'Бета', done: 1, total: 2 }), '5 окт')).toBe('Бета · 5 окт · 1/2');
    expect(milestoneHint(ms('a', { name: 'Бета' }), '')).toBe('Бета');
  });
});

describe('task milestones: the store keeps unchanged ones by reference', () => {
  it('merge: equal milestones keep their objects, the same array when nothing changed', () => {
    const a = ms('a', { position: 0 });
    const b = ms('b', { position: 1 });
    const prev = [a, b];
    expect(mergeMilestones(prev, [ms('b', { position: 1 }), ms('a', { position: 0 })])).toBe(prev);
    const next = mergeMilestones(prev, [ms('a', { position: 0 }), ms('b', { position: 1, name: 'Новое' })]);
    expect(next[0]).toBe(a);
    expect(next[1]).not.toBe(b);
  });

  it('TASK_UPDATE: the task object changes, its untouched milestones do not', () => {
    const a = ms('a', { position: 0 });
    const t1 = create(TaskSchema, { id: 't', boardId: 'b', statusId: 's', milestones: [a, ms('b', { position: 1 })] });
    const d1 = { ...EMPTY_DATA, ...upsertTask(EMPTY_DATA, t1) };
    const t2 = create(TaskSchema, { id: 't', boardId: 'b', statusId: 's', title: 'x', milestones: [ms('a', { position: 0 }), ms('b', { position: 1, done: 1, total: 1 })] });
    const d2 = { ...d1, ...upsertTask(d1, t2) };
    const got = d2.tasks['t']?.milestones ?? [];
    expect(got[0]).toBe(d1.tasks['t']?.milestones[0]);
    expect(got[1]?.done).toBe(1);
  });
});
