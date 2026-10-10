import {
  AdminBillingAccountDetailsSchema,
  AdminBillingAccountSchema,
  AdminBillingProvidersSchema,
  AdminBillingMutationResultSchema,
  AdminBillingPaymentSchema,
  AdminBillingRefundRequestSchema,
  AdminBillingRefundSchema,
  AdminBillingDisputeSchema,
  AdminPriceVersionSchema,
  AdminProviderEventSchema,
  AutoTopupAttemptStatus,
  AutoTopupSettingsSchema,
  BillingAccountStatus,
  BillingPaymentSchema,
  BillingPlanOfferSchema,
  BillingQuotePurpose,
  BillingQuoteSchema,
  BillingRefundRequestSchema,
  BillingResumeMode,
  BillingSalesMode,
  BillingState,
  BillingSummarySchema,
  CheckoutState,
  CheckoutStatusSchema,
  DisputeStatus,
  GetBillingResponseSchema,
  LedgerEntryKind,
  LedgerEntrySchema,
  PayerProfileSchema,
  PayerSchemaSchema,
  PayerType,
  checkPayer,
  PaymentMethodKind,
  PaymentOrigin,
  PaymentStatus,
  Plan,
  PlanLimitKind,
  PlanLimitViolationSchema,
  PlanSource,
  RefundOrigin,
  RefundRequestStatus,
  RefundStatus,
  SavedPaymentMethodSchema,
  SavedMethodTopupSchema,
  SavedMethodTopupState,
  type AdminBillingAccount,
  type BillingPlanOffer,
  type BillingSummary,
  type LedgerEntry,
  type Money,
  type PayerProfile,
} from '@calaba/protocol';
import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ApiError } from '../api/client';
import type { AdminBillingApi, BillingAdapters, OwnerBillingApi } from './api';
// The schema the server serves, pinned by its Go test (internal/billing/payer TestSchemaGolden).
import payerSchemaJson from '../../../../../../proto/testdata/billing_payer_schema.json';

const payerSchema = fromJson(PayerSchemaSchema, payerSchemaJson as JsonValue);

/**
 * In-memory billing for dev / QA builds (VITE_BILLING_MOCK=1, services/billing.ts): the owner
 * cabinet and the superadmin pages without a billing server. The scenario comes from
 * `?billing=<name>` or localStorage `calaba-billing-mock`: normal | debt | suspended | inactive |
 * stopped | member | memberSuspended | disabled | selfServe (no account until the first ACTIVATE quote).
 * A top-up checkout is «paid» on the second poll.
 * Never imported by a production build.
 */

const DAY = 86_400_000;
const USD = 'USD';
const usd = (minor: bigint): Money => ({ $typeName: 'calaba.v1.Money', minor, currency: USD });
/** Money in the currency of the mock account's market (ADR-0083: Global $, Russia ₽). */
const mon = (minor: bigint): Money => ({ $typeName: 'calaba.v1.Money', minor, currency: S().market === 'ru' ? 'RUB' : USD });

/**
 * Which markets new accounts may open in (ADR-0083), from `?sales=` or localStorage
 * `calaba-billing-sales`: global (default: Stripe only, as before) | both | ru | contact.
 * `?market=ru` makes the scenario's account a Russian (₽) one.
 */
type Sales = 'global' | 'both' | 'ru' | 'contact';
function param(name: string, key: string): string | null {
  try {
    const v = new URLSearchParams(location.search).get(name) ?? localStorage.getItem(key);
    if (v) localStorage.setItem(key, v);
    return v;
  } catch {
    return null;
  }
}
/**
 * ADR-0086 plan transitions: `?limits=over` — the workspace exceeds Team and Free (6 bots, an SSO
 * connection, rooms of 30, 7 GB of files): those offers carry violations and their quotes answer 409
 * PLAN_LIMITS_EXCEEDED; `?admin=1` — a superadmin assigned the plan (no self-serve, admin_assigned).
 */
const overLimits = (): boolean => param('limits', 'calaba-billing-limits') === 'over';
const adminAssigned = (): boolean => param('admin', 'calaba-billing-admin') === '1';
const v = (kind: PlanLimitKind, current: bigint, limit: bigint, rooms = 0) => create(PlanLimitViolationSchema, { kind, current, limit, rooms });
function violationsFor(p: Plan) {
  if (!overLimits() || p === Plan.ENTERPRISE) return [];
  if (p === Plan.TEAM) return [v(PlanLimitKind.BOTS, 6n, 5n), v(PlanLimitKind.ROOM_MEMBERS, 30n, 15n, 2), v(PlanLimitKind.SSO, 1n, 0n)];
  return [
    v(PlanLimitKind.BOTS, 6n, 1n),
    v(PlanLimitKind.STORAGE_MB, 7340n, 5120n),
    v(PlanLimitKind.ROOM_MEMBERS, 30n, 5n, 2),
    v(PlanLimitKind.AUTOMATIONS, 3n, 0n),
    v(PlanLimitKind.SSO, 1n, 0n),
  ];
}
const exceeded = (p: Plan): ApiError | null => {
  const list = violationsFor(p);
  return list.length ? new ApiError('ERROR_CODE_CONFLICT', 'the workspace uses more than the plan allows', 409, undefined, { reason: 'PLAN_LIMITS_EXCEEDED', planViolations: list }) : null;
};

const salesOf = (v: string | null): Sales => (v === 'both' || v === 'ru' || v === 'contact' ? v : 'global');
const ts = (ms: number) => timestampFromMs(ms);

