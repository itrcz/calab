-- name: CreateRoom :one
-- expires_at set = a temporary room (ADR-0044); created_by: the creator (NULL: not recorded).
INSERT INTO rooms (workspace_id, type, name, topic, position, is_private,
                   audio_bitrate_kbps, max_stream_preset, max_streams, category_id, user_limit, camera_limit,
                   expires_at, created_by)
VALUES (sqlc.arg('workspace_id')::uuid, sqlc.arg('type'), sqlc.arg('name'), sqlc.arg('topic'),
        coalesce(sqlc.narg('position')::integer,
                 (SELECT coalesce(max(position) + 1, 0) FROM rooms
                  WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND archived_at IS NULL AND type <> 'task')),
        sqlc.arg('is_private'), sqlc.narg('audio_bitrate_kbps'), sqlc.narg('max_stream_preset'),
        sqlc.narg('max_streams'), sqlc.narg('category_id'), sqlc.arg('user_limit'), sqlc.narg('camera_limit'),
        sqlc.narg('expires_at'), sqlc.narg('created_by'))
RETURNING *;

-- name: GetRoom :one
SELECT * FROM rooms WHERE id = $1 AND archived_at IS NULL;

-- name: GetRoomForUpdate :one
-- The live room, locked for the rest of the transaction (PATCH restricted, ADR-0029).
SELECT * FROM rooms WHERE id = $1 AND archived_at IS NULL FOR UPDATE;

-- name: ListRooms :many
SELECT * FROM rooms
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND archived_at IS NULL AND type <> 'task'
ORDER BY position, id;

-- name: UpdateRoom :one
UPDATE rooms SET
    name     = coalesce(sqlc.narg('name'), name),
    topic    = coalesce(sqlc.narg('topic'), topic),
    position = coalesce(sqlc.narg('position'), position),
    user_limit = coalesce(sqlc.narg('user_limit'), user_limit),
    allow_recording = coalesce(sqlc.narg('allow_recording'), allow_recording),
    restricted = coalesce(sqlc.narg('restricted'), restricted),
    guest_approval = coalesce(sqlc.narg('guest_approval'), guest_approval),
    audio_bitrate_kbps = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('audio_bitrate_kbps')::integer ELSE audio_bitrate_kbps END,
    max_stream_preset  = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('max_stream_preset')::text ELSE max_stream_preset END,
    max_streams        = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('max_streams')::integer ELSE max_streams END,
    camera_limit       = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('camera_limit')::integer ELSE camera_limit END,
    category_id        = CASE WHEN sqlc.arg('set_category')::boolean THEN sqlc.narg('category_id')::uuid ELSE category_id END
WHERE id = sqlc.arg('id') AND archived_at IS NULL
RETURNING *;

-- name: ArchiveRoom :execrows
UPDATE rooms SET archived_at = now() WHERE id = $1 AND archived_at IS NULL;

-- name: ListRoomOverrides :many
SELECT * FROM room_permissions WHERE room_id = $1 ORDER BY target_type, target_id;

-- name: ListWorkspaceRoomOverrides :many
SELECT rp.* FROM room_permissions rp
JOIN rooms r ON r.id = rp.room_id
WHERE r.workspace_id = sqlc.arg('workspace_id')::uuid AND r.archived_at IS NULL
ORDER BY rp.room_id, rp.target_type, rp.target_id;

-- name: DeleteRoomOverrides :exec
DELETE FROM room_permissions WHERE room_id = $1;

-- name: InsertRoomOverride :exec
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
VALUES ($1, $2, $3, $4, $5);

