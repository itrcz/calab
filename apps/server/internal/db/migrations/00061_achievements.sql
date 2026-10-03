-- Achievements (ADR-0061).
--
-- achievements          the host catalog (one per installation, kept by the superadmins); the
--                       picture is a blob.Store object "achievements/<uuid>.webp" outside the
--                       files table and every quota. archived_at: cannot be granted any more.
-- member_achievements   grants to workspace members with a «for what» note; revoked_at keeps the
--                       row (the chat card stays). achievement_id is RESTRICT: a catalog entry
--                       with grants is archived, never deleted.
-- workspace_members.achievement_count
--                       live grants of the member (WorkspaceMember.achievement_count), kept by
--                       the grant / revoke transaction; a BEFORE INSERT trigger recounts it when
--                       a former member joins again (their grants are kept).
-- announcement_room()   the room of server cards (birthdays, achievements): the workspace's first
--                       text room in sidebar order, a non-private one preferred.
--
-- Safe on a populated database: workspace_members only gets a column with a constant default
-- (metadata-only since PG 11); every index is on a new, empty table.

-- +goose Up
-- ALTER TABLE workspace_members takes ACCESS EXCLUSIVE: fail fast instead of queueing every
-- member read behind a long transaction (see 00055).
SET LOCAL lock_timeout = '10s';

CREATE TABLE achievements (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
    description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
    image_key   text NOT NULL,
    image_size  integer NOT NULL CHECK (image_size > 0),
    width       integer NOT NULL,
    height      integer NOT NULL,
    position    integer NOT NULL DEFAULT 0,
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);
CREATE INDEX achievements_position_idx ON achievements (position, id);

CREATE TABLE member_achievements (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    achievement_id uuid NOT NULL REFERENCES achievements (id) ON DELETE RESTRICT,
    granted_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    note           text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 120),
    message_id     uuid REFERENCES messages (id) ON DELETE SET NULL,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    revoked_at     timestamptz,
    revoked_by     uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX member_achievements_member_idx ON member_achievements (workspace_id, user_id, granted_at DESC)
    WHERE revoked_at IS NULL;
CREATE INDEX member_achievements_achievement_idx ON member_achievements (achievement_id);
CREATE INDEX member_achievements_message_idx ON member_achievements (message_id) WHERE message_id IS NOT NULL;

ALTER TABLE workspace_members ADD COLUMN achievement_count integer NOT NULL DEFAULT 0;

-- +goose StatementBegin
CREATE FUNCTION workspace_member_achievement_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.achievement_count := (SELECT count(*) FROM member_achievements a
        WHERE a.workspace_id = NEW.workspace_id AND a.user_id = NEW.user_id AND a.revoked_at IS NULL);
    RETURN NEW;
END
$$;
-- +goose StatementEnd
CREATE TRIGGER workspace_member_achievement_count BEFORE INSERT ON workspace_members
    FOR EACH ROW EXECUTE FUNCTION workspace_member_achievement_count();

-- +goose StatementBegin
CREATE FUNCTION announcement_room(ws uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT r.id FROM rooms r
    LEFT JOIN room_categories c ON c.id = r.category_id
    WHERE r.workspace_id = ws AND r.type = 'text' AND r.archived_at IS NULL
    ORDER BY r.is_private, (r.category_id IS NOT NULL), c.position, r.position, r.id
    LIMIT 1
$$;
-- +goose StatementEnd

-- +goose Down
SET LOCAL lock_timeout = '10s';
DROP FUNCTION announcement_room(uuid);
DROP TRIGGER workspace_member_achievement_count ON workspace_members;
DROP FUNCTION workspace_member_achievement_count();
ALTER TABLE workspace_members DROP COLUMN achievement_count;
DROP TABLE member_achievements;
DROP TABLE achievements;
