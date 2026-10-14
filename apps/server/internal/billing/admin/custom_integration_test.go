//go:build integration

package admin_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/plans"
)

// withPlans remounts the admin API with the standard plans' limits (Team: 2 bots here).
func (e *env) withPlans() {
	e.t.Helper()
	team := plans.DefaultTeam
	team.Bots = 2
	reg, err := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), e.fp)
	if err != nil {
		e.t.Fatal(err)
	}
	e.mux = newMux(e, admin.New(admin.Deps{
		DB: e.d, Core: e.c, Clock: e.clk, Providers: reg, ProviderSpec: "stripe:global", Reconciler: e.rec,
		Committed: func(context.Context, sqlc.BillingAccount) { e.committed++ },
		Plans:     plans.New(nil, nil, plans.DefaultFree, team, plans.DefaultBusiness),
	}))
}

func (e *env) addBots(n int) {
	e.t.Helper()
	for range n {
		u := e.user("bot")
		if _, err := e.d.Pool.Exec(ctx, `UPDATE users SET is_bot = true WHERE id = $1`, u); err != nil {
			e.t.Fatal(err)
		}
		if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: "member"}); err != nil {
			e.t.Fatal(err)
		}
	}
}

func customReq(unit int64) *v1.AdminSetCustomPlanRequest {
	return &v1.AdminSetCustomPlanRequest{
		Limits: &v1.PlanLimits{Members: 30, Bots: 5, RoomMembers: 12}, Unit: usd(unit), DisplayName: "  Acme\tPro\u202e ",
		Description: "Contract 7", Reason: "signed contract", RequestId: uuid.NewString(),
	}
}

func TestAdminCustomPlan(t *testing.T) {
	e := newEnv(t, 3)
	e.withPlans()
	e.enable()
	e.pay(1000)
	path := "/api/admin/billing/accounts/" + e.acc.String()

	// Validation.
	bad := []func(r *v1.AdminSetCustomPlanRequest){
		func(r *v1.AdminSetCustomPlanRequest) { r.Limits = nil },
		func(r *v1.AdminSetCustomPlanRequest) { r.Unit = usd(0) },                                       // required to enter
		func(r *v1.AdminSetCustomPlanRequest) { r.Unit = usd(core.CustomUnitCap("USD") + 1) },           // over the cap
		func(r *v1.AdminSetCustomPlanRequest) { r.DisplayName = strings.Repeat("я", 41) },               // name
		func(r *v1.AdminSetCustomPlanRequest) { r.Description = strings.Repeat("d", 141) },              // description
		func(r *v1.AdminSetCustomPlanRequest) { r.EffectiveFrom = timestamppb.New(t0.Add(-time.Hour)) }, // past
	}
	for i, f := range bad {
		r := customReq(20)
		f(r)
		if st, ae := e.call("PUT", path+"/custom-plan", r, nil); st != 422 {
			t.Fatalf("bad request %d: %d %v", i, st, ae)
		}
	}
	r := customReq(20)
	r.Unit = &v1.Money{Minor: 20, Currency: "RUB"}
	e.wantErr(422, "BILLING_CURRENCY_MISMATCH", "PUT", path+"/custom-plan", r)

	// Preview: the exact effect, nothing written.
	r = customReq(20)
	r.Preview = true
	var res v1.AdminBillingMutationResult
	e.must("PUT", path+"/custom-plan", r, &res)
	if !res.GetPreview() || res.GetAmount().GetMinor() != 60 || res.GetAccount().GetPlan() != v1.Plan_PLAN_CUSTOM || e.account().Plan != core.PlanTeam {
		t.Fatalf("preview %v / %s", &res, e.account().Plan)
	}
	// Assign: an inactive account starts on custom (3 × 20 from the advance).
	r.Preview = false
	e.must("PUT", path+"/custom-plan", r, &res)
	acc := e.account()
	if res.GetAmount().GetMinor() != 60 || acc.Plan != core.PlanCustom || acc.Status != core.StatusActive || acc.BalanceMinor != 940 ||
		res.GetAccount().GetPlanDisplayName() != "Acme Pro" || res.GetPrice().GetAccountId() != e.acc.String() {
		t.Fatalf("assign %v / %+v", &res, acc)
	}
	// Replay answers the same; another body with that request_id is refused.
	var again v1.AdminBillingMutationResult
	e.must("PUT", path+"/custom-plan", r, &again)
	if !again.GetReplayed() || e.account().BalanceMinor != 940 {
		t.Fatalf("replay %v", &again)
	}
	row, err := e.d.Q.GetWorkspacePlan(ctx, e.ws)
	if err != nil || row.Plan != "custom" || row.Source != "billing" || row.DisplayName != "Acme Pro" || row.Description != "Contract 7" ||
		!strings.Contains(row.Note, "signed contract") {
		t.Fatalf("plan row %+v %v", row, err)
	}

	// A price change from tomorrow: a version, no money now; the details list the history.
	r = customReq(35)
	r.EffectiveFrom = timestamppb.New(t0.Add(30 * time.Hour))
	e.must("PUT", path+"/custom-plan", r, &res)
	if res.GetAmount().GetMinor() != 0 || res.GetPrice().GetUnit().GetMinor() != 35 {
		t.Fatalf("price change %v", &res)
	}
	var det v1.AdminBillingAccountDetails
	e.must("GET", path, nil, &det)
	cp := det.GetCustomPlan()
	if !cp.GetActive() || len(cp.GetPrices()) != 2 || cp.GetPrices()[0].GetUnit().GetMinor() != 35 || cp.GetDisplayName() != "Acme Pro" ||
		cp.GetLimits().GetMembers() != 30 {
		t.Fatalf("details %v", cp)
	}
	// Prices of accounts stay out of the catalog.
	var cat v1.AdminPriceVersions
	e.must("GET", "/api/admin/billing/prices", nil, &cat)
	for _, p := range cat.GetPrices() {
		if p.GetAccountId() != "" {
			t.Fatalf("custom price in the catalog: %v", p)
		}
	}

	// Back to Team with 3 bots (Team allows 2): refused with the violations, then overridden.
	e.addBots(3)
	back := &v1.AdminSetAccountPlanRequest{Plan: v1.Plan_PLAN_TEAM, Reason: "contract ended", RequestId: uuid.NewString()}
	st, ae := e.call("POST", path+"/plan", back, nil)
	if st != 409 || ae.GetReason() != "PLAN_LIMITS_EXCEEDED" || len(ae.GetPlanLimitsExceeded().GetViolations()) == 0 {
		t.Fatalf("over Team limits: %d %v", st, ae)
	}
	back.OverrideLimits = true
	e.must("POST", path+"/plan", back, &res)
	if acc := e.account(); acc.Plan != core.PlanTeam || res.GetCompensation().GetMinor() <= 0 {
		t.Fatalf("back to Team %v / %+v", &res, acc)
	}
	row, err = e.d.Q.GetWorkspacePlan(ctx, e.ws)
	if err != nil || row.Plan != "team" || row.DisplayName != "" || !strings.Contains(row.Note, "over limits: bots 3>2") {
		t.Fatalf("plan row after %+v %v", row, err)
	}
	if acts := e.actions(); len(acts) < 4 || acts[len(acts)-1] != "plan" || acts[len(acts)-2] != "custom_plan" {
		t.Fatalf("audit %v", acts)
	}
}
