import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { BoardRuleSchema, DispatchEventSchema, TaskGitLinkKind, TaskGitLinkSchema, TaskSchema, type BoardRule } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// services/automations.ts on the gateway events 92–94 (ADR-0060), with the stores it writes.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false });
vi.stubGlobal('window', globalThis);
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined, openExternal: () => Promise.resolve() } } }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), fail: vi.fn() }, useToasts: { getState: () => ({ push: vi.fn() }) } }));
const list = vi.fn<(boardId: string) => Promise<{ rules: BoardRule[] }>>();
const update = vi.fn<(id: string, init: unknown) => Promise<{ rule?: BoardRule }>>();
vi.mock('./automationsApi', () => ({ automationsApi: { rules: { list: (id: string) => list(id), update: (id: string, init: unknown) => update(id, init) } } }));

const { applyAutomationEvent, ensureRules, moveRule, setRuleEnabled } = await import('./automations');
const { useAutomations, ruleIdsOf, gitLinksOf } = await import('../stores/automations');
const { useBoards } = await import('../stores/boards');

const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;
const rule = (id: string, position: number, p: MessageInitShape<typeof BoardRuleSchema> = {}): BoardRule => create(BoardRuleSchema, { id, boardId: 'b1', name: id, position, enabled: true, ...p });

describe('gateway events 92–94 → the store', () => {
  beforeEach(() => {
    useAutomations.getState().reset();
    useBoards.getState().reset();
    list.mockReset();
    update.mockReset();
  });

  it('BOARD_RULE_UPDATE replaces one rule: the other rows and the order keep their references', () => {
    useAutomations.getState().setBoardRules('b1', [rule('a', 0), rule('b', 1), rule('c', 2)]);
    const before = useAutomations.getState();
    expect(applyAutomationEvent(ev({ event: { case: 'boardRuleUpdate', value: { workspaceId: 'w', boardId: 'b1', rule: rule('b', 1, { lastError: 'RULE_LOOP' }) } } }))).toBe(true);
    const after = useAutomations.getState();
    const changed = ['a', 'b', 'c'].filter((id) => after.rules[id] !== before.rules[id]);
    expect(changed).toEqual(['b']);
    expect(ruleIdsOf(after, 'b1')).toBe(ruleIdsOf(before, 'b1'));
  });

  it('BOARD_RULE_UPDATE of a new rule appends it; BOARD_RULE_DELETE removes it', () => {
    useAutomations.getState().setBoardRules('b1', [rule('a', 0)]);
    applyAutomationEvent(ev({ event: { case: 'boardRuleUpdate', value: { workspaceId: 'w', boardId: 'b1', rule: rule('n', 1) } } }));
    expect(ruleIdsOf(useAutomations.getState(), 'b1')).toEqual(['a', 'n']);
    applyAutomationEvent(ev({ event: { case: 'boardRuleDelete', value: { workspaceId: 'w', boardId: 'b1', ruleId: 'a' } } }));
    expect(ruleIdsOf(useAutomations.getState(), 'b1')).toEqual(['n']);
  });

  it('TASK_GIT_LINKS_UPDATE: links of a task shown in the panel, the counter of a loaded card', () => {
    const link = create(TaskGitLinkSchema, { id: 'l1', taskId: 't1', kind: TaskGitLinkKind.PR, repo: 'org/app', ref: '42' });
    const e = ev({ event: { case: 'taskGitLinksUpdate', value: { workspaceId: 'w', boardId: 'b1', taskId: 't1', links: [link], count: 1 } } });
    // Neither in the panel nor on a loaded board: nothing kept.
    applyAutomationEvent(e);
    expect(gitLinksOf(useAutomations.getState(), 't1')).toEqual([]);
    expect(useAutomations.getState().gitCounts['t1']).toBeUndefined();
    // The panel loaded the task (GET /tasks/{id}) and its card is on the board.
    useAutomations.getState().setGitLinks('t1', [], true);
    useBoards.getState().upsertTask(create(TaskSchema, { id: 't1', boardId: 'b1', workspaceId: 'w', statusId: 's' }));
    const task = useBoards.getState().tasks['t1'];
    applyAutomationEvent(e);
    expect(gitLinksOf(useAutomations.getState(), 't1').map((l) => l.id)).toEqual(['l1']);
    expect(useAutomations.getState().gitCounts['t1']).toBe(1);
    // The card object is untouched: only the chip leaf reads the counter.
    expect(useBoards.getState().tasks['t1']).toBe(task);
  });

  it('other events are not ours', () => {
    expect(applyAutomationEvent(ev({ event: { case: 'boardDelete', value: { workspaceId: 'w', boardId: 'b1' } } }))).toBe(false);
  });
});

describe('rules REST', () => {
  beforeEach(() => {
    useAutomations.getState().reset();
    list.mockReset();
    update.mockReset();
  });

  it('loads a board once (the tab and activity rows share it)', async () => {
    list.mockResolvedValue({ rules: [rule('a', 0)] });
    await Promise.all([ensureRules('b1'), ensureRules('b1')]);
    await ensureRules('b1');
    expect(list).toHaveBeenCalledTimes(1);
    expect(useAutomations.getState().load['b1']).toBe('ready');
    await ensureRules('b1', true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('the switch is optimistic and rolls back on a refusal', async () => {
    useAutomations.getState().setBoardRules('b1', [rule('a', 0)]);
    update.mockRejectedValueOnce(new Error('boom'));
    const p = setRuleEnabled('w', 'a', false);
    expect(useAutomations.getState().rules['a']?.enabled).toBe(false);
    await p;
    expect(useAutomations.getState().rules['a']?.enabled).toBe(true);
  });

  it('a drag sends the new position of the moved rule', async () => {
    useAutomations.getState().setBoardRules('b1', [rule('a', 0), rule('b', 1), rule('c', 2)]);
    update.mockResolvedValue({ rule: rule('c', 0) });
    await moveRule('w', 'b1', 'c', ['c', 'a', 'b']);
    expect(update).toHaveBeenCalledWith('c', { position: 0 });
    expect(ruleIdsOf(useAutomations.getState(), 'b1')).toEqual(['c', 'a', 'b']);
  });
});
