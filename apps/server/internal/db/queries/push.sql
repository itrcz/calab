-- name: LockPushSession :one
-- Fresh DB facts; auth's minute-long session cache cannot authorize token registration.
SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
AND u.disabled_at IS NULL AND NOT u.is_guest AND NOT u.is_bot
FOR UPDATE OF s;

-- name: FindPushEndpoint :one
SELECT * FROM push_devices WHERE provider = $1 AND environment = $2 AND app_id = $3 AND token_hash = $4 FOR UPDATE;

-- name: FindPushInstallation :one
SELECT * FROM push_devices WHERE session_id = $1 AND installation_id = $2 AND provider = $3 AND environment = $4 AND app_id = $5 FOR UPDATE;

-- name: CountPushDevices :one
SELECT count(*) FROM push_devices WHERE user_id = $1;

-- name: CreatePushDevice :one
INSERT INTO push_devices (user_id, session_id, installation_id, provider, environment, app_id, token, token_hash, notifications_enabled, calls_enabled, mentions_enabled, all_enabled)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *;

-- name: RotatePushDevice :one
UPDATE push_devices SET token = $2, token_hash = $3, version = version + 1,
notifications_enabled = $4, calls_enabled = $5, mentions_enabled = $6, all_enabled = $7, updated_at = now(), expires_at = now() + interval '30 days'
WHERE id = $1 RETURNING *;

-- name: RefreshPushDevice :one
UPDATE push_devices SET updated_at = now(), expires_at = now() + interval '30 days'
WHERE id = $1 RETURNING *;

-- name: DeletePushDeviceOwned :execrows
DELETE FROM push_devices WHERE id = $1 AND user_id = $2 AND session_id = $3 AND version = $4;

-- name: DeletePushDeviceVersion :execrows
DELETE FROM push_devices WHERE id = $1 AND version = $2 AND token_hash = $3;

-- name: DeletePushSessions :exec
DELETE FROM push_devices WHERE session_id = ANY($1::uuid[]);

-- name: DiscardPushRotation :exec
DELETE FROM push_deliveries WHERE device_id = $1 AND device_version <> $2;

-- name: ListPushDevices :many
SELECT d.* FROM push_devices d JOIN sessions s ON s.id = d.session_id JOIN users u ON u.id = d.user_id
WHERE d.user_id = $1 AND d.expires_at > now() AND s.user_id = d.user_id
AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL AND NOT u.is_bot AND NOT u.is_guest
ORDER BY d.id LIMIT 32;

-- name: LockPushDevice :one
SELECT * FROM push_devices WHERE id = $1 FOR UPDATE;

-- name: QueuePushDelivery :execrows
-- Caller locks the endpoint row so the per-device backlog bound holds under concurrency.
INSERT INTO push_deliveries (device_id, device_version, event_key, kind, reference_id, room_id, expires_at, actor_id, notice_kind, context_id, occurrence_at, reminder_minutes)
SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
WHERE CASE WHEN $4::smallint = 2 THEN
 (SELECT count(*) FROM push_deliveries WHERE device_id=$1 AND kind=2) < 4
ELSE
 (SELECT count(*) FROM push_deliveries WHERE device_id=$1 AND kind<>2 AND delivered_at IS NULL AND attempts<6 AND expires_at>now()) < 128
 AND (SELECT count(*) FROM push_deliveries WHERE device_id=$1 AND kind<>2) < 2048
END
ON CONFLICT (device_id, event_key) DO NOTHING;

-- name: ClaimPushDeliveries :many
WITH live_calls AS MATERIALIZED (
 SELECT id FROM push_deliveries WHERE kind=2 AND not_before<=now() AND expires_at>now() AND attempts<6 AND delivered_at IS NULL
 AND (lease_until IS NULL OR lease_until<now()) ORDER BY expires_at,not_before,id LIMIT 3 FOR UPDATE SKIP LOCKED
), ordinary AS MATERIALIZED (
 SELECT id FROM push_deliveries WHERE kind<>2 AND not_before<=now() AND expires_at>now() AND attempts<6 AND delivered_at IS NULL
 AND (lease_until IS NULL OR lease_until<now()) ORDER BY expires_at,not_before,id
 LIMIT (4-(SELECT count(*) FROM live_calls)) FOR UPDATE SKIP LOCKED
), ready AS (SELECT id FROM live_calls UNION ALL SELECT id FROM ordinary)
UPDATE push_deliveries d SET lease_id = $1, lease_until = now() + interval '15 seconds', attempts = attempts + 1
FROM ready WHERE d.id = ready.id RETURNING d.*;

