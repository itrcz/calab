import {
  CheckoutState,
  CheckoutStatusSchema,
  SavedMethodTopupState,
  type BillingSummary,
  type CheckoutStatus,
  type PaymentMethodOption,
  type SavedMethodTopup,
  type SavedPaymentMethod,
} from '@calaba/protocol';
import { create } from '@bufbuild/protobuf';
import type { MessageKey } from '../../i18n';

/**
 * One-click top-up with a saved card (ADR-0083 phase 2, owner 2026-10-10): the owner picks a saved
 * card in «Пополнить баланс», confirms the amount, the server charges it (Stripe on-session, Tochka
 * Charge Subscription). The answer is mapped onto the checkout flow (lib/billing/checkout.ts): a
 * 3-D Secure page is the «checkout URL» opened in the payment window, the poll reads
 * GET …/saved-method-topups/{id} instead of the checkout.
 */

/** Saved cards the server lets the owner charge in one click now. */
export function savedChoices(summary: BillingSummary): SavedPaymentMethod[] {
  return summary.savedMethods.filter((m) => m.oneClick);
}

/** The method option a saved card is charged under (limits): same provider and kind. */
export function optionForSaved(summary: BillingSummary, m: SavedPaymentMethod): PaymentMethodOption | undefined {
  return summary.methods.find((o) => o.provider === m.provider && o.kind === m.kind);
}

const BRANDS: Record<string, string> = {
  mir: 'МИР',
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  unionpay: 'UnionPay',
  jcb: 'JCB',
  discover: 'Discover',
  diners: 'Diners Club',
};

/** The card network as people know it («МИР», «Visa»); '' when unknown. Not translated. */
export function brandName(brand: string): string {
  const b = brand.trim().toLowerCase();
  return BRANDS[b] ?? (b ? b.charAt(0).toUpperCase() + b.slice(1) : '');
}

/** «Visa •••• 4242», «МИР •••• 0792»; «•••• 4242» without a known brand. Brand names are not translated. */
export function cardLabel(m: Pick<SavedPaymentMethod, 'brand' | 'last4'>): string {
  const brand = brandName(m.brand);
  const tail = m.last4 ? `•••• ${m.last4}` : '';
  return [brand, tail].filter(Boolean).join(' ') || '••••';
}

/** The one-click answer as a checkout status for the checkout reducer. */
export function asCheckoutStatus(t: SavedMethodTopup): CheckoutStatus {
  const state =
    t.state === SavedMethodTopupState.FAILED ? CheckoutState.FAILED : t.state === SavedMethodTopupState.SUCCEEDED ? CheckoutState.COMPLETED : CheckoutState.OPEN;
  return create(CheckoutStatusSchema, { checkoutId: t.id, state, credited: t.credited, ...(t.amount ? { amount: t.amount } : {}) });
}

/** Text of a failed one-click charge. */
export function savedFailureKey(code: string): MessageKey {
  if (code === 'authentication_required' || code === 'payment_intent_authentication_failure') return 'billing.saved.failedAuth';
  if (code === 'insufficient_funds') return 'billing.saved.failedFunds';
  return 'billing.saved.failed';
}
