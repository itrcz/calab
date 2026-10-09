package plans

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// businessFeatures are the identity features a Business plan (PLAN_ENTERPRISE) grants.
var businessFeatures = []identitypolicy.Feature{identitypolicy.SSO, identitypolicy.DirectorySync, identitypolicy.OAuthProvider}

// setBusinessGrants writes the cloud_business identity grants of ws (enabled with the plan
// validity until) inside the caller's transaction, which holds the workspace lock. An operator
// grant (onprem_enterprise) is never replaced. force rewrites rows that already match (the
// superadmin plan edit bumps every grant version); otherwise only differing rows are written.
// Reports whether a row was written.
func setBusinessGrants(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, enabled bool, until *time.Time, actor *uuid.UUID, force bool) (bool, error) {
	changed := false
	for _, feature := range businessFeatures {
		current, err := q.GetIdentityGrant(ctx, sqlc.GetIdentityGrantParams{WorkspaceID: ws, Feature: string(feature)})
		if err != nil && !db.IsNotFound(err) {
			return false, err
		}
		if err == nil && current.Source == "onprem_enterprise" {
			continue // plan edits cannot replace an operator grant
		}
		if !force && err == nil && current.Source == "cloud_business" && current.Enabled == enabled &&
			current.RevokedAt == nil && sameTime(current.ValidUntil, until) {
			continue
		}
		if !force && db.IsNotFound(err) && !enabled {
			continue // no grant row denies already
		}
		if _, err := q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: string(feature),
			Enabled: enabled, Source: "cloud_business", ValidUntil: until, UpdatedBy: actor}); err != nil {
			return false, err
		}
		changed = true
	}
	return changed, nil
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

// SyncBillingIdentity makes the identity grants of a billing-managed workspace follow its plan
// (workspace_plans with source = billing): Business (enterprise) enables SSO, directory sync and
// the OAuth provider, any other plan (team, free after a stop) disables them, and a change
// invalidates the workspace's identity sessions like the superadmin plan edit
// (auth.InvalidateIdentity "plan_changed"). A billing suspension keeps the plan and the grants
// (ADR-0080 §3): the identity gate closes the workspace from billing_accounts.
//
// Billing calls it AFTER the commit of an account change, in its own transaction: the identity
// writes lock the workspace row, and the lock order is workspace → billing account, so it must
// never run while a billing account is locked. Reading the current plan under the workspace lock
// makes it idempotent and convergent: concurrent calls serialize on that lock and the last one
// sees the last committed plan. A manual plan (any other source) is left to the superadmin
// edit. Reports whether the grants changed.
func SyncBillingIdentity(ctx context.Context, d *db.DB, ws uuid.UUID) (bool, error) {
	changed := false
	// Background work, not a request write: the request's identity admission (closed for a
	// suspended workspace) must not refuse it.
	ctx = db.WithoutAdmission(ctx)
	err := d.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			if db.IsNotFound(err) {
				return nil // deleted meanwhile
			}
			return err
		}
		row, err := q.GetWorkspacePlan(ctx, ws)
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if row.Source != "billing" {
			return nil
		}
		if changed, err = setBusinessGrants(ctx, q, ws, row.Plan == "enterprise", nil, nil, false); err != nil || !changed {
			return err
		}
		return auth.InvalidateIdentity(ctx, q, ws, nil, nil, "plan_changed")
	})
	return changed, err
}
