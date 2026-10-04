-- Workspace calendar (ADR-0038).

-- name: InsertEvent :one
INSERT INTO events (workspace_id, room_id, title, description, starts_at, ends_at, all_day, tz, organizer_id, record, rrule, until_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: GetEvent :one
SELECT * FROM events WHERE id = $1;

-- name: GetEventForUpdate :one
SELECT * FROM events WHERE id = $1 AND cancelled_at IS NULL FOR UPDATE;

-- name: UpdateEvent :one
UPDATE events SET room_id = $2, title = $3, description = $4, starts_at = $5, ends_at = $6, all_day = $7,
    tz = $8, record = $9, rrule = $10, until_at = $11, sequence = sequence + sqlc.arg('bump')::integer, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: BumpEventSequence :one
UPDATE events SET sequence = sequence + 1, updated_at = now() WHERE id = $1 RETURNING *;

-- name: CancelEvent :one
UPDATE events SET cancelled_at = now(), sequence = sequence + 1, updated_at = now()
WHERE id = $1 AND cancelled_at IS NULL
RETURNING *;

-- name: ListWorkspaceEvents :many
-- Live events of a workspace with an occurrence possibly overlapping [from, to).
SELECT * FROM events
WHERE workspace_id = $1 AND cancelled_at IS NULL
  AND starts_at < sqlc.arg('to') AND (until_at IS NULL OR until_at > sqlc.arg('from'))
ORDER BY starts_at, id;

-- name: ListUserEvents :many
-- Live events the user organizes or attends in workspaces where they are a member (not a
-- guest), possibly overlapping [from, to).
SELECT e.* FROM events e
JOIN workspace_members m ON m.workspace_id = e.workspace_id AND m.user_id = sqlc.arg('user_id') AND m.role <> 'guest'
WHERE e.cancelled_at IS NULL
  AND e.starts_at < sqlc.arg('to') AND (e.until_at IS NULL OR e.until_at > sqlc.arg('from'))
  AND (e.organizer_id = sqlc.arg('user_id')
       OR EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = sqlc.arg('user_id')))
ORDER BY e.starts_at, e.id;

-- name: ListRoomEventsNear :many
-- Live events with a room in the workspaces that may have an occurrence around now (the room
-- badge of the snapshots of a READY, ADR-0038 §6).
SELECT * FROM events
WHERE workspace_id = ANY(sqlc.arg('workspace_ids')::uuid[]) AND cancelled_at IS NULL AND room_id IS NOT NULL
  AND starts_at < sqlc.arg('to') AND (until_at IS NULL OR until_at > sqlc.arg('from'))
ORDER BY starts_at, id;

-- name: ListDueEvents :many
-- Events that may have an occurrence starting or ending in [from, to): the sweeper's input.
SELECT * FROM events
WHERE cancelled_at IS NULL AND starts_at < sqlc.arg('to') AND (until_at IS NULL OR until_at > sqlc.arg('from'))
ORDER BY starts_at, id
LIMIT 5000;

-- name: ListEventAttendees :many
SELECT * FROM event_attendees WHERE event_id = ANY(sqlc.arg('event_ids')::uuid[])
ORDER BY event_id, (user_id IS NULL), user_id, email;

-- name: ListEventExceptions :many
SELECT * FROM event_exceptions WHERE event_id = ANY(sqlc.arg('event_ids')::uuid[]) ORDER BY event_id, occurrence_at;

-- name: ListEventRecordings :many
SELECT * FROM event_recordings WHERE event_id = ANY(sqlc.arg('event_ids')::uuid[]);

