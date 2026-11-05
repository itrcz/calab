-- MCP OAuth (ADR-0158): dynamically registered clients, authorization requests, MCP sessions.

-- name: CreateMCPClient :one
INSERT INTO mcp_oauth_clients (id, name, redirect_uris, created_ip)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetMCPClient :one
SELECT * FROM mcp_oauth_clients WHERE id = $1;

-- name: DeleteUnusedMCPClients :exec
-- Clients that never got a session (last_used_at is set in the transaction that creates the
-- first one), older than a day: registration is public. Bounded per call.
DELETE FROM mcp_oauth_clients
WHERE id IN (
    SELECT c.id FROM mcp_oauth_clients c
    WHERE c.last_used_at IS NULL AND c.created_at < now() - interval '1 day'
    LIMIT 200
);

-- name: TouchMCPClient :exec
UPDATE mcp_oauth_clients SET last_used_at = now() WHERE id = $1;

-- name: CreateMCPRequest :one
INSERT INTO mcp_oauth_requests (handle_hash, browser_hash, client_id, redirect_uri, code_challenge, state, resource, created_ip, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: CountMCPRequestsFromIP :one
SELECT count(*) FROM mcp_oauth_requests WHERE created_ip = $1 AND expires_at > now() AND decided_at IS NULL;

-- name: GetMCPRequestForUpdate :one
SELECT * FROM mcp_oauth_requests WHERE handle_hash = $1 FOR UPDATE;

-- name: BindMCPRequest :exec
UPDATE mcp_oauth_requests SET user_id = $2, bound_session = $3, csrf_hash = $4 WHERE id = $1;

-- name: DecideMCPRequest :exec
UPDATE mcp_oauth_requests SET decided_at = now(), code_hash = sqlc.narg('code_hash'), code_expires_at = sqlc.narg('code_expires_at') WHERE id = $1;

-- name: GetMCPRequestByCodeForUpdate :one
SELECT * FROM mcp_oauth_requests WHERE code_hash = $1 FOR UPDATE;

-- name: UseMCPCode :exec
UPDATE mcp_oauth_requests SET code_used_at = now(), session_id = $2 WHERE id = $1;

-- name: DeleteMCPRequestsByHashes :exec
DELETE FROM mcp_oauth_requests WHERE browser_hash = ANY(sqlc.arg('hashes')::bytea[]) AND decided_at IS NULL;

-- name: DeleteExpiredMCPRequests :exec
-- Requests live 10 min and codes 60 s: an expired request without a used code goes at once; a
-- used code is kept a day so that its replay can still revoke the session it made.
DELETE FROM mcp_oauth_requests
WHERE id IN (
    SELECT id FROM mcp_oauth_requests
    WHERE (code_used_at IS NULL AND expires_at < now()) OR expires_at < now() - interval '1 day'
    LIMIT 500
);

-- name: CreateMCPSession :one
INSERT INTO sessions (user_id, refresh_token_hash, device_name, ip, user_agent, expires_at, scope, mcp_client_id)
VALUES ($1, $2, $3, $4, $5, $6, 'mcp', $7)
RETURNING *;

-- name: RevokeReplacedMCPSessions :many
-- A new consent replaces the person's earlier live sessions of the same client, and keeps at most
-- 10 live MCP sessions per person (the oldest go).
UPDATE sessions AS t SET revoked_at = now(), revoked_reason = sqlc.arg(reason)::text, replay_seal = NULL
WHERE t.user_id = sqlc.arg(user_id)::uuid AND t.scope = 'mcp' AND t.revoked_at IS NULL AND t.id <> sqlc.arg(id)::uuid
  AND (t.mcp_client_id = sqlc.arg(mcp_client_id)::text OR t.id NOT IN (
      SELECT s.id FROM sessions s
      WHERE s.user_id = sqlc.arg(user_id)::uuid AND s.scope = 'mcp' AND s.revoked_at IS NULL
      ORDER BY s.created_at DESC LIMIT 10))
RETURNING t.id;

-- name: IsSessionLive :one
SELECT EXISTS (SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now());