-- name: LockPushDispatch :one
-- Bind endpoint version and user/session state transactionally just before provider dispatch.
SELECT d.*, u.settings, u.presence_status, u.presence_until FROM push_devices d
JOIN push_deliveries p ON p.device_id = d.id AND p.device_version = d.version
JOIN sessions s ON s.id = d.session_id AND s.user_id = d.user_id JOIN users u ON u.id = d.user_id
WHERE p.id = $1 AND p.lease_id = $2 AND p.lease_until > now() AND p.expires_at > now()
AND d.expires_at > now() AND s.revoked_at IS NULL AND s.expires_at > now()
AND u.disabled_at IS NULL AND NOT u.is_guest AND NOT u.is_bot
FOR UPDATE OF p, d FOR SHARE OF s;

-- name: CompletePushDelivery :execrows
UPDATE push_deliveries SET delivered_at = now(), lease_id = NULL, lease_until = NULL WHERE id = $1 AND lease_id = $2;

-- name: RetryPushDelivery :execrows
UPDATE push_deliveries SET lease_id = NULL, lease_until = NULL, not_before = $3
WHERE id = $1 AND lease_id = $2;

-- name: CleanupPushDeliveries :execrows
DELETE FROM push_deliveries WHERE id IN (SELECT id FROM push_deliveries
WHERE expires_at <= now() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED);

-- name: CleanupPushDevices :execrows
-- Lock both facts before deletion. Same-token refresh need not change version;
-- session renewal may only change s, so an ID/version snapshot is insufficient.
WITH expired AS MATERIALIZED (
 SELECT d.id FROM push_devices d JOIN sessions s ON s.id = d.session_id
 WHERE d.expires_at <= now() OR s.revoked_at IS NOT NULL OR s.expires_at <= now()
 ORDER BY d.expires_at LIMIT 500 FOR UPDATE OF d, s SKIP LOCKED
)
DELETE FROM push_devices d USING expired WHERE d.id = expired.id;
-- name: LockPushRegistry :exec
-- Registrations are infrequent; serialize cross-session endpoint rebinding and the user cap.
SELECT pg_advisory_xact_lock(71550665450630184);

-- name: ListPushMessageTargets :many
-- Routing candidates only. The worker resolves current VIEW_ROOM and notification rules.
SELECT DISTINCT d.user_id FROM push_devices d JOIN rooms r ON r.id = $1
WHERE d.user_id > sqlc.arg('after')::uuid AND d.expires_at > now()
AND (EXISTS (SELECT 1 FROM dm_members dm WHERE dm.room_id=r.id AND dm.user_id=d.user_id) OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=d.user_id))
AND r.archived_at IS NULL AND r.type NOT IN ('task','notes')
ORDER BY d.user_id LIMIT 64;

-- name: PushMessageFacts :one
SELECT coalesce(r.level, 'inherit')::text AS room_level, coalesce(w.level, 'mentions')::text AS workspace_level,
 coalesce(r.muted_until > now(),false)::boolean AS room_muted, coalesce(w.muted_until > now(),false)::boolean AS workspace_muted,
 (EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id=sqlc.arg('message_id') AND mm.user_id=sqlc.arg('user_id'))
 OR EXISTS (SELECT 1 FROM message_everyone_mentions em WHERE em.message_id=sqlc.arg('message_id')))::boolean AS mentioned,
 EXISTS (SELECT 1 FROM bot_blocks b JOIN messages msg ON msg.author_id=b.bot_user_id WHERE b.user_id=sqlc.arg('user_id') AND msg.id=sqlc.arg('message_id'))::boolean AS blocked
FROM (SELECT 1) one LEFT JOIN room_notification_settings r ON r.user_id=sqlc.arg('user_id') AND r.room_id=sqlc.arg('room_id')
LEFT JOIN workspace_notification_settings w ON w.user_id=sqlc.arg('user_id') AND w.workspace_id=sqlc.narg('workspace_id')::uuid;

-- name: DeleteInvalidPushDevice :execrows
DELETE FROM push_devices WHERE id=$1 AND version=$2 AND token_hash=$3
AND (sqlc.narg('invalid_before')::timestamptz IS NULL OR updated_at <= sqlc.narg('invalid_before')::timestamptz);

