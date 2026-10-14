-- Balance billing v1 (ADR-0080 v5 «v1 cut», docs/plans/billing-v1-tasks.md): a money balance per
-- workspace billing account, daily seat charges, provider payments (Stripe first) and optional
-- auto-topup. Everything here is new and empty except workspace_plans / workspace_plan_log,
-- which are small (one row per workspace with a manual plan): their new column has a constant
-- default (metadata only) and its CHECK is validated inline under a short lock_timeout.
--
-- Money: bigint minor units (cents / kopecks) of the account currency; an account is fixed to
-- one market + currency (no FX). Sign of billing_ledger.amount_minor = effect on the balance.
--
-- Invariants enforced here (the rest is the core's job, under SELECT … FOR UPDATE of the
-- account row, with no network inside the transaction):
--   * one live account per workspace (partial UNIQUE), workspace delete keeps the money rows;
--   * negative_since / suspend_at set together (one debt episode, written once);
--   * one credit per provider payment: UNIQUE(provider, provider_account, livemode,
--     provider_payment_id) on billing_payments, and one funding lot per payment;
--   * consumed + refunded <= amount on every funding lot;
--   * one open checkout and one open auto-topup attempt per account (partial UNIQUE);
--   * billing_ledger / billing_allocations / billing_prices / billing_audit are append-only
--     (a trigger raises on UPDATE / DELETE / TRUNCATE). Their user references are plain uuids
--     without a foreign key: ON DELETE SET NULL would be an UPDATE the trigger refuses.

-- +goose Up
SET LOCAL lock_timeout = '10s';

-- +goose StatementBegin
CREATE FUNCTION billing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'billing: % is append-only (% refused)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END
$$;
-- +goose StatementEnd

CREATE TABLE billing_accounts (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    -- NULL after the workspace was deleted (the account is closed first; money history stays).
    workspace_id   uuid REFERENCES workspaces (id) ON DELETE SET NULL,
    market         text NOT NULL CHECK (market IN ('global', 'ru')),
    currency       text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    -- provider id of the market (provider.ID: 'stripe', later 'tochka').
    provider       text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
    plan           text NOT NULL DEFAULT 'team' CHECK (plan IN ('team', 'enterprise')),
    -- inactive: enabled by a superadmin, not activated yet; active: daily charges run;
    -- stopped: owner stopped the paid plan (no new charges); suspended: debt deadline passed;
    -- closed: workspace deleted or account replaced (terminal).
    status         text NOT NULL DEFAULT 'inactive'
        CHECK (status IN ('inactive', 'active', 'stopped', 'suspended', 'closed')),
    balance_minor  bigint NOT NULL DEFAULT 0,   -- cache of sum(billing_ledger.amount_minor)
    entry_seq      bigint NOT NULL DEFAULT 0 CHECK (entry_seq >= 0), -- last billing_ledger.seq
    -- Debt episode (ADR-0080 §8): set once when the balance first goes negative; suspend_at =
    -- negative_since + 7 days. A partial payment does not move them.
    negative_since timestamptz,
    suspend_at     timestamptz,
    next_due_at    timestamptz,                  -- next renewal of the seat lots (active only)
    hold_until     timestamptz,                  -- incident hold by a superadmin: no debits/suspension
    dispute_hold   boolean NOT NULL DEFAULT false, -- an open dispute: no refunds / auto-topup
    discount_bps   integer NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
    revision       bigint NOT NULL DEFAULT 1 CHECK (revision >= 1), -- expected_revision, BillingUpdate.revision
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz,
    CONSTRAINT billing_accounts_market_currency_check
        CHECK ((market = 'global' AND currency = 'USD') OR (market = 'ru' AND currency = 'RUB')),
    CONSTRAINT billing_accounts_episode_check
        CHECK ((negative_since IS NULL) = (suspend_at IS NULL) AND (suspend_at IS NULL OR suspend_at > negative_since)),
    CONSTRAINT billing_accounts_closed_check CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX billing_accounts_workspace_live_idx ON billing_accounts (workspace_id)
    WHERE status <> 'closed';
CREATE INDEX billing_accounts_workspace_idx ON billing_accounts (workspace_id); -- ON DELETE SET NULL
CREATE INDEX billing_accounts_due_idx ON billing_accounts (next_due_at) WHERE status = 'active';
CREATE INDEX billing_accounts_suspend_idx ON billing_accounts (suspend_at) WHERE suspend_at IS NOT NULL;
CREATE INDEX billing_accounts_created_by_idx ON billing_accounts (created_by) WHERE created_by IS NOT NULL;

-- Provider customer of an account (Stripe Customer). Never taken from a client.
CREATE TABLE billing_customers (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id       uuid NOT NULL REFERENCES billing_accounts (id),
    provider         text NOT NULL,
    provider_account text NOT NULL,              -- merchant account (acct_…)
    livemode         boolean NOT NULL,
    customer_id      text NOT NULL,              -- cus_…
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_account, livemode, customer_id),
    UNIQUE (account_id, provider, livemode)
);

