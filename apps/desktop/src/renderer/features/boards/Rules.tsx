import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Plan, type Board } from '@calaba/protocol';
import { ChevronDown, Ellipsis, GripVertical, History, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Spinner, Tip, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { planHas } from '../../lib/plan';
import { MAX_RULES, TEMPLATES, draftOf, emptyDraft, fromTemplate, moveTo, type RuleDraft } from '../../lib/boards/rules';
import { ruleSummary } from '../../lib/boards/ruleSummary';
import { deleteRule, ensureRules, moveRule, setRuleEnabled } from '../../services/automations';
import { openPlanContact, planContact } from '../../services/plan';
import { ruleIdsOf, useAutomations } from '../../stores/automations';
import { useBoards } from '../../stores/boards';
import { useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { PlanPill } from '../workspace/PlanTab';
import { RuleEditor } from './RuleEditor';
import { RuleRuns } from './RuleRuns';
import { summaryCtx } from './ruleCtx';

/**
 * Board settings → «Автоматизации» (ADR-0060 §6, docs/08 «Доски»): the board's rules as rows —
 * switch, name, the generated «Когда … → тогда …», runs and the last run, «⚠» on an error; drag
 * to reorder; «+ Правило» and «Из шаблона ▾» (eight presets, statuses of this board resolved);
 * a row opens the editor sheet, ⋯ — the run log and delete. Rules load when the tab opens; a
 * BOARD_RULE_UPDATE replaces one rule, so one row re-renders (rows are memo and select by id).
 * Below Team: the plan pill and why, every control read-only.
 */
export function RulesTab({ board }: { board: Board }): ReactNode {
  const plan = useWorkspaces((s) => s.byId[board.workspaceId]?.ws.plan);
  const allowed = planHas(plan, 'automations');
  const readOnly = !allowed;
  const state = useAutomations((s) => s.load[board.id]);
  const ids = useAutomations((s) => ruleIdsOf(s, board.id));
  const [editing, setEditing] = useState<{ ruleId: string | null; draft: RuleDraft } | null>(null);
  const [runsOf, setRunsOf] = useState<string | null>(null);
  useEffect(() => {
    void ensureRules(board.id, true);
  }, [board.id]);
  const edit = useCallback((ruleId: string) => {
    const r = useAutomations.getState().rules[ruleId];
    if (r) setEditing({ ruleId, draft: draftOf(r) });
  }, []);
  // Drag & drop: the dragged id in a ref, the drop line as a primitive per row.
  const dragId = useRef<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const onDragStart = useCallback((id: string) => {
    dragId.current = id;
  }, []);
  const onDragOver = useCallback((index: number) => {
    if (dragId.current !== null) setOver(index);
  }, []);
  const onDrop = useCallback(
    (index: number) => {
      const id = dragId.current;
      dragId.current = null;
      setOver(null);
      const list = ruleIdsOf(useAutomations.getState(), board.id);
      const from = id ? list.indexOf(id) : -1;
      if (!id || from < 0 || from === index || from + 1 === index) return;
      void moveRule(board.workspaceId, board.id, id, moveTo(list, from, from < index ? index - 1 : index));
    },
    [board.id, board.workspaceId],
  );
  const onDragEnd = useCallback(() => {
    dragId.current = null;
    setOver(null);
  }, []);
  const statuses = board.statuses;
  const editor = editing ? <RuleEditor board={board} rule={editing.ruleId ? (useAutomations.getState().rules[editing.ruleId] ?? null) : null} initial={editing.draft} readOnly={readOnly} onClose={() => setEditing(null)} /> : null;
  return (
    <>
      {allowed ? null : <PlanNote />}
      <section className="flex flex-col gap-1.5" data-testid="rules-tab">
        <h3 className="px-1 text-caption font-semibold text-muted">{t('rules.card')}</h3>
        <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {state === 'error' ? (
            <p className="px-3 py-3 text-body text-danger-text">{t('rules.loadFailed')}</p>
          ) : state !== 'ready' && ids.length === 0 ? (
            <div className="grid h-16 place-items-center">
              <Spinner />
            </div>
          ) : ids.length === 0 ? (
            <p className="px-3 py-3 text-body text-muted" data-testid="rules-empty">
              {t('rules.empty')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-card-line)]" data-testid="rules-list" onDragOver={(e) => dragId.current !== null && e.preventDefault()} onDrop={(e) => e.preventDefault()}>
              {ids.map((id, i) => (
                <RuleRow
                  key={id}
                  id={id}
                  index={i}
                  boardId={board.id}
                  workspaceId={board.workspaceId}
                  readOnly={readOnly}
                  line={over === i ? 'before' : over === ids.length && i === ids.length - 1 ? 'after' : null}
                  onEdit={edit}
                  onRuns={setRunsOf}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                />
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 border-t border-[var(--color-card-line)] px-3 py-2">
            <Button size="sm" variant="secondary" disabled={readOnly || ids.length >= MAX_RULES} onClick={() => setEditing({ ruleId: null, draft: emptyDraft() })} data-testid="rule-add">
              <Plus className="size-3.5" aria-hidden /> {t('rules.add')}
            </Button>
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <Button size="sm" variant="secondary" disabled={readOnly || ids.length >= MAX_RULES} data-testid="rule-templates">
                  {t('rules.fromTemplate')} <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className={cx(menuBox, 'w-80')} sideOffset={4} align="start" collisionPadding={16}>
                  {TEMPLATES.map((x) => (
                    <Dropdown.Item key={x.id} className={menuItem} onSelect={() => setEditing({ ruleId: null, draft: fromTemplate(x.id, statuses) })} data-testid={`rule-tpl-${x.id}`}>
                      {t(x.label)}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
            {ids.length >= MAX_RULES ? <span className="text-caption text-faint">{t('rules.limit')}</span> : null}
          </div>
        </div>
        <p className="px-1 text-caption text-faint">{t('rules.footer')}</p>
      </section>
      {editor}
      {runsOf ? <RuleRuns ruleId={runsOf} board={board} onClose={() => setRunsOf(null)} /> : null}
    </>
  );
}

/** Below Team: «Team» pill + what happens to the rules + «Связаться». */
function PlanNote(): ReactNode {
  const contact = planContact();
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2.5" role="note" data-testid="rules-plan">
      <PlanPill plan={Plan.TEAM} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium">{t('rules.planTitle')}</span>
        <span className="text-caption text-muted">{t('rules.planText')}</span>
      </div>
      {contact ? (
        <Button size="sm" variant="secondary" onClick={openPlanContact}>
          {t('plan.contactShort')}
        </Button>
      ) : null}
    </div>
  );
}

interface RowProps {
  id: string;
  index: number;
  boardId: string;
  workspaceId: string;
  readOnly: boolean;
  line: 'before' | 'after' | null;
  onEdit: (id: string) => void;
  onRuns: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

/** One rule: grip, switch, name + summary, runs · last run, ⚠, ⋯. Memo, selects its rule by id. */
const RuleRow = memo(function RuleRow({ id, index, boardId, workspaceId, readOnly, line, onEdit, onRuns, onDragStart, onDragOver, onDrop, onDragEnd }: RowProps): ReactNode {
  const rule = useAutomations((s) => s.rules[id]);
  const statuses = useBoards((s) => s.boards[boardId]?.statuses);
  const labels = useBoards((s) => s.boards[boardId]?.labels);
  const summary = useMemo(() => (rule ? ruleSummary(rule, summaryCtx(statuses && labels ? { statuses, labels } : undefined, workspaceId)) : ''), [rule, statuses, labels, workspaceId]);
  if (!rule) return null;
  const last = rule.lastRunAt ? timestampDate(rule.lastRunAt) : null;
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('rules.deleteTitle', { name: rule.name }), t('rules.deleteText'), t('common.delete'))) void deleteRule(workspaceId, id);
  };
  return (
    <li
      className={cx(
        'group/rule relative flex items-center gap-2 px-2 py-2',
        line === 'before' && 'before:absolute before:-top-px before:left-2 before:right-2 before:h-0.5 before:rounded-full before:bg-accent',
        line === 'after' && 'after:absolute after:-bottom-px after:left-2 after:right-2 after:h-0.5 after:rounded-full after:bg-accent',
        !rule.enabled && 'opacity-70',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY > r.top + r.height / 2 ? index + 1 : index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDrop(e.clientY > r.top + r.height / 2 ? index + 1 : index);
      }}
      data-testid="rule-row"
      data-rule={id}
    >
      {readOnly ? (
        <span className="size-6" />
      ) : (
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            onDragStart(id);
          }}
          onDragEnd={onDragEnd}
          title={t('rules.drag')}
          aria-hidden
          className="grid size-6 cursor-grab place-items-center rounded-[var(--radius-icon)] text-faint opacity-0 hover:bg-hover hover:text-fg group-hover/rule:opacity-100"
        >
          <GripVertical className="size-4" aria-hidden />
        </span>
      )}
      <Toggle label={t('rules.enable', { name: rule.name })} checked={rule.enabled} disabled={readOnly} onChange={(v) => void setRuleEnabled(workspaceId, id, v)} />
      <button type="button" onClick={() => onEdit(id)} className="flex min-w-0 flex-1 flex-col items-start rounded-[var(--radius-row)] px-1.5 py-0.5 text-left hover:bg-hover" data-testid="rule-open">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-body font-medium">{rule.name}</span>
          {rule.lastError ? (
            <Tip label={t('rules.attention', { error: rule.lastError })}>
              <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-label={t('rules.attention', { error: rule.lastError })} data-testid="rule-warn" />
            </Tip>
          ) : null}
        </span>
        <span className="line-clamp-2 w-full text-caption text-muted" data-testid="rule-summary">
          {summary}
        </span>
      </button>
      <span className="flex w-28 shrink-0 flex-col items-end text-caption tabular-nums text-faint">
        <span>{t('rules.runs', { n: rule.runsCount })}</span>
        <span className="truncate" title={last ? fmt.full(last) : undefined}>
          {last ? t('rules.lastRun', { when: fmt.relative(last) }) : t('rules.never')}
        </span>
      </span>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" aria-label={t('boards.more')} className="grid size-7 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active" data-testid="rule-more">
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-48')} sideOffset={4} align="end" collisionPadding={16}>
            <Dropdown.Item className={menuItem} onSelect={() => onEdit(id)}>
              <Pencil className="size-4" aria-hidden /> {t('rules.edit')}
            </Dropdown.Item>
            <Dropdown.Item className={menuItem} onSelect={() => onRuns(id)} data-testid="rule-runs">
              <History className="size-4" aria-hidden /> {t('rules.log')}
            </Dropdown.Item>
            {readOnly ? null : (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()} data-testid="rule-delete">
                  <Trash2 className="size-4" aria-hidden /> {t('rules.delete')}
                </Dropdown.Item>
              </>
            )}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </li>
  );
});
