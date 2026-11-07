import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { ApprovalGate, ApproverState, TaskNoticeKind, TaskNoticeSchema, TaskPriority, BoardCategorySchema, BoardSchema, TaskChecklistItemSchema, TaskChecklistSchema, BoardStatusSchema, BoardStatusType, BoardViewSchema, DispatchEventSchema, TaskActivitySchema, TaskApprovalState, TaskApproverSchema, TaskSchema, WorkspaceSnapshotSchema, type Task } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// services/boards.ts on the gateway events (ADR-0042 §4), with the stores it writes.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false });
vi.stubGlobal('window', globalThis);
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), fail: vi.fn() }, useToasts: { getState: () => ({ push: vi.fn() }) } }));
const update = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const search = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('./boardsApi', () => ({ boardsApi: { tasks: { update: (...a: unknown[]) => update(...a), search: (...a: unknown[]) => search(...a) } } }));

const { openTaskAnywhere, duplicateStatusId, applyBoardEvent, moveTask, updateTask, bulkUpdate, gateText, applySnapshotBoards, noticeText, duplicateAfterId, searchAllTasks, ALL_TASKS_LIMIT } = await import('./boards');
const { t } = await import('../i18n');
const { memberName } = await import('../stores/workspaces');
const { useBoards, workspaceBoards } = await import('../stores/boards');
const { useBoardsUi, MY_TASKS } = await import('../stores/boardsUi');
const { toast } = await import('../stores/toasts');
const { useMailUi } = await import('../stores/mailUi');
const { useUi } = await import('../stores/ui');
const { ApiError } = await import('../lib/api/client');

const task = (id: string, statusId: string, position: number, p: MessageInitShape<typeof TaskSchema> = {}): Task =>
  create(TaskSchema, { id, boardId: 'b1', workspaceId: 'w1', statusId, position, key: `CAL-${id}`, title: id, roomId: `r-${id}`, ...p });

describe('gateway events 75–81 → the store', () => {
  beforeEach(() => useBoards.getState().reset());
  const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;

  it('BOARD_CREATE / UPDATE / DELETE', () => {
    const board = create(BoardSchema, { id: 'b1', workspaceId: 'w1', name: 'Разработка', myOpenTasks: 3, views: [create(BoardViewSchema, { id: 'v-mine', shared: false })] });
    useBoards.getState().upsertBoard(board);
    expect(applyBoardEvent(ev({ event: { case: 'boardUpdate', value: { board: { ...board, name: 'Dev', myOpenTasks: 0, views: [create(BoardViewSchema, { id: 'v-shared', shared: true })] } } } }))).toBe(true);
    const b = useBoards.getState().boards['b1'];
    expect(b?.name).toBe('Dev');
    // Events carry 0 and the shared views only: my count and my views stay.
    expect(b?.myOpenTasks).toBe(3);
    expect(b?.views.map((v) => v.id)).toEqual(['v-shared', 'v-mine']);
    applyBoardEvent(ev({ event: { case: 'boardCreate', value: { board: create(BoardSchema, { id: 'b2', workspaceId: 'w1' }) } } }));
    expect(useBoards.getState().boards['b2']).toBeDefined();
    applyBoardEvent(ev({ event: { case: 'boardDelete', value: { workspaceId: 'w1', boardId: 'b2' } } }));
    expect(useBoards.getState().boards['b2']).toBeUndefined();
  });

  it('TASK_CREATE / UPDATE / DELETE / ACTIVITY on a loaded board; others ignored unless known', () => {
    useBoards.getState().setBoardTasks('b1', [task('a', 's1', 1024)]);
    useBoards.getState().setLoad('b1', 'ready');
    applyBoardEvent(ev({ event: { case: 'taskCreate', value: { task: task('n', 's1', 4096) } } }));
    expect(useBoards.getState().columns['b1']?.['s1']).toEqual(['a', 'n']);
    const before = useBoards.getState().columns;
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: task('a', 's1', 1024, { title: 'T' }) } } }));
    expect(useBoards.getState().tasks['a']?.title).toBe('T');
    expect(useBoards.getState().columns).toBe(before);
    applyBoardEvent(ev({ event: { case: 'taskDelete', value: { workspaceId: 'w1', boardId: 'b1', taskId: 'n' } } }));
    expect(useBoards.getState().columns['b1']?.['s1']).toEqual(['a']);
    applyBoardEvent(ev({ event: { case: 'taskActivity', value: { workspaceId: 'w1', activity: create(TaskActivitySchema, { id: 'x1', taskId: 'a', kind: 'status' }) } } }));
    applyBoardEvent(ev({ event: { case: 'taskActivity', value: { workspaceId: 'w1', activity: create(TaskActivitySchema, { id: 'x1', taskId: 'a', kind: 'status' }) } } }));
    expect(useBoards.getState().activity['a']).toHaveLength(1);
    // A task of a board never opened is kept only while unread («Непрочитанное» lists it).
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: create(TaskSchema, { id: 'z', boardId: 'b9', workspaceId: 'w1', unread: true, viewerState: true }) } } }));
    expect(useBoards.getState().tasks['z']?.id).toBe('z');
    expect(useBoards.getState().unread['z']).toBe('w1');
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: create(TaskSchema, { id: 'q', boardId: 'b9', workspaceId: 'w1' }) } } }));
    expect(useBoards.getState().tasks['q']).toBeUndefined();
    expect(applyBoardEvent(ev({ event: { case: 'typingStart', value: { roomId: 'r', userId: 'u' } } }))).toBe(false);
  });
});

