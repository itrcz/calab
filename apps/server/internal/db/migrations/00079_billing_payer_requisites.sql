-- Billing: country requisites of the payer (ADR-0080 §0.1).
--
--   * billing_payers.type gains 'sole_proprietor' (RU / KZ / BY ИП).
--   * billing_payers.requisites: field key → normalized value of the country schema
--     (internal/billing/payer); tax_id stays the primary tax number, copied from it.
--   * billing_payer_versions: every saved payer, append-only (ADR-0080 §6.4). billing_payers is
--     the current one and names its version; checkouts keep their own payer_snapshot (with the
--     version), so editing the payer never rewrites what a payment was made under.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_payers DROP CONSTRAINT billing_payers_type_check;
ALTER TABLE billing_payers ADD CONSTRAINT billing_payers_type_check
    CHECK (type IN ('person', 'company', 'sole_proprietor'));
ALTER TABLE billing_payers ADD COLUMN requisites jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(requisites) = 'object');
ALTER TABLE billing_payers ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE billing_payer_versions (
    account_id uuid NOT NULL REFERENCES billing_accounts (id),
    version    integer NOT NULL CHECK (version > 0),
    type       text NOT NULL CHECK (type IN ('person', 'company', 'sole_proprietor')),
    name       text NOT NULL,
    country    text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    email      text NOT NULL,
    tax_id     text,
    requisites jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(requisites) = 'object'),
    created_by uuid,                          -- append-only: no FK
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, version)
);
CREATE TRIGGER billing_payer_versions_append_only BEFORE UPDATE OR DELETE ON billing_payer_versions
    FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER billing_payer_versions_no_truncate BEFORE TRUNCATE ON billing_payer_versions
    FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- The payers saved so far become version 1.
INSERT INTO billing_payer_versions (account_id, version, type, name, country, email, tax_id, created_by, created_at)
SELECT account_id, 1, type, name, country, email, tax_id, updated_by, updated_at FROM billing_payers;

-- +goose Down
SET LOCAL lock_timeout = '10s';

DROP TABLE billing_payer_versions;
ALTER TABLE billing_payers DROP COLUMN version;
ALTER TABLE billing_payers DROP COLUMN requisites;
UPDATE billing_payers SET type = 'company' WHERE type = 'sole_proprietor';
ALTER TABLE billing_payers DROP CONSTRAINT billing_payers_type_check;
ALTER TABLE billing_payers ADD CONSTRAINT billing_payers_type_check CHECK (type IN ('person', 'company'));
