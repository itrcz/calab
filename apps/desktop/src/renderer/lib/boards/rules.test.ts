import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { BoardRuleSchema, BoardStatusSchema, BoardStatusType, RuleAssigneesMode, RuleGitEvent, RuleRecipients, RuleSpecialUser, TaskApprovalState, TaskPriority, type BoardRule } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RULES,
  TEMPLATES,
  actionIssue,
  blankAction,
  blankTrigger,
  emptyDraft,
  fromTemplate,
  issueAtField,
  moveTo,
  removeRule,
  reorderRules,
  setBoardRules,
  upsertRule,
  validateDraft,
  wireActions,
  type RuleDraft,
} from './rules';

const st = (id: string, name: string, type: BoardStatusType, position: number) => create(BoardStatusSchema, { id, name, type, position });
const statuses = [st('todo', 'К выполнению', BoardStatusType.UNSTARTED, 0), st('doing', 'В работе', BoardStatusType.STARTED, 1), st('review', 'На ревью', BoardStatusType.STARTED, 2), st('done', 'Готово', BoardStatusType.COMPLETED, 3)];

const draft = (p: Partial<RuleDraft> = {}): RuleDraft => ({ ...emptyDraft(), name: 'R', ...p });
const setStatus = (statusId: string) => {
  const a = blankAction('setStatus');
  return { ...a, kind: { case: 'setStatus' as const, value: { ...(a.kind.value as object), statusId } } } as typeof a;
};

