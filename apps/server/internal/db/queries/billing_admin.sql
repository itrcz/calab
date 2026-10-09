-- Balance billing v1, superadmin API (T6, internal/billing/admin). Reads for the admin lists
-- and the few non-money writes of the admin commands (hold, discount, refund request decision,
-- provider refund id). Money moves only through the core (internal/billing/core); every
-- write here runs in a transaction that first locks the account (LockBillingAccount).

-- name: AdminListBillingAccounts :many
-- Newest first. q matches the account id, the workspace id (exact) or the workspace name /
-- owner email (pattern is q with LIKE wildcards escaped); an empty status matches any.
SELECT sqlc.embed(a), coalesce(w.name, '')::text AS workspace_name, coalesce(u.email::text, '')::text AS owner_email,
    (SELECT count(*) FROM workspace_members m JOIN users mu ON mu.id = m.user_id
     WHERE m.workspace_id = a.workspace_id AND m.role <> 'guest' AND NOT mu.is_bot)::integer AS billable_members
FROM billing_accounts a
LEFT JOIN workspaces w ON w.id = a.workspace_id
LEFT JOIN users u ON u.id = w.owner_id
WHERE (sqlc.arg('status')::text = '' OR a.status = sqlc.arg('status')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR a.id < sqlc.narg('before_id')::uuid)
  AND (sqlc.arg('q')::text = ''
    OR a.id::text = sqlc.arg('q')::text OR a.workspace_id::text = sqlc.arg('q')::text
    OR w.name ILIKE '%' || sqlc.arg('pattern')::text || '%'
    OR u.email::text ILIKE '%' || sqlc.arg('pattern')::text || '%')
ORDER BY a.id DESC
LIMIT sqlc.arg('lim');

-- name: AdminGetBillingAccount :one
SELECT sqlc.embed(a), coalesce(w.name, '')::text AS workspace_name, coalesce(u.email::text, '')::text AS owner_email,
    (SELECT count(*) FROM workspace_members m JOIN users mu ON mu.id = m.user_id
     WHERE m.workspace_id = a.workspace_id AND m.role <> 'guest' AND NOT mu.is_bot)::integer AS billable_members
FROM billing_accounts a
LEFT JOIN workspaces w ON w.id = a.workspace_id
LEFT JOIN users u ON u.id = w.owner_id
WHERE a.id = $1;

-- name: AdminListBillingLedger :many
-- Newest first with the seat lot and the payment of the entry; before_seq = 0 starts at the top.
SELECT sqlc.embed(l), c.sku AS charge_sku, c.qty AS charge_qty, c.starts_at AS charge_starts_at,
    c.ends_at AS charge_ends_at, f.payment_id AS lot_payment_id
FROM billing_ledger l
LEFT JOIN billing_charges c ON c.id = l.charge_id
LEFT JOIN billing_funding_lots f ON f.id = l.lot_id
WHERE l.account_id = sqlc.arg('account_id')
  AND (sqlc.arg('before_seq')::bigint = 0 OR l.seq < sqlc.arg('before_seq')::bigint)
ORDER BY l.seq DESC
LIMIT sqlc.arg('lim');

-- name: AdminListBillingPayments :many
SELECT sqlc.embed(p), a.workspace_id
FROM billing_payments p
JOIN billing_accounts a ON a.id = p.account_id
WHERE (sqlc.narg('account_id')::uuid IS NULL OR p.account_id = sqlc.narg('account_id')::uuid)
  AND (sqlc.arg('status')::text = '' OR p.status = sqlc.arg('status')::text)
  AND (sqlc.arg('provider_payment_id')::text = '' OR p.provider_payment_id = sqlc.arg('provider_payment_id')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR p.id < sqlc.narg('before_id')::uuid)
ORDER BY p.id DESC
LIMIT sqlc.arg('lim');

