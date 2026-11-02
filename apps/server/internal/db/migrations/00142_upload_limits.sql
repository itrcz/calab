-- Upload limits per workspace set by a superadmin (ADR-0155). NULL = the server default
-- (UPLOAD_RATE_BURST, UPLOAD_RATE_PER_HOUR, MAX_FILE_SIZE_MB). The ranges match the admin API;
-- 4096 MB is the server's hard cap of one file (files.MaxFileSizeCapMB).
-- workspace_admin_log gets the action 'upload_limits' (the new values in reason).

-- +goose Up
ALTER TABLE workspaces
    ADD COLUMN upload_burst    integer CHECK (upload_burst BETWEEN 1 AND 10000),
    ADD COLUMN upload_per_hour integer CHECK (upload_per_hour BETWEEN 1 AND 100000),
    ADD COLUMN max_file_mb     integer CHECK (max_file_mb BETWEEN 1 AND 4096);

ALTER TABLE workspace_admin_log DROP CONSTRAINT workspace_admin_log_action_check;
ALTER TABLE workspace_admin_log ADD CONSTRAINT workspace_admin_log_action_check
    CHECK (action IN ('suspend', 'resume', 'upload_limits'));

-- +goose Down
DELETE FROM workspace_admin_log WHERE action = 'upload_limits';
ALTER TABLE workspace_admin_log DROP CONSTRAINT workspace_admin_log_action_check;
ALTER TABLE workspace_admin_log ADD CONSTRAINT workspace_admin_log_action_check
    CHECK (action IN ('suspend', 'resume'));
ALTER TABLE workspaces
    DROP COLUMN max_file_mb,
    DROP COLUMN upload_per_hour,
    DROP COLUMN upload_burst;
