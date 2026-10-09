import {
  BillingAccountStatus,
  BillingState,
  PaymentMethodKind,
  Plan,
  type BillingSummary,
  type Money,
  type PaymentMethodOption,
  type WorkspaceBillingStatus,
} from '@calaba/protocol';
import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import { clampMinor, currencyDigits, maxMinor, minorOf } from './money';

/**
 * Pure rules of the owner billing cabinet (ADR-0080 v5 §0, §7, §8, §13): what to show for a
 * summary, how far the suspension deadline is, which top-up amounts are offered and whether a
 * typed amount is acceptable. The server re-validates everything; these only shape the UI.
 */

/** Text of the consent the owner accepts for auto-topup; bump with the wording (PUT …/auto-topup). */
export const AUTO_TOPUP_CONSENT_VERSION = 1;

/** Auto-topup reserve: debt + this many days of the current team (owner's rule, ADR-0080 §7). */
export const RESERVE_DAYS = 30n;

/** Fallback USD limits of v1 when the server sends none (ADR-0080 §0): top-up $5..$5000, cap $500 / $5000. */
export const USD_TOPUP_MIN = 500n;
export const USD_TOPUP_MAX = 500_000n;
export const USD_AUTO_DEFAULT = 50_000n;
export const USD_AUTO_MAX = 500_000n;

/** The billing state everyone may see (Workspace.billing); UNSPECIFIED = no billing account. */
export const billingStateOf = (b: WorkspaceBillingStatus | undefined): BillingState => b?.state ?? BillingState.UNSPECIFIED;

export const isSuspended = (b: WorkspaceBillingStatus | undefined): boolean => billingStateOf(b) === BillingState.SUSPENDED;

/** Billing is a paid plan (Team / Business); anything else is shown as Team. */
export const billingPlan = (p: Plan): Plan.TEAM | Plan.ENTERPRISE => (p === Plan.ENTERPRISE ? Plan.ENTERPRISE : Plan.TEAM);

export const otherPlan = (p: Plan): Plan.TEAM | Plan.ENTERPRISE => (billingPlan(p) === Plan.TEAM ? Plan.ENTERPRISE : Plan.TEAM);

/** What the cabinet offers for the account status. */
export type CabinetPhase = 'inactive' | 'active' | 'arrears' | 'stopped' | 'suspended' | 'closed';

export function cabinetPhase(s: BillingSummary, state: BillingState): CabinetPhase {
  if (s.status === BillingAccountStatus.CLOSED) return 'closed';
  if (s.status === BillingAccountStatus.SUSPENDED || state === BillingState.SUSPENDED) return 'suspended';
  if (s.status === BillingAccountStatus.INACTIVE) return 'inactive';
  if (s.status === BillingAccountStatus.STOPPED) return 'stopped';
  if (minorOf(s.debt) > 0n || state === BillingState.IN_ARREARS) return 'arrears';
  return 'active';
}

/** «≈ N дней» of the forecast: none when not running or in debt; 'lessThanDay' under one day. */
export type Forecast = { kind: 'none' } | { kind: 'lessThanDay' } | { kind: 'days'; days: number };

export function forecastOf(s: BillingSummary): Forecast {
  if (s.forecastDays < 0 || minorOf(s.debt) > 0n || minorOf(s.dailyCost) <= 0n) return { kind: 'none' };
  if (s.forecastDays === 0) return { kind: 'lessThanDay' };
  return { kind: 'days', days: s.forecastDays };
}

/** Time left until a deadline, for the countdown («6 д 23 ч», «3 ч 12 мин»). Never negative. */
export interface Left {
  days: number;
  hours: number;
  minutes: number;
  /** ≤ 0: the deadline has passed. */
  ms: number;
}

export function timeLeft(deadlineMs: number, nowMs: number): Left {
  const ms = Math.max(0, deadlineMs - nowMs);
  const totalMin = Math.floor(ms / 60_000);
  return { days: Math.floor(totalMin / 1440), hours: Math.floor((totalMin % 1440) / 60), minutes: totalMin % 60, ms: deadlineMs - nowMs };
}

/** How often a countdown must tick: each minute within a day, each 10 minutes before. */
export const countdownPeriod = (left: Left): number => (left.days >= 1 ? 600_000 : 60_000);

/** A timestamp in ms, null when unset. */
export const tsMs = (ts: Timestamp | undefined): number | null => (ts ? timestampMs(ts) : null);

/** The money a manual top-up is allowed in for an option (server limits, v1 USD fallback). */
export function topupLimits(o: PaymentMethodOption | undefined, currency: string): { min: bigint; max: bigint } {
  const usd = currency === 'USD';
  const min = o?.min && o.min.minor > 0n ? o.min.minor : usd ? USD_TOPUP_MIN : 1n;
  const max = o?.max && o.max.minor > 0n ? o.max.minor : usd ? USD_TOPUP_MAX : 10n ** 12n;
  return { min, max: max < min ? min : max };
}