type Market = 'global' | 'ru';
type Scenario = 'normal' | 'debt' | 'suspended' | 'inactive' | 'stopped' | 'member' | 'memberSuspended' | 'disabled' | 'selfServe';
const SCENARIOS: readonly Scenario[] = ['normal', 'debt', 'suspended', 'inactive', 'stopped', 'member', 'memberSuspended', 'disabled', 'selfServe'];

function scenario(): Scenario {
  let v: string | null = null;
  try {
    v = new URLSearchParams(location.search).get('billing') ?? localStorage.getItem('calaba-billing-mock');
    if (v) localStorage.setItem('calaba-billing-mock', v);
  } catch {
    // storage blocked: the default
  }
  return (SCENARIOS as readonly string[]).includes(v ?? '') ? (v as Scenario) : 'normal';
}

const wait = (ms = 180): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface State {
  sc: Scenario;
  status: BillingAccountStatus;
  plan: Plan.TEAM | Plan.ENTERPRISE;
  balance: bigint;
  members: number;
  negativeSince: number | null;
  suspendAt: number | null;
  revision: bigint;
  autoOn: boolean;
  cap: bigint;
  cardSaved: boolean;
  /** A billing account exists (selfServe: created by the first ACTIVATE quote). */
  account: boolean;
  market: Market;
  sales: Sales;
  /** Acquirers open for new clients (admin «Эквайеры»). */
  accept: { stripe: boolean; tochka: boolean };
  /** The admin moved «Orbit» (inactive, no payments) to Russia. */
  orbitRu: boolean;
  checkouts: Map<string, { amount: bigint; polls: number; save: boolean }>;
  ledger: LedgerEntry[];
  refundRequests: Array<ReturnType<typeof create<typeof BillingRefundRequestSchema>>>;
  payer: PayerProfile;
}

/** The mock's saved payer: a Russian company on the RU market, a German one otherwise. */
function initialPayer(market: Market): PayerProfile {
  return market === 'ru'
    ? create(PayerProfileSchema, {
        type: PayerType.COMPANY,
        name: 'ООО «Ромашка»',
        country: 'RU',
        email: 'billing@romashka.test',
        taxId: '7707083893',
        requisites: { inn: '7707083893', kpp: '773601001', ogrn: '1027700132195', legal_address: 'Москва, ул. Вавилова, 19' },
        version: 3,
      })
    : create(PayerProfileSchema, {
        type: PayerType.COMPANY,
        name: 'ООО «Ромашка»',
        country: 'DE',
        email: 'billing@romashka.test',
        taxId: 'DE123456789',
        requisites: { vat: 'DE123456789' },
        version: 2,
      });
}

const unit = (p: Plan, m: Market = S().market): bigint => (m === 'ru' ? (p === Plan.ENTERPRISE ? 1800n : 600n) : p === Plan.ENTERPRISE ? 30n : 10n);
const price = (minor: bigint, m: Market): Money => ({ $typeName: 'calaba.v1.Money', minor, currency: m === 'ru' ? 'RUB' : USD });

/** The plan offers of GET …/billing (built-in default limits of the server, plans/limits.go). */
function offers(m: Market = S().market): BillingPlanOffer[] {
  const free = { members: 50, roomMembers: 5, storageMb: 5n * 1024n, bots: 1, audioTierMaxKbps: 16, caldavDisabled: true, telephonyDisabled: true, automationsDisabled: true };
  const team = { members: 100, roomMembers: 15, storageMb: 300n * 1024n, bots: 5, telephonyDisabled: true };
  const biz = { members: 500, roomMembers: 50, storageMb: 1024n * 1024n, bots: 20 };
  return [
    create(BillingPlanOfferSchema, { plan: Plan.FREE, limits: free, market: m, violations: violationsFor(Plan.FREE) }),
    create(BillingPlanOfferSchema, { plan: Plan.TEAM, unitPrice: price(unit(Plan.TEAM, m), m), limits: team, market: m, violations: violationsFor(Plan.TEAM) }),
    create(BillingPlanOfferSchema, { plan: Plan.ENTERPRISE, unitPrice: price(unit(Plan.ENTERPRISE, m), m), limits: biz, market: m, violations: violationsFor(Plan.ENTERPRISE) }),
  ];
}

function seedLedger(now: number, balance: bigint, members: number, plan: Plan, market: Market): LedgerEntry[] {
  const mon = (minor: bigint): Money => price(minor, market);
  const out: LedgerEntry[] = [];
  let bal = balance;
  let seq = 40n;
  const each = unit(plan, market);
  for (let i = 0; i < 36; i++) {
    const topup = i % 12 === 5;
    const amount = topup ? 2500n : -(each * BigInt(members));
    const at = now - i * DAY - 3_600_000;
    out.push(
      create(LedgerEntrySchema, {
        id: `le-${seq}`,
        seq,
        kind: topup ? LedgerEntryKind.TOPUP : LedgerEntryKind.SEAT_CHARGE,
        amount: mon(amount),
        balanceAfter: mon(bal),
        createdAt: ts(at),
        ...(topup ? { paymentId: `pay-${i}` } : { sku: plan === Plan.ENTERPRISE ? 'seat.enterprise.day' : 'seat.team.day', quantity: members, startsAt: ts(at), endsAt: ts(at + DAY) }),
      }),
    );
    bal -= amount;
    seq--;
  }
  out.splice(
    3,
    0,
    create(LedgerEntrySchema, { id: 'le-credit', seq: 37n, kind: LedgerEntryKind.ADMIN_CREDIT, amount: mon(1000n), balanceAfter: mon(balance), createdAt: ts(now - 3 * DAY), reason: 'Компенсация за сбой 03.10' }),
  );
  return out;
}

