-- ADR-0082: the approval notice waits a per-board delay (an approver added by mistake and
-- removed within it is never notified).
--
-- boards.approval_notify_delay_seconds: how long after an approver is added (or their decided
-- vote is reset) the APPROVAL_REQUESTED notice goes out; 0 = immediately. Existing boards get
-- the default one minute.
-- task_approvers.notify_due_at: when the pending notice is due (NULL = none pending; rows that
-- existed before this migration were notified already). notify_reason: requested (became an
-- approver) | re_requested (the task changed and the decided vote was reset).

-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE boards ADD COLUMN approval_notify_delay_seconds integer NOT NULL DEFAULT 60
    CONSTRAINT boards_approval_notify_delay_check CHECK (approval_notify_delay_seconds IN (0, 60, 300, 900, 1800, 3600));
ALTER TABLE task_approvers
    ADD COLUMN notify_due_at timestamptz,
    ADD COLUMN notify_reason text NOT NULL DEFAULT 'requested'
        CONSTRAINT task_approvers_notify_reason_check CHECK (notify_reason IN ('requested', 're_requested'));
CREATE INDEX task_approvers_notify_due_idx ON task_approvers (notify_due_at) WHERE notify_due_at IS NOT NULL;

-- +goose Down
DROP INDEX task_approvers_notify_due_idx;
ALTER TABLE task_approvers DROP COLUMN notify_reason, DROP COLUMN notify_due_at;
ALTER TABLE boards DROP COLUMN approval_notify_delay_seconds;
