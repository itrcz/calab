-- +goose NO TRANSACTION
-- MCP OAuth (ADR-0158): the MCP sessions of a client and of a person — the foreign key check when
-- an unused client is deleted, and the replacement of a person's earlier sessions of the same
-- client at a new consent. Partial: only MCP sessions carry a client. CONCURRENTLY: sessions may be
-- large.

-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_mcp_client_idx ON sessions (mcp_client_id) WHERE mcp_client_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_mcp_user_idx ON sessions (user_id, created_at) WHERE scope = 'mcp' AND revoked_at IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS sessions_mcp_user_idx;
DROP INDEX CONCURRENTLY IF EXISTS sessions_mcp_client_idx;
