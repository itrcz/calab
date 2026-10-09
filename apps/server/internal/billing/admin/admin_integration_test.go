//go:build integration

package admin_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/core"
	bmoney "github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// sharedFake is the provider of every test: its object ids are unique only within one instance.
var sharedFake = fake.New(fake.Options{ID: provider.Stripe})

var (
	ctx = context.Background()
	t0  = time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
)

type reconciler struct{ calls []uuid.UUID }

func (r *reconciler) ReconcileAccount(_ context.Context, id uuid.UUID) error {
	r.calls = append(r.calls, id)
	return nil
}

// env: one workspace (owner + members), the admin API on a fake clock and a fake provider
// registered as stripe.
type env struct {
	t         *testing.T
	d         *db.DB
	clk       *billing.FakeClock
	c         *core.Core
	fp        *fake.Provider
	rec       *reconciler
	mux       *http.ServeMux
	admin     uuid.UUID
	ws, owner uuid.UUID
	wsName    string
	acc       uuid.UUID
	customer  provider.CustomerRef
	committed int
	identity  *auth.Identity
}

func newEnv(t *testing.T, members int) *env {
	t.Helper()
	d := dbtest.Connect(t)
	e := &env{t: t, d: d, clk: billing.NewFakeClock(t0), rec: &reconciler{}}
	e.c = core.New(d, e.clk, core.Config{Debits: true, Enforcement: true}, core.Hooks{})
	e.fp = sharedFake // provider ids (pi_fake1, re_fake1, …) are unique per fake instance
	reg, err := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), e.fp)
	if err != nil {
		t.Fatal(err)
	}
	e.admin = e.user("admin")
	e.owner = e.user("owner")
	e.wsName = "Acme " + uuid.NewString()[:8]
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "b" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: e.wsName, Visibility: "private", OwnerID: e.owner})
	if err != nil {
		t.Fatal(err)
	}
	e.ws = ws.ID
	if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: e.owner, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	for range members - 1 {
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: e.user("m"), Role: "member"}); err != nil {
			t.Fatal(err)
		}
	}
	h := admin.New(admin.Deps{
		DB: d, Core: e.c, Clock: e.clk, Providers: reg, ProviderSpec: "stripe:global", Reconciler: e.rec,
		Committed: func(context.Context, sqlc.BillingAccount) { e.committed++ },
	})
	e.identity = &auth.Identity{UserID: e.admin, Principal: identitypolicy.Principal{UserID: e.admin, Authority: identitypolicy.LocalAccount}}
	e.mux = newMux(e, h)
	t.Cleanup(func() {
		if e.acc != uuid.Nil {
			_ = db.GuardExec(ctx, d, func(q *sqlc.Queries) error {
				_, err := q.UpdateBillingAccountState(ctx, sqlc.UpdateBillingAccountStateParams{Status: core.StatusClosed, Plan: core.PlanTeam, Now: time.Now(), ID: e.acc})
				return err
			})
		}
	})
	return e
}

// newMux mounts h behind a fake auth middleware that installs e.identity (the app's identity
// gate is covered by internal/app TestBillingAdminGate).
func newMux(e *env, h *admin.Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.Register(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if e.identity != nil {
				r = r.WithContext(auth.WithIdentity(r.Context(), *e.identity))
			}
			next.ServeHTTP(w, r)
		})
	})
	return mux
}

func (e *env) user(name string) uuid.UUID {
	e.t.Helper()
	email := uuid.NewString() + "@admin.test"
	u, err := e.d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: name, Settings: []byte("{}")})
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

