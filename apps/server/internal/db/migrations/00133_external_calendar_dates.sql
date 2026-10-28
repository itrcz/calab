-- Preserve DATE values across profile timezone changes (ADR-0144).
-- Old writers remain compatible; existing imports acquire dates on their next normal sync.
-- +goose Up
ALTER TABLE external_busy ADD COLUMN start_date text NOT NULL DEFAULT '';
ALTER TABLE external_busy ADD COLUMN end_date text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE external_busy DROP COLUMN start_date;
ALTER TABLE external_busy DROP COLUMN end_date;
