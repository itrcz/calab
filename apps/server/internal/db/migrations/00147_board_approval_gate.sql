-- Board approvals (CBF-156, ADR-0160): «Согласование держит переходы» of the board settings.
--
-- boards.approval_gate_off  false (the default) = ADR-0049 §2: a task waiting for approval or
--                           rejected does not move forward; true = the approval never holds a
--                           status change. MANAGE_BOARD writes it.

-- +goose Up
ALTER TABLE boards ADD COLUMN approval_gate_off boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE boards DROP COLUMN approval_gate_off;
