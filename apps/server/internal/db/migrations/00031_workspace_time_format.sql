-- Clock format for every time shown in a workspace (docs/09 #73): auto (the viewer's system
-- locale), h24 or h12. A constant default: no table rewrite.

-- +goose Up
ALTER TABLE workspaces ADD COLUMN time_format text NOT NULL DEFAULT 'auto'
    CHECK (time_format IN ('auto', 'h24', 'h12'));

-- +goose Down
ALTER TABLE workspaces DROP COLUMN time_format;