-- Payer of an account (Checkout collects address and tax id itself; this is what we show).
CREATE TABLE billing_payers (
    account_id uuid PRIMARY KEY REFERENCES billing_accounts (id),
    type       text NOT NULL CHECK (type IN ('person', 'company')),
    name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    country    text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    email      text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
    tax_id     text CHECK (tax_id IS NULL OR char_length(tax_id) BETWEEN 1 AND 64),
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_payers_updated_by_idx ON billing_payers (updated_by) WHERE updated_by IS NOT NULL;

-- Price versions per market and SKU, immutable. A new version starts at effective_from (the
-- admin API requires effective_from >= now + 10 days; the seed below is the launch price).
CREATE TABLE billing_prices (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    market         text NOT NULL CHECK (market IN ('global', 'ru')),
    currency       text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    sku            text NOT NULL CHECK (sku ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
    plan           text CHECK (plan IN ('team', 'enterprise')), -- NULL for future non-seat SKUs
    unit_minor     bigint NOT NULL CHECK (unit_minor > 0), -- per unit (seat) per 24 h, before discount
    effective_from timestamptz NOT NULL,
    created_by     uuid,                          -- append-only: no FK
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (market, sku, effective_from),
    CONSTRAINT billing_prices_market_currency_check
        CHECK ((market = 'global' AND currency = 'USD') OR (market = 'ru' AND currency = 'RUB'))
);
CREATE TRIGGER billing_prices_append_only BEFORE UPDATE OR DELETE ON billing_prices
    FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER billing_prices_no_truncate BEFORE TRUNCATE ON billing_prices
    FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

INSERT INTO billing_prices (market, currency, sku, plan, unit_minor, effective_from) VALUES
    ('global', 'USD', 'seat.team.day', 'team', 10, '2026-01-01T00:00:00Z'),
    ('global', 'USD', 'seat.enterprise.day', 'enterprise', 30, '2026-01-01T00:00:00Z'),
    ('ru', 'RUB', 'seat.team.day', 'team', 600, '2026-01-01T00:00:00Z'),
    ('ru', 'RUB', 'seat.enterprise.day', 'enterprise', 1800, '2026-01-01T00:00:00Z');

-- Hosted checkout sessions (manual top-up). The row is written before the provider call (open,
-- provider_session_id NULL), so a retry with the same request_id finds it.
CREATE TABLE billing_checkouts (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id          uuid NOT NULL REFERENCES billing_accounts (id),
    request_id          uuid NOT NULL,
    body_hash           bytea NOT NULL CHECK (octet_length(body_hash) = 32), -- sha256 of the request
    purpose             text NOT NULL CHECK (purpose IN ('topup', 'activate', 'resume')),
    method_id           text NOT NULL,             -- capability option id, e.g. 'stripe:card'
    provider            text NOT NULL,
    amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
    currency            text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    save_method         boolean NOT NULL DEFAULT false,
    status              text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'completed', 'expired', 'canceled', 'failed')),
    provider_session_id text UNIQUE,
    url                 text,
    payer_snapshot      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payer_snapshot) = 'object'),
    created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, request_id)
);
CREATE UNIQUE INDEX billing_checkouts_one_open_idx ON billing_checkouts (account_id) WHERE status = 'open';
CREATE INDEX billing_checkouts_created_by_idx ON billing_checkouts (created_by) WHERE created_by IS NOT NULL;

