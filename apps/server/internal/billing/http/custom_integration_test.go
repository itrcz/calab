//go:build integration

package billinghttp_test

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// The custom plan on the owner routes (ADR-0086 «Индивидуальный тариф»): the owner sees its
// price and limits and keeps paying for it, but cannot change, stop or replace it.
func TestTransitionCustomPlan(t *testing.T) {
	e := newEnv(t, envOpt{plans: transitionPlans(t)})
	e.paid(1000)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, v1.Plan_PLAN_TEAM, "/activate"); st != 200 {
		t.Fatalf("activate Team: %d %v", st, ae)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET discount_bps = 2000 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, e.acc)
		if err != nil {
			return err
		}
		_, _, err = e.core.AssignPlanIn(ctx, q, acc, core.AssignPlan{Plan: core.PlanCustom, RequestID: uuid.New(), Unit: 7,
			Custom: &core.CustomPlan{Limits: []byte(`{"members":10,"bots":3}`), Name: "Acme Pro", Description: "Contract 7"}}, &e.owner)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	var got v1.GetBillingResponse
	if st, r := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 {
		t.Fatalf("GET: %d %s", st, r)
	}
	sum := got.GetSummary()
	if !got.GetAdminAssigned() || sum.GetPlan() != v1.Plan_PLAN_CUSTOM || sum.GetUnitPrice().GetMinor() != 7 || sum.GetDiscountBps() != 0 ||
		sum.GetDailyCost().GetMinor() != 14 {
		t.Fatalf("owner view: %v", &got)
	}
	var offer *v1.BillingPlanOffer
	for _, o := range got.GetOffers() {
		if o.GetPlan() == v1.Plan_PLAN_CUSTOM {
			offer = o
		}
	}
	if offer == nil || offer.GetUnitPrice().GetMinor() != 7 || offer.GetLimits().GetMembers() != 10 || offer.GetLimits().GetBots() != 3 {
		t.Fatalf("custom offer %v", offer)
	}

	// Every owner transition is refused: change, stop, activation of another plan.
	for _, req := range []*v1.BillingQuoteRequest{
		{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN, Plan: v1.Plan_PLAN_ENTERPRISE},
		{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN, Plan: v1.Plan_PLAN_TEAM},
		{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP},
		{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, Plan: v1.Plan_PLAN_ENTERPRISE},
	} {
		if st, r := e.do(e.owner, "POST", e.base()+"/quote", req, nil); st != 409 || r != "BILLING_PLAN_ADMIN_ASSIGNED" {
			t.Fatalf("quote %v: %d %s", req, st, r)
		}
	}
	if _, err := e.core.Stop(ctx, e.acc, &e.owner); !errors.Is(err, billing.ErrPlanAdminAssigned) {
		t.Fatalf("stop: %v", err)
	}
	if _, err := e.core.ChangePlan(ctx, e.acc, core.PlanEnterprise, uuid.New(), &e.owner); !errors.Is(err, billing.ErrPlanAdminAssigned) {
		t.Fatalf("change: %v", err)
	}
	// A quote of the plan itself (activation of what runs) still prices the custom day.
	var q v1.BillingQuote
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE}, &q); st != 200 ||
		q.GetUnitPrice().GetMinor() != 7 || q.GetPlan() != v1.Plan_PLAN_CUSTOM {
		t.Fatalf("quote of the custom plan: %d %s %v", st, r, &q)
	}
	// Top-ups work.
	before := got.GetSummary().GetBalance().GetMinor()
	e.paid(500)
	if st, r := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 || got.GetSummary().GetBalance().GetMinor() != before+500 {
		t.Fatalf("top-up on custom: %d %s %v", st, r, &got)
	}
	// Members: the status only, no money.
	var member v1.GetBillingResponse
	if st, r := e.do(e.member, "GET", e.base(), nil, &member); st != 200 || member.GetSummary() != nil || len(member.GetOffers()) != 0 {
		t.Fatalf("member view: %d %s %v", st, r, &member)
	}
}
