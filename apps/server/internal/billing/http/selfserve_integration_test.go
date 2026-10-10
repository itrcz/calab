//go:build integration

package billinghttp_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	billinghttp "github.com/calaba/calaba/server/internal/billing/http"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// selfServe: the plan screen's server side — self-serve on, plan limits by kind, committed hook counted.
func selfServe(committed *int) envOpt {
	return envOpt{noAccount: true, cfg: func(c *billinghttp.Config) {
		c.SelfServe = true
		c.PlanLimits = func(p v1.Plan) *v1.PlanLimits { return &v1.PlanLimits{Members: uint32(p) * 100} } //nolint:gosec // small enum
		c.Committed = func(context.Context, sqlc.BillingAccount) { *committed++ }
	}}
}

func offerUnits(offers []*v1.BillingPlanOffer) map[v1.Plan]int64 {
	out := map[v1.Plan]int64{}
	for _, o := range offers {
		out[o.GetPlan()] = o.GetUnitPrice().GetMinor()
	}
	return out
}

// Self-serve: the owner of a workspace without an account sees self_serve and the offers; only
// an ACTIVATE quote creates the (inactive) account, for the plan asked; activate starts that plan.
func TestSelfServeStart(t *testing.T) {
	committed := 0
	e := newEnv(t, selfServe(&committed))
	var got v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 || !got.GetSelfServe() || got.GetSummary() != nil {
		t.Fatalf("owner view: %d %v", st, &got)
	}
	if u := offerUnits(got.GetOffers()); len(u) != 3 || u[v1.Plan_PLAN_FREE] != 0 || u[v1.Plan_PLAN_TEAM] != 10 || u[v1.Plan_PLAN_ENTERPRISE] != 30 {
		t.Fatalf("offers %v", got.GetOffers())
	}
	if got.GetOffers()[1].GetLimits().GetMembers() == 0 {
		t.Fatalf("offer limits %v", got.GetOffers())
	}
	var member v1.GetBillingResponse
	if st, _ := e.do(e.member, "GET", e.base(), nil, &member); st != 200 || member.GetSelfServe() || len(member.GetOffers()) != 0 {
		t.Fatalf("member view: %d %v", st, &member)
	}
	// Nothing but an owner's ACTIVATE quote starts an account.
	if st, r := e.do(e.member, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE}, nil); st != 403 || r != "BILLING_PERMISSION_REQUIRED" {
		t.Fatalf("member quote: %d %s", st, r)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP}, nil); st != 404 || r != "BILLING_ACCOUNT_NOT_FOUND" {
		t.Fatalf("stop quote: %d %s", st, r)
	}
	if st, _ := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{}, nil); st != 404 {
		t.Fatalf("topup without account: %d", st)
	}
	bad := &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, Plan: v1.Plan_PLAN_FREE}
	if st, _ := e.do(e.owner, "POST", e.base()+"/quote", bad, nil); st != 422 {
		t.Fatalf("activate quote for Free: %d", st)
	}
	if _, err := e.d.Q.GetLiveBillingAccountByWorkspace(ctx, &e.ws); err == nil {
		t.Fatal("an account was created before a valid ACTIVATE quote")
	}

	var q v1.BillingQuote
	req := &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, Plan: v1.Plan_PLAN_ENTERPRISE}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", req, &q); st != 200 || q.GetPlan() != v1.Plan_PLAN_ENTERPRISE ||
		q.GetSeats() != 2 || q.GetCharge().GetMinor() != 60 || q.GetToPay().GetMinor() != 60 {
		t.Fatalf("quote: %d %s %v", st, r, &q)
	}
	acc, err := e.d.Q.GetLiveBillingAccountByWorkspace(ctx, &e.ws)
	if err != nil || acc.Status != "inactive" || acc.Market != "global" || acc.Currency != "USD" || committed != 1 {
		t.Fatalf("account %v %v committed=%d", acc, err, committed)
	}
	e.acc = acc.ID
	// A second quote reuses the account.
	if st, _ := e.do(e.owner, "POST", e.base()+"/quote", req, &q); st != 200 || committed != 1 {
		t.Fatalf("second quote: %d committed=%d", st, committed)
	}
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 || got.GetSelfServe() || got.GetSummary() == nil || len(got.GetOffers()) != 3 {
		t.Fatalf("after start: %v", &got)
	}

	e.paid(1000)
	if st, _ := e.do(e.owner, "POST", e.base()+"/quote", req, &q); st != 200 || q.GetToPay().GetMinor() != 0 {
		t.Fatalf("quote after top-up: %v", &q)
	}
	act := &v1.BillingActionRequest{QuoteId: q.GetQuoteId(), RequestId: uuid.NewString(), ExpectedRevision: q.GetRevision(), Plan: v1.Plan_PLAN_ENTERPRISE}
	if st, r := e.do(e.owner, "POST", e.base()+"/activate", act, &got); st != 200 || got.GetStatus().GetState() != v1.BillingState_BILLING_STATE_ACTIVE ||
		got.GetSummary().GetPlan() != v1.Plan_PLAN_ENTERPRISE || got.GetSummary().GetBalance().GetMinor() != 940 {
		t.Fatalf("activate: %d %s %v", st, r, &got)
	}
	// The plan is part of the request: the same id with another plan is another request.
	act.Plan = v1.Plan_PLAN_TEAM
	if st, r := e.do(e.owner, "POST", e.base()+"/activate", act, nil); st != 409 || r != "BILLING_REQUEST_REUSED" {
		t.Fatalf("same id, other plan: %d %s", st, r)
	}
}

// Without BILLING_SELF_SERVE the owner of a workspace without an account sees nothing to start
// and a quote does not create one.
func TestSelfServeOff(t *testing.T) {
	e := newEnv(t, envOpt{noAccount: true})
	var got v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 || got.GetSelfServe() || len(got.GetOffers()) != 0 {
		t.Fatalf("owner view: %d %v", st, &got)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE}, nil); st != 404 || r != "BILLING_ACCOUNT_NOT_FOUND" {
		t.Fatalf("quote: %d %s", st, r)
	}
	if _, err := e.d.Q.GetLiveBillingAccountByWorkspace(ctx, &e.ws); err == nil {
		t.Fatal("an account was created")
	}
}

// An existing account's offers carry its discount.
func TestOffersDiscounted(t *testing.T) {
	e := newEnv(t)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET discount_bps = 5000 WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	var got v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 || got.GetSelfServe() {
		t.Fatalf("owner view: %d %v", st, &got)
	}
	if u := offerUnits(got.GetOffers()); u[v1.Plan_PLAN_TEAM] != 5 || u[v1.Plan_PLAN_ENTERPRISE] != 15 {
		t.Fatalf("offers %v", got.GetOffers())
	}
}
