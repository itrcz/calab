-- Balance billing v1 (ADR-0080 v5): admission and enforcement (T3). Owned by the admission
-- side (workspaces, auth, guests, identitypolicy, plans); money queries live in billing*.sql.
-- The seat count is CountBillableMembers (billing.sql).

-- name: WorkspaceBillingSuspended :one
-- Whether the live billing account of a workspace is suspended for debt (false without one).
-- Enforced only with BILLING_ENFORCEMENT_ENABLED; independent of the moderation suspension
-- (workspaces.suspended_at).
SELECT EXISTS (
    SELECT 1 FROM billing_accounts
    WHERE workspace_id = $1 AND status = 'suspended'
)::boolean;

-- name: GetWorkspaceBillingStatus :one
-- Workspace.billing (WorkspaceBillingStatus, no amounts): the plan source and the live
-- account's state; account_status is empty without a live account.
SELECT
    COALESCE((SELECT wp.source FROM workspace_plans wp WHERE wp.workspace_id = w.id), 'manual')::text AS source,
    COALESCE(a.status, '')::text AS account_status,
    a.negative_since, a.suspend_at, a.lapsed_at
FROM workspaces w
LEFT JOIN billing_accounts a ON a.workspace_id = w.id AND a.status <> 'closed'
WHERE w.id = $1;
