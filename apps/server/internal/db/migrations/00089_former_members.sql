-- Former members (ADR-0097) and guests leaving after 48 h without activity (ADR-0098).
--
-- workspace_former_members  one row per user who left a workspace and has not come back:
--                           a snapshot of the name / avatar / nickname / highest built-in role
--                           and joined_at, with when, why and by whom. Written in the
--                           transaction that deletes the membership; AddMember deletes it again
--                           (back = an ordinary member). joined_at NULL = unknown (backfill).
--                           removed_by NULL = themself, the server or a deleted account.
-- workspace_members.last_active_at
--                           last activity of a guest membership (API request at most every
--                           5 min, gateway IDENTIFY); NULL = never touched, joined_at counts.
--                           Only guest rows are written; the hourly sweep removes registered
--                           users' guest memberships idle for GUEST_INACTIVITY.
--
-- Backfill: authors of messages and task actors / assignees of a workspace who are not members
-- any more become former members ('removed', left_at = their last trace there), so that old
-- "unknown" authors get their names back. Guest accounts get at most 48 h left
-- (guest_expires_at = least(current, now + 48h)); guest memberships start from the user's last
-- session activity, so that the first sweep does not remove guests seen yesterday.
--
-- Safe on a populated database: a nullable column without a default on workspace_members
-- (metadata only) and a partial index on its guest rows; one pass over messages and task
-- tables for the backfill.

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE workspace_former_members (
    workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    display_name   text NOT NULL,
    avatar_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
    nickname       text NOT NULL DEFAULT '',
    role           text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    joined_at      timestamptz,
    left_at        timestamptz NOT NULL DEFAULT now(),
    reason         text NOT NULL CHECK (reason IN ('left', 'removed', 'banned', 'guest_expired', 'directory_disabled')),
    removed_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    PRIMARY KEY (workspace_id, user_id)
);
-- The list (newest first) and user deletion / the avatar FK.
CREATE INDEX workspace_former_members_left_idx ON workspace_former_members (workspace_id, left_at DESC, user_id);
CREATE INDEX workspace_former_members_user_idx ON workspace_former_members (user_id);
CREATE INDEX workspace_former_members_avatar_idx ON workspace_former_members (avatar_file_id) WHERE avatar_file_id IS NOT NULL;
CREATE INDEX workspace_former_members_removed_by_idx ON workspace_former_members (removed_by) WHERE removed_by IS NOT NULL;

-- The one pass over messages / task tables runs before workspace_members is altered: the
-- ACCESS EXCLUSIVE lock of ALTER TABLE is then held only for the short guest updates below,
-- not for the whole scan (every permission check reads workspace_members).
INSERT INTO workspace_former_members (workspace_id, user_id, display_name, avatar_file_id, role, left_at, reason)
SELECT t.workspace_id, t.user_id, u.display_name, u.avatar_file_id,
       CASE WHEN u.is_guest THEN 'guest' ELSE 'member' END, max(t.at), 'removed'
FROM (
    SELECT r.workspace_id, m.author_id AS user_id, m.created_at AS at
    FROM messages m JOIN rooms r ON r.id = m.room_id
    WHERE r.workspace_id IS NOT NULL
    UNION ALL
    SELECT b.workspace_id, a.actor_id, a.created_at
    FROM task_activity a JOIN boards b ON b.id = a.board_id
    WHERE a.actor_id IS NOT NULL
    UNION ALL
    SELECT b.workspace_id, t.created_by, t.created_at
    FROM tasks t JOIN boards b ON b.id = t.board_id
    WHERE t.created_by IS NOT NULL
    UNION ALL
    SELECT b.workspace_id, ta.user_id, ta.assigned_at
    FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id JOIN boards b ON b.id = t.board_id
) t
JOIN users u ON u.id = t.user_id AND NOT u.is_bot -- a removed bot is not a former member
WHERE NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id AND wm.user_id = t.user_id)
GROUP BY t.workspace_id, t.user_id, u.display_name, u.avatar_file_id, u.is_guest
ON CONFLICT DO NOTHING;

ALTER TABLE workspace_members ADD COLUMN last_active_at timestamptz;
CREATE INDEX workspace_members_guest_active_idx ON workspace_members ((coalesce(last_active_at, joined_at)))
    WHERE role = 'guest';

UPDATE workspace_members m SET last_active_at = s.seen
FROM (SELECT user_id, max(last_seen_at) AS seen FROM sessions GROUP BY user_id) s
WHERE m.role = 'guest' AND s.user_id = m.user_id;

UPDATE users SET guest_expires_at = least(guest_expires_at, now() + interval '48 hours')
WHERE is_guest AND guest_expires_at IS NOT NULL;

-- +goose Down
SET LOCAL lock_timeout = '10s';
DROP INDEX workspace_members_guest_active_idx;
ALTER TABLE workspace_members DROP COLUMN last_active_at;
DROP TABLE workspace_former_members;
