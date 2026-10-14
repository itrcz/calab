-- Direct messages (ADR-0020). A DM is a room with type 'dm', no workspace and two rows in
-- dm_members; dm_key = least(a, b) || ':' || greatest(a, b) makes it unique per pair.

-- name: GetDMByKey :one
SELECT * FROM rooms WHERE dm_key = $1 AND archived_at IS NULL;

-- name: CreateDMRoom :one
-- No row = a concurrent request created the pair's DM first (read it with GetDMByKey).
INSERT INTO rooms (workspace_id, type, name, dm_key)
VALUES (NULL, 'dm', 'dm', sqlc.arg('dm_key'))
ON CONFLICT (dm_key) WHERE dm_key IS NOT NULL DO NOTHING
RETURNING *;

-- name: AddDMMembers :exec
INSERT INTO dm_members (room_id, user_id)
SELECT sqlc.arg('room_id')::uuid, u FROM unnest(sqlc.arg('user_ids')::uuid[]) AS u;

-- name: GetDMPeer :one
-- The other participant of a DM the user is in (no row = not a participant / not a DM).
SELECT p.user_id FROM dm_members me
JOIN dm_members p ON p.room_id = me.room_id AND p.user_id <> me.user_id
JOIN rooms r ON r.id = me.room_id AND r.archived_at IS NULL
WHERE me.room_id = sqlc.arg('room_id') AND me.user_id = sqlc.arg('user_id');

-- name: ShareWorkspace :one
-- Both users are full members (not the guest role) of at least one common workspace.
SELECT EXISTS (
    SELECT 1 FROM workspace_members a
    JOIN workspace_members b ON b.workspace_id = a.workspace_id AND b.user_id = sqlc.arg('other_id')
    WHERE a.user_id = sqlc.arg('user_id') AND a.role <> 'guest' AND b.role <> 'guest'
)::boolean;

