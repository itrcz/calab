-- Board status icon (ADR-0093).
--
-- board_statuses.icon  a display token (dashed, circle, quarter, half, three-quarters, check, x,
--                      eye, shield-check, hourglass, pause, flag, star, bolt, rocket, bug, inbox,
--                      archive, lock — boards.StatusIcons, checked by the API); '' = the icon of
--                      the status type. Display only: the type keeps the semantics.
--
-- Safe on a populated database: a column with a constant default (metadata only).

-- +goose Up
SET lock_timeout = '10s';
ALTER TABLE board_statuses ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT '';
RESET lock_timeout;

-- +goose Down
ALTER TABLE board_statuses DROP COLUMN IF EXISTS icon;
