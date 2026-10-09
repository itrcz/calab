-- Auto-topup (T7: internal/billing/autotopup, ADR-0080 §7 and v5 «v1 cut»). Same rules as
-- billing.sql: every write runs in a transaction that locked the account first; time comes
-- from billing.Clock as sqlc.arg('now').

-- name: ListBillingAutoTopupCandidates :many
-- Accounts that may need an auto-topup now: active, consent not revoked, not_before passed,
-- no open attempt, no dispute / incident hold. The need itself (balance under the threshold)
-- is decided from the quote; everything is re-checked under the account lock. Keyset pages by
-- account_id (after = the last id of the previous page, uuid nil first): a tick walks every
-- live consent, so accounts that never needed a top-up cannot starve the others.
SELECT t.account_id FROM billing_autotopup t
JOIN billing_accounts a ON a.id = t.account_id
WHERE t.revoked_at IS NULL
  AND t.account_id > sqlc.arg('after')::uuid
  AND (t.not_before IS NULL OR t.not_before <= sqlc.arg('now')::timestamptz)
  AND a.status = 'active' AND NOT a.dispute_hold
  AND (a.hold_until IS NULL OR a.hold_until <= sqlc.arg('now')::timestamptz)
  AND NOT EXISTS (SELECT 1 FROM billing_autotopup_attempts x
                  WHERE x.account_id = t.account_id AND x.status IN ('prepared', 'dispatched', 'unknown'))
ORDER BY t.account_id
LIMIT sqlc.arg('lim');

-- name: SetBillingAutoTopupNotBefore :exec
-- The next new attempt not earlier than not_before (never moved back).
UPDATE billing_autotopup SET not_before = GREATEST(coalesce(not_before, sqlc.arg('not_before')::timestamptz), sqlc.arg('not_before')::timestamptz),
    updated_at = sqlc.arg('now')::timestamptz
WHERE account_id = sqlc.arg('account_id');

-- name: MarkBillingAutoTopupAttemptDispatched :one
-- prepared → dispatched, committed before the provider call: a prepared attempt was never sent.
UPDATE billing_autotopup_attempts SET status = 'dispatched', dispatched_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'prepared'
RETURNING *;

-- name: FailBillingAutoTopupAttemptPrepared :one
-- A prepared attempt that will not be sent (consent revoked, need gone, abandoned by a crash).
UPDATE billing_autotopup_attempts SET status = 'failed', failure_code = sqlc.arg('failure_code'),
    finished_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'prepared'
RETURNING *;

-- name: SetBillingAutoTopupAttemptPayment :one
-- The provider answered with a payment of a dispatched / unknown attempt that is not final yet
-- (processing): keep its id, unknown becomes dispatched again.
UPDATE billing_autotopup_attempts SET provider_payment_id = sqlc.arg('provider_payment_id'),
    status = CASE WHEN status = 'unknown' THEN 'dispatched' ELSE status END
WHERE id = sqlc.arg('id') AND status IN ('dispatched', 'unknown')
RETURNING *;

-- name: SettleBillingAutoTopupAttemptPaid :one
-- The attempt's payment was credited: succeeded, also after failed (a late success is never
-- hidden behind an old failure).
UPDATE billing_autotopup_attempts SET status = 'succeeded', provider_payment_id = sqlc.arg('provider_payment_id'),
    failure_code = '', dispatched_at = coalesce(dispatched_at, sqlc.arg('now')::timestamptz),
    finished_at = coalesce(finished_at, sqlc.arg('now')::timestamptz)
WHERE id = sqlc.arg('id') AND status <> 'succeeded'
RETURNING *;

-- name: ListBillingAutoTopupAttemptsToRecover :many
-- Open attempts older than `before`: prepared ones were never sent (abandoned), dispatched /
-- unknown ones are resolved with the same idempotency key or a provider lookup.
SELECT * FROM billing_autotopup_attempts
WHERE status IN ('prepared', 'dispatched', 'unknown') AND created_at < sqlc.arg('before')::timestamptz
ORDER BY created_at
LIMIT sqlc.arg('lim');

-- name: GetBillingCustomerByID :one
SELECT * FROM billing_customers WHERE id = $1;

-- name: ListBillingAutoTopupReconcileCustomers :many
-- Customers that may have auto-topup payments since `since` (restore reconcile): accounts with a
-- consent live or changed since then, or an attempt since then.
SELECT c.* FROM billing_customers c
WHERE c.account_id IN (
    SELECT t.account_id FROM billing_autotopup t
    WHERE t.revoked_at IS NULL OR t.revoked_at > sqlc.arg('since')::timestamptz OR t.updated_at > sqlc.arg('since')::timestamptz
    UNION
    SELECT x.account_id FROM billing_autotopup_attempts x WHERE x.created_at > sqlc.arg('since')::timestamptz)
ORDER BY c.id;

-- name: BillingAutoTopupReconciled :one
-- The restore marker (BILLING_AUTO_TOPUP_REQUIRE_RECONCILE) was reconciled by an operator.
SELECT EXISTS (SELECT 1 FROM billing_audit
               WHERE action = 'auto_topup.reconcile' AND details->>'marker' = sqlc.arg('marker')::text)::boolean;

-- name: LockWorkspaceForBillingClose :one
-- Workspace deletion locks the workspace row before the billing account (lock order of
-- admission: workspace rows → account).
SELECT id FROM workspaces WHERE id = $1 FOR UPDATE;
