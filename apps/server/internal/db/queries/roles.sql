-- Workspace roles (ADR-0026).

-- name: LockWorkspaceRoles :exec
-- Serializes role mutations of one workspace (count limit, positions, member role sets).
SELECT pg_advisory_xact_lock(hashtext('calaba.roles:' || sqlc.arg('workspace_id')::text));

-- name: ListWorkspaceRoles :many
SELECT * FROM workspace_roles WHERE workspace_id = $1 ORDER BY position DESC;

-- name: GetWorkspaceRole :one
SELECT * FROM workspace_roles WHERE id = $1 AND workspace_id = $2;

-- name: GetBuiltinRole :one
SELECT * FROM workspace_roles WHERE workspace_id = $1 AND builtin = $2;

-- name: CountWorkspaceRoles :one
SELECT count(*)::integer FROM workspace_roles WHERE workspace_id = $1;

-- name: ShiftCustomRolesUp :many
-- Makes room for a new custom role at position 2 (the bottom of the custom roles).
UPDATE workspace_roles SET position = position + 1
WHERE workspace_id = $1 AND builtin IS NULL
RETURNING *;

-- name: CreateRole :one
INSERT INTO workspace_roles (workspace_id, name, color, position, permissions, mentionable)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: UpdateRole :one
UPDATE workspace_roles SET
    name        = coalesce(sqlc.narg('name'), name),
    color       = coalesce(sqlc.narg('color'), color),
    permissions = coalesce(sqlc.narg('permissions'), permissions),
    mentionable = coalesce(sqlc.narg('mentionable'), mentionable)
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: SetRolePosition :one
UPDATE workspace_roles SET position = $3 WHERE id = $1 AND workspace_id = $2 RETURNING *;

-- name: DeleteRole :execrows
DELETE FROM workspace_roles WHERE id = $1 AND workspace_id = $2 AND builtin IS NULL;

-- name: DeleteRoleOverrides :many
-- The deleted role's room and board overrides; returns the affected rooms.
WITH boards_gone AS (
    DELETE FROM board_permissions WHERE target_type = 'role' AND target_id = sqlc.arg('role_id')::text
)
DELETE FROM room_permissions WHERE target_type = 'role' AND target_id = sqlc.arg('role_id')::text
RETURNING room_id;

-- name: ListMemberRoleIDs :many
SELECT mr.role_id FROM member_roles mr
JOIN workspace_roles wr ON wr.id = mr.role_id
WHERE mr.workspace_id = $1 AND mr.user_id = $2
ORDER BY wr.position DESC;

-- name: AddMemberRole :exec
INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: RemoveMemberRole :exec
DELETE FROM member_roles WHERE workspace_id = $1 AND user_id = $2 AND role_id = $3;

-- name: ListWorkspaceMemberRoles :many
-- Every member's built-in role and role ids (highest first) and whether it is a bot: the
-- gateway's workspace state and guest visibility.
SELECT m.user_id, m.role,
       coalesce((SELECT array_agg(mr.role_id ORDER BY wr.position DESC)
                 FROM member_roles mr JOIN workspace_roles wr ON wr.id = mr.role_id
                 WHERE mr.workspace_id = m.workspace_id AND mr.user_id = m.user_id), '{}')::uuid[] AS role_ids,
       u.is_bot
FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1;

-- name: GetMemberAccess :one
-- A member's built-in role and roles (lowest position first) for perm.Resolver.
SELECT m.role,
       coalesce(r.ids, '{}')::uuid[] AS role_ids,
       coalesce(r.positions, '{}')::integer[] AS role_positions,
       coalesce(r.perms, '{}')::bigint[] AS role_permissions
FROM workspace_members m
LEFT JOIN LATERAL (
    SELECT array_agg(wr.id ORDER BY wr.position) AS ids,
           array_agg(wr.position ORDER BY wr.position) AS positions,
           array_agg(wr.permissions ORDER BY wr.position) AS perms
    FROM member_roles mr JOIN workspace_roles wr ON wr.id = mr.role_id
    WHERE mr.workspace_id = m.workspace_id AND mr.user_id = m.user_id
) r ON true
WHERE m.workspace_id = sqlc.arg('workspace_id') AND m.user_id = sqlc.arg('user_id');
