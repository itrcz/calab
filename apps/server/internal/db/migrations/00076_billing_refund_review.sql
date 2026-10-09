-- Billing: a Calab refund whose outcome stayed unknown past the provider's idempotency window
-- (ADR-0080 §11, review 2026-10-09). After 23 h since the refund row was written the refund is
-- never POSTed again (an expired Idempotency-Key could refund twice); reconciliation lists the
-- payment's refunds and matches metadata calab_refund_id instead. Nothing found after 24 h:
-- needs_review_at is set, the reservation stays, a superadmin resolves it (reconcile with
-- release_refund_ids, or a refund made by hand in the provider dashboard is matched to it).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_refunds ADD COLUMN needs_review_at timestamptz;

CREATE INDEX billing_refunds_needs_review_idx ON billing_refunds (needs_review_at)
    WHERE needs_review_at IS NOT NULL AND status IN ('pending', 'requires_action');

-- +goose Down
DROP INDEX IF EXISTS billing_refunds_needs_review_idx;
ALTER TABLE billing_refunds DROP COLUMN IF EXISTS needs_review_at;
