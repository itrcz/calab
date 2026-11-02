-- The channel an action came through (ADR-0156): messages.via / task_activity.via = 'mcp' when a
-- bot (itself or on behalf of a person, ADR-0106 / ADR-0111) made it through the MCP endpoint;
-- NULL for everything else (the app, REST, rules, the server). The client shows «via MCP».
--
-- Safe on a populated database: nullable columns without defaults are metadata only; the checks
-- are NOT VALID (every existing value is NULL, nothing to check, the big tables are not scanned
-- under a lock), and are still enforced for new rows.

-- +goose Up
ALTER TABLE messages ADD COLUMN via text;
ALTER TABLE messages ADD CONSTRAINT messages_via_check CHECK (via = 'mcp') NOT VALID;

ALTER TABLE task_activity ADD COLUMN via text;
ALTER TABLE task_activity ADD CONSTRAINT task_activity_via_check CHECK (via = 'mcp') NOT VALID;

-- +goose Down
ALTER TABLE task_activity DROP COLUMN via;
ALTER TABLE messages DROP COLUMN via;
