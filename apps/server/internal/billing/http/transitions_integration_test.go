//go:build integration

package billinghttp_test

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/plans"
)

// Plan transitions (ADR-0086 «Переходы тарифов»): the quote and the commit refuse a plan the
// workspace does not fit, with the violations; a superadmin-assigned plan is never overridden by
// self-serve; a free resume is never checked.

// transitionPlans: Free allows 2 members (the env has owner + member + a guest), Team 1 bot,
// Business everything; identity features only on Business.
func transitionPlans(t *testing.T) *plans.Service {
	t.Helper()
	free, team, biz := plans.DefaultFree, plans.DefaultTeam, plans.DefaultBusiness
	free.Members, team.Bots = 2, 1
	return plans.New(nil, nil, free, team, biz)
}

// doErr is do that returns the ApiError of a refusal.
func (e *env) doErr(user uuid.UUID, method, path string, in proto.Message) (int, *v1.ApiError) {
	e.t.Helper()
	var body io.Reader = http.NoBody
	if in != nil {
		b, _ := protojson.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, e.srv.URL+path, body)
	req.Header.Set("X-Test-User", user.String())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	var ae v1.ApiError
	if res.StatusCode >= 300 {
		_ = protojson.Unmarshal(raw, &ae)
	}
	return res.StatusCode, &ae
}

func (e *env) bot() uuid.UUID {
	e.t.Helper()
	u := e.user()
	if _, err := e.d.Pool.Exec(ctx, `UPDATE users SET is_bot = true WHERE id = $1`, u); err != nil {
		e.t.Fatal(err)
	}
	e.addMember(u, "member")
	return u
}

func (e *env) drop(u uuid.UUID) {
	e.t.Helper()
	if _, err := e.d.Pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, e.ws, u); err != nil {
		e.t.Fatal(err)
	}
}

// wantViolations checks a 409 PLAN_LIMITS_EXCEEDED with exactly these {kind: current/limit}.
func wantViolations(t *testing.T, what string, st int, ae *v1.ApiError, want map[v1.PlanLimitKind][2]uint64) {
	t.Helper()
	if st != 409 || ae.GetReason() != "PLAN_LIMITS_EXCEEDED" || len(ae.GetPlanLimitsExceeded().GetViolations()) != len(want) {
		t.Fatalf("%s: %d %v, want 409 PLAN_LIMITS_EXCEEDED %v", what, st, ae, want)
	}
	for _, v := range ae.GetPlanLimitsExceeded().GetViolations() {
		w, ok := want[v.GetKind()]
		if !ok || v.GetCurrent() != w[0] || v.GetLimit() != w[1] {
			t.Fatalf("%s: violation %v, want %v", what, v, want)
		}
	}
}

// quoteAct quotes purpose/plan and runs the action with that quote.
func (e *env) quoteAct(purpose v1.BillingQuotePurpose, plan v1.Plan, path string) (int, *v1.ApiError) {
	e.t.Helper()
	var q v1.BillingQuote
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: purpose, Plan: plan}, &q); st != 200 {
		e.t.Fatalf("quote %v %v: %d %s", purpose, plan, st, r)
	}
	var in proto.Message = &v1.BillingActionRequest{QuoteId: q.GetQuoteId(), RequestId: uuid.NewString(), ExpectedRevision: q.GetRevision(), Plan: plan}
	if path == "/change-plan" {
		in = &v1.ChangeBillingPlanRequest{Plan: plan, QuoteId: q.GetQuoteId(), RequestId: uuid.NewString(), ExpectedRevision: q.GetRevision()}
	}
	return e.doErr(e.owner, "POST", e.base()+path, in)
}

func offerViolations(r *v1.GetBillingResponse, p v1.Plan) []*v1.PlanLimitViolation {
	for _, o := range r.GetOffers() {
		if o.GetPlan() == p {
			return o.GetViolations()
		}
	}
	return nil
}

// Stop (→ Free when the paid days end) is refused while the workspace has more members than Free
// allows: the plan screen marks Free, the quote and the commit answer the violations; it passes
// once the owner removed the extra member.
func TestTransitionStopOverFreeLimits(t *testing.T) {
	e := newEnv(t, envOpt{plans: transitionPlans(t)})
	e.paid(1000)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, v1.Plan_PLAN_TEAM, "/activate"); st != 200 {
		t.Fatalf("activate Team (Free → Team): %d %v", st, ae)
	}
	extra := e.user()
	e.addMember(extra, "member")

	var got v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 {
		t.Fatal(st)
	}
	if v := offerViolations(&got, v1.Plan_PLAN_FREE); len(v) != 1 || v[0].GetKind() != v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS || v[0].GetCurrent() != 3 || v[0].GetLimit() != 2 {
		t.Fatalf("Free offer violations %v", v)
	}
	if v := offerViolations(&got, v1.Plan_PLAN_ENTERPRISE); len(v) != 0 {
		t.Fatalf("Business offer violations %v", v)
	}
	want := map[v1.PlanLimitKind][2]uint64{v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS: {3, 2}}
	st, ae := e.doErr(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP})
	wantViolations(t, "stop quote", st, ae, want)
	// The commit checks again under the lock (a stale client, no quote).
	st, ae = e.doErr(e.owner, "POST", e.base()+"/stop", &v1.BillingActionRequest{RequestId: uuid.NewString()})
	wantViolations(t, "stop", st, ae, want)
	if a := e.account(); a.Status != core.StatusActive {
		t.Fatalf("refused stop changed the account: %s", a.Status)
	}
	e.drop(extra)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP, v1.Plan_PLAN_UNSPECIFIED, "/stop"); st != 200 {
		t.Fatalf("stop after the fix: %d %v", st, ae)
	}
}

