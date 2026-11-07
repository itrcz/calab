import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GatewayFrameSchema, GatewayOpcode, RoomType, type DispatchEvent, type Ready } from '@calaba/protocol';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Task boards in the mock (ADR-0042): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email = 'owner@calaba.test'): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  });

const json = async <T>(r: Promise<Response>): Promise<T> => (await (await r).json()) as T;

interface BoardJ {
  id: string;
  key: string;
  name: string;
  permissions?: string;
  statuses: { id: string; name: string; type: string; isDefault?: boolean }[];
  labels?: { id: string; name: string }[];
  views?: { id: string; name: string; shared?: boolean }[];
}
interface TaskJ {
  id: string;
  key: string;
  title: string;
  statusId: string;
  position?: number;
  roomId: string;
  assignees?: { userId: string; isLead?: boolean; note?: string }[];
  labelIds?: string[];
  commentCount?: number;
  unread?: boolean;
}

const bit = (n: number): bigint => 1n << BigInt(n);

async function gateway(token: string): Promise<{ ready: Ready; events: DispatchEvent[]; close: () => void }> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/gateway?v=1`);
  const events: DispatchEvent[] = [];
  const ready = await new Promise<Ready>((resolve, reject) => {
    setTimeout(() => reject(new Error('no READY')), 5000);
    ws.on('open', () => ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } }))));
    ws.on('message', (data: Buffer) => {
      const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
      if (f.payload.case !== 'dispatch') return;
      if (f.payload.value.event.case === 'ready') resolve(f.payload.value.event.value);
      else events.push(f.payload.value.event.case ? f.payload.value : f.payload.value);
    });
    ws.once('error', reject);
  });
  return { ready, events, close: () => ws.close() };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('boards mock (ADR-0042)', () => {
  it('READY carries the visible boards with the viewer bits and unread tasks; guests get none', async () => {
    server.reset();
    const anna = await gateway(await login());
    const snap = anna.ready.workspaces.find((w) => w.workspace?.id === IDS.workspaces.main);
    expect(snap?.boards.map((b) => b.key)).toEqual(['CAL', 'MKT']);
    expect(snap?.boards[0]?.statuses.map((s) => s.name)).toEqual(['Backlog', 'Todo', 'В работе', 'Ревью', 'Готово', 'Отменено']);
    expect((snap?.boards[0]?.permissions ?? 0n) & bit(20)).toBe(bit(20));
    expect(snap?.unreadTaskIds).toHaveLength(1);
    // Task rooms never appear among the rooms.
    expect(snap?.rooms.every((r) => r.type !== RoomType.TASK)).toBe(true);
    anna.close();
    const boris = await gateway(await login('boris@calaba.test'));
    const bs = boris.ready.workspaces.find((w) => w.workspace?.id === IDS.workspaces.main);
    // Борис is an admin: every board bit.
    expect(bs?.boards[0]?.permissions).toBe(bit(17) | bit(18) | bit(19) | bit(20));
    boris.close();
    const vera = await gateway(await login('vera@calaba.test'));
    // Вера is a member: VIEW_BOARD | CREATE_TASKS.
    expect(vera.ready.workspaces.find((w) => w.workspace?.id === IDS.workspaces.main)?.boards[0]?.permissions).toBe(bit(17) | bit(18));
    vera.close();
    const dina = await login('dina@calaba.test');
    expect((await api(dina, `/api/workspaces/${IDS.workspaces.main}/boards`)).status).toBe(403);
  });

  it('creates a task, moves it between columns, assigns people with a lead and notes', async () => {
    server.reset();
    const anna = await login();
    const boards = (await json<{ boards: BoardJ[] }>(api(anna, `/api/workspaces/${IDS.workspaces.main}/boards`))).boards;
    const cal = boards[0] as BoardJ;
    const todo = cal.statuses.find((s) => s.name === 'Todo')?.id ?? '';
    const doing = cal.statuses.find((s) => s.name === 'В работе')?.id ?? '';
    const listed = (await json<{ tasks: TaskJ[] }>(api(anna, `/api/boards/${cal.id}/tasks`))).tasks;
    expect(listed.map((t) => t.key)).toContain('CAL-3');

    const created = await api(anna, `/api/boards/${cal.id}/tasks`, { method: 'POST', body: { title: 'Новая задача', statusId: todo } });
    expect(created.status).toBe(201);
    const task = ((await created.json()) as { task: TaskJ }).task;
    expect(task.key).toBe('CAL-9');
    // Invalid: empty title.
    expect((await api(anna, `/api/boards/${cal.id}/tasks`, { method: 'POST', body: { title: ' ' } })).status).toBe(422);

    // Kanban move: after CAL-3 in «В работе».
    const cal3 = listed.find((t) => t.key === 'CAL-3') as TaskJ;
    const cal4 = listed.find((t) => t.key === 'CAL-4') as TaskJ;
    const moved = await json<{ task: TaskJ }>(api(anna, `/api/tasks/${task.id}`, { method: 'PATCH', body: { statusId: doing, afterTaskId: cal3.id, beforeTaskId: cal4.id } }));
    expect(moved.task.statusId).toBe(doing);
    const col = (await json<{ tasks: TaskJ[] }>(api(anna, `/api/boards/${cal.id}/tasks`))).tasks.filter((t) => t.statusId === doing).map((t) => t.key);
    expect(col).toEqual(['CAL-3', 'CAL-9', 'CAL-4']);

    // Assignees: exactly one lead.
    const bad = await api(anna, `/api/tasks/${task.id}/assignees`, { method: 'PUT', body: { assignees: [{ userId: IDS.users.vera }, { userId: IDS.users.boris }] } });
    expect(bad.status).toBe(422);
    const ok = await json<{ task: TaskJ }>(
      api(anna, `/api/tasks/${task.id}/assignees`, {
        method: 'PUT',
        body: { assignees: [{ userId: IDS.users.vera, note: 'Дизайн' }, { userId: IDS.users.boris, isLead: true, note: 'Бэкенд' }] },
      }),
    );
    expect(ok.task.assignees?.map((a) => [a.userId, !!a.isLead, a.note])).toEqual([
      [IDS.users.boris, true, 'Бэкенд'],
      [IDS.users.vera, false, 'Дизайн'],
    ]);
    // Guests cannot be assigned (not on the board).
    const guest = await api(anna, `/api/tasks/${task.id}/assignees`, { method: 'PUT', body: { assignees: [{ userId: IDS.users.dina, isLead: true }] } });
    expect(guest.status).toBe(422);
  });

  it('task rooms carry comments through the message API; the feed interleaves them with the journal', async () => {
    server.reset();
    const anna = await login();
    const cal3 = server.boards.taskByKey('CAL-3');
    expect(cal3).toBeTruthy();
    const full = await json<{ task: TaskJ; room?: { id: string; type: string }; subtasks: TaskJ[]; related: TaskJ[] }>(api(anna, `/api/tasks/${cal3?.task.id}`));
    expect(full.room?.type).toBe('ROOM_TYPE_TASK');
    expect(full.subtasks.map((t) => t.key)).toEqual(['CAL-5']);
    expect(full.related.map((t) => t.key)).toEqual(['CAL-4']);
    const roomId = full.task.roomId;
    const sent = await api(anna, `/api/rooms/${roomId}/messages`, { method: 'POST', body: { content: 'Проверил — эхо есть', nonce: 'n1' } });
    expect(sent.status).toBe(201);
    const after = await json<{ task: TaskJ }>(api(anna, `/api/tasks/${cal3?.task.id}`));
    expect(after.task.commentCount).toBe(3);
    const feed = await json<{ items: { message?: { content: string }; activity?: { kind: string } }[] }>(api(anna, `/api/tasks/${cal3?.task.id}/activity`));
    expect(feed.items[0]?.message?.content).toBe('Проверил — эхо есть');
    expect(feed.items.some((i) => i.activity?.kind === 'created')).toBe(true);
    // Guests do not see the room.
    const dina = await login('dina@calaba.test');
    expect((await api(dina, `/api/rooms/${roomId}/messages`)).status).toBe(404);
  });

  it('filters by the universal TaskFilter, keeps views, answers my tasks and search', async () => {
    server.reset();
    const anna = await login();
    const cal = (await json<{ boards: BoardJ[] }>(api(anna, `/api/workspaces/${IDS.workspaces.main}/boards`))).boards[0] as BoardJ;
    const bug = cal.labels?.find((l) => l.name === 'Баг')?.id ?? '';
    const filter = { conditions: [{ field: 'TASK_FIELD_LABEL', op: 'TASK_OP_ANY_OF', values: [bug] }] };
    const byLabel = await json<{ tasks: TaskJ[] }>(api(anna, `/api/boards/${cal.id}/tasks?filter=${encodeURIComponent(JSON.stringify(filter))}`));
    expect(byLabel.tasks.map((t) => t.key)).toEqual(['CAL-3']);
    const overdue = { conditions: [{ field: 'TASK_FIELD_DUE_ON', op: 'TASK_OP_BEFORE', values: ['2026-01-15'] }] };
    expect((await json<{ tasks: TaskJ[] }>(api(anna, `/api/boards/${cal.id}/tasks?filter=${encodeURIComponent(JSON.stringify(overdue))}`))).tasks.map((t) => t.key)).toEqual(['CAL-3']);
    const mine = { conditions: [{ field: 'TASK_FIELD_ASSIGNEE', op: 'TASK_OP_IS', values: ['me'] }] };
    expect((await json<{ tasks: TaskJ[] }>(api(anna, `/api/boards/${cal.id}/tasks?filter=${encodeURIComponent(JSON.stringify(mine))}`))).tasks.map((t) => t.key).sort()).toEqual(['CAL-3', 'CAL-4', 'CAL-7']);

    const view = await api(anna, `/api/boards/${cal.id}/views`, { method: 'POST', body: { name: 'Баги', kind: 'BOARD_VIEW_KIND_LIST', filter, shared: false } });
    expect(view.status).toBe(201);
    const withViews = await json<{ board: BoardJ }>(api(anna, `/api/boards/${cal.id}`));
    expect(withViews.board.views?.map((v) => v.name)).toEqual(['Баги']);
    // Personal: Вера does not see it.
    const vera = await login('vera@calaba.test');
    expect((await json<{ board: BoardJ }>(api(vera, `/api/boards/${cal.id}`))).board.views ?? []).toEqual([]);
    // A shared view needs MANAGE_BOARD.
    expect((await api(vera, `/api/boards/${cal.id}/views`, { method: 'POST', body: { name: 'x', shared: true } })).status).toBe(403);

    const my = await json<{ tasks: TaskJ[] }>(api(anna, `/api/me/tasks?workspace_id=${IDS.workspaces.main}&scope=lead&open=1`));
    expect(my.tasks.map((t) => t.key).sort()).toEqual(['CAL-4', 'MKT-2']);
    const found = await json<{ tasks: TaskJ[] }>(api(anna, `/api/workspaces/${IDS.workspaces.main}/tasks/search?q=${encodeURIComponent('эхо')}`));
    expect(found.tasks.map((t) => t.key)).toEqual(['CAL-3']);
    expect((await json<{ tasks: TaskJ[] }>(api(anna, `/api/workspaces/${IDS.workspaces.main}/tasks/search?q=MKT`))).tasks.map((t) => t.key)).toEqual(['MKT-1', 'MKT-2']);
    expect((await json<{ task: TaskJ }>(api(anna, `/api/t/cal-3`))).task.key).toBe('CAL-3');
  });

  it('checks board permissions: members edit only their tasks, private boards hide, overrides grant', async () => {
    server.reset();
    const anna = await login();
    const vera = await login('vera@calaba.test');
    const cal = (await json<{ boards: BoardJ[] }>(api(anna, `/api/workspaces/${IDS.workspaces.main}/boards`))).boards[0] as BoardJ;
    const cal1 = server.boards.taskByKey('CAL-1')?.task.id ?? '';
    const cal2 = server.boards.taskByKey('CAL-2')?.task.id ?? '';
    // CAL-2 is Вера's: she may edit it; CAL-1 is not.
    expect((await api(vera, `/api/tasks/${cal2}`, { method: 'PATCH', body: { title: 'Тёмная тема' } })).status).toBe(200);
    expect((await api(vera, `/api/tasks/${cal1}`, { method: 'PATCH', body: { title: 'x' } })).status).toBe(403);
    expect((await api(vera, `/api/boards/${cal.id}/statuses`, { method: 'POST', body: { name: 'QA' } })).status).toBe(403);
    // Labels on the fly: CREATE_TASKS is enough.
    expect((await api(vera, `/api/boards/${cal.id}/labels`, { method: 'POST', body: { name: 'Срочно', color: 0xff9f0a } })).status).toBe(201);
    // A private board: Вера loses it; a user override brings it back.
    const pb = await json<{ board: BoardJ }>(api(anna, `/api/boards/${cal.id}`, { method: 'PATCH', body: { isPrivate: true } }));
    expect(pb.board.id).toBe(cal.id);
    expect((await api(vera, `/api/boards/${cal.id}`)).status).toBe(404);
    const perms = await api(anna, `/api/boards/${cal.id}/permissions`, {
      method: 'PUT',
      body: { overrides: [{ targetType: 'PERMISSION_TARGET_TYPE_USER', targetId: IDS.users.vera, allow: String(bit(17) | bit(18) | bit(19)), deny: '0' }] },
    });
    expect(perms.status).toBe(200);
    const seen = await json<{ board: BoardJ }>(api(vera, `/api/boards/${cal.id}`));
    expect(BigInt(seen.board.permissions ?? '0')).toBe(bit(17) | bit(18) | bit(19));
    expect((await api(vera, `/api/tasks/${cal1}`, { method: 'PATCH', body: { title: 'Экспорт в CSV' } })).status).toBe(200);
    // A room bit on a board is refused.
    expect((await api(anna, `/api/boards/${cal.id}/permissions`, { method: 'PUT', body: { overrides: [{ targetType: 'PERMISSION_TARGET_TYPE_USER', targetId: IDS.users.vera, allow: '1', deny: '0' }] } })).status).toBe(422);
  });

  it('fans out events 75–81 to the viewers', async () => {
    server.reset();
    const annaToken = await login();
    const vera = await gateway(await login('vera@calaba.test'));
    const cal = (await json<{ boards: BoardJ[] }>(api(annaToken, `/api/workspaces/${IDS.workspaces.main}/boards`))).boards[0] as BoardJ;
    const created = await json<{ task: TaskJ }>(api(annaToken, `/api/boards/${cal.id}/tasks`, { method: 'POST', body: { title: 'Событие', assignees: [{ userId: IDS.users.vera, isLead: true }] } }));
    await api(annaToken, `/api/boards/${cal.id}/labels`, { method: 'POST', body: { name: 'QA', color: 1 } });
    await api(annaToken, `/api/tasks/${created.task.id}/archive`, { method: 'POST' });
    const b = await json<{ board: BoardJ }>(api(annaToken, `/api/workspaces/${IDS.workspaces.main}/boards`, { method: 'POST', body: { name: 'Новая', template: 'BOARD_TEMPLATE_EMPTY' } }));
    await api(annaToken, `/api/boards/${b.board.id}?purge=1`, { method: 'DELETE' });
    server.updateTaskAs(IDS.users.boris, server.boards.taskByKey('CAL-2')?.task.id ?? '', { title: 'Переименовал Борис' });
    await wait(150);
    const cases = vera.events.map((e) => e.event.case);
    expect(cases).toEqual(expect.arrayContaining(['taskCreate', 'taskUpdate', 'taskActivity', 'boardUpdate', 'taskDelete', 'boardCreate', 'boardDelete']));
    const assigned = vera.events.find((e) => e.event.case === 'taskUpdate' && e.event.value.notice);
    expect(assigned?.event.case === 'taskUpdate' ? assigned.event.value.task?.unread : false).toBe(true);
    const renamed = vera.events.filter((e) => e.event.case === 'taskUpdate').at(-1);
    expect(renamed?.event.case === 'taskUpdate' ? renamed.event.value.task?.title : '').toBe('Переименовал Борис');
    vera.close();
  });

  it('approvals (ADR-0049): the seeded CAL-6, the forward gate, votes, veto, reset on a new title', async () => {
    server.reset();
    const anna = await login();
    const boris = await login('boris@calaba.test');
    const cal = (await json<{ boards: BoardJ[] }>(api(anna, `/api/workspaces/${IDS.workspaces.main}/boards`))).boards[0] as BoardJ;
    const st = (name: string): string => cal.statuses.find((s) => s.name === name)?.id ?? '';
    type ApprovalJ = TaskJ & { approvers?: { userId: string; state?: string; comment?: string }[]; approvalState?: string };
    const cal6 = (await json<{ tasks: ApprovalJ[] }>(api(anna, `/api/boards/${cal.id}/tasks`))).tasks.find((t) => t.key === 'CAL-6') as ApprovalJ;
    expect(cal6.approvalState).toBe('TASK_APPROVAL_STATE_PENDING');
    expect(cal6.approvers?.map((a) => a.state)).toEqual(['APPROVER_STATE_APPROVED', 'APPROVER_STATE_PENDING']);
    // Forward (Готово) refused with the counts; back (Todo) and Отменено are fine.
    const refused = await api(anna, `/api/tasks/${cal6.id}`, { method: 'PATCH', body: { statusId: st('Готово') } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: 'TASK_APPROVAL_REQUIRED' });
    expect((await api(anna, `/api/tasks/${cal6.id}`, { method: 'PATCH', body: { statusId: st('Todo') } })).status).toBe(200);
    // ADR-0160: with the board's gate off the same move goes through, the votes stay.
    expect((await api(anna, `/api/boards/${cal.id}`, { method: 'PATCH', body: { approvalGate: 'APPROVAL_GATE_OFF' } })).status).toBe(200);
    const moved = await json<{ task: ApprovalJ }>(api(anna, `/api/tasks/${cal6.id}`, { method: 'PATCH', body: { statusId: st('Готово') } }));
    expect(moved.task.approvers?.map((a) => a.state)).toEqual(['APPROVER_STATE_APPROVED', 'APPROVER_STATE_PENDING']);
    expect((await api(anna, `/api/tasks/${cal6.id}`, { method: 'PATCH', body: { statusId: st('Todo') } })).status).toBe(200);
    expect((await api(anna, `/api/boards/${cal.id}`, { method: 'PATCH', body: { approvalGate: 'APPROVAL_GATE_HOLD' } })).status).toBe(200);
    // Борис approves: the quorum («все») is reached, the move goes through.
    const ok = await json<{ task: ApprovalJ }>(api(boris, `/api/tasks/${cal6.id}/approval`, { method: 'POST', body: { decision: 'TASK_APPROVAL_DECISION_APPROVE' } }));
    expect(ok.task.approvalState).toBe('TASK_APPROVAL_STATE_APPROVED');
    // A new title resets the votes; a veto needs a comment.
    await api(anna, `/api/tasks/${cal6.id}`, { method: 'PATCH', body: { title: 'Ревью прав v2' } });
    expect((await api(boris, `/api/tasks/${cal6.id}/approval`, { method: 'POST', body: { decision: 'TASK_APPROVAL_DECISION_REJECT' } })).status).toBe(422);
    const vetoed = await json<{ task: ApprovalJ }>(api(boris, `/api/tasks/${cal6.id}/approval`, { method: 'POST', body: { decision: 'TASK_APPROVAL_DECISION_REJECT', comment: 'Нет тестов' } }));
    expect(vetoed.task.approvalState).toBe('TASK_APPROVAL_STATE_REJECTED');
    // Not an approver → 403; the list: a guest → 422, the quorum above the count → 422.
    const vera = await login('vera@calaba.test');
    expect((await api(vera, `/api/tasks/${cal6.id}/approval`, { method: 'POST', body: { decision: 'TASK_APPROVAL_DECISION_APPROVE' } })).status).toBe(403);
    expect((await api(anna, `/api/tasks/${cal6.id}/approvers`, { method: 'PUT', body: { userIds: [IDS.users.dina] } })).status).toBe(422);
    expect((await api(anna, `/api/tasks/${cal6.id}/approvers`, { method: 'PUT', body: { userIds: [IDS.users.boris], required: 2 } })).status).toBe(422);
    const cleared = await json<{ task: ApprovalJ }>(api(anna, `/api/tasks/${cal6.id}/approvers`, { method: 'PUT', body: { userIds: [] } }));
    expect(cleared.task.approvalState).toBe('TASK_APPROVAL_STATE_NONE');
  });
});

describe('boards 2.0 mock (ADR-0058)', () => {
  it('READY board categories; create / order / delete a category', async () => {
    const token = await login();
    const gw = await gateway(token);
    try {
      const ws = gw.ready.workspaces.find((w) => w.workspace?.id === IDS.workspaces.main);
      expect(ws?.boardCategories.map((c) => c.name)).toEqual(['Продвижение']);
      const mkt = ws?.boards.find((b) => b.key === 'MKT');
      expect(mkt?.categoryId).toBe(ws?.boardCategories[0]?.id);
      const made = await json<{ category: { id: string } }>(api(token, `/api/workspaces/${IDS.workspaces.main}/board-categories`, { method: 'POST', body: { name: 'Новая' } }));
      const cal = ws?.boards.find((b) => b.key === 'CAL');
      const order = await api(token, `/api/workspaces/${IDS.workspaces.main}/boards/order`, { method: 'PUT', body: { boards: [{ boardId: cal?.id, categoryId: made.category.id, position: 0 }], categories: [{ categoryId: made.category.id, position: 0 }] } });
      expect(order.status).toBe(200);
      await wait(50);
      expect(gw.events.some((e) => e.event.case === 'boardCategoryCreate')).toBe(true);
      expect(gw.events.some((e) => e.event.case === 'boardUpdate' && e.event.value.board?.categoryId === made.category.id)).toBe(true);
      expect((await api(token, `/api/board-categories/${made.category.id}`, { method: 'DELETE' })).status).toBe(204);
      await wait(50);
      expect(gw.events.some((e) => e.event.case === 'boardCategoryDelete')).toBe(true);
    } finally {
      gw.close();
    }
  });

  it('a checklist tick sends TASK_CHECKLIST_UPDATE with the counters and no TASK_UPDATE', async () => {
    const token = await login();
    const t3 = await json<{ task: { id: string; checklistTotal: number; checklistDone: number; checklists: { id: string; items: { id: string; done?: boolean }[] }[] } }>(api(token, '/api/t/CAL-3'));
    expect(t3.task.checklistTotal).toBe(3);
    expect(t3.task.checklistDone).toBe(1);
    const second = t3.task.checklists[0]?.items[1]?.id ?? '';
    const gw = await gateway(token);
    try {
      const r = await json<{ checklistDone: number }>(api(token, `/api/checklist-items/${second}`, { method: 'PATCH', body: { done: true } }));
      expect(r.checklistDone).toBe(2);
      await wait(50);
      expect(gw.events.filter((e) => e.event.case === 'taskChecklistUpdate')).toHaveLength(1);
      expect(gw.events.some((e) => e.event.case === 'taskUpdate')).toBe(false);
    } finally {
      gw.close();
    }
  });

  it('features: a disabled one refuses writes (409 FEATURE_DISABLED with the field); webhook on Team is 409 PLAN_LIMIT', async () => {
    const token = await login();
    const boards = await json<{ boards: { id: string; key: string }[] }>(api(token, `/api/workspaces/${IDS.workspaces.main}/boards`));
    const cal = boards.boards.find((b) => b.key === 'CAL')?.id ?? '';
    const patched = await json<{ board: { disabledFeatures: string[]; estimateScale: string } }>(api(token, `/api/boards/${cal}`, { method: 'PATCH', body: { setDisabledFeatures: true, disabledFeatures: ['BOARD_FEATURE_ESTIMATE'], estimateScale: 'ESTIMATE_SCALE_TSHIRT' } }));
    expect(patched.board.disabledFeatures).toEqual(['BOARD_FEATURE_ESTIMATE']);
    expect(patched.board.estimateScale).toBe('ESTIMATE_SCALE_TSHIRT');
    const t3 = await json<{ task: { id: string } }>(api(token, '/api/t/CAL-3'));
    const refused = await api(token, `/api/tasks/${t3.task.id}`, { method: 'PATCH', body: { estimate: 5 } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ field: 'estimate', reason: 'FEATURE_DISABLED' });
    await api(token, `/api/boards/${cal}`, { method: 'PATCH', body: { setDisabledFeatures: true, disabledFeatures: [], estimateScale: 'ESTIMATE_SCALE_FIBONACCI' } });
    const hook = await api(token, `/api/boards/${cal}/webhook`, { method: 'PUT', body: { url: 'https://hooks.example.com/calab', secret: '' } });
    expect(hook.status).toBe(409);
    expect((await json<{ webhook?: unknown }>(api(token, `/api/boards/${cal}/webhook`))).webhook).toBeUndefined();
  });

  it('task search (ADR-0139): words, a board filter, the archive, key_task, saved searches', async () => {
    const token = await login();
    const ws = IDS.workspaces.main;
    const boards = (await json<{ boards: BoardJ[] }>(api(token, `/api/workspaces/${ws}/boards`))).boards;
    const cal = boards.find((b) => b.key === 'CAL')?.id ?? '';
    const find = (qs: string): Promise<{ tasks?: TaskJ[]; keyTask?: TaskJ; nextCursor?: string }> => json(api(token, `/api/workspaces/${ws}/tasks/search?${qs}`));
    const all = await find('q=' + encodeURIComponent('доск') + '&state=all&archived=1');
    const keys = all.tasks?.map((t) => t.key) ?? [];
    expect(keys).toEqual(expect.arrayContaining(['CAL-1', 'MKT-1']));
    const filter = encodeURIComponent(JSON.stringify({ conditions: [{ field: 'TASK_FIELD_BOARD', op: 'TASK_OP_IS', values: [cal] }] }));
    expect((await find('q=' + encodeURIComponent('доск') + '&archived=1&filter=' + filter)).tasks).toHaveLength(keys.filter((k) => k.startsWith('CAL-')).length);
    const keyed = await find('q=CAL-3&state=all&archived=1&filter=' + filter);
    expect(keyed.keyTask?.key).toBe('CAL-3');
    const key = await find('q=cal-3&archived=only');
    expect(key.keyTask?.key).toBe('CAL-3');
    expect(key.tasks ?? []).toHaveLength(0);
    const saved = await json<{ search: { id: string; name: string } }>(api(token, `/api/workspaces/${ws}/task-searches`, { method: 'POST', body: { name: 'Мои', query: { q: 'доск' } } }));
    expect(saved.search.name).toBe('Мои');
    expect((await json<{ searches: unknown[] }>(api(token, `/api/workspaces/${ws}/task-searches`))).searches).toHaveLength(1);
    expect((await api(token, `/api/workspaces/${ws}/task-searches/${saved.search.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('task notice history (ADR-0141)', () => {
  it('a comment mention lands in the mentioned user’s GET /api/me/task-notices', async () => {
    const token = await login();
    const t = server.boards.taskByKey('CAL-3');
    if (!t) throw new Error('CAL-3 is not seeded');
    server.injectMessage({ roomId: t.task.roomId, authorId: IDS.users.vera, content: `@${IDS.users.anna} проверишь?` });
    const r = await json<{ entries: Array<{ taskKey: string; notice: { actorId: string } }> }>(api(token, '/api/me/task-notices'));
    expect(r.entries[0]?.taskKey).toBe('CAL-3');
    expect(r.entries[0]?.notice.actorId).toBe(IDS.users.vera);
  });
});
