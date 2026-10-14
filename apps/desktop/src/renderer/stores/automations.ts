import type { BoardRule, TaskGitLink } from '@calaba/protocol';
import { create } from 'zustand';
import { EMPTY_RULES, removeRule, reorderRules, setBoardRules, upsertRule, type RulesData } from '../lib/boards/rules';
import type { LoadState } from './boards';

/**
 * Board automations (ADR-0060): the rules of boards whose «Автоматизации» tab was opened (loaded
 * on demand, then kept live by BOARD_RULE_UPDATE / _DELETE), rules seen in events of other boards
 * (their names for the activity feed), and the Git links of tasks opened in the panel (GET
 * /tasks/{id}, TASK_GIT_LINKS_UPDATE). Transitions are pure (lib/boards/rules.ts) and keep every
 * untouched rule by reference: an event re-renders one row. Components select by id.
 */
interface AutomationsState extends RulesData {
  load: Readonly<Record<string, LoadState>>;
  /** Task id → its Git links (newest first); only tasks shown in the panel. */
  gitLinks: Readonly<Record<string, readonly TaskGitLink[]>>;
  /**
   * Task id → its link count from TASK_GIT_LINKS_UPDATE (newer than the task object until the
   * TASK_UPDATE that follows): the card's chip reads it, so the event re-renders the chip only.
   */
  gitCounts: Readonly<Record<string, number>>;
  reset: () => void;
  setLoad: (boardId: string, s: LoadState) => void;
  setBoardRules: (boardId: string, list: readonly BoardRule[]) => void;
  upsertRule: (r: BoardRule) => void;
  removeRule: (ruleId: string, boardId?: string) => void;
  reorder: (boardId: string, ids: readonly string[]) => void;
  setGitLinks: (taskId: string, links: readonly TaskGitLink[], force?: boolean) => void;
  setGitCount: (taskId: string, n: number) => void;
}

export const useAutomations = create<AutomationsState>()((set) => ({
  ...EMPTY_RULES,
  load: {},
  gitLinks: {},
  gitCounts: {},
  reset: () => set({ ...EMPTY_RULES, load: {}, gitLinks: {}, gitCounts: {} }),
  setLoad: (boardId, s) => set((d) => (d.load[boardId] === s ? {} : { load: { ...d.load, [boardId]: s } })),
  setBoardRules: (boardId, list) => set((d) => setBoardRules(d, boardId, list)),
  upsertRule: (r) => set((d) => upsertRule(d, r)),
  removeRule: (id, boardId) => set((d) => removeRule(d, id, boardId)),
  reorder: (boardId, ids) => set((d) => reorderRules(d, boardId, ids)),
  // An event for a task nothing shows is dropped unless `force` (the panel's own load).
  setGitLinks: (taskId, links, force = false) => set((d) => (!force && !d.gitLinks[taskId] ? {} : { gitLinks: { ...d.gitLinks, [taskId]: links } })),
  setGitCount: (taskId, n) => set((d) => (d.gitCounts[taskId] === n ? {} : { gitCounts: { ...d.gitCounts, [taskId]: n } })),
}));

const NONE: readonly string[] = [];
const NO_LINKS: readonly TaskGitLink[] = [];

/** A board's rule ids by position (stable reference while the order does not change). */
export function ruleIdsOf(s: RulesData, boardId: string): readonly string[] {
  return s.order[boardId] ?? NONE;
}

/** A task's loaded Git links (stable reference). */
export function gitLinksOf(s: Pick<AutomationsState, 'gitLinks'>, taskId: string): readonly TaskGitLink[] {
  return s.gitLinks[taskId] ?? NO_LINKS;
}

/** The name of a rule for «⚙ Автоматизация: имя» — '' when unknown (a primitive selector). */
export function ruleNameOf(s: RulesData, ruleId: string): string {
  return s.rules[ruleId]?.name ?? '';
}