-- name: InsertEventAttendee :exec
INSERT INTO event_attendees (event_id, user_id, email, required, status, responded_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: UpdateEventAttendeeRequired :exec
UPDATE event_attendees SET required = $3 WHERE event_id = $1 AND user_id = $2;

-- name: UpdateExternalAttendeeRequired :exec
UPDATE event_attendees SET required = $3 WHERE event_id = $1 AND email = $2;

-- name: DeleteEventAttendee :exec
DELETE FROM event_attendees WHERE event_id = $1 AND user_id = $2;

-- name: DeleteExternalAttendee :exec
DELETE FROM event_attendees WHERE event_id = $1 AND email = $2;

-- name: SetEventAttendeeStatus :one
UPDATE event_attendees SET status = $3, responded_at = now()
WHERE event_id = $1 AND user_id = $2
RETURNING *;

-- name: SetExternalAttendeeStatus :one
UPDATE event_attendees SET status = $3, responded_at = CASE WHEN status = $3 THEN responded_at ELSE now() END
WHERE event_id = $1 AND email = $2
RETURNING *;

-- name: SetEventAttendeeInvite :exec
UPDATE event_attendees SET invite_id = $3 WHERE event_id = $1 AND email = $2;

-- name: InsertEventException :execrows
INSERT INTO event_exceptions (event_id, occurrence_at) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: ClaimEventReminder :execrows
INSERT INTO event_reminders_sent (event_id, occurrence_at, user_id, minutes) VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: ClaimEventRoomSignal :execrows
INSERT INTO event_room_signals (event_id, occurrence_at, kind) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: DeleteOldEventSignals :exec
WITH r AS (DELETE FROM event_reminders_sent WHERE event_reminders_sent.sent_at < sqlc.arg('before'))
DELETE FROM event_room_signals WHERE event_room_signals.sent_at < sqlc.arg('before');

-- name: ListReminderTargets :many
-- Attendees and organizers of the events who are still non-guest members of the event's
-- workspace, with their reminder settings and answer (an organizer not on the list: accepted).
SELECT e.id AS event_id, u.id AS user_id, u.event_reminders, u.event_reminders_dnd,
       coalesce(a.status, 'accepted')::text AS status
FROM events e
JOIN users u ON (u.id = e.organizer_id
                 OR u.id IN (SELECT ea.user_id FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id IS NOT NULL))
JOIN workspace_members m ON m.workspace_id = e.workspace_id AND m.user_id = u.id AND m.role <> 'guest'
LEFT JOIN event_attendees a ON a.event_id = e.id AND a.user_id = u.id
WHERE e.id = ANY(sqlc.arg('event_ids')::uuid[]) AND u.disabled_at IS NULL AND NOT u.is_bot;

-- name: ListEventUsers :many
-- Users for event cards and mail: names, emails (verified or not), locales.
SELECT id, display_name, email, email_verified_at, locale, is_bot, is_guest, timezone FROM users
WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: GetUserEventReminders :one
SELECT event_reminders, event_reminders_dnd FROM users WHERE id = $1;

-- name: SetUserEventReminders :one
UPDATE users SET event_reminders = $2, event_reminders_dnd = $3 WHERE id = $1
RETURNING *;

-- name: InsertEventRecording :execrows
INSERT INTO event_recordings (event_id, occurrence_at, recording_id) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: ListEventsForRecording :many
-- Live events of the room organized by the user that may have an occurrence around `at`.
SELECT * FROM events
WHERE room_id = $1 AND organizer_id = $2 AND cancelled_at IS NULL
  AND starts_at < sqlc.arg('to') AND (until_at IS NULL OR until_at > sqlc.arg('from'));

-- name: CreateEventRoomInvite :one
INSERT INTO room_invites (room_id, code, created_by, expires_at, max_uses, allow_guests, allow_bits, not_before, event_id)
VALUES ($1, $2, $3, $4, 1, true, $5, $6, $7)
RETURNING *;

-- name: GetRoomInvite :one
SELECT * FROM room_invites WHERE id = $1;

-- name: MoveEventRoomInvite :exec
-- A meeting moved in time: its unused guest link follows the new window.
UPDATE room_invites SET not_before = $2, expires_at = $3 WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeEventRoomInvites :exec
-- Guest links of the event (all, or only those of the given ids).
UPDATE room_invites SET revoked_at = now()
WHERE event_id = $1 AND revoked_at IS NULL
  AND (sqlc.narg('ids')::uuid[] IS NULL OR id = ANY(sqlc.narg('ids')::uuid[]));

-- name: ListRoomLiveEvents :many
-- One-off meetings of a room that have not ended at `now` (ADR-0044: a temporary room closes
-- them).
SELECT * FROM events
WHERE room_id = sqlc.arg('room_id') AND cancelled_at IS NULL AND rrule IS NULL AND ends_at > sqlc.arg('now')
ORDER BY starts_at
FOR UPDATE;

-- name: EndEventAt :one
-- A running one-off meeting ends at `at` (its room closed).
UPDATE events SET ends_at = sqlc.arg('at'), sequence = sequence + 1, updated_at = now()
WHERE id = sqlc.arg('id') AND cancelled_at IS NULL AND starts_at < sqlc.arg('at') AND ends_at > sqlc.arg('at')
RETURNING *;

-- name: FollowRoomExpiryEvents :many
-- A temporary room was extended or shortened (ADR-0044): its one-off meetings that ended with the
-- room (ends_at = the old end) follow the new end; a meeting moved by hand is left alone.
UPDATE events SET ends_at = sqlc.arg('ends_at'), sequence = sequence + 1, updated_at = now()
WHERE room_id = sqlc.arg('room_id') AND cancelled_at IS NULL AND rrule IS NULL
  AND ends_at = sqlc.arg('old_ends_at') AND starts_at < sqlc.arg('ends_at')
RETURNING *;

-- name: ListEventsByIDs :many
-- Events of a search page (unified search, ADR-0062); the caller keeps its own order.
SELECT * FROM events WHERE id = ANY(sqlc.arg('ids')::uuid[]);
