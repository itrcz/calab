-- ADR-0072: provider-side message-text privacy. Separate from replaceable audio settings.
-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE users ADD COLUMN hide_message_text_in_notifications boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE users DROP COLUMN hide_message_text_in_notifications;