describe('approvals (ADR-0049) in the store and the move gate', () => {
  const statuses = [
    create(BoardStatusSchema, { id: 'todo', position: 1, type: BoardStatusType.UNSTARTED }),
    create(BoardStatusSchema, { id: 'doing', position: 2, type: BoardStatusType.STARTED }),
    create(BoardStatusSchema, { id: 'done', position: 3, type: BoardStatusType.COMPLETED }),
    create(BoardStatusSchema, { id: 'gone', position: 4, type: BoardStatusType.CANCELLED }),
  ];
  const pending = (p: MessageInitShape<typeof TaskSchema> = {}): Task =>
    task('a', 'todo', 1024, {
      approvers: [create(TaskApproverSchema, { userId: 'u1', state: ApproverState.APPROVED }), create(TaskApproverSchema, { userId: 'u2', state: ApproverState.PENDING })],
      approvalState: TaskApprovalState.PENDING,
      ...p,
    });
  const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;
  beforeEach(() => {
    useBoards.getState().reset();
    useBoards.getState().upsertBoard(create(BoardSchema, { id: 'b1', workspaceId: 'w1', statuses }));
    useBoards.getState().setBoardTasks('b1', [pending(), task('b', 'todo', 2048)]);
    useBoards.getState().setLoad('b1', 'ready');
    update.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it('TASK_UPDATE replaces the approvals of that task only (other cards keep their objects: no re-render)', () => {
    const before = useBoards.getState();
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: pending({ approvalState: TaskApprovalState.APPROVED, approvers: [create(TaskApproverSchema, { userId: 'u1', state: ApproverState.APPROVED })] }) } } }));
    const after = useBoards.getState();
    expect(after.tasks['a']?.approvalState).toBe(TaskApprovalState.APPROVED);
    expect(after.tasks['b']).toBe(before.tasks['b']);
    expect(after.columns).toBe(before.columns);
  });

  it('a forward move of a task waiting for approval is refused locally with the toast; back / cancel go', async () => {
    await moveTask('a', 'doing', '', '');
    await updateTask('a', { statusId: 'done' });
    expect(update).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(useBoards.getState().tasks['a']?.statusId).toBe('todo');
    update.mockResolvedValue({});
    await moveTask('a', 'gone', '', '');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('ADR-0160: on a board whose gate is off the pending task moves forward and in bulk, no toast', async () => {
    useBoards.getState().upsertBoard(create(BoardSchema, { id: 'b1', workspaceId: 'w1', statuses, approvalGate: ApprovalGate.OFF }));
    update.mockResolvedValue({});
    await moveTask('a', 'doing', '', '');
    await updateTask('a', { statusId: 'done' });
    await bulkUpdate(['a', 'b'], { statusId: 'doing' });
    expect(update).toHaveBeenCalledTimes(4);
    expect(toast.error).not.toHaveBeenCalled();
    expect(useBoards.getState().tasks['a']?.statusId).toBe('doing');
  });

  it('409 TASK_APPROVAL_REQUIRED (a race) reverts the optimistic move with the same toast', async () => {
    useBoards.getState().upsertTask(pending({ approvalState: TaskApprovalState.APPROVED }));
    update.mockRejectedValue(new ApiError('CONFLICT', 'approval required', 409, '', { reason: 'TASK_APPROVAL_REQUIRED', used: 1, limit: 2 }));
    await moveTask('a', 'doing', '', '');
    expect(useBoards.getState().tasks['a']?.statusId).toBe('todo');
    expect(toast.error).toHaveBeenCalledWith(gateText(pending(), 1, 2));
  });

  it('the toast names the veto', () => {
    const vetoed = pending({ approvers: [create(TaskApproverSchema, { userId: 'u9', state: ApproverState.REJECTED, comment: 'нет' })] });
    expect(gateText(vetoed)).not.toBe(gateText(pending()));
    expect(gateText(pending())).toMatch(/1.*2/);
  });
});

