-- name: BlockUser :exec
INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: UnblockUser :exec
DELETE FROM user_blocks WHERE user_id = $1 AND blocked_user_id = $2;

-- name: ListBlockedUsers :many
SELECT blocked_user_id FROM user_blocks WHERE user_id = $1 ORDER BY created_at;

-- name: IsUserBlocked :one
-- user_id blocked blocked_user_id (one direction).
SELECT EXISTS (SELECT 1 FROM user_blocks WHERE user_id = $1 AND blocked_user_id = $2)::boolean;

-- name: IsBlockedEitherWay :one
-- A block between two people in either direction (ADR-0154: DMs and calls).
SELECT EXISTS (SELECT 1 FROM user_blocks
    WHERE (user_id = sqlc.arg('a')::uuid AND blocked_user_id = sqlc.arg('b')::uuid)
       OR (user_id = sqlc.arg('b')::uuid AND blocked_user_id = sqlc.arg('a')::uuid))::boolean;
