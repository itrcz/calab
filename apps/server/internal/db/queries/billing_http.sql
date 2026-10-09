-- Billing HTTP, webhook inbox, reconciliation and mail (T5: internal/billing/http,
-- internal/billing/inbox). Same rules as billing.sql: money mutations run in a transaction that
-- locked the account first; time comes from billing.Clock as sqlc.arg('now').

-- name: MarkBillingProviderEventDead :exec
-- An event that will never be processed (orphan, mismatch, too many attempts): kept with its
-- error for the admin event list, not claimed again.
UPDATE billing_provider_events SET processed_at = sqlc.arg('now')::timestamptz, error = sqlc.arg('error')
WHERE id = sqlc.arg('id');

-- name: GetBillingProviderEvent :one
SELECT * FROM billing_provider_events WHERE provider = $1 AND provider_account = $2 AND event_id = $3;

-- name: GetBillingPaymentByCheckout :one
SELECT * FROM billing_payments WHERE checkout_id = $1 ORDER BY id DESC LIMIT 1;

-- name: SetBillingPaymentClosed :one
-- processing → failed | canceled (a fresh provider read said so; nothing was credited).
UPDATE billing_payments SET status = sqlc.arg('status'), updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'processing'
RETURNING *;

-- name: ListBillingCheckoutsToReconcile :many
-- Open checkouts older than `before` (abandoned hosted pages, lost success redirects).
SELECT * FROM billing_checkouts
WHERE status = 'open' AND created_at < sqlc.arg('before')::timestamptz
ORDER BY created_at
LIMIT sqlc.arg('lim');

-- name: ListBillingPaymentsProcessing :many
SELECT * FROM billing_payments WHERE status = 'processing' ORDER BY id LIMIT sqlc.arg('lim');

-- name: ListBillingDirtyCustomers :many
-- Customers with recent payment activity (a checkout or a payment since `since`): the periodic
-- import lists their payments to find the ones whose webhooks were lost.
SELECT c.* FROM billing_customers c
WHERE EXISTS (SELECT 1 FROM billing_checkouts k WHERE k.account_id = c.account_id AND k.created_at >= sqlc.arg('since')::timestamptz)
   OR EXISTS (SELECT 1 FROM billing_payments p WHERE p.account_id = c.account_id AND p.created_at >= sqlc.arg('since')::timestamptz)
ORDER BY c.id
LIMIT sqlc.arg('lim');

-- name: ListPendingCalabBillingRefunds :many
-- Refunds requested through Calab whose provider id is not recorded yet: a webhook of such a
-- refund must not be imported as a dashboard refund (the money is reserved already).
SELECT * FROM billing_refunds
WHERE payment_id = $1 AND origin = 'calab' AND provider_refund_id IS NULL AND status IN ('pending', 'requires_action')
ORDER BY id;

-- name: UpsertBillingPaymentMethod :one
-- A card saved by a checkout with save_method (setup_future_usage); detached_at stays as it is.
INSERT INTO billing_payment_methods (account_id, customer_id, provider, livemode, provider_pm_id, kind, brand, last4, exp_month, exp_year)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (provider_pm_id) DO UPDATE SET brand = EXCLUDED.brand, last4 = EXCLUDED.last4,
    exp_month = EXCLUDED.exp_month, exp_year = EXCLUDED.exp_year
WHERE billing_payment_methods.account_id = EXCLUDED.account_id
RETURNING *;

-- name: ListBillingPaymentMethods :many
SELECT * FROM billing_payment_methods WHERE account_id = $1 AND detached_at IS NULL ORDER BY id;

-- name: GetBillingPaymentMethod :one
SELECT * FROM billing_payment_methods WHERE id = $1;

-- name: DetachBillingPaymentMethod :one
UPDATE billing_payment_methods SET detached_at = coalesce(detached_at, sqlc.arg('now')::timestamptz)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DetachBillingPaymentMethodByProviderID :one
UPDATE billing_payment_methods SET detached_at = coalesce(detached_at, sqlc.arg('now')::timestamptz)
WHERE provider_pm_id = sqlc.arg('provider_pm_id')
RETURNING *;

-- name: RevokeBillingAutoTopupForMethod :execrows
-- The consent card went away: auto-topup consent ends at once.
UPDATE billing_autotopup SET revoked_at = sqlc.arg('now')::timestamptz, revoked_reason = sqlc.arg('reason'),
    updated_at = sqlc.arg('now')::timestamptz
WHERE pm_id = sqlc.arg('pm_id') AND revoked_at IS NULL;

-- name: ListBillingRefundRequests :many
SELECT * FROM billing_refund_requests WHERE account_id = $1 ORDER BY id DESC LIMIT sqlc.arg('lim');

