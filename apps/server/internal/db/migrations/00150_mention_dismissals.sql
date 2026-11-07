-- Dismissed chat mentions of the «Упоминания» inbox (CBF-155, ADR-0163): the ✕ on a card.
--
-- mention_dismissals  one row per (user, message) the user removed from their inbox; keyed by
--                     the message, not the mention row, so an edit that rewrites the mention
--                     rows does not bring it back. GET /api/me/mentions skips these. A deleted
--                     message drops its rows (the delete handler; the FK for hard deletes).
-- Task notices are dismissed by deleting the user's own task_notice_log row: no table.

-- +goose Up
CREATE TABLE mention_dismissals (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX mention_dismissals_message_idx ON mention_dismissals (message_id);

-- +goose Down
DROP TABLE mention_dismissals;
