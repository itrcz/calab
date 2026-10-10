-- Billing core (T1: internal/billing/core, internal/billing/worker). Same rules as
-- billing.sql: every mutation runs in a transaction that locked the account first; time comes
-- from billing.Clock as sqlc.arg('now').

-- name: GetBillingChargeByKey :one
SELECT * FROM billing_charges WHERE business_key = $1;

-- name: BillingCapacityAt :one
-- Seats of `plan` covering `at` (lots [starts_at, ends_at) minus cancelled seats).
SELECT coalesce(sum(qty - canceled_qty), 0)::integer AS seats FROM billing_charges
WHERE account_id = sqlc.arg('account_id') AND plan = sqlc.arg('plan')
  AND starts_at <= sqlc.arg('at')::timestamptz AND ends_at > sqlc.arg('at')::timestamptz;

-- name: NextBillingChargeEnd :one
-- The next renewal boundary: the earliest end after `after` of a lot of `plan` with seats left.
SELECT ends_at FROM billing_charges
WHERE account_id = sqlc.arg('account_id') AND plan = sqlc.arg('plan')
  AND ends_at > sqlc.arg('after')::timestamptz AND qty > canceled_qty
ORDER BY ends_at
LIMIT 1;

-- name: LastBillingChargeEnd :one
-- The end of the coverage of `plan` (stopped accounts keep their lots until then).
SELECT ends_at FROM billing_charges
WHERE account_id = sqlc.arg('account_id') AND plan = sqlc.arg('plan')
  AND ends_at > sqlc.arg('after')::timestamptz AND qty > canceled_qty
ORDER BY ends_at DESC
LIMIT 1;

-- name: LockBillingChargesCoveringAt :many
-- Lots of `plan` covering `at` with seats left, longest-living first (cancellation order).
SELECT * FROM billing_charges
WHERE account_id = sqlc.arg('account_id') AND plan = sqlc.arg('plan')
  AND starts_at <= sqlc.arg('at')::timestamptz AND ends_at > sqlc.arg('at')::timestamptz
  AND qty > canceled_qty
ORDER BY ends_at DESC, id DESC
FOR UPDATE;

-- name: CancelBillingChargeSeats :one
-- Gives back qty seats for seat_us seat-microseconds; compensated_delta is the new cumulative
-- compensation minus the old one, debt_delta the part of it that cancels unpaid debt.
UPDATE billing_charges SET canceled_qty = canceled_qty + sqlc.arg('qty')::integer,
    canceled_seat_us = canceled_seat_us + sqlc.arg('seat_us')::bigint,
    compensated_minor = compensated_minor + sqlc.arg('compensated_delta')::bigint,
    unfunded_minor = unfunded_minor - sqlc.arg('debt_delta')::bigint
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: UnfundBillingCharge :one
-- The money of a funding lot that paid this charge was taken back (dispute, reversed credit):
-- that part of the delivered service becomes debt again.
UPDATE billing_charges SET unfunded_minor = unfunded_minor + sqlc.arg('delta')::bigint
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: ListBillingChargeSegments :many
-- Money segments of a charge: net allocation per funding lot in the order the lots first paid
-- it (FIFO). The unfunded rest is the receivable suffix after them.
SELECT lot_id, sum(amount_minor)::bigint AS amount_minor
FROM billing_allocations
WHERE charge_id = $1
GROUP BY lot_id
HAVING sum(amount_minor) > 0
ORDER BY (array_agg(id ORDER BY id))[1];

-- name: ListBillingLotSegments :many
-- What a funding lot paid: net allocation per charge, the latest paid first (claw-back order).
SELECT charge_id, sum(amount_minor)::bigint AS amount_minor
FROM billing_allocations
WHERE lot_id = $1
GROUP BY charge_id
HAVING sum(amount_minor) > 0
ORDER BY (array_agg(id ORDER BY id DESC))[1] DESC;

-- name: LockBillingCharge :one
SELECT * FROM billing_charges WHERE id = $1 FOR UPDATE;

-- name: GetBillingFundingLot :one
SELECT * FROM billing_funding_lots WHERE id = $1;

-- name: GetBillingFundingLotByPayment :one
SELECT * FROM billing_funding_lots WHERE payment_id = $1;

-- name: GetBillingRefund :one
SELECT * FROM billing_refunds WHERE id = $1;

-- name: LockBillingFundingLot :one
SELECT * FROM billing_funding_lots WHERE id = $1 FOR UPDATE;

-- name: LockBillingFundingLotByPayment :one
SELECT * FROM billing_funding_lots WHERE payment_id = $1 FOR UPDATE;

-- name: BillingFreeAdvance :one
-- Money left on the funding lots (the free advance).
SELECT coalesce(sum(amount_minor - consumed_minor - refunded_minor), 0)::bigint AS minor
FROM billing_funding_lots
WHERE account_id = $1 AND consumed_minor + refunded_minor < amount_minor;

