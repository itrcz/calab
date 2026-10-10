-- name: GetWorkspacePlan :one
SELECT * FROM workspace_plans WHERE workspace_id = $1;

-- name: UpsertWorkspacePlan :one
-- The manual plan (superadmin). A billing-managed plan (source = 'billing', ADR-0080) is not
-- touched: no row comes back (409 BILLING_PLAN_MANAGED).
INSERT INTO workspace_plans (workspace_id, plan, limits, valid_until, note, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (workspace_id) DO UPDATE SET
    plan = EXCLUDED.plan, limits = EXCLUDED.limits, valid_until = EXCLUDED.valid_until,
    note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
WHERE workspace_plans.source = 'manual'
RETURNING *;

-- name: InsertPlanLog :exec
INSERT INTO workspace_plan_log (workspace_id, actor_id, plan, limits, valid_until, note)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: ListPlanLog :many
SELECT l.*, u.email AS actor_email
FROM workspace_plan_log l
LEFT JOIN users u ON u.id = l.actor_id
WHERE l.workspace_id = $1
ORDER BY l.id DESC
LIMIT 100;

-- name: AdminSearchWorkspaces :many
-- Superadmin search by name, slug or owner email (pattern already escaped for LIKE; empty =
-- all), newest first.
SELECT w.id
FROM workspaces w
JOIN users u ON u.id = w.owner_id
WHERE sqlc.arg('pattern')::text = ''
   OR w.name ILIKE '%' || sqlc.arg('pattern')::text || '%'
   OR w.slug ILIKE '%' || sqlc.arg('pattern')::text || '%'
   OR u.email::text ILIKE '%' || sqlc.arg('pattern')::text || '%'
ORDER BY w.id DESC
LIMIT 50;

-- name: AdminWorkspaceDetails :many
-- Workspaces with their owner, plan row and usage (members without guests, live rooms,
-- time of the newest message; epoch = none).
SELECT sqlc.embed(w), sqlc.embed(u),
    p.note AS plan_note, p.updated_by AS plan_updated_by, p.updated_at AS plan_updated_at,
    sb.email AS suspended_by_email,
    (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = w.id AND m.role <> 'guest')::integer AS members,
    (SELECT count(*) FROM rooms r WHERE r.workspace_id = w.id AND r.archived_at IS NULL AND r.type <> 'task')::integer AS rooms,
    (SELECT count(*) FROM workspace_members m JOIN users bu ON bu.id = m.user_id WHERE m.workspace_id = w.id AND bu.is_bot)::integer AS bots,
    (SELECT count(*) FROM sticker_packs sp WHERE sp.workspace_id = w.id AND sp.deleted_at IS NULL)::integer AS sticker_packs,
    coalesce((SELECT max(lm.created_at) FROM rooms r
        CROSS JOIN LATERAL (SELECT m.created_at FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) lm
        WHERE r.workspace_id = w.id), 'epoch'::timestamptz)::timestamptz AS last_activity
FROM workspaces w
JOIN users u ON u.id = w.owner_id
LEFT JOIN workspace_plans p ON p.workspace_id = w.id
LEFT JOIN users sb ON sb.id = w.suspended_by
WHERE w.id = ANY(sqlc.arg('ids')::uuid[]);

-- name: GetWorkspacePlanUsage :one
-- What a plan transition is checked against (ADR-0086, plans.Violations): every counted limit and
-- every plan-gated feature in use, in one read. Identity features granted by the operator
-- (onprem_enterprise) do not depend on the plan and come back in operator_features.
SELECT
    (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = sqlc.arg('workspace_id')::uuid AND m.role <> 'guest')::bigint AS members,
    (SELECT count(*) FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = sqlc.arg('workspace_id')::uuid AND u.is_bot)::bigint AS bots,
    (SELECT w.storage_used_bytes FROM workspaces w WHERE w.id = sqlc.arg('workspace_id')::uuid)::bigint AS storage_bytes,
    (SELECT count(*) FROM boards b WHERE b.workspace_id = sqlc.arg('workspace_id')::uuid)::bigint AS boards,
    (SELECT count(*) FROM sticker_packs p WHERE p.workspace_id = sqlc.arg('workspace_id')::uuid AND p.deleted_at IS NULL)::bigint AS sticker_packs,
    (SELECT count(*) FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id AND p.deleted_at IS NULL
        WHERE p.workspace_id = sqlc.arg('workspace_id')::uuid AND s.deleted_at IS NULL)::bigint AS stickers,
    (SELECT coalesce(array_agg(r.user_limit), '{}') FROM rooms r
        WHERE r.workspace_id = sqlc.arg('workspace_id')::uuid AND r.type = 'voice' AND r.archived_at IS NULL AND r.user_limit > 0)::integer[] AS room_user_limits,
    (SELECT coalesce(max(x.n), 0) FROM (SELECT count(*) AS n FROM board_forms f JOIN boards b ON b.id = f.board_id
        WHERE b.workspace_id = sqlc.arg('workspace_id')::uuid GROUP BY f.board_id) x)::bigint AS max_board_forms,
    (SELECT count(*) FROM board_rules r JOIN boards b ON b.id = r.board_id
        WHERE b.workspace_id = sqlc.arg('workspace_id')::uuid AND r.enabled)::bigint AS automations,
    (SELECT count(*) FROM board_webhooks h JOIN boards b ON b.id = h.board_id
        WHERE b.workspace_id = sqlc.arg('workspace_id')::uuid AND h.disabled_at IS NULL)::bigint AS board_webhooks,
    (SELECT count(*) FROM sip_accounts a WHERE a.workspace_id = sqlc.arg('workspace_id')::uuid AND a.enabled)::bigint AS telephony,
    (SELECT count(*) FROM workspace_identity_connections c WHERE c.workspace_id = sqlc.arg('workspace_id')::uuid AND c.status = 'active')::bigint AS sso,
    (SELECT count(*) FROM workspace_directories d WHERE d.workspace_id = sqlc.arg('workspace_id')::uuid AND d.disabled_at IS NULL)::bigint AS directories,
    (SELECT count(*) FROM oauth_clients o WHERE o.workspace_id = sqlc.arg('workspace_id')::uuid AND o.disabled_at IS NULL)::bigint AS oauth_apps,
    (SELECT coalesce(array_agg(g.feature), '{}') FROM workspace_identity_grants g
        WHERE g.workspace_id = sqlc.arg('workspace_id')::uuid AND g.source = 'onprem_enterprise' AND g.enabled AND g.revoked_at IS NULL)::text[] AS operator_features;

-- name: LockWorkspacePlanRow :one
-- The plan row under a lock (ADR-0086): a self-serve start decides whether a superadmin assigned the
-- plan while the superadmin's upsert waits for it.
SELECT * FROM workspace_plans WHERE workspace_id = $1 FOR UPDATE;
