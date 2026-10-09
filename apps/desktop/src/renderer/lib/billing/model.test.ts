import { create } from '@bufbuild/protobuf';
import {
  BillingAccountStatus,
  BillingDisputeSchema,
  BillingPaymentSchema,
  BillingRefundSchema,
  BillingState,
  BillingSummarySchema,
  DisputeStatus,
  MoneySchema,
  PaymentMethodKind,
  PaymentMethodOptionSchema,
  PaymentStatus,
  Plan,
  RefundStatus,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  amountProblem,
  autoTopupFailure,
  autoTopupLimits,
  billingPlan,
  cabinetPhase,
  countdownPeriod,
  defaultTopup,
  forecastOf,
  offeredMethods,
  otherPlan,
  refundableMinor,
  rejectRefundRequest,
  reserveAmount,
  timeLeft,
  topupLimits,
  topupPresets,
} from './model';

const usd = (minor: bigint) => create(MoneySchema, { minor, currency: 'USD' });

function summary(init: Parameters<typeof create<typeof BillingSummarySchema>>[1] = {}) {
  return create(BillingSummarySchema, {
    status: BillingAccountStatus.ACTIVE,
    plan: Plan.TEAM,
    balance: usd(4230n),
    debt: usd(0n),
    unitPrice: usd(10n),
    dailyCost: usd(60n),
    billableMembers: 6,
    forecastDays: 70,
    methods: [{ id: 'stripe:card', provider: 'stripe', kind: PaymentMethodKind.CARD, min: usd(500n), max: usd(500_000n), autoTopupCapable: true }],
    ...init,
  });
}

describe('cabinet phase', () => {
  it('follows the account status and the debt', () => {
    expect(cabinetPhase(summary(), BillingState.ACTIVE)).toBe('active');
    expect(cabinetPhase(summary({ debt: usd(320n), balance: usd(-320n) }), BillingState.IN_ARREARS)).toBe('arrears');
    expect(cabinetPhase(summary(), BillingState.IN_ARREARS)).toBe('arrears');
    expect(cabinetPhase(summary({ status: BillingAccountStatus.SUSPENDED }), BillingState.SUSPENDED)).toBe('suspended');
    // Workspace.billing says suspended before the summary caught up: suspended wins.
    expect(cabinetPhase(summary(), BillingState.SUSPENDED)).toBe('suspended');
    expect(cabinetPhase(summary({ status: BillingAccountStatus.INACTIVE }), BillingState.INACTIVE)).toBe('inactive');
    expect(cabinetPhase(summary({ status: BillingAccountStatus.STOPPED }), BillingState.STOPPED)).toBe('stopped');
    expect(cabinetPhase(summary({ status: BillingAccountStatus.CLOSED }), BillingState.UNSPECIFIED)).toBe('closed');
  });

  it('maps plans', () => {
    expect(billingPlan(Plan.ENTERPRISE)).toBe(Plan.ENTERPRISE);
    expect(billingPlan(Plan.FREE)).toBe(Plan.TEAM);
    expect(otherPlan(Plan.TEAM)).toBe(Plan.ENTERPRISE);
    expect(otherPlan(Plan.ENTERPRISE)).toBe(Plan.TEAM);
  });
});

describe('forecast display', () => {
  it('shows days only while running without debt', () => {
    expect(forecastOf(summary())).toEqual({ kind: 'days', days: 70 });
    expect(forecastOf(summary({ forecastDays: 0 }))).toEqual({ kind: 'lessThanDay' });
    expect(forecastOf(summary({ forecastDays: -1 }))).toEqual({ kind: 'none' });
    expect(forecastOf(summary({ debt: usd(1n) }))).toEqual({ kind: 'none' });
    expect(forecastOf(summary({ dailyCost: usd(0n) }))).toEqual({ kind: 'none' });
  });
});

describe('countdown', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  it('splits the time left', () => {
    expect(timeLeft(now + 3 * 86_400_000 + 5 * 3_600_000 + 30_000, now)).toMatchObject({ days: 3, hours: 5, minutes: 0 });
    expect(timeLeft(now + 4 * 3_600_000 + 12 * 60_000, now)).toMatchObject({ days: 0, hours: 4, minutes: 12 });
    expect(timeLeft(now - 1000, now)).toMatchObject({ days: 0, hours: 0, minutes: 0, ms: -1000 });
  });
  it('ticks rarely while far away', () => {
    expect(countdownPeriod(timeLeft(now + 2 * 86_400_000, now))).toBe(600_000);
    expect(countdownPeriod(timeLeft(now + 3_600_000, now))).toBe(60_000);
  });
});