describe('ADR-0058: events 87–91, READY categories, FEATURE_DISABLED', () => {
  beforeEach(() => {
    useBoards.getState().reset();
    vi.mocked(toast.error).mockClear();
  });
  const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;

  it('BOARD_CATEGORY_CREATE / UPDATE / DELETE and READY board_categories', () => {
    applySnapshotBoards(create(WorkspaceSnapshotSchema, { workspace: { id: 'w1' }, boardCategories: [create(BoardCategorySchema, { id: 'k0', workspaceId: 'w1', name: 'Old' })] }));
    expect(Object.keys(useBoards.getState().categories)).toEqual(['k0']);
    expect(applyBoardEvent(ev({ event: { case: 'boardCategoryCreate', value: { category: create(BoardCategorySchema, { id: 'k1', workspaceId: 'w1', name: 'Продукт' }) } } }))).toBe(true);
    applyBoardEvent(ev({ event: { case: 'boardCategoryUpdate', value: { category: create(BoardCategorySchema, { id: 'k1', workspaceId: 'w1', name: 'Product', position: 2 }) } } }));
    expect(useBoards.getState().categories['k1']?.name).toBe('Product');
    applyBoardEvent(ev({ event: { case: 'boardCategoryDelete', value: { workspaceId: 'w1', categoryId: 'k1' } } }));
    expect(useBoards.getState().categories['k1']).toBeUndefined();
  });

  it('TASK_CHECKLIST_UPDATE / DELETE patch the counters, not the task object', () => {
    useBoards.getState().setBoardTasks('b1', [task('a', 's1', 1024)]);
    const t = useBoards.getState().tasks['a'];
    useBoards.getState().setChecklists('a', []);
    const checklist = create(TaskChecklistSchema, { id: 'c1', taskId: 'a', title: 'QA', items: [create(TaskChecklistItemSchema, { id: 'i1', checklistId: 'c1', done: true })] });
    expect(applyBoardEvent(ev({ event: { case: 'taskChecklistUpdate', value: { workspaceId: 'w1', boardId: 'b1', taskId: 'a', checklist, checklistTotal: 1, checklistDone: 1 } } }))).toBe(true);
    expect(useBoards.getState().tasks['a']).toBe(t);
    expect(useBoards.getState().checkCounts['a']).toEqual({ total: 1, done: 1 });
    expect(useBoards.getState().checklists['a']?.map((c) => c.id)).toEqual(['c1']);
    applyBoardEvent(ev({ event: { case: 'taskChecklistDelete', value: { workspaceId: 'w1', boardId: 'b1', taskId: 'a', checklistId: 'c1', checklistTotal: 0, checklistDone: 0 } } }));
    expect(useBoards.getState().checklists['a']).toEqual([]);
  });

  it('409 FEATURE_DISABLED rolls back with a toast naming the field', async () => {
    useBoards.getState().upsertTask(task('a', 's1', 1024));
    update.mockRejectedValue(new ApiError('CONFLICT', 'the board feature ESTIMATE is switched off', 409, 'estimate', { reason: 'FEATURE_DISABLED' }));
    await updateTask('a', { estimate: 5 });
    expect(useBoards.getState().tasks['a']?.estimate).toBe(0);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Оценка'));
  });
});