describe('validateDraft (the editor, ADR-0060 §3)', () => {
  it('a complete draft has no issues', () => {
    expect(validateDraft(draft({ actions: [setStatus('done')] }))).toEqual([]);
  });

  it('needs a name of 1..60 characters', () => {
    expect(validateDraft(draft({ name: '  ', actions: [setStatus('done')] })).map((i) => i.at)).toEqual(['name']);
    expect(validateDraft(draft({ name: 'x'.repeat(61), actions: [setStatus('done')] })).map((i) => i.at)).toEqual(['name']);
  });

  it('needs 1..5 actions', () => {
    expect(validateDraft(draft({ actions: [] })).map((i) => i.at)).toEqual(['actions']);
    const six = Array.from({ length: 6 }, () => setStatus('done'));
    expect(validateDraft(draft({ actions: six })).map((i) => i.at)).toEqual(['actions']);
    expect(validateDraft(draft({ actions: six.slice(0, 5) }))).toEqual([]);
  });

  it('checks the days of scheduled triggers', () => {
    const stale = blankTrigger('stale');
    const bad = { ...stale, kind: { case: 'stale' as const, value: { ...(stale.kind.value as object), days: 0 } } } as typeof stale;
    expect(validateDraft(draft({ trigger: bad, actions: [setStatus('done')] })).map((i) => i.at)).toEqual(['trigger']);
    const due = blankTrigger('dueIn');
    const far = { ...due, kind: { case: 'dueIn' as const, value: { ...(due.kind.value as object), days: 31 } } } as typeof due;
    expect(validateDraft(draft({ trigger: far, actions: [setStatus('done')] })).map((i) => i.at)).toEqual(['trigger']);
  });

  it('marks the action that misses a required field', () => {
    const issues = validateDraft(draft({ actions: [setStatus('done'), blankAction('setStatus'), blankAction('comment')] }));
    expect(issues).toEqual([
      { at: 'action:1', key: 'rules.err.status' },
      { at: 'action:2', key: 'rules.err.text' },
    ]);
  });

  it('knows the required fields of each action kind', () => {
    const with_ = (kind: Parameters<typeof blankAction>[0], value: object) => {
      const a = blankAction(kind);
      return { ...a, kind: { case: kind, value: { ...(a.kind.value as object), ...value } } } as typeof a;
    };
    expect(actionIssue(blankAction('setAssignees'))).toBe('rules.err.users');
    expect(actionIssue(with_('setAssignees', { special: RuleSpecialUser.CREATOR }))).toBeNull();
    expect(actionIssue(with_('setAssignees', { mode: RuleAssigneesMode.CLEAR }))).toBeNull();
    expect(actionIssue(with_('setAssignees', { userIds: Array.from({ length: 11 }, (_, i) => `u${i}`) }))).toBe('rules.err.users');
    expect(actionIssue(blankAction('setLabels'))).toBe('rules.err.labels');
    expect(actionIssue(with_('setLabels', { removeIds: ['l'] }))).toBeNull();
    expect(actionIssue(blankAction('setPriority'))).toBeNull();
    expect(actionIssue(with_('setDue', { daysFromNow: 400 }))).toBe('rules.err.days');
    expect(actionIssue(with_('setDue', { daysFromNow: 400, clear: true }))).toBeNull();
    expect(actionIssue(blankAction('addChecklist'))).toBe('rules.err.checklist');
    expect(actionIssue(with_('addChecklist', { name: 'QA', items: ['a', '', 'b'] }))).toBeNull();
    expect(actionIssue(with_('comment', { template: 'x'.repeat(2001) }))).toBe('rules.err.text');
    expect(actionIssue(with_('notifyRoom', { template: 'hi' }))).toBe('rules.err.room');
    expect(actionIssue(with_('notifyRoom', { template: 'hi', roomId: 'r' }))).toBeNull();
    expect(actionIssue(with_('notifyDm', { to: RuleRecipients.UNSPECIFIED, template: 'hi' }))).toBe('rules.err.to');
    expect(actionIssue(with_('createSubtasks', { titles: Array.from({ length: 11 }, () => 't') }))).toBe('rules.err.subtasks');
    expect(actionIssue(with_('createSubtasks', { titles: ['a', ''] }))).toBeNull();
    expect(actionIssue(blankAction('archive'))).toBeNull();
  });

  it('counts code points like the server (an emoji is one)', () => {
    expect(validateDraft(draft({ name: '🚀'.repeat(60), actions: [setStatus('done')] }))).toEqual([]);
  });

  it('drops empty lines of multi-line fields on the wire', () => {
    const a = blankAction('createSubtasks');
    const typed = { ...a, kind: { case: 'createSubtasks' as const, value: { titles: [' a ', '', 'b'] } } } as typeof a;
    expect(wireActions([typed])[0]?.kind.value).toMatchObject({ titles: ['a', 'b'] });
  });

  it('maps a 422 field to its block', () => {
    expect(issueAtField('actions[2].setStatus.statusId')).toBe('action:2');
    expect(issueAtField('actions')).toBe('actions');
    expect(issueAtField('trigger.statusChanged.toStatusId')).toBe('trigger');
    expect(issueAtField('name')).toBe('name');
    expect(issueAtField('condition')).toBeNull();
    expect(issueAtField(undefined)).toBeNull();
  });
});

describe('templates (ADR-0060 §2)', () => {
  it('has the eight presets', () => {
    expect(TEMPLATES.map((x) => x.id)).toEqual(['approvedToWork', 'rejectedBack', 'checklistDone', 'prOpenedReview', 'prMergedDone', 'overdueUrgent', 'newTaskAssign', 'staleRemind']);
  });

  it('resolves statuses of the board by type and by name', () => {
    const approved = fromTemplate('approvedToWork', statuses);
    expect(approved.trigger.kind).toMatchObject({ case: 'approvalChanged', value: { state: TaskApprovalState.APPROVED } });
    expect(approved.actions[0]?.kind).toMatchObject({ case: 'setStatus', value: { statusId: 'doing' } });
    expect(fromTemplate('prOpenedReview', statuses).actions[0]?.kind).toMatchObject({ value: { statusId: 'review' } });
    expect(fromTemplate('prMergedDone', statuses).trigger.kind).toMatchObject({ case: 'git', value: { event: RuleGitEvent.PR_MERGED } });
    expect(fromTemplate('prMergedDone', statuses).actions[0]?.kind).toMatchObject({ value: { statusId: 'done' } });
    expect(fromTemplate('overdueUrgent', statuses).actions.map((a) => a.kind.case)).toEqual(['setPriority', 'comment']);
    expect(fromTemplate('overdueUrgent', statuses).actions[0]?.kind).toMatchObject({ value: { priority: TaskPriority.URGENT } });
  });

  it('leaves a field the board cannot fill for the user', () => {
    const noReview = statuses.filter((s) => s.id !== 'review');
    const d = fromTemplate('prOpenedReview', noReview);
    expect(d.actions[0]?.kind).toMatchObject({ value: { statusId: '' } });
    expect(validateDraft(d).map((i) => i.at)).toEqual(['action:0']);
    // «назначить …»: nobody picked yet.
    expect(validateDraft(fromTemplate('newTaskAssign', statuses)).map((i) => i.at)).toEqual(['action:0']);
  });

  it('every template is valid on a full board except «назначить …»', () => {
    for (const x of TEMPLATES) if (x.id !== 'newTaskAssign') expect(validateDraft(fromTemplate(x.id, statuses)), x.id).toEqual([]);
  });
});

