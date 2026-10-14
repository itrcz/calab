import { create, fromJson, toJson, type MessageInitShape } from '@bufbuild/protobuf';
import { ApproverState, BoardStatusType, TaskApprovalState, TaskAssigneeSchema, TaskField, TaskFilterSchema, TaskOp, TaskPriority, TaskRelationKind, TaskRelationSchema, TaskSchema, type Task } from '@calaba/protocol';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { FILTER_FIELDS, fieldDef, opLabel } from './filterFields';
import { EMPTY_FILTER, FORMER, addCond, complete, filterKey, fromTaskFilter, matchTask, quickOn, resolveDay, toTaskFilter, toggleQuick, toggleValue, type FilterState } from './filter';

const ctx = { me: 'u-me', today: '2026-01-15', statuses: { s1: { type: BoardStatusType.UNSTARTED }, s2: { type: BoardStatusType.STARTED }, s3: { type: BoardStatusType.COMPLETED } } };

function task(p: MessageInitShape<typeof TaskSchema> = {}): Task {
  return create(TaskSchema, { id: 't1', key: 'CAL-1', title: 'Эхо в звонке', description: 'Windows 11', statusId: 's1', ...p });
}

describe('filter registry', () => {
  it('describes every TaskField but UNSPECIFIED, each with its default op among its ops', () => {
    const fields = Object.values(TaskField).filter((v): v is TaskField => typeof v === 'number' && v !== TaskField.UNSPECIFIED);
    expect(FILTER_FIELDS.map((f) => f.field).sort((a, b) => a - b)).toEqual(fields.sort((a, b) => a - b));
    for (const f of FILTER_FIELDS) expect(f.ops).toContain(f.op);
    expect(fieldDef(TaskField.LABEL)?.multi).toBe(true);
    expect(opLabel(TaskOp.IS, 2)).toBe('boards.op.anyOf');
  });
});

describe('TaskFilter round trip', () => {
  it('keeps conditions through toTaskFilter → protojson → fromTaskFilter', () => {
    const f: FilterState = {
      any: true,
      conds: [
        { field: TaskField.STATUS, op: TaskOp.IS, values: ['s1', 's2'] },
        { field: TaskField.ASSIGNEE, op: TaskOp.EMPTY, values: [] },
        { field: TaskField.LABEL, op: TaskOp.ANY_OF, values: ['l1'] },
        { field: TaskField.DUE_ON, op: TaskOp.BEFORE, values: ['today'] },
        { field: TaskField.START_ON, op: TaskOp.BETWEEN, values: ['2026-01-01', '2026-01-31'] },
        { field: TaskField.CREATED_AT, op: TaskOp.BETWEEN, values: ['2026-01-10', '2026-01-12'] },
        { field: TaskField.UPDATED_AT, op: TaskOp.AFTER, values: ['2026-01-05'] },
        { field: TaskField.ESTIMATE, op: TaskOp.GT, values: ['3'] },
        { field: TaskField.TEXT, op: TaskOp.CONTAINS, values: ['эхо'] },
        { field: TaskField.RELATION, op: TaskOp.IS, values: ['blocked'] },
      ],
    };
    const wire = toTaskFilter(f);
    const json = toJson(TaskFilterSchema, wire);
    const back = fromTaskFilter(fromJson(TaskFilterSchema, json));
    expect(back).toEqual(f);
    // Instants go as from / to, the estimate as a number.
    expect(wire.conditions[5]?.from).toBeDefined();
    expect(wire.conditions[7]?.number).toBe(3);
  });

  it('drops incomplete conditions and unknown fields', () => {
    const f = addCond(EMPTY_FILTER, TaskField.STATUS);
    expect(complete(f.conds[0] as never)).toBe(false);
    expect(toTaskFilter(f).conditions).toHaveLength(0);
    const unknown = create(TaskFilterSchema, { conditions: [{ field: 99 as TaskField, op: TaskOp.IS, values: ['x'] }] });
    expect(fromTaskFilter(unknown).conds).toHaveLength(0);
  });

  it('toggles values and quick chips (mine / unassigned exclude each other)', () => {
    const c = toggleValue({ field: TaskField.LABEL, op: TaskOp.ANY_OF, values: ['a'] }, 'b');
    expect(c.values).toEqual(['a', 'b']);
    expect(toggleValue(c, 'a').values).toEqual(['b']);
    expect(toggleValue({ field: TaskField.TEXT, op: TaskOp.CONTAINS, values: ['x'] }, 'y').values).toEqual(['y']);
    let f = toggleQuick(EMPTY_FILTER, 'mine');
    expect(quickOn(f, 'mine')).toBe(true);
    f = toggleQuick(f, 'unassigned');
    expect(quickOn(f, 'mine')).toBe(false);
    expect(quickOn(f, 'unassigned')).toBe(true);
    f = toggleQuick(f, 'unassigned');
    expect(f.conds).toHaveLength(0);
    expect(filterKey(toggleQuick(EMPTY_FILTER, 'overdue'))).not.toBe(filterKey(EMPTY_FILTER));
  });
});

