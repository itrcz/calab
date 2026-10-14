package admin

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/plans"
)

// The custom plan of an account (ADR-0086 «Индивидуальный тариф») and a superadmin's way back to a
// standard plan. Both commands run in one transaction with their audit row (an exact preview):
// usage locks (plans.LockUsage) → account lock → plan row lock, the order of core.Guard; then the
// limits check (409 PLAN_LIMITS_EXCEEDED unless override_limits — never silent: the plan log note
// and a WARN name the excess) and core.AssignPlanIn.

const (
	actionCustomPlan = "custom_plan"
	actionPlan       = "plan"
)

// customPlan: PUT /api/admin/billing/accounts/{id}/custom-plan.
func (h *Handlers) customPlan(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminSetCustomPlanRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionCustomPlan, &req, accID.String())
	if err != nil {
		return err
	}
	if req.Limits == nil {
		return httpx.Validation("limits", "limits are required")
	}
	lim := plans.FromProto(req.GetLimits())
	if err := lim.Validate(); err != nil {
		return httpx.Validation("limits", err.Error())
	}
	limitsJSON, err := json.Marshal(lim)
	if err != nil {
		return err
	}
	name, description, err := plans.CustomText(req.GetDisplayName(), req.GetDescription())
	if err != nil {
		return err
	}
	unit := req.GetUnit().GetMinor()
	if unit < 0 {
		return httpx.Validation("unit", "the price per seat per day must be positive")
	}
	var from time.Time
	if req.EffectiveFrom != nil {
		if err := req.GetEffectiveFrom().CheckValid(); err != nil {
			return httpx.Validation("effectiveFrom", "invalid effective_from")
		}
		from = req.GetEffectiveFrom().AsTime()
	}
	ctx := r.Context()
	var over []*v1.PlanLimitViolation
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, ws, err := h.lockForPlan(ctx, q, accID, req.GetExpectedRevision())
		if err != nil {
			return nil, err
		}
		if unit > 0 && req.GetUnit().GetCurrency() != acc.Currency {
			return nil, billing.ErrCurrencyMismatch
		}
		note, err := checkLimits(ctx, q, ws, "custom", lim, false, req.GetOverrideLimits(), c.reason, &over)
		if err != nil {
			return nil, err
		}
		after, ar, err := h.d.Core.AssignPlanIn(ctx, q, acc, core.AssignPlan{
			Plan: core.PlanCustom, Custom: &core.CustomPlan{Limits: limitsJSON, Name: name, Description: description},
			Unit: unit, From: from, RequestID: c.requestID, Note: note,
		}, &c.actor)
		if err != nil {
			return nil, err
		}
		return assignEffect(acc, after, ar, ws), nil
	})
	if err != nil {
		return err
	}
	warnOverride(ctx, res, accID, c.actor, "custom", over)
	return h.respond(w, r, res, accID)
}

// setPlan: POST /api/admin/billing/accounts/{id}/plan — a standard paid plan (back from custom).
func (h *Handlers) setPlan(w http.ResponseWriter, r *http.Request) error {
	accID, err := httpx.PathUUID(r, "id", "billing account")
	if err != nil {
		return err
	}
	var req v1.AdminSetAccountPlanRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, actionPlan, &req, accID.String())
	if err != nil {
		return err
	}
	plan := planName(req.GetPlan())
	if plan == "" {
		return httpx.Validation("plan", "plan must be PLAN_TEAM or PLAN_ENTERPRISE")
	}
	ctx := r.Context()
	var over []*v1.PlanLimitViolation
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, ws, err := h.lockForPlan(ctx, q, accID, req.GetExpectedRevision())
		if err != nil {
			return nil, err
		}
		note := "admin: " + c.reason
		if h.d.Plans != nil {
			lim, identity := h.d.Plans.TargetLimits(plan)
			if note, err = checkLimits(ctx, q, ws, plan, lim, identity, req.GetOverrideLimits(), c.reason, &over); err != nil {
				return nil, err
			}
		}
		after, ar, err := h.d.Core.AssignPlanIn(ctx, q, acc, core.AssignPlan{Plan: plan, RequestID: c.requestID, Note: note}, &c.actor)
		if err != nil {
			return nil, err
		}
		return assignEffect(acc, after, ar, ws), nil
	})
	if err != nil {
		return err
	}
	warnOverride(ctx, res, accID, c.actor, plan, over)
	return h.respond(w, r, res, accID)
}

