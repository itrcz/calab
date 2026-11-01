-- name: CreateUserReport :one
INSERT INTO user_reports (id, workspace_id, reporter_id, target_user_id, message_id, room_id, message_text, reason, comment)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: CountRecentReportsBy :one
SELECT count(*) FROM user_reports WHERE reporter_id = $1 AND created_at > $2;

-- name: ListWorkspaceReports :many
-- Newest first; before = the last id of the previous page (ids are uuidv7).
SELECT * FROM user_reports
WHERE workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: GetUserReport :one
SELECT * FROM user_reports WHERE id = $1 AND workspace_id = $2;

-- name: ResolveUserReport :one
UPDATE user_reports SET resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, sqlc.arg('resolved_by')::uuid)
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;
