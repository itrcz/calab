-- Free / busy, working hours and CalDAV (ADR-0041).

-- name: SetUserWorkHours :one
UPDATE users SET work_start_min = $2, work_end_min = $3, work_days = $4 WHERE id = $1
RETURNING *;

-- name: ListFreeBusyMembers :many
-- Members (not guests) of the workspace among ids that are people (not bots), enabled.
SELECT u.id, u.timezone, u.work_start_min, u.work_end_min, u.work_days FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND m.user_id = ANY(sqlc.arg('ids')::uuid[]) AND m.role <> 'guest'
  AND NOT u.is_bot AND NOT u.is_guest AND u.disabled_at IS NULL;

-- name: ListBusyEvents :many
-- Live events the users organize or attend (any workspace), possibly overlapping [from, to).
SELECT e.* FROM events e
WHERE e.cancelled_at IS NULL
  AND e.starts_at < sqlc.arg('to') AND (e.until_at IS NULL OR e.until_at > sqlc.arg('from'))
  AND (e.organizer_id = ANY(sqlc.arg('ids')::uuid[])
       OR EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = ANY(sqlc.arg('ids')::uuid[])))
ORDER BY e.starts_at, e.id;

-- name: ListRoomBusyEvents :many
-- Live events of a room possibly overlapping [from, to).
SELECT * FROM events
WHERE room_id = $1 AND cancelled_at IS NULL
  AND starts_at < sqlc.arg('to') AND (until_at IS NULL OR until_at > sqlc.arg('from'))
ORDER BY starts_at, id;

-- name: ListExternalBusy :many
-- With the owner's share_level (ADR-0045 §4): what of the details others may see.
SELECT sqlc.embed(b), coalesce(a.share_level, 'busy')::text AS share_level FROM external_busy b
LEFT JOIN caldav_accounts a ON a.user_id = b.user_id
WHERE b.user_id = ANY(sqlc.arg('ids')::uuid[]) AND b.starts_at < sqlc.arg('to') AND b.ends_at > sqlc.arg('from')
ORDER BY b.user_id, b.starts_at;

-- name: ListMyExternalEvents :many
SELECT * FROM external_busy
WHERE user_id = $1 AND starts_at < sqlc.arg('to') AND ends_at > sqlc.arg('from')
ORDER BY starts_at, ends_at, uid;

-- name: MatchMemberEmails :many
-- Members of the workspace (people, not guests; enabled) whose confirmed e-mail is one of emails
-- (lower case) — attendees of external events (ADR-0045 §3, §4).
SELECT u.id, lower(u.email)::text AS email FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND m.role <> 'guest' AND NOT u.is_bot AND NOT u.is_guest AND u.disabled_at IS NULL
  AND u.email_verified_at IS NOT NULL AND lower(u.email) = ANY(sqlc.arg('emails')::text[]);

-- name: DeleteExternalBusy :exec
DELETE FROM external_busy WHERE user_id = $1;

-- name: InsertExternalBusy :exec
INSERT INTO external_busy (user_id, uid, starts_at, ends_at, all_day, summary, location, attendees, organizer, url,
    href, etag, recurring, web_url)
SELECT sqlc.arg('user_id')::uuid, unnest(sqlc.arg('uids')::text[]), unnest(sqlc.arg('starts')::timestamptz[]),
    unnest(sqlc.arg('ends')::timestamptz[]), unnest(sqlc.arg('all_days')::boolean[]), unnest(sqlc.arg('summaries')::text[]),
    unnest(sqlc.arg('locations')::text[]), unnest(sqlc.arg('attendees')::text[])::jsonb, unnest(sqlc.arg('organizers')::text[]),
    unnest(sqlc.arg('urls')::text[]), unnest(sqlc.arg('hrefs')::text[]), unnest(sqlc.arg('etags')::text[]),
    unnest(sqlc.arg('recurrings')::boolean[]), unnest(sqlc.arg('web_urls')::text[]);

-- name: GetMyExternalEvent :one
-- One imported occurrence of the caller (ADR-0045, amendment 1): a delete names it by uid, start and href.
SELECT * FROM external_busy
WHERE user_id = $1 AND uid = $2 AND starts_at = $3 AND href = sqlc.arg('href')::text
LIMIT 1;

-- name: DeleteMyExternalSeries :execrows
DELETE FROM external_busy WHERE user_id = $1 AND uid = $2;

-- name: DeleteMyExternalOccurrence :execrows
DELETE FROM external_busy WHERE user_id = $1 AND uid = $2 AND starts_at = $3;

-- name: GetCalDavAccount :one
SELECT * FROM caldav_accounts WHERE user_id = $1;

-- name: LockCalDavAccount :one
SELECT * FROM caldav_accounts WHERE user_id = $1 FOR UPDATE;