describe('top-up amounts', () => {
  const lim = { min: 500n, max: 500_000n };

  it('takes the limits from the method, with the v1 USD fallback', () => {
    expect(topupLimits(summary().methods[0], 'USD')).toEqual(lim);
    expect(topupLimits(undefined, 'USD')).toEqual(lim);
    expect(topupLimits(create(PaymentMethodOptionSchema, { id: 'stripe:card', min: usd(1000n), max: usd(100n) }), 'USD')).toEqual({ min: 1000n, max: 1000n });
  });

  it('validates a typed amount', () => {
    expect(amountProblem(null, '', lim)).toBe('empty');
    expect(amountProblem(null, '12.345', lim)).toBe('invalid');
    expect(amountProblem(499n, '4.99', lim)).toBe('tooSmall');
    expect(amountProblem(500_001n, '5000.01', lim)).toBe('tooLarge');
    expect(amountProblem(500n, '5', lim)).toBeNull();
    expect(amountProblem(500_000n, '5000', lim)).toBeNull();
  });

  it('reserve = debt + 30 days of the current daily cost (ADR-0080 §7)', () => {
    expect(reserveAmount(summary())).toBe(1800n); // 30 × $0.60
    expect(reserveAmount(summary({ debt: usd(200n), dailyCost: usd(100n) }))).toBe(3200n); // owner's example: $2 + 10 × $0.10 × 30
    expect(reserveAmount(summary({ dailyCost: usd(0n) }))).toBe(0n);
  });

  it('offers the reserve first, then round amounts inside the limits', () => {
    const p = topupPresets(summary(), lim, 'USD');
    expect(p[0]).toEqual({ minor: 1800n, reserve: true });
    expect(p.slice(1).map((x) => x.minor)).toEqual([1000n, 2500n, 5000n, 10_000n]);
    expect(p.length).toBeLessThanOrEqual(5);
    // A reserve that is a round amount is not offered twice; cents are rounded up to whole dollars.
    const q = topupPresets(summary({ dailyCost: usd(33n) }), lim, 'USD');
    expect(q[0]).toEqual({ minor: 1000n, reserve: true });
    expect(q.filter((x) => x.minor === 1000n)).toHaveLength(1);
    // Below the minimum the reserve is raised to it.
    expect(topupPresets(summary({ dailyCost: usd(1n) }), lim, 'USD')[0]).toEqual({ minor: 500n, reserve: true });
    // No reserve without cost: the smallest round amount is the default.
    expect(defaultTopup(summary({ dailyCost: usd(0n) }), lim, 'USD')).toBe(1000n);
  });

  it('offers only known methods', () => {
    expect(offeredMethods(summary({ methods: [{ id: '', kind: PaymentMethodKind.CARD }, { id: 'x', kind: PaymentMethodKind.UNSPECIFIED }, { id: 'stripe:card', kind: PaymentMethodKind.CARD }] })).map((m) => m.id)).toEqual(['stripe:card']);
  });
});

describe('auto-topup limits', () => {
  it('uses the server values, falling back to $500 / $5000 for USD', () => {
    expect(autoTopupLimits(summary())).toEqual({ def: 50_000n, max: 500_000n });
    expect(autoTopupLimits(summary({ autoTopup: { defaultMaxAmount: usd(20_000n), limitMaxAmount: usd(100_000n) } }))).toEqual({ def: 20_000n, max: 100_000n });
    expect(autoTopupLimits(summary({ autoTopup: { defaultMaxAmount: usd(900_000n), limitMaxAmount: usd(100_000n) } }))).toEqual({ def: 100_000n, max: 100_000n });
  });
});

describe('refundableMinor', () => {
  const pay = (refunded = 0n, status = PaymentStatus.SUCCEEDED) => create(BillingPaymentSchema, { id: 'p1', amount: usd(1000n), refunded: usd(refunded), status });
  const dispute = (status: DisputeStatus, paymentId = 'p1') => create(BillingDisputeSchema, { id: 'd', paymentId, status });
  const refund = (amount: bigint, status: RefundStatus, paymentId = 'p1') => create(BillingRefundSchema, { id: 'r', paymentId, amount: usd(amount), status });

  it('is amount minus refunded minus refunds in flight', () => {
    expect(refundableMinor(pay(), [], [])).toBe(1000n);
    expect(refundableMinor(pay(300n), [], [refund(300n, RefundStatus.SUCCEEDED), refund(200n, RefundStatus.PENDING), refund(100n, RefundStatus.FAILED)])).toBe(500n);
    expect(refundableMinor(pay(), [], [refund(500n, RefundStatus.PENDING, 'other')])).toBe(1000n);
  });

  it('hides «Вернуть» on fully refunded, unfinished, lost or open-disputed payments', () => {
    expect(refundableMinor(pay(1000n), [], [])).toBe(0n);
    expect(refundableMinor(pay(600n), [], [refund(400n, RefundStatus.REQUIRES_ACTION)])).toBe(0n);
    expect(refundableMinor(pay(0n, PaymentStatus.PROCESSING), [], [])).toBe(0n);
    expect(refundableMinor(pay(), [dispute(DisputeStatus.LOST)], [])).toBe(0n);
    expect(refundableMinor(pay(), [dispute(DisputeStatus.OPEN)], [])).toBe(0n);
    expect(refundableMinor(pay(), [dispute(DisputeStatus.WON), dispute(DisputeStatus.LOST, 'other')], [])).toBe(1000n);
    expect(refundableMinor(undefined, [], [])).toBe(0n);
  });
});

describe('autoTopupFailure', () => {
  it('names the known codes and folds the rest into generic', () => {
    for (const c of ['authentication_required', 'card_declined', 'insufficient_funds', 'expired_card'] as const) expect(autoTopupFailure(c)).toBe(c);
    expect(autoTopupFailure('do_not_honor')).toBe('generic');
    expect(autoTopupFailure('')).toBe('generic');
  });
});

describe('rejectRefundRequest', () => {
  it('rejects without a preview, with the trimmed reason and the form request id', () => {
    expect(rejectRefundRequest({ reason: '  duplicate request ', requestId: 'r-1' })).toEqual({ approve: false, reason: 'duplicate request', requestId: 'r-1', preview: false });
  });
});
