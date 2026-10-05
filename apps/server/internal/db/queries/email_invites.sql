-- ADR-0023: invitations by email.

-- name: LookupInvitee :one
-- Verified, active, non-guest account with exactly this address (citext: case-insensitive).
SELECT * FROM users
WHERE email = $1 AND email_verified_at IS NOT NULL AND disabled_at IS NULL AND NOT is_guest;

-- name: GetPendingEmailInvite :one
SELECT * FROM email_invites WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL;

-- name: CreateEmailInvite :one
INSERT INTO email_invites (workspace_id, email, role, invited_by, invite_id, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: RenewEmailInvite :one
-- Sending again: a new link (the old invite row is deleted by the caller), new expiry.
UPDATE email_invites SET invite_id = $2, role = $3, invited_by = $4, expires_at = $5, last_sent_at = now()
WHERE id = $1
RETURNING *;

-- name: ListEmailInvites :many
SELECT * FROM email_invites WHERE workspace_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC;

-- name: GetEmailInvite :one
SELECT * FROM email_invites WHERE id = $1 AND workspace_id = $2;

-- name: GetEmailInviteByInvite :one
SELECT * FROM email_invites WHERE invite_id = $1;

-- name: AcceptEmailInvite :exec
UPDATE email_invites SET accepted_at = now() WHERE id = $1;

-- name: PendingEmailInvitesFor :many
-- Live invitations of an address, locked for accepting them (auto-join after verification).
SELECT * FROM email_invites
WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()
ORDER BY created_at
FOR UPDATE;

-- name: HasPendingEmailInvite :one
-- Whether a live invitation waits for an address (ADR-0065: its join needs the confirmation).
SELECT EXISTS (
  SELECT 1 FROM email_invites
  WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()
)::bool;

-- name: UseInvite :exec
UPDATE workspace_invites SET uses = uses + 1 WHERE id = $1;