/** Open markets for new accounts (ADR-0083). */
function openMarkets(s: State): Market[] {
  const byMode: Record<Sales, Market[]> = { global: ['global'], both: ['global', 'ru'], ru: ['ru'], contact: [] };
  return byMode[s.sales].filter((m) => (m === 'ru' ? s.accept.tochka : s.accept.stripe));
}

function salesMode(open: Market[]): BillingSalesMode {
  if (open.length === 2) return BillingSalesMode.BOTH;
  if (open[0] === 'ru') return BillingSalesMode.RU_ONLY;
  if (open[0] === 'global') return BillingSalesMode.GLOBAL_ONLY;
  return BillingSalesMode.CONTACT;
}

/** The market is fixed by the first payment (or an open checkout). */
const fixed = (s: State): boolean => s.ledger.length > 0 || s.checkouts.size > 0 || s.status === BillingAccountStatus.ACTIVE || s.status === BillingAccountStatus.SUSPENDED;

/** The sales part of GET …/billing: markets, mode, default and offers. */
function salesPart(s: State) {
  if (s.account && fixed(s)) return { markets: [s.market], offers: offers(s.market) };
  const open = openMarkets(s);
  const catalog: Market[] = open.length ? open : ['global'];
  const def: Market = open.length === 1 ? (open[0] ?? 'global') : s.account && open.includes(s.market) ? s.market : 'global';
  return { markets: open, salesMode: salesMode(open), defaultMarket: def, offers: catalog.flatMap((m) => offers(m)) };
}

function initial(): State {
  const sc = scenario();
  const now = Date.now();
  const members = 6;
  const market: Market = param('market', 'calaba-billing-market') === 'ru' ? 'ru' : 'global';
  const s: State = {
    sc,
    status: BillingAccountStatus.ACTIVE,
    plan: Plan.TEAM,
    balance: 4230n,
    members,
    negativeSince: null,
    suspendAt: null,
    revision: 12n,
    autoOn: true,
    cap: 50_000n,
    cardSaved: true,
    account: true,
    checkouts: new Map(),
    market,
    sales: salesOf(param('sales', 'calaba-billing-sales')),
    accept: { stripe: true, tochka: true },
    orbitRu: false,
    payer: initialPayer(market),
    ledger: [],
    refundRequests: [
      create(BillingRefundRequestSchema, { id: 'rr-1', amount: price(1500n, market), status: RefundRequestStatus.APPROVED, reason: 'Переплатили', createdAt: ts(now - 20 * DAY), decidedAt: ts(now - 19 * DAY) }),
    ],
  };
  if (sc === 'debt') Object.assign(s, { balance: -320n, negativeSince: now - 3 * DAY - 19 * 3_600_000, suspendAt: now + 3 * DAY + 5 * 3_600_000, autoOn: false });
  if (sc === 'suspended' || sc === 'memberSuspended')
    Object.assign(s, { status: BillingAccountStatus.SUSPENDED, balance: -560n, negativeSince: now - 8 * DAY, suspendAt: now - DAY, autoOn: false, cardSaved: false });
  if (sc === 'inactive' || sc === 'selfServe') Object.assign(s, { status: BillingAccountStatus.INACTIVE, balance: 0n, autoOn: false, cardSaved: false, refundRequests: [] });
  if (sc === 'selfServe') s.account = false;
  if (sc === 'stopped') Object.assign(s, { status: BillingAccountStatus.STOPPED, balance: 1210n, autoOn: false });
  if (overLimits()) s.plan = Plan.ENTERPRISE; // Business, over Team's and Free's limits (ADR-0086)
  s.ledger = sc === 'inactive' || sc === 'selfServe' ? [] : seedLedger(now, s.balance, members, s.plan, s.market);
  return s;
}

let st: State | null = null;
const S = (): State => (st ??= initial());

function stateOf(s: State): BillingState {
  if (s.status === BillingAccountStatus.SUSPENDED) return BillingState.SUSPENDED;
  if (s.status === BillingAccountStatus.INACTIVE) return BillingState.INACTIVE;
  if (s.status === BillingAccountStatus.STOPPED) return BillingState.STOPPED;
  return s.balance < 0n ? BillingState.IN_ARREARS : BillingState.ACTIVE;
}

function summary(s: State): BillingSummary {
  const price = unit(s.plan);
  const daily = s.status === BillingAccountStatus.ACTIVE ? price * BigInt(s.members) : 0n;
  const debt = s.balance < 0n ? -s.balance : 0n;
  const now = Date.now();
  return create(BillingSummarySchema, {
    accountId: 'acc-1',
    status: s.status,
    plan: s.plan,
    market: s.market,
    balance: mon(s.balance),
    debt: mon(debt),
    unitPrice: mon(price),
    dailyCost: mon(daily),
    billableMembers: s.members,
    coveredSeats: s.status === BillingAccountStatus.ACTIVE ? s.members : 0,
    ...(s.status === BillingAccountStatus.ACTIVE ? { nextDueAt: ts(now + 9 * 3_600_000) } : {}),
    ...(s.negativeSince ? { negativeSince: ts(s.negativeSince) } : {}),
    ...(s.suspendAt ? { suspendAt: ts(s.suspendAt) } : {}),
    forecastDays: daily > 0n && s.balance > 0n ? Number(s.balance / daily) : -1,
    revision: s.revision,
    methods:
      s.market === 'ru'
        ? [
            { id: 'tochka:card', provider: 'tochka', kind: PaymentMethodKind.CARD, min: mon(15_000n), max: mon(50_000_000n), autoTopupCapable: true },
            { id: 'tochka:sbp', provider: 'tochka', kind: PaymentMethodKind.SBP, min: mon(15_000n), max: mon(50_000_000n), autoTopupCapable: false },
          ]
        : [{ id: 'stripe:card', provider: 'stripe', kind: PaymentMethodKind.CARD, min: mon(500n), max: mon(500_000n), autoTopupCapable: true }],
    autoTopup: autoTopup(s),
    savedMethods: s.cardSaved ? [savedCard(s)] : [],
    payer: s.payer,
  });
}

