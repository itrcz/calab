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
