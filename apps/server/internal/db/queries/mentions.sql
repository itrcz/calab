-- name: InsertMentions :exec
-- Direct mentions: only members of the room's workspace, never the author, never a person
-- who blocked the author (a bot, ADR-0031).
INSERT INTO message_mentions (user_id, message_id, room_id)
SELECT u, sqlc.arg('message_id')::uuid, sqlc.arg('room_id')::uuid
FROM unnest(sqlc.arg('user_ids')::uuid[]) AS u
JOIN workspace_members wm ON wm.user_id = u AND wm.workspace_id = sqlc.arg('workspace_id')::uuid
WHERE u <> sqlc.arg('author_id')::uuid
  AND NOT EXISTS (SELECT 1 FROM bot_blocks bb WHERE bb.user_id = u AND bb.bot_user_id = sqlc.arg('author_id')::uuid)
ON CONFLICT DO NOTHING;

-- name: InsertEveryoneMention :exec
INSERT INTO message_everyone_mentions (message_id, room_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: DeleteMentions :exec
DELETE FROM message_mentions WHERE message_id = $1;

-- name: DeleteEveryoneMention :exec
DELETE FROM message_everyone_mentions WHERE message_id = $1;

-- name: DismissMentions :exec
-- The ✕ on inbox cards (CBF-155, ADR-0163): only messages that mention the caller now (directly
-- or @everyone) — an unknown or foreign id is skipped, never a foreign-key error that would tell
-- it exists, and no row is written about a message the caller was never shown.
INSERT INTO mention_dismissals (user_id, message_id)
SELECT sqlc.arg('user_id')::uuid, m.id FROM messages m
WHERE m.id = ANY(sqlc.arg('message_ids')::uuid[])
  AND (EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = sqlc.arg('user_id')::uuid)
       OR EXISTS (SELECT 1 FROM message_everyone_mentions e WHERE e.message_id = m.id))
ON CONFLICT DO NOTHING;

-- name: DeleteMentionDismissals :exec
-- A deleted message leaves every inbox for good: its dismissals go with its mention rows.
DELETE FROM mention_dismissals WHERE message_id = $1;

-- name: ListMentions :many
-- Newest first. Each branch is an index range scan limited to one page; own messages and
-- deleted ones are excluded (mention rows are removed on delete, the filter is a safety net).
-- Dismissed ones (CBF-155) are skipped inside each branch, so a page stays full.
WITH ids AS (
    (SELECT mm.message_id AS id FROM message_mentions mm
     WHERE mm.user_id = sqlc.arg('user_id')::uuid AND mm.room_id = ANY(sqlc.arg('room_ids')::uuid[])
       AND (sqlc.narg('before')::uuid IS NULL OR mm.message_id < sqlc.narg('before')::uuid)
       AND NOT EXISTS (SELECT 1 FROM mention_dismissals d WHERE d.user_id = sqlc.arg('user_id')::uuid AND d.message_id = mm.message_id)
     ORDER BY mm.message_id DESC LIMIT sqlc.arg('lim'))
    UNION
    (SELECT e.message_id FROM message_everyone_mentions e
     JOIN messages em ON em.id = e.message_id AND em.author_id <> sqlc.arg('user_id')::uuid
     WHERE e.room_id = ANY(sqlc.arg('room_ids')::uuid[])
       AND (sqlc.narg('before')::uuid IS NULL OR e.message_id < sqlc.narg('before')::uuid)
       AND NOT EXISTS (SELECT 1 FROM mention_dismissals d WHERE d.user_id = sqlc.arg('user_id')::uuid AND d.message_id = e.message_id)
     ORDER BY e.message_id DESC LIMIT sqlc.arg('lim'))
)
SELECT m.* FROM messages m
JOIN ids ON ids.id = m.id
WHERE m.deleted_at IS NULL
ORDER BY m.id DESC
LIMIT sqlc.arg('lim');

-- name: UpsertRoomNotificationSettings :one
INSERT INTO room_notification_settings (user_id, room_id, level, muted_until)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, room_id) DO UPDATE SET level = EXCLUDED.level, muted_until = EXCLUDED.muted_until
RETURNING *;

-- name: DeleteRoomNotificationSettings :exec
DELETE FROM room_notification_settings WHERE user_id = $1 AND room_id = $2;

-- name: ListRoomNotificationSettings :many
-- Stored settings of the given rooms (the ones the user can view now).
SELECT s.* FROM room_notification_settings s
WHERE s.user_id = sqlc.arg('user_id')::uuid AND s.room_id = ANY(sqlc.arg('room_ids')::uuid[]);

-- name: UpsertWorkspaceNotificationSettings :one
INSERT INTO workspace_notification_settings (user_id, workspace_id, level, muted_until, task_level)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, workspace_id) DO UPDATE SET level = EXCLUDED.level, muted_until = EXCLUDED.muted_until, task_level = EXCLUDED.task_level
RETURNING *;

-- name: GetWorkspaceTaskLevel :one
-- The stored «Задачи» level of the user in the workspace ('all' without a row, ADR-0042).
SELECT coalesce((SELECT s.task_level FROM workspace_notification_settings s
    WHERE s.user_id = $1 AND s.workspace_id = $2), 'all')::text;

-- name: DeleteWorkspaceNotificationSettings :exec
DELETE FROM workspace_notification_settings WHERE user_id = $1 AND workspace_id = $2;

-- name: ListWorkspaceNotificationSettings :many
-- Stored settings of the workspaces the user is a member of now.
SELECT s.* FROM workspace_notification_settings s
JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
WHERE s.user_id = $1;
