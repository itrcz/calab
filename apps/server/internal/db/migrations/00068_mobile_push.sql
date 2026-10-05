-- +goose Up
-- Native tokens are routing data, never authentication or RTC grants. No endpoint is public.
CREATE TABLE push_devices (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL,
    provider smallint NOT NULL CHECK (provider BETWEEN 1 AND 3),
    environment text NOT NULL CHECK (environment IN ('development', 'production')),
    app_id text NOT NULL CHECK (length(app_id) BETWEEN 1 AND 255),
    token text NOT NULL CHECK (length(token) BETWEEN 1 AND 4096),
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    notifications_enabled boolean NOT NULL DEFAULT true,
    calls_enabled boolean NOT NULL DEFAULT false,
    mentions_enabled boolean NOT NULL DEFAULT true,
    all_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
    UNIQUE (provider, environment, app_id, token_hash),
    UNIQUE (session_id, installation_id, provider, environment, app_id)
);
CREATE INDEX push_devices_session ON push_devices(session_id);
CREATE INDEX push_devices_user ON push_devices(user_id);
CREATE INDEX push_devices_expiry ON push_devices(expires_at);

CREATE TABLE push_deliveries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    device_id uuid NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
    device_version bigint NOT NULL,
    event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 160),
    kind smallint NOT NULL CHECK (kind BETWEEN 1 AND 4),
    reference_id uuid NOT NULL,
    room_id uuid,
    actor_id uuid,
    notice_kind smallint NOT NULL DEFAULT 0 CHECK (notice_kind BETWEEN 0 AND 7),
    context_id uuid,
    occurrence_at timestamptz,
    reminder_minutes smallint NOT NULL DEFAULT 0 CHECK (reminder_minutes BETWEEN 0 AND 1440),
    expires_at timestamptz NOT NULL,
    not_before timestamptz NOT NULL DEFAULT now(),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
    lease_id uuid,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    UNIQUE (device_id, event_key)
);
CREATE INDEX push_deliveries_ready ON push_deliveries(not_before) WHERE attempts < 6 AND delivered_at IS NULL;
CREATE INDEX push_deliveries_expiry ON push_deliveries(expires_at);

-- Committed routing intent has no device token/content. Recipient expansion is
-- resumable and never waits on provider-held endpoint/session locks in Publisher.
CREATE TABLE push_intents (
 id uuid PRIMARY KEY DEFAULT uuidv7(),
 recipient_id uuid REFERENCES users(id) ON DELETE CASCADE,
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 160),
 kind smallint NOT NULL CHECK(kind BETWEEN 1 AND 4),
 reference_id uuid NOT NULL,
 room_id uuid,
 actor_id uuid,
 notice_kind smallint NOT NULL DEFAULT 0 CHECK(notice_kind BETWEEN 0 AND 7),
 context_id uuid,
 occurrence_at timestamptz,
 reminder_minutes smallint NOT NULL DEFAULT 0 CHECK(reminder_minutes BETWEEN 0 AND 1440),
 expires_at timestamptz NOT NULL,
 not_before timestamptz NOT NULL DEFAULT now(),
 after_user uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 64),
 lease_id uuid,
 lease_until timestamptz,
 completed_at timestamptz,
 UNIQUE NULLS NOT DISTINCT (recipient_id,event_key)
);
CREATE INDEX push_intents_ready ON push_intents(not_before) WHERE completed_at IS NULL AND attempts<64;
CREATE INDEX push_intents_expiry ON push_intents(expires_at);

-- +goose Down
DROP TABLE push_intents;
DROP TABLE push_deliveries;
DROP TABLE push_devices;
