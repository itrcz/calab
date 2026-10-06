-- name: GetIdentityRoomParent :one
-- Durable attribution only: handlers retain archive, permissions and read/write rules.
SELECT workspace_id FROM rooms WHERE id = $1;
-- Identity v1 foundation, ADR-0054. Consumer mutations run with audit/outbox in one transaction.

-- name: CreateIdentityGrant :one
INSERT INTO workspace_identity_grants (workspace_id, feature, enabled, source, valid_until, updated_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('feature'), sqlc.arg('enabled'), sqlc.arg('source'), sqlc.narg('valid_until'), sqlc.narg('updated_by'))
RETURNING *;

-- name: GetIdentityGrant :one
SELECT * FROM workspace_identity_grants WHERE workspace_id = sqlc.arg('workspace_id') AND feature = sqlc.arg('feature');

-- name: CreateIdentityPolicy :one
INSERT INTO workspace_identity_policies (workspace_id, mode, assurance_max_age_seconds, updated_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('mode'), sqlc.arg('assurance_max_age_seconds'), sqlc.narg('updated_by'))
RETURNING *;

-- name: GetIdentityPolicy :one
SELECT * FROM workspace_identity_policies WHERE workspace_id = sqlc.arg('workspace_id');

-- name: CreateIdentityConnection :one
INSERT INTO workspace_identity_connections (id, workspace_id, name, status, tenant_id, provider, issuer, client_id, client_secret_box, scopes, created_by)
VALUES (COALESCE(sqlc.narg('id')::uuid, uuidv7()), sqlc.arg('workspace_id'), sqlc.arg('name'), sqlc.arg('status'), sqlc.arg('tenant_id'), sqlc.arg('provider'), sqlc.arg('issuer'), sqlc.arg('client_id'), sqlc.narg('client_secret_box'), sqlc.arg('scopes'), sqlc.narg('created_by'))
RETURNING *;

-- name: GetIdentityConnection :one
SELECT * FROM workspace_identity_connections WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateExternalIdentity :one
INSERT INTO workspace_external_identities (workspace_id, connection_id, user_id, issuer, subject, status)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('connection_id'), sqlc.arg('user_id'), sqlc.arg('issuer'), sqlc.arg('subject'), sqlc.arg('status'))
RETURNING *;

-- name: GetExternalIdentity :one
SELECT * FROM workspace_external_identities WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateIdentityAccess :one
INSERT INTO workspace_identity_access (workspace_id, user_id, status, reason)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('user_id'), sqlc.arg('status'), sqlc.arg('reason'))
RETURNING *;

-- name: GetIdentityAccess :one
SELECT * FROM workspace_identity_access WHERE workspace_id = sqlc.arg('workspace_id') AND user_id = sqlc.arg('user_id');

-- name: CreateWorkspaceAssurance :one
INSERT INTO session_workspace_assurances (session_id, workspace_id, user_id, connection_id, identity_id, authenticated_at, valid_until, policy_version, access_version, connection_version, identity_version, session_version, entitlement_version)
VALUES (sqlc.arg('session_id'), sqlc.arg('workspace_id'), sqlc.arg('user_id'), sqlc.arg('connection_id'), sqlc.arg('identity_id'), sqlc.arg('authenticated_at'), sqlc.arg('valid_until'), sqlc.arg('policy_version'), sqlc.arg('access_version'), sqlc.arg('connection_version'), sqlc.arg('identity_version'), sqlc.arg('session_version'), sqlc.arg('entitlement_version'))
RETURNING *;

-- name: GetWorkspaceAssurance :one
SELECT * FROM session_workspace_assurances WHERE session_id = sqlc.arg('session_id') AND workspace_id = sqlc.arg('workspace_id');

