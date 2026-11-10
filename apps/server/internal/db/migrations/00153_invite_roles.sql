-- Custom roles an invitation gives on joining by it (ADR-0026 addendum 2026-11-10, CBF-174): link
-- invites and invitations by email (their link row). Checked when the invitation is made and
-- again on joining against the author's current roles (workspaces.GiveInviteRoles): only roles
-- that still exist and the author may still give, hence no foreign key.

-- +goose Up
ALTER TABLE workspace_invites ADD COLUMN role_ids uuid[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE workspace_invites DROP COLUMN role_ids;
