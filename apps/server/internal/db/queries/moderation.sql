-- name: SetWorkspaceSuspension :one
-- Suspends (at = now) or resumes (at NULL) a workspace; the reason / actor are cleared on resume.
UPDATE workspaces
SET suspended_at     = sqlc.narg('suspended_at'),
    suspended_reason = sqlc.arg('reason'),
    suspended_by     = sqlc.narg('suspended_by')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: InsertAdminLog :exec
INSERT INTO workspace_admin_log (workspace_id, actor_id, action, reason)
VALUES ($1, $2, $3, $4);

-- name: WorkspaceSuspended :one
-- Whether a workspace is suspended (false for an unknown id).
SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1 AND suspended_at IS NOT NULL)::boolean;

-- name: MessageWorkspaceSuspended :one
-- Whether the workspace of a message's room is suspended (false for DMs / unknown ids).
SELECT EXISTS (
    SELECT 1 FROM messages m
    JOIN rooms r ON r.id = m.room_id
    JOIN workspaces w ON w.id = r.workspace_id
    WHERE m.id = $1 AND w.suspended_at IS NOT NULL
)::boolean;

-- name: InviteWorkspaceSuspended :one
-- Whether the workspace of an invite code is suspended (false for unknown codes).
SELECT EXISTS (
    SELECT 1 FROM workspace_invites i
    JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.code = $1 AND w.suspended_at IS NOT NULL
)::boolean;

-- name: IsBanned :one
-- Whether a user (or, if given, their address) is banned from a workspace.
SELECT EXISTS (
    SELECT 1 FROM workspace_bans b
    WHERE b.workspace_id = sqlc.arg('workspace_id')
      AND (b.user_id = sqlc.arg('user_id')
           OR (sqlc.narg('email')::citext IS NOT NULL AND b.email = sqlc.narg('email')::citext))
)::boolean;

-- name: CreateBan :one
INSERT INTO workspace_bans (workspace_id, user_id, email, reason, banned_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (workspace_id, user_id) DO UPDATE
SET email = EXCLUDED.email, reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, created_at = now()
RETURNING *;

-- name: DeleteBan :execrows
DELETE FROM workspace_bans WHERE workspace_id = $1 AND user_id = $2;

-- name: ListBans :many
SELECT sqlc.embed(b), sqlc.embed(u)
FROM workspace_bans b
JOIN users u ON u.id = b.user_id
WHERE b.workspace_id = $1
ORDER BY b.created_at DESC, b.user_id;

-- name: DeletePendingEmailInvitesFor :exec
-- Revokes the pending email invitations of an address in a workspace (their links go with them).
DELETE FROM workspace_invites i
USING email_invites e
WHERE e.invite_id = i.id AND e.workspace_id = $1 AND e.email = $2 AND e.accepted_at IS NULL;

-- name: SetWorkspaceUploadLimits :one
-- The superadmin's upload limits of a workspace (ADR-0155); NULL = the server default.
UPDATE workspaces
SET upload_burst    = sqlc.narg('burst'),
    upload_per_hour = sqlc.narg('per_hour'),
    max_file_mb     = sqlc.narg('max_file_mb')
WHERE id = sqlc.arg('id')
RETURNING *;
