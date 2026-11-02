-- Account deletion by the user (ADR-0153). The users row becomes an anonymous tombstone; other
-- people's history keeps the id as its author.

-- name: AnonymizeDeletedUser :one
-- Everything personal goes; disabled_at makes every existing check refuse the account.
UPDATE users SET
    email = NULL, pending_email = NULL, email_verified_at = NULL, password_hash = NULL,
    display_name = 'Удалённый пользователь', avatar_file_id = NULL,
    status_text = '', status_emoji = '', status_expires_at = NULL,
    settings = '{}', timezone = NULL, locale = NULL, presence_status = NULL, presence_until = NULL,
    birthday_day = NULL, birthday_month = NULL, birthday_year = NULL, birthday_hidden = true,
    username = NULL, phone = NULL, task_notify_off = DEFAULT, task_notify_bots = DEFAULT,
    calendar_zones = DEFAULT, storage_quota_bytes = NULL, hide_message_text_in_notifications = DEFAULT,
    disabled_at = coalesce(disabled_at, now()), deleted_at = now()
WHERE id = $1 AND NOT is_guest AND NOT is_bot AND deleted_at IS NULL
RETURNING *;

-- name: ScrubFormerSnapshots :exec
-- Former-member snapshots of the user in every workspace (also older ones) lose name, avatar and
-- nickname.
UPDATE workspace_former_members SET display_name = 'Удалённый пользователь', avatar_file_id = NULL, nickname = ''
WHERE user_id = $1;

-- name: ScrubUserSessions :exec
-- Revoked sessions keep their rows (other tables reference them) without the device details.
UPDATE sessions SET ip = '', user_agent = '', device_name = '' WHERE user_id = $1;

-- name: DeleteAccountPersonalData :exec
-- Rows that only describe the user (no one else's history): codes, attribution, calendars,
-- sticker installs, bot blocks, the people the user blocked (ADR-0154) and bot shares, task subscriptions, product admin, identity links,
-- OAuth consents, bot delegations, push devices, notes about
-- people (by and about the user).
WITH
    codes AS (DELETE FROM email_codes WHERE email_codes.user_id = sqlc.arg('user_id')::uuid),
    attribution AS (DELETE FROM user_attribution WHERE user_attribution.user_id = sqlc.arg('user_id')::uuid),
    caldav AS (DELETE FROM caldav_accounts WHERE caldav_accounts.user_id = sqlc.arg('user_id')::uuid),
    caldav_push AS (DELETE FROM caldav_pushes WHERE caldav_pushes.user_id = sqlc.arg('user_id')::uuid),
    busy AS (DELETE FROM external_busy WHERE external_busy.user_id = sqlc.arg('user_id')::uuid),
    ext_reminders AS (DELETE FROM external_reminders_sent WHERE external_reminders_sent.user_id = sqlc.arg('user_id')::uuid),
    packs AS (DELETE FROM user_sticker_packs WHERE user_sticker_packs.user_id = sqlc.arg('user_id')::uuid),
    blocks AS (DELETE FROM bot_blocks WHERE bot_blocks.user_id = sqlc.arg('user_id')::uuid),
    user_blocks_by AS (DELETE FROM user_blocks WHERE user_blocks.user_id = sqlc.arg('user_id')::uuid),
    shares AS (DELETE FROM bot_contact_shares WHERE bot_contact_shares.user_id = sqlc.arg('user_id')::uuid),
    subs AS (DELETE FROM task_subscribers WHERE task_subscribers.user_id = sqlc.arg('user_id')::uuid),
    admin AS (DELETE FROM product_admin_grants WHERE product_admin_grants.user_id = sqlc.arg('user_id')::uuid),
    identities AS (DELETE FROM workspace_external_identities WHERE workspace_external_identities.user_id = sqlc.arg('user_id')::uuid),
    consents AS (DELETE FROM oauth_consents WHERE oauth_consents.user_id = sqlc.arg('user_id')::uuid),
    delegations AS (DELETE FROM bot_delegations WHERE bot_delegations.user_id = sqlc.arg('user_id')::uuid),
    invites AS (DELETE FROM bot_delegation_invites WHERE bot_delegation_invites.user_id = sqlc.arg('user_id')::uuid),
    declines AS (DELETE FROM bot_delegation_declines WHERE bot_delegation_declines.user_id = sqlc.arg('user_id')::uuid),
    devices AS (DELETE FROM push_devices WHERE push_devices.user_id = sqlc.arg('user_id')::uuid),
    people_notes AS (DELETE FROM user_notes WHERE user_notes.author_id = sqlc.arg('user_id')::uuid OR user_notes.subject_id = sqlc.arg('user_id')::uuid),
    owned_bots AS (UPDATE bots SET acts_as_owner = false, acts_as_owner_since = NULL WHERE bots.owner_user_id = sqlc.arg('user_id')::uuid AND bots.acts_as_owner)
SELECT 1;

-- name: DeleteUserNotesRooms :many
-- The user's notes shelves (ADR-0039): messages go by cascade, their uploads become orphans for
-- the file cleanup. Returns the shelves.
DELETE FROM rooms r
USING dm_members d
WHERE d.room_id = r.id AND d.user_id = $1 AND r.type = 'notes'
RETURNING r.id;
