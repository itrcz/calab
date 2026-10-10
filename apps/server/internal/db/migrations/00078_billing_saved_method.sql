-- Billing: charges of a saved card (ADR-0083 phase 2).
--
--   * billing_autotopup_attempts becomes the one queue of charges of a saved card: kind 'auto'
--     (the auto-topup job, as before) or 'manual' (the owner's one-click top-up). The partial
--     UNIQUE index keeps one charge in flight per account whatever its kind, which is what makes
--     a provider without idempotency keys (Tochka) safe: a charge is attributed by reading the
--     subscription's operations, never by a key.
--   * manual charges carry the owner's request_id + body hash (a retry returns the same charge)
--     and the user who asked; a Stripe one-click charge may wait for 3-D Secure
--     ('requires_action', the provider's confirmation URL in action_url).
--   * order_snapshot: the operations (Tochka Order[] ids) the card's subscription had before the
--     charge was sent; the charge is the new approval that appears after it.
--   * billing_payments.origin 'saved_method': a manual top-up charged in one click.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_autotopup_attempts ADD COLUMN kind text NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto', 'manual'));
ALTER TABLE billing_autotopup_attempts ADD COLUMN request_id uuid;
ALTER TABLE billing_autotopup_attempts ADD COLUMN body_hash bytea;
ALTER TABLE billing_autotopup_attempts ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE billing_autotopup_attempts ADD COLUMN action_url text NOT NULL DEFAULT '';
ALTER TABLE billing_autotopup_attempts ADD COLUMN order_snapshot text[];
ALTER TABLE billing_autotopup_attempts ADD CONSTRAINT billing_autotopup_attempts_manual_check
    CHECK ((kind = 'manual') = (request_id IS NOT NULL AND body_hash IS NOT NULL));
CREATE UNIQUE INDEX billing_autotopup_attempts_request_idx ON billing_autotopup_attempts (account_id, request_id)
    WHERE request_id IS NOT NULL;
CREATE INDEX billing_autotopup_attempts_created_by_idx ON billing_autotopup_attempts (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE billing_autotopup_attempts DROP CONSTRAINT billing_autotopup_attempts_status_check;
ALTER TABLE billing_autotopup_attempts ADD CONSTRAINT billing_autotopup_attempts_status_check
    CHECK (status IN ('prepared', 'dispatched', 'requires_action', 'succeeded', 'failed', 'unknown'));
DROP INDEX billing_autotopup_attempts_one_open_idx;
CREATE UNIQUE INDEX billing_autotopup_attempts_one_open_idx ON billing_autotopup_attempts (account_id)
    WHERE status IN ('prepared', 'dispatched', 'requires_action', 'unknown');

ALTER TABLE billing_payments DROP CONSTRAINT billing_payments_origin_check;
ALTER TABLE billing_payments ADD CONSTRAINT billing_payments_origin_check
    CHECK (origin IN ('checkout', 'auto_topup', 'saved_method', 'import'));
ALTER TABLE billing_payments DROP CONSTRAINT billing_payments_origin_refs_check;
ALTER TABLE billing_payments ADD CONSTRAINT billing_payments_origin_refs_check CHECK (
    (origin = 'checkout' AND attempt_id IS NULL) OR
    (origin IN ('auto_topup', 'saved_method') AND checkout_id IS NULL AND attempt_id IS NOT NULL) OR
    (origin = 'import' AND attempt_id IS NULL));

-- +goose Down
ALTER TABLE billing_payments DROP CONSTRAINT billing_payments_origin_refs_check;
UPDATE billing_payments SET origin = 'auto_topup' WHERE origin = 'saved_method';
ALTER TABLE billing_payments ADD CONSTRAINT billing_payments_origin_refs_check CHECK (
    (origin = 'checkout' AND attempt_id IS NULL) OR
    (origin = 'auto_topup' AND checkout_id IS NULL AND attempt_id IS NOT NULL) OR
    (origin = 'import' AND attempt_id IS NULL));
ALTER TABLE billing_payments DROP CONSTRAINT billing_payments_origin_check;
ALTER TABLE billing_payments ADD CONSTRAINT billing_payments_origin_check CHECK (origin IN ('checkout', 'auto_topup', 'import'));

UPDATE billing_autotopup_attempts SET status = 'failed', failure_code = 'authentication_required', finished_at = now()
WHERE status = 'requires_action';
DROP INDEX billing_autotopup_attempts_one_open_idx;
CREATE UNIQUE INDEX billing_autotopup_attempts_one_open_idx ON billing_autotopup_attempts (account_id)
    WHERE status IN ('prepared', 'dispatched', 'unknown');
ALTER TABLE billing_autotopup_attempts DROP CONSTRAINT billing_autotopup_attempts_status_check;
ALTER TABLE billing_autotopup_attempts ADD CONSTRAINT billing_autotopup_attempts_status_check
    CHECK (status IN ('prepared', 'dispatched', 'succeeded', 'failed', 'unknown'));
DROP INDEX IF EXISTS billing_autotopup_attempts_created_by_idx;
DROP INDEX IF EXISTS billing_autotopup_attempts_request_idx;
ALTER TABLE billing_autotopup_attempts DROP CONSTRAINT billing_autotopup_attempts_manual_check;
ALTER TABLE billing_autotopup_attempts DROP COLUMN order_snapshot;
ALTER TABLE billing_autotopup_attempts DROP COLUMN action_url;
ALTER TABLE billing_autotopup_attempts DROP COLUMN created_by;
ALTER TABLE billing_autotopup_attempts DROP COLUMN body_hash;
ALTER TABLE billing_autotopup_attempts DROP COLUMN request_id;
ALTER TABLE billing_autotopup_attempts DROP COLUMN kind;
