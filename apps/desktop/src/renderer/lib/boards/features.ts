import { BoardFeature, EstimateScale, TaskField } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';

/**
 * Board features (ADR-0058 §3): what a board switched off (`Board.disabled_features`, ascending)
 * and the estimate scale. The client hides the fields, views and filter fields of a disabled
 * feature — the data stays and comes back when it is switched on; the server refuses writes
 * (409 FEATURE_DISABLED). Pure: components select the board's array (a stable reference until
 * BOARD_UPDATE) and ask these.
 */

export interface FeatureDef {
  feature: BoardFeature;
  label: MessageKey;
  hint: MessageKey;
}

/** The «Фичи» tab, in the order of the enum. */
export const FEATURES: readonly FeatureDef[] = [
  { feature: BoardFeature.ESTIMATE, label: 'boards.feat.estimate', hint: 'boards.feat.estimateHint' },
  { feature: BoardFeature.START_DATE, label: 'boards.feat.startDate', hint: 'boards.feat.startDateHint' },
  { feature: BoardFeature.DUE_DATE, label: 'boards.feat.dueDate', hint: 'boards.feat.dueDateHint' },
  { feature: BoardFeature.PRIORITY, label: 'boards.feat.priority', hint: 'boards.feat.priorityHint' },
  { feature: BoardFeature.LABELS, label: 'boards.feat.labels', hint: 'boards.feat.labelsHint' },
  { feature: BoardFeature.MILESTONES, label: 'boards.feat.milestones', hint: 'boards.feat.milestonesHint' },
  { feature: BoardFeature.SUBTASKS, label: 'boards.feat.subtasks', hint: 'boards.feat.subtasksHint' },
  { feature: BoardFeature.RELATIONS, label: 'boards.feat.relations', hint: 'boards.feat.relationsHint' },
  { feature: BoardFeature.APPROVALS, label: 'boards.feat.approvals', hint: 'boards.feat.approvalsHint' },
  { feature: BoardFeature.CHECKLISTS, label: 'boards.feat.checklists', hint: 'boards.feat.checklistsHint' },
  { feature: BoardFeature.ATTACHMENTS, label: 'boards.feat.attachments', hint: 'boards.feat.attachmentsHint' },
  { feature: BoardFeature.COMMENTS, label: 'boards.feat.comments', hint: 'boards.feat.commentsHint' },
  { feature: BoardFeature.TIMELINE, label: 'boards.feat.timeline', hint: 'boards.feat.timelineHint' },
  { feature: BoardFeature.FORMS, label: 'boards.feat.forms', hint: 'boards.feat.formsHint' },
  { feature: BoardFeature.AUTOMATIONS, label: 'boards.feat.automations', hint: 'boards.feat.automationsHint' },
  { feature: BoardFeature.GIT_LINKS, label: 'boards.feat.gitLinks', hint: 'boards.feat.gitLinksHint' },
];

/** Disabled features of a board (Board.disabled_features); empty = all on. */
export type Disabled = readonly BoardFeature[] | undefined;

export const featureOn = (disabled: Disabled, f: BoardFeature): boolean => !disabled?.includes(f);

/** The disabled set with `f` switched on / off: ascending, no duplicates (the PATCH body). */
export function withFeature(disabled: Disabled, f: BoardFeature, on: boolean): BoardFeature[] {
  const set = new Set(disabled ?? []);
  if (on) set.delete(f);
  else set.add(f);
  set.delete(BoardFeature.UNSPECIFIED);
  return [...set].sort((a, b) => a - b);
}

/** Filter fields that belong to a feature: the picker hides them, a chip with one is «выключено». */
const FIELD_FEATURE: Partial<Record<TaskField, BoardFeature>> = {
  [TaskField.ESTIMATE]: BoardFeature.ESTIMATE,
  [TaskField.START_ON]: BoardFeature.START_DATE,
  [TaskField.DUE_ON]: BoardFeature.DUE_DATE,
  [TaskField.PRIORITY]: BoardFeature.PRIORITY,
  [TaskField.LABEL]: BoardFeature.LABELS,
  [TaskField.MILESTONE]: BoardFeature.MILESTONES,
  [TaskField.PARENT]: BoardFeature.SUBTASKS,
  [TaskField.RELATION]: BoardFeature.RELATIONS,
  [TaskField.APPROVAL_STATE]: BoardFeature.APPROVALS,
  [TaskField.APPROVER_PENDING]: BoardFeature.APPROVALS,
  [TaskField.HAS_ATTACHMENTS]: BoardFeature.ATTACHMENTS,
};

/** A filter field of a disabled feature (the filter still counts it on the server: ADR §3). */
export function fieldOff(disabled: Disabled, field: TaskField): boolean {
  const f = FIELD_FEATURE[field];
  return f !== undefined && !featureOn(disabled, f);
}

// ---------------------------------------------------------------- estimate scale

export const ESTIMATE_SCALES: ReadonlyArray<{ scale: EstimateScale; label: MessageKey }> = [
  { scale: EstimateScale.FIBONACCI, label: 'boards.scale.fibonacci' },
  { scale: EstimateScale.LINEAR, label: 'boards.scale.linear' },
  { scale: EstimateScale.TSHIRT, label: 'boards.scale.tshirt' },
];

const FIBONACCI = [1, 2, 3, 5, 8, 13, 21] as const;
const LINEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
/** T-shirt sizes: the stored number of each (ADR-0058 §3). */
const TSHIRT: ReadonlyArray<readonly [number, string]> = [
  [1, 'XS'],
  [2, 'S'],
  [3, 'M'],
  [5, 'L'],
  [8, 'XL'],
];

/** The values a board's scale offers (UNSPECIFIED — an older server — reads as Fibonacci). */
export function scaleValues(scale: EstimateScale | undefined): readonly number[] {
  if (scale === EstimateScale.LINEAR) return LINEAR;
  if (scale === EstimateScale.TSHIRT) return TSHIRT.map(([n]) => n);
  return FIBONACCI;
}

/**
 * An estimate as the scale names it: «M» on T-shirt, else the number. A value outside the
 * scale (the scale changed later) shows as its number until edited.
 */
export function estimateName(n: number, scale: EstimateScale | undefined): string {
  if (scale === EstimateScale.TSHIRT) {
    const hit = TSHIRT.find(([v]) => v === n);
    if (hit) return hit[1];
  }
  return String(n);
}

/** A T-shirt size is a word, not points (the UI drops «б.» for it). */
export const isSized = (n: number, scale: EstimateScale | undefined): boolean => scale === EstimateScale.TSHIRT && TSHIRT.some(([v]) => v === n);

// ---------------------------------------------------------------- views

const GROUP_FEATURE: Record<string, BoardFeature> = { priority: BoardFeature.PRIORITY, label: BoardFeature.LABELS, milestone: BoardFeature.MILESTONES };
const SORT_FEATURE: Record<string, BoardFeature> = { priority: BoardFeature.PRIORITY, due: BoardFeature.DUE_DATE };

/** A list grouping / sort that needs no disabled feature (otherwise the list falls back). */
export const groupOn = (groupBy: string, disabled: Disabled): boolean => {
  const f = GROUP_FEATURE[groupBy];
  return f === undefined || featureOn(disabled, f);
};
export const sortOn = (sort: string, disabled: Disabled): boolean => {
  const f = SORT_FEATURE[sort];
  return f === undefined || featureOn(disabled, f);
};
