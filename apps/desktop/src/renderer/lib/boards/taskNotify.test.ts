import { TaskNoticeKind } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { TASK_NOTIFY_GROUPS, editedKey, rowOn, withRow } from './taskNotify';

const rows = TASK_NOTIFY_GROUPS.flatMap((g) => g.rows);
const row = (id: string) => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
};

describe('task notification triggers (ADR-0089 §5)', () => {
  it('every wire kind has exactly one row; approvals are locked', () => {
    const kinds = rows.flatMap((r) => r.kinds);
    const wire = Object.values(TaskNoticeKind).filter((v): v is TaskNoticeKind => typeof v === 'number' && v !== TaskNoticeKind.UNSPECIFIED);
    expect([...kinds].sort((a, b) => a - b)).toEqual([...wire].sort((a, b) => a - b));
    expect(rows.filter((r) => r.locked).flatMap((r) => r.kinds).sort()).toEqual(
      [TaskNoticeKind.APPROVAL_REQUESTED, TaskNoticeKind.APPROVED, TaskNoticeKind.REJECTED].sort(),
    );
  });

  it('the addressed kinds are «Мне лично», the rest «Задачи, в которых участвую»', () => {
    const me = TASK_NOTIFY_GROUPS.find((g) => g.id === 'me')?.rows.flatMap((r) => r.kinds);
    expect(me).toContain(TaskNoticeKind.DUE_SOON);
    expect(me).toContain(TaskNoticeKind.OVERDUE);
    expect(me).not.toContain(TaskNoticeKind.DUE_CHANGED);
  });

  it('switching a row off and on edits only its kinds, keeps unknown ones, sorts', () => {
    const off = [99, TaskNoticeKind.EDITED];
    const next = withRow(off, row('dueSoon'), false);
    expect(next).toEqual([TaskNoticeKind.DUE_SOON, TaskNoticeKind.EDITED, 99]);
    expect(rowOn(next, row('dueSoon'))).toBe(false);
    expect(rowOn(next, row('overdue'))).toBe(true);
    expect(withRow(next, row('dueSoon'), true)).toEqual([TaskNoticeKind.EDITED, 99]);
    expect(withRow(next, row('dueSoon'), false)).toEqual(next); // idempotent
  });

  it('a locked row is always on and never switched off', () => {
    const decision = row('decision');
    expect(rowOn([TaskNoticeKind.APPROVED], decision)).toBe(true);
    expect(withRow([], decision, false)).toEqual([]);
  });

  it('EDITED says what changed', () => {
    expect(editedKey('title')).toBe('boards.notice.editedTitle');
    expect(editedKey('description')).toBe('boards.notice.editedDescription');
  });
});
