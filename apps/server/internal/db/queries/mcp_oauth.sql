-- MCP OAuth (ADR-0158): dynamically registered clients, authorization requests, MCP sessions.

-- name: CreateMCPClient :one
INSERT INTO mcp_oauth_clients (id, name, redirect_uris, created_ip)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetMCPClient :one
SELECT * FROM mcp_oauth_clients WHERE id = $1;

-- name: CountMCPClientsFromIP :one
SELECT count(*) FROM mcp_oauth_clients WHERE created_ip = $1 AND created_at > now() - interval '1 hour';

-- name: DeleteUnusedMCPClients :exec
-- Clients that never got a session, older than 7 days (registration is public). Bounded per call.
DELETE FROM mcp_oauth_clients
WHERE id IN (
    SELECT c.id FROM mcp_oauth_clients c
    WHERE c.last_used_at IS NULL AND c.created_at < now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.mcp_client_id = c.id)
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
-- Codes live 60 s, requests 10 min; a used code is kept a day so its replay can revoke its session.
DELETE FROM mcp_oauth_requests
WHERE id IN (SELECT id FROM mcp_oauth_requests WHERE expires_at < now() - interval '1 day' LIMIT 500);

-- name: CreateMCPSession :one
INSERT INTO sessions (user_id, refresh_token_hash, device_name, ip, user_agent, expires_at, scope, mcp_client_id)
VALUES ($1, $2, $3, $4, $5, $6, 'mcp', $7)
RETURNING *;
