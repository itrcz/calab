-- name: CreateInvite :one
INSERT INTO workspace_invites (workspace_id, code, created_by, max_uses, expires_at, role_ids)
VALUES ($1, $2, $3, $4, $5, coalesce(sqlc.arg(role_ids)::uuid[], '{}'))
RETURNING *;

-- name: GetInvite :one
SELECT * FROM workspace_invites WHERE id = $1;

-- name: AddMemberRolesIfExist :exec
-- Custom roles given to a member who has just been added or joined by an invitation (ADR-0026
-- addendum 2026-11-10), checked by the caller (inviteRoles / GiveInviteRoles); one deleted in
-- between is skipped.
INSERT INTO member_roles (workspace_id, user_id, role_id)
SELECT wr.workspace_id, sqlc.arg(user_id)::uuid, wr.id FROM workspace_roles wr
WHERE wr.workspace_id = sqlc.arg(workspace_id)::uuid AND wr.id = ANY (sqlc.arg(role_ids)::uuid[]) AND wr.builtin IS NULL
ON CONFLICT DO NOTHING;

-- name: ListInvites :many
-- Links only: invitations sent by email are listed by ListEmailInvites.
SELECT * FROM workspace_invites i
WHERE i.workspace_id = $1 AND NOT EXISTS (SELECT 1 FROM email_invites e WHERE e.invite_id = i.id)
ORDER BY i.created_at DESC;

-- name: GetInviteByCode :one
SELECT * FROM workspace_invites WHERE code = $1;

-- name: ConsumeInvite :one
-- Atomically takes one use of a valid invite; no row = invalid / expired / used up.
UPDATE workspace_invites SET uses = uses + 1
WHERE code = $1
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_uses = 0 OR uses < max_uses)
RETURNING *;

-- name: DeleteInvite :execrows
DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2;

-- name: CountWorkspaceMembers :one
-- Members without guests (public invite preview).
SELECT count(*)::integer FROM workspace_members WHERE workspace_id = $1 AND role <> 'guest';

-- name: LockWorkspaceMembers :exec
-- Serializes the plan's members check of one workspace between the count and the insert.
SELECT pg_advisory_xact_lock(hashtext('calaba.members:' || sqlc.arg('workspace_id')::uuid::text));
