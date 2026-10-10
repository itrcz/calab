package billinghttp

import (
	"context"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/plans"
)

// Plan transitions on the owner routes (ADR-0086). The quote checks the transition it prices
// (without locks), the core command checks it again under the account lock (core.Guard), so a
// member or bot added between the quote and the commit is caught. The plan screen shows the
// violations of every plan up front (BillingPlanOffer.violations).

// adminAssigned: a superadmin assigned the workspace's plan; self-serve does not override it.
func (s *Service) adminAssigned(ctx context.Context, c caller) (bool, error) {
	return plans.AdminAssignedAt(ctx, s.db.Q, c.ws.ID, s.now(ctx), false)
}

// quoteTarget is the plan a quote of purpose moves the workspace to ("" = no transition to check:
// RESUME_FREE, a replay of the current state, an unknown purpose).
func quoteTarget(c caller, purpose v1.BillingQuotePurpose, plan string) string {
	switch purpose {
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE:
		if plan == "" {
			plan = core.PlanTeam // a new account starts on Team (core.EnableAccount)
			if c.hasAc {
				plan = c.acc.Plan
			}
		}
		if c.hasAc && c.acc.Status == core.StatusActive && c.acc.Plan == plan {
			return ""
		}
		return plan
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN:
		if c.hasAc && c.acc.Plan == plan {
			return ""
		}
		return plan
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_RESUME_PAID:
		if c.hasAc {
			return c.acc.Plan
		}
	case v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP:
		if c.hasAc && c.acc.Status == core.StatusActive {
			return core.PlanFree
		}
	}
	return ""
}

// checkQuoteTransition refuses a quote whose transition the workspace cannot make now
// (BILLING_PLAN_ADMIN_ASSIGNED, PLAN_LIMITS_EXCEEDED with the violations). It runs before a
// self-serve start, so a refused quote creates no account.
func (s *Service) checkQuoteTransition(ctx context.Context, c caller, purpose v1.BillingQuotePurpose, plan string) error {
	target := quoteTarget(c, purpose, plan)
	if target == "" || s.cfg.Plans == nil {
		return nil
	}
	return s.cfg.Plans.CheckTransition(ctx, s.db.Q, c.ws.ID, target, s.now(ctx), false)
}

// markViolations fills BillingPlanOffer.violations of the plan screen.
func (s *Service) markViolations(ctx context.Context, c caller, offers []*v1.BillingPlanOffer) error {
	if s.cfg.Plans == nil || len(offers) == 0 {
		return nil
	}
	v, err := s.cfg.Plans.OfferViolations(ctx, s.db.Q, c.ws.ID)
	if err != nil {
		return err
	}
	for _, o := range offers {
		o.Violations = v[o.GetPlan()]
	}
	return nil
}
