-- The user's last own mic / sound choice in voice (ADR-0165, CBF-180): the next voice session on
-- any of the user's devices starts with it. voice_mute_at NULL = never chosen. Constant defaults:
-- adding the columns rewrites nothing.

-- +goose Up
ALTER TABLE users
    ADD COLUMN voice_muted boolean NOT NULL DEFAULT false,
    ADD COLUMN voice_deafened boolean NOT NULL DEFAULT false,
    ADD COLUMN voice_mute_at timestamptz;

-- +goose Down
ALTER TABLE users
    DROP COLUMN voice_mute_at,
    DROP COLUMN voice_deafened,
    DROP COLUMN voice_muted;