// ADR-0059 §5: a viewer who sees a board only through his cards.
describe('task-scoped boards in the store', () => {
  beforeEach(() => {
    useBoards.getState().reset();
    useBoardsUi.setState({ taskId: null, boardOf: {}, active: false });
  });
  const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;
  const scoped = (): void => useBoards.getState().upsertBoard(create(BoardSchema, { id: 'b1', workspaceId: 'w1', name: 'Dev', permissions: 0n, taskScoped: true }));

  it('BOARD_CREATE with taskScoped shows the board in the list even with permissions 0', () => {
    applyBoardEvent(ev({ event: { case: 'boardCreate', value: { board: create(BoardSchema, { id: 'b1', workspaceId: 'w1', name: 'Dev', permissions: 0n, taskScoped: true }) } } }));
    expect(workspaceBoards(useBoards.getState().boards, 'w1').map((b) => b.id)).toEqual(['b1']);
  });

  it('TASK_DELETE without purged removes the card and closes its open panel on a scoped board', () => {
    scoped();
    useBoards.getState().setBoardTasks('b1', [task('a', 's1', 1024)]);
    useBoardsUi.getState().openTask('a');
    applyBoardEvent(ev({ event: { case: 'taskDelete', value: { workspaceId: 'w1', boardId: 'b1', taskId: 'a' } } }));
    expect(useBoards.getState().tasks['a']).toBeUndefined();
    expect(useBoardsUi.getState().taskId).toBeNull();
  });

  it('TASK_DELETE of another card leaves the open panel alone', () => {
    scoped();
    useBoards.getState().setBoardTasks('b1', [task('a', 's1', 1024), task('c', 's1', 2048)]);
    useBoardsUi.getState().openTask('a');
    applyBoardEvent(ev({ event: { case: 'taskDelete', value: { workspaceId: 'w1', boardId: 'b1', taskId: 'c' } } }));
    expect(useBoardsUi.getState().taskId).toBe('a');
  });

  it('BOARD_DELETE closes the open board and the panel of its task', () => {
    scoped();
    useBoards.getState().setBoardTasks('b1', [task('a', 's1', 1024)]);
    useBoardsUi.getState().openBoard('w1', 'b1');
    useBoardsUi.getState().openTask('a');
    applyBoardEvent(ev({ event: { case: 'boardDelete', value: { workspaceId: 'w1', boardId: 'b1' } } }));
    expect(useBoards.getState().boards['b1']).toBeUndefined();
    expect(useBoardsUi.getState().boardOf['w1']).toBe(MY_TASKS);
    expect(useBoardsUi.getState().taskId).toBeNull();
  });
});


describe('noticeText (ADR-0089 triggers)', () => {
  const tk = task('n1', 's1', 1, { priority: TaskPriority.HIGH });
  const text = (n: MessageInitShape<typeof TaskNoticeSchema>): string => noticeText(tk, create(TaskNoticeSchema, n));
  const who = memberName('w1', 'u1');

  it('addressed kinds name the actor; the due sweep and a rule have none', () => {
    expect(text({ kind: TaskNoticeKind.UNASSIGNED, actorId: 'u1' })).toBe(t('boards.notice.unassigned', { name: who }));
    expect(text({ kind: TaskNoticeKind.UNASSIGNED })).toBe(t('boards.notice.unassignedAuto'));
    expect(text({ kind: TaskNoticeKind.WATCHER_ADDED, actorId: 'u1' })).toBe(t('boards.notice.watcherAdded', { name: who }));
    expect(text({ kind: TaskNoticeKind.APPROVED_ON_BEHALF, actorId: 'u1' })).toBe(t('boards.notice.approvedOnBehalf', { name: who })); // ADR-0108
    expect(text({ kind: TaskNoticeKind.DUE_SOON, dueOn: '2030-03-11', daysLeft: 1 })).toBe(t('boards.notice.dueTomorrow'));
    expect(text({ kind: TaskNoticeKind.DUE_SOON, dueOn: '2030-03-10', daysLeft: 0 })).toBe(t('boards.notice.dueToday'));
    const overdue = text({ kind: TaskNoticeKind.OVERDUE, dueOn: '2030-03-09', daysLeft: -1 });
    expect(overdue).toContain('2030');
    expect(overdue).not.toContain(t('common.unknownUser'));
  });

  it('field changes carry their details', () => {
    expect(text({ kind: TaskNoticeKind.DUE_CHANGED, dueOn: '' })).toBe(t('boards.notice.dueRemoved'));
    expect(text({ kind: TaskNoticeKind.DUE_CHANGED, dueOn: '2031-01-15' })).toContain('2031');
    expect(text({ kind: TaskNoticeKind.PRIORITY })).toBe(t('boards.notice.priority', { value: t('boards.prio.high') }));
    expect(text({ kind: TaskNoticeKind.MILESTONE, text: 'Релиз' })).toBe(t('boards.notice.milestone', { value: 'Релиз' }));
    expect(text({ kind: TaskNoticeKind.MILESTONE })).toBe(t('boards.notice.milestoneRemoved'));
    expect(text({ kind: TaskNoticeKind.MOVED, text: 'Дизайн' })).toBe(t('boards.notice.moved', { value: 'Дизайн' }));
    expect(text({ kind: TaskNoticeKind.EDITED, text: 'title' })).toBe(t('boards.notice.editedTitle'));
    expect(text({ kind: TaskNoticeKind.EDITED, text: 'description' })).toBe(t('boards.notice.editedDescription'));
    expect(text({ kind: TaskNoticeKind.ATTACHMENT, text: 'смета.pdf' })).toBe(t('boards.notice.attachment', { value: 'смета.pdf' }));
    expect(text({ kind: TaskNoticeKind.ARCHIVED })).toBe(t('boards.notice.archived'));
  });

  it('status keeps its text; an unknown kind is «Задача обновлена»', () => {
    expect(text({ kind: TaskNoticeKind.STATUS, actorId: 'u1' })).toBe(t('boards.notice.status', { name: who }));
    expect(text({ kind: 99 as TaskNoticeKind })).toBe(t('boards.notice.updated'));
  });
});

