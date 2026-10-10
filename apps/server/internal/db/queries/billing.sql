-- Balance billing v1 (ADR-0080 v5, migration 00074): the base queries of the foundation (T0).
--
-- Ownership: this file is frozen after T0 so parallel tasks do not collide. Add new queries in
-- your own file instead: billing_core.sql (T1 core / worker), billing_stripe.sql (T2),
-- billing_http.sql (T5 HTTP / inbox / mail), billing_admin.sql (T6), billing_autotopup.sql
-- (T7). Query names start with Billing… or a billing noun so they stay unique.
--
-- Rules for every billing query:
--   * money mutations run inside one transaction that first locks the account
--     (LockBillingAccount / LockLiveBillingAccountByWorkspace) — no network inside it;
--   * time comes from billing.Clock (sqlc.arg('now')), not now(), so the fake clock drives
--     deadlines and renewals in tests; created_at / updated_at defaults are bookkeeping only;
--   * provider ids are idempotency keys: inserts use ON CONFLICT … DO NOTHING RETURNING and
--     treat "no row" as "already there" (then Get… the existing row).

-- name: BillingNow :one
-- Database time for billing.DBClock: call it after taking the account lock.
SELECT clock_timestamp()::timestamptz AS now;

-- name: InsertBillingAccount :one
INSERT INTO billing_accounts (workspace_id, market, currency, provider, plan, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetBillingAccount :one
SELECT * FROM billing_accounts WHERE id = $1;

-- name: BillingAccountMarketFixed :one
-- ADR-0083: the market of an account is fixed by its first money: a ledger entry, any payment
-- row (even a processing one) or an open checkout. Read under the account lock.
SELECT (a.entry_seq > 0 OR a.balance_minor <> 0
        OR EXISTS (SELECT 1 FROM billing_payments p WHERE p.account_id = a.id)
        OR EXISTS (SELECT 1 FROM billing_checkouts c WHERE c.account_id = a.id AND c.status = 'open'))::boolean AS fixed
FROM billing_accounts a WHERE a.id = $1;

-- name: SwitchBillingAccountMarket :one
-- Moves an account without money history to another market (BillingAccountMarketFixed false,
-- checked under the same lock).
UPDATE billing_accounts
SET market = sqlc.arg('market'), currency = sqlc.arg('currency'), provider = sqlc.arg('provider'),
    revision = revision + 1, updated_at = sqlc.arg('now')
WHERE id = sqlc.arg('id') AND status IN ('inactive', 'stopped') AND entry_seq = 0
RETURNING *;

-- name: LockBillingAccount :one
-- The single lock of every money mutation of the account (ADR-0080 §10).
SELECT * FROM billing_accounts WHERE id = $1 FOR UPDATE;

-- name: GetLiveBillingAccountByWorkspace :one
SELECT * FROM billing_accounts WHERE workspace_id = $1 AND status <> 'closed';

-- name: LockLiveBillingAccountByWorkspace :one
SELECT * FROM billing_accounts WHERE workspace_id = $1 AND status <> 'closed' FOR UPDATE;

-- name: UpdateBillingAccountState :one
-- Status, debt episode, schedule and plan after a core operation (the row is locked). Bumps
-- the revision; balance_minor / entry_seq change only through AppendBillingLedgerEntry.
UPDATE billing_accounts SET
    status = sqlc.arg('status'), plan = sqlc.arg('plan'),
    negative_since = sqlc.narg('negative_since'), suspend_at = sqlc.narg('suspend_at'),
    next_due_at = sqlc.narg('next_due_at'),
    closed_at = CASE WHEN sqlc.arg('status')::text = 'closed' THEN coalesce(closed_at, sqlc.arg('now')::timestamptz) ELSE NULL END,
    revision = revision + 1, updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: ClaimBillingAccountsDue :many
-- Active accounts whose seat lots are due for renewal, oldest first. Run it in the renewal
-- transaction of a small batch: SKIP LOCKED lets parallel workers take different accounts (the
-- rows stay locked until that transaction ends; re-check next_due_at on each row).
SELECT id FROM billing_accounts
WHERE status = 'active' AND next_due_at <= sqlc.arg('now')::timestamptz
ORDER BY next_due_at
LIMIT sqlc.arg('lim')
FOR UPDATE SKIP LOCKED;

-- name: ListBillingAccountsToSuspend :many
-- Accounts whose debt deadline passed (still in debt is re-checked under the lock).
SELECT id FROM billing_accounts
WHERE status IN ('active', 'stopped') AND suspend_at <= sqlc.arg('now')::timestamptz
ORDER BY suspend_at
LIMIT sqlc.arg('lim');

-- name: AppendBillingLedgerEntry :one
-- Appends one entry and moves the balance cache and entry_seq in the same statement. The
-- account must be locked by the caller. A duplicate business_key raises unique_violation
-- (and rolls the balance back with the statement): check GetBillingLedgerEntryByKey first.
WITH acc AS (
    UPDATE billing_accounts
    SET balance_minor = balance_minor + sqlc.arg('amount_minor')::bigint, entry_seq = entry_seq + 1,
        revision = revision + 1, updated_at = sqlc.arg('now')::timestamptz
    WHERE billing_accounts.id = sqlc.arg('account_id')
    RETURNING id, entry_seq, balance_minor
)
INSERT INTO billing_ledger (account_id, seq, kind, amount_minor, balance_after, business_key,
    lot_id, charge_id, refund_id, dispute_id, actor_id, reason, created_at)
SELECT acc.id, acc.entry_seq, sqlc.arg('kind'), sqlc.arg('amount_minor')::bigint, acc.balance_minor,
    sqlc.arg('business_key'), sqlc.narg('lot_id'), sqlc.narg('charge_id'), sqlc.narg('refund_id'),
    sqlc.narg('dispute_id'), sqlc.narg('actor_id'), sqlc.arg('reason'), sqlc.arg('now')::timestamptz
FROM acc
RETURNING *;

-- name: GetBillingLedgerEntryByKey :one
SELECT * FROM billing_ledger WHERE business_key = $1;

-- name: ListBillingLedger :many
-- Newest first; before_seq = 0 starts at the newest entry.
SELECT * FROM billing_ledger
WHERE account_id = sqlc.arg('account_id')
  AND (sqlc.arg('before_seq')::bigint = 0 OR seq < sqlc.arg('before_seq')::bigint)
ORDER BY seq DESC
LIMIT sqlc.arg('lim');

-- name: ListBillingLedgerMismatches :many
-- Nightly check: accounts whose balance cache or entry_seq disagrees with their ledger.
SELECT a.id, a.balance_minor, a.entry_seq,
    coalesce(l.total, 0)::bigint AS ledger_total, coalesce(l.last_seq, 0)::bigint AS ledger_seq
FROM billing_accounts a
LEFT JOIN (
    SELECT account_id, sum(amount_minor) AS total, max(seq) AS last_seq, count(*) AS n
    FROM billing_ledger GROUP BY account_id
) l ON l.account_id = a.id
WHERE a.balance_minor <> coalesce(l.total, 0) OR a.entry_seq <> coalesce(l.last_seq, 0)
   OR a.entry_seq <> coalesce(l.n, 0);

-- name: GetBillingPriceAt :one
-- The price version of a SKU in effect at `at`.
SELECT * FROM billing_prices
WHERE market = sqlc.arg('market') AND sku = sqlc.arg('sku') AND effective_from <= sqlc.arg('at')::timestamptz
ORDER BY effective_from DESC
LIMIT 1;

-- name: ListBillingPrices :many
SELECT * FROM billing_prices ORDER BY market, sku, effective_from DESC;

-- name: InsertBillingPrice :one
INSERT INTO billing_prices (market, currency, sku, plan, unit_minor, effective_from, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetBillingCustomer :one
SELECT * FROM billing_customers WHERE account_id = $1 AND provider = $2 AND livemode = $3;

-- name: InsertBillingCustomer :one
-- No row = the account already has a customer of this provider/mode (GetBillingCustomer).
INSERT INTO billing_customers (account_id, provider, provider_account, livemode, customer_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT DO NOTHING
RETURNING *;

-- name: GetBillingCustomerByProviderID :one
SELECT * FROM billing_customers
WHERE provider = $1 AND provider_account = $2 AND livemode = $3 AND customer_id = $4;

-- name: GetBillingPayer :one
SELECT * FROM billing_payers WHERE account_id = $1;

-- name: UpsertBillingPayer :one
INSERT INTO billing_payers (account_id, type, name, country, email, tax_id, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, sqlc.arg('now')::timestamptz)
ON CONFLICT (account_id) DO UPDATE SET
    type = EXCLUDED.type, name = EXCLUDED.name, country = EXCLUDED.country, email = EXCLUDED.email,
    tax_id = EXCLUDED.tax_id, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
RETURNING *;

-- name: InsertBillingCheckout :one
-- No row = this request_id exists (GetBillingCheckoutByRequest: same body_hash → same result,
-- else 409). A second open checkout of the account raises unique_violation
-- (billing_checkouts_one_open_idx): answer 409 BILLING_PAYMENT_PENDING with the open one.
INSERT INTO billing_checkouts (account_id, request_id, body_hash, purpose, method_id, provider,
    amount_minor, currency, save_method, payer_snapshot, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (account_id, request_id) DO NOTHING
RETURNING *;

-- name: GetBillingCheckout :one
SELECT * FROM billing_checkouts WHERE id = $1;

-- name: GetBillingCheckoutByRequest :one
SELECT * FROM billing_checkouts WHERE account_id = $1 AND request_id = $2;

-- name: GetOpenBillingCheckout :one
SELECT * FROM billing_checkouts WHERE account_id = $1 AND status = 'open';

-- name: GetBillingCheckoutBySession :one
SELECT * FROM billing_checkouts WHERE provider_session_id = $1;

-- name: SetBillingCheckoutSession :one
-- After the provider created the session (outside the transaction that inserted the row).
UPDATE billing_checkouts SET provider_session_id = sqlc.arg('session_id'), url = sqlc.arg('url'),
    expires_at = sqlc.narg('expires_at'), updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'open' AND (provider_session_id IS NULL OR provider_session_id = sqlc.arg('session_id'))
RETURNING *;

-- name: SetBillingCheckoutStatus :one
-- Leaves 'open' only: completed / expired / canceled / failed are final.
UPDATE billing_checkouts SET status = sqlc.arg('status'), updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'open'
RETURNING *;

-- name: InsertBillingPayment :one
-- No row = this provider payment is already recorded (GetBillingPaymentByProviderID). The
-- unique key is the one-credit-per-PaymentIntent guarantee.
INSERT INTO billing_payments (account_id, provider, provider_account, livemode, provider_payment_id,
    provider_charge_id, amount_minor, currency, status, origin, checkout_id, attempt_id, receipt_url,
    succeeded_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (provider, provider_account, livemode, provider_payment_id) DO NOTHING
RETURNING *;

-- name: GetBillingPayment :one
SELECT * FROM billing_payments WHERE id = $1;

-- name: GetBillingPaymentByProviderID :one
SELECT * FROM billing_payments
WHERE provider = $1 AND provider_account = $2 AND livemode = $3 AND provider_payment_id = $4;

-- name: MarkBillingPaymentSucceeded :one
-- processing → succeeded (amount_received confirmed by a fresh provider read).
UPDATE billing_payments SET status = 'succeeded', amount_minor = sqlc.arg('amount_minor'),
    provider_charge_id = sqlc.narg('provider_charge_id'), receipt_url = sqlc.arg('receipt_url'),
    succeeded_at = sqlc.arg('succeeded_at')::timestamptz, updated_at = sqlc.arg('now')::timestamptz
WHERE id = sqlc.arg('id') AND status = 'processing'
RETURNING *;

-- name: ListBillingPayments :many
SELECT * FROM billing_payments
WHERE account_id = sqlc.arg('account_id')
  AND (sqlc.narg('before_id')::uuid IS NULL OR id < sqlc.narg('before_id')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: InsertBillingFundingLot :one
-- No row = the payment already has its lot (UNIQUE payment_id): never credit twice.
INSERT INTO billing_funding_lots (account_id, source, payment_id, amount_minor, actor_id, reason)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (payment_id) DO NOTHING
RETURNING *;

-- name: LockOpenBillingFundingLots :many
-- FIFO: lots with money left, oldest first (the account is locked already; FOR UPDATE keeps
-- the lots consistent with it). Never SKIP LOCKED here: an older lot must not be skipped.
SELECT * FROM billing_funding_lots
WHERE account_id = $1 AND consumed_minor + refunded_minor < amount_minor
ORDER BY id
FOR UPDATE;

-- name: ConsumeBillingFundingLot :one
-- delta may be negative (reversal). The CHECK keeps consumed + refunded within the amount.
UPDATE billing_funding_lots SET consumed_minor = consumed_minor + sqlc.arg('delta')::bigint
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: RefundBillingFundingLot :one
UPDATE billing_funding_lots SET refunded_minor = refunded_minor + sqlc.arg('delta')::bigint
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: InsertBillingAllocation :one
INSERT INTO billing_allocations (account_id, charge_id, lot_id, amount_minor)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: InsertBillingCharge :one
-- No row = the business key exists (renew:{account}:{starts_at}, admit:{request_id}, …).
INSERT INTO billing_charges (account_id, sku, plan, price_id, qty, unit_minor, discount_bps,
    starts_at, ends_at, amount_minor, unfunded_minor, reason, business_key, actor_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (business_key) DO NOTHING
RETURNING *;

-- name: ListBillingChargesActiveAt :many
-- Seat lots covering `at` (capacity = sum(qty) of the current plan's SKU).
SELECT * FROM billing_charges
WHERE account_id = sqlc.arg('account_id') AND starts_at <= sqlc.arg('at')::timestamptz AND ends_at > sqlc.arg('at')::timestamptz
ORDER BY ends_at, id;

-- name: ListBillingChargesEndingBy :many
-- Seat lots that end at or before `due` and were not renewed yet are the renewal candidates;
-- the core decides how many seats to renew from the current billable members.
SELECT * FROM billing_charges
WHERE account_id = sqlc.arg('account_id') AND ends_at <= sqlc.arg('due')::timestamptz AND ends_at > sqlc.arg('since')::timestamptz
ORDER BY ends_at, id;

-- name: LockUnfundedBillingCharges :many
-- Debt is paid first, oldest charge first.
SELECT * FROM billing_charges
WHERE account_id = $1 AND unfunded_minor > 0
ORDER BY starts_at, id
FOR UPDATE;

-- name: FundBillingCharge :one
-- A top-up paid delta of the charge's debt part.
UPDATE billing_charges SET unfunded_minor = unfunded_minor - sqlc.arg('delta')::bigint
WHERE id = sqlc.arg('id') AND unfunded_minor >= sqlc.arg('delta')::bigint
RETURNING *;

-- name: CompensateBillingCharge :one
-- Unused part returned (seat removed / plan change); debt_delta cancels debt first.
UPDATE billing_charges SET compensated_minor = compensated_minor + sqlc.arg('delta')::bigint,
    unfunded_minor = unfunded_minor - sqlc.arg('debt_delta')::bigint
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: InsertBillingRefund :one
-- No row = idem_key / provider_refund_id exists (GetBillingRefundByIdemKey). Refundable
-- amount is checked by the caller under the account lock.
INSERT INTO billing_refunds (account_id, payment_id, lot_id, amount_minor, currency, status, origin,
    provider_refund_id, idem_key, reason, requested_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT DO NOTHING
RETURNING *;

-- name: GetBillingRefundByIdemKey :one
SELECT * FROM billing_refunds WHERE idem_key = $1;

-- name: GetBillingRefundByProviderID :one
SELECT * FROM billing_refunds WHERE provider_refund_id = $1;

-- name: InsertBillingDispute :one
INSERT INTO billing_disputes (account_id, payment_id, provider_dispute_id, amount_minor, currency)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (provider_dispute_id) DO NOTHING
RETURNING *;

-- name: GetBillingDisputeByProviderID :one
SELECT * FROM billing_disputes WHERE provider_dispute_id = $1;

-- name: InsertBillingRefundRequest :one
INSERT INTO billing_refund_requests (account_id, request_id, amount_minor, reason, requested_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (account_id, request_id) DO NOTHING
RETURNING *;

-- name: InsertBillingProviderEvent :one
-- After the signature check; no row = duplicate delivery (ACK 200 all the same).
INSERT INTO billing_provider_events (provider, provider_account, livemode, event_id, kind, object_id, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (provider, provider_account, event_id) DO NOTHING
RETURNING id;

-- name: ClaimBillingProviderEvents :many
-- Due unprocessed events, oldest first; next_attempt_at moves one lease ahead so a crashed
-- worker's events are retried and a second worker skips them.
UPDATE billing_provider_events SET next_attempt_at = sqlc.arg('now')::timestamptz + sqlc.arg('lease')::interval,
    attempts = attempts + 1
WHERE id IN (
    SELECT e.id FROM billing_provider_events e
    WHERE e.processed_at IS NULL AND e.next_attempt_at <= sqlc.arg('now')::timestamptz
    ORDER BY e.next_attempt_at, e.id
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: MarkBillingProviderEventProcessed :exec
UPDATE billing_provider_events SET processed_at = sqlc.arg('now')::timestamptz, error = '' WHERE id = sqlc.arg('id');

-- name: MarkBillingProviderEventRetry :exec
UPDATE billing_provider_events SET next_attempt_at = sqlc.arg('next_attempt_at')::timestamptz, error = sqlc.arg('error')
WHERE id = sqlc.arg('id');

-- name: GetBillingAutoTopup :one
SELECT * FROM billing_autotopup WHERE account_id = $1;

-- name: InsertBillingAutoTopupAttempt :one
-- A second open attempt of the account raises unique_violation
-- (billing_autotopup_attempts_one_open_idx): never two charges in flight.
INSERT INTO billing_autotopup_attempts (account_id, pm_id, amount_minor, currency, created_at)
VALUES ($1, $2, $3, $4, sqlc.arg('now')::timestamptz)
RETURNING *;

-- name: GetOpenBillingAutoTopupAttempt :one
SELECT * FROM billing_autotopup_attempts
WHERE account_id = $1 AND status IN ('prepared', 'dispatched', 'unknown');

-- name: GetLastBillingAutoTopupAttempt :one
SELECT * FROM billing_autotopup_attempts WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: SetBillingAutoTopupAttemptStatus :one
-- prepared → dispatched → succeeded | failed | unknown; unknown → succeeded | failed.
UPDATE billing_autotopup_attempts SET status = sqlc.arg('status'),
    provider_payment_id = coalesce(sqlc.narg('provider_payment_id'), provider_payment_id),
    failure_code = sqlc.arg('failure_code'),
    dispatched_at = CASE WHEN sqlc.arg('status')::text = 'dispatched' THEN sqlc.arg('now')::timestamptz ELSE dispatched_at END,
    finished_at = CASE WHEN sqlc.arg('status')::text IN ('succeeded', 'failed') THEN sqlc.arg('now')::timestamptz ELSE NULL END
WHERE id = sqlc.arg('id') AND status NOT IN ('succeeded', 'failed')
RETURNING *;

-- name: InsertBillingAudit :one
-- No row = request_id was used (GetBillingAuditByRequest: same body_hash = replay, else 409).
INSERT INTO billing_audit (request_id, body_hash, account_id, workspace_id, actor_id, action, reason, details)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (request_id) DO NOTHING
RETURNING *;

-- name: GetBillingAuditByRequest :one
SELECT * FROM billing_audit WHERE request_id = $1;

-- name: InsertBillingNotification :one
-- No row = this mail was already queued for the account (dedup by business key).
INSERT INTO billing_notifications (account_id, key, template, mail_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (account_id, key) DO NOTHING
RETURNING *;

-- name: CountBillableMembers :one
-- Paid seats: members except guests and bots (the owner included). plans.KindMembers, which
-- counts bots, stays the hard plan limit.
SELECT count(*)::integer FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND m.role <> 'guest' AND NOT u.is_bot;
