import {
  AdminBillingAccountSchema,
  AdminBillingAccountsSchema,
  AdminBillingDisputesSchema,
  AdminBillingMutationResultSchema,
  AdminBillingPaymentsSchema,
  AdminBillingRefundRequestsSchema,
  AdminBillingRefundsSchema,
  AdminCreatePriceRequestSchema,
  AdminDiscountRequestSchema,
  AdminEnableBillingRequestSchema,
  AdminHoldRequestSchema,
  AdminManualCreditRequestSchema,
  AdminPriceVersionSchema,
  AdminPriceVersionsSchema,
  AdminProviderEventsSchema,
  AdminReconcileRequestSchema,
  AdminRefundRequestSchema,
  AdminReverseCreditRequestSchema,
  AutoTopupSettingsSchema,
  BillingActionRequestSchema,
  BillingPaymentPageSchema,
  BillingQuoteRequestSchema,
  BillingQuoteSchema,
  BillingRefundRequestSchema,
  BillingRefundRequestsSchema,
  ChangeBillingPlanRequestSchema,
  CheckoutStatusSchema,
  CreateRefundRequestSchema,
  CreateTopupRequestSchema,
  CreateTopupResponseSchema,
  GetBillingResponseSchema,
  LedgerPageSchema,
  PayerProfileSchema,
  PutAutoTopupRequestSchema,
  PutPayerRequestSchema,
  ResumeBillingRequestSchema,
  SavedPaymentMethodsSchema,
  type AdminBillingAccount,
  type AdminBillingAccounts,
  type AdminBillingDisputes,
  type AdminBillingMutationResult,
  type AdminBillingPayments,
  type AdminBillingRefundRequests,
  type AdminBillingRefunds,
  type AdminPriceVersion,
  type AdminPriceVersions,
  type AdminProviderEvents,
  type AutoTopupSettings,
  type BillingPaymentPage,
  type BillingQuote,
  type BillingRefundRequest,
  type BillingRefundRequests,
  type CheckoutStatus,
  type CreateTopupResponse,
  type GetBillingResponse,
  type LedgerPage,
  type PayerProfile,
  type SavedPaymentMethods,
} from '@calaba/protocol';
import type { DescMessage, MessageInitShape } from '@bufbuild/protobuf';
import { body, call, callEmpty, qs } from '../api/client';

/**
 * The billing REST contract (ADR-0080 v5 §13, apps/server/internal/billing/http/routes.go) as a
 * typed adapter: the REST one below, an in-memory mock (lib/billing/mock.ts) for dev / QA builds.
 * Bodies are protojson of the generated messages only. Mutations of the owner answer whatever
 * they answer — the cabinet re-reads GET …/billing afterwards, so their bodies are not relied on.
 */

type Init<T extends DescMessage> = MessageInitShape<T>;

export interface OwnerBillingApi {
  get(ws: string, signal?: AbortSignal): Promise<GetBillingResponse>;
  quote(ws: string, init: Init<typeof BillingQuoteRequestSchema>): Promise<BillingQuote>;
  activate(ws: string, init: Init<typeof BillingActionRequestSchema>): Promise<void>;
  stop(ws: string, init: Init<typeof BillingActionRequestSchema>): Promise<void>;
  changePlan(ws: string, init: Init<typeof ChangeBillingPlanRequestSchema>): Promise<void>;
  resume(ws: string, init: Init<typeof ResumeBillingRequestSchema>): Promise<void>;
  payer(ws: string, signal?: AbortSignal): Promise<PayerProfile>;
  putPayer(ws: string, payer: Init<typeof PayerProfileSchema>): Promise<void>;
  topup(ws: string, init: Init<typeof CreateTopupRequestSchema>): Promise<CreateTopupResponse>;
  checkout(ws: string, checkoutId: string, signal?: AbortSignal): Promise<CheckoutStatus>;
  autoTopup(ws: string, signal?: AbortSignal): Promise<AutoTopupSettings>;
  putAutoTopup(ws: string, init: Init<typeof PutAutoTopupRequestSchema>): Promise<void>;
  revokeAutoTopup(ws: string): Promise<void>;
  paymentMethods(ws: string, signal?: AbortSignal): Promise<SavedPaymentMethods>;
  detachMethod(ws: string, methodId: string): Promise<void>;
  ledger(ws: string, cursor: string, signal?: AbortSignal): Promise<LedgerPage>;
  payments(ws: string, cursor: string, signal?: AbortSignal): Promise<BillingPaymentPage>;
  refundRequests(ws: string, signal?: AbortSignal): Promise<BillingRefundRequests>;
  createRefundRequest(ws: string, init: Init<typeof CreateRefundRequestSchema>): Promise<BillingRefundRequest>;
}

