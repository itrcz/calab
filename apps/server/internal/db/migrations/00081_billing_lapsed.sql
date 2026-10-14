-- Billing: «тариф не активен» (ADR-0086 amendment, owner 2026-10-10). A stopped account whose
-- paid days ran out while the workspace uses more than Free allows does not drop to Free: it
-- stays stopped with lapsed_at set, and the workspace runs in the restricted mode (no writing,
-- voice for two, no video) until the owner pays or moves to Free once the usage fits.
-- lapsed_at is only ever set on a stopped account; every other status clears it.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_accounts ADD COLUMN lapsed_at timestamptz;
ALTER TABLE billing_accounts ADD CONSTRAINT billing_accounts_lapsed_check
    CHECK (lapsed_at IS NULL OR status = 'stopped');

-- +goose Down
ALTER TABLE billing_accounts DROP CONSTRAINT billing_accounts_lapsed_check;
ALTER TABLE billing_accounts DROP COLUMN lapsed_at;