-- name: ListDMs :many
-- The user's DMs, most recent activity first: the peer, the read marker, the newest live
-- message and the unread count (others' live messages after the marker, capped at 999; a
-- DM never read counts from its start). Every lookup is an index probe per DM
-- (dm_members_user_id_idx, messages_live_room_id_idx). room_id NULL = all DMs. Without
-- messages (has_messages false) last_message_* are the room's id and creation time. The
-- newest message's author, first 200 characters and attachment count are the list preview
-- (DmSummary.last_message): the client needs no history request per DM. The user's own
-- dm_state (item 51): archived_at, and cleared_before — the preview and the unread count start
-- after it (the DM stays listed; the client hides a cleared DM without newer messages).
-- peer_read_message_id: the peer's read marker for read receipts (docs/09 #92; a primary-key
-- probe; NULL for a bot peer).
SELECT r.id AS room_id, r.created_at AS room_created_at,
       sqlc.embed(u),
       rs.last_read_message_id,
       (lm.id IS NOT NULL)::boolean AS has_messages,
       coalesce(lm.id, r.id)::uuid AS last_message_id,
       coalesce(lm.created_at, r.created_at)::timestamptz AS last_message_at,
       coalesce(lm.author_id, me.user_id)::uuid AS last_author_id,
       coalesce(lm.preview, '')::text AS last_preview,
       coalesce(lm.attachments, 0)::integer AS last_attachments,
       coalesce(lm.sticker_emoji, '')::text AS last_sticker_emoji,
       (SELECT count(*) FROM (
           SELECT 1 FROM messages m
           WHERE m.room_id = r.id AND m.deleted_at IS NULL AND m.author_id <> me.user_id
             AND m.id > greatest(coalesce(rs.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                 coalesce(ds.cleared_before, '00000000-0000-0000-0000-000000000000'::uuid))
           LIMIT 999) x)::integer AS unread_count,
       ds.archived_at, ds.cleared_before,
       prs.last_read_message_id AS peer_read_message_id
FROM dm_members me
JOIN rooms r ON r.id = me.room_id AND r.archived_at IS NULL
JOIN dm_members p ON p.room_id = me.room_id AND p.user_id <> me.user_id
JOIN users u ON u.id = p.user_id
LEFT JOIN read_states rs ON rs.user_id = me.user_id AND rs.room_id = r.id
LEFT JOIN read_states prs ON prs.user_id = p.user_id AND prs.room_id = r.id AND NOT u.is_bot
LEFT JOIN dm_state ds ON ds.user_id = me.user_id AND ds.room_id = r.id
LEFT JOIN LATERAL (
    SELECT m.id, m.created_at, m.author_id, left(m.content, 200) AS preview,
           (SELECT count(*) FROM message_attachments ma WHERE ma.message_id = m.id) AS attachments,
           (SELECT st.emoji FROM stickers st WHERE st.id = m.sticker_id) AS sticker_emoji
    FROM messages m
    WHERE m.room_id = r.id AND m.deleted_at IS NULL
      AND m.id > coalesce(ds.cleared_before, '00000000-0000-0000-0000-000000000000'::uuid)
    ORDER BY m.id DESC
    LIMIT 1
) lm ON true
WHERE me.user_id = sqlc.arg('user_id')
  AND (sqlc.narg('room_id')::uuid IS NULL OR r.id = sqlc.narg('room_id')::uuid)
ORDER BY coalesce(lm.id, r.id) DESC
LIMIT sqlc.arg('lim');

-- name: SetDMArchived :one
-- Moves the user's DM to / out of their archive (archiving again keeps the first time).
INSERT INTO dm_state (user_id, room_id, archived_at)
VALUES (sqlc.arg('user_id'), sqlc.arg('room_id'), CASE WHEN sqlc.arg('archived')::boolean THEN now() END)
ON CONFLICT (user_id, room_id) DO UPDATE
SET archived_at = CASE WHEN sqlc.arg('archived')::boolean THEN coalesce(dm_state.archived_at, now()) END
RETURNING *;

-- name: ClearDM :one
-- «Удалить чат» for the user only: hides the history up to now (uuidv7() orders after every
-- message created before) and takes the DM out of the archive.
INSERT INTO dm_state (user_id, room_id, cleared_before)
VALUES (sqlc.arg('user_id'), sqlc.arg('room_id'), uuidv7())
ON CONFLICT (user_id, room_id) DO UPDATE SET archived_at = NULL, cleared_before = uuidv7()
RETURNING *;

-- name: UnarchiveDMForRecipients :many
-- A new message takes the DM out of the archive of the participants other than its author.
UPDATE dm_state SET archived_at = NULL
WHERE room_id = sqlc.arg('room_id') AND user_id <> sqlc.arg('author_id') AND archived_at IS NOT NULL
RETURNING *;

-- name: GetDMClearedBefore :one
-- The user's «Удалить чат» mark in a room (the zero uuid = none, also for rooms that are no DM).
SELECT coalesce((SELECT ds.cleared_before FROM dm_state ds WHERE ds.user_id = sqlc.arg('user_id') AND ds.room_id = sqlc.arg('room_id')),
                '00000000-0000-0000-0000-000000000000'::uuid)::uuid AS cleared_before;

-- name: ListDMCandidates :many
-- Users the caller may start a DM with: full members of a workspace the caller is a full
-- member of; not guest accounts, not disabled, not the caller. q matches the display name
-- or a workspace nickname (case-insensitive substring; '' = everyone).
SELECT u.* FROM users u
WHERE u.id <> sqlc.arg('user_id') AND NOT u.is_guest AND u.disabled_at IS NULL
  AND EXISTS (
    SELECT 1 FROM workspace_members a
    JOIN workspace_members b ON b.workspace_id = a.workspace_id AND b.user_id = u.id AND b.role <> 'guest'
    WHERE a.user_id = sqlc.arg('user_id') AND a.role <> 'guest'
      AND (sqlc.arg('q')::text = '' OR u.display_name ILIKE '%' || sqlc.arg('q')::text || '%'
           OR b.nickname ILIKE '%' || sqlc.arg('q')::text || '%')
  )
ORDER BY lower(u.display_name), u.id
LIMIT sqlc.arg('lim');

-- name: IsAvatar :one
SELECT EXISTS (SELECT 1 FROM users WHERE avatar_file_id = $1)::boolean;

-- name: UnattachedUserBytes :one
-- Bytes a user uploaded for DMs (user-scoped, not an avatar) not attached to a message yet.
SELECT coalesce(sum(f.size), 0)::bigint FROM files f
WHERE f.uploader_id = $1 AND f.workspace_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id);

-- name: ListSearchPersonalRooms :many
-- The user's live DMs and notes shelves with their «Удалить чат» mark (unified search, ADR-0062:
-- the user is a participant, as perm.ReadRoom checks for these rooms).
SELECT r.id, r.type, ds.cleared_before FROM dm_members d
JOIN rooms r ON r.id = d.room_id AND r.archived_at IS NULL AND r.type IN ('dm', 'notes')
LEFT JOIN dm_state ds ON ds.user_id = d.user_id AND ds.room_id = r.id
WHERE d.user_id = $1;
