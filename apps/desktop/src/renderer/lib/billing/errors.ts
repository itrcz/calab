import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../api/client';
import { errorText } from '../api/errors';

/**
 * ApiError.reason values of billing (apps/server/internal/billing/errors.go, ADR-0080 §13) → the
 * cabinet's sentences. Anything else falls back to the generic texts of lib/api/errors.
 */
const REASON: Record<string, MessageKey> = {
  BILLING_INSUFFICIENT_FUNDS: 'billing.err.insufficient',
  BILLING_QUOTE_EXPIRED: 'billing.err.quoteExpired',
  BILLING_REVISION_CONFLICT: 'billing.err.revision',
  BILLING_RECONCILING: 'billing.err.reconciling',
  BILLING_PAYMENT_PENDING: 'billing.err.pending',
  BILLING_PAYMENT_UNKNOWN: 'billing.err.unknown',
  BILLING_CHANGE_INCOMPATIBLE: 'billing.err.incompatible',
  BILLING_PRICE_CONFIRMATION_REQUIRED: 'billing.err.priceConfirm',
  BILLING_SEAT_GROWTH_REQUIRES_FUNDS: 'billing.err.seatGrowth',
  BILLING_REQUEST_REUSED: 'billing.err.reused',
  BILLING_PLAN_MANAGED: 'billing.err.planManaged',
  BILLING_ACCOUNT_EXISTS: 'billing.err.exists',
  BILLING_METHOD_UNAVAILABLE: 'billing.err.method',
  BILLING_OWNER_REQUIRED: 'billing.err.owner', // servers before ADR-0087
  BILLING_PERMISSION_REQUIRED: 'billing.err.permission',
  WORKSPACE_BILLING_SUSPENDED: 'billing.err.suspended',
  BILLING_DISABLED: 'billing.soon',
  BILLING_NOT_IMPLEMENTED: 'billing.soon',
  BILLING_PROVIDER_UNAVAILABLE: 'billing.err.provider',
  BILLING_AUTO_TOPUP_LIMIT: 'billing.err.autoLimit',
  BILLING_AUTO_TOPUP_UNAVAILABLE: 'billing.err.autoUnavailable',
  BILLING_REFUND_EXCEEDS_REFUNDABLE: 'billing.err.refundExceeds',
  BILLING_REFUND_NOT_RELEASABLE: 'billing.err.notReleasable',
  BILLING_ACCOUNT_NOT_FOUND: 'billing.err.notFound',
  BILLING_DISPUTE_HOLD: 'billing.err.disputeHold',
  BILLING_CURRENCY_MISMATCH: 'billing.err.currency',
  BILLING_AMOUNT_OUT_OF_RANGE: 'billing.err.range',
  BILLING_PRICE_EFFECTIVE_TOO_SOON: 'billing.err.priceTooSoon',
  BILLING_CREDIT_ALREADY_REVERSED: 'billing.err.reversed',
  BILLING_MARKET_FIXED: 'billing.err.marketFixed',
  BILLING_MARKET_UNAVAILABLE: 'billing.err.marketUnavailable',
};

const reasonOf = (e: unknown): string | undefined => (e instanceof ApiError ? e.reason : undefined);

/** 501: billing is off on this server (BILLING_ENABLED=false) or the route is not built yet. */
export function billingUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 501 || e.reason === 'BILLING_DISABLED' || e.reason === 'BILLING_NOT_IMPLEMENTED');
}

/** 404 BILLING_ACCOUNT_NOT_FOUND: the workspace has no billing account (manual / free plan). */
export function billingNotFound(e: unknown): boolean {
  return e instanceof ApiError && (e.reason === 'BILLING_ACCOUNT_NOT_FOUND' || (e.status === 404 && !e.reason));
}

/** The quote / revision went stale: the cabinet re-reads and asks for a new quote. */
export function billingStale(e: unknown): boolean {
  const r = reasonOf(e);
  return r === 'BILLING_QUOTE_EXPIRED' || r === 'BILLING_REVISION_CONFLICT';
}

/** One line for an inline error / toast: the billing reason when known, else the generic text. */
export function billingErrorText(e: unknown, what?: string): string {
  const r = reasonOf(e);
  const key = r ? REASON[r] : undefined;
  if (key) return what ? `${what}. ${t(key)}` : t(key);
  return errorText(e, what);
}
