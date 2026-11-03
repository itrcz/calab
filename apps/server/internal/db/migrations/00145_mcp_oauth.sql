-- MCP without a bot (ADR-0158): a person connects an MCP client (Claude Code, Codex, Cursor…)
-- through OAuth 2.1 — dynamic client registration, Authorization Code + PKCE S256, consent in the
-- web app. The grant is a session of the person (sessions.scope = 'mcp') whose access tokens are
-- valid only on /api/mcp and in the tools' in-process calls.
--
-- Safe on a populated database: the new sessions columns are nullable without defaults (metadata
-- only) and the check is NOT VALID (every existing value is NULL); the foreign key is NOT VALID
-- too, so adding it does not scan sessions under a lock. The new tables start empty.

-- +goose Up
CREATE TABLE mcp_oauth_clients (
    id            text PRIMARY KEY CHECK (id ~ '^calab_mc_[A-Za-z0-9_-]{32}$'),
    name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
    created_ip    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);
-- The cleanup of clients that never got a session (registration is public).
CREATE INDEX mcp_oauth_clients_unused_idx ON mcp_oauth_clients (created_at) WHERE last_used_at IS NULL;

-- One authorization request: created by /authorize in the browser that started it (browser_hash,
-- the __Host-calab_mcp cookie), bound to the person's session by the consent page, answered with
-- a one-time code (code_hash), exchanged once for a session (session_id).
CREATE TABLE mcp_oauth_requests (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    handle_hash    bytea NOT NULL UNIQUE,
    browser_hash   bytea NOT NULL,
    client_id      text NOT NULL REFERENCES mcp_oauth_clients (id) ON DELETE CASCADE,
    redirect_uri   text NOT NULL,
    code_challenge text NOT NULL,
    state          text NOT NULL DEFAULT '',
    resource       text NOT NULL DEFAULT '',
    created_ip     text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    user_id        uuid REFERENCES users (id) ON DELETE CASCADE,
    bound_session  uuid,
    csrf_hash      bytea,
    decided_at     timestamptz,
    code_hash      bytea UNIQUE,
    code_expires_at timestamptz,
    code_used_at   timestamptz,
    session_id     uuid
);
CREATE INDEX mcp_oauth_requests_expires_idx ON mcp_oauth_requests (expires_at);
CREATE INDEX mcp_oauth_requests_ip_idx ON mcp_oauth_requests (created_ip, created_at);

ALTER TABLE sessions ADD COLUMN scope text;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_check CHECK (scope = 'mcp') NOT VALID;
ALTER TABLE sessions ADD COLUMN mcp_client_id text;
ALTER TABLE sessions ADD CONSTRAINT sessions_mcp_scope_client_check CHECK ((scope IS NULL) = (mcp_client_id IS NULL)) NOT VALID;
-- An MCP session is a local account's, never freshly password-authenticated (no reauth windows).
ALTER TABLE sessions ADD CONSTRAINT sessions_mcp_authority_check CHECK (scope IS NULL OR (authority_kind = 'local_account' AND local_authenticated_at IS NULL)) NOT VALID;
ALTER TABLE sessions ADD CONSTRAINT sessions_mcp_client_fk FOREIGN KEY (mcp_client_id) REFERENCES mcp_oauth_clients (id) ON DELETE RESTRICT NOT VALID;

-- +goose Down
-- Without the columns an MCP session would look like an app session: end them first.
UPDATE sessions SET revoked_at = now(), revoked_reason = 'MCP_ROLLBACK', replay_seal = NULL WHERE scope = 'mcp' AND revoked_at IS NULL;
ALTER TABLE sessions DROP COLUMN mcp_client_id;
ALTER TABLE sessions DROP COLUMN scope;
DROP TABLE mcp_oauth_requests;
DROP TABLE mcp_oauth_clients;