/** The saved card: МИР ••0792 on Tochka in RU, Visa ••4242 on Stripe otherwise (one-click on). */
function savedCard(s: State) {
  const ru = s.market === 'ru';
  return create(SavedPaymentMethodSchema, {
    id: 'pm-1',
    kind: PaymentMethodKind.CARD,
    provider: ru ? 'tochka' : 'stripe',
    brand: ru ? 'mir' : 'visa',
    last4: ru ? '0792' : '4242',
    ...(ru ? {} : { expMonth: 8, expYear: 2029 }),
    createdAt: ts(Date.now() - 90 * DAY),
    oneClick: true,
    autoTopupCapable: true,
  });
}

/** One-click top-ups of the mock: ?oneclick=3ds asks for 3-D Secure (paid on the second poll), =decline fails. */
const oneClicks = new Map<string, { amount: bigint; polls: number }>();

function autoTopup(s: State) {
  const now = Date.now();
  const debt = s.balance < 0n ? -s.balance : 0n;
  return create(AutoTopupSettingsSchema, {
    enabled: s.autoOn,
    paymentMethodId: s.cardSaved ? 'pm-1' : '',
    maxAmount: mon(s.cap),
    defaultMaxAmount: mon(50_000n),
    limitMaxAmount: mon(500_000n),
    consentVersion: s.autoOn ? 1 : 0,
    ...(s.autoOn ? { consentAt: ts(now - 40 * DAY) } : {}),
    nextAmount: mon(debt + 30n * unit(s.plan) * BigInt(s.members)),
    ...(s.cardSaved
      ? { lastAttempt: { id: 'att-1', amount: mon(1800n), status: AutoTopupAttemptStatus.SUCCEEDED, createdAt: ts(now - 12 * DAY), finishedAt: ts(now - 12 * DAY + 4000) } }
      : {}),
  });
}

const unavailable = (): ApiError => new ApiError('ERROR_CODE_UNAVAILABLE', 'billing is not enabled', 501, undefined, { reason: 'BILLING_DISABLED' });

function guard(s: State): void {
  if (s.sc === 'disabled') throw unavailable();
}

function bump(s: State): void {
  s.revision++;
  if (s.balance >= 0n) {
    s.negativeSince = null;
    s.suspendAt = null;
  }
}

function quoteOf(s: State, purpose: BillingQuotePurpose, plan: Plan) {
  const debt = s.balance < 0n ? -s.balance : 0n;
  const price = unit(plan || s.plan);
  const day = price * BigInt(s.members);
  // ADR-0086: a stop returns nothing (paid days run to their end); only a plan change compensates.
  const comp = purpose === BillingQuotePurpose.CHANGE_PLAN ? unit(s.plan) * BigInt(s.members) / 2n : 0n;
  const charge = purpose === BillingQuotePurpose.STOP || purpose === BillingQuotePurpose.RESUME_FREE ? 0n : day;
  const free = s.balance > 0n ? s.balance : 0n;
  const need = debt + charge - comp - free;
  return create(BillingQuoteSchema, {
    quoteId: `q-${Date.now()}`,
    purpose,
    plan: plan || s.plan,
    debt: mon(debt),
    charge: mon(charge),
    compensation: mon(comp),
    toPay: mon(need > 0n ? need : 0n),
    seats: s.members,
    unitPrice: mon(price),
    expiresAt: ts(Date.now() + 10 * 60_000),
    revision: s.revision,
  });
}

