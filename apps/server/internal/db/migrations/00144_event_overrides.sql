-- One occurrence of a series changed on its own (ADR-0157, board #147): the override is an
-- ordinary one-off meeting row that names its series (series_id) and the original start of the
-- occurrence it replaces (recurrence_at, iCalendar RECURRENCE-ID). The series skips that
-- occurrence when it expands; exports write the override under the series' UID.
--
-- Safe on a populated database: nullable columns without defaults are metadata only; the
-- checks are NOT VALID (every existing value is NULL) and still enforced for new rows; the
-- index is partial and small (no row has series_id yet).

-- +goose Up
ALTER TABLE events ADD COLUMN series_id uuid REFERENCES events (id) ON DELETE CASCADE;
ALTER TABLE events ADD COLUMN recurrence_at timestamptz;
ALTER TABLE events ADD CONSTRAINT events_override_check
    CHECK ((series_id IS NULL) = (recurrence_at IS NULL) AND (series_id IS NULL OR rrule IS NULL)) NOT VALID;
CREATE UNIQUE INDEX events_override_idx ON events (series_id, recurrence_at) WHERE series_id IS NOT NULL AND cancelled_at IS NULL;

-- +goose Down
DROP INDEX events_override_idx;
ALTER TABLE events DROP CONSTRAINT events_override_check;
ALTER TABLE events DROP COLUMN recurrence_at;
ALTER TABLE events DROP COLUMN series_id;
