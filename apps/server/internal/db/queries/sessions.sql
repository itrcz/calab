-- name: CreateSession :one
INSERT INTO sessions (user_id, refresh_token_hash, device_name, ip, user_agent, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetSessionForUpdate :one
SELECT * FROM sessions WHERE id = $1 FOR UPDATE;

-- name: GetSession :one
SELECT * FROM sessions WHERE id = $1;

-- name: ListSessionsByIDs :many
SELECT * FROM sessions WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: RotateSession :one
-- A new refresh generation: unused, with its secret sealed under the previous one (replay.go).
UPDATE sessions SET
    prev_refresh_token_hash = refresh_token_hash,
    refresh_token_hash      = $2,
    refresh_gen             = refresh_gen + 1,
    refresh_used_at         = NULL,
    replay_seal             = sqlc.arg(replay_seal),
    rotated_at              = now(),
    last_seen_at            = now(),
    expires_at              = $3,
    ip                      = $4,
    user_agent              = $5
WHERE id = $1
RETURNING *;

-- name: TouchSession :exec
-- "Last activity" of a session between refreshes (access tokens live 24 h): bumped by the
-- periodic session recheck (auth/sessioncheck.go), at most every 5 minutes.
UPDATE sessions SET last_seen_at = now()
WHERE id = $1 AND revoked_at IS NULL AND last_seen_at < now() - interval '5 minutes';

-- name: MarkRefreshGenUsed :exec
-- The first use of refresh generation refresh_gen (an access token minted for it was presented).
-- The seal is not needed any more: the previous token is reuse from now on.
UPDATE sessions SET refresh_used_at = now(), replay_seal = NULL
WHERE id = $1 AND refresh_gen = $2 AND refresh_used_at IS NULL AND revoked_at IS NULL;

-- name: RevokeSession :execrows
UPDATE sessions SET revoked_at = now(), revoked_reason = sqlc.arg(reason)::text, replay_seal = NULL
WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeUserSession :execrows
UPDATE sessions SET revoked_at = now(), revoked_reason = sqlc.arg(reason)::text, replay_seal = NULL
WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: RevokeAllUserSessions :many
UPDATE sessions SET revoked_at = now(), revoked_reason = sqlc.arg(reason)::text, replay_seal = NULL
WHERE user_id = $1 AND revoked_at IS NULL
RETURNING id;

-- name: ListActiveSessions :many
SELECT * FROM sessions
WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
ORDER BY last_seen_at DESC;

-- name: RevokeOtherUserSessions :many
UPDATE sessions SET revoked_at = now(), revoked_reason = sqlc.arg(reason)::text, replay_seal = NULL
WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
RETURNING id;
