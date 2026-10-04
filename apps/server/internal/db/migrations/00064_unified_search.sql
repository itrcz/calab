-- +goose NO TRANSACTION
-- Unified search (ADR-0062). pg_trgm gives typo / substring matching on short fields (task and
-- event titles, file names); events get a full-text index like messages_search_idx; recordings
-- keep their transcript as plain text (transcript_text, from transcript_json: the segments'
-- texts one per line) with a full-text index. messages_search_idx is not touched.
--
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it. A role
-- without that right fails here with the message below; the operator then runs
-- `CREATE EXTENSION pg_trgm;` in this database as a superuser once and restarts (docs/06).
--
-- Indexes are built CONCURRENTLY (no write lock on busy tables); an index left INVALID by an
-- interrupted build is dropped first so that a retry builds it again. lock_timeout bounds the
-- short ACCESS EXCLUSIVE locks (ADD COLUMN, dropping an invalid index): a migration waiting
-- behind a long transaction fails instead of queueing every query on the table.
-- room_recordings.transcript_text of existing rows is filled by the server in batches after
-- start (recording.BackfillTranscripts): restart-safe, idempotent.

-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'migration 00064: no privilege to create extension pg_trgm in database %', current_database()
        USING HINT = 'As a superuser (or the database owner on PostgreSQL 13+) run: CREATE EXTENSION pg_trgm; — see docs/06 «pg_trgm».';
END
$$;
-- +goose StatementEnd

SET lock_timeout = '10s';

ALTER TABLE room_recordings ADD COLUMN IF NOT EXISTS transcript_text text;

-- +goose StatementBegin
DO $$
DECLARE
    ix text;
BEGIN
    FOR ix IN
        SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relname IN ('events_search_idx', 'events_title_trgm_idx', 'files_name_trgm_idx',
                                                 'tasks_title_trgm_idx', 'room_recordings_transcript_search_idx',
                                                 'room_recordings_transcript_todo_idx')
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', ix);
    END LOOP;
END
$$;
-- +goose StatementEnd

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_search_idx ON events
    USING gin ((to_tsvector('russian', title || ' ' || description) || to_tsvector('simple', title || ' ' || description)));
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_title_trgm_idx ON events USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_name_trgm_idx ON files USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_title_trgm_idx ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS room_recordings_transcript_search_idx ON room_recordings
    USING gin ((to_tsvector('russian', transcript_text) || to_tsvector('simple', transcript_text)))
    WHERE transcript_text IS NOT NULL;
-- The backfill's work queue: ready results not converted yet.
CREATE INDEX CONCURRENTLY IF NOT EXISTS room_recordings_transcript_todo_idx ON room_recordings (id)
    WHERE transcript_json IS NOT NULL AND transcript_text IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS room_recordings_transcript_todo_idx;
DROP INDEX CONCURRENTLY IF EXISTS room_recordings_transcript_search_idx;
DROP INDEX CONCURRENTLY IF EXISTS tasks_title_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS files_name_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS events_title_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS events_search_idx;
ALTER TABLE room_recordings DROP COLUMN IF EXISTS transcript_text;
-- pg_trgm stays: other objects of the database may use it.
