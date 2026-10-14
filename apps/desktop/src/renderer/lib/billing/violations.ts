import { PlanLimitKind, type PlanLimitViolation } from '@calaba/protocol';
import { plural, t, type MessageKey, type PluralKey } from '../../i18n';
import { ApiError } from '../api/client';
import { fmt } from '../format';
import { storageText } from '../plan';

/**
 * A plan transition the workspace does not fit (ADR-0086): the server's PLAN_LIMITS_EXCEEDED lists
 * every exceeded limit / feature in use; the client shows one sentence per violation with where to
 * fix it. Nothing here decides — the server checks the quote and again the commit.
 */

/** The violations of a refused transition (409 PLAN_LIMITS_EXCEEDED), empty for any other error. */
export function violationsOf(e: unknown): readonly PlanLimitViolation[] {
  return e instanceof ApiError && e.reason === 'PLAN_LIMITS_EXCEEDED' ? (e.extra.planViolations ?? []) : [];
}

/** 409 BILLING_PLAN_ADMIN_ASSIGNED: a superadmin assigned the plan; self-serve does not change it. */
export const adminAssignedError = (e: unknown): boolean => e instanceof ApiError && e.reason === 'BILLING_PLAN_ADMIN_ASSIGNED';

/** Where a violation is fixed: a workspace settings tab, the boards section, or nowhere linkable. */
export type FixPlace = { kind: 'settings'; tab: string } | { kind: 'boards' } | null;

const FIX: Readonly<Record<PlanLimitKind, FixPlace>> = {
  [PlanLimitKind.UNSPECIFIED]: null,
  [PlanLimitKind.MEMBERS]: { kind: 'settings', tab: 'members' },
  [PlanLimitKind.BOTS]: { kind: 'settings', tab: 'bots' },
  [PlanLimitKind.STORAGE_MB]: null,
  [PlanLimitKind.BOARDS]: { kind: 'boards' },
  [PlanLimitKind.STICKER_PACKS]: { kind: 'settings', tab: 'stickers' },
  [PlanLimitKind.STICKERS]: { kind: 'settings', tab: 'stickers' },
  [PlanLimitKind.ROOM_MEMBERS]: null,
  [PlanLimitKind.BOARD_FORMS]: { kind: 'boards' },
  [PlanLimitKind.SSO]: { kind: 'settings', tab: 'identity' },
  [PlanLimitKind.DIRECTORY_SYNC]: { kind: 'settings', tab: 'identity' },
  [PlanLimitKind.OAUTH_APPS]: { kind: 'settings', tab: 'oauth' },
  [PlanLimitKind.TELEPHONY]: { kind: 'settings', tab: 'telephony' },
  [PlanLimitKind.BOARD_WEBHOOKS]: { kind: 'boards' },
  [PlanLimitKind.AUTOMATIONS]: { kind: 'boards' },
};

export const fixPlace = (v: PlanLimitViolation): FixPlace => FIX[v.kind] ?? null;

/** The button of a fix place. */
export const FIX_LABEL: Readonly<Record<string, MessageKey>> = {
  members: 'billing.fix.members',
  bots: 'billing.fix.bots',
  stickers: 'billing.fix.stickers',
  identity: 'billing.fix.identity',
  oauth: 'billing.fix.oauth',
  telephony: 'billing.fix.telephony',
  boards: 'billing.fix.boards',
};

export const fixLabel = (p: Exclude<FixPlace, null>): MessageKey => FIX_LABEL[p.kind === 'boards' ? 'boards' : p.tab] ?? 'billing.fix.open';

/** Counted kinds: one plural sentence by the current count. */
const COUNTED: Partial<Record<PlanLimitKind, PluralKey>> = {
  [PlanLimitKind.MEMBERS]: 'billing.violation.members',
  [PlanLimitKind.BOTS]: 'billing.violation.bots',
  [PlanLimitKind.BOARDS]: 'billing.violation.boards',
  [PlanLimitKind.STICKER_PACKS]: 'billing.violation.stickerPacks',
  [PlanLimitKind.STICKERS]: 'billing.violation.stickers',
  [PlanLimitKind.OAUTH_APPS]: 'billing.violation.oauth',
  [PlanLimitKind.BOARD_WEBHOOKS]: 'billing.violation.webhooks',
  [PlanLimitKind.AUTOMATIONS]: 'billing.violation.automations',
};

/** Features the target plan lacks (limit 0): one sentence each. */
const FEATURE: Partial<Record<PlanLimitKind, MessageKey>> = {
  [PlanLimitKind.SSO]: 'billing.violation.sso',
  [PlanLimitKind.DIRECTORY_SYNC]: 'billing.violation.directory',
  [PlanLimitKind.TELEPHONY]: 'billing.violation.telephony',
};

/** One sentence for a violation of the plan named `plan` («Team»). */
export function violationText(v: PlanLimitViolation, plan: string): string {
  const n = Number(v.current);
  const limit = fmt.number(Number(v.limit));
  switch (v.kind) {
    case PlanLimitKind.STORAGE_MB:
      return t('billing.violation.storage', { used: storageText(v.current), limit: storageText(v.limit), plan });
    case PlanLimitKind.ROOM_MEMBERS:
      return plural('billing.violation.roomMembers', v.rooms, { current: fmt.number(n), limit, plan });
    case PlanLimitKind.BOARD_FORMS:
      return v.limit === 0n ? t('billing.violation.formsOff', { plan }) : plural('billing.violation.forms', n, { limit, plan });
  }
  const counted = COUNTED[v.kind];
  if (counted) return plural(counted, n, { limit, plan });
  const feature = FEATURE[v.kind];
  if (feature) return t(feature, { plan });
  return t('billing.violation.other', { plan });
}