function owner(): OwnerBillingApi {
  return {
    async get() {
      await wait();
      const s = S();
      guard(s);
      if (s.sc === 'member' || s.sc === 'memberSuspended')
        return create(GetBillingResponseSchema, { status: { state: s.sc === 'member' ? BillingState.ACTIVE : BillingState.SUSPENDED, source: PlanSource.BILLING, ...(s.suspendAt ? { suspendAt: ts(s.suspendAt) } : {}) } });
      if (adminAssigned()) return create(GetBillingResponseSchema, { status: { source: PlanSource.MANUAL }, adminAssigned: true });
      if (!s.account) return create(GetBillingResponseSchema, { status: { source: PlanSource.MANUAL }, selfServe: true, ...salesPart(s) });
      return create(GetBillingResponseSchema, {
        status: { state: stateOf(s), source: PlanSource.BILLING, ...(s.suspendAt ? { suspendAt: ts(s.suspendAt) } : {}) },
        summary: summary(s),
        ...salesPart(s),
      });
    },
    async quote(_ws, init) {
      await wait();
      const s = S();
      const purpose = init.purpose ?? BillingQuotePurpose.ACTIVATE;
      const want = init.market === 'ru' || init.market === 'global' ? init.market : undefined;
      if (purpose === BillingQuotePurpose.ACTIVATE && !(s.account && fixed(s))) {
        const open = openMarkets(s);
        const m = want ?? (open.length === 1 ? open[0] : 'global');
        if (!m || !open.includes(m)) throw new ApiError('ERROR_CODE_VALIDATION', 'market', 422, undefined, { reason: 'BILLING_MARKET_UNAVAILABLE' });
        s.market = m;
      } else if (want && want !== s.market) {
        throw new ApiError('ERROR_CODE_CONFLICT', 'market fixed', 409, undefined, { reason: 'BILLING_MARKET_FIXED' });
      }
      const target = purpose === BillingQuotePurpose.STOP ? Plan.FREE : purpose === BillingQuotePurpose.RESUME_FREE ? null : (init.plan || s.plan);
      const over = target === null || target === s.plan ? null : exceeded(target);
      if (over) throw over;
      if (!s.account) {
        if (purpose !== BillingQuotePurpose.ACTIVATE) throw new ApiError('ERROR_CODE_NOT_FOUND', 'billing account not found', 404, undefined, { reason: 'BILLING_ACCOUNT_NOT_FOUND' });
        s.account = true; // self-serve: the ACTIVATE quote starts the account
        bump(s);
      }
      return quoteOf(s, purpose, init.plan ?? Plan.UNSPECIFIED);
    },
    async activate(_ws, init) {
      await wait();
      const s = S();
      if (init.plan === Plan.TEAM || init.plan === Plan.ENTERPRISE) s.plan = init.plan;
      s.balance -= unit(s.plan) * BigInt(s.members);
      s.status = BillingAccountStatus.ACTIVE;
      bump(s);
    },
    async stop() {
      await wait();
      const s = S();
      s.status = BillingAccountStatus.STOPPED;
      bump(s);
    },
    async changePlan(_ws, init) {
      await wait();
      const s = S();
      const from = s.plan;
      s.plan = init.plan === Plan.ENTERPRISE ? Plan.ENTERPRISE : Plan.TEAM;
      // The ledger of a change (ADR-0086 history): a full day of the new plan, the unused rest of the old one back.
      const charge = unit(s.plan) * BigInt(s.members);
      const comp = (unit(from) * BigInt(s.members) * 7n) / 10n;
      const op = `op-${s.revision}`;
      const now = Date.now();
      s.balance += comp;
      s.ledger.unshift(
        create(LedgerEntrySchema, { id: `${op}-c`, seq: s.revision + 200n, kind: LedgerEntryKind.COMPENSATION, amount: mon(comp), balanceAfter: mon(s.balance), createdAt: ts(now), reason: 'seats returned', sku: from === Plan.ENTERPRISE ? 'seat.enterprise.day' : 'seat.team.day', quantity: s.members, operationId: op }),
      );
      s.balance -= charge;
      s.ledger.unshift(
        create(LedgerEntrySchema, { id: `${op}-s`, seq: s.revision + 201n, kind: LedgerEntryKind.SEAT_CHARGE, amount: mon(-charge), balanceAfter: mon(s.balance), createdAt: ts(now), reason: 'change_plan', sku: s.plan === Plan.ENTERPRISE ? 'seat.enterprise.day' : 'seat.team.day', quantity: s.members, startsAt: ts(now), endsAt: ts(now + DAY), operationId: op }),
      );
      bump(s);
    },
    async resume(_ws, init) {
      await wait();
      const s = S();
      if (s.balance < 0n) throw new ApiError('ERROR_CODE_CONFLICT', 'insufficient', 409, undefined, { reason: 'BILLING_INSUFFICIENT_FUNDS' });
      s.status = init.mode === BillingResumeMode.PAID ? BillingAccountStatus.ACTIVE : BillingAccountStatus.STOPPED;
      bump(s);
    },
    async payer() {
      await wait();
      return summary(S()).payer ?? create(PayerProfileSchema);
    },
    async putPayer(_ws, init) {
      await wait();
      const s = S();
      const { payer, problems } = checkPayer(payerSchema, {
        type: init.type ?? PayerType.UNSPECIFIED,
        name: init.name ?? '',
        country: init.country ?? '',
        email: init.email ?? '',
        taxId: init.taxId ?? '',
        requisites: init.requisites ?? {},
      });
      const first = problems[0];
      if (!payer || first) throw new ApiError('ERROR_CODE_VALIDATION', 'invalid payer', 422, first?.field, { reason: first?.reason ?? 'PAYER_FORMAT' });
      s.payer = create(PayerProfileSchema, { ...payer, version: s.payer.version + 1 });
      bump(s);
      return s.payer;
    },
    async payerSchema() {
      await wait(60);
      return payerSchema;
    },
    async topup(_ws, init) {
      await wait(300);
      const s = S();
      const amount = init.amount?.minor ?? 0n;
      const [lo, hi] = s.market === 'ru' ? [15_000n, 50_000_000n] : [500n, 500_000n];
      if (amount < lo || amount > hi) throw new ApiError('ERROR_CODE_VALIDATION', 'range', 422, 'amount', { reason: 'BILLING_AMOUNT_OUT_OF_RANGE' });
      const id = `co-${Date.now()}`;
      s.checkouts.set(id, { amount, polls: 0, save: !!init.saveMethod });
      const url = s.market === 'ru' ? `https://merch.securepaytb.ru/order/?uuid=mock_${id}` : `https://checkout.stripe.com/c/pay/mock_${id}`;
      return { $typeName: 'calaba.v1.CreateTopupResponse', checkoutId: id, url };
    },
    async checkout(_ws, cid) {
      await wait(120);
      const s = S();
      const c = s.checkouts.get(cid);
      if (!c) throw new ApiError('ERROR_CODE_NOT_FOUND', 'checkout', 404);
      c.polls++;
      const paid = c.polls >= 2;
      if (paid && c.polls === 2) {
        s.balance += c.amount;
        if (c.save) s.cardSaved = true;
        if (s.status === BillingAccountStatus.SUSPENDED && s.balance >= 0n) s.status = BillingAccountStatus.STOPPED;
        s.ledger.unshift(
          create(LedgerEntrySchema, { id: `le-${cid}`, seq: s.revision + 100n, kind: LedgerEntryKind.TOPUP, amount: mon(c.amount), balanceAfter: mon(s.balance), createdAt: ts(Date.now()), paymentId: `pay-${cid}` }),
        );
        bump(s);
      }
      return create(CheckoutStatusSchema, { checkoutId: cid, state: paid ? CheckoutState.COMPLETED : CheckoutState.OPEN, amount: mon(c.amount), credited: paid, ...(paid ? { paymentId: `pay-${cid}` } : {}) });
    },
    async savedTopup(_ws, init) {
      await wait(500);
      const s = S();
      const amount = init.amount?.minor ?? 0n;
      const [lo, hi] = s.market === 'ru' ? [15_000n, 50_000_000n] : [500n, 500_000n];
      if (amount < lo || amount > hi) throw new ApiError('ERROR_CODE_VALIDATION', 'range', 422, 'amount', { reason: 'BILLING_AMOUNT_OUT_OF_RANGE' });
      const id = `sm-${Date.now()}`;
      const mode = param('oneclick', 'calaba-billing-oneclick');
      const base = { id, amount: mon(amount), paymentMethodId: init.paymentMethodId ?? '', createdAt: ts(Date.now()) };
      if (mode === 'decline') return create(SavedMethodTopupSchema, { ...base, state: SavedMethodTopupState.FAILED, failureCode: 'card_declined' });
      if (mode === '3ds') {
        oneClicks.set(id, { amount, polls: 0 });
        return create(SavedMethodTopupSchema, { ...base, state: SavedMethodTopupState.REQUIRES_ACTION, actionUrl: 'https://hooks.stripe.com/3d_secure_2/hosted?mock=1' });
      }
      s.balance += amount;
      bump(s);
      return create(SavedMethodTopupSchema, { ...base, state: SavedMethodTopupState.SUCCEEDED, credited: true });
    },
    async savedTopupStatus(_ws, id) {
      await wait(120);
      const s = S();
      const c = oneClicks.get(id);
      if (!c) throw new ApiError('ERROR_CODE_NOT_FOUND', 'top-up', 404);
      c.polls++;
      const base = { id, amount: mon(c.amount), paymentMethodId: 'pm-1', createdAt: ts(Date.now()) };
      if (c.polls < 2) return create(SavedMethodTopupSchema, { ...base, state: SavedMethodTopupState.REQUIRES_ACTION, actionUrl: 'https://hooks.stripe.com/3d_secure_2/hosted?mock=1' });
      if (c.polls === 2) {
        s.balance += c.amount;
        bump(s);
      }
      return create(SavedMethodTopupSchema, { ...base, state: SavedMethodTopupState.SUCCEEDED, credited: true });
    },
    async autoTopup() {
      await wait();
      return autoTopup(S());
    },
    async putAutoTopup(_ws, init) {
      await wait();
      const s = S();
      s.autoOn = true;
      s.cap = init.maxAmount?.minor ?? s.cap;
      bump(s);
    },
    async revokeAutoTopup() {
      await wait();
      const s = S();
      s.autoOn = false;
      bump(s);
    },
    async paymentMethods() {
      await wait();
      const s = S();
      return {
        $typeName: 'calaba.v1.SavedPaymentMethods',
        methods: s.cardSaved ? [savedCard(s)] : [],
      };
    },
    async detachMethod() {
      await wait();
      const s = S();
      s.cardSaved = false;
      s.autoOn = false;
      bump(s);
    },
    async ledger(_ws, cursor) {
      await wait();
      const all = S().ledger;
      const from = Number(cursor || '0');
      const page = all.slice(from, from + 20);
      return { $typeName: 'calaba.v1.LedgerPage', entries: page, nextCursor: from + 20 < all.length ? String(from + 20) : '' };
    },
    async payments() {
      await wait();
      const now = Date.now();
      const payments = [0, 1, 2].map((i) =>
        create(BillingPaymentSchema, {
          id: `pay-${i}`,
          amount: mon(i === 1 ? 1800n : 2500n),
          status: PaymentStatus.SUCCEEDED,
          origin: i === 1 ? PaymentOrigin.AUTO_TOPUP : PaymentOrigin.CHECKOUT,
          succeededAt: ts(now - (5 + i * 12) * DAY),
          createdAt: ts(now - (5 + i * 12) * DAY),
          receiptUrl: 'https://pay.stripe.com/receipts/mock',
          refunded: mon(i === 2 ? 1500n : 0n),
        }),
      );
      return { $typeName: 'calaba.v1.BillingPaymentPage', payments: S().sc === 'inactive' ? [] : payments, nextCursor: '' };
    },
    async refundRequests() {
      await wait();
      return { $typeName: 'calaba.v1.BillingRefundRequests', requests: S().refundRequests };
    },
    async createRefundRequest(_ws, init) {
      await wait();
      const r = create(BillingRefundRequestSchema, { id: `rr-${Date.now()}`, amount: mon(init.amount?.minor ?? 0n), status: RefundRequestStatus.REQUESTED, reason: init.reason ?? '', createdAt: ts(Date.now()) });
      S().refundRequests.unshift(r);
      return r;
    },
  };
}

