-- +goose NO TRANSACTION
-- Room picture (ADR-0092).
--
-- rooms.icon_file_id  an image of the workspace shown instead of the room type glyph; NULL = the
--                     glyph. SET NULL when the file goes (cleanup, ADR-0011).
-- messages index      system messages room_icon (payload roomIcon.fileId) by file: they keep the
--                     picture readable to the room (files.CanRead → FileRooms) and out of the
--                     orphan cleanup while they live.
--
-- Safe on a populated database: rooms only gets a nullable column without a default (metadata
-- only); its foreign key is added NOT VALID and validated without blocking writes; the indexes
-- are built CONCURRENTLY (hence NO TRANSACTION: every statement is idempotent).

-- +goose Up
SET lock_timeout = '10s';

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS icon_file_id uuid;

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_icon_file_id_fkey') THEN
        ALTER TABLE rooms ADD CONSTRAINT rooms_icon_file_id_fkey FOREIGN KEY (icon_file_id)
            REFERENCES files (id) ON DELETE SET NULL NOT VALID;
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE rooms VALIDATE CONSTRAINT rooms_icon_file_id_fkey;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS rooms_icon_file_idx ON rooms (icon_file_id) WHERE icon_file_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_room_icon_file_idx ON messages ((payload -> 'roomIcon' ->> 'fileId'))
    WHERE kind = 'system' AND payload ? 'roomIcon';

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS messages_room_icon_file_idx;
DROP INDEX CONCURRENTLY IF EXISTS rooms_icon_file_idx;
ALTER TABLE rooms DROP COLUMN IF EXISTS icon_file_id;
