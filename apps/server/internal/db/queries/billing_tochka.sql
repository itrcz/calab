-- Billing queries of ADR-0083 (Tochka / RU market): provider settings, polling of pending
-- checkouts, refunds sent at most once.

-- name: ListBillingProviderSettings :many
SELECT * FROM billing_provider_settings ORDER BY provider;

-- name: GetBillingProviderSettingForUpdate :one
SELECT * FROM billing_provider_settings WHERE provider = $1 FOR UPDATE;

-- name: UpsertBillingProviderSetting :one
INSERT INTO billing_provider_settings (provider, accept_new, updated_by, updated_at)
VALUES (sqlc.arg('provider'), sqlc.arg('accept_new'), sqlc.narg('updated_by'), sqlc.arg('now'))
ON CONFLICT (provider) DO UPDATE SET accept_new = EXCLUDED.accept_new, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
RETURNING *;

-- name: ScheduleBillingCheckoutPoll :exec
-- The next pull of an open checkout of a provider without failure / expiry webhooks.
UPDATE billing_checkouts SET next_poll_at = sqlc.arg('at'), polls = polls + sqlc.arg('inc')::integer
WHERE id = sqlc.arg('id') AND status = 'open';

-- name: ListBillingCheckoutsToPoll :many
-- Open checkouts with a provider page whose next poll is due.
SELECT * FROM billing_checkouts
WHERE status = 'open' AND next_poll_at <= sqlc.arg('now')::timestamptz AND provider_session_id IS NOT NULL
ORDER BY next_poll_at
LIMIT sqlc.arg('lim');

-- name: MarkBillingRefundDispatched :one
-- A refund of a provider without idempotency keys is about to be sent: committed before the
-- request; a row already marked is never sent again (no rows).
UPDATE billing_refunds SET dispatched_at = sqlc.arg('now')::timestamptz, updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND dispatched_at IS NULL AND status IN ('pending', 'requires_action')
RETURNING *;
