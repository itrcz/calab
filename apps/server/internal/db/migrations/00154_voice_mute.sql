-- The user's last own mic / sound choice in voice (ADR-0168, CBF-180): the next voice session on
-- any of the user's devices starts with it. voice_mute_at NULL = never chosen. Constant defaults:
-- adding the columns rewrites nothing (metadata only); a short lock_timeout so a long reader on
-- users cannot queue every login behind the ACCESS EXCLUSIVE lock.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE users
    ADD COLUMN voice_muted boolean NOT NULL DEFAULT false,
    ADD COLUMN voice_deafened boolean NOT NULL DEFAULT false,
    ADD COLUMN voice_mute_at timestamptz;

-- +goose Down
ALTER TABLE users
    DROP COLUMN voice_mute_at,
    DROP COLUMN voice_deafened,
    DROP COLUMN voice_muted;