function accounts(): AdminBillingAccount[] {
  const now = Date.now();
  const s = S();
  const mk = (i: number, name: string, email: string, status: BillingAccountStatus, balance: bigint, plan: Plan, extra: Omit<Partial<AdminBillingAccount>, '$typeName' | '$unknown'> = {}) =>
    create(AdminBillingAccountSchema, {
      accountId: `acc-${i}`,
      workspaceId: `ws-${i}`,
      workspaceName: name,
      ownerEmail: email,
      market: 'global',
      status,
      plan,
      balance: usd(balance),
      debt: usd(balance < 0n ? -balance : 0n),
      createdAt: ts(now - (60 + i) * DAY),
      revision: BigInt(10 + i),
      billableMembers: 3 + i,
      ...(status === BillingAccountStatus.ACTIVE ? { nextDueAt: ts(now + 5 * 3_600_000) } : {}),
      ...extra,
    });
  return [
    mk(1, 'Calab Team', 'owner@calaba.test', s.status, s.balance, s.plan, s.suspendAt ? { suspendAt: ts(s.suspendAt), negativeSince: ts(s.negativeSince ?? now) } : {}),
    mk(2, 'Studio North', 'anna@north.test', BillingAccountStatus.ACTIVE, -1240n, Plan.ENTERPRISE, { negativeSince: ts(now - 2 * DAY), suspendAt: ts(now + 5 * DAY), discountBps: 1500 }),
    mk(3, 'Garage Lab', 'dev@garage.test', BillingAccountStatus.SUSPENDED, -880n, Plan.TEAM, { suspendAt: ts(now - DAY), negativeSince: ts(now - 8 * DAY) }),
    mk(4, 'Orbit', 'cto@orbit.test', BillingAccountStatus.INACTIVE, 0n, Plan.TEAM, s.orbitRu ? { market: 'ru', balance: price(0n, 'ru'), debt: price(0n, 'ru') } : {}),
    mk(5, 'Pixel Forge', 'hi@pixel.test', BillingAccountStatus.ACTIVE, 98_120n, Plan.ENTERPRISE, { holdUntil: ts(now + 2 * DAY), disputeHold: true }),
  ];
}

