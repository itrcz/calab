-- Reminders of imported CalDAV events (ADR-0045, amendment 3).
--
-- caldav_accounts         + remind: remind of the imported events like of meetings (the user's
--                         event_reminders); off by default.
-- external_reminders_sent dedup of EVENT_REMINDER of an imported event per user, event (the UID
--                         hash), occurrence and minutes: external_busy is replaced on every import,
--                         so the claim cannot hang on its rows (event_reminders_sent for meetings).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE caldav_accounts ADD COLUMN remind boolean NOT NULL DEFAULT false;

CREATE TABLE external_reminders_sent (
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    uid           text NOT NULL,
    occurrence_at timestamptz NOT NULL,
    minutes       smallint NOT NULL,
    sent_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, uid, occurrence_at, minutes)
);
CREATE INDEX external_reminders_sent_at_idx ON external_reminders_sent (sent_at);

-- +goose Down
DROP TABLE external_reminders_sent;
ALTER TABLE caldav_accounts DROP COLUMN remind;