-- name: BillingDebt :one
-- Unpaid parts of delivered seat charges.
SELECT coalesce(sum(unfunded_minor), 0)::bigint AS minor
FROM billing_charges
WHERE account_id = $1 AND unfunded_minor > 0;

-- name: ListBillingFundingMismatches :many
-- Nightly check of the second invariant: balance = free advance - debt.
SELECT a.id, a.balance_minor,
    coalesce((SELECT sum(l.amount_minor - l.consumed_minor - l.refunded_minor) FROM billing_funding_lots l
        WHERE l.account_id = a.id), 0)::bigint AS free_minor,
    coalesce((SELECT sum(c.unfunded_minor) FROM billing_charges c
        WHERE c.account_id = a.id AND c.unfunded_minor > 0), 0)::bigint AS debt_minor
FROM billing_accounts a
WHERE a.balance_minor <> coalesce((SELECT sum(l.amount_minor - l.consumed_minor - l.refunded_minor)
        FROM billing_funding_lots l WHERE l.account_id = a.id), 0)
    - coalesce((SELECT sum(c.unfunded_minor) FROM billing_charges c
        WHERE c.account_id = a.id AND c.unfunded_minor > 0), 0);

-- name: ClaimBillingRenewal :one
-- One account due for renewal (active) or for the end of its coverage (stopped), not under an
-- incident hold, nor in skip (accounts that failed in this round). The row stays locked until the claiming transaction ends; SKIP LOCKED lets
-- parallel workers take different accounts.
SELECT * FROM billing_accounts
WHERE status = sqlc.arg('status') AND next_due_at <= sqlc.arg('now')::timestamptz
  AND (hold_until IS NULL OR hold_until <= sqlc.arg('now')::timestamptz)
  AND id <> ALL(sqlc.arg('skip')::uuid[])
ORDER BY next_due_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- name: ClaimBillingSuspension :one
-- One account whose debt deadline passed (still in debt is re-checked after the catch-up).
SELECT * FROM billing_accounts
WHERE suspend_at <= sqlc.arg('now')::timestamptz AND status IN ('active', 'stopped')
  AND (hold_until IS NULL OR hold_until <= sqlc.arg('now')::timestamptz)
  AND id <> ALL(sqlc.arg('skip')::uuid[])
ORDER BY suspend_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- name: SetBillingAccountDisputeHold :one
UPDATE billing_accounts SET dispute_hold = sqlc.arg('dispute_hold'), revision = revision + 1,
    updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: UpsertBillingWorkspacePlan :one
-- The plan billing gives the workspace (source = billing: the manual admin API refuses it).
-- limits / display_name / description: the custom plan's definition (NULL / '' otherwise).
INSERT INTO workspace_plans (workspace_id, plan, limits, valid_until, note, updated_by, updated_at, source, display_name, description)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('plan'), sqlc.narg('limits'), NULL, sqlc.arg('note'), sqlc.narg('updated_by'),
    sqlc.arg('now')::timestamptz, 'billing', sqlc.arg('display_name'), sqlc.arg('description'))
ON CONFLICT (workspace_id) DO UPDATE SET
    plan = EXCLUDED.plan, limits = EXCLUDED.limits, valid_until = NULL, note = EXCLUDED.note,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at, source = 'billing',
    display_name = EXCLUDED.display_name, description = EXCLUDED.description
RETURNING *;

-- name: InsertBillingPlanLog :exec
INSERT INTO workspace_plan_log (workspace_id, actor_id, plan, limits, valid_until, note, source, created_at, display_name, description)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('actor_id'), sqlc.arg('plan'), sqlc.arg('limits'), NULL, sqlc.arg('note'), 'billing',
    sqlc.arg('now')::timestamptz, sqlc.arg('display_name'), sqlc.arg('description'));

-- name: LockBillingRefund :one
SELECT * FROM billing_refunds WHERE id = $1 FOR UPDATE;

-- name: SetBillingRefundStatus :one
-- pending / requires_action → any; succeeded, failed and canceled are final.
UPDATE billing_refunds SET status = sqlc.arg('status'),
    provider_refund_id = coalesce(sqlc.narg('provider_refund_id'), provider_refund_id),
    succeeded_at = CASE WHEN sqlc.arg('status')::text = 'succeeded' THEN sqlc.arg('now')::timestamptz ELSE NULL END,
    updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status IN ('pending', 'requires_action')
RETURNING *;

-- name: AddBillingPaymentRefunded :one
UPDATE billing_payments SET refunded_minor = refunded_minor + sqlc.arg('delta')::bigint,
    updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: LockBillingDisputeByProviderID :one
SELECT * FROM billing_disputes WHERE provider_dispute_id = $1 FOR UPDATE;

-- name: CloseBillingDispute :one
UPDATE billing_disputes SET status = 'closed', outcome = sqlc.arg('outcome'),
    closed_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'open'
RETURNING *;

-- name: CountOpenBillingDisputes :one
SELECT count(*)::integer FROM billing_disputes WHERE account_id = $1 AND status = 'open';
