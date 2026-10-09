-- +goose NO TRANSACTION
-- ADR-0082: the approval notice waits a per-board delay (an approver added by mistake and
-- removed within it is never notified).
--
-- boards.approval_notify_delay_seconds: how long after an approver is added (or their decided
-- vote is reset) the APPROVAL_REQUESTED notice goes out; 0 = immediately. Existing boards get
-- the default one minute.
-- task_approvers.notify_due_at: when the pending notice is due (NULL = none pending; rows that
-- existed before this migration were notified already). notify_reason: requested (became an
-- approver) | re_requested (the task changed and the decided vote was reset).
--
-- Safe on a populated database (like 00060/00071): the columns have constant defaults (metadata
-- only on PG >= 11); the CHECK of task_approvers is added NOT VALID and validated without
-- blocking writes; the partial index is built CONCURRENTLY (hence NO TRANSACTION: every
-- statement is idempotent). lock_timeout makes the ALTERs fail fast instead of queueing every
-- read behind a long transaction. boards is small: its CHECK is checked inline.

-- +goose Up
SET lock_timeout = '10s';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS approval_notify_delay_seconds integer NOT NULL DEFAULT 60
    CONSTRAINT boards_approval_notify_delay_check CHECK (approval_notify_delay_seconds IN (0, 60, 300, 900, 1800, 3600));
ALTER TABLE task_approvers
    ADD COLUMN IF NOT EXISTS notify_due_at timestamptz,
    ADD COLUMN IF NOT EXISTS notify_reason text NOT NULL DEFAULT 'requested';

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_approvers_notify_reason_check') THEN
        ALTER TABLE task_approvers ADD CONSTRAINT task_approvers_notify_reason_check
            CHECK (notify_reason IN ('requested', 're_requested')) NOT VALID;
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE task_approvers VALIDATE CONSTRAINT task_approvers_notify_reason_check;
RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS task_approvers_notify_due_idx ON task_approvers (notify_due_at) WHERE notify_due_at IS NOT NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS task_approvers_notify_due_idx;
ALTER TABLE task_approvers DROP COLUMN IF EXISTS notify_reason, DROP COLUMN IF EXISTS notify_due_at;
ALTER TABLE boards DROP COLUMN IF EXISTS approval_notify_delay_seconds;
