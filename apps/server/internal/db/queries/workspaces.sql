-- name: CreateWorkspace :one
INSERT INTO workspaces (slug, name, visibility, owner_id, storage_quota_bytes)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: CountOwnedWorkspaces :one
SELECT count(*)::integer FROM workspaces WHERE owner_id = $1;

-- name: LockUserWorkspaces :exec
-- Serializes workspace creation per user (limit check + insert).
SELECT pg_advisory_xact_lock(hashtext('calaba.ws.create:' || sqlc.arg('user_id')::text));

-- name: GetWorkspace :one
SELECT * FROM workspaces WHERE id = $1;

-- name: ListUserWorkspaces :many
SELECT w.* FROM workspaces w
JOIN workspace_members m ON m.workspace_id = w.id
WHERE m.user_id = $1
ORDER BY m.joined_at;

-- name: ListOpenWorkspacesForUser :many
SELECT w.* FROM workspaces w
WHERE w.visibility = 'open'
  AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = $1)
ORDER BY w.name
LIMIT 200;

-- name: UpdateWorkspace :one
UPDATE workspaces SET
    slug                       = coalesce(sqlc.narg('slug'), slug),
    name                       = coalesce(sqlc.narg('name'), name),
    visibility                 = coalesce(sqlc.narg('visibility'), visibility),
    icon_file_id               = CASE WHEN sqlc.arg('set_icon')::boolean THEN sqlc.narg('icon_file_id')::uuid ELSE icon_file_id END,
    default_audio_bitrate_kbps = coalesce(sqlc.narg('default_audio_bitrate_kbps'), default_audio_bitrate_kbps),
    default_max_stream_preset  = coalesce(sqlc.narg('default_max_stream_preset'), default_max_stream_preset),
    default_max_streams        = coalesce(sqlc.narg('default_max_streams'), default_max_streams),
    default_camera_limit       = coalesce(sqlc.narg('default_camera_limit'), default_camera_limit),
    allow_self_nickname        = coalesce(sqlc.narg('allow_self_nickname'), allow_self_nickname),
    time_format                = coalesce(sqlc.narg('time_format'), time_format)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeleteWorkspace :execrows
DELETE FROM workspaces WHERE id = $1;

-- name: AddMember :one
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (workspace_id, user_id) DO NOTHING
RETURNING *;

-- name: GetMember :one
SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2;

-- name: GetMemberWithUser :one
SELECT sqlc.embed(m), sqlc.embed(u),
       coalesce((SELECT array_agg(mr.role_id ORDER BY wr.position DESC)
                 FROM member_roles mr JOIN workspace_roles wr ON wr.id = mr.role_id
                 WHERE mr.workspace_id = m.workspace_id AND mr.user_id = m.user_id), '{}')::uuid[] AS role_ids
FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND m.user_id = $2;

-- name: ListMembers :many
SELECT sqlc.embed(m), sqlc.embed(u),
       coalesce((SELECT array_agg(mr.role_id ORDER BY wr.position DESC)
                 FROM member_roles mr JOIN workspace_roles wr ON wr.id = mr.role_id
                 WHERE mr.workspace_id = m.workspace_id AND mr.user_id = m.user_id), '{}')::uuid[] AS role_ids
FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1
ORDER BY m.joined_at;

-- name: UpdateMember :one
UPDATE workspace_members SET
    role     = coalesce(sqlc.narg('role'), role),
    nickname = coalesce(sqlc.narg('nickname'), nickname)
WHERE workspace_id = sqlc.arg('workspace_id') AND user_id = sqlc.arg('user_id')
RETURNING *;

-- name: RemoveMember :execrows
DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2;

-- name: DeleteUserOverridesInWorkspace :exec
-- A member leaves: their room overrides and board overrides (ADR-0042) go.
WITH boards_gone AS (
    DELETE FROM board_permissions bp USING boards bb
    WHERE bp.board_id = bb.id AND bb.workspace_id = sqlc.arg('workspace_id')::uuid
      AND bp.target_type = 'user' AND bp.target_id = sqlc.arg('user_id')::text
)
DELETE FROM room_permissions rp
USING rooms r
WHERE rp.room_id = r.id AND r.workspace_id = sqlc.arg('workspace_id')::uuid
  AND rp.target_type = 'user' AND rp.target_id = sqlc.arg('user_id')::text;

-- name: ListUserWorkspaceIDs :many
SELECT workspace_id FROM workspace_members WHERE user_id = $1;

-- name: ListMemberNames :many
-- Voice display names: nickname if set, else the user's display name.
SELECT m.user_id, CASE WHEN m.nickname <> '' THEN m.nickname ELSE u.display_name END AS name
FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND m.user_id = ANY(sqlc.arg('user_ids')::uuid[]);