-- name: GetRoomAccess :one
-- Everything needed to compute a user's permissions in a room, in one round trip. Workspace
-- rooms: the membership (role NULL = not a member), the member's roles lowest position first
-- (ADR-0026) with each role's override in this room (0/0 = none) and the user override. An
-- archived room is found only when it is temporary (ADR-0044: its history stays readable);
-- archived / temp / created_by say so. DMs
-- and notes shelves (workspace_id NULL): the participants (a shelf: its owner). suspended: the workspace is suspended (item 32).
-- restricted: ADMINISTRATOR gives no bypass in the room (ADR-0029).
SELECT r.workspace_id,
       r.type,
       r.restricted,
       r.is_private,
       m.role,
       coalesce(mr.ids, '{}')::uuid[] AS role_ids,
       coalesce(mr.positions, '{}')::integer[] AS role_positions,
       coalesce(mr.perms, '{}')::bigint[] AS role_permissions,
       coalesce(mr.allows, '{}')::bigint[] AS role_allows,
       coalesce(mr.denies, '{}')::bigint[] AS role_denies,
       uo.allow AS user_allow, uo.deny AS user_deny,
       (CASE WHEN r.type IN ('dm', 'notes') THEN ARRAY(SELECT d.user_id FROM dm_members d WHERE d.room_id = r.id ORDER BY d.user_id)
             ELSE '{}'::uuid[] END)::uuid[] AS dm_members,
       (w.suspended_at IS NOT NULL)::boolean AS suspended,
       (r.archived_at IS NOT NULL)::boolean AS archived,
       (r.expires_at IS NOT NULL)::boolean AS temp,
       r.created_by
FROM rooms r
LEFT JOIN workspaces w ON w.id = r.workspace_id
LEFT JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = sqlc.arg('user_id')
LEFT JOIN LATERAL (
    SELECT array_agg(wr.id ORDER BY wr.position) AS ids,
           array_agg(wr.position ORDER BY wr.position) AS positions,
           array_agg(wr.permissions ORDER BY wr.position) AS perms,
           array_agg(coalesce(ro.allow, 0) ORDER BY wr.position) AS allows,
           array_agg(coalesce(ro.deny, 0) ORDER BY wr.position) AS denies
    FROM member_roles x
    JOIN workspace_roles wr ON wr.id = x.role_id
    LEFT JOIN room_permissions ro ON ro.room_id = r.id AND ro.target_type = 'role' AND ro.target_id = wr.id::text
    WHERE x.workspace_id = m.workspace_id AND x.user_id = m.user_id
) mr ON true
LEFT JOIN room_permissions uo ON uo.room_id = r.id AND uo.target_type = 'user' AND uo.target_id = sqlc.arg('user_id')::text
WHERE r.id = sqlc.arg('room_id') AND (r.archived_at IS NULL OR r.expires_at IS NOT NULL);

-- name: GetRoomAccesses :many
-- GetRoomAccess for several users at once (the RTC identity sweep checks a room in one call):
-- the same columns, one row per given user in their order, or no rows when GetRoomAccess finds
-- no room. Keep the two in step; perm converts these rows to GetRoomAccessRow.
SELECT r.workspace_id,
       r.type,
       r.restricted,
       r.is_private,
       m.role,
       coalesce(mr.ids, '{}')::uuid[] AS role_ids,
       coalesce(mr.positions, '{}')::integer[] AS role_positions,
       coalesce(mr.perms, '{}')::bigint[] AS role_permissions,
       coalesce(mr.allows, '{}')::bigint[] AS role_allows,
       coalesce(mr.denies, '{}')::bigint[] AS role_denies,
       uo.allow AS user_allow, uo.deny AS user_deny,
       (CASE WHEN r.type IN ('dm', 'notes') THEN ARRAY(SELECT d.user_id FROM dm_members d WHERE d.room_id = r.id ORDER BY d.user_id)
             ELSE '{}'::uuid[] END)::uuid[] AS dm_members,
       (w.suspended_at IS NOT NULL)::boolean AS suspended,
       (r.archived_at IS NOT NULL)::boolean AS archived,
       (r.expires_at IS NOT NULL)::boolean AS temp,
       r.created_by
