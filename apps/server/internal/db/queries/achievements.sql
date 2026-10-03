-- Achievements (ADR-0061, amendment 1): the workspace catalogs and grants to workspace members.

-- name: ListWorkspaceAchievements :many
-- The workspace's catalog in its order, archived entries included, with the live grants and
-- whether it was ever granted (DELETE refuses then).
SELECT sqlc.embed(a),
    (SELECT count(*) FROM member_achievements m WHERE m.achievement_id = a.id AND m.revoked_at IS NULL)::bigint AS granted,
    EXISTS (SELECT 1 FROM member_achievements m WHERE m.achievement_id = a.id)::boolean AS in_use
FROM achievements a WHERE a.workspace_id = $1
ORDER BY a.position, a.id;

-- name: GetAchievement :one
SELECT * FROM achievements WHERE id = $1;

-- name: LockAchievement :one
SELECT * FROM achievements WHERE id = $1 FOR UPDATE;

-- name: AchievementGrantStats :one
SELECT (SELECT count(*) FROM member_achievements m WHERE m.achievement_id = sqlc.arg('id')::uuid AND m.revoked_at IS NULL)::bigint AS granted,
    EXISTS (SELECT 1 FROM member_achievements m WHERE m.achievement_id = sqlc.arg('id')::uuid)::boolean AS in_use;

-- name: LockWorkspaceAchievements :exec
-- Serializes achievement creation of one workspace between the count and the insert.
SELECT pg_advisory_xact_lock(hashtext('calaba.achievements.' || sqlc.arg('workspace_id')::uuid::text));

-- name: CountWorkspaceAchievements :one
SELECT count(*)::integer FROM achievements WHERE workspace_id = $1;

-- name: InsertAchievement :one
-- A new entry goes to the end of the workspace's catalog.
INSERT INTO achievements (workspace_id, title, description, file_id, image_size, width, height, position, created_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('title'), sqlc.arg('description'), sqlc.arg('file_id'), sqlc.arg('image_size'),
    sqlc.arg('width'), sqlc.arg('height'),
    (SELECT coalesce(max(position) + 1, 0) FROM achievements WHERE workspace_id = sqlc.arg('workspace_id')), sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateAchievement :one
UPDATE achievements SET title = $2, description = $3, file_id = $4, image_size = $5, width = $6,
    height = $7, position = $8, archived_at = $9, legacy_image_key = $10, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteAchievement :execrows
-- Only an entry that was never granted (revoked grants count): 0 rows = in use or gone.
DELETE FROM achievements a WHERE a.id = $1
  AND NOT EXISTS (SELECT 1 FROM member_achievements m WHERE m.achievement_id = a.id);

-- name: IsWorkspaceAchievement :one
-- The file is the picture of an achievement (files.CanRead: members of its workspace).
SELECT EXISTS (SELECT 1 FROM achievements WHERE file_id = $1)::boolean;

-- name: NextLegacyAchievement :one
-- An entry copied from the former host catalog whose picture still waits for its file
-- (migration 00063); skipped when another instance is on it.
SELECT * FROM achievements WHERE legacy_image_key IS NOT NULL
ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;

-- name: ListLegacyAchievementBlobs :many
-- Former host pictures no entry waits for any more: safe to delete from the blob store.
SELECT b.key FROM achievement_legacy_blobs b
WHERE NOT EXISTS (SELECT 1 FROM achievements a WHERE a.legacy_image_key = b.key)
ORDER BY b.key;

-- name: CountLegacyAchievementBlobs :one
SELECT count(*)::integer FROM achievement_legacy_blobs;

-- name: DeleteLegacyAchievementBlob :exec
DELETE FROM achievement_legacy_blobs WHERE key = $1;

-- name: InsertMemberAchievement :one
INSERT INTO member_achievements (workspace_id, user_id, achievement_id, granted_by, note)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: SetMemberAchievementMessage :exec
UPDATE member_achievements SET message_id = $2 WHERE id = $1;

-- name: RevokeMemberAchievement :one
UPDATE member_achievements SET revoked_at = now(), revoked_by = sqlc.narg('revoked_by')
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id') AND user_id = sqlc.arg('user_id')
  AND revoked_at IS NULL
RETURNING *;

-- name: ListMemberAchievements :many
-- A member's live grants, newest first, with the room of each chat card.
SELECT sqlc.embed(a), m.room_id AS card_room_id
FROM member_achievements a
LEFT JOIN messages m ON m.id = a.message_id
WHERE a.workspace_id = $1 AND a.user_id = $2 AND a.revoked_at IS NULL
ORDER BY a.granted_at DESC, a.id DESC;

-- name: RecountMemberAchievements :one
-- Stores and returns the member's live grant count (WorkspaceMember.achievement_count).
UPDATE workspace_members wm SET achievement_count = (
    SELECT count(*) FROM member_achievements a
    WHERE a.workspace_id = wm.workspace_id AND a.user_id = wm.user_id AND a.revoked_at IS NULL)
WHERE wm.workspace_id = $1 AND wm.user_id = $2
RETURNING *;

-- name: GetAnnouncementRoom :one
-- The room of server cards of a workspace (birthdays, achievements): announcement_room(),
-- migration 00061. No row = the workspace has no text room.
SELECT r.id FROM rooms r WHERE r.id = announcement_room(sqlc.arg('workspace_id')::uuid);

-- name: InsertCardMention :exec
-- A server card mentions the member it is about (its author): the mention inbox and counters
-- treat it as an @-mention. Only a member of the room's workspace.
INSERT INTO message_mentions (user_id, message_id, room_id)
SELECT sqlc.arg('user_id')::uuid, sqlc.arg('message_id')::uuid, sqlc.arg('room_id')::uuid
WHERE EXISTS (SELECT 1 FROM workspace_members wm
    WHERE wm.user_id = sqlc.arg('user_id')::uuid AND wm.workspace_id = sqlc.arg('workspace_id')::uuid)
ON CONFLICT DO NOTHING;

-- name: SetLegacyAchievementFile :exec
-- The copied picture of a former host entry (migration 00063); file_id NULL = it was lost.
UPDATE achievements SET file_id = sqlc.narg('file_id'), legacy_image_key = NULL
WHERE id = sqlc.arg('id') AND legacy_image_key IS NOT NULL;

-- name: AddWorkspaceUsage :exec
-- Counts server-made bytes into the workspace usage without the quota check (a one-shot data
-- migration must not fail on a full workspace).
UPDATE workspaces SET storage_used_bytes = storage_used_bytes + sqlc.arg('size')::bigint WHERE id = sqlc.arg('id');