-- name: CreateIdentityLoginTransaction :one
INSERT INTO identity_login_transactions (id, workspace_id, connection_id, connection_version, purpose, session_id, user_id, state_hash, browser_hash, nonce_hash, verifier_box, return_uri, native_challenge, browser_start_hash, expires_at)
VALUES (COALESCE(sqlc.narg('id')::uuid, uuidv7()), sqlc.arg('workspace_id'), sqlc.arg('connection_id'), sqlc.arg('connection_version'), sqlc.arg('purpose'), sqlc.narg('session_id'), sqlc.narg('user_id'), sqlc.arg('state_hash'), sqlc.arg('browser_hash'), sqlc.arg('nonce_hash'), sqlc.arg('verifier_box'), sqlc.arg('return_uri'), sqlc.narg('native_challenge'), sqlc.narg('browser_start_hash'), sqlc.arg('expires_at'))
RETURNING *;

-- name: GetIdentityLoginTransaction :one
SELECT * FROM identity_login_transactions WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateIdentityNativeHandoff :one
INSERT INTO identity_native_handoffs (id, transaction_id, ticket_hash, challenge, expires_at, result_box)
VALUES (COALESCE(sqlc.narg('id')::uuid, uuidv7()), sqlc.arg('transaction_id'), sqlc.arg('ticket_hash'), sqlc.arg('challenge'), sqlc.arg('expires_at'), sqlc.arg('result_box'))
RETURNING *;

-- name: GetIdentityNativeHandoff :one
SELECT * FROM identity_native_handoffs WHERE id = sqlc.arg('id');

-- name: CreateIdentityRecoveryCode :one
INSERT INTO workspace_identity_recovery_codes (workspace_id, owner_id, code_hash, expires_at)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('owner_id'), sqlc.arg('code_hash'), sqlc.arg('expires_at'))
RETURNING *;

-- name: GetIdentityRecoveryCode :one
SELECT * FROM workspace_identity_recovery_codes WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateIdentityInvalidation :one
INSERT INTO identity_invalidation_outbox (workspace_id, user_id, session_id, policy_version, access_version, reason)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('user_id'), sqlc.narg('session_id'), sqlc.arg('policy_version'), sqlc.arg('access_version'), sqlc.arg('reason'))
RETURNING *;

-- name: GetIdentityInvalidation :one
SELECT * FROM identity_invalidation_outbox WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateIdentityAudit :one
INSERT INTO workspace_identity_audit (workspace_id, actor_id, action, target_id, outcome)
VALUES (sqlc.arg('workspace_id'), sqlc.narg('actor_id'), sqlc.arg('action'), sqlc.narg('target_id'), sqlc.arg('outcome'))
RETURNING *;

-- name: GetIdentityAudit :one
SELECT * FROM workspace_identity_audit WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateProductAdminGrant :one
INSERT INTO product_admin_grants (user_id, operator_note)
VALUES (sqlc.arg('user_id'), sqlc.arg('operator_note'))
RETURNING *;

-- name: GetProductAdminGrant :one
SELECT * FROM product_admin_grants WHERE user_id = sqlc.arg('user_id');

-- name: CreateScopedIdentitySession :one
INSERT INTO sessions(user_id,refresh_token_hash,device_name,ip,user_agent,expires_at,authority_kind,authority_workspace_id,authority_connection_id,recovery_authenticated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *;

-- name: RecordLocalAuthentication :one
UPDATE sessions SET local_authenticated_at = sqlc.arg('authenticated_at')
WHERE id = sqlc.arg('session_id') AND user_id = sqlc.arg('user_id') AND authority_kind = 'local_account'
AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING *;

-- name: UpsertIdentityGrant :one
INSERT INTO workspace_identity_grants(workspace_id,feature,enabled,source,valid_until,updated_by)
VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,feature) DO UPDATE SET
    enabled=EXCLUDED.enabled, source=EXCLUDED.source, valid_until=EXCLUDED.valid_until,
    revoked_at=NULL, version=workspace_identity_grants.version+1, updated_by=EXCLUDED.updated_by, updated_at=clock_timestamp()
RETURNING *;

-- name: ListIdentityGrants :many
SELECT * FROM workspace_identity_grants WHERE workspace_id=$1 ORDER BY feature;

-- name: GetIdentityPolicyForUpdate :one
SELECT * FROM workspace_identity_policies WHERE workspace_id=$1 FOR UPDATE;