function providersView(s: State) {
  return create(AdminBillingProvidersSchema, {
    providers: [
      { id: 'stripe', markets: ['global'], acceptNew: s.accept.stripe },
      { id: 'tochka', markets: ['ru'], acceptNew: s.accept.tochka, ...(s.accept.tochka ? {} : { updatedAt: ts(Date.now()) }) },
    ],
    mode: salesMode((['global', 'ru'] as Market[]).filter((m) => (m === 'ru' ? s.accept.tochka : s.accept.stripe))),
  });
}

function admin(): AdminBillingApi {
  const result = (a: AdminBillingAccount, before: bigint, after: bigint, preview: boolean) =>
    create(AdminBillingMutationResultSchema, { preview, balanceBefore: usd(before), balanceAfter: usd(after), account: { ...a, balance: usd(after) }, auditId: preview ? '' : `audit-${Date.now()}` });
  const find = (id: string): AdminBillingAccount => {
    const all = accounts();
    return all.find((a) => a.accountId === id) ?? all[0] ?? create(AdminBillingAccountSchema);
  };
  return {
    async accounts(q) {
      await wait();
      guard(S());
      const needle = (q.q ?? '').toLowerCase();
      return { $typeName: 'calaba.v1.AdminBillingAccounts', accounts: accounts().filter((a) => !needle || `${a.workspaceName} ${a.ownerEmail}`.toLowerCase().includes(needle)), nextCursor: '' };
    },
    async account(id) {
      await wait();
      const a = find(id);
      return create(AdminBillingAccountDetailsSchema, {
        account: a,
        freeAdvance: usd(a.balance && a.balance.minor > 0n ? a.balance.minor : 0n),
        pendingRefunds: usd(0n),
        savedMethods: id === 'acc-1' && S().cardSaved ? [savedCard(S())] : [],
      });
    },
    async ledger(id, cursor) {
      return owner().ledger(id, cursor);
    },
    async payments(q) {
      await wait();
      const page = await owner().payments(q.accountId ?? '', '');
      return {
        $typeName: 'calaba.v1.AdminBillingPayments',
        payments: page.payments.map((p) => create(AdminBillingPaymentSchema, { payment: p, accountId: q.accountId ?? 'acc-1', provider: 'stripe', providerPaymentId: `pi_3Q${p.id}`, livemode: false })),
        nextCursor: '',
      };
    },
    async refunds(q) {
      await wait();
      return {
        $typeName: 'calaba.v1.AdminBillingRefunds',
        refunds: [
          create(AdminBillingRefundSchema, {
            refund: { id: 'rf-1', paymentId: 'pay-2', amount: usd(1500n), status: RefundStatus.SUCCEEDED, origin: RefundOrigin.CALAB, reason: 'Переплатили', createdAt: ts(Date.now() - 19 * DAY), succeededAt: ts(Date.now() - 19 * DAY) },
            accountId: q.accountId ?? 'acc-1',
            providerRefundId: 're_3Qmock',
          }),
        ],
        nextCursor: '',
      };
    },
    async refundRequests(q) {
      await wait();
      return {
        $typeName: 'calaba.v1.AdminBillingRefundRequests',
        requests: [
          create(AdminBillingRefundRequestSchema, {
            request: { id: 'rr-2', amount: usd(2000n), status: RefundRequestStatus.REQUESTED, reason: 'Закрываем пространство, верните остаток', createdAt: ts(Date.now() - 2 * 3_600_000) },
            accountId: q.accountId ?? 'acc-2',
            workspaceId: 'ws-2',
          }),
        ],
        nextCursor: '',
      };
    },
    async disputes(q) {
      await wait();
      return {
        $typeName: 'calaba.v1.AdminBillingDisputes',
        disputes:
          q.accountId === 'acc-5'
            ? [create(AdminBillingDisputeSchema, { dispute: { id: 'dp-1', paymentId: 'pay-0', amount: usd(2500n), status: DisputeStatus.OPEN, createdAt: ts(Date.now() - 3 * DAY) }, accountId: 'acc-5', providerDisputeId: 'du_mock' })]
            : [],
        nextCursor: '',
      };
    },
    async events() {
      await wait();
      return {
        $typeName: 'calaba.v1.AdminProviderEvents',
        events: [
          create(AdminProviderEventSchema, { id: 'ev-1', provider: 'stripe', eventId: 'evt_1Qmock', kind: 'payment_intent.succeeded', objectId: 'pi_3Qpay-0', receivedAt: ts(Date.now() - 600_000), processedAt: ts(Date.now() - 599_000), attempts: 1 }),
          create(AdminProviderEventSchema, { id: 'ev-2', provider: 'stripe', eventId: 'evt_1Qfail', kind: 'charge.refunded', objectId: 'ch_3Qmock', receivedAt: ts(Date.now() - 3_600_000), attempts: 4, error: 'payment not found: pi_3Qunknown' }),
        ],
        nextCursor: '',
      };
    },
    async enable(ws, init) {
      await wait();
      const a = create(AdminBillingAccountSchema, { accountId: `acc-${ws}`, workspaceId: ws, status: BillingAccountStatus.INACTIVE, plan: init.plan ?? Plan.TEAM, market: init.market ?? 'global', balance: usd(0n), debt: usd(0n), revision: 1n });
      return result(a, 0n, 0n, false);
    },
    async manualCredit(id, init) {
      await wait();
      const a = find(id);
      const b = a.balance?.minor ?? 0n;
      return result(a, b, b + (init.amount?.minor ?? 0n), !!init.preview);
    },
    async reverseCredit(id, _cid, init) {
      await wait();
      const a = find(id);
      const b = a.balance?.minor ?? 0n;
      return result(a, b, b - 1000n, !!init.preview);
    },
    async refund(_pid, init) {
      await wait();
      const a = find('acc-1');
      const b = a.balance?.minor ?? 0n;
      if ((init.amount?.minor ?? 0n) > 2500n) throw new ApiError('ERROR_CODE_CONFLICT', 'refundable', 409, undefined, { reason: 'BILLING_REFUND_EXCEEDS_REFUNDABLE' });
      return result(a, b, b - (init.amount?.minor ?? 0n), !!init.preview);
    },
    async decideRefundRequest(_id, init) {
      await wait();
      const a = find('acc-2');
      const b = a.balance?.minor ?? 0n;
      return result(a, b, init.approve ? b - 2000n : b, !!init.preview);
    },
    async hold(id) {
      await wait();
      const a = find(id);
      return result(a, a.balance?.minor ?? 0n, a.balance?.minor ?? 0n, false);
    },
    async reconcile(id) {
      await wait();
      const a = find(id);
      return result(a, a.balance?.minor ?? 0n, a.balance?.minor ?? 0n, false);
    },
    async discount(id, init) {
      await wait();
      const a = find(id);
      return result({ ...a, discountBps: init.discountBps ?? 0 }, a.balance?.minor ?? 0n, a.balance?.minor ?? 0n, false);
    },
    async prices() {
      await wait();
      const now = Date.now();
      return {
        $typeName: 'calaba.v1.AdminPriceVersions',
        prices: [
          create(AdminPriceVersionSchema, { id: 'pr-1', market: 'global', sku: 'seat.team.day', plan: Plan.TEAM, unit: usd(10n), effectiveFrom: ts(now - 200 * DAY), createdAt: ts(now - 200 * DAY) }),
          create(AdminPriceVersionSchema, { id: 'pr-2', market: 'global', sku: 'seat.enterprise.day', plan: Plan.ENTERPRISE, unit: usd(30n), effectiveFrom: ts(now - 200 * DAY), createdAt: ts(now - 200 * DAY) }),
          create(AdminPriceVersionSchema, { id: 'pr-3', market: 'global', sku: 'seat.team.day', plan: Plan.TEAM, unit: usd(12n), effectiveFrom: ts(now + 14 * DAY), createdAt: ts(now - DAY) }),
        ],
      };
    },
    async changeMarket(id, init) {
      await wait();
      const s = S();
      const a = find(id);
      if (a.status !== BillingAccountStatus.INACTIVE) throw new ApiError('ERROR_CODE_CONFLICT', 'market fixed', 409, undefined, { reason: 'BILLING_MARKET_FIXED' });
      if (!init.preview && id === 'acc-4') s.orbitRu = init.market === 'ru';
      const m: Market = init.market === 'ru' ? 'ru' : 'global';
      return create(AdminBillingMutationResultSchema, { preview: !!init.preview, account: { ...a, market: m, balance: price(0n, m), debt: price(0n, m) }, auditId: init.preview ? '' : `audit-${Date.now()}` });
    },
    async providers() {
      await wait();
      return providersView(S());
    },
    async setProvider(id, init) {
      await wait();
      const s = S();
      if (!init.preview && (id === 'stripe' || id === 'tochka')) s.accept[id] = !!init.acceptNew;
      return create(AdminBillingMutationResultSchema, { preview: !!init.preview, providers: providersView(s), auditId: init.preview ? '' : `audit-${Date.now()}` });
    },
    async createPrice(init) {
      await wait();
      return create(AdminPriceVersionSchema, { id: `pr-${Date.now()}`, market: init.market ?? 'global', plan: init.plan ?? Plan.TEAM, sku: 'seat.team.day', ...(init.unit ? { unit: init.unit } : {}), ...(init.effectiveFrom ? { effectiveFrom: init.effectiveFrom } : {}) });
    },
  };
}

export function createMockAdapters(): BillingAdapters {
  return { owner: owner(), admin: admin() };
}
