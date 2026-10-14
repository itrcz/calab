package core

import (
	"context"
	"fmt"

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

// CustomPlan is the definition of a custom plan (ADR-0086 «Индивидуальный тариф»): its limits
// (plans.Limits as JSON), the name members see (empty = «Индивидуальный») and a short
// description. It lives on the workspace_plans row (source = billing) while the account is on it.
type CustomPlan struct {
	Limits      []byte
	Name        string
	Description string
}

// maxPlanNote is workspace_plans.note's CHECK.
const maxPlanNote = 500

func (s *state) syncPlan() error {
	plan, managed := PlanFor(s.acc)
	if !managed || s.acc.WorkspaceID == nil {
		return nil
	}
	ws := *s.acc.WorkspaceID
	row, err := s.q.GetWorkspacePlan(s.ctx, ws)
	found := err == nil
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	var def CustomPlan
	if plan == PlanCustom {
		switch {
		case s.custom != nil:
			def = *s.custom
		case found && row.Plan == PlanCustom:
			def = CustomPlan{Limits: row.Limits, Name: row.DisplayName, Description: row.Description}
		default:
			// Only a superadmin's assignment puts an account on custom, and it writes the definition.
			return fmt.Errorf("billing: account %s is on the custom plan without its definition", s.acc.ID)
		}
	}
	if found && s.custom == nil && row.Source == "billing" && row.Plan == plan && row.ValidUntil == nil &&
		(plan == PlanCustom || (row.Limits == nil && row.DisplayName == "" && row.Description == "")) {
		return nil
	}
	note := s.planNote
	if note == "" {
		note = "billing"
	}
	if r := []rune(note); len(r) > maxPlanNote {
		note = string(r[:maxPlanNote])
	}
	logged := def.Limits
	if logged == nil {
		logged = []byte("{}")
	}
	if _, err := s.q.UpsertBillingWorkspacePlan(s.ctx, sqlc.UpsertBillingWorkspacePlanParams{
		WorkspaceID: ws, Plan: plan, Limits: def.Limits, Note: note, UpdatedBy: s.actor, Now: s.now,
		DisplayName: def.Name, Description: def.Description,
	}); err != nil {
		return err
	}
	if err := s.q.InsertBillingPlanLog(s.ctx, sqlc.InsertBillingPlanLogParams{
		WorkspaceID: ws, ActorID: s.actor, Plan: plan, Limits: logged, Note: note, Now: s.now,
		DisplayName: def.Name, Description: def.Description,
	}); err != nil {
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