-- name: UpsertCalDavAccount :one
INSERT INTO caldav_accounts (user_id, url, username, secret_enc, calendars, calendar_href, import, push)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (user_id) DO UPDATE SET url = EXCLUDED.url, username = EXCLUDED.username,
    secret_enc = EXCLUDED.secret_enc, calendars = EXCLUDED.calendars, calendar_href = EXCLUDED.calendar_href,
    import = EXCLUDED.import, push = EXCLUDED.push, last_sync_at = NULL, last_error = '', updated_at = now()
RETURNING *;

-- name: UpdateCalDavAccount :one
UPDATE caldav_accounts SET calendar_href = $2, import = $3, push = $4, last_error = '', updated_at = now()
WHERE user_id = $1
RETURNING *;

-- name: PatchCalDavAccount :one
-- What colleagues see (ADR-0045 §2) and the reminders (amendment 3); NULL = unchanged.
UPDATE caldav_accounts SET share_level = coalesce(sqlc.narg('share_level')::text, share_level),
    remind = coalesce(sqlc.narg('remind')::boolean, remind), updated_at = now()
WHERE user_id = $1
RETURNING *;

-- name: ListDueExternalReminders :many
-- Reminders of imported events due at now (ADR-0045 amendment 3): accounts that remind and import
-- a chosen calendar, enabled people; timed (not all-day) events starting in (now, to] whose moment
-- (start − one of the user's event_reminders) is in (since, now] — since = now − the grace.
SELECT b.user_id, b.uid, b.starts_at, b.ends_at, b.summary, b.location, b.attendees, b.organizer, b.url,
    b.href, b.recurring, b.web_url, m.minutes::int AS minutes, u.event_reminders_dnd, a.username AS login
FROM caldav_accounts a
JOIN users u ON u.id = a.user_id
CROSS JOIN LATERAL unnest(u.event_reminders) AS m (minutes)
JOIN external_busy b ON b.user_id = a.user_id
WHERE a.remind AND a.import AND a.calendar_href IS NOT NULL
  AND u.disabled_at IS NULL AND NOT u.is_bot AND NOT u.is_guest AND NOT b.all_day
  AND b.starts_at > sqlc.arg('now')::timestamptz AND b.starts_at <= sqlc.arg('to')::timestamptz
  AND b.starts_at - m.minutes * interval '1 minute' <= sqlc.arg('now')::timestamptz
  AND b.starts_at - m.minutes * interval '1 minute' > sqlc.arg('since')::timestamptz
ORDER BY b.user_id, b.starts_at, b.uid, m.minutes;

-- name: DeleteCalDavAccount :execrows
DELETE FROM caldav_accounts WHERE user_id = $1;

-- name: DeleteCalDavPushes :exec
DELETE FROM caldav_pushes WHERE user_id = $1;

-- name: SetCalDavSynced :one
UPDATE caldav_accounts SET last_sync_at = $2, last_error = $3 WHERE user_id = $1
RETURNING *;

-- name: SetCalDavError :exec
UPDATE caldav_accounts SET last_error = $2 WHERE user_id = $1;

-- name: ListDueCalDavImports :many
-- Accounts whose import is due (never synced, or last synced before `before`).
SELECT user_id FROM caldav_accounts
WHERE import AND calendar_href IS NOT NULL AND (last_sync_at IS NULL OR last_sync_at < sqlc.arg('before'))
ORDER BY last_sync_at NULLS FIRST
LIMIT sqlc.arg('lim');

-- name: EnqueueCalDavPushes :execrows
-- Queues the event for those of the users who push to a chosen calendar; a pending row gets
-- the newer change (gen + 1, due now, attempts from zero).
INSERT INTO caldav_pushes (user_id, event_id)
SELECT a.user_id, sqlc.arg('event_id')::uuid FROM caldav_accounts a
WHERE a.user_id = ANY(sqlc.arg('ids')::uuid[]) AND a.push AND a.calendar_href IS NOT NULL
ON CONFLICT (user_id, event_id) DO UPDATE SET gen = caldav_pushes.gen + 1, attempts = 0, next_at = now(), error = '';

-- name: ClaimCalDavPushes :many
-- Takes due pushes: next_at moves one lease ahead (a crashed worker's rows come back).
UPDATE caldav_pushes SET next_at = now() + sqlc.arg('lease')::interval
WHERE (user_id, event_id) IN (
    SELECT p.user_id, p.event_id FROM caldav_pushes p
    WHERE p.next_at <= now()
    ORDER BY p.next_at
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: DeleteCalDavPush :exec
DELETE FROM caldav_pushes WHERE user_id = $1 AND event_id = $2 AND gen = $3;

-- name: RetryCalDavPush :exec
UPDATE caldav_pushes SET attempts = attempts + 1, next_at = $4, error = $5
WHERE user_id = $1 AND event_id = $2 AND gen = $3;
