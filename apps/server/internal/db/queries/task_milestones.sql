-- ADR-0063: milestones inside a task; subtasks link to one of their parent's.

-- name: ListTaskMilestones :many
SELECT * FROM task_milestones WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[]) ORDER BY task_id, position, id;

-- name: LockTaskMilestones :many
-- The milestones of these tasks, locked in id order (syncMilestones): two subtasks completed at
-- once serialize here, so the second one counts the first one's status.
SELECT * FROM task_milestones WHERE task_id = ANY(sqlc.arg('task_ids')::uuid[]) ORDER BY id FOR NO KEY UPDATE;

-- name: ListMilestoneLinks :many
-- Live subtasks of these tasks linked to one of their parent's milestones, with the status type
-- (the milestones' progress is computed by internal/boards: MilestoneProgress).
SELECT s.task_milestone_id::uuid AS milestone_id, st.type AS status_type
FROM tasks s
JOIN task_milestones m ON m.id = s.task_milestone_id AND m.task_id = s.parent_id
JOIN board_statuses st ON st.id = s.status_id
WHERE s.parent_id = ANY(sqlc.arg('task_ids')::uuid[]) AND s.archived_at IS NULL;

-- name: GetTaskMilestone :one
SELECT * FROM task_milestones WHERE id = $1;

-- name: GetTaskMilestoneForUpdate :one
SELECT * FROM task_milestones WHERE id = $1 FOR UPDATE;

-- name: GetTaskMilestoneWorkspace :one
-- The workspace of a task milestone (identity route resolution).
SELECT b.workspace_id FROM task_milestones m
JOIN tasks t ON t.id = m.task_id JOIN boards b ON b.id = t.board_id
WHERE m.id = $1;

-- name: CountTaskMilestones :one
SELECT count(*)::integer FROM task_milestones WHERE task_id = $1;

-- name: CreateTaskMilestone :one
-- position NULL = last. Lock the task row first: count limit, positions.
INSERT INTO task_milestones (task_id, name, due_on, position, created_by)
VALUES (sqlc.arg('task_id'), sqlc.arg('name'), sqlc.narg('due_on'),
        coalesce(sqlc.narg('position')::double precision,
                 (SELECT coalesce(max(position) + 1, 0) FROM task_milestones WHERE task_id = sqlc.arg('task_id'))),
        sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateTaskMilestone :one
-- NULL name / position keep the value; set_due replaces due_on (NULL clears it).
UPDATE task_milestones SET
    name = coalesce(sqlc.narg('name'), name),
    due_on = CASE WHEN sqlc.arg('set_due')::boolean THEN sqlc.narg('due_on')::date ELSE due_on END,
    position = coalesce(sqlc.narg('position'), position),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetTaskMilestoneCompleted :one
-- A person's toggle (no linked subtasks).
UPDATE task_milestones SET
    completed_at = CASE WHEN sqlc.arg('completed')::boolean THEN coalesce(completed_at, now()) END,
    completed_by = CASE WHEN sqlc.arg('completed')::boolean THEN coalesce(completed_by, sqlc.narg('actor_id')) END,
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeleteTaskMilestone :execrows
DELETE FROM task_milestones WHERE id = $1;

-- name: SetTaskMilestoneAuto :exec
-- The server's completion (ADR-0063 §2): all linked subtasks done, or not any more.
UPDATE task_milestones SET
    completed_at = CASE WHEN sqlc.arg('completed')::boolean THEN now() END,
    completed_by = CASE WHEN sqlc.arg('completed')::boolean THEN sqlc.narg('actor_id')::uuid END,
    updated_at = now()
WHERE id = sqlc.arg('id');

-- name: UnlinkMilestoneSubtasks :many
-- Before a milestone is deleted: its subtasks lose the link (they get TASK_UPDATE).
UPDATE tasks SET task_milestone_id = NULL, updated_at = now() WHERE task_milestone_id = $1 RETURNING id;

-- name: ParentsOfTasks :many
-- The parents of these tasks (candidates for the milestones' auto completion).
SELECT DISTINCT parent_id::uuid FROM tasks WHERE id = ANY(sqlc.arg('task_ids')::uuid[]) AND parent_id IS NOT NULL;