export interface AdminListQuery {
  q?: string;
  accountId?: string;
  cursor?: string;
  /** refund-requests: only REQUESTED ones; events: only failed ones. */
  open?: boolean;
}

export interface AdminBillingApi {
  accounts(q: AdminListQuery, signal?: AbortSignal): Promise<AdminBillingAccounts>;
  account(id: string, signal?: AbortSignal): Promise<AdminBillingAccount>;
  ledger(id: string, cursor: string, signal?: AbortSignal): Promise<LedgerPage>;
  payments(q: AdminListQuery, signal?: AbortSignal): Promise<AdminBillingPayments>;
  refunds(q: AdminListQuery, signal?: AbortSignal): Promise<AdminBillingRefunds>;
  refundRequests(q: AdminListQuery, signal?: AbortSignal): Promise<AdminBillingRefundRequests>;
  disputes(q: AdminListQuery, signal?: AbortSignal): Promise<AdminBillingDisputes>;
  events(q: AdminListQuery, signal?: AbortSignal): Promise<AdminProviderEvents>;
  enable(workspaceId: string, init: Init<typeof AdminEnableBillingRequestSchema>): Promise<AdminBillingAccount>;
  manualCredit(id: string, init: Init<typeof AdminManualCreditRequestSchema>): Promise<AdminBillingMutationResult>;
  reverseCredit(id: string, creditId: string, init: Init<typeof AdminReverseCreditRequestSchema>): Promise<AdminBillingMutationResult>;
  refund(paymentId: string, init: Init<typeof AdminRefundRequestSchema>): Promise<AdminBillingMutationResult>;
  hold(id: string, init: Init<typeof AdminHoldRequestSchema>): Promise<AdminBillingMutationResult>;
  reconcile(id: string, init: Init<typeof AdminReconcileRequestSchema>): Promise<AdminBillingMutationResult>;
  discount(id: string, init: Init<typeof AdminDiscountRequestSchema>): Promise<AdminBillingMutationResult>;
  prices(signal?: AbortSignal): Promise<AdminPriceVersions>;
  createPrice(init: Init<typeof AdminCreatePriceRequestSchema>): Promise<AdminPriceVersion>;
}

const W = (ws: string): string => `/api/workspaces/${encodeURIComponent(ws)}/billing`;
const A = '/api/admin/billing';
const enc = encodeURIComponent;

export const restOwnerApi: OwnerBillingApi = {
  get: (ws, signal) => call('GET', W(ws), GetBillingResponseSchema, undefined, signal),
  quote: (ws, init) => call('POST', `${W(ws)}/quote`, BillingQuoteSchema, body(BillingQuoteRequestSchema, init)),
  activate: (ws, init) => callEmpty('POST', `${W(ws)}/activate`, body(BillingActionRequestSchema, init)),
  stop: (ws, init) => callEmpty('POST', `${W(ws)}/stop`, body(BillingActionRequestSchema, init)),
  changePlan: (ws, init) => callEmpty('POST', `${W(ws)}/change-plan`, body(ChangeBillingPlanRequestSchema, init)),
  resume: (ws, init) => callEmpty('POST', `${W(ws)}/resume`, body(ResumeBillingRequestSchema, init)),
  payer: (ws, signal) => call('GET', `${W(ws)}/payer`, PayerProfileSchema, undefined, signal),
  putPayer: (ws, payer) => callEmpty('PUT', `${W(ws)}/payer`, body(PutPayerRequestSchema, { payer })),
  topup: (ws, init) => call('POST', `${W(ws)}/topups`, CreateTopupResponseSchema, body(CreateTopupRequestSchema, init)),
  checkout: (ws, cid, signal) => call('GET', `${W(ws)}/checkouts/${enc(cid)}`, CheckoutStatusSchema, undefined, signal),
  autoTopup: (ws, signal) => call('GET', `${W(ws)}/auto-topup`, AutoTopupSettingsSchema, undefined, signal),
  putAutoTopup: (ws, init) => callEmpty('PUT', `${W(ws)}/auto-topup`, body(PutAutoTopupRequestSchema, init)),
  revokeAutoTopup: (ws) => callEmpty('DELETE', `${W(ws)}/auto-topup`),
  paymentMethods: (ws, signal) => call('GET', `${W(ws)}/payment-methods`, SavedPaymentMethodsSchema, undefined, signal),
  detachMethod: (ws, pm) => callEmpty('DELETE', `${W(ws)}/payment-methods/${enc(pm)}`),
  ledger: (ws, cursor, signal) => call('GET', `${W(ws)}/ledger${qs({ cursor })}`, LedgerPageSchema, undefined, signal),
  payments: (ws, cursor, signal) => call('GET', `${W(ws)}/payments${qs({ cursor })}`, BillingPaymentPageSchema, undefined, signal),
  refundRequests: (ws, signal) => call('GET', `${W(ws)}/refund-requests`, BillingRefundRequestsSchema, undefined, signal),
  createRefundRequest: (ws, init) => call('POST', `${W(ws)}/refund-requests`, BillingRefundRequestSchema, body(CreateRefundRequestSchema, init)),
};