-- name: SetIdentityPolicy :one
UPDATE workspace_identity_policies SET mode=sqlc.arg('mode'), version=version+1,
    assurance_max_age_seconds=sqlc.arg('assurance_max_age_seconds'), updated_by=sqlc.narg('updated_by'), updated_at=clock_timestamp()
WHERE workspace_id=sqlc.arg('workspace_id') AND version=sqlc.arg('expected_version') RETURNING *;

-- name: ListIdentityConnections :many
SELECT * FROM workspace_identity_connections WHERE workspace_id=$1 ORDER BY created_at;

-- name: GetActiveIdentityConnection :one
SELECT * FROM workspace_identity_connections WHERE workspace_id=$1 AND status='active' AND disabled_at IS NULL;

-- name: GetIdentityConnectionForUpdate :one
SELECT * FROM workspace_identity_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE;

-- name: UpdateIdentityConnection :one
UPDATE workspace_identity_connections SET name=sqlc.arg('name'), client_id=sqlc.arg('client_id'),
    client_secret_box=sqlc.narg('client_secret_box'), scopes=sqlc.arg('scopes'),
    version=version+1, tested_version=NULL, tested_at=NULL, status='draft'
WHERE workspace_id=sqlc.arg('workspace_id') AND id=sqlc.arg('id') AND version=sqlc.arg('expected_version') RETURNING *;

-- name: MarkIdentityConnectionTested :one
UPDATE workspace_identity_connections SET tested_version=version, tested_at=clock_timestamp(), status='tested'
WHERE workspace_id=$1 AND id=$2 AND version=$3 AND disabled_at IS NULL RETURNING *;

-- name: ActivateIdentityConnection :one
UPDATE workspace_identity_connections SET status='active'
WHERE workspace_id=$1 AND id=$2 AND version=$3 AND tested_version=version AND disabled_at IS NULL RETURNING *;

-- name: DisableIdentityConnection :one
UPDATE workspace_identity_connections SET status='disabled',disabled_at=clock_timestamp(),version=version+1,tested_version=NULL
WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: FindExternalIdentity :one
SELECT * FROM workspace_external_identities
WHERE workspace_id=$1 AND connection_id=$2 AND issuer=$3 AND subject=$4;

-- name: FindUserExternalIdentity :one
SELECT * FROM workspace_external_identities WHERE workspace_id=$1 AND connection_id=$2 AND user_id=$3 AND status <> 'unlinked';

-- name: SetExternalIdentityStatus :one
UPDATE workspace_external_identities SET status=$4,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$3 RETURNING *;

