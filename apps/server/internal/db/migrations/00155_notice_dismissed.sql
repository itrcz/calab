-- The inbox ✕ on a task notice (CBF-155) now hides the history row instead of deleting it, so
-- «Недавние» (CBF-179), which lists the latest notice of each task, keeps agreeing with the live
-- list after a reload. GET /api/me/task-notices skips dismissed rows; the ✕ on a «Недавние» row
-- deletes the task's rows.

-- +goose Up
ALTER TABLE task_notice_log ADD COLUMN dismissed boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE task_notice_log DROP COLUMN dismissed;
