-- +goose NO TRANSACTION
-- Task notification triggers (ADR-0089).
--
-- users.task_notify_off  the task notification kinds the user switched off (notifications.TaskKind
--                        names); '{}' = everything on, so kinds added later are on by themselves.
--                        Never holds the mandatory approval kinds (the server drops them).
-- task_due_notices       dedup of the due sweep: one DUE_SOON for «tomorrow» and one for «today»,
--                        one OVERDUE per task, recipient and due date. A new due date gets new
--                        rows; the old ones go when the date changes, the task is finished or
--                        archived, and after 30 days.
--
-- Safe on a populated database: users gets a column with a constant default (metadata only);
-- the index of tasks by due date is built CONCURRENTLY (hence NO TRANSACTION: every statement
-- is idempotent).

-- +goose Up
SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS task_notify_off text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS task_due_notices (
    task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind    text NOT NULL CHECK (kind IN ('due_tomorrow', 'due_today', 'overdue')),
    due_on  date NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, kind, due_on, user_id)
);
CREATE INDEX IF NOT EXISTS task_due_notices_user_idx ON task_due_notices (user_id);
CREATE INDEX IF NOT EXISTS task_due_notices_sent_idx ON task_due_notices (sent_at);

RESET lock_timeout;

-- The due sweep: live tasks by due date.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_due_on_idx ON tasks (due_on) WHERE archived_at IS NULL AND due_on IS NOT NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS tasks_due_on_idx;
DROP TABLE IF EXISTS task_due_notices;
ALTER TABLE users DROP COLUMN IF EXISTS task_notify_off;
