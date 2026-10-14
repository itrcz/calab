//go:build integration

package plans_test

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/worker"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/plans"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var (
	ctx = context.Background()
	t0  = time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
)

func day(n int) time.Time { return t0.Add(time.Duration(n) * billing.Day) }

// grantEnv is one workspace with a live billing account whose core runs the app's post-commit
// identity sync (app.billingCommitted → plans.SyncBillingIdentity).
type grantEnv struct {
	t      *testing.T
	d      *db.DB
	clk    *billing.FakeClock
	c      *core.Core
	w      *worker.Worker
	ws     uuid.UUID
	owner  uuid.UUID
	acc    uuid.UUID
	syncMu sync.Mutex
	errs   []error
}

func newGrantEnv(t *testing.T, credit int64) *grantEnv {
	t.Helper()
	e := &grantEnv{t: t, d: dbtest.Connect(t), clk: billing.NewFakeClock(t0)}
	e.c = core.New(e.d, e.clk, core.Config{Debits: true, Enforcement: true}, core.Hooks{
		Committed: func(ctx context.Context, acc sqlc.BillingAccount, _ bool) {
			if acc.WorkspaceID == nil {
				return
			}
			if _, err := plans.SyncBillingIdentity(ctx, e.d, *acc.WorkspaceID); err != nil {
				e.syncMu.Lock()
				e.errs = append(e.errs, err)
				e.syncMu.Unlock()
			}
		},
	})
	e.w = worker.New(e.c, worker.Options{Suspend: true, Batch: 1000})
	e.owner, e.ws = workspace(t, e.d)
	acc, err := e.c.EnableAccount(ctx, e.ws, "global", "stripe", &e.owner)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	t.Cleanup(func() {
		_, _ = e.d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now(), next_due_at = NULL WHERE id = $1`, acc.ID)
	})
	if _, err := e.c.AdminCredit(ctx, e.acc, credit, "test", uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	return e
}

func workspace(t *testing.T, d *db.DB) (owner, ws uuid.UUID) {
	t.Helper()
	email := uuid.NewString() + "@plans.test"
	u, err := d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "Owner", Settings: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	w, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "p" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Plans", Visibility: "private", OwnerID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: w.ID, UserID: u.ID, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	return u.ID, w.ID
}

func (e *grantEnv) noSyncErrors() {
	e.t.Helper()
	e.syncMu.Lock()
	defer e.syncMu.Unlock()
	if len(e.errs) > 0 {
		e.t.Fatalf("identity sync after commit: %v", e.errs)
	}
}

// wantIdentity checks every Business feature the way the identity gate does (grant + plan
// eligibility), and the number of plan_changed identity invalidations so far.
func (e *grantEnv) wantIdentity(step string, available bool, invalidations int) {
	e.t.Helper()
	e.noSyncErrors()
	loader := identitypolicy.NewSQLLoader(e.d.Q, identitypolicy.EntitlementConfig{Edition: "cloud"})
	for _, f := range []identitypolicy.Feature{identitypolicy.SSO, identitypolicy.DirectorySync, identitypolicy.OAuthProvider} {
		g, err := loader.LoadGrant(ctx, time.Now(), e.ws, f)
		if err != nil {
			e.t.Fatal(err)
		}
		if got := identitypolicy.RequireEntitlement(time.Now(), e.ws, g, f).Allowed; got != available {
			e.t.Fatalf("%s: %s available %v, want %v (%+v)", step, f, got, available, g)
		}
	}
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM identity_invalidation_outbox WHERE workspace_id = $1 AND reason = 'plan_changed'`, e.ws).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	if n != invalidations {
		e.t.Fatalf("%s: %d plan_changed invalidations, want %d", step, n, invalidations)
	}
}

func (e *grantEnv) plan() string {
	e.t.Helper()
	row, err := e.d.Q.GetWorkspacePlan(ctx, e.ws)
	if err != nil {
		e.t.Fatal(err)
	}
	return row.Plan
}

// A billing plan change has the identity side effects of the superadmin plan edit, after the
// commit: Business enables SSO / directory sync / the OAuth provider, Team and Free after a
// stop disable them, each change invalidates the workspace's identity sessions once, and a
// command that does not change the plan touches nothing.
func TestBillingPlanIdentityGrants(t *testing.T) {
	e := newGrantEnv(t, 1_000_000)
	e.wantIdentity("inactive", false, 0)
	if _, err := e.c.Activate(ctx, e.acc, core.PlanEnterprise, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantIdentity("activate Business", true, 1)
	if _, err := e.c.ChangePlan(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantIdentity("downgrade to Team", false, 2)
	if _, err := e.c.ChangePlan(ctx, e.acc, core.PlanEnterprise, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantIdentity("upgrade to Business", true, 3)
	// A money command without a plan change: grants and sessions stay.
	if _, err := e.c.AdminCredit(ctx, e.acc, 100, "test", uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantIdentity("credit", true, 3)
	// Stop: Business until the paid days end, then Free.
	if _, err := e.c.Stop(ctx, e.acc, &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantIdentity("stopped, days running", true, 3)
	e.clk.Set(day(1))
	e.w.Tick(ctx)
	if p := e.plan(); p != core.PlanFree {
		t.Fatalf("plan after the stop ran out: %s", p)
	}
	e.wantIdentity("stopped → Free", false, 4)
}

// A billing suspension keeps the plan and the grants (ADR-0080 §3): the identity gate closes
// the workspace from billing_accounts, the grants come back usable after the debt is paid.
func TestBillingSuspensionKeepsIdentityGrants(t *testing.T) {
	e := newGrantEnv(t, 30) // one Business day of one member
	if _, err := e.c.Activate(ctx, e.acc, core.PlanEnterprise, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantIdentity("activate Business", true, 1)
	for d := 1; d <= 8; d++ {
		e.clk.Set(day(d))
		e.w.Tick(ctx)
	}
	acc, err := e.d.Q.GetBillingAccount(ctx, e.acc)
	if err != nil {
		t.Fatal(err)
	}
	if acc.Status != core.StatusSuspended {
		t.Fatalf("not suspended: %+v", acc)
	}
	e.wantIdentity("suspended", true, 1)
}

// A manual plan (source ≠ billing) is the superadmin's: the billing sync leaves its grants.
func TestBillingIdentitySyncSkipsManualPlan(t *testing.T) {
	d := dbtest.Connect(t)
	owner, ws := workspace(t, d)
	if _, err := d.Q.UpsertWorkspacePlan(ctx, sqlc.UpsertWorkspacePlanParams{WorkspaceID: ws, Plan: "team", Note: "manual", UpdatedBy: &owner}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: string(identitypolicy.SSO),
		Enabled: true, Source: "cloud_business", UpdatedBy: &owner}); err != nil {
		t.Fatal(err)
	}
	changed, err := plans.SyncBillingIdentity(ctx, d, ws)
	if err != nil || changed {
		t.Fatalf("manual plan: changed %v, err %v", changed, err)
	}
	g, err := d.Q.GetIdentityGrant(ctx, sqlc.GetIdentityGrantParams{WorkspaceID: ws, Feature: string(identitypolicy.SSO)})
	if err != nil || !g.Enabled || g.Version != 1 {
		t.Fatalf("manual grant changed: %+v %v", g, err)
	}
}

// Admission (workspace lock, then the account inside Admit) racing plan changes (account lock,
// then the workspace lock of the identity sync after the commit) never deadlocks, and the
// grants end up matching the last committed plan.
func TestBillingPlanChangeRacesAdmission(t *testing.T) {
	e := newGrantEnv(t, 100_000_000)
	if _, err := e.c.Activate(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	plansCycle := []string{core.PlanEnterprise, core.PlanTeam}
	for round := range 5 {
		rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		var wg sync.WaitGroup
		errs := make(chan error, 16)
		for range 4 {
			wg.Go(func() {
				email := uuid.NewString() + "@plans.test"
				u, err := e.d.Q.CreateUser(rctx, sqlc.CreateUserParams{Email: &email, DisplayName: "M", Settings: []byte("{}")})
				if err != nil {
					errs <- err
					return
				}
				errs <- e.d.Tx(rctx, func(q *sqlc.Queries) error {
					if _, err := q.LockOAuthWorkspace(rctx, e.ws); err != nil {
						return err
					}
					if _, err := q.AddMember(rctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u.ID, Role: "member"}); err != nil {
						return err
					}
					return e.c.Admit(rctx, q, e.ws, u.ID, uuid.New())
				})
			})
		}
		wg.Go(func() {
			for i := range 2 {
				_, err := e.c.ChangePlan(rctx, e.acc, plansCycle[(round*2+i)%2], uuid.New(), &e.owner)
				errs <- err
			}
		})
		wg.Wait()
		cancel()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		e.noSyncErrors()
		business := e.plan() == core.PlanEnterprise
		loader := identitypolicy.NewSQLLoader(e.d.Q, identitypolicy.EntitlementConfig{Edition: "cloud"})
		g, err := loader.LoadGrant(ctx, time.Now(), e.ws, identitypolicy.SSO)
		if err != nil {
			t.Fatal(err)
		}
		if g.Enabled != business || identitypolicy.RequireEntitlement(time.Now(), e.ws, g, identitypolicy.SSO).Allowed != business {
			t.Fatalf("round %d: plan business=%v, grant %+v", round, business, g)
		}
	}
}
