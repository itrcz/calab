-- name: ListBirthdayCandidates :many
-- People whose month * 100 + day is one of the given dates (the worker passes the dates that
-- are "today" somewhere on Earth); hidden birthdays, guests, bots and disabled accounts are out.
SELECT id, timezone, birthday_day, birthday_month FROM users
WHERE birthday_day IS NOT NULL AND NOT birthday_hidden AND NOT is_guest AND NOT is_bot AND disabled_at IS NULL
  AND (birthday_month * 100 + birthday_day) = ANY(sqlc.arg('dates')::integer[]);

-- name: ListBirthdayRooms :many
-- Where a user's birthday card goes: every workspace they are a non-guest member of that is
-- not suspended and has someone else (not a bot) in it, with its first text room in sidebar
-- order (top level first, then categories by position); a room everyone can see (not private)
-- is preferred — announcement_room() (migration 00061), shared with achievement cards.
-- Workspaces without a text room are skipped. owner_timezone: the workspace owner's zone, the
-- fallback of the greeting time when the user has none (birthdays.GreetZone).
SELECT m.workspace_id, fr.id::uuid AS room_id, ow.timezone AS owner_timezone
FROM workspace_members m
JOIN workspaces w ON w.id = m.workspace_id AND w.suspended_at IS NULL
JOIN users ow ON ow.id = w.owner_id
JOIN LATERAL (SELECT announcement_room(m.workspace_id) AS id) fr ON fr.id IS NOT NULL
WHERE m.user_id = $1 AND m.role <> 'guest'
  AND EXISTS (
      SELECT 1 FROM workspace_members o JOIN users u ON u.id = o.user_id
      WHERE o.workspace_id = m.workspace_id AND o.user_id <> m.user_id AND NOT u.is_bot);

-- name: ClaimBirthdayGreeting :execrows
-- One card per (user, workspace, the user's local date): 0 rows = already posted.
INSERT INTO birthday_greetings (user_id, workspace_id, day) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: SetBirthdayGreetingMessage :exec
UPDATE birthday_greetings SET message_id = $4 WHERE user_id = $1 AND workspace_id = $2 AND day = $3;

-- name: DeleteOldBirthdayGreetings :execrows
-- The dedup only needs the last few days.
DELETE FROM birthday_greetings WHERE day < sqlc.arg('before')::date;

-- name: ListWorkspaceBirthdays :many
-- Members of a workspace with a visible birthday (GET /api/workspaces/{id}/birthdays).
SELECT u.id, u.birthday_day, u.birthday_month, u.birthday_year
FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND u.birthday_day IS NOT NULL AND NOT u.birthday_hidden AND NOT u.is_bot;

-- name: ListMemberBirthdays :many
-- Every member's birthday, hidden ones included, for the admin table (docs/09 #77): bots and
-- guests are left out.
SELECT u.id, u.birthday_day, u.birthday_month, u.birthday_year, u.birthday_hidden
FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND u.birthday_day IS NOT NULL AND NOT u.is_bot AND m.role <> 'guest';