-- Saved payment methods (off-session auto-topup).
CREATE TABLE billing_payment_methods (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id     uuid NOT NULL REFERENCES billing_accounts (id),
    customer_id    uuid NOT NULL REFERENCES billing_customers (id),
    provider       text NOT NULL,
    livemode       boolean NOT NULL,
    provider_pm_id text NOT NULL UNIQUE,         -- pm_…
    kind           text NOT NULL CHECK (kind IN ('card', 'sbp', 'bank_transfer')),
    brand          text NOT NULL DEFAULT '',
    last4          text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
    exp_month      smallint CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
    exp_year       smallint CHECK (exp_year IS NULL OR exp_year BETWEEN 2000 AND 2200),
    created_at     timestamptz NOT NULL DEFAULT now(),
    detached_at    timestamptz
);
CREATE INDEX billing_payment_methods_account_idx ON billing_payment_methods (account_id) WHERE detached_at IS NULL;
CREATE INDEX billing_payment_methods_customer_idx ON billing_payment_methods (customer_id);

-- Auto-topup consent per account. Active = revoked_at IS NULL. Owner transfer revokes it.
CREATE TABLE billing_autotopup (
    account_id      uuid PRIMARY KEY REFERENCES billing_accounts (id),
    pm_id           uuid NOT NULL REFERENCES billing_payment_methods (id),
    max_minor       bigint NOT NULL CHECK (max_minor > 0), -- owner cap per attempt (USD: default 50000, max 500000)
    consent_version integer NOT NULL CHECK (consent_version >= 1),
    consent_at      timestamptz NOT NULL,
    consent_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    revoked_at      timestamptz,
    revoked_reason  text NOT NULL DEFAULT '',
    not_before      timestamptz,                -- next new attempt not earlier (≥ 24 h after the last one)
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_autotopup_pm_idx ON billing_autotopup (pm_id);
CREATE INDEX billing_autotopup_consent_by_idx ON billing_autotopup (consent_by) WHERE consent_by IS NOT NULL;

-- One off-session charge attempt; id is the provider Idempotency-Key (also in PI metadata).
CREATE TABLE billing_autotopup_attempts (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id          uuid NOT NULL REFERENCES billing_accounts (id),
    pm_id               uuid NOT NULL REFERENCES billing_payment_methods (id),
    amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
    currency            text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    status              text NOT NULL DEFAULT 'prepared'
        CHECK (status IN ('prepared', 'dispatched', 'succeeded', 'failed', 'unknown')),
    provider_payment_id text,
    failure_code        text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    dispatched_at       timestamptz,
    finished_at         timestamptz,
    CONSTRAINT billing_autotopup_attempts_finished_check
        CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX billing_autotopup_attempts_one_open_idx ON billing_autotopup_attempts (account_id)
    WHERE status IN ('prepared', 'dispatched', 'unknown');
CREATE INDEX billing_autotopup_attempts_account_idx ON billing_autotopup_attempts (account_id, created_at DESC);
CREATE INDEX billing_autotopup_attempts_pm_idx ON billing_autotopup_attempts (pm_id);

-- Provider payments (PaymentIntents). The only source of a provider credit: one row per PI.
CREATE TABLE billing_payments (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id          uuid NOT NULL REFERENCES billing_accounts (id),
    provider            text NOT NULL,
    provider_account    text NOT NULL,
    livemode            boolean NOT NULL,
    provider_payment_id text NOT NULL,           -- pi_…
    provider_charge_id  text,                    -- ch_… (reference only)
    amount_minor        bigint NOT NULL CHECK (amount_minor > 0), -- amount_received
    currency            text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    status              text NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed', 'canceled')),
    origin              text NOT NULL CHECK (origin IN ('checkout', 'auto_topup', 'import')),
    checkout_id         uuid REFERENCES billing_checkouts (id),
    attempt_id          uuid REFERENCES billing_autotopup_attempts (id),
    receipt_url         text NOT NULL DEFAULT '',
    refunded_minor      bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
    succeeded_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_account, livemode, provider_payment_id),
    CONSTRAINT billing_payments_succeeded_check CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL)),
    CONSTRAINT billing_payments_refunded_check CHECK (refunded_minor <= amount_minor),
    CONSTRAINT billing_payments_origin_refs_check CHECK (
        (origin = 'checkout' AND attempt_id IS NULL) OR
        (origin = 'auto_topup' AND checkout_id IS NULL AND attempt_id IS NOT NULL) OR
        (origin = 'import' AND attempt_id IS NULL))
);
CREATE INDEX billing_payments_account_idx ON billing_payments (account_id, id DESC);
CREATE INDEX billing_payments_checkout_idx ON billing_payments (checkout_id) WHERE checkout_id IS NOT NULL;
CREATE UNIQUE INDEX billing_payments_attempt_idx ON billing_payments (attempt_id) WHERE attempt_id IS NOT NULL;

