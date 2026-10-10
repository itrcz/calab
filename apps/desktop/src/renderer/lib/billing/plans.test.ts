import { create } from '@bufbuild/protobuf';
import { BillingAccountStatus, BillingPlanOfferSchema, BillingQuotePurpose, BillingState, BillingSummarySchema, GetBillingResponseSchema, MoneySchema, Plan } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { IDENTITY_FEATURES, badgeShown, badgeView, clampSeats, currentTier, defaultSeats, forSale, planStep, screenPhase, seatsRange, seatsTopup, selfServeOf } from './plans';

const usd = (minor: bigint) => create(MoneySchema, { minor, currency: 'USD' });

function resp(status?: BillingAccountStatus, state = BillingState.UNSPECIFIED, balance = 0n, selfServe = false) {
  return create(GetBillingResponseSchema, {
    status: { state },
    selfServe,
    ...(status ? { summary: create(BillingSummarySchema, { status, plan: Plan.TEAM, balance: usd(balance), debt: usd(balance < 0n ? -balance : 0n) }) } : {}),
  });
}

describe('badge', () => {
  it('shows for a billing workspace or an owner who may start billing, never otherwise', () => {
    expect(badgeShown(BillingState.UNSPECIFIED, false)).toBe(false);
    expect(badgeShown(BillingState.UNSPECIFIED, true)).toBe(true);
    expect(badgeShown(BillingState.ACTIVE, false)).toBe(true);
  });
  it('self_serve counts only without a summary', () => {
    expect(selfServeOf(resp(undefined, BillingState.UNSPECIFIED, 0n, true))).toBe(true);
    expect(selfServeOf(resp(BillingAccountStatus.INACTIVE, BillingState.INACTIVE, 0n, true))).toBe(false);
    expect(selfServeOf(null)).toBe(false);
  });
  it('names the plan and the state that needs attention', () => {
    expect(badgeView(Plan.UNSPECIFIED, BillingState.UNSPECIFIED)).toEqual({ plan: Plan.FREE, tone: 'free', note: null });
    expect(badgeView(Plan.TEAM, BillingState.ACTIVE)).toEqual({ plan: Plan.TEAM, tone: 'paid', note: null });
    expect(badgeView(Plan.TEAM, BillingState.IN_ARREARS).note).toBe('debt');
    expect(badgeView(Plan.ENTERPRISE, BillingState.SUSPENDED)).toEqual({ plan: Plan.ENTERPRISE, tone: 'danger', note: 'suspended' });
    expect(badgeView(Plan.FREE, BillingState.INACTIVE).note).toBe('inactive');
  });
});

describe('planStep', () => {
  it('starts a paid plan from no account, inactive or stopped', () => {
    for (const phase of ['none', 'inactive', 'stopped'] as const) {
      expect(planStep(phase, Plan.TEAM, Plan.ENTERPRISE)).toEqual({ kind: 'pay', purpose: BillingQuotePurpose.ACTIVATE, plan: Plan.ENTERPRISE });
      expect(planStep(phase, Plan.TEAM, Plan.FREE)).toEqual({ kind: 'current' });
    }
  });
  it('changes or stops a running plan; no upgrade in debt', () => {
    expect(planStep('active', Plan.TEAM, Plan.TEAM)).toEqual({ kind: 'current' });
    expect(planStep('active', Plan.TEAM, Plan.ENTERPRISE)).toEqual({ kind: 'pay', purpose: BillingQuotePurpose.CHANGE_PLAN, plan: Plan.ENTERPRISE });
    expect(planStep('active', Plan.ENTERPRISE, Plan.FREE)).toEqual({ kind: 'stop' });
    expect(planStep('arrears', Plan.TEAM, Plan.ENTERPRISE)).toEqual({ kind: 'blocked', why: 'debtUpgrade' });
    expect(planStep('arrears', Plan.ENTERPRISE, Plan.TEAM)).toEqual({ kind: 'pay', purpose: BillingQuotePurpose.CHANGE_PLAN, plan: Plan.TEAM });
  });
  it('leaves suspended and closed accounts to the cabinet', () => {
    expect(planStep('suspended', Plan.TEAM, Plan.TEAM)).toEqual({ kind: 'blocked', why: 'suspended' });
    expect(planStep('closed', Plan.TEAM, Plan.FREE)).toEqual({ kind: 'blocked', why: 'closed' });
  });
  it('marks the running paid plan, else Free', () => {
    expect(currentTier('active', Plan.ENTERPRISE)).toBe(Plan.ENTERPRISE);
    expect(currentTier('stopped', Plan.ENTERPRISE)).toBe(Plan.FREE);
    expect(screenPhase(resp())).toBe('none');
    expect(screenPhase(resp(BillingAccountStatus.ACTIVE, BillingState.ACTIVE, -10n))).toBe('arrears');
  });
});

