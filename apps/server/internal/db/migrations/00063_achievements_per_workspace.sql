-- Achievements per workspace (ADR-0061, amendment 1): the catalog moves from the host to every
-- workspace, its pictures from blob keys "achievements/<uuid>.webp" to files of the workspace.
--
-- achievements.workspace_id   the owning workspace (NOT NULL after the copy below).
-- achievements.file_id        the picture, a file of that workspace (files.CanRead: members;
--                             the orphan cleanup keeps it). NULL = no picture yet: a copied entry
--                             whose picture the server still has to make (legacy_image_key set)
--                             or whose old picture was lost.
-- achievements.legacy_image_key
--                             the blob key of the former host picture, until the server's
--                             one-shot startup task (achievements.MigrateLegacy) has copied it
--                             into a workspace file and cleared it.
-- achievement_legacy_blobs    the former host pictures to delete from the blob store once no
--                             entry still waits for its copy (the same startup task).
--
-- The copy: every host achievement with grants is copied into each workspace that has grants of
-- it (a new id per workspace); the grants and their chat cards are re-pointed to the copy; host
-- achievements without grants are deleted. All of it in this migration's transaction; only the
-- bytes are left to Go (blob I/O does not belong in SQL). achievements and member_achievements
-- are new and small (one release old).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE achievements
    ADD COLUMN workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
    ADD COLUMN file_id uuid REFERENCES files (id),
    ADD COLUMN legacy_image_key text;

CREATE TABLE achievement_legacy_blobs (key text PRIMARY KEY);
INSERT INTO achievement_legacy_blobs (key)
SELECT DISTINCT image_key FROM achievements WHERE image_key <> '';

CREATE TABLE achievement_copies AS
SELECT g.achievement_id AS old_id, g.workspace_id, uuidv7() AS new_id
FROM (SELECT DISTINCT achievement_id, workspace_id FROM member_achievements) g;

INSERT INTO achievements (id, workspace_id, title, description, image_key, legacy_image_key, image_size,
    width, height, position, created_by, created_at, updated_at, archived_at)
SELECT c.new_id, c.workspace_id, a.title, a.description, '', nullif(a.image_key, ''), a.image_size,
    a.width, a.height, a.position, a.created_by, a.created_at, a.updated_at, a.archived_at
FROM achievement_copies c JOIN achievements a ON a.id = c.old_id;

UPDATE member_achievements m SET achievement_id = c.new_id
FROM achievement_copies c
WHERE m.achievement_id = c.old_id AND m.workspace_id = c.workspace_id;

-- The chat cards name the achievement (SystemMessage.achievement.achievementId, protojson).
UPDATE messages msg SET payload = jsonb_set(msg.payload, '{achievement,achievementId}', to_jsonb(m.achievement_id::text))
FROM member_achievements m
WHERE msg.id = m.message_id AND msg.payload ? 'achievement';

-- Only host rows are left without a workspace; none of them is granted any more.
DELETE FROM achievements WHERE workspace_id IS NULL;
DROP TABLE achievement_copies;

ALTER TABLE achievements ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE achievements DROP COLUMN image_key;
DROP INDEX achievements_position_idx;
CREATE INDEX achievements_workspace_idx ON achievements (workspace_id, position, id);
CREATE INDEX achievements_file_idx ON achievements (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX achievements_legacy_idx ON achievements (id) WHERE legacy_image_key IS NOT NULL;

-- +goose Down
-- Schema only: the catalogs stay per-row (a copy per workspace), their pictures are dropped
-- (the files go with the orphan cleanup), image_key is empty.
SET LOCAL lock_timeout = '10s';
DROP INDEX achievements_legacy_idx;
DROP INDEX achievements_file_idx;
DROP INDEX achievements_workspace_idx;
ALTER TABLE achievements ADD COLUMN image_key text NOT NULL DEFAULT '';
ALTER TABLE achievements ALTER COLUMN image_key DROP DEFAULT;
ALTER TABLE achievements DROP COLUMN legacy_image_key, DROP COLUMN file_id, DROP COLUMN workspace_id;
CREATE INDEX achievements_position_idx ON achievements (position, id);
DROP TABLE achievement_legacy_blobs;
