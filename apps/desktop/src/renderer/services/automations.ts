import type { MessageInitShape } from '@bufbuild/protobuf';
import type { BoardGit, BoardRule, DispatchEvent, GitProvider, RuleRun, RuleTestResponse, UpdateBoardRuleRequestSchema } from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { hasCondition, issueAtField, wireActions, type IssueAt, type RuleDraft } from '../lib/boards/rules';
import { toTaskFilter } from '../lib/boards/filter';
import { log } from '../lib/log';
import { useAutomations } from '../stores/automations';
import { useBoards } from '../stores/boards';
import { toast } from '../stores/toasts';
import { automationsApi } from './automationsApi';
import { reportFeatureError } from './boards';

/**
 * Board automations (ADR-0060): rules loaded when the «Автоматизации» tab opens (or an activity
 * row needs a rule's name), kept live by BOARD_RULE_UPDATE / _DELETE (events 92–93); the Git
 * links of the open task (TASK_GIT_LINKS_UPDATE, 94); the board's Git webhook setup. Every
 * mutation reports a refusal with a toast; components never call the API directly.
 */

// ------------------------------------------------------------------ events

/** Gateway events 92–94. Returns false for any other event. */
export function applyAutomationEvent(ev: DispatchEvent['event']): boolean {
  const s = useAutomations.getState();
  switch (ev.case) {
    case 'boardRuleUpdate':
      if (ev.value.rule) s.upsertRule(ev.value.rule);
      return true;
    case 'boardRuleDelete':
      s.removeRule(ev.value.ruleId, ev.value.boardId);
      return true;
    case 'taskGitLinksUpdate': {
      const { taskId, links, count } = ev.value;
      s.setGitLinks(taskId, links);
      // The card's «⎇ N» (a leaf on this counter) before the TASK_UPDATE that follows.
      if (useBoards.getState().tasks[taskId]) s.setGitCount(taskId, count);
      return true;
    }
    default:
      return false;
  }
}

// ------------------------------------------------------------------ rules

const inflight = new Map<string, Promise<void>>();

/** Loads a board's rules once (the tab, an activity row); `force` refetches (a run counter). */
export function ensureRules(boardId: string, force = false): Promise<void> {
  const s = useAutomations.getState();
  const st = s.load[boardId];
  if (!force && (st === 'ready' || st === 'loading')) return inflight.get(boardId) ?? Promise.resolve();
  const run = (async () => {
    if (st !== 'ready') s.setLoad(boardId, 'loading');
    try {
      const r = await automationsApi.rules.list(boardId);
      useAutomations.getState().setBoardRules(boardId, r.rules);
      useAutomations.getState().setLoad(boardId, 'ready');
    } catch (e) {
      log.warn('board rules failed', e);
      useAutomations.getState().setLoad(boardId, 'error');
    } finally {
      inflight.delete(boardId);
    }
  })();
  inflight.set(boardId, run);
  return run;
}

/** A refusal of a rule write: plan / feature toasts, 422 → where the editor shows it. */
export interface RuleSaveError {
  at: IssueAt | null;
  text: string;
}

function ruleError(e: unknown, workspaceId: string): RuleSaveError | null {
  // FEATURE_DISABLED (a due trigger without due dates) and PLAN_LIMIT (below Team): toasts.
  if (reportFeatureError(e, workspaceId)) return null;
  if (e instanceof ApiError) {
    if (e.reason === 'RULE_LIMIT') return { at: null, text: t('rules.limit') };
    if (e.status === 422) return { at: issueAtField(e.field), text: t('rules.err.server', { error: e.message }) };
    if (e.status === 403) return { at: null, text: t('boards.err.forbidden') };
  }
  toast.fail(e, t('rules.err.save'));
  return null;
}

function wire(d: RuleDraft): { name: string; enabled: boolean; trigger: RuleDraft['trigger']; actions: RuleDraft['actions'] } {
  return { name: d.name.trim(), enabled: d.enabled, trigger: d.trigger, actions: wireActions(d.actions) };
}

/** POST: the new rule, or the refusal for the editor. */
export async function createRule(workspaceId: string, boardId: string, d: RuleDraft): Promise<{ rule: BoardRule } | { error: RuleSaveError | null }> {
  try {
    const r = await automationsApi.rules.create(boardId, { ...wire(d), ...(hasCondition(d.condition) ? { condition: toTaskFilter(d.condition) } : {}) });
    if (r.rule) useAutomations.getState().upsertRule(r.rule);
    toast.success(t('rules.created'));
    return r.rule ? { rule: r.rule } : { error: null };
  } catch (e) {
    return { error: ruleError(e, workspaceId) };
  }
}

