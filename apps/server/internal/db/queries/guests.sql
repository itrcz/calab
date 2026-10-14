-- name: CreateGuestUser :one
INSERT INTO users (email, password_hash, display_name, settings, is_guest, guest_expires_at)
VALUES (NULL, NULL, $1, $2, true, $3)
RETURNING *;

-- name: TouchGuest :exec
UPDATE users SET guest_expires_at = $2 WHERE id = $1 AND is_guest AND guest_expires_at IS NOT NULL;

-- name: LockExpiredGuest :one
-- Re-checks expiry under a row lock inside the cleanup transaction (a refresh may have
-- just extended it).
SELECT id FROM users
WHERE id = $1 AND is_guest AND guest_expires_at IS NOT NULL AND guest_expires_at < now() AND disabled_at IS NULL
FOR UPDATE;

-- name: ListExpiredGuests :many
SELECT id FROM users
WHERE is_guest AND guest_expires_at IS NOT NULL AND guest_expires_at < $1 AND disabled_at IS NULL
LIMIT 200;

-- name: AnonymizeGuest :exec
-- Messages keep their author row; everything personal is dropped.
UPDATE users SET display_name = 'Гость (удалён)', status_text = '', status_emoji = '', status_expires_at = NULL,
    avatar_file_id = NULL, settings = '{}', guest_expires_at = NULL, disabled_at = now()
WHERE id = $1 AND is_guest;

-- name: ClearGuestExpiry :exec
UPDATE users SET guest_expires_at = NULL WHERE id = $1;

-- name: DeleteUserRoomOverrides :exec
DELETE FROM room_permissions WHERE target_type = 'user' AND target_id = sqlc.arg('user_id')::text;

-- name: ListUserFiles :many
SELECT * FROM files WHERE uploader_id = $1;

-- name: UpsertUserOverride :one
-- Grants `allow` to one user in a room on top of an existing override. Bits an admin
-- explicitly denied to this user stay denied (a link must not lift a deny).
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
VALUES (sqlc.arg('room_id'), 'user', sqlc.arg('user_id')::text, sqlc.arg('allow'), 0)
ON CONFLICT (room_id, target_type, target_id) DO UPDATE
    SET allow = room_permissions.allow | (EXCLUDED.allow & ~room_permissions.deny)
RETURNING *;

-- name: CreateRoomInvite :one
INSERT INTO room_invites (room_id, code, created_by, expires_at, max_uses, allow_guests, allow_bits, require_approval, members_only)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: SetRoomInviteApproval :one
-- require_approval NULL = as the room (ADR-0040).
UPDATE room_invites SET require_approval = sqlc.narg('require_approval')
WHERE id = sqlc.arg('id') AND room_id = sqlc.arg('room_id') AND revoked_at IS NULL
RETURNING *;

-- name: ListRoomInvites :many
SELECT * FROM room_invites
WHERE room_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
  AND (max_uses = 0 OR uses < max_uses)
ORDER BY created_at DESC;

-- name: GetRoomInviteByCode :one
SELECT sqlc.embed(i), sqlc.embed(r), sqlc.embed(w)
FROM room_invites i
JOIN rooms r ON r.id = i.room_id AND r.archived_at IS NULL
JOIN workspaces w ON w.id = r.workspace_id
WHERE i.code = $1 AND i.revoked_at IS NULL
  AND (i.expires_at IS NULL OR i.expires_at > now())
  AND (i.max_uses = 0 OR i.uses < i.max_uses);

-- name: ConsumeRoomInvite :one
UPDATE room_invites SET uses = uses + 1
WHERE id = $1 AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_uses = 0 OR uses < max_uses)
  AND (not_before IS NULL OR not_before <= now())
RETURNING *;

-- name: RevokeRoomInvite :execrows
-- only_members_only: the caller may revoke members-only links only (INVITE_MEMBERS, ADR-0043).
UPDATE room_invites SET revoked_at = now()
WHERE id = $1 AND room_id = $2 AND revoked_at IS NULL
  AND (NOT sqlc.arg('only_members_only')::bool OR members_only);

-- name: PromoteGuest :one
UPDATE workspace_members SET role = 'member'
WHERE workspace_id = $1 AND user_id = $2 AND role = 'guest'
RETURNING *;