// call sends one request; out (may be nil) receives a 2xx body; returns status and ApiError.
func (e *env) call(method, path string, in proto.Message, out proto.Message) (int, *v1.ApiError) {
	e.t.Helper()
	var body []byte
	if in != nil {
		var err error
		if body, err = protojson.Marshal(in); err != nil {
			e.t.Fatal(err)
		}
	}
	req := httptest.NewRequestWithContext(ctx, method, path, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	if rec.Code >= 300 {
		var ae v1.ApiError
		_ = protojson.Unmarshal(rec.Body.Bytes(), &ae)
		return rec.Code, &ae
	}
	if out != nil {
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(rec.Body.Bytes(), out); err != nil {
			e.t.Fatalf("%s %s: %v: %s", method, path, err, rec.Body.String())
		}
	}
	return rec.Code, nil
}

func (e *env) must(method, path string, in, out proto.Message) {
	e.t.Helper()
	if st, ae := e.call(method, path, in, out); st != 200 {
		e.t.Fatalf("%s %s: %d %v", method, path, st, ae)
	}
}

func (e *env) wantErr(status int, reason, method, path string, in proto.Message) {
	e.t.Helper()
	st, ae := e.call(method, path, in, nil)
	if st != status || (reason != "" && ae.GetReason() != reason) {
		e.t.Fatalf("%s %s: %d %v, want %d %s", method, path, st, ae, status, reason)
	}
}

func usd(minor int64) *v1.Money { return &v1.Money{Minor: minor, Currency: "USD"} }

func (e *env) enable() {
	e.t.Helper()
	var res v1.AdminBillingMutationResult
	e.must("POST", "/api/admin/billing/workspaces/"+e.ws.String()+"/enable",
		&v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: uuid.NewString()}, &res)
	e.acc = uuid.MustParse(res.GetAccount().GetAccountId())
}

func (e *env) account() sqlc.BillingAccount {
	e.t.Helper()
	a, err := e.d.Q.GetBillingAccount(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

// audits counts the audit rows of the workspace / its account; actions lists them oldest first.
func (e *env) audits() int {
	e.t.Helper()
	return len(e.actions())
}

func (e *env) actions() []string {
	e.t.Helper()
	rows, err := e.d.Pool.Query(ctx, `SELECT action FROM billing_audit WHERE workspace_id = $1 OR account_id = $2 ORDER BY id`, e.ws, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, a)
	}
	return out
}

// pay makes a succeeded checkout payment at the fake provider, records and credits it.
func (e *env) pay(amount int64) sqlc.BillingPayment {
	e.t.Helper()
	if e.customer.ID == "" {
		var err error
		if e.customer, err = e.fp.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + e.acc.String(), AccountID: e.acc}); err != nil {
			e.t.Fatal(err)
		}
	}
	sess, err := e.fp.CreateCheckout(ctx, provider.CheckoutReq{IdemKey: "checkout:" + uuid.NewString(), Amount: bmoney.New(amount, bmoney.USD),
		Method: provider.MethodCard, Customer: e.customer, SuccessURL: "https://x.test/ok", CancelURL: "https://x.test/no", ExpiresAt: e.clk.Time().Add(time.Hour)})
	if err != nil {
		e.t.Fatal(err)
	}
	fact, err := e.fp.CompleteCheckout(sess.ID, fake.Succeed)
	if err != nil {
		e.t.Fatal(err)
	}
	at := e.clk.Time()
	p, err := db.GuardValue(ctx, e.d, func(q *sqlc.Queries) (sqlc.BillingPayment, error) {
		return q.InsertBillingPayment(ctx, sqlc.InsertBillingPaymentParams{AccountID: e.acc, Provider: "stripe",
			ProviderAccount: fact.ProviderAccount, ProviderPaymentID: fact.ID, AmountMinor: amount, Currency: "USD",
			Status: "succeeded", Origin: "import", SucceededAt: &at})
	})
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.c.CreditPaymentTx(ctx, p.ID); err != nil {
		e.t.Fatal(err)
	}
	return p
}

func (e *env) refunds() []sqlc.BillingRefund {
	e.t.Helper()
	rs, err := e.d.Q.AdminListBillingRefunds(ctx, sqlc.AdminListBillingRefundsParams{AccountID: &e.acc, Lim: 100})
	if err != nil {
		e.t.Fatal(err)
	}
	return rs
}

func TestGuardHidesTheAPI(t *testing.T) {
	e := newEnv(t, 1)
	for _, id := range []*auth.Identity{
		nil,
		{UserID: e.admin, IsBot: true, Principal: identitypolicy.Principal{Authority: identitypolicy.LocalAccount}},
		{UserID: e.admin, Principal: identitypolicy.Principal{Authority: identitypolicy.Recovery}},
	} {
		e.identity = id
		e.wantErr(404, "", "GET", "/api/admin/billing/accounts", nil)
		e.wantErr(404, "", "POST", "/api/admin/billing/workspaces/"+e.ws.String()+"/enable",
			&v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: uuid.NewString()})
	}
}