FROM rooms r
CROSS JOIN unnest(sqlc.arg('user_ids')::uuid[]) WITH ORDINALITY AS k(user_id, ord)
LEFT JOIN workspaces w ON w.id = r.workspace_id
LEFT JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = k.user_id
LEFT JOIN LATERAL (
    SELECT array_agg(wr.id ORDER BY wr.position) AS ids,
           array_agg(wr.position ORDER BY wr.position) AS positions,
           array_agg(wr.permissions ORDER BY wr.position) AS perms,
           array_agg(coalesce(ro.allow, 0) ORDER BY wr.position) AS allows,
           array_agg(coalesce(ro.deny, 0) ORDER BY wr.position) AS denies
    FROM member_roles x
    JOIN workspace_roles wr ON wr.id = x.role_id
    LEFT JOIN room_permissions ro ON ro.room_id = r.id AND ro.target_type = 'role' AND ro.target_id = wr.id::text
    WHERE x.workspace_id = m.workspace_id AND x.user_id = m.user_id
) mr ON true
LEFT JOIN room_permissions uo ON uo.room_id = r.id AND uo.target_type = 'user' AND uo.target_id = k.user_id::text
WHERE r.id = sqlc.arg('room_id') AND (r.archived_at IS NULL OR r.expires_at IS NOT NULL)
ORDER BY k.ord;

-- name: CreateCategory :one
INSERT INTO room_categories (workspace_id, name, position)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('name'),
        coalesce(sqlc.narg('position')::integer,
                 (SELECT coalesce(max(position) + 1, 0) FROM room_categories WHERE workspace_id = sqlc.arg('workspace_id'))))
RETURNING *;

-- name: ListCategories :many
SELECT * FROM room_categories WHERE workspace_id = $1 ORDER BY position, id;

-- name: GetCategory :one
SELECT * FROM room_categories WHERE id = $1;

-- name: UpdateCategory :one
UPDATE room_categories SET
    name     = coalesce(sqlc.narg('name'), name),
    position = coalesce(sqlc.narg('position'), position)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeleteCategory :many