describe('store transitions', () => {
  const rule = (id: string, position: number, p: MessageInitShape<typeof BoardRuleSchema> = {}): BoardRule => create(BoardRuleSchema, { id, boardId: 'b1', name: id, position, enabled: true, ...p });

  it('loads a board and keeps other boards', () => {
    let d = setBoardRules(EMPTY_RULES, 'b2', [create(BoardRuleSchema, { id: 'x', boardId: 'b2' })]);
    d = setBoardRules(d, 'b1', [rule('b', 1), rule('a', 0)]);
    expect(d.order['b1']).toEqual(['a', 'b']);
    expect(d.rules['x']).toBeDefined();
  });

  it('an update replaces one rule and keeps the order list', () => {
    const d = setBoardRules(EMPTY_RULES, 'b1', [rule('a', 0), rule('b', 1), rule('c', 2)]);
    const next = upsertRule(d, rule('b', 1, { name: 'B', lastError: 'RULE_LOOP' }));
    expect(next.order['b1']).toBe(d.order['b1']);
    expect(next.rules['a']).toBe(d.rules['a']);
    expect(next.rules['c']).toBe(d.rules['c']);
    expect(next.rules['b']?.lastError).toBe('RULE_LOOP');
  });

  it('a new rule or a moved one re-sorts the board', () => {
    let d = setBoardRules(EMPTY_RULES, 'b1', [rule('a', 0), rule('b', 1)]);
    d = upsertRule(d, rule('c', 2));
    expect(d.order['b1']).toEqual(['a', 'b', 'c']);
    d = upsertRule(d, rule('c', -1));
    expect(d.order['b1']).toEqual(['c', 'a', 'b']);
  });

  it('a rule of a board not loaded is kept for its name only', () => {
    const d = upsertRule(EMPTY_RULES, rule('a', 0));
    expect(d.rules['a']?.name).toBe('a');
    expect(d.order['b1']).toBeUndefined();
  });

  it('delete and reorder', () => {
    let d = setBoardRules(EMPTY_RULES, 'b1', [rule('a', 0), rule('b', 1), rule('c', 2)]);
    d = reorderRules(d, 'b1', moveTo(d.order['b1'] ?? [], 2, 0));
    expect(d.order['b1']).toEqual(['c', 'a', 'b']);
    expect(d.rules['c']?.position).toBe(0);
    d = removeRule(d, 'a');
    expect(d.order['b1']).toEqual(['c', 'b']);
    expect(d.rules['a']).toBeUndefined();
  });

  it('a reload with the same rules keeps their objects', () => {
    const list = [rule('a', 0), rule('b', 1)];
    const d = setBoardRules(EMPTY_RULES, 'b1', list);
    const again = setBoardRules(d, 'b1', [rule('a', 0), rule('b', 1)]);
    expect(again.rules['a']).toBe(d.rules['a']);
    expect(again.order['b1']).toBe(d.order['b1']);
  });
});