const listQs = (q: AdminListQuery): string =>
  qs({ q: q.q, account_id: q.accountId, cursor: q.cursor, ...(q.open ? { open: 'true' } : {}) });

export const restAdminApi: AdminBillingApi = {
  accounts: (q, signal) => call('GET', `${A}/accounts${listQs(q)}`, AdminBillingAccountsSchema, undefined, signal),
  account: (id, signal) => call('GET', `${A}/accounts/${enc(id)}`, AdminBillingAccountSchema, undefined, signal),
  ledger: (id, cursor, signal) => call('GET', `${A}/accounts/${enc(id)}/ledger${qs({ cursor })}`, LedgerPageSchema, undefined, signal),
  payments: (q, signal) => call('GET', `${A}/payments${listQs(q)}`, AdminBillingPaymentsSchema, undefined, signal),
  refunds: (q, signal) => call('GET', `${A}/refunds${listQs(q)}`, AdminBillingRefundsSchema, undefined, signal),
  refundRequests: (q, signal) => call('GET', `${A}/refund-requests${listQs(q)}`, AdminBillingRefundRequestsSchema, undefined, signal),
  disputes: (q, signal) => call('GET', `${A}/disputes${listQs(q)}`, AdminBillingDisputesSchema, undefined, signal),
  events: (q, signal) => call('GET', `${A}/events${listQs(q)}`, AdminProviderEventsSchema, undefined, signal),
  enable: (ws, init) => call('POST', `${A}/workspaces/${enc(ws)}/enable`, AdminBillingAccountSchema, body(AdminEnableBillingRequestSchema, init)),
  manualCredit: (id, init) => call('POST', `${A}/accounts/${enc(id)}/manual-credits`, AdminBillingMutationResultSchema, body(AdminManualCreditRequestSchema, init)),
  reverseCredit: (id, cid, init) =>
    call('POST', `${A}/accounts/${enc(id)}/manual-credits/${enc(cid)}/reverse`, AdminBillingMutationResultSchema, body(AdminReverseCreditRequestSchema, init)),
  refund: (pid, init) => call('POST', `${A}/payments/${enc(pid)}/refunds`, AdminBillingMutationResultSchema, body(AdminRefundRequestSchema, init)),
  hold: (id, init) => call('POST', `${A}/accounts/${enc(id)}/hold`, AdminBillingMutationResultSchema, body(AdminHoldRequestSchema, init)),
  reconcile: (id, init) => call('POST', `${A}/accounts/${enc(id)}/reconcile`, AdminBillingMutationResultSchema, body(AdminReconcileRequestSchema, init)),
  discount: (id, init) => call('PUT', `${A}/accounts/${enc(id)}/discount`, AdminBillingMutationResultSchema, body(AdminDiscountRequestSchema, init)),
  prices: (signal) => call('GET', `${A}/prices`, AdminPriceVersionsSchema, undefined, signal),
  createPrice: (init) => call('POST', `${A}/prices`, AdminPriceVersionSchema, body(AdminCreatePriceRequestSchema, init)),
};

export interface BillingAdapters {
  owner: OwnerBillingApi;
  admin: AdminBillingApi;
}
