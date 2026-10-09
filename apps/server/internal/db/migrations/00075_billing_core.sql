-- Billing core (T1, ADR-0080 §9): cancelled capacity of a seat lot and the schedule of stopped
-- accounts. Both tables are new and empty (00074), so the column defaults are metadata only.
--
-- billing_charges.canceled_qty / canceled_seat_us (seat-microseconds): seats of a lot given back before its end
-- (plan change, explicit cancellation of unused seat-days). The capacity of a lot at time t is
-- qty - canceled_qty; the compensation of a lot is the cumulative half-up share
-- amount × canceled_seat_us / (qty × lot microseconds), so several partial cancellations add up to
-- exactly what one cancellation of the same seat-time would return (ADR-0080 §9 «Возврат»).
--
-- billing_accounts_stopped_due_idx: a stopped account keeps its running lots until their end
-- (next_due_at = end of the coverage); the worker switches its plan to Free then.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE billing_charges
    ADD COLUMN canceled_qty integer NOT NULL DEFAULT 0,
    ADD COLUMN canceled_seat_us bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT billing_charges_canceled_check
        CHECK (canceled_qty BETWEEN 0 AND qty AND canceled_seat_us >= 0);

CREATE INDEX billing_accounts_stopped_due_idx ON billing_accounts (next_due_at) WHERE status = 'stopped';

-- +goose Down
SET LOCAL lock_timeout = '10s';
DROP INDEX billing_accounts_stopped_due_idx;
ALTER TABLE billing_charges DROP CONSTRAINT billing_charges_canceled_check,
    DROP COLUMN canceled_seat_us, DROP COLUMN canceled_qty;
