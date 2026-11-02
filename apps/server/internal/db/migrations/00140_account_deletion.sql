-- Account deletion by the user (ADR-0153): the users row stays as an anonymous tombstone (its id keeps
-- the authorship of other people's history), marked by deleted_at; its email is gone, so the address
-- can register again. A former membership records the new reason account_deleted.

-- +goose Up
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users
    DROP CONSTRAINT users_email_or_guest,
    ADD CONSTRAINT users_email_or_guest CHECK (email IS NOT NULL OR is_guest OR is_bot OR deleted_at IS NOT NULL);

ALTER TABLE workspace_former_members
    DROP CONSTRAINT workspace_former_members_reason_check,
    ADD CONSTRAINT workspace_former_members_reason_check
        CHECK (reason IN ('left', 'removed', 'banned', 'guest_expired', 'directory_disabled', 'account_deleted'));

-- +goose Down
UPDATE workspace_former_members SET reason = 'left' WHERE reason = 'account_deleted';
ALTER TABLE workspace_former_members
    DROP CONSTRAINT workspace_former_members_reason_check,
    ADD CONSTRAINT workspace_former_members_reason_check
        CHECK (reason IN ('left', 'removed', 'banned', 'guest_expired', 'directory_disabled'));

-- A tombstone without email cannot satisfy the old check: keep it a placeholder address.
UPDATE users SET email = 'deleted-' || id::text || '@invalid' WHERE deleted_at IS NOT NULL AND email IS NULL;
ALTER TABLE users
    DROP CONSTRAINT users_email_or_guest,
    ADD CONSTRAINT users_email_or_guest CHECK (email IS NOT NULL OR is_guest OR is_bot);
ALTER TABLE users DROP COLUMN deleted_at;
