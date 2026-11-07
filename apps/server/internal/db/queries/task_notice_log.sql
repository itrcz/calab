-- name: InsertTaskNotices :exec
-- The notified users of one task change (ADR-0141), one statement for all of them: the arrays
-- are zipped (equal lengths); an absent optional id is uuid.Nil.
INSERT INTO task_notice_log (id, user_id, task_id, kind, actor_id, message_id, text, rule_id, re_requested, due_on, days_left)
SELECT n.id, n.user_id, sqlc.arg('task_id')::uuid, n.kind,
       NULLIF(n.actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
       NULLIF(n.message_id, '00000000-0000-0000-0000-000000000000'::uuid),
       n.text,
       NULLIF(n.rule_id, '00000000-0000-0000-0000-000000000000'::uuid),
       n.re_requested, n.due_on, n.days_left
FROM (SELECT unnest(sqlc.arg('ids')::uuid[]) AS id, unnest(sqlc.arg('user_ids')::uuid[]) AS user_id,
             unnest(sqlc.arg('kinds')::smallint[]) AS kind, unnest(sqlc.arg('actor_ids')::uuid[]) AS actor_id,
             unnest(sqlc.arg('message_ids')::uuid[]) AS message_id, unnest(sqlc.arg('texts')::text[]) AS text,
             unnest(sqlc.arg('rule_ids')::uuid[]) AS rule_id, unnest(sqlc.arg('re_requested')::boolean[]) AS re_requested,
             unnest(sqlc.arg('due_ons')::text[]) AS due_on, unnest(sqlc.arg('days_left')::integer[]) AS days_left) AS n
ON CONFLICT DO NOTHING;

-- name: ListTaskNoticeLog :many
-- A user's task notices, newest first (one index range scan of a page).
SELECT * FROM task_notice_log
WHERE user_id = sqlc.arg('user_id')
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: DismissTaskNotices :exec
-- The ✕ on inbox cards (CBF-155, ADR-0163): the caller's own history rows only.
DELETE FROM task_notice_log
WHERE user_id = sqlc.arg('user_id')::uuid AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: PruneTaskNoticeLog :execrows
-- Rows older than the cutoff, a bounded batch per call.
DELETE FROM task_notice_log
WHERE id IN (SELECT l.id FROM task_notice_log l WHERE l.created_at < sqlc.arg('before') LIMIT 5000);
