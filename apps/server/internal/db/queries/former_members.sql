-- Former members (ADR-0097) and the guest-membership inactivity sweep (ADR-0098).

-- name: RemoveMemberAsFormer :one
-- Deletes the membership and keeps a former-member row with a snapshot of the profile, in one
-- statement. No row = was not a member.
WITH gone AS (
    DELETE FROM workspace_members wm
    WHERE wm.workspace_id = sqlc.arg('workspace_id')::uuid AND wm.user_id = sqlc.arg('user_id')::uuid
    RETURNING wm.workspace_id, wm.user_id, wm.nickname, wm.role, wm.joined_at
)
INSERT INTO workspace_former_members AS f
    (workspace_id, user_id, display_name, avatar_file_id, nickname, role, joined_at, left_at, reason, removed_by)
SELECT g.workspace_id, g.user_id, u.display_name, u.avatar_file_id, g.nickname, g.role, g.joined_at, now(),
       sqlc.arg('reason')::text, sqlc.narg('removed_by')::uuid
FROM gone g JOIN users u ON u.id = g.user_id
ON CONFLICT (workspace_id, user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name, avatar_file_id = EXCLUDED.avatar_file_id, nickname = EXCLUDED.nickname,
    role = EXCLUDED.role, joined_at = EXCLUDED.joined_at, left_at = EXCLUDED.left_at, reason = EXCLUDED.reason,
    removed_by = EXCLUDED.removed_by
RETURNING *;

-- name: RemoveUserMembershipsAsFormer :many
-- A guest account expires (ADR-0098): every membership goes, each kept as a former member.
WITH gone AS (
    DELETE FROM workspace_members wm WHERE wm.user_id = sqlc.arg('user_id')::uuid
    RETURNING wm.workspace_id, wm.user_id, wm.nickname, wm.role, wm.joined_at
)
INSERT INTO workspace_former_members AS f
    (workspace_id, user_id, display_name, avatar_file_id, nickname, role, joined_at, left_at, reason, removed_by)
SELECT g.workspace_id, g.user_id, u.display_name, u.avatar_file_id, g.nickname, g.role, g.joined_at, now(),
       sqlc.arg('reason')::text, NULL
FROM gone g JOIN users u ON u.id = g.user_id
ON CONFLICT (workspace_id, user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name, avatar_file_id = EXCLUDED.avatar_file_id, nickname = EXCLUDED.nickname,
    role = EXCLUDED.role, joined_at = EXCLUDED.joined_at, left_at = EXCLUDED.left_at, reason = EXCLUDED.reason,
    removed_by = NULL
RETURNING *;

-- name: GetFormerMember :one
SELECT * FROM workspace_former_members WHERE workspace_id = $1 AND user_id = $2;

-- name: ListWorkspaceUserRefs :many
-- GET …/users?ids= (ADR-0097 §2): the ids that are or were members of the workspace; any other
-- id is left out. former_* are the snapshot (an anonymised guest account shows it).
SELECT u.id, u.display_name, u.avatar_file_id, u.username, u.is_guest, u.is_bot, u.disabled_at,
       (m.user_id IS NOT NULL)::boolean AS is_member,
       f.display_name AS former_name, f.avatar_file_id AS former_avatar, f.left_at, f.reason
FROM users u
LEFT JOIN workspace_members m ON m.workspace_id = sqlc.arg('workspace_id')::uuid AND m.user_id = u.id
LEFT JOIN workspace_former_members f ON f.workspace_id = sqlc.arg('workspace_id')::uuid AND f.user_id = u.id
WHERE u.id = ANY(sqlc.arg('ids')::uuid[]) AND (m.user_id IS NOT NULL OR f.user_id IS NOT NULL);

-- name: ListFormerMembers :many
-- GET …/former-members (ADR-0097 §3): newest first, keyset by (left_at, user_id). Former guests
-- (guest role or guest account) only with include_guests. q: an ILIKE pattern ('' = all).
-- Bots are never former members.
-- open_tasks: open tasks of live boards of the workspace where the user is an assignee.
SELECT sqlc.embed(f), u.display_name AS live_name, u.avatar_file_id AS live_avatar, u.username,
       u.is_guest, u.is_bot, u.disabled_at,
       (SELECT count(*) FROM task_assignees a
        JOIN tasks t ON t.id = a.task_id AND t.archived_at IS NULL
        JOIN board_statuses st ON st.id = t.status_id AND st.type NOT IN ('completed', 'cancelled')
        JOIN boards b ON b.id = t.board_id AND b.archived_at IS NULL AND b.workspace_id = f.workspace_id
        WHERE a.user_id = f.user_id)::integer AS open_tasks
FROM workspace_former_members f JOIN users u ON u.id = f.user_id
WHERE f.workspace_id = sqlc.arg('workspace_id')::uuid AND NOT u.is_bot
  AND (sqlc.arg('include_guests')::boolean OR NOT (f.role = 'guest' OR u.is_guest))
  AND (sqlc.arg('q')::text = '' OR u.display_name ILIKE sqlc.arg('q')::text OR f.display_name ILIKE sqlc.arg('q')::text
       OR coalesce(u.username, '') ILIKE sqlc.arg('q')::text OR f.nickname ILIKE sqlc.arg('q')::text)
  AND (sqlc.narg('before_at')::timestamptz IS NULL
       OR (f.left_at, f.user_id) < (sqlc.narg('before_at')::timestamptz, sqlc.narg('before_id')::uuid))
ORDER BY f.left_at DESC, f.user_id DESC
LIMIT sqlc.arg('lim')::integer;

-- name: TouchGuestMemberships :exec
-- Activity of a user's guest memberships (ADR-0098): API requests (with the session touch) and
-- gateway IDENTIFY, written at most every 5 minutes.
UPDATE workspace_members SET last_active_at = now()
WHERE user_id = $1 AND role = 'guest' AND (last_active_at IS NULL OR last_active_at < now() - interval '5 minutes');

-- name: ListIdleGuestMemberships :many
-- Guest memberships of registered users idle since before `before` (guest accounts expire as a
-- whole: ListExpiredGuests; bots are never guests).
SELECT m.workspace_id, m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.role = 'guest' AND coalesce(m.last_active_at, m.joined_at) < sqlc.arg('before')::timestamptz
  AND NOT u.is_guest AND NOT u.is_bot
ORDER BY coalesce(m.last_active_at, m.joined_at)
LIMIT 200;

-- name: LockIdleGuestMembership :one
-- Re-checks the idle guest membership under a row lock inside the sweep transaction (an
-- activity touch may have just renewed it, a promotion made it a member).
SELECT user_id FROM workspace_members
WHERE workspace_id = $1 AND user_id = $2 AND role = 'guest'
  AND coalesce(last_active_at, joined_at) < sqlc.arg('before')::timestamptz
FOR UPDATE;