-- name: AdminListBillingRefunds :many
SELECT * FROM billing_refunds
WHERE (sqlc.narg('account_id')::uuid IS NULL OR account_id = sqlc.narg('account_id')::uuid)
  AND (sqlc.narg('payment_id')::uuid IS NULL OR payment_id = sqlc.narg('payment_id')::uuid)
  AND (sqlc.arg('status')::text = '' OR status = sqlc.arg('status')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR id < sqlc.narg('before_id')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: AdminListBillingRefundsByIdemPrefix :many
-- Refunds created by one admin request (idem_key 'refund:{request_id}…'), oldest first.
SELECT * FROM billing_refunds WHERE idem_key LIKE sqlc.arg('prefix')::text || '%' ORDER BY id;

-- name: AdminBillingPendingRefunds :one
-- Money reserved by refunds that are not final yet.
SELECT coalesce(sum(amount_minor), 0)::bigint AS minor FROM billing_refunds
WHERE account_id = $1 AND status IN ('pending', 'requires_action');

-- name: AdminSetBillingRefundProviderID :one
-- The provider accepted a refund that is still pending: remember its id for the webhook /
-- reconciliation. The account is locked by the caller.
UPDATE billing_refunds SET provider_refund_id = sqlc.arg('provider_refund_id')::text, updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND provider_refund_id IS NULL AND status IN ('pending', 'requires_action')
RETURNING *;

-- name: AdminListBillingDisputes :many
SELECT * FROM billing_disputes
WHERE (sqlc.narg('account_id')::uuid IS NULL OR account_id = sqlc.narg('account_id')::uuid)
  AND (sqlc.arg('status')::text = '' OR status = sqlc.arg('status')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR id < sqlc.narg('before_id')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: AdminListBillingProviderEvents :many
-- Ops view of the webhook inbox; filters for failing (error set) and unprocessed events.
SELECT * FROM billing_provider_events
WHERE (NOT sqlc.arg('errors_only')::boolean OR error <> '')
  AND (NOT sqlc.arg('unprocessed_only')::boolean OR processed_at IS NULL)
  AND (sqlc.arg('kind')::text = '' OR kind = sqlc.arg('kind')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR id < sqlc.narg('before_id')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: AdminListBillingRefundRequests :many
SELECT sqlc.embed(r), a.workspace_id
FROM billing_refund_requests r
JOIN billing_accounts a ON a.id = r.account_id
WHERE (sqlc.narg('account_id')::uuid IS NULL OR r.account_id = sqlc.narg('account_id')::uuid)
  AND (sqlc.arg('status')::text = '' OR r.status = sqlc.arg('status')::text)
  AND (sqlc.narg('before_id')::uuid IS NULL OR r.id < sqlc.narg('before_id')::uuid)
ORDER BY r.id DESC
LIMIT sqlc.arg('lim');

-- name: AdminGetBillingRefundRequest :one
SELECT * FROM billing_refund_requests WHERE id = $1;

-- name: AdminLockBillingRefundRequest :one
-- After LockBillingAccount of its account.
SELECT * FROM billing_refund_requests WHERE id = $1 FOR UPDATE;

-- name: AdminDecideBillingRefundRequest :one
UPDATE billing_refund_requests SET status = sqlc.arg('status'), decided_by = sqlc.narg('decided_by'),
    decided_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'requested'
RETURNING *;

-- name: AdminListRefundableBillingPayments :many
-- Payments of the account whose funding lot still has unused money, in lot (FIFO) order.
SELECT p.id FROM billing_payments p
JOIN billing_funding_lots f ON f.payment_id = p.id
WHERE p.account_id = $1 AND f.consumed_minor + f.refunded_minor < f.amount_minor
ORDER BY f.id;

-- name: AdminSetBillingAccountHold :one
-- Incident hold (NULL = released); the account is locked by the caller.
UPDATE billing_accounts SET hold_until = sqlc.narg('hold_until'), revision = revision + 1,
    updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: AdminSetBillingAccountDiscount :one
-- Discount of future seat charges (bought lots keep their price); the account is locked.
UPDATE billing_accounts SET discount_bps = sqlc.arg('discount_bps'), revision = revision + 1,
    updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id')
RETURNING *;