-- name: UpsertIdentityAccess :one
INSERT INTO workspace_identity_access(workspace_id,user_id,status,reason) VALUES($1,$2,$3,$4)
ON CONFLICT (workspace_id,user_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,
version=workspace_identity_access.version+1,updated_at=clock_timestamp() RETURNING *;

-- name: UpsertWorkspaceAssurance :one
INSERT INTO session_workspace_assurances(session_id,workspace_id,user_id,connection_id,identity_id,authenticated_at,valid_until,policy_version,access_version,connection_version,identity_version,entitlement_version,session_version)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT(session_id,workspace_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,identity_id=EXCLUDED.identity_id,
authenticated_at=EXCLUDED.authenticated_at,valid_until=EXCLUDED.valid_until,policy_version=EXCLUDED.policy_version,
access_version=EXCLUDED.access_version,connection_version=EXCLUDED.connection_version,identity_version=EXCLUDED.identity_version,
entitlement_version=EXCLUDED.entitlement_version,session_version=EXCLUDED.session_version,revoked_at=NULL RETURNING *;

-- name: RevokeWorkspaceAssurances :execrows
UPDATE session_workspace_assurances SET revoked_at=clock_timestamp()
WHERE workspace_id=sqlc.arg('workspace_id') AND (sqlc.narg('user_id')::uuid IS NULL OR user_id=sqlc.narg('user_id'))
AND (sqlc.narg('session_id')::uuid IS NULL OR session_id=sqlc.narg('session_id')) AND revoked_at IS NULL;

-- name: ConsumeIdentityLoginTransaction :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM identity_login_transactions AS src WHERE src.state_hash=$1 AND src.browser_hash=$2 AND src.connection_id=$3 AND src.connection_version=$4 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE identity_login_transactions AS t SET consumed_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: ConsumeIdentityBrowserStart :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM identity_login_transactions AS src WHERE src.browser_start_hash=$1 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.browser_started_at IS NULL AND locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE identity_login_transactions AS t SET browser_started_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: CompleteIdentityLoginTransaction :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM identity_login_transactions AS src WHERE src.id=$1 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.consumed_at IS NOT NULL AND locked.completed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE identity_login_transactions AS t SET result_box=$2,completed_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: FinishIdentityLoginTransaction :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM identity_login_transactions AS src WHERE src.id=$1 AND src.browser_hash=$2 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.completed_at IS NOT NULL AND locked.finished_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE identity_login_transactions AS t SET finished_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: ConsumeIdentityNativeHandoff :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM identity_native_handoffs AS src WHERE src.transaction_id=$1 AND src.ticket_hash=$2 AND src.challenge=$3 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE identity_native_handoffs AS t SET consumed_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: ConsumeIdentityRecoveryCode :one
WITH locked AS MATERIALIZED (
    SELECT r.*,w.owner_id AS current_owner_id FROM workspace_identity_recovery_codes r
    JOIN workspaces w ON w.id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.owner_id=$2 AND r.code_hash=$3 FOR UPDATE OF r,w
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.current_owner_id=$2 AND locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE workspace_identity_recovery_codes AS r SET consumed_at=clock_timestamp()
FROM eligible WHERE r.id=eligible.id RETURNING r.*;

-- name: DeleteIdentityRecoveryCodes :execrows
DELETE FROM workspace_identity_recovery_codes WHERE workspace_id=$1;

-- name: ListIdentityInvalidationsForUpdate :many
SELECT * FROM identity_invalidation_outbox WHERE delivered_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED;

-- name: MarkIdentityInvalidationDelivered :exec
UPDATE identity_invalidation_outbox SET delivered_at=clock_timestamp() WHERE id=$1;

-- name: ListIdentityAudit :many
SELECT * FROM workspace_identity_audit WHERE workspace_id=$1 AND (sqlc.narg('before_id')::uuid IS NULL OR id<sqlc.narg('before_id'))
ORDER BY id DESC LIMIT sqlc.arg('limit_count');

-- name: ReserveIdentityID :one
SELECT uuidv7()::uuid AS id;

-- name: GetIdentityGateState :one
-- A single MVCC snapshot; transaction-sensitive callers use Queries.WithTx and locks.
SELECT sqlc.embed(s), u.is_guest, u.is_bot,
(u.disabled_at IS NOT NULL OR (u.is_guest AND u.guest_expires_at<=clock_timestamp()))::boolean AS user_disabled,
w.id AS workspace_id, (w.suspended_at IS NOT NULL)::boolean AS workspace_suspended,
(m.user_id IS NOT NULL)::boolean AS member,
COALESCE(CASE WHEN w.owner_id=u.id AND m.role='owner' THEN 'owner' WHEN m.role='owner' THEN 'member' ELSE m.role END,'')::text AS builtin_role,
(COALESCE(x.status='suspended',false) OR EXISTS(SELECT FROM workspace_bans b WHERE b.workspace_id=w.id AND (b.user_id=u.id OR b.email=u.email)))::boolean AS suspended,
COALESCE(x.version,1)::bigint AS access_version,
COALESCE(p.mode,'off')::text AS policy_mode, COALESCE(p.version,1)::bigint AS policy_version,
COALESCE(p.entitlement_version,1)::bigint AS entitlement_version,
COALESCE(p.assurance_max_age_seconds,3600)::integer AS max_age_seconds,
COALESCE(wp.plan='enterprise' AND (wp.valid_until IS NULL OR wp.valid_until>clock_timestamp()),false)::boolean AS business_eligible,
wp.valid_until AS plan_valid_until,
a.session_id AS assurance_session_id, a.user_id AS assurance_user_id, a.connection_id AS assurance_connection_id, a.identity_id AS assurance_identity_id,
a.authenticated_at AS assurance_authenticated_at, a.valid_until AS assurance_valid_until, a.revoked_at AS assurance_revoked_at,
COALESCE(a.policy_version,0)::bigint AS assurance_policy_version,COALESCE(a.access_version,0)::bigint AS assurance_access_version,
COALESCE(a.connection_version,0)::bigint AS assurance_connection_version,COALESCE(a.identity_version,0)::bigint AS assurance_identity_version,
COALESCE(a.entitlement_version,0)::bigint AS assurance_entitlement_version,COALESCE(a.session_version,0)::bigint AS assurance_session_version,
COALESCE(c.id,'00000000-0000-0000-0000-000000000000'::uuid)::uuid AS connection_id,
COALESCE(c.version,0)::bigint AS connection_version,
COALESCE(c.status='active' AND c.disabled_at IS NULL,false)::boolean AS connection_enabled,
COALESCE(c.tested_version=c.version,false)::boolean AS connection_tested,
COALESCE(e.id,'00000000-0000-0000-0000-000000000000'::uuid)::uuid AS identity_id,
COALESCE(e.version,0)::bigint AS identity_version,
COALESCE(e.status='active' AND e.issuer=c.issuer,false)::boolean AS identity_active,
(o.user_id IS NOT NULL)::boolean AS directory_required,
COALESCE(o.status='active',false)::boolean AS directory_active,
(d.disabled_at IS NULL AND d.last_success_at IS NOT NULL)::boolean AS directory_enabled,
COALESCE(d.last_success_at + make_interval(secs=>d.max_staleness_seconds),'epoch'::timestamptz)::timestamptz AS directory_valid_until,
EXISTS(SELECT FROM workspace_identity_recovery_codes r WHERE r.workspace_id=w.id AND r.owner_id=w.owner_id AND r.consumed_at IS NULL AND r.expires_at>clock_timestamp())::boolean AS recovery_ready,
EXISTS(SELECT FROM product_admin_grants g WHERE g.user_id=u.id AND g.revoked_at IS NULL)::boolean AS product_admin_granted,
gs.enabled AS sso_enabled, gs.source AS sso_source, gs.valid_until AS sso_valid_until, gs.revoked_at AS sso_revoked_at,COALESCE(gs.version,0)::bigint AS sso_version,
gd.enabled AS directory_granted, gd.source AS directory_source, gd.valid_until AS directory_grant_valid_until,gd.revoked_at AS directory_revoked_at,COALESCE(gd.version,0)::bigint AS directory_grant_version,
go.enabled AS oauth_enabled, go.source AS oauth_source,go.valid_until AS oauth_valid_until,go.revoked_at AS oauth_revoked_at,COALESCE(go.version,0)::bigint AS oauth_version
FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.id=sqlc.arg('workspace_id')
LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=u.id
LEFT JOIN workspace_identity_access x ON x.workspace_id=w.id AND x.user_id=u.id
LEFT JOIN workspace_identity_policies p ON p.workspace_id=w.id
LEFT JOIN workspace_plans wp ON wp.workspace_id=w.id
LEFT JOIN session_workspace_assurances a ON a.session_id=s.id AND a.workspace_id=w.id
LEFT JOIN workspace_external_identities e ON e.workspace_id=w.id AND e.id=a.identity_id
LEFT JOIN workspace_identity_connections c ON c.workspace_id=w.id AND c.id=e.connection_id
LEFT JOIN workspace_directories d ON d.workspace_id=w.id
LEFT JOIN directory_objects o ON o.workspace_id=w.id AND o.directory_id=d.id AND o.user_id=u.id
LEFT JOIN workspace_identity_grants gs ON gs.workspace_id=w.id AND gs.feature='corporate_sso'
LEFT JOIN workspace_identity_grants gd ON gd.workspace_id=w.id AND gd.feature='directory_sync'
LEFT JOIN workspace_identity_grants go ON go.workspace_id=w.id AND go.feature='oauth_provider'
WHERE s.id=sqlc.arg('session_id') AND s.user_id=sqlc.arg('user_id');

-- name: GetIdentityGateStates :many
-- GetIdentityGateState for several exact session/user pairs of one workspace in one snapshot
-- (the RTC identity sweep checks a room in one call): the same columns; a pair without a live
-- session row is absent. Keep the two in step; identitypolicy converts these rows to
-- GetIdentityGateStateRow.
SELECT sqlc.embed(s), u.is_guest, u.is_bot,
(u.disabled_at IS NOT NULL OR (u.is_guest AND u.guest_expires_at<=clock_timestamp()))::boolean AS user_disabled,
w.id AS workspace_id, (w.suspended_at IS NOT NULL)::boolean AS workspace_suspended,
(m.user_id IS NOT NULL)::boolean AS member,
COALESCE(CASE WHEN w.owner_id=u.id AND m.role='owner' THEN 'owner' WHEN m.role='owner' THEN 'member' ELSE m.role END,'')::text AS builtin_role,
(COALESCE(x.status='suspended',false) OR EXISTS(SELECT FROM workspace_bans b WHERE b.workspace_id=w.id AND (b.user_id=u.id OR b.email=u.email)))::boolean AS suspended,
COALESCE(x.version,1)::bigint AS access_version,
COALESCE(p.mode,'off')::text AS policy_mode, COALESCE(p.version,1)::bigint AS policy_version,
COALESCE(p.entitlement_version,1)::bigint AS entitlement_version,
COALESCE(p.assurance_max_age_seconds,3600)::integer AS max_age_seconds,
COALESCE(wp.plan='enterprise' AND (wp.valid_until IS NULL OR wp.valid_until>clock_timestamp()),false)::boolean AS business_eligible,
wp.valid_until AS plan_valid_until,
a.session_id AS assurance_session_id, a.user_id AS assurance_user_id, a.connection_id AS assurance_connection_id, a.identity_id AS assurance_identity_id,
a.authenticated_at AS assurance_authenticated_at, a.valid_until AS assurance_valid_until, a.revoked_at AS assurance_revoked_at,
COALESCE(a.policy_version,0)::bigint AS assurance_policy_version,COALESCE(a.access_version,0)::bigint AS assurance_access_version,
COALESCE(a.connection_version,0)::bigint AS assurance_connection_version,COALESCE(a.identity_version,0)::bigint AS assurance_identity_version,
COALESCE(a.entitlement_version,0)::bigint AS assurance_entitlement_version,COALESCE(a.session_version,0)::bigint AS assurance_session_version,
COALESCE(c.id,'00000000-0000-0000-0000-000000000000'::uuid)::uuid AS connection_id,
COALESCE(c.version,0)::bigint AS connection_version,
COALESCE(c.status='active' AND c.disabled_at IS NULL,false)::boolean AS connection_enabled,
COALESCE(c.tested_version=c.version,false)::boolean AS connection_tested,
COALESCE(e.id,'00000000-0000-0000-0000-000000000000'::uuid)::uuid AS identity_id,
COALESCE(e.version,0)::bigint AS identity_version,
COALESCE(e.status='active' AND e.issuer=c.issuer,false)::boolean AS identity_active,
(o.user_id IS NOT NULL)::boolean AS directory_required,
COALESCE(o.status='active',false)::boolean AS directory_active,
(d.disabled_at IS NULL AND d.last_success_at IS NOT NULL)::boolean AS directory_enabled,
COALESCE(d.last_success_at + make_interval(secs=>d.max_staleness_seconds),'epoch'::timestamptz)::timestamptz AS directory_valid_until,
EXISTS(SELECT FROM workspace_identity_recovery_codes r WHERE r.workspace_id=w.id AND r.owner_id=w.owner_id AND r.consumed_at IS NULL AND r.expires_at>clock_timestamp())::boolean AS recovery_ready,
EXISTS(SELECT FROM product_admin_grants g WHERE g.user_id=u.id AND g.revoked_at IS NULL)::boolean AS product_admin_granted,
gs.enabled AS sso_enabled, gs.source AS sso_source, gs.valid_until AS sso_valid_until, gs.revoked_at AS sso_revoked_at,COALESCE(gs.version,0)::bigint AS sso_version,
gd.enabled AS directory_granted, gd.source AS directory_source, gd.valid_until AS directory_grant_valid_until,gd.revoked_at AS directory_revoked_at,COALESCE(gd.version,0)::bigint AS directory_grant_version,
go.enabled AS oauth_enabled, go.source AS oauth_source,go.valid_until AS oauth_valid_until,go.revoked_at AS oauth_revoked_at,COALESCE(go.version,0)::bigint AS oauth_version
FROM unnest(sqlc.arg('session_ids')::uuid[]) WITH ORDINALITY AS k(session_id, ord)
JOIN unnest(sqlc.arg('user_ids')::uuid[]) WITH ORDINALITY AS ku(user_id, ord) ON ku.ord=k.ord
JOIN sessions s ON s.id=k.session_id AND s.user_id=ku.user_id
JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.id=sqlc.arg('workspace_id')
LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=u.id
LEFT JOIN workspace_identity_access x ON x.workspace_id=w.id AND x.user_id=u.id
LEFT JOIN workspace_identity_policies p ON p.workspace_id=w.id
LEFT JOIN workspace_plans wp ON wp.workspace_id=w.id
LEFT JOIN session_workspace_assurances a ON a.session_id=s.id AND a.workspace_id=w.id
LEFT JOIN workspace_external_identities e ON e.workspace_id=w.id AND e.id=a.identity_id
LEFT JOIN workspace_identity_connections c ON c.workspace_id=w.id AND c.id=e.connection_id
LEFT JOIN workspace_directories d ON d.workspace_id=w.id
LEFT JOIN directory_objects o ON o.workspace_id=w.id AND o.directory_id=d.id AND o.user_id=u.id
LEFT JOIN workspace_identity_grants gs ON gs.workspace_id=w.id AND gs.feature='corporate_sso'
LEFT JOIN workspace_identity_grants gd ON gd.workspace_id=w.id AND gd.feature='directory_sync'
LEFT JOIN workspace_identity_grants go ON go.workspace_id=w.id AND go.feature='oauth_provider'
ORDER BY k.ord;

-- name: EnsureIdentityPolicy :one
INSERT INTO workspace_identity_policies(workspace_id) VALUES($1)
ON CONFLICT(workspace_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id RETURNING *;

-- name: GetIdentityLoginTransactionByState :one
SELECT * FROM identity_login_transactions WHERE state_hash=$1;

-- name: GetIdentityLoginTransactionByID :one
SELECT * FROM identity_login_transactions WHERE id=$1;

-- name: RevokeScopedIdentitySessions :execrows
UPDATE sessions SET revoked_at=clock_timestamp(), authority_version=authority_version+1
WHERE authority_workspace_id=sqlc.arg('workspace_id') AND authority_kind IN ('workspace_sso','recovery')
AND (sqlc.narg('user_id')::uuid IS NULL OR user_id=sqlc.narg('user_id'))
AND (sqlc.narg('connection_id')::uuid IS NULL OR authority_connection_id=sqlc.narg('connection_id'))
AND revoked_at IS NULL;

-- name: TouchIdentityAccess :one
INSERT INTO workspace_identity_access(workspace_id,user_id,version) VALUES($1,$2,2)
ON CONFLICT(workspace_id,user_id) DO UPDATE SET version=workspace_identity_access.version+1,updated_at=clock_timestamp()
RETURNING *;

-- name: TouchIdentityPolicy :one
UPDATE workspace_identity_policies SET version=version+1,updated_at=clock_timestamp()
WHERE workspace_id=$1 RETURNING *;

-- name: GetIdentityMemberEligibility :one
SELECT u.id AS user_id,(u.disabled_at IS NOT NULL OR u.is_guest OR u.is_bot)::boolean AS user_denied,
(m.user_id IS NOT NULL)::boolean AS member,
(COALESCE(a.status='suspended',false) OR EXISTS(SELECT FROM workspace_bans b WHERE b.workspace_id=w.id AND (b.user_id=u.id OR b.email=u.email)))::boolean AS suspended,
COALESCE(a.version,1)::bigint AS access_version,
(o.user_id IS NOT NULL)::boolean AS directory_required,
COALESCE(o.status='active' AND d.disabled_at IS NULL AND d.last_success_at IS NOT NULL,false)::boolean AS directory_active,
COALESCE(d.last_success_at+make_interval(secs=>d.max_staleness_seconds),'epoch'::timestamptz)::timestamptz AS directory_valid_until
FROM users u JOIN workspaces w ON w.id=sqlc.arg('workspace_id')
LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=u.id
LEFT JOIN workspace_identity_access a ON a.workspace_id=w.id AND a.user_id=u.id
LEFT JOIN workspace_directories d ON d.workspace_id=w.id
LEFT JOIN directory_objects o ON o.workspace_id=w.id AND o.directory_id=d.id AND o.user_id=u.id
WHERE u.id=sqlc.arg('user_id');

-- name: LockIdentityBoundary :one
-- NO KEY UPDATE still conflicts with every UPDATE/DELETE of these rows (ban, member
-- removal, session revoke) and with the FOR SHARE admission locks, but not with
-- FK KEY SHARE inserts (messages, files, members) referencing the workspace/user.
SELECT s.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
JOIN users u ON u.id=m.user_id JOIN sessions s ON s.user_id=u.id
WHERE w.id=sqlc.arg('workspace_id') AND u.id=sqlc.arg('user_id') AND s.id=sqlc.arg('session_id')
FOR NO KEY UPDATE OF w,u,m,s;

-- name: GetRecentIdentityConnectionTest :one
SELECT * FROM identity_login_transactions WHERE workspace_id=$1 AND connection_id=$2 AND user_id=$3
AND connection_version=$4 AND purpose='test' AND finished_at>clock_timestamp()-interval '5 minutes'
ORDER BY finished_at DESC LIMIT 1;

-- name: GetSSOWorkspaceBySlug :one
SELECT * FROM workspaces WHERE slug=$1;

-- name: IdentityDatabaseNow :one
SELECT clock_timestamp()::timestamptz AS database_now;

-- Admission locks are shared for ordinary resource writes. Revokers already
-- take LockOAuthWorkspace (FOR NO KEY UPDATE); UPDATE of user/member/session rows also
-- conflicts with these locks. Acquire sorted workspaces, users, members, sessions.
-- Boundary-row mutations choose the exclusive mode before reading any source.
-- name: LockIdentityWorkspaceShared :one
SELECT id FROM workspaces WHERE id=$1 FOR SHARE;

-- name: LockIdentityUserShared :one
SELECT id FROM users WHERE id=$1 FOR SHARE;

-- name: LockIdentityUserExclusive :one
SELECT id FROM users WHERE id=$1 FOR UPDATE;

-- name: LockIdentityMemberShared :one
SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE;

-- name: LockIdentityMemberExclusive :one
SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE;

-- name: LockIdentitySessionShared :one
SELECT id FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE;

-- name: LockIdentitySessionExclusive :one
SELECT id FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE;

-- name: LockProductAdminGrantShared :many
SELECT user_id FROM product_admin_grants WHERE user_id=$1 FOR SHARE;

-- name: LockIdentityBotShared :one
SELECT * FROM bots WHERE user_id=$1 FOR SHARE;

-- name: IsIdentityWorkspaceProfileImage :one
SELECT EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = sqlc.arg('workspace_id') AND w.icon_file_id = sqlc.arg('file_id')
    UNION ALL
    SELECT 1 FROM users u
    JOIN workspace_members m ON m.user_id = u.id
    WHERE m.workspace_id = sqlc.arg('workspace_id')
      AND u.avatar_file_id = sqlc.arg('file_id') AND u.disabled_at IS NULL
)::boolean AS allowed;