-- Funding lots: money on the balance, spent FIFO (id order); refunds go back to the lot's payment.
CREATE TABLE billing_funding_lots (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id     uuid NOT NULL REFERENCES billing_accounts (id),
    source         text NOT NULL CHECK (source IN ('payment', 'admin_credit')),
    payment_id     uuid UNIQUE REFERENCES billing_payments (id),
    amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
    consumed_minor bigint NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0),
    refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
    actor_id       uuid REFERENCES users (id) ON DELETE SET NULL, -- admin_credit: the superadmin
    reason         text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_funding_lots_payment_ref_check CHECK ((source = 'payment') = (payment_id IS NOT NULL)),
    CONSTRAINT billing_funding_lots_amount_check CHECK (consumed_minor + refunded_minor <= amount_minor)
);
CREATE INDEX billing_funding_lots_open_idx ON billing_funding_lots (account_id, id)
    WHERE consumed_minor + refunded_minor < amount_minor;
CREATE INDEX billing_funding_lots_actor_idx ON billing_funding_lots (actor_id) WHERE actor_id IS NOT NULL;

-- Seat charges (= seat lots): qty seats of one SKU for [starts_at, ends_at). Funded FIFO from
-- funding lots (billing_allocations); unfunded_minor is the debt part, paid first by top-ups.
CREATE TABLE billing_charges (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id        uuid NOT NULL REFERENCES billing_accounts (id),
    sku               text NOT NULL,
    plan              text NOT NULL CHECK (plan IN ('team', 'enterprise')),
    price_id          uuid NOT NULL REFERENCES billing_prices (id),
    qty               integer NOT NULL CHECK (qty > 0),
    unit_minor        bigint NOT NULL CHECK (unit_minor >= 0), -- after discount
    discount_bps      integer NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
    starts_at         timestamptz NOT NULL,
    ends_at           timestamptz NOT NULL,
    amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
    unfunded_minor    bigint NOT NULL DEFAULT 0 CHECK (unfunded_minor >= 0),
    compensated_minor bigint NOT NULL DEFAULT 0 CHECK (compensated_minor >= 0),
    reason            text NOT NULL CHECK (reason IN ('activate', 'renew', 'admit', 'change_plan', 'resume')),
    -- renew:{account}:{starts_at} | admit:{request_id} | activate:{request_id} | …
    business_key      text NOT NULL UNIQUE,
    actor_id          uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_charges_interval_check CHECK (ends_at > starts_at),
    CONSTRAINT billing_charges_amount_check CHECK (unfunded_minor + compensated_minor <= amount_minor)
);
CREATE INDEX billing_charges_account_ends_idx ON billing_charges (account_id, ends_at);
CREATE INDEX billing_charges_unfunded_idx ON billing_charges (account_id, starts_at, id) WHERE unfunded_minor > 0;
CREATE INDEX billing_charges_price_idx ON billing_charges (price_id);
CREATE INDEX billing_charges_actor_idx ON billing_charges (actor_id) WHERE actor_id IS NOT NULL;

