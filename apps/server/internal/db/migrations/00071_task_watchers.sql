-- Task watchers (ADR-0076): an explicit role on a task. A watcher is always a subscriber and,
-- like an assignee or an approver, opens the task to a member who does not see the board
-- (task-scoped access, ADR-0059). A plain subscription (author, self, mention without the right
-- to edit) stays watcher = false and gives no access.
-- task_subscribers_watcher_idx: the invited EXISTS of GetBoardAccess / ListInvitedTasks by user.

-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE task_subscribers ADD COLUMN watcher boolean NOT NULL DEFAULT false;
CREATE INDEX task_subscribers_watcher_idx ON task_subscribers (user_id) WHERE watcher;

-- +goose Down
DROP INDEX IF EXISTS task_subscribers_watcher_idx;
ALTER TABLE task_subscribers DROP COLUMN watcher;