// Business → Team: a bot added between the quote and the commit is caught by the commit (race),
// the change passes once it fits; the history groups the change's charge and compensation.
func TestTransitionDowngradeRechecksAtCommit(t *testing.T) {
	e := newEnv(t, envOpt{plans: transitionPlans(t)})
	e.paid(1000)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, v1.Plan_PLAN_ENTERPRISE, "/activate"); st != 200 {
		t.Fatalf("activate Business: %d %v", st, ae)
	}
	e.bot()
	var q v1.BillingQuote
	quote := &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN, Plan: v1.Plan_PLAN_TEAM}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", quote, &q); st != 200 {
		t.Fatalf("quote with 1 bot: %d %s", st, r)
	}
	b2 := e.bot() // meanwhile
	change := &v1.ChangeBillingPlanRequest{Plan: v1.Plan_PLAN_TEAM, QuoteId: q.GetQuoteId(), RequestId: uuid.NewString(), ExpectedRevision: q.GetRevision()}
	st, ae := e.doErr(e.owner, "POST", e.base()+"/change-plan", change)
	wantViolations(t, "change at commit", st, ae, map[v1.PlanLimitKind][2]uint64{
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS: {2, 1},
	})
	e.drop(b2)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN, v1.Plan_PLAN_TEAM, "/change-plan"); st != 200 {
		t.Fatalf("change after the fix: %d %v", st, ae)
	}
	if a := e.account(); a.Plan != core.PlanTeam {
		t.Fatalf("plan %s", a.Plan)
	}
	var page v1.LedgerPage
	if st, _ := e.do(e.owner, "GET", e.base()+"/ledger", nil, &page); st != 200 {
		t.Fatal(st)
	}
	ops := map[string][]v1.LedgerEntryKind{}
	for _, en := range page.GetEntries() {
		if en.GetOperationId() != "" {
			ops[en.GetOperationId()] = append(ops[en.GetOperationId()], en.GetKind())
		}
	}
	// activate (one charge) and the change (charge + compensation of the Business lot).
	if len(ops) != 2 {
		t.Fatalf("operations %v", ops)
	}
	grouped := false
	for _, kinds := range ops {
		if len(kinds) == 2 {
			grouped = true
		}
	}
	if !grouped {
		t.Fatalf("the change's charge and compensation are not one operation: %v", ops)
	}
}

// Nothing in use: nothing exceeds, even Free.
func TestTransitionViolationsEmptyUsage(t *testing.T) {
	u := plans.Usage{}
	if v := u.Violations(plans.DefaultFree, false); len(v) != 0 {
		t.Fatalf("empty usage: %v", v)
	}
}

// Identity features in use (an active SSO connection) block leaving Business; an operator grant
// (on-prem) does not depend on the plan and does not.
func TestTransitionIdentityInUse(t *testing.T) {
	e := newEnv(t, envOpt{plans: transitionPlans(t)})
	e.paid(1000)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, v1.Plan_PLAN_ENTERPRISE, "/activate"); st != 200 {
		t.Fatalf("activate Business: %d %v", st, ae)
	}
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_identity_connections (workspace_id, name, status, provider, issuer, client_id)
		VALUES ($1, 'Entra', 'active', 'entra', $2, 'client')`, e.ws, "https://login.example.test/"+e.ws.String()); err != nil {
		t.Fatal(err)
	}
	st, ae := e.doErr(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN, Plan: v1.Plan_PLAN_TEAM})
	wantViolations(t, "to Team with SSO", st, ae, map[v1.PlanLimitKind][2]uint64{v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO: {1, 0}})
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_identity_grants (workspace_id, feature, enabled, source) VALUES ($1, 'corporate_sso', true, 'onprem_enterprise')
		ON CONFLICT (workspace_id, feature) DO UPDATE SET source = 'onprem_enterprise', enabled = true`, e.ws); err != nil {
		t.Fatal(err)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_CHANGE_PLAN, Plan: v1.Plan_PLAN_TEAM}, nil); st != 200 {
		t.Fatalf("operator grant: %d %s", st, r)
	}
}