// lockForPlan takes the locks of a plan assignment in the order of core.Guard: the usage locks of
// the workspace, the account, its plan row. A deleted workspace has no plan to assign.
func (h *Handlers) lockForPlan(ctx context.Context, q *sqlc.Queries, accID uuid.UUID, expected uint64) (sqlc.BillingAccount, uuid.UUID, error) {
	acc0, err := q.GetBillingAccount(ctx, accID)
	if db.IsNotFound(err) {
		return acc0, uuid.Nil, billing.ErrAccountNotFound
	}
	if err != nil {
		return acc0, uuid.Nil, err
	}
	if acc0.WorkspaceID == nil {
		return acc0, uuid.Nil, conflict("the workspace of this billing account was deleted")
	}
	ws := *acc0.WorkspaceID
	if err := plans.LockUsage(ctx, q, ws); err != nil {
		return acc0, ws, err
	}
	acc, err := lockAccount(ctx, q, accID)
	if err != nil {
		return acc, ws, err
	}
	if err := notClosed(acc); err != nil {
		return acc, ws, err
	}
	if err := checkRevision(acc, expected); err != nil {
		return acc, ws, err
	}
	if _, err := q.LockWorkspacePlanRow(ctx, ws); err != nil && !db.IsNotFound(err) {
		return acc, ws, err
	}
	return acc, ws, nil
}

// checkLimits refuses target's limits the workspace exceeds unless override (ADR-0086 §6) and
// returns the plan log note: the reason, and what the override let through.
func checkLimits(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, target string, lim plans.Limits, identity, override bool,
	reason string, over *[]*v1.PlanLimitViolation) (string, error) {
	u, err := plans.ReadUsage(ctx, q, ws)
	if err != nil {
		return "", err
	}
	note := "admin: " + reason
	v := u.Violations(lim, identity)
	if len(v) == 0 {
		return note, nil
	}
	if !override {
		return "", plans.ViolationsError(target, v)
	}
	*over = v
	return note + " [over limits: " + plans.ViolationsText(v) + "]", nil
}

func assignEffect(before, after sqlc.BillingAccount, ar core.AssignResult, ws uuid.UUID) *effect {
	res := &v1.AdminBillingMutationResult{Amount: money(ar.Charged, after.Currency), Compensation: money(ar.Compensated, after.Currency)}
	if ar.Price != nil {
		res.Price = priceProto(*ar.Price)
	}
	return &effect{before: &before, acc: &after, res: res,
		target: map[string]string{"account_id": after.ID.String(), "workspace_id": ws.String(), "plan": after.Plan}}
}

func warnOverride(ctx context.Context, res *v1.AdminBillingMutationResult, accID, actor uuid.UUID, plan string, over []*v1.PlanLimitViolation) {
	if len(over) == 0 || res.GetPreview() || res.GetReplayed() {
		return
	}
	slog.WarnContext(ctx, "billing account plan set over its limits", "account", accID, "by", actor, "plan", plan,
		"violations", plans.ViolationsText(over))
}

// customPlanDetails is AdminBillingAccountDetails.custom_plan: the definition in force and the
// account's price versions.
func customPlanDetails(ctx context.Context, q *sqlc.Queries, acc *v1.AdminBillingAccount, accID uuid.UUID) (*v1.AdminCustomPlan, error) {
	out := &v1.AdminCustomPlan{Active: acc.GetPlan() == v1.Plan_PLAN_CUSTOM}
	versions, err := q.ListBillingCustomPrices(ctx, &accID)
	if err != nil {
		return nil, err
	}
	for _, p := range versions {
		out.Prices = append(out.Prices, priceProto(p))
	}
	ws, err := uuid.Parse(acc.GetWorkspaceId())
	if err != nil {
		return out, nil //nolint:nilerr // no workspace (deleted): no definition
	}
	row, err := q.GetWorkspacePlan(ctx, ws)
	if db.IsNotFound(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if row.Plan == core.PlanCustom {
		l, err := plans.ParseLimits(string(row.Limits), plans.CustomBase)
		if err != nil {
			slog.WarnContext(ctx, "invalid custom plan limits", "workspace", ws, "err", err)
		}
		out.Limits, out.DisplayName, out.Description = l.Proto(), row.DisplayName, row.Description
	}
	return out, nil
}
