import { PaymentOrigin, type AdminBillingPayment } from '@calaba/protocol';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../api/client';
import { describeError, recentAuthRequired } from '../api/errors';
import { billingErrorText } from './errors';

/**
 * The superadmin billing forms (features/admin/billing): the audit reason every mutation takes
 * (apps/server/internal/billing/admin: 5..1000 characters, else 422 field "reason") and the
 * server's answers placed next to their field. 2026-10-10: a refund with a 3-letter reason got
 * 422 and the dialog said only «что-то пошло не так».
 */

export const REASON_MIN = 5;
export const REASON_MAX = 1000;

/** The reason as the server will judge it (trimmed); null = fine. */
export function reasonProblem(reason: string): 'short' | 'long' | null {
  const n = reason.trim().length;
  if (n < REASON_MIN) return 'short';
  if (n > REASON_MAX) return 'long';
  return null;
}

/** The hint under the reason field: «12 / 1000 · не короче 5 символов». */
export const reasonHint = (reason: string): string => t('adminBilling.reasonHint', { n: reason.trim().length, max: REASON_MAX, min: REASON_MIN });

/** The inline error of the reason field once the form was submitted. */
export function reasonError(reason: string, touched: boolean): string | null {
  if (!touched) return null;
  const p = reasonProblem(reason);
  return p ? t(p === 'short' ? 'adminBilling.reasonShort' : 'adminBilling.reasonLong', { min: REASON_MIN, max: REASON_MAX }) : null;
}

/** Fields of the admin billing routes (httpx.Validation names) → what is wrong with them. */
const FIELD: Record<string, MessageKey> = {
  reason: 'adminBilling.reasonShort',
  amount: 'adminBilling.err.amount',
  discountBps: 'adminBilling.err.discount',
  holdUntil: 'adminBilling.err.holdUntil',
  market: 'adminBilling.err.market',
  plan: 'adminBilling.err.plan',
  unit: 'adminBilling.err.unit',
  effectiveFrom: 'adminBilling.err.effectiveFrom',
  limits: 'adminBilling.err.limits',
  requestId: 'adminBilling.err.request',
  request_id: 'adminBilling.err.request',
  refundRequestId: 'adminBilling.err.request',
  release_refund_ids: 'adminBilling.err.request',
};

/** A refused admin action: the field it is about (a 422 with `field`) and one localized line. */
export interface AdminFormError {
  field: string | null;
  text: string;
}

/**
 * The server's refusal as the form shows it: a 422 with a field → that field's sentence (placed
 * next to it); a billing reason → its sentence; a recent-auth demand → the password notice; any
 * other ApiError → its localized text, and when that would only be «something went wrong», the
 * HTTP status (never a bare generic line).
 */
export function adminFormError(e: unknown): AdminFormError {
  if (recentAuthRequired(e)) return { field: null, text: t('adminBilling.reauth') };
  if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION' && e.field) {
    const key = FIELD[e.field];
    return { field: e.field, text: key ? t(key, { min: REASON_MIN, max: REASON_MAX }) : t('adminBilling.err.field', { field: e.field }) };
  }
  if (e instanceof ApiError && !e.reason && describeError(e).generic) return { field: null, text: t('adminBilling.err.status', { status: e.status }) };
  return { field: null, text: billingErrorText(e) };
}

/**
 * Tochka cannot refund a charge of a saved card (subscription) or a one-click top-up through the
 * API (providers/tochka Refund → ErrNotSupported): the core marks the refund «Нужна проверка» and
 * the money is returned by hand in the bank. Known from the payment row: Tochka + an auto-topup /
 * one-click origin, or a charge id ({subscription}:{order}).
 */
export function refundManualOnly(p: Pick<AdminBillingPayment, 'provider' | 'providerPaymentId' | 'payment'>): boolean {
  if (p.provider !== 'tochka') return false;
  const origin = p.payment?.origin;
  return origin === PaymentOrigin.AUTO_TOPUP || origin === PaymentOrigin.SAVED_METHOD || p.providerPaymentId.includes(':');
}