/** PATCH of the whole rule from the editor (name, trigger, condition, actions, enabled). */
export async function saveRule(workspaceId: string, ruleId: string, d: RuleDraft): Promise<{ rule: BoardRule } | { error: RuleSaveError | null }> {
  const cond = hasCondition(d.condition);
  const init: MessageInitShape<typeof UpdateBoardRuleRequestSchema> = { ...wire(d), setActions: true, ...(cond ? { condition: toTaskFilter(d.condition) } : { clearCondition: true }) };
  try {
    const r = await automationsApi.rules.update(ruleId, init);
    if (r.rule) useAutomations.getState().upsertRule(r.rule);
    toast.success(t('rules.saved'));
    return r.rule ? { rule: r.rule } : { error: null };
  } catch (e) {
    return { error: ruleError(e, workspaceId) };
  }
}

/** The list's switch: optimistic, rolled back on a refusal. */
export async function setRuleEnabled(workspaceId: string, ruleId: string, enabled: boolean): Promise<void> {
  const s = useAutomations.getState();
  const prev = s.rules[ruleId];
  if (!prev) return;
  s.upsertRule({ ...prev, enabled });
  try {
    const r = await automationsApi.rules.update(ruleId, { enabled });
    if (r.rule) useAutomations.getState().upsertRule(r.rule);
  } catch (e) {
    useAutomations.getState().upsertRule(prev);
    const err = ruleError(e, workspaceId);
    if (err) toast.error(err.text);
  }
}

/** Drag & drop: the new order locally, then PATCH position of the moved rule (the server shifts the others). */
export async function moveRule(workspaceId: string, boardId: string, ruleId: string, ids: readonly string[]): Promise<void> {
  const before = useAutomations.getState().order[boardId] ?? [];
  const index = ids.indexOf(ruleId);
  if (index < 0) return;
  useAutomations.getState().reorder(boardId, ids);
  try {
    const r = await automationsApi.rules.update(ruleId, { position: index });
    if (r.rule) useAutomations.getState().upsertRule(r.rule);
  } catch (e) {
    useAutomations.getState().reorder(boardId, before);
    const err = ruleError(e, workspaceId);
    if (err) toast.error(err.text);
    void ensureRules(boardId, true);
  }
}

export async function deleteRule(workspaceId: string, ruleId: string): Promise<boolean> {
  const prev = useAutomations.getState().rules[ruleId];
  try {
    await automationsApi.rules.remove(ruleId);
    useAutomations.getState().removeRule(ruleId, prev?.boardId);
    return true;
  } catch (e) {
    const err = ruleError(e, workspaceId);
    if (err) toast.error(err.text);
    return false;
  }
}

export async function testRule(ruleId: string, taskId: string): Promise<RuleTestResponse | null> {
  try {
    return await automationsApi.rules.test(ruleId, taskId);
  } catch (e) {
    toast.fail(e, t('rules.testFailed'));
    return null;
  }
}

export async function loadRuns(ruleId: string, signal?: AbortSignal): Promise<RuleRun[]> {
  const r = await automationsApi.rules.runs(ruleId, 100, signal);
  return r.runs;
}

// ------------------------------------------------------------------ Git (ADR-0060 §4)

export interface GitState {
  git: BoardGit | null;
  /** The secret, only right after a save (shown once). */
  secret: string;
}

function gitFail(e: unknown, workspaceId: string): void {
  if (reportFeatureError(e, workspaceId)) return;
  if (e instanceof ApiError && e.status === 422 && e.field === 'secret') toast.error(t('git.badSecret'));
  else if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.forbidden'));
  else toast.fail(e, t('git.err.save'));
}

export async function loadGit(boardId: string, signal?: AbortSignal): Promise<BoardGit | null> {
  const r = await automationsApi.git.get(boardId, signal);
  return r.git ?? null;
}

export async function saveGit(workspaceId: string, boardId: string, provider: GitProvider, secret: string): Promise<GitState | null> {
  try {
    const r = await automationsApi.git.set(boardId, provider, secret);
    return { git: r.git ?? null, secret: r.secret };
  } catch (e) {
    gitFail(e, workspaceId);
    return null;
  }
}

export async function deleteGit(workspaceId: string, boardId: string): Promise<boolean> {
  try {
    await automationsApi.git.remove(boardId);
    return true;
  } catch (e) {
    gitFail(e, workspaceId);
    return false;
  }
}
