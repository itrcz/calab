package billinghttp

import (
	"context"
	"errors"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// The plan screen of the client: the plan offers of GET …/billing and the self-serve start
// (BILLING_SELF_SERVE). A self-serve account is the same inactive account a superadmin's enable
// creates (core.EnableAccount): inert until the owner activates it, so creating it on the
// owner's first ACTIVATE quote moves no money and changes no limits.

// selfServeProvider is the provider of SelfServeMarket when self-serve is on, "" otherwise.
func (s *Service) selfServeProvider() string {
	if !s.cfg.SelfServe || s.reg == nil {
		return ""
	}
	p, ok := s.reg.ProviderFor(SelfServeMarket)
	if !ok {
		return ""
	}
	return string(p.ID())
}

// canSelfServe: the owner of a workspace without a live account may start billing.
func (s *Service) canSelfServe(c caller) bool {
	return c.owner && !c.hasAc && s.selfServeProvider() != ""
}

// startSelfServe creates the inactive account of c's workspace; a concurrent start wins and is
// read back.
func (s *Service) startSelfServe(ctx context.Context, c *caller) error {
	acc, err := s.core.EnableAccount(ctx, c.ws.ID, SelfServeMarket, s.selfServeProvider(), &c.user)
	switch {
	case errors.Is(err, billing.ErrAccountExists):
		acc, err = s.db.Q.GetLiveBillingAccountByWorkspace(ctx, &c.ws.ID)
	case err == nil && s.cfg.Committed != nil:
		s.cfg.Committed(ctx, acc)
	}
	if err != nil {
		return err
	}
	c.acc, c.hasAc = acc, true
	return nil
}

// offers are Free, Team and Business of market: the paid ones at the price version in effect
// at now after discountBps; a paid plan without a price version is left out (not for sale).
func (s *Service) offers(ctx context.Context, market string, discountBps int, now time.Time) ([]*v1.BillingPlanOffer, error) {
	out := []*v1.BillingPlanOffer{{Plan: v1.Plan_PLAN_FREE, Limits: s.limits(v1.Plan_PLAN_FREE)}}
	for _, p := range []string{core.PlanTeam, core.PlanEnterprise} {
		price, err := s.db.Q.GetBillingPriceAt(ctx, sqlc.GetBillingPriceAtParams{Market: market, Sku: core.SKU(p), At: now})
		if db.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		unit, err := money.ApplyDiscountBps(price.UnitMinor, discountBps)
		if err != nil {
			return nil, err
		}
		out = append(out, &v1.BillingPlanOffer{Plan: planProto(p), UnitPrice: mon(unit, price.Currency), Limits: s.limits(planProto(p))})
	}
	return out, nil
}

func (s *Service) limits(p v1.Plan) *v1.PlanLimits {
	if s.cfg.PlanLimits == nil {
		return nil
	}
	return s.cfg.PlanLimits(p)
}
