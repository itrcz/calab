-- Billing refunds, the synchronous model (ADR-0080 / ADR-0083 amendment, owner 2026-10-10):
-- admin refunds sent at once and booked when executed, refunds made at the bank booked from the
-- polled operation lists, «Требует внимания».

-- name: StartBillingRefund :one
-- An admin refund about to be sent: nothing reserved (reserved = false), the ledger entry comes
-- when the provider executed it. No row = idem_key exists (GetBillingRefundByIdemKey).
INSERT INTO billing_refunds (account_id, payment_id, lot_id, amount_minor, currency, status, origin, idem_key, reason, requested_by, reserved)
VALUES (sqlc.arg('account_id'), sqlc.arg('payment_id'), sqlc.arg('lot_id'), sqlc.arg('amount_minor'), sqlc.arg('currency'),
        'pending', 'calab', sqlc.arg('idem_key'), sqlc.arg('reason'), sqlc.narg('requested_by'), false)
ON CONFLICT DO NOTHING
RETURNING *;

-- name: SumUnreservedPendingBillingRefunds :one
-- Money of a payment promised to pending refunds that took nothing yet (unknown outcomes).
SELECT coalesce(sum(amount_minor), 0)::bigint FROM billing_refunds
WHERE payment_id = $1 AND reserved = false AND status IN ('pending', 'requires_action');

-- name: ListUnclaimedCalabBillingRefunds :many
-- Calab refunds of a payment the provider's refund id is not known for yet: waiting (unknown
-- outcome) or executed with an answer the bank did not confirm by id. A listed provider refund of
-- the same amount is theirs, never a new one (no double deduction). Oldest first.
SELECT * FROM billing_refunds
WHERE payment_id = $1 AND origin = 'calab' AND provider_refund_id IS NULL
  AND status IN ('pending', 'requires_action', 'succeeded')
ORDER BY created_at, id;

-- name: ClaimBillingRefundProviderID :one
-- The provider's id of a Calab refund that had none yet (an unknown outcome, or an executed answer
-- the bank did not confirm by id). No row = it has one.
UPDATE billing_refunds SET provider_refund_id = sqlc.arg('provider_refund_id')::text, updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND provider_refund_id IS NULL
RETURNING *;

-- name: ListUnclaimedCalabBillingRefundsOfSubscription :many
-- ListUnclaimedCalabBillingRefunds over every payment of one subscription (its binding payment and
-- charges {subscription}:charge:{order}): a refund listed on the subscription names no charge.
SELECT r.* FROM billing_refunds r
JOIN billing_payments p ON p.id = r.payment_id
WHERE p.provider = sqlc.arg('provider')
  AND (p.provider_payment_id = sqlc.arg('subscription')::text OR starts_with(p.provider_payment_id, sqlc.arg('subscription')::text || ':charge:'))
  AND r.origin = 'calab' AND r.provider_refund_id IS NULL AND r.status IN ('pending', 'requires_action', 'succeeded')
ORDER BY r.created_at, r.id;

-- name: BillingPaymentIsSavedMethodBinding :one
-- The payment is the binding payment of a saved method (Tochka: the subscription's operation id is
-- both): refunded only by hand.
SELECT EXISTS (SELECT 1 FROM billing_payment_methods
    WHERE provider = sqlc.arg('provider') AND provider_pm_id = sqlc.arg('provider_payment_id'))::boolean AS binding;

-- name: ListBillingPaymentsWithRefundRoom :many
-- Payments of the account the provider may still refund (paid minus refunded > 0), in lot order:
-- where a refund made at the bank is booked when its own payment cannot hold it.
SELECT p.id, p.provider_payment_id, (f.amount_minor - f.refunded_minor)::bigint AS room
FROM billing_payments p
JOIN billing_funding_lots f ON f.payment_id = p.id
WHERE p.account_id = $1 AND f.amount_minor > f.refunded_minor
ORDER BY f.id;

-- name: LastBillingActivity :one
-- The latest payment or refund of a provider: the refund polling cadence (24 h / 7 days / 180 days).
SELECT coalesce(greatest(
    (SELECT max(p0.created_at) FROM billing_payments p0 WHERE p0.provider = sqlc.arg('provider')),
    (SELECT max(r.created_at) FROM billing_refunds r JOIN billing_payments p ON p.id = r.payment_id WHERE p.provider = sqlc.arg('provider'))
), 'epoch'::timestamptz)::timestamptz AS last_at;

-- name: ListBillingRefundsToClose :many
-- Unreserved Calab refunds still pending (unknown outcome) older than `before`: the provider has
-- no trace of them — closed as failed, nothing was deducted.
SELECT * FROM billing_refunds
WHERE origin = 'calab' AND reserved = false AND status IN ('pending', 'requires_action') AND created_at < sqlc.arg('before')::timestamptz
ORDER BY id
LIMIT sqlc.arg('lim');

-- name: InsertBillingProviderIssue :one
-- A provider refund for the superadmin (00082). status imported = booked already (informational).
-- No row = known already (its status is kept).
INSERT INTO billing_provider_issues (account_id, payment_id, provider, provider_ref, amount_minor, currency, reason, status, occurred_at, resolved_at)
VALUES (sqlc.arg('account_id'), sqlc.narg('payment_id'), sqlc.arg('provider'), sqlc.arg('provider_ref'), sqlc.arg('amount_minor'),
        sqlc.arg('currency'), sqlc.arg('reason'), sqlc.arg('status'), sqlc.narg('occurred_at'),
        CASE WHEN sqlc.arg('status')::text = 'open' THEN NULL ELSE now() END)
ON CONFLICT (provider, provider_ref) DO NOTHING
RETURNING *;

-- name: GetBillingProviderIssue :one
SELECT * FROM billing_provider_issues WHERE id = $1;

-- name: LockBillingProviderIssue :one
SELECT * FROM billing_provider_issues WHERE id = $1 FOR UPDATE;

-- name: ListBillingProviderIssues :many
-- account_id NULL = every account; status NULL = every status; newest first, keyset by id.
SELECT * FROM billing_provider_issues
WHERE (sqlc.narg('account_id')::uuid IS NULL OR account_id = sqlc.narg('account_id')::uuid)
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR id < sqlc.narg('before_id')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: CountOpenBillingProviderIssues :one
SELECT count(*)::bigint FROM billing_provider_issues WHERE status = 'open';

-- name: ResolveBillingProviderIssue :one
-- open → imported | dismissed. No row = resolved before.
UPDATE billing_provider_issues SET status = sqlc.arg('status'), resolved_at = sqlc.arg('now')::timestamptz, resolved_by = sqlc.narg('resolved_by')
WHERE id = sqlc.arg('id') AND status = 'open'
RETURNING *;
