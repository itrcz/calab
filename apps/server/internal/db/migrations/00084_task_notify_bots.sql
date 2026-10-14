-- +goose NO TRANSACTION
-- Task notice relay to bots (ADR-0090).
--
-- users.task_notify_bots  the bots (user ids) that get the user's task notices as TASK_NOTICE
--                         (≤ 10, checked by PATCH /api/me). No foreign key (an array): a bot
--                         deleted since is removed by the bot deletion, and every send checks
--                         that the bot still exists, is a member of the task's workspace and is
--                         not blocked by the user — a stale id never delivers anything.
--
-- Safe on a populated database: a column with a constant default (metadata only); the partial
-- index of the users with a relay (the bots' cache lists them) is built CONCURRENTLY (hence NO
-- TRANSACTION: every statement is idempotent).

-- +goose Up
SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS task_notify_bots uuid[] NOT NULL DEFAULT '{}';

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS users_task_notify_bots_idx ON users (id) WHERE task_notify_bots <> '{}';

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS users_task_notify_bots_idx;
ALTER TABLE users DROP COLUMN IF EXISTS task_notify_bots;
