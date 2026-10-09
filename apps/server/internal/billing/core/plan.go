package core

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// PlanFor is the workspace plan an account gives (workspace_plans.plan with source = billing).
// managed=false: billing does not manage the plan (inactive or closed account) and the manual
// plan row stays as it is.
//
//	active, suspended          → the account plan (team | enterprise); suspension is enforced
//	                             by the account status, not by the plan
//	stopped, coverage running  → the account plan until the last lot ends (NextDueAt)
//	stopped, coverage over     → free
func PlanFor(acc sqlc.BillingAccount) (plan string, managed bool) {
	switch acc.Status {
	case StatusActive, StatusSuspended:
		return acc.Plan, true
	case StatusStopped:
		if acc.NextDueAt != nil {
			return acc.Plan, true
		}
		return PlanFree, true
	}
	return "", false
}

// SyncPlan writes PlanFor(acc) into workspace_plans (source = billing) and the plan log if it
// differs, inside the caller's transaction (the account must be locked), and runs
// Hooks.PlanChanged. Commands call it themselves; T3 may call it after its own account
// changes. Reports whether the row changed.
func (c *Core) SyncPlan(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, actor *uuid.UUID) (bool, error) {
	s, err := c.stateOf(ctx, q, acc, actor)
	if err != nil {
		return false, err
	}
	if err := s.syncPlan(); err != nil {
		return false, err
	}
	return s.planChanged, nil
}

func (s *state) syncPlan() error {
	plan, managed := PlanFor(s.acc)
	if !managed || s.acc.WorkspaceID == nil {
		return nil
	}
	ws := *s.acc.WorkspaceID
	row, err := s.q.GetWorkspacePlan(s.ctx, ws)
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	if err == nil && row.Source == "billing" && row.Plan == plan && row.Limits == nil && row.ValidUntil == nil {
		return nil
	}
	if _, err := s.q.UpsertBillingWorkspacePlan(s.ctx, sqlc.UpsertBillingWorkspacePlanParams{
		WorkspaceID: ws, Plan: plan, UpdatedBy: s.actor, Now: s.now,
	}); err != nil {
		return err
	}
	if err := s.q.InsertBillingPlanLog(s.ctx, sqlc.InsertBillingPlanLogParams{WorkspaceID: ws, ActorID: s.actor, Plan: plan, Now: s.now}); err != nil {
		return err
	}
	if h := s.c.hooks.PlanChanged; h != nil {
		if err := h(s.ctx, s.q, ws, plan); err != nil {
			return err
		}
	}
	s.planChanged = true
	return nil
}
