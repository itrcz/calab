-- +goose NO TRANSACTION
-- Task watchers (ADR-0076): an explicit role on a task. A watcher is always a subscriber and,
-- like an assignee or an approver, opens the task to a member who does not see the board
-- (task-scoped access, ADR-0059). A plain subscription (author, self, mention without the right
-- to edit) stays watcher = false and gives no access.
-- task_subscribers_watcher_idx: the invited EXISTS of GetBoardAccess / ListInvitedTasks by user.
--
-- Safe on a populated database: the column has a constant default (metadata only on PG ≥ 11);
-- the index is built CONCURRENTLY (hence NO TRANSACTION: every statement is idempotent), so
-- task_subscribers stays readable and writable meanwhile. lock_timeout makes the ALTER fail
-- fast instead of queueing every subscriber read behind a long transaction.

-- +goose Up
SET lock_timeout = '10s';
ALTER TABLE task_subscribers ADD COLUMN IF NOT EXISTS watcher boolean NOT NULL DEFAULT false;
RESET lock_timeout;
CREATE INDEX CONCURRENTLY IF NOT EXISTS task_subscribers_watcher_idx ON task_subscribers (user_id) WHERE watcher;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS task_subscribers_watcher_idx;
ALTER TABLE task_subscribers DROP COLUMN IF EXISTS watcher;
