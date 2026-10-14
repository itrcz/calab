import { create } from '@bufbuild/protobuf';
import {
  BoardRuleSchema,
  RuleActionSchema,
  RuleAssigneesMode,
  RuleGitEvent,
  RuleRecipients,
  RuleSpecialUser,
  RuleTriggerSchema,
  TaskApprovalState,
  TaskConditionSchema,
  TaskFilterSchema,
  TaskPriority,
  type RuleAction,
  type RuleTrigger,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { actionText, ruleSummary, triggerText, type SummaryCtx } from './ruleSummary';

// ADR-0060 §6: the list's «Когда … → тогда …», generated from the rule (ru is the default locale).
const names: Record<string, string> = { todo: 'К выполнению', doing: 'В работе', done: 'Готово', bug: 'Баг', u1: 'Аня', u2: 'Борис', r1: 'general' };
const ctx: SummaryCtx = { status: (id) => names[id], label: (id) => names[id], user: (id) => names[id], room: (id) => names[id] };
const trg = (kind: RuleTrigger['kind']): RuleTrigger => create(RuleTriggerSchema, { kind });
const act = (kind: RuleAction['kind']): RuleAction => create(RuleActionSchema, { kind });

describe('triggerText', () => {
  it('names every trigger with its parameters', () => {
    expect(triggerText(trg({ case: 'taskCreated', value: {} } as RuleTrigger['kind']), ctx)).toBe('создана задача');
    expect(triggerText(trg({ case: 'statusChanged', value: { toStatusId: 'done' } } as RuleTrigger['kind']), ctx)).toBe('статус → «Готово»');
    expect(triggerText(trg({ case: 'statusChanged', value: { fromStatusId: 'todo', toStatusId: 'doing' } } as RuleTrigger['kind']), ctx)).toBe('статус «К выполнению» → «В работе»');
    expect(triggerText(trg({ case: 'statusChanged', value: {} } as RuleTrigger['kind']), ctx)).toBe('изменён статус');
    expect(triggerText(trg({ case: 'approvalChanged', value: { state: TaskApprovalState.REJECTED } } as RuleTrigger['kind']), ctx)).toBe('отклонено');
    expect(triggerText(trg({ case: 'assigneesChanged', value: { added: true, lead: true } } as RuleTrigger['kind']), ctx)).toBe('добавлен исполнитель или сменился ответственный');
    expect(triggerText(trg({ case: 'labelChanged', value: { labelId: 'bug', added: true } } as RuleTrigger['kind']), ctx)).toBe('добавлен лейбл «Баг»');
    expect(triggerText(trg({ case: 'labelChanged', value: { labelId: '', added: false } } as RuleTrigger['kind']), ctx)).toBe('снят лейбл');
    expect(triggerText(trg({ case: 'priorityChanged', value: { toPriority: TaskPriority.URGENT } } as RuleTrigger['kind']), ctx)).toBe('приоритет → Срочно');
    expect(triggerText(trg({ case: 'git', value: { event: RuleGitEvent.PR_MERGED } } as RuleTrigger['kind']), ctx)).toBe('PR смержен');
    expect(triggerText(trg({ case: 'dueIn', value: { days: 0 } } as RuleTrigger['kind']), ctx)).toBe('срок сегодня');
    expect(triggerText(trg({ case: 'overdue', value: { days: 3 } } as RuleTrigger['kind']), ctx)).toBe('просрочена на 3 дн.');
    expect(triggerText(trg({ case: 'stale', value: { days: 14 } } as RuleTrigger['kind']), ctx)).toBe('без движения 14 дн.');
    expect(triggerText(undefined, ctx)).toBe('—');
  });

  it('shows «?» for a reference that no longer resolves', () => {
    expect(triggerText(trg({ case: 'statusChanged', value: { toStatusId: 'gone' } } as RuleTrigger['kind']), ctx)).toBe('статус → «?»');
  });
});

describe('actionText', () => {
  it('names every action', () => {
    expect(actionText(act({ case: 'setStatus', value: { statusId: 'doing' } } as RuleAction['kind']), ctx)).toBe('статус → «В работе»');
    expect(actionText(act({ case: 'setAssignees', value: { mode: RuleAssigneesMode.SET, userIds: ['u1'], special: RuleSpecialUser.CREATOR } } as RuleAction['kind']), ctx)).toBe('назначить: Аня, автор');
    expect(actionText(act({ case: 'setAssignees', value: { mode: RuleAssigneesMode.CLEAR } } as RuleAction['kind']), ctx)).toBe('снять всех исполнителей');
    expect(actionText(act({ case: 'setLabels', value: { addIds: ['bug'], removeIds: ['x'] } } as RuleAction['kind']), ctx)).toBe('лейблы +Баг −?');
    expect(actionText(act({ case: 'setDue', value: { daysFromNow: 2 } } as RuleAction['kind']), ctx)).toBe('срок через 2 дн.');
    expect(actionText(act({ case: 'setDue', value: { clear: true } } as RuleAction['kind']), ctx)).toBe('убрать срок');
    expect(actionText(act({ case: 'notifyRoom', value: { roomId: 'r1', template: 'x' } } as RuleAction['kind']), ctx)).toBe('сообщение в #general');
    expect(actionText(act({ case: 'notifyDm', value: { to: RuleRecipients.LEAD, template: 'x' } } as RuleAction['kind']), ctx)).toBe('уведомить ответственного');
    expect(actionText(act({ case: 'createSubtasks', value: { titles: ['a', ' ', 'b'] } } as RuleAction['kind']), ctx)).toBe('подзадачи: 2');
    expect(actionText(act({ case: 'archive', value: {} } as RuleAction['kind']), ctx)).toBe('в архив');
  });
});

describe('ruleSummary', () => {
  it('joins the trigger, the condition count and the actions', () => {
    const rule = create(BoardRuleSchema, {
      trigger: trg({ case: 'git', value: { event: RuleGitEvent.PR_OPENED } } as RuleTrigger['kind']),
      actions: [act({ case: 'setStatus', value: { statusId: 'doing' } } as RuleAction['kind']), act({ case: 'comment', value: { template: 'x' } } as RuleAction['kind'])],
    });
    expect(ruleSummary(rule, ctx)).toBe('Когда открыт PR → тогда статус → «В работе», комментарий');
    const withCond = { ...rule, condition: create(TaskFilterSchema, { conditions: [create(TaskConditionSchema, {}), create(TaskConditionSchema, {})] }) };
    expect(ruleSummary(withCond, ctx)).toBe('Когда открыт PR, если 2 усл. → тогда статус → «В работе», комментарий');
  });
});