describe('«Мои задачи → Все задачи» (CBF-35)', () => {
  beforeEach(() => useBoards.getState().reset());

  it('asks the workspace search with the state, keeps the server order, stores the tasks', async () => {
    search.mockResolvedValueOnce({ tasks: [task('z', 's1', 1, { boardId: 'b2' }), task('a', 's1', 2)] });
    const ac = new AbortController();
    await expect(searchAllTasks('w1', 'login', 'done', ac.signal)).resolves.toEqual(['z', 'a']);
    expect(search).toHaveBeenCalledWith('w1', 'login', { state: 'done', limit: ALL_TASKS_LIMIT }, ac.signal);
    expect(useBoards.getState().tasks['z']?.boardId).toBe('b2');
  });
});

describe('«Дублировать» status (CBF #103)', () => {
  const mk = (id: string, type: BoardStatusType, position: number) => create(BoardStatusSchema, { id, type, position });
  const src = (statusId: string) => ({ statusId, boardId: 'b1' });
  const basic = [mk('todo', BoardStatusType.UNSTARTED, 1), mk('doing', BoardStatusType.STARTED, 2), mk('done', BoardStatusType.COMPLETED, 3), mk('gone', BoardStatusType.CANCELLED, 4)];

  it('a finished source gets no status: the server picks the default', () => {
    expect(duplicateStatusId(src('done'), basic)).toBeUndefined();
  });
  it('a cancelled source gets no status either', () => {
    expect(duplicateStatusId(src('gone'), basic)).toBeUndefined();
  });
  it('an unfinished source keeps its status', () => {
    expect(duplicateStatusId(src('doing'), basic)).toBe('doing');
    expect(duplicateStatusId(src('todo'), basic)).toBe('todo');
  });
  it('a custom board: judged by the status type, not the name', () => {
    const custom = [mk('x1', BoardStatusType.BACKLOG, 1), mk('x2', BoardStatusType.STARTED, 2), mk('Closed', BoardStatusType.CANCELLED, 3), mk('Shipped', BoardStatusType.COMPLETED, 4)];
    expect(duplicateStatusId(src('Shipped'), custom)).toBeUndefined();
    expect(duplicateStatusId(src('Closed'), custom)).toBeUndefined();
    expect(duplicateStatusId(src('x2'), custom)).toBe('x2');
    expect(duplicateStatusId(src('x1'), custom)).toBe('x1');
  });
  it('an unknown status (board not loaded) is kept as is', () => {
    expect(duplicateStatusId(src('zzz'), [])).toBe('zzz');
  });
  it('CBF-158: the copy is placed after the source only in the same status', () => {
    expect(duplicateAfterId({ id: 't1', statusId: 'todo' }, 'todo')).toBe('t1');
    expect(duplicateAfterId({ id: 't1', statusId: 'done' }, undefined)).toBeUndefined();
  });
});

describe('openTaskAnywhere from the mail (#104)', () => {
  beforeEach(() => {
    useBoards.getState().reset();
    useUi.setState({ activeWorkspaceId: 'w1' });
    useBoardsUi.setState({ active: true, taskId: null });
    useMailUi.setState({ active: true });
  });
  it('closes the mail over the already active boards and opens the task', () => {
    openTaskAnywhere({ id: 't1', workspaceId: 'w1', boardId: 'b1' });
    expect(useMailUi.getState().active).toBe(false);
    expect(useBoardsUi.getState().active).toBe(true);
    expect(useBoardsUi.getState().taskId).toBe('t1');
  });
  it('does the same for a task of another workspace', () => {
    openTaskAnywhere({ id: 't2', workspaceId: 'w2', boardId: 'b9' });
    expect(useMailUi.getState().active).toBe(false);
    expect(useBoardsUi.getState().taskId).toBe('t2');
  });
});
