-- +goose NO TRANSACTION
-- Milestones inside a task (ADR-0063).
--
-- task_milestones          stages of one task with a target date (≤ 20 per task, enforced by
--                          the server); completed_at is toggled by people while no subtask is
--                          linked, else maintained by the server (all linked subtasks done).
-- tasks.task_milestone_id  a subtask's milestone: one of its parent's (checked by the server,
--                          reset when the parent changes); SET NULL when the milestone goes.
--
-- Safe on a populated database: tasks only gets a nullable column without a default (metadata
-- only); its foreign key is added NOT VALID and validated without blocking writes; its index is
-- built CONCURRENTLY (hence NO TRANSACTION: every statement is idempotent). lock_timeout makes
-- the ALTERs fail fast instead of queueing every task read behind a long transaction.

-- +goose Up
SET lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS task_milestones (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    task_id      uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    due_on       date,
    position     double precision NOT NULL DEFAULT 0,
    completed_at timestamptz,
    completed_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (completed_at IS NOT NULL OR completed_by IS NULL)
);
CREATE INDEX IF NOT EXISTS task_milestones_task_idx ON task_milestones (task_id, position);
CREATE INDEX IF NOT EXISTS task_milestones_completed_by_idx ON task_milestones (completed_by) WHERE completed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_milestones_created_by_idx ON task_milestones (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_milestone_id uuid;

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_task_milestone_id_fkey') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_task_milestone_id_fkey FOREIGN KEY (task_milestone_id)
            REFERENCES task_milestones (id) ON DELETE SET NULL NOT VALID;
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE tasks VALIDATE CONSTRAINT tasks_task_milestone_id_fkey;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_task_milestone_idx ON tasks (task_milestone_id) WHERE task_milestone_id IS NOT NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS tasks_task_milestone_idx;
ALTER TABLE tasks DROP COLUMN IF EXISTS task_milestone_id;
DROP TABLE IF EXISTS task_milestones;