describe('relative days', () => {
  it('resolves tokens against today (Monday-first weeks)', () => {
    // 2026-01-15 is a Thursday.
    expect(resolveDay('today', '2026-01-15')).toBe('2026-01-15');
    expect(resolveDay('week_start', '2026-01-15')).toBe('2026-01-12');
    expect(resolveDay('week_end', '2026-01-15')).toBe('2026-01-18');
    expect(resolveDay('month_end', '2026-02-10')).toBe('2026-02-28');
    expect(resolveDay('-7d', '2026-01-15')).toBe('2026-01-08');
    expect(resolveDay('+14d', '2026-01-15')).toBe('2026-01-29');
    expect(resolveDay('2025-12-31', '2026-01-15')).toBe('2025-12-31');
  });
});

describe('matchTask', () => {
  const m = (t: Task, conds: FilterState['conds'], any = false): boolean => matchTask(t, { conds, any }, ctx);
  it('matches each field like the server', () => {
    const t = task({
      priority: TaskPriority.HIGH,
      assignees: [create(TaskAssigneeSchema, { userId: 'u-me', isLead: true }), create(TaskAssigneeSchema, { userId: 'u2' })],
      labelIds: ['l1', 'l2'],
      dueOn: '2026-01-14',
      estimate: 5,
      createdBy: 'u2',
      commentCount: 2,
      relations: [create(TaskRelationSchema, { taskId: 't0', relatedId: 't1', kind: TaskRelationKind.BLOCKS })],
      createdAt: timestampFromMs(Date.UTC(2026, 0, 11, 10)),
    });
    expect(m(t, [{ field: TaskField.STATUS, op: TaskOp.IS, values: ['s1'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.STATUS, op: TaskOp.IS_NOT, values: ['s1'] }])).toBe(false);
    expect(m(t, [{ field: TaskField.STATUS_TYPE, op: TaskOp.IS, values: ['unstarted'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.ASSIGNEE, op: TaskOp.IS, values: ['me'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.LEAD, op: TaskOp.IS, values: ['u2'] }])).toBe(false);
    expect(m(t, [{ field: TaskField.ASSIGNEE, op: TaskOp.EMPTY, values: [] }])).toBe(false);
    expect(m(t, [{ field: TaskField.CREATOR, op: TaskOp.IS_NOT, values: ['me'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.PRIORITY, op: TaskOp.IS, values: ['high'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.LABEL, op: TaskOp.IS, values: ['l1', 'l2'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.LABEL, op: TaskOp.IS, values: ['l1', 'l3'] }])).toBe(false);
    expect(m(t, [{ field: TaskField.LABEL, op: TaskOp.ANY_OF, values: ['l1', 'l3'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.LABEL, op: TaskOp.NONE_OF, values: ['l3'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.DUE_ON, op: TaskOp.BEFORE, values: ['today'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.DUE_ON, op: TaskOp.BETWEEN, values: ['2026-01-12', 'week_end'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.START_ON, op: TaskOp.EMPTY, values: [] }])).toBe(true);
    expect(m(t, [{ field: TaskField.ESTIMATE, op: TaskOp.GT, values: ['3'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.ESTIMATE, op: TaskOp.LT, values: ['3'] }])).toBe(false);
    expect(m(t, [{ field: TaskField.HAS_COMMENTS, op: TaskOp.IS, values: ['true'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.HAS_ATTACHMENTS, op: TaskOp.IS, values: ['true'] }])).toBe(false);
    expect(m(t, [{ field: TaskField.RELATION, op: TaskOp.IS, values: ['blocked'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.TEXT, op: TaskOp.CONTAINS, values: ['ЭХО windows'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.TEXT, op: TaskOp.CONTAINS, values: ['cal-1'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.CREATED_AT, op: TaskOp.BETWEEN, values: ['2026-01-10', '2026-01-12'] }])).toBe(true);
    // AND by default, OR with `any`.
    const two: FilterState['conds'] = [
      { field: TaskField.STATUS, op: TaskOp.IS, values: ['s2'] },
      { field: TaskField.PRIORITY, op: TaskOp.IS, values: ['3'] },
    ];
    expect(m(t, two)).toBe(false);
    expect(m(t, two, true)).toBe(true);
  });
});

describe('approval filters (ADR-0049)', () => {
  const m = (t: Task, conds: FilterState['conds']): boolean => matchTask(t, { conds, any: false }, ctx);
  it('matches the derived state and my pending vote', () => {
    const t = task({
      approvalState: TaskApprovalState.PENDING,
      approvers: [
        { userId: 'u-me', state: ApproverState.PENDING },
        { userId: 'u-2', state: ApproverState.APPROVED },
      ],
    });
    expect(m(t, [{ field: TaskField.APPROVAL_STATE, op: TaskOp.IS, values: ['pending', 'rejected'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.APPROVAL_STATE, op: TaskOp.IS_NOT, values: ['pending'] }])).toBe(false);
    expect(m(task(), [{ field: TaskField.APPROVAL_STATE, op: TaskOp.IS, values: ['none'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.APPROVER_PENDING, op: TaskOp.IS, values: ['me'] }])).toBe(true);
    expect(m(t, [{ field: TaskField.APPROVER_PENDING, op: TaskOp.IS, values: ['u-2'] }])).toBe(false);
  });

  it('«Ждут моего согласования» is a quick chip: APPROVER_PENDING IS me, shown in the field list', () => {
    const f = toggleQuick(EMPTY_FILTER, 'approval');
    expect(f.conds).toEqual([{ field: TaskField.APPROVER_PENDING, op: TaskOp.IS, values: ['me'] }]);
    expect(quickOn(f, 'approval')).toBe(true);
    expect(toggleQuick(f, 'approval').conds).toEqual([]);
    expect(fieldDef(TaskField.APPROVAL_STATE)).toMatchObject({ kind: 'approval' });
    expect(fieldDef(TaskField.APPROVAL_STATE)?.hidden).toBeFalsy();
    expect(fieldDef(TaskField.APPROVER_PENDING)?.hidden).toBeFalsy();
  });
});

describe('assignee «бывшие участники» (ADR-0097 §4)', () => {
  const gone = { ...ctx, gone: (id: string) => id === 'ex' };
  const f: FilterState = { any: false, conds: [{ field: TaskField.ASSIGNEE, op: TaskOp.IS, values: [FORMER] }] };
  const assigned = (...ids: string[]) => task({ assignees: ids.map((userId, i) => create(TaskAssigneeSchema, { userId, isLead: i === 0 })) });

  it('matches a task with an assignee who is not a member, not one with only members or nobody', () => {
    expect(matchTask(assigned('ex'), f, gone)).toBe(true);
    expect(matchTask(assigned('u-me', 'ex'), f, gone)).toBe(true);
    expect(matchTask(assigned('u-me'), f, gone)).toBe(false);
    expect(matchTask(assigned(), f, gone)).toBe(false);
  });

  it('is never sent to the server and is not «Без исполнителя»', () => {
    expect(toTaskFilter(f).conditions).toHaveLength(0);
    const none: FilterState = { any: false, conds: [{ field: TaskField.ASSIGNEE, op: TaskOp.EMPTY, values: [] }] };
    expect(matchTask(assigned('ex'), none, gone)).toBe(false);
  });
});
