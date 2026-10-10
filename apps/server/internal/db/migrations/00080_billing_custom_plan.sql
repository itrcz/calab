-- Custom plan of a billing account (ADR-0086 «Индивидуальный тариф», 2026-10-10): a superadmin gives
-- a workspace its own limits, its own price per seat per day in the account currency and a name
-- members see instead of «Индивидуальный».
--
--   * billing_accounts / billing_charges: plan 'custom' next to team / enterprise; seat lots of the
--     custom plan reference the account's own price version.
--   * billing_prices: account_id NOT NULL = a price version of that account only (sku
--     seat.custom.day, plan custom); NULL = the catalog of the market as before. Still append-only:
--     a new price is a new row from effective_from (never in the past), so bought seat-days are
--     never repriced. The catalog keeps one version per (market, sku, effective_from). For an
--     account the newest row whose effective_from has come applies (a new version replaces what
--     was scheduled after its start), so its index is not unique.
--   * workspace_plans / workspace_plan_log: display_name (<= 40) and description (<= 140) of a
--     custom plan (manual or billing); empty = the localized «Индивидуальный». The log versions them.
--
-- billing_accounts, billing_charges and billing_prices are small (billing is weeks old), so the
-- re-validated CHECKs are cheap; workspace_plans / workspace_plan_log get columns with constant
-- defaults (metadata only).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_accounts DROP CONSTRAINT billing_accounts_plan_check,
    ADD CONSTRAINT billing_accounts_plan_check CHECK (plan IN ('team', 'enterprise', 'custom'));

ALTER TABLE billing_charges DROP CONSTRAINT billing_charges_plan_check,
    ADD CONSTRAINT billing_charges_plan_check CHECK (plan IN ('team', 'enterprise', 'custom'));

ALTER TABLE billing_prices ADD COLUMN account_id uuid REFERENCES billing_accounts (id);
ALTER TABLE billing_prices DROP CONSTRAINT billing_prices_plan_check,
    ADD CONSTRAINT billing_prices_plan_check CHECK (plan IN ('team', 'enterprise', 'custom')),
    ADD CONSTRAINT billing_prices_custom_check
        CHECK ((plan IS NOT DISTINCT FROM 'custom') = (account_id IS NOT NULL)),
    DROP CONSTRAINT billing_prices_market_sku_effective_from_key;
CREATE UNIQUE INDEX billing_prices_catalog_idx ON billing_prices (market, sku, effective_from)
    WHERE account_id IS NULL;
-- Also the index of the foreign key.
CREATE INDEX billing_prices_account_idx ON billing_prices (account_id, effective_from)
    WHERE account_id IS NOT NULL;

ALTER TABLE workspace_plans
    ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 40),
    ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 140);
ALTER TABLE workspace_plan_log
    ADD COLUMN display_name text NOT NULL DEFAULT '',
    ADD COLUMN description text NOT NULL DEFAULT '';

-- +goose Down
-- Fails while custom rows exist (billing_prices is append-only): a custom plan is money history.
SET LOCAL lock_timeout = '10s';
ALTER TABLE workspace_plan_log DROP COLUMN description, DROP COLUMN display_name;
ALTER TABLE workspace_plans DROP COLUMN description, DROP COLUMN display_name;
DROP INDEX billing_prices_account_idx;
DROP INDEX billing_prices_catalog_idx;
ALTER TABLE billing_prices DROP CONSTRAINT billing_prices_custom_check,
    DROP CONSTRAINT billing_prices_plan_check,
    ADD CONSTRAINT billing_prices_plan_check CHECK (plan IN ('team', 'enterprise')),
    ADD CONSTRAINT billing_prices_market_sku_effective_from_key UNIQUE (market, sku, effective_from);
ALTER TABLE billing_prices DROP COLUMN account_id;
ALTER TABLE billing_charges DROP CONSTRAINT billing_charges_plan_check,
    ADD CONSTRAINT billing_charges_plan_check CHECK (plan IN ('team', 'enterprise'));
ALTER TABLE billing_accounts DROP CONSTRAINT billing_accounts_plan_check,
    ADD CONSTRAINT billing_accounts_plan_check CHECK (plan IN ('team', 'enterprise'));
