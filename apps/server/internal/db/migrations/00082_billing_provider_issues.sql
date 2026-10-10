-- Billing: synchronous admin refunds and refunds made at the bank (ADR-0080 / ADR-0083 amendment,
-- owner 2026-10-10).
--
-- billing_refunds.reserved: false = the refund took no money at creation (the synchronous model:
-- the ledger entry is written when the provider executed it, nothing is reserved while it is
-- pending — the only pending state left is an unknown outcome). Rows written before keep true
-- (reserved at creation, released when they fail).
--
-- billing_provider_issues: «Требует внимания» — refunds executed at the provider that the
-- reconciliation recorded on its own or could not record. A refund the bank executed is a fact:
-- it is deducted at once (reason bank_refund, status imported: informational, why the balance
-- moved); only a refund that cannot be recorded stays open for a superadmin:
--   currency_mismatch — not in the account's currency;
--   exceeds_payments  — more than the account's payments can still return.
-- One row per provider refund.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_refunds ADD COLUMN reserved boolean NOT NULL DEFAULT true;

CREATE TABLE billing_provider_issues (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id       uuid NOT NULL REFERENCES billing_accounts (id),
    payment_id       uuid REFERENCES billing_payments (id),
    provider         text NOT NULL,
    provider_ref     text NOT NULL CHECK (char_length(provider_ref) BETWEEN 1 AND 300),
    amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
    currency         text NOT NULL CHECK (char_length(currency) = 3),
    reason           text NOT NULL CHECK (reason IN ('bank_refund', 'currency_mismatch', 'exceeds_payments')),
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'imported', 'dismissed')),
    occurred_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    resolved_at      timestamptz,
    resolved_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    UNIQUE (provider, provider_ref),
    CONSTRAINT billing_provider_issues_resolved_check CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX billing_provider_issues_account_idx ON billing_provider_issues (account_id, id DESC);
CREATE INDEX billing_provider_issues_open_idx ON billing_provider_issues (id DESC) WHERE status = 'open';
CREATE INDEX billing_provider_issues_payment_idx ON billing_provider_issues (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX billing_provider_issues_resolved_by_idx ON billing_provider_issues (resolved_by) WHERE resolved_by IS NOT NULL;

-- +goose Down
DROP TABLE billing_provider_issues;
ALTER TABLE billing_refunds DROP COLUMN reserved;