-- Which lot paid which charge; append-only, reversals are negative rows.
CREATE TABLE billing_allocations (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id   uuid NOT NULL REFERENCES billing_accounts (id),
    charge_id    uuid NOT NULL REFERENCES billing_charges (id),
    lot_id       uuid NOT NULL REFERENCES billing_funding_lots (id),
    amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_allocations_charge_idx ON billing_allocations (charge_id);
CREATE INDEX billing_allocations_lot_idx ON billing_allocations (lot_id);
CREATE INDEX billing_allocations_account_idx ON billing_allocations (account_id);
CREATE TRIGGER billing_allocations_append_only BEFORE UPDATE OR DELETE ON billing_allocations
    FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER billing_allocations_no_truncate BEFORE TRUNCATE ON billing_allocations
    FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- Refunds to the original payment. idem_key is the provider Idempotency-Key ('refund:{id}');
-- a refund made in the provider dashboard gets 'dashboard:{provider_refund_id}'.
CREATE TABLE billing_refunds (
    id                 uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id         uuid NOT NULL REFERENCES billing_accounts (id),
    payment_id         uuid NOT NULL REFERENCES billing_payments (id),
    lot_id             uuid REFERENCES billing_funding_lots (id),
    amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
    currency           text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    status             text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
    origin             text NOT NULL CHECK (origin IN ('calab', 'dashboard')),
    provider_refund_id text UNIQUE,              -- re_… (NULL until the provider answered)
    idem_key           text NOT NULL UNIQUE,
    reason             text NOT NULL DEFAULT '',
    requested_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    succeeded_at       timestamptz
);
CREATE INDEX billing_refunds_account_idx ON billing_refunds (account_id, id DESC);
CREATE INDEX billing_refunds_payment_idx ON billing_refunds (payment_id);
CREATE INDEX billing_refunds_lot_idx ON billing_refunds (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX billing_refunds_requested_by_idx ON billing_refunds (requested_by) WHERE requested_by IS NOT NULL;

-- Owner requests to refund the unused balance (POST …/billing/refund-requests); a superadmin
-- decides and executes them as billing_refunds.
CREATE TABLE billing_refund_requests (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id   uuid NOT NULL REFERENCES billing_accounts (id),
    request_id   uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 1000),
    status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
    requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    UNIQUE (account_id, request_id)
);
CREATE INDEX billing_refund_requests_open_idx ON billing_refund_requests (created_at) WHERE status = 'requested';
CREATE INDEX billing_refund_requests_requested_by_idx ON billing_refund_requests (requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX billing_refund_requests_decided_by_idx ON billing_refund_requests (decided_by) WHERE decided_by IS NOT NULL;

-- Disputes (chargebacks) of a payment.
CREATE TABLE billing_disputes (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id          uuid NOT NULL REFERENCES billing_accounts (id),
    payment_id          uuid NOT NULL REFERENCES billing_payments (id),
    provider_dispute_id text NOT NULL UNIQUE,    -- dp_…
    amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
    currency            text NOT NULL CHECK (currency IN ('USD', 'RUB')),
    status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    outcome             text CHECK (outcome IN ('won', 'lost', 'withdrawn')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    closed_at           timestamptz,
    CONSTRAINT billing_disputes_closed_check CHECK ((status = 'closed') = (outcome IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX billing_disputes_account_idx ON billing_disputes (account_id, id DESC);
CREATE INDEX billing_disputes_payment_idx ON billing_disputes (payment_id);

-- The money ledger: append-only, seq increments per account (billing_accounts.entry_seq).
-- Sign = effect on the balance, fixed per kind.
CREATE TABLE billing_ledger (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id    uuid NOT NULL REFERENCES billing_accounts (id),
    seq           bigint NOT NULL CHECK (seq >= 1),
    kind          text NOT NULL CHECK (kind IN ('topup', 'seat_charge', 'compensation', 'refund',
        'refund_reversal', 'dispute', 'dispute_reversal', 'admin_credit', 'admin_debit')),
    amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),
    balance_after bigint NOT NULL,
    business_key  text NOT NULL UNIQUE,
    lot_id        uuid REFERENCES billing_funding_lots (id),
    charge_id     uuid REFERENCES billing_charges (id),
    refund_id     uuid REFERENCES billing_refunds (id),
    dispute_id    uuid REFERENCES billing_disputes (id),
    actor_id      uuid,                          -- append-only: no FK
    reason        text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, seq),
    CONSTRAINT billing_ledger_sign_check CHECK (CASE
        WHEN kind IN ('topup', 'compensation', 'refund_reversal', 'dispute_reversal', 'admin_credit') THEN amount_minor > 0
        ELSE amount_minor < 0 END)
);
CREATE INDEX billing_ledger_lot_idx ON billing_ledger (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX billing_ledger_charge_idx ON billing_ledger (charge_id) WHERE charge_id IS NOT NULL;
CREATE INDEX billing_ledger_refund_idx ON billing_ledger (refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX billing_ledger_dispute_idx ON billing_ledger (dispute_id) WHERE dispute_id IS NOT NULL;
CREATE TRIGGER billing_ledger_append_only BEFORE UPDATE OR DELETE ON billing_ledger
    FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER billing_ledger_no_truncate BEFORE TRUNCATE ON billing_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- Webhook inbox: inserted after the signature check (ON CONFLICT DO NOTHING), ACKed, then
-- processed by a worker. Minimal payload (ids, kind, metadata), no card data.
CREATE TABLE billing_provider_events (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    provider         text NOT NULL,
    provider_account text NOT NULL,
    livemode         boolean NOT NULL,
    event_id         text NOT NULL,              -- evt_…
    kind             text NOT NULL,              -- provider.EventKind
    object_id        text NOT NULL DEFAULT '',
    payload          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    received_at      timestamptz NOT NULL DEFAULT now(),
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    processed_at     timestamptz,
    error            text NOT NULL DEFAULT '',
    UNIQUE (provider, provider_account, event_id)
);
CREATE INDEX billing_provider_events_due_idx ON billing_provider_events (next_attempt_at) WHERE processed_at IS NULL;
CREATE INDEX billing_provider_events_received_idx ON billing_provider_events (received_at);

-- Audit of every billing mutation by a person (owner, superadmin); request_id makes a retry
-- idempotent (same body_hash = same result, another body = 409). Append-only.
CREATE TABLE billing_audit (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    request_id   uuid NOT NULL UNIQUE,
    body_hash    bytea NOT NULL CHECK (octet_length(body_hash) = 32),
    account_id   uuid REFERENCES billing_accounts (id),
    workspace_id uuid,                           -- append-only: no FK
    actor_id     uuid,                           -- append-only: no FK
    action       text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
    reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 1000),
    details      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_audit_account_idx ON billing_audit (account_id, id DESC) WHERE account_id IS NOT NULL;
CREATE TRIGGER billing_audit_append_only BEFORE UPDATE OR DELETE ON billing_audit
    FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER billing_audit_no_truncate BEFORE TRUNCATE ON billing_audit
    FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- Financial mail dedup: one mail per (account, business key); the mail row may be cleaned up.
CREATE TABLE billing_notifications (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id uuid NOT NULL REFERENCES billing_accounts (id),
    key        text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
    template   text NOT NULL,
    mail_id    uuid REFERENCES mail_outbox (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, key)
);
CREATE INDEX billing_notifications_mail_idx ON billing_notifications (mail_id) WHERE mail_id IS NOT NULL;

-- Plans set by billing are not editable through the manual admin API (409 there).
ALTER TABLE workspace_plans ADD COLUMN source text NOT NULL DEFAULT 'manual'
    CONSTRAINT workspace_plans_source_check CHECK (source IN ('manual', 'billing'));
ALTER TABLE workspace_plan_log ADD COLUMN source text NOT NULL DEFAULT 'manual'
    CONSTRAINT workspace_plan_log_source_check CHECK (source IN ('manual', 'billing'));

-- +goose Down
SET LOCAL lock_timeout = '10s';
ALTER TABLE workspace_plan_log DROP COLUMN source;
ALTER TABLE workspace_plans DROP COLUMN source;
DROP TABLE billing_notifications;
DROP TABLE billing_audit;
DROP TABLE billing_provider_events;
DROP TABLE billing_ledger;
DROP TABLE billing_disputes;
DROP TABLE billing_refund_requests;
DROP TABLE billing_refunds;
DROP TABLE billing_allocations;
DROP TABLE billing_charges;
DROP TABLE billing_funding_lots;
DROP TABLE billing_payments;
DROP TABLE billing_autotopup_attempts;
DROP TABLE billing_autotopup;
DROP TABLE billing_payment_methods;
DROP TABLE billing_checkouts;
DROP TABLE billing_prices;
DROP TABLE billing_payers;
DROP TABLE billing_customers;
DROP TABLE billing_accounts;
DROP FUNCTION billing_append_only();