// A plan a superadmin assigned (manual Team) is not overridden by self-serve: no self_serve, the
// quote refuses before creating an account, the core refuses an activation of an account the
// superadmin enabled; once the manual plan expired, self-serve works.
func TestTransitionAdminAssignedPlan(t *testing.T) {
	committed := 0
	opt := selfServe(&committed)
	opt.plans = transitionPlans(t)
	e := newEnv(t, opt)
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_plans (workspace_id, plan, note) VALUES ($1, 'team', 'contract')`, e.ws); err != nil {
		t.Fatal(err)
	}
	var got v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &got); st != 200 || !got.GetAdminAssigned() || got.GetSelfServe() || len(got.GetOffers()) != 0 {
		t.Fatalf("owner view: %d %v", st, &got)
	}
	activate := &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, Plan: v1.Plan_PLAN_ENTERPRISE}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", activate, nil); st != 404 && (st != 409 || r != "BILLING_PLAN_ADMIN_ASSIGNED") {
		t.Fatalf("quote: %d %s", st, r)
	}
	if _, err := e.d.Q.GetLiveBillingAccountByWorkspace(ctx, &e.ws); err == nil {
		t.Fatal("a quote created an account over an admin-assigned plan")
	}
	// The superadmin enabled billing anyway: the commit refuses too (the plan row stays manual).
	acc, err := e.core.EnableAccount(ctx, e.ws, "global", "stripe", &e.owner)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	if _, err := e.core.AdminCredit(ctx, e.acc, 1000, "test", uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", activate, nil); st != 409 || r != "BILLING_PLAN_ADMIN_ASSIGNED" {
		t.Fatalf("quote with account: %d %s", st, r)
	}
	if _, err := e.core.Activate(ctx, e.acc, core.PlanEnterprise, uuid.New(), &e.owner); !errors.Is(err, billing.ErrPlanAdminAssigned) {
		t.Fatalf("activate: %v", err)
	}
	row, err := e.d.Q.GetWorkspacePlan(ctx, e.ws)
	if err != nil || row.Source != "manual" || row.Plan != "team" {
		t.Fatalf("plan row %v %v", row, err)
	}
	// Expired: the Free limits apply already, self-serve takes over.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspace_plans SET valid_until = now() - interval '1 day' WHERE workspace_id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.core.Activate(ctx, e.acc, core.PlanEnterprise, uuid.New(), &e.owner); err != nil {
		t.Fatalf("activate after expiry: %v", err)
	}
	if row, _ := e.d.Q.GetWorkspacePlan(ctx, e.ws); row.Source != "billing" || row.Plan != "enterprise" {
		t.Fatalf("plan row after activation %v", row)
	}
}

// A suspended workspace: a free resume is never checked (paying the debt must not require fitting
// Free, ADR-0080 §8), a paid resume is a transition to the account's plan and is.
func TestTransitionResumeChecks(t *testing.T) {
	e := newEnv(t, envOpt{plans: transitionPlans(t)})
	e.paid(1000)
	if st, ae := e.quoteAct(v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, v1.Plan_PLAN_TEAM, "/activate"); st != 200 {
		t.Fatalf("activate Team: %d %v", st, ae)
	}
	e.bot()
	e.bot() // Team allows 1 bot, Free 1 bot; members 4 > Free's 2
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'suspended', next_due_at = NULL WHERE id = $1`, e.acc); err != nil {
		t.Fatal(err)
	}
	if _, err := e.core.Resume(ctx, e.acc, core.ResumePaid, core.PlanTeam, uuid.New(), &e.owner); !isViolation(err) {
		t.Fatalf("paid resume over Team's bots: %v", err)
	}
	st, ae := e.doErr(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_RESUME_PAID})
	if st != 409 || ae.GetReason() != "PLAN_LIMITS_EXCEEDED" {
		t.Fatalf("paid resume quote: %d %v", st, ae)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_RESUME_FREE}, nil); st != 200 {
		t.Fatalf("free resume quote: %d %s", st, r)
	}
	var got v1.GetBillingResponse
	in := &v1.ResumeBillingRequest{Mode: v1.BillingResumeMode_BILLING_RESUME_MODE_FREE, RequestId: uuid.NewString()}
	if st, r := e.do(e.owner, "POST", e.base()+"/resume", in, &got); st != 200 || got.GetSummary().GetStatus() != v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_STOPPED {
		t.Fatalf("free resume over Free's limits: %d %s %v", st, r, &got)
	}
}

func isViolation(err error) bool {
	var ae interface{ Proto() *v1.ApiError }
	return errors.As(err, &ae) && ae.Proto().GetReason() == "PLAN_LIMITS_EXCEEDED"
}

// Only the owner moves plans; members get 403 before any check.
func TestTransitionOwnerOnly(t *testing.T) {
	e := newEnv(t, envOpt{plans: transitionPlans(t)})
	if st, r := e.do(e.member, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_STOP}, nil); st != 403 || r != "BILLING_PERMISSION_REQUIRED" {
		t.Fatalf("member: %d %s", st, r)
	}
}