-- Deletes a category; returns the rooms that were in it. They move to the top level, after the
-- rooms already there, in their order (docs/09 P1 #19): no position ties with top-level rooms.
WITH base AS (
    SELECT coalesce(max(r.position) + 1, 0) AS p FROM rooms r
    WHERE r.workspace_id = (SELECT c.workspace_id FROM room_categories c WHERE c.id = sqlc.arg('id')::uuid)
      AND r.category_id IS NULL AND r.archived_at IS NULL
), ordered AS (
    SELECT r.id, row_number() OVER (ORDER BY r.position, r.name, r.id) - 1 AS n FROM rooms r
    WHERE r.category_id = sqlc.arg('id')::uuid AND r.archived_at IS NULL
), moved AS (
    UPDATE rooms SET category_id = NULL, position = base.p + ordered.n
    FROM base, ordered
    WHERE rooms.id = ordered.id
    RETURNING rooms.id
), gone AS (
    DELETE FROM room_categories WHERE room_categories.id = sqlc.arg('id')::uuid
)
SELECT id FROM moved;

-- name: SetRoomPlacement :one
UPDATE rooms SET position = sqlc.arg('position'), category_id = sqlc.narg('category_id')
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')::uuid AND archived_at IS NULL
RETURNING *;

-- name: SetCategoryPosition :one
UPDATE room_categories SET position = sqlc.arg('position')
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: SetVoiceStatus :one
UPDATE rooms SET voice_status = sqlc.narg('status') WHERE id = sqlc.arg('id') AND archived_at IS NULL
RETURNING *;

-- name: ClearVoiceStatus :execrows
-- The call ended: the status goes with it.
UPDATE rooms SET voice_status = NULL WHERE id = $1 AND voice_status IS NOT NULL;

-- ---- temporary rooms (ADR-0044) ----

-- name: LockTempRooms :exec
-- Serializes temporary room creation in a workspace (the live caps) for the transaction.
SELECT pg_advisory_xact_lock(hashtextextended('temp-rooms:' || sqlc.arg('workspace_id')::uuid::text, 0));

-- name: CountLiveTempRooms :one
SELECT count(*)::integer AS total,
       (count(*) FILTER (WHERE created_by = sqlc.arg('user_id')::uuid))::integer AS mine
FROM rooms
WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND expires_at IS NOT NULL AND archived_at IS NULL;

-- name: SetRoomExpiry :one
-- A temporary room's new end, or NULL = permanent (make_permanent). Live temporary rooms only.
UPDATE rooms SET expires_at = sqlc.narg('expires_at')
WHERE id = sqlc.arg('id') AND archived_at IS NULL AND expires_at IS NOT NULL
RETURNING *;

-- name: FollowRoomExpiry :exec
-- The room's own links that ended with the room follow its new end (not meeting guest links).
UPDATE room_invites SET expires_at = sqlc.arg('expires_at')
WHERE room_id = sqlc.arg('room_id') AND revoked_at IS NULL AND event_id IS NULL
  AND expires_at = sqlc.arg('old_expires_at');

-- name: SetRoomPrivate :one
UPDATE rooms SET is_private = sqlc.arg('is_private')
WHERE id = sqlc.arg('id') AND archived_at IS NULL
RETURNING *;

-- name: RemoveRoleDeny :exec
-- Removes deny bits from one role override; an override left empty is dropped.
UPDATE room_permissions SET deny = deny & ~sqlc.arg('bits')::bigint
WHERE room_id = sqlc.arg('room_id') AND target_type = 'role' AND target_id = sqlc.arg('target_id')::text;

-- name: DropEmptyRoleOverride :exec
DELETE FROM room_permissions
WHERE room_id = sqlc.arg('room_id') AND target_type = 'role' AND target_id = sqlc.arg('target_id')::text
  AND allow = 0 AND deny = 0;

-- name: AddRoleDeny :exec
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
VALUES (sqlc.arg('room_id'), 'role', sqlc.arg('target_id')::text, 0, sqlc.arg('deny'))
ON CONFLICT (room_id, target_type, target_id) DO UPDATE
    SET deny = room_permissions.deny | EXCLUDED.deny, allow = room_permissions.allow & ~EXCLUDED.deny;

-- name: GrantUserOverride :exec
-- A personal allow for a private temporary room (creator, chosen people): added to an
-- existing override, never lifting its denies.
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
VALUES (sqlc.arg('room_id'), 'user', sqlc.arg('user_id')::text, sqlc.arg('allow'), 0)
ON CONFLICT (room_id, target_type, target_id) DO UPDATE
    SET allow = room_permissions.allow | (EXCLUDED.allow & ~room_permissions.deny);

-- name: RevokeAllRoomInvites :exec
UPDATE room_invites SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL;

-- name: ArchiveTempRoom :one
-- Archives a live temporary room: now (DELETE), or only when it has expired (the sweeper; a
-- concurrent extension wins).
UPDATE rooms SET archived_at = now()
WHERE id = sqlc.arg('id') AND archived_at IS NULL AND expires_at IS NOT NULL
  AND (NOT sqlc.arg('only_expired')::boolean OR expires_at <= now())
RETURNING *;

-- name: DueTempRooms :many
SELECT id FROM rooms
WHERE expires_at <= now() AND archived_at IS NULL
ORDER BY expires_at
LIMIT $1;

-- name: ListArchivedTempRooms :many
-- The archive of temporary rooms, newest first, with their live message count.
SELECT sqlc.embed(r),
       (SELECT count(*) FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL)::integer AS message_count
FROM rooms r
WHERE r.workspace_id = sqlc.arg('workspace_id')::uuid AND r.expires_at IS NOT NULL AND r.archived_at IS NOT NULL
ORDER BY r.archived_at DESC, r.id
LIMIT 500;

-- name: ListRoomOverridesIn :many
SELECT * FROM room_permissions WHERE room_id = ANY(sqlc.arg('room_ids')::uuid[])
ORDER BY room_id, target_type, target_id;

-- name: PurgeableTempRooms :many
-- Archived temporary rooms past the retention (TEMP_ROOM_RETENTION_DAYS).
SELECT id FROM rooms
WHERE expires_at IS NOT NULL AND archived_at IS NOT NULL AND archived_at < sqlc.arg('before')
ORDER BY archived_at
LIMIT sqlc.arg('lim');

-- name: DeleteArchivedTempRoom :execrows
-- Messages, reactions, pins, read state, overrides and links go by cascade (as a deleted notes
-- shelf); the room's uploads become orphans for the file cleanup; meetings keep no room.
DELETE FROM rooms WHERE id = $1 AND expires_at IS NOT NULL AND archived_at IS NOT NULL;