-- name: GetBillingRefundRequestByRequest :one
SELECT * FROM billing_refund_requests WHERE account_id = $1 AND request_id = $2;

-- name: ListBillingLedgerPage :many
-- Newest first (before_seq = 0: from the newest) with what the owner history shows: the seat
-- lot of a charge and the payment of a funding lot.
SELECT l.id, l.seq, l.kind, l.amount_minor, l.balance_after, l.created_at, l.reason, l.actor_id, l.refund_id,
    c.sku AS charge_sku, c.qty AS charge_qty, c.starts_at AS charge_starts_at, c.ends_at AS charge_ends_at,
    f.payment_id AS lot_payment_id
FROM billing_ledger l
LEFT JOIN billing_charges c ON c.id = l.charge_id
LEFT JOIN billing_funding_lots f ON f.id = l.lot_id
WHERE l.account_id = sqlc.arg('account_id')
  AND (sqlc.arg('before_seq')::bigint = 0 OR l.seq < sqlc.arg('before_seq')::bigint)
ORDER BY l.seq DESC
LIMIT sqlc.arg('lim');

-- name: GetBillingAutoTopupAttemptOfAccount :one
SELECT * FROM billing_autotopup_attempts WHERE id = $1 AND account_id = $2;

-- name: ListBillingAccountsSuspendingSoon :many
-- Accounts in debt whose deadline is within (now, until]: the «one day left» mail.
SELECT * FROM billing_accounts
WHERE suspend_at > sqlc.arg('now')::timestamptz AND suspend_at <= sqlc.arg('until')::timestamptz
  AND status IN ('active', 'stopped') AND balance_minor < 0
ORDER BY suspend_at
LIMIT sqlc.arg('lim');

-- name: GetBillingNotification :one
SELECT * FROM billing_notifications WHERE account_id = $1 AND key = $2;

-- name: ListBillingOpenCheckoutsOfAccount :many
SELECT * FROM billing_checkouts WHERE account_id = $1 AND status = 'open' ORDER BY id;

-- name: ListBillingPaymentsProcessingOfAccount :many
SELECT * FROM billing_payments WHERE account_id = $1 AND status = 'processing' ORDER BY id;

-- name: ListBillingCustomersOfAccount :many
SELECT * FROM billing_customers WHERE account_id = $1 ORDER BY id;

-- name: UpsertBillingAutoTopupConsent :one
-- The owner's auto-topup consent (PUT …/auto-topup); the account is locked by the caller.
-- not_before survives a new consent (≤ 1 new attempt per 24 h, T7).
INSERT INTO billing_autotopup (account_id, pm_id, max_minor, consent_version, consent_at, consent_by, updated_at)
VALUES ($1, $2, $3, $4, sqlc.arg('now')::timestamptz, $5, sqlc.arg('now')::timestamptz)
ON CONFLICT (account_id) DO UPDATE SET pm_id = EXCLUDED.pm_id, max_minor = EXCLUDED.max_minor,
    consent_version = EXCLUDED.consent_version, consent_at = EXCLUDED.consent_at, consent_by = EXCLUDED.consent_by,
    revoked_at = NULL, revoked_reason = '', updated_at = EXCLUDED.updated_at
RETURNING *;

-- name: RevokeBillingAutoTopup :execrows
UPDATE billing_autotopup SET revoked_at = sqlc.arg('now')::timestamptz, revoked_reason = sqlc.arg('reason'),
    updated_at = sqlc.arg('now')::timestamptz
WHERE account_id = sqlc.arg('account_id') AND revoked_at IS NULL;

-- name: ListBillingRefundsToRetry :many
-- Calab refunds still waiting for the provider (lost answer, provider down): reconciliation
-- asks again with the same idempotency key, or re-reads them by provider id. account_id NULL =
-- every account; only rows not touched since `before`.
SELECT * FROM billing_refunds
WHERE origin = 'calab' AND status IN ('pending', 'requires_action')
  AND (sqlc.narg('account_id')::uuid IS NULL OR account_id = sqlc.narg('account_id')::uuid)
  AND updated_at < sqlc.arg('before')::timestamptz
ORDER BY id
LIMIT sqlc.arg('lim');

-- name: MarkBillingRefundNeedsReview :one
-- A Calab refund the provider has no trace of past the idempotency window: a superadmin decides.
-- No row = it left pending meanwhile or was marked before (the first mark keeps its time).
UPDATE billing_refunds SET needs_review_at = sqlc.arg('now')::timestamptz, updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND origin = 'calab' AND status IN ('pending', 'requires_action') AND needs_review_at IS NULL
RETURNING *;

-- name: CountBillingRefundsNeedingReview :one
SELECT count(*)::bigint FROM billing_refunds
WHERE needs_review_at IS NOT NULL AND status IN ('pending', 'requires_action');
