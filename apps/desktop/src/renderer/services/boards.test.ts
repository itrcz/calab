import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { ApproverState, BoardCategorySchema, BoardSchema, TaskChecklistItemSchema, TaskChecklistSchema, BoardStatusSchema, BoardStatusType, BoardViewSchema, DispatchEventSchema, TaskActivitySchema, TaskApprovalState, TaskApproverSchema, TaskSchema, WorkspaceSnapshotSchema, type Task } from '@calaba/protocol';
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
vi.mock('./boardsApi', () => ({ boardsApi: { tasks: { update: (...a: unknown[]) => update(...a) } } }));

const { applyBoardEvent, moveTask, updateTask, gateText, applySnapshotBoards } = await import('./boards');
const { useBoards, workspaceBoards } = await import('../stores/boards');
const { useBoardsUi, MY_TASKS } = await import('../stores/boardsUi');
const { toast } = await import('../stores/toasts');
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
    // A task of a board never opened is not kept (only its unread mark).
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: create(TaskSchema, { id: 'z', boardId: 'b9', workspaceId: 'w1', unread: true, viewerState: true }) } } }));
    expect(useBoards.getState().tasks['z']).toBeUndefined();
    expect(useBoards.getState().unread['z']).toBe('w1');
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

