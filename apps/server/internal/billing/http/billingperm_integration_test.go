//go:build integration

package billinghttp_test

import (
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// holder adds a member whose custom role carries bits (ADR-0087); bits 0 = a plain member.
func (e *env) holder(bits perm.Bits) uuid.UUID {
	e.t.Helper()
	u := e.user()
	e.addMember(u, "member")
	if bits == 0 {
		return u
	}
	pos := int32(e.count(`SELECT max(position) + 1 FROM workspace_roles WHERE workspace_id = $1 AND position < 1000`, e.ws)) //nolint:gosec // few roles
	r, err := e.d.Q.CreateRole(ctx, sqlc.CreateRoleParams{WorkspaceID: e.ws, Name: "Billing " + uuid.NewString()[:8], Position: pos,
		Permissions: int64(bits)}) //nolint:gosec // test bits
	if err != nil {
		e.t.Fatal(err)
	}
	if err := e.d.Q.AddMemberRole(ctx, sqlc.AddMemberRoleParams{WorkspaceID: e.ws, UserID: u, RoleID: r.ID}); err != nil {
		e.t.Fatal(err)
	}
	return u
}

// ADR-0087: every billing route checks its own bit — VIEW reads, TOPUP opens a hosted
// checkout, MANAGE does the rest — with the implications MANAGE → TOPUP → VIEW. A denial is
// 403 BILLING_PERMISSION_REQUIRED; anything else (200, 400, 404, 409, 422, 501) passed the check.
func TestBillingPermissionPerRoute(t *testing.T) {
	e := newEnv(t)
	e.paid(1000)
	const (
		none = perm.Bits(0)
		V    = perm.BillingView
		T    = perm.BillingTopup
		M    = perm.BillingManage
	)
	users := map[perm.Bits]uuid.UUID{none: e.holder(none), V: e.holder(V), T: e.holder(T), M: e.holder(M)}
	admin := e.user()
	e.addMember(admin, "admin") // ADMINISTRATOR gives no billing bit
	routes := []struct {
		method, path string
		need         perm.Bits
	}{
		{"POST", "/quote", M}, {"POST", "/activate", M}, {"POST", "/stop", M}, {"POST", "/change-plan", M}, {"POST", "/resume", M},
		{"GET", "/payer", V}, {"PUT", "/payer", M}, {"GET", "/payer-schema", V},
		{"POST", "/topups", T}, {"GET", "/checkouts/" + uuid.NewString(), T},
		{"GET", "/auto-topup", V}, {"PUT", "/auto-topup", M}, {"DELETE", "/auto-topup", M},
		{"GET", "/payment-methods", V}, {"DELETE", "/payment-methods/" + uuid.NewString(), M},
		{"POST", "/saved-method-topups", M}, {"GET", "/saved-method-topups/" + uuid.NewString(), M},
		{"GET", "/ledger", V}, {"GET", "/payments", V}, {"GET", "/refund-requests", V}, {"POST", "/refund-requests", M},
	}
	// Bodies that pass the handlers' validation before the permission check.
	bodies := map[string]proto.Message{
		"/change-plan": &v1.ChangeBillingPlanRequest{Plan: v1.Plan_PLAN_TEAM},
		"/resume":      &v1.ResumeBillingRequest{Mode: v1.BillingResumeMode_BILLING_RESUME_MODE_FREE},
	}
	for _, r := range routes {
		for have, u := range users {
			allowed := have != 0 && perm.BillingOf(have, false, false).Has(r.need)
			st, reason := e.do(u, r.method, e.base()+r.path, bodies[r.path], nil)
			denied := st == 403 && reason == "BILLING_PERMISSION_REQUIRED"
			if allowed == denied {
				t.Errorf("bits %x %s %s: %d %s (allowed %v)", uint64(have), r.method, r.path, st, reason, allowed)
			}
		}
		if st, reason := e.do(admin, r.method, e.base()+r.path, bodies[r.path], nil); st != 403 || reason != "BILLING_PERMISSION_REQUIRED" {
			t.Errorf("admin %s %s: %d %s", r.method, r.path, st, reason)
		}
	}
	// GET …/billing: the status for everyone, the summary from VIEW on.
	for have, u := range users {
		var sum v1.GetBillingResponse
		if st, _ := e.do(u, "GET", e.base(), nil, &sum); st != 200 || (sum.GetSummary() != nil) != (have != 0) || sum.GetStatus() == nil {
			t.Errorf("bits %x GET /: %d summary %v", uint64(have), st, sum.GetSummary() != nil)
		}
	}
	// Saving the method for later charges is MANAGE: a TOPUP holder pays without saving.
	save := &v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 2000, Currency: "USD"}, RequestId: uuid.NewString(), SaveMethod: true}
	if st, reason := e.do(users[T], "POST", e.base()+"/topups", save, nil); st != 403 || reason != "BILLING_PERMISSION_REQUIRED" {
		t.Fatalf("TOPUP save_method: %d %s", st, reason)
	}
	var co v1.CreateTopupResponse
	save.SaveMethod, save.RequestId = false, uuid.NewString()
	if st, reason := e.do(users[T], "POST", e.base()+"/topups", save, &co); st != 200 || co.GetUrl() == "" {
		t.Fatalf("TOPUP top-up: %d %s", st, reason)
	}
	if n := e.count(`SELECT count(*) FROM billing_checkouts WHERE id = $1 AND created_by = $2`, uuid.MustParse(co.GetCheckoutId()), users[T]); n != 1 {
		t.Fatal("checkout created_by is the payer")
	}
	var cs v1.CheckoutStatus
	if st, reason := e.do(users[T], "GET", e.base()+"/checkouts/"+co.GetCheckoutId(), nil, &cs); st != 200 || cs.GetCheckoutId() != co.GetCheckoutId() {
		t.Fatalf("TOPUP checkout status: %d %s", st, reason)
	}
}

// ADR-0087: a MANAGE holder's plan action is recorded as theirs (billing_audit.actor_id), not
// the owner's.
func TestBillingActionActorIsTheCaller(t *testing.T) {
	e := newEnv(t)
	e.paid(5000)
	mgr := e.holder(perm.BillingManage)
	var q v1.BillingQuote
	if st, r := e.do(mgr, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE}, &q); st != 200 {
		t.Fatalf("quote: %d %s", st, r)
	}
	act := &v1.BillingActionRequest{QuoteId: q.GetQuoteId(), RequestId: uuid.NewString(), ExpectedRevision: q.GetRevision()}
	if st, r := e.do(mgr, "POST", e.base()+"/activate", act, nil); st != 200 {
		t.Fatalf("activate: %d %s", st, r)
	}
	if n := e.count(`SELECT count(*) FROM billing_audit WHERE request_id = $1 AND actor_id = $2 AND action = 'owner.activate'`, uuid.MustParse(act.GetRequestId()), mgr); n != 1 {
		t.Fatal("audit actor is not the caller")
	}
	if n := e.count(`SELECT count(*) FROM workspace_plan_log WHERE workspace_id = $1 AND actor_id = $2`, e.ws, e.owner); n != 0 {
		t.Fatal("plan log credits the owner")
	}
}