-- name: GetPushDevice :one
SELECT * FROM push_devices WHERE id=$1;

-- name: CleanupPushDeviceDeliveries :exec
-- Endpoint lock is held; expired receipts never grow admission storage indefinitely.
DELETE FROM push_deliveries WHERE device_id=$1 AND expires_at<=now();

-- name: DiscardPreviousPushCalls :exec
-- Current CallStore authorizes only this genuine live call for the callee. Old
-- terminal calls cannot become authorized again; preserve only current-call dedupe.
DELETE FROM push_deliveries WHERE device_id=$1 AND kind=2 AND reference_id<>$2;

-- name: LockPushIntentAdmission :exec
-- Separate from endpoint/session/provider locks; keep the bounded global queue exact.
SELECT pg_advisory_xact_lock(71550665450630185);

-- name: QueuePushIntent :execrows
-- The cap bounds pending work. Completed rows only keep dedupe until expiry (<= 5 min)
-- and must not make a busy server drop new notifications.
INSERT INTO push_intents(recipient_id,event_key,kind,reference_id,room_id,actor_id,notice_kind,context_id,occurrence_at,reminder_minutes,expires_at)
SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
WHERE CASE WHEN $3::smallint=2 THEN (SELECT count(*) FROM push_intents WHERE kind=2 AND completed_at IS NULL)<4096
ELSE (SELECT count(*) FROM push_intents WHERE kind<>2 AND completed_at IS NULL)<8192 END
ON CONFLICT(recipient_id,event_key) DO NOTHING;

-- name: ClaimPushIntents :many
WITH live_calls AS MATERIALIZED (
 SELECT id FROM push_intents WHERE kind=2 AND not_before<=now() AND expires_at>now() AND completed_at IS NULL AND attempts<64
 AND (lease_until IS NULL OR lease_until<now()) ORDER BY expires_at,id LIMIT 4 FOR UPDATE SKIP LOCKED
), ordinary AS MATERIALIZED (
 SELECT id FROM push_intents WHERE kind<>2 AND not_before<=now() AND expires_at>now() AND completed_at IS NULL AND attempts<64
 AND (lease_until IS NULL OR lease_until<now()) ORDER BY not_before,expires_at,id LIMIT 32 FOR UPDATE SKIP LOCKED
), ready AS (SELECT id FROM live_calls UNION ALL SELECT id FROM ordinary)
UPDATE push_intents p SET lease_id=$1,lease_until=now()+interval '5 seconds',attempts=attempts+1
FROM ready WHERE p.id=ready.id RETURNING p.*;

-- name: AdvancePushIntent :execrows
UPDATE push_intents SET after_user=$3 WHERE id=$1 AND lease_id=$2;

-- name: CompletePushIntent :execrows
UPDATE push_intents SET completed_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2;

-- name: RetryPushIntent :execrows
UPDATE push_intents SET lease_id=NULL,lease_until=NULL,not_before=now()+least(32,power(2,least(attempts,5))) * interval '1 second' WHERE id=$1 AND lease_id=$2;

-- name: CleanupPushIntents :execrows
DELETE FROM push_intents WHERE id IN(SELECT id FROM push_intents WHERE expires_at<=now() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED);


-- name: LockPushDeliverySession :one
-- Delivery reads may coexist across endpoints of one session; revocation/renewal
-- still serialize on this row. Ordinary APNs must not hold VoIP session admission.
SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id
WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
AND u.disabled_at IS NULL AND NOT u.is_guest AND NOT u.is_bot FOR SHARE OF s;

-- name: HasPushIntent :one
SELECT EXISTS(SELECT 1 FROM push_intents WHERE recipient_id IS NOT DISTINCT FROM sqlc.narg('recipient_id')::uuid AND event_key=$1)::boolean;

-- name: HasPushDelivery :one
SELECT EXISTS(SELECT 1 FROM push_deliveries WHERE device_id=$1 AND event_key=$2)::boolean;

-- name: GetPushReference :one
-- Opaque receipt is scoped to the current endpoint version and session, never a URL grant.
SELECT p.* FROM push_deliveries p JOIN push_devices d ON d.id=p.device_id AND d.version=p.device_version
WHERE p.id=$1 AND d.id=$2 AND d.user_id=$3 AND d.session_id=$4
AND p.kind IN (1,2) AND p.expires_at>now() AND d.expires_at>now() AND p.delivered_at IS NOT NULL;
