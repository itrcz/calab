import { BillingQuotePurpose, BillingState, Plan, type BillingPlanOffer, type GetBillingResponse } from '@calaba/protocol';
import { clampMinor, currencyDigits, maxMinor, minorOf } from './money';
import { RESERVE_DAYS, cabinetPhase, type CabinetPhase } from './model';

/**
 * Pure rules of the plan badge and the «Тариф и оплата» screen (ADR-0080 v5, docs/08 «Тариф»):
 * when the badge shows and what it says, which step a chosen plan takes for the account phase,
 * and the amounts the one pay path offers. The server re-validates everything.
 */

/** The plans the screen compares, in order. */
export type PlanTier = Plan.FREE | Plan.TEAM | Plan.ENTERPRISE;
export const TIERS: readonly PlanTier[] = [Plan.FREE, Plan.TEAM, Plan.ENTERPRISE];

/** The badge exists: a billing workspace (Workspace.billing state, every member) or an owner who may start billing. */
export const badgeShown = (state: BillingState, selfServe: boolean): boolean => state !== BillingState.UNSPECIFIED || selfServe;

/** The owner may start billing here (GET …/billing answered self_serve). */
export const selfServeOf = (d: GetBillingResponse | null | undefined): boolean => !!d?.selfServe && !d.summary;

export type BadgeTone = 'free' | 'paid' | 'warn' | 'danger';

export interface BadgeView {
  /** The plan named on the badge (Workspace.plan; Free when unset). */
  plan: Plan;
  tone: BadgeTone;
  /** A short state after the name: debt, suspended, waiting for the first payment, plan not active. */
  note: 'debt' | 'suspended' | 'inactive' | 'lapsed' | null;
}

export function badgeView(plan: Plan, state: BillingState): BadgeView {
  const p = plan === Plan.UNSPECIFIED ? Plan.FREE : plan;
  if (state === BillingState.SUSPENDED) return { plan: p, tone: 'danger', note: 'suspended' };
  if (state === BillingState.IN_ARREARS) return { plan: p, tone: 'warn', note: 'debt' };
  // The restricted mode (ADR-0086 amendment): «не активен», the warn outline like the debt.
  if (state === BillingState.LAPSED) return { plan: p, tone: 'warn', note: 'lapsed' };
  if (state === BillingState.INACTIVE) return { plan: p, tone: 'free', note: 'inactive' };
  return { plan: p, tone: p === Plan.FREE ? 'free' : 'paid', note: null };
}

/** The account phase for the screen; 'none' = no account yet (self-serve). */
export type ScreenPhase = CabinetPhase | 'none';

export function screenPhase(d: GetBillingResponse | null | undefined): ScreenPhase {
  if (!d?.summary) return 'none';
  return cabinetPhase(d.summary, d.status?.state ?? BillingState.UNSPECIFIED);
}

/** The plan the screen marks as current: the paid one while it runs, Free otherwise; none in the restricted mode. */
export function currentTier(phase: ScreenPhase, accountPlan: Plan): PlanTier | null {
  if (phase === 'active' || phase === 'arrears') return accountPlan === Plan.ENTERPRISE ? Plan.ENTERPRISE : Plan.TEAM;
  if (phase === 'lapsed') return null;
  return Plan.FREE;
}

export type PlanStep =
  /** Already on it. */
  | { kind: 'current' }
  /** Quote, pay what is missing, then the action — the one pay path. */
  | { kind: 'pay'; purpose: BillingQuotePurpose.ACTIVATE | BillingQuotePurpose.CHANGE_PLAN; plan: Plan.TEAM | Plan.ENTERPRISE }
  /** Free from a running paid plan: stop it (the existing stop quote; always allowed, ADR-0086 amendment). */
  | { kind: 'stop' }
  /** Free out of the restricted mode (resume FREE): only when the workspace fits Free. */
  | { kind: 'toFree' }
  /** Not offered here: an upgrade with debt, a suspended or closed account (the cabinet handles it). */
  | { kind: 'blocked'; why: 'debtUpgrade' | 'suspended' | 'closed' };

const rank = (p: Plan): number => (p === Plan.ENTERPRISE ? 2 : p === Plan.TEAM ? 1 : 0);

