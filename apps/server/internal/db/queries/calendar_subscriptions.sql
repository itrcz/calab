-- name: GetCalendarSubscription :one
SELECT * FROM calendar_subscriptions WHERE workspace_id = $1 AND user_id = $2;

-- name: GetCalendarSubscriptionByID :one
SELECT * FROM calendar_subscriptions WHERE id = $1;

-- name: ActivateCalendarSubscription :one
INSERT INTO calendar_subscriptions (id, workspace_id, user_id) VALUES ($1, $2, $3)
ON CONFLICT (workspace_id, user_id) DO UPDATE SET user_id = EXCLUDED.user_id
RETURNING *;

-- name: RotateCalendarSubscription :one
UPDATE calendar_subscriptions SET id = sqlc.arg('new_id')
WHERE workspace_id = $1 AND user_id = $2 RETURNING *;

-- name: DeleteCalendarSubscription :exec
DELETE FROM calendar_subscriptions WHERE workspace_id = $1 AND user_id = $2;

-- name: ListCalendarExportEvents :many
SELECT e.* FROM events e
WHERE e.workspace_id = $1 AND e.cancelled_at IS NULL
  AND e.starts_at < sqlc.arg('to')
  AND ((e.rrule IS NULL AND e.ends_at > sqlc.arg('from'))
       OR (e.rrule IS NOT NULL AND (e.until_at IS NULL OR e.until_at > sqlc.arg('from'))))
  AND (e.organizer_id = sqlc.arg('user_id')
       OR EXISTS (SELECT 1 FROM event_attendees a
                  WHERE a.event_id = e.id AND a.user_id = sqlc.arg('user_id') AND a.status <> 'declined'))
ORDER BY e.starts_at, e.id LIMIT 1001;
