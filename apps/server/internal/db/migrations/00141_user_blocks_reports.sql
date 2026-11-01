-- Report and block users (ADR-0154).
-- user_blocks: a person blocked another person (account-level): neither can start a DM, write
-- into their DM or call the other; message pushes from the blocked author are not sent.
-- user_reports: a report about a person or their message to the workspace's moderators
-- (MANAGE_MEMBERS). reporter / target survive account deletion as NULL (the journal stays).

-- +goose Up
CREATE TABLE user_blocks (
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, blocked_user_id),
    CHECK (user_id <> blocked_user_id)
);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_user_id);

CREATE TABLE user_reports (
    id             uuid PRIMARY KEY,
    workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    reporter_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    target_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    message_id     uuid,              -- no FK: the message may be deleted, the report stays
    room_id        uuid,
    message_text   text NOT NULL DEFAULT '',
    reason         smallint NOT NULL, -- calaba.v1.ReportReason
    comment        text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at    timestamptz,
    resolved_by    uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX user_reports_workspace_idx ON user_reports (workspace_id, id DESC);
CREATE INDEX user_reports_reporter_idx ON user_reports (reporter_id, created_at);

-- +goose Down
DROP TABLE user_reports;
DROP TABLE user_blocks;