/** What choosing `target` does for the account phase (lead plan «v1 cut»: an upgrade only without debt). */
export function planStep(phase: ScreenPhase, accountPlan: Plan, target: PlanTier): PlanStep {
  if (phase === 'closed') return { kind: 'blocked', why: 'closed' };
  if (phase === 'suspended') return { kind: 'blocked', why: 'suspended' };
  // The restricted mode: no plan is current; Free is the way out once the workspace fits it.
  if (phase === 'lapsed') return target === Plan.FREE ? { kind: 'toFree' } : { kind: 'pay', purpose: BillingQuotePurpose.ACTIVATE, plan: target };
  const current = currentTier(phase, accountPlan) ?? Plan.FREE;
  if (target === current) return { kind: 'current' };
  if (target === Plan.FREE) return { kind: 'stop' };
  if (phase === 'active' || phase === 'arrears') {
    if (phase === 'arrears' && rank(target) > rank(current)) return { kind: 'blocked', why: 'debtUpgrade' };
    return { kind: 'pay', purpose: BillingQuotePurpose.CHANGE_PLAN, plan: target };
  }
  // No account, inactive or stopped: start the chosen plan.
  return { kind: 'pay', purpose: BillingQuotePurpose.ACTIVATE, plan: target };
}

/** The offer of a plan (undefined when the server sells it not / sent no offers). */
export const offerOf = (offers: readonly BillingPlanOffer[] | undefined, p: Plan): BillingPlanOffer | undefined => offers?.find((o) => o.plan === p);

/** A paid tier the server offers a price for. */
export const forSale = (offers: readonly BillingPlanOffer[] | undefined, p: PlanTier): boolean => p === Plan.FREE || minorOf(offerOf(offers, p)?.unitPrice) > 0n;

/** Per seat for 30 days (the «≈ в месяц» line of a card). */
export const monthOf = (unitMinor: bigint): bigint => unitMinor * RESERVE_DAYS;

/**
 * Identity features a plan grants that are not in PlanLimits: the server's single source is
 * `businessFeatures` of apps/server/internal/plans/identity.go (SSO, directory sync — Active
 * Directory / SCIM — and Calab as an OAuth provider, for PLAN_ENTERPRISE only). Keep in step with it.
 */
export type IdentityFeature = 'sso' | 'directory' | 'oauth';
export const IDENTITY_FEATURES: Readonly<Record<PlanTier, readonly IdentityFeature[]>> = {
  [Plan.FREE]: [],
  [Plan.TEAM]: [],
  [Plan.ENTERPRISE]: ['sso', 'directory', 'oauth'],
};

/** Seats prefilled after choosing a plan (owner 10.10: Team 5, Business 10). */
export const DEFAULT_SEATS: Readonly<Record<Plan.TEAM | Plan.ENTERPRISE, number>> = { [Plan.TEAM]: 5, [Plan.ENTERPRISE]: 10 };

/** Upper bound of the seats field when the plan has no members limit. */
export const SEATS_CAP = 10_000;

/**
 * The seats range of a plan: never below the people already billable (owner included), never
 * above the plan's members limit (0 = none → SEATS_CAP).
 */
export function seatsRange(billable: number, planMembers: number): { min: number; max: number } {
  const max = planMembers > 0 ? planMembers : SEATS_CAP;
  const min = Math.min(Math.max(1, billable), max);
  return { min, max };
}

/** The seats field's start value for a plan. */
export function defaultSeats(plan: Plan.TEAM | Plan.ENTERPRISE, range: { min: number; max: number }): number {
  return clampSeats(DEFAULT_SEATS[plan], range);
}

/** A typed seat count clamped into the range (NaN → min). */
export function clampSeats(n: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(n)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.trunc(n)));
}

export interface SeatsTopup {
  /** seats × unit × 30 days: the prepaid month for the planned team. */
  month: bigint;
  /** What to top up now (minor units, within the method limits); 0 when the balance already covers it. */
  amount: bigint;
}

/**
 * The top-up of the pay path for a planned team: debt + seats × unit price × 30 days minus the
 * money already on the balance, at least what the action itself needs (quote to_pay), rounded up
 * to a whole unit and kept within the method limits. Seats are a prepaid size, not a purchase:
 * the server still charges the actual billable people each 24 h (ADR-0080 §1).
 */
export function seatsTopup(
  a: { seats: number; unit: bigint; debt: bigint; balance: bigint; toPay: bigint },
  lim: { min: bigint; max: bigint },
  currency: string,
): SeatsTopup {
  const month = BigInt(Math.max(0, a.seats)) * maxMinor(a.unit, 0n) * RESERVE_DAYS;
  const need = maxMinor(a.debt, 0n) + month - maxMinor(a.balance, 0n);
  const want = need > a.toPay ? need : a.toPay;
  if (want <= 0n) return { month, amount: 0n };
  const unit = 10n ** BigInt(currencyDigits(currency));
  return { month, amount: clampMinor(((want + unit - 1n) / unit) * unit, lim.min, lim.max) };
}

