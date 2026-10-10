-- Billing: Tochka as the RU acquirer (ADR-0083).
--
--   * billing_provider_settings: the superadmin's «принимать новых клиентов» per provider. A
--     provider without a row accepts new clients (when configured by env). Closing one hides its
--     market from accounts not fixed by a payment yet; fixed accounts keep working on it.
--   * billing_checkouts.next_poll_at / polls: Tochka pushes only successful payments, so open
--     checkouts of such providers are polled with a backoff (expiry and failures arrive no other
--     way).
--   * billing_refunds.dispatched_at: a refund of a provider without idempotency keys is sent at
--     most once; the mark commits before the request, a lost answer is resolved by reading the
--     payment's operations, never by sending again.

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE billing_provider_settings (
    provider   text PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
    accept_new boolean NOT NULL,
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_provider_settings_updated_by_idx ON billing_provider_settings (updated_by) WHERE updated_by IS NOT NULL;

ALTER TABLE billing_checkouts ADD COLUMN next_poll_at timestamptz;
ALTER TABLE billing_checkouts ADD COLUMN polls integer NOT NULL DEFAULT 0 CHECK (polls >= 0);
CREATE INDEX billing_checkouts_poll_idx ON billing_checkouts (next_poll_at) WHERE status = 'open';

ALTER TABLE billing_refunds ADD COLUMN dispatched_at timestamptz;

-- +goose Down
ALTER TABLE billing_refunds DROP COLUMN IF EXISTS dispatched_at;
DROP INDEX IF EXISTS billing_checkouts_poll_idx;
ALTER TABLE billing_checkouts DROP COLUMN IF EXISTS polls;
ALTER TABLE billing_checkouts DROP COLUMN IF EXISTS next_poll_at;
DROP TABLE IF EXISTS billing_provider_settings;
