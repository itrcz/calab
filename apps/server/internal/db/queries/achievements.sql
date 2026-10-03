-- Achievements (ADR-0061): the host catalog and grants to workspace members.

-- name: ListAchievements :many
-- The whole catalog in its order, archived entries included.
SELECT * FROM achievements ORDER BY position, id;

-- name: GetAchievement :one
SELECT * FROM achievements WHERE id = $1;

-- name: LockAchievement :one
SELECT * FROM achievements WHERE id = $1 FOR UPDATE;

-- name: InsertAchievement :one
-- A new entry goes to the end of the catalog.
INSERT INTO achievements (title, description, image_key, image_size, width, height, position, created_by)
VALUES (sqlc.arg('title'), sqlc.arg('description'), sqlc.arg('image_key'), sqlc.arg('image_size'),
    sqlc.arg('width'), sqlc.arg('height'),
    (SELECT coalesce(max(position) + 1, 0) FROM achievements), sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateAchievement :one
UPDATE achievements SET title = $2, description = $3, image_key = $4, image_size = $5, width = $6,
    height = $7, position = $8, archived_at = $9, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteAchievement :execrows
-- Only an entry that was never granted (revoked grants count): 0 rows = in use or gone.
DELETE FROM achievements a WHERE a.id = $1
  AND NOT EXISTS (SELECT 1 FROM member_achievements m WHERE m.achievement_id = a.id);

-- name: AdminAchievementStats :many
-- Live grants and the workspaces they are in, per catalog entry.
SELECT achievement_id, count(*)::bigint AS granted, count(DISTINCT workspace_id)::bigint AS workspaces
FROM member_achievements WHERE revoked_at IS NULL
GROUP BY achievement_id;

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