describe('offers and amounts', () => {
  it('sells a paid plan only with a price', () => {
    const offers = [create(BillingPlanOfferSchema, { plan: Plan.TEAM, unitPrice: usd(10n) }), create(BillingPlanOfferSchema, { plan: Plan.ENTERPRISE })];
    expect(forSale(offers, Plan.FREE)).toBe(true);
    expect(forSale(offers, Plan.TEAM)).toBe(true);
    expect(forSale(offers, Plan.ENTERPRISE)).toBe(false);
    expect(forSale(undefined, Plan.TEAM)).toBe(false);
  });
  it('maps SSO / directory / OAuth to Business only (plans/identity.go businessFeatures)', () => {
    expect(IDENTITY_FEATURES[Plan.ENTERPRISE]).toEqual(['sso', 'directory', 'oauth']);
    expect(IDENTITY_FEATURES[Plan.TEAM]).toEqual([]);
  });
  it('keeps seats between the billable people and the plan limit', () => {
    const r = seatsRange(3, 100);
    expect(r).toEqual({ min: 3, max: 100 });
    expect(defaultSeats(Plan.TEAM, r)).toBe(5);
    expect(defaultSeats(Plan.ENTERPRISE, seatsRange(12, 500))).toBe(12);
    expect(seatsRange(0, 0)).toEqual({ min: 1, max: 10_000 });
    expect(seatsRange(200, 100)).toEqual({ min: 100, max: 100 });
    expect(clampSeats(Number.NaN, r)).toBe(3);
    expect(clampSeats(1, r)).toBe(3);
    expect(clampSeats(7.9, r)).toBe(7);
    expect(clampSeats(1000, r)).toBe(100);
  });
  it('tops up seats × price × 30 days less the balance, at least the action, within the limits', () => {
    const lim = { min: 500n, max: 500_000n };
    // 10 seats of Business ($0.30): $90 for 30 days.
    expect(seatsTopup({ seats: 10, unit: 30n, debt: 0n, balance: 0n, toPay: 180n }, lim, 'USD')).toEqual({ month: 9000n, amount: 9000n });
    // Debt is added, the balance subtracted, rounded up to a whole dollar.
    expect(seatsTopup({ seats: 5, unit: 10n, debt: 320n, balance: 0n, toPay: 370n }, lim, 'USD').amount).toBe(1900n);
    expect(seatsTopup({ seats: 5, unit: 10n, debt: 0n, balance: 1250n, toPay: 0n }, lim, 'USD').amount).toBe(500n); // $2.50 short → the $5 minimum
    // The balance covers the month: nothing to pay.
    expect(seatsTopup({ seats: 5, unit: 10n, debt: 0n, balance: 2000n, toPay: 0n }, lim, 'USD').amount).toBe(0n);
    // Small amounts reach the method minimum, large ones stop at its maximum.
    expect(seatsTopup({ seats: 1, unit: 10n, debt: 0n, balance: 0n, toPay: 10n }, lim, 'USD').amount).toBe(500n);
    expect(seatsTopup({ seats: 10_000, unit: 30n, debt: 0n, balance: 0n, toPay: 0n }, lim, 'USD').amount).toBe(500_000n);
  });
});
