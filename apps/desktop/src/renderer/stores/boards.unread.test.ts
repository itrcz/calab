import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ApproverState, BoardSchema, TaskApprovalState, TaskApproverSchema, TaskNoticeKind, TaskSchema, type Task } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalTagKey } from '../lib/boards/approvals';
import { unreadReason } from '../services/boards';
import { unreadCount, unreadIds, unreadOrdered, useBoards } from './boards';

vi.mock('../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

/**
 * «Непрочитанное» (docs/08 «Доски»): the tab lists exactly the badge's set, newest notice first;
 * re-renders are proven on the store as in boards.rerender.test.ts — a component re-renders only
 * when its selector's result changes.
 */
const N = 60;
const ids = Array.from({ length: N }, (_, i) => `t${i}`);
const ap = (userId: string, state: ApproverState) => create(TaskApproverSchema, { userId, state });

function seed(): void {
  const s = useBoards.getState();
  s.reset();
  s.upsertBoard(create(BoardSchema, { id: 'b1', workspaceId: 'w1', name: 'Релиз', emoji: '🚀' }));
  s.upsertBoard(create(BoardSchema, { id: 'b2', workspaceId: 'w1', name: 'Маркетинг' }));
  s.setBoardTasks(
    'b1',
    ids.map((id, i) =>
      create(TaskSchema, {
        id,
        key: `R-${i}`,
        title: id,
        boardId: 'b1',
        workspaceId: 'w1',
        statusId: 's1',
        position: i * 1024,
        approvers: i === 3 ? [ap('a', ApproverState.APPROVED), ap('b', ApproverState.PENDING)] : [],
        approvalState: i === 3 ? TaskApprovalState.PENDING : TaskApprovalState.NONE,
      }),
    ),
  );
  // READY: the server's order (newest notice first) — one of another workspace too.
  s.setUnread('w1', ['t5', 't9', 'x1']);
  s.setUnread('w2', ['y1']);
}

describe('«Непрочитанное» = the badge set', () => {
  beforeEach(seed);

  it('the tab ids are the badge set, in the server order', () => {
    const s = useBoards.getState();
    expect(unreadIds(s, 'w1')).toEqual(['t5', 't9', 'x1']);
    expect(unreadIds(s, 'w1').length).toBe(unreadCount(s, 'w1'));
    expect(new Set(unreadOrdered(s, 'w1'))).toEqual(new Set(unreadIds(s, 'w1')));
  });

  it('stays equal through live updates: a new unread task, a read one, a completed one', () => {
    const s = useBoards.getState();
    const t3 = s.tasks['t3'] as Task;
    s.upsertTask({ ...t3, unread: true, viewerState: true });
    s.upsertTask({ ...(s.tasks['t5'] as Task), unread: false, viewerState: true });
    s.upsertTask({ ...(s.tasks['t9'] as Task), unread: true, viewerState: true, completedAt: timestampFromMs(5) });
    const now = useBoards.getState();
    expect(new Set(unreadIds(now, 'w1'))).toEqual(new Set(['x1', 't3']));
    expect(unreadOrdered(now, 'w1').length).toBe(unreadCount(now, 'w1'));
  });

  it('a notice this session puts its task first and gives the reason', () => {
    const s = useBoards.getState();
    s.setNotice('t9', { kind: TaskNoticeKind.MENTIONED, actorId: '', text: '', reRequested: false, dueOn: '', daysLeft: 0, at: 1000 });
    const now = useBoards.getState();
    expect(unreadOrdered(now, 'w1')).toEqual(['t9', 't5', 'x1']);
    expect(unreadReason(now, 't9')).toContain('упомина');
    expect(unreadReason(now, 't5')).toBe('');
  });
});

describe('re-renders of one TASK_UPDATE', () => {
  beforeEach(() => {
    seed();
    useBoards.getState().setNotice('t5', { kind: TaskNoticeKind.COMMENT, actorId: '', text: '', reRequested: false, dueOn: '', daysLeft: 0, at: 1 });
  });

  function snapshot(): Map<string, unknown> {
    const s = useBoards.getState();
    const out = new Map<string, unknown>();
    out.set('unread list', unreadOrdered(s, 'w1').join(',')); // useShallow over the ids
    for (const id of ids) {
      out.set(`card ${id}`, s.tasks[id]); // TaskCard / ListRow
      out.set(`tag ${id}`, approvalTagKey(s.tasks[id])); // ApprovalTag leaf
    }
    for (const id of unreadIds(s, 'w1')) {
      // UnreadRow: its primitive selectors.
      out.set(`row ${id}`, [s.tasks[id]?.key, s.tasks[id]?.title, s.tasks[id]?.boardId, unreadReason(s, id)].join('|'));
    }
    return out;
  }
  const changed = (a: Map<string, unknown>, b: Map<string, unknown>): string[] => [...a.keys()].filter((k) => !Object.is(a.get(k), b.get(k)));

  it('an unread task renamed: its card and its unread row, nothing else', () => {
    const before = snapshot();
    const s = useBoards.getState();
    s.upsertTask({ ...(s.tasks['t5'] as Task), title: 'renamed' });
    expect(changed(before, snapshot()).sort()).toEqual(['card t5', 'row t5']);
  });

  it('a vote on a card: the card and its tag only', () => {
    const before = snapshot();
    const s = useBoards.getState();
    s.upsertTask({ ...(s.tasks['t3'] as Task), approvers: [ap('a', ApproverState.APPROVED), ap('b', ApproverState.APPROVED)], approvalState: TaskApprovalState.APPROVED });
    expect(changed(before, snapshot()).sort()).toEqual(['card t3', 'tag t3']);
  });
});
