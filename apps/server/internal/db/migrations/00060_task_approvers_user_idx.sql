-- +goose NO TRANSACTION
-- Task-scoped board access (ADR-0059): GetBoardAccess and the task-scoped lists look up the
-- tasks a user approves by user_id in any state; task_approvers_pending_idx (00053) covers only
-- pending votes. CONCURRENTLY: task_approvers may be large on a busy workspace.

-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS task_approvers_user_idx ON task_approvers (user_id);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS task_approvers_user_idx;
