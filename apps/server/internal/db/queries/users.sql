-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: CreateUser :one
INSERT INTO users (email, password_hash, display_name, settings, locale, email_verified_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: ListUsersByIDs :many
SELECT * FROM users WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: UpdateUser :one
UPDATE users SET
    display_name   = coalesce(sqlc.narg('display_name'), display_name),
    status_text    = coalesce(sqlc.narg('status_text'), status_text),
    avatar_file_id = CASE WHEN sqlc.arg('set_avatar')::boolean THEN sqlc.narg('avatar_file_id')::uuid ELSE avatar_file_id END,
    settings       = coalesce(sqlc.narg('settings'), settings),
    timezone       = CASE WHEN sqlc.arg('set_timezone')::boolean THEN sqlc.narg('timezone')::text ELSE timezone END,
    locale         = CASE WHEN sqlc.arg('set_locale')::boolean THEN sqlc.narg('locale')::text ELSE locale END,
    birthday_day    = CASE WHEN sqlc.arg('set_birthday')::boolean THEN sqlc.narg('birthday_day')::smallint ELSE birthday_day END,
    birthday_month  = CASE WHEN sqlc.arg('set_birthday')::boolean THEN sqlc.narg('birthday_month')::smallint ELSE birthday_month END,
    birthday_year   = CASE WHEN sqlc.arg('set_birthday')::boolean THEN sqlc.narg('birthday_year')::smallint ELSE birthday_year END,
    birthday_hidden = coalesce(sqlc.narg('birthday_hidden')::boolean, birthday_hidden),
    hide_message_text_in_notifications = coalesce(sqlc.narg('hide_message_text_in_notifications')::boolean, hide_message_text_in_notifications),
    phone          = CASE WHEN sqlc.arg('set_phone')::boolean THEN sqlc.narg('phone')::text ELSE phone END,
    username       = CASE WHEN sqlc.arg('set_username')::boolean THEN sqlc.narg('username')::citext ELSE username END
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: UsernameOwner :one
-- ADR-0077: who holds a nickname (people and bots share the namespace); no rows = free.
SELECT id FROM users WHERE username = $1;

-- name: ResolveUsernames :many
-- ADR-0077: literal @nick mentions → live accounts (the caller checks visibility).
SELECT id, username::text AS username FROM users
WHERE username = ANY(sqlc.arg('names')::citext[]) AND disabled_at IS NULL;

-- name: ResolveMemberUsernames :many
-- ADR-0077: literal @nick mentions → live members of a workspace.
SELECT u.id, u.username::text AS username FROM users u
JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = sqlc.arg('workspace_id')
WHERE u.username = ANY(sqlc.arg('names')::citext[]) AND u.disabled_at IS NULL;

-- name: LockRegistration :exec
-- Serializes the first-user bootstrap check (see auth.Register).
SELECT pg_advisory_xact_lock(hashtext('calaba.registration'));

-- name: UpdateStatus :one
UPDATE users SET status_text = $2, status_emoji = $3, status_expires_at = $4
WHERE id = $1
RETURNING *;

-- name: SetPasswordHash :exec
UPDATE users SET password_hash = $2 WHERE id = $1;

-- name: SetEmail :one
UPDATE users SET email = $2 WHERE id = $1
RETURNING *;

-- name: LockPasswordHash :one
-- Login re-reads the hash under a share lock in the session transaction: a concurrent
-- password change either waits for the new session (and then revokes it) or has already
-- replaced the hash (and the login fails).
SELECT password_hash FROM users WHERE id = $1 FOR SHARE;

-- name: SetEmailVerified :one
-- Marks the current address verified (no-op if it already is).
UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1
RETURNING *;

-- name: SetPendingEmail :one
UPDATE users SET pending_email = $2 WHERE id = $1
RETURNING *;

-- name: ConfirmPendingEmail :one
-- The confirmed pending address becomes the login email (unique: may fail with 23505).
UPDATE users SET email = pending_email, pending_email = NULL, email_verified_at = now()
WHERE id = $1 AND pending_email IS NOT NULL
RETURNING *;

-- name: SetEmailAndVerified :one
-- Servers without SMTP: an email change takes effect at once (nothing to verify with).
UPDATE users SET email = $2, pending_email = NULL, email_verified_at = now() WHERE id = $1
RETURNING *;

-- name: SetManualPresence :exec
-- NULL status clears the manual status (docs/05 «Presence»).
UPDATE users SET presence_status = sqlc.narg('status')::smallint, presence_until = sqlc.narg('until')::timestamptz
WHERE id = sqlc.arg('id');

-- name: ExpireManualPresence :many
-- Claims manual statuses that ran out (the presence sweeper, one instance at a time).
-- Returns the ended values (to drop exactly that Valkey copy, not a newer choice).
WITH ended AS (
    SELECT id, presence_status, presence_until FROM users
    WHERE presence_status IS NOT NULL AND presence_until <= now()
    LIMIT 500
    FOR UPDATE SKIP LOCKED
)
UPDATE users u SET presence_status = NULL, presence_until = NULL
FROM ended
WHERE u.id = ended.id
RETURNING ended.id, ended.presence_status, ended.presence_until;

-- name: ExpireCustomStatuses :many
-- Clears temporary custom statuses that ran out (the presence sweeper, one instance at a
-- time) and returns the updated users, to announce the change.
UPDATE users SET status_text = '', status_emoji = '', status_expires_at = NULL
WHERE id IN (
    SELECT id FROM users
    WHERE status_expires_at IS NOT NULL AND status_expires_at <= now()
    LIMIT 500
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: ListManualPresence :many
-- Live manual statuses, to restore Valkey at startup.
SELECT id, presence_status, presence_until FROM users
WHERE presence_status IS NOT NULL AND (presence_until IS NULL OR presence_until > now());

-- name: HasSimilarAccount :one
-- Registration hint (docs/09 #119): an active, non-guest, non-bot account with the same local
-- part at a sibling domain of the same organisation — same name with a different last label
-- (kv@gptunnel.ai vs kv@gptunnel.ru), or a domain of the email invitations of workspace_id
-- (the sign-up's invite). Never the exact address. A scan of users: registration is rare.
SELECT EXISTS (
    SELECT 1 FROM users u
    WHERE u.email IS NOT NULL AND u.email <> sqlc.arg('email')::citext
      AND NOT u.is_guest AND NOT u.is_bot AND u.disabled_at IS NULL
      AND lower(split_part(u.email::text, '@', 1)) = lower(sqlc.arg('local')::text)
      AND (
          lower(regexp_replace(split_part(u.email::text, '@', 2), '\.[^.]*$', '')) = lower(sqlc.arg('domain_name')::text)
          OR lower(split_part(u.email::text, '@', 2)) IN (
              SELECT lower(split_part(e.email::text, '@', 2)) FROM email_invites e
              WHERE e.workspace_id = sqlc.narg('workspace_id')::uuid
          )
      )
)::boolean;