export type AmountProblem = 'empty' | 'invalid' | 'tooSmall' | 'tooLarge';

/** Why an amount (minor, or null = unparsable / empty input) cannot be paid; null when it can. */
export function amountProblem(minor: bigint | null, raw: string, lim: { min: bigint; max: bigint }): AmountProblem | null {
  if (minor === null) return raw.trim() ? 'invalid' : 'empty';
  if (minor < lim.min) return 'tooSmall';
  if (minor > lim.max) return 'tooLarge';
  return null;
}

/** Debt + 30 days of the current daily cost (the auto-topup formula, also a top-up preset). */
export function reserveAmount(s: BillingSummary): bigint {
  return maxMinor(0n, minorOf(s.debt)) + RESERVE_DAYS * maxMinor(0n, minorOf(s.dailyCost));
}

export interface Preset {
  minor: bigint;
  /** The «долг + 30 суток» preset (labelled separately). */
  reserve: boolean;
}

/**
 * Amount presets: the reserve (debt + 30 days, rounded up to a whole unit, within the limits) first,
 * then round amounts inside the limits (USD: 10 / 25 / 50 / 100 / 250). Distinct, ascending after
 * the reserve; at most 5.
 */
export function topupPresets(s: BillingSummary, lim: { min: bigint; max: bigint }, currency: string): Preset[] {
  const unit = 10n ** BigInt(currencyDigits(currency));
  const steps = currency === 'RUB' ? [500n, 1000n, 3000n, 5000n] : [10n, 25n, 50n, 100n, 250n];
  const out: Preset[] = [];
  const reserve = reserveAmount(s);
  if (reserve > 0n) {
    const up = ((reserve + unit - 1n) / unit) * unit;
    out.push({ minor: clampMinor(up, lim.min, lim.max), reserve: true });
  }
  for (const st of steps) {
    const v = st * unit;
    if (v < lim.min || v > lim.max || out.some((p) => p.minor === v)) continue;
    out.push({ minor: v, reserve: false });
    if (out.length >= 5) break;
  }
  return out;
}

/** The first preset an empty top-up form starts with: the reserve, else the smallest round amount. */
export function defaultTopup(s: BillingSummary, lim: { min: bigint; max: bigint }, currency: string): bigint {
  const p = topupPresets(s, lim, currency);
  return p[0]?.minor ?? lim.min;
}

/** Auto-topup cap limits: default / max from the server, v1 USD fallback. */
export function autoTopupLimits(s: BillingSummary): { def: bigint; max: bigint } {
  const a = s.autoTopup;
  const usd = s.balance?.currency === 'USD';
  const max = a?.limitMaxAmount && a.limitMaxAmount.minor > 0n ? a.limitMaxAmount.minor : usd ? USD_AUTO_MAX : 10n ** 12n;
  const def = a?.defaultMaxAmount && a.defaultMaxAmount.minor > 0n ? a.defaultMaxAmount.minor : usd ? USD_AUTO_DEFAULT : max;
  return { def: def > max ? max : def, max };
}

/** Methods the cabinet may offer for a manual top-up (server list, unknown kinds dropped). */
export function offeredMethods(s: BillingSummary): PaymentMethodOption[] {
  return s.methods.filter((m) => m.id !== '' && m.kind !== PaymentMethodKind.UNSPECIFIED);
}

/** Auto-topup can be offered: some method is capable of it (Stripe card, ADR-0080 §0). */
export const autoTopupOffered = (s: BillingSummary): boolean => s.methods.some((m) => m.autoTopupCapable);

/** The account currency (balance first, then the price). */
export const currencyOf = (s: BillingSummary | undefined): string => s?.balance?.currency || s?.unitPrice?.currency || s?.dailyCost?.currency || 'USD';

/** Money with the account currency. */
export const money = (minor: bigint, currency: string): { minor: bigint; currency: string } => ({ minor, currency });

/** «4 × $0.10 = $0.40 в сутки»: true when the summary carries what the line needs. */
export const hasDailyLine = (s: BillingSummary): boolean => s.billableMembers > 0 && !!s.unitPrice;

/** Sum of Money values of one currency (bigint). */
export const sumMinor = (...ms: Array<Money | undefined>): bigint => ms.reduce((a, m) => a + minorOf(m), 0n);

/** Request ids of money mutations: one per form open, so a double click is the same request. */
export function requestId(): string {
  return globalThis.crypto.randomUUID();
}
