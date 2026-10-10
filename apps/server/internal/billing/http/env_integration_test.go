//go:build integration

package billinghttp_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	billinghttp "github.com/calaba/calaba/server/internal/billing/http"
	"github.com/calaba/calaba/server/internal/billing/inbox"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka/tochkatest"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay/tochkapaytest"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/plans"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var ctx = context.Background()

// env: one workspace (owner + one member + a guest) with an inactive billing account, the
// fake provider registered as "stripe", the core, the inbox and the owner / public routes behind
// a test identity (header X-Test-User).
type env struct {
	t         *testing.T
	d         *db.DB
	fp        provider.Provider // the registered provider (the fake, or a wrapper of it)
	fake      *fake.Provider
	core      *core.Core
	in        *inbox.Inbox
	mail      *mail.Service
	srv       *httptest.Server
	ws        uuid.UUID
	owner     uuid.UUID
	member    uuid.UUID
	acc       uuid.UUID
	merchant  string // merchant account of the fake
	bank      *tochkatest.Bank
	tochka    *tochka.Provider
	payBank   *tochkapaytest.Bank
	tochkaPay *tochkapay.Provider
	reg       *provider.Registry
	job       *autotopup.Job // with envOpt.charger
}

type envOpt struct {
	wrap  func(*fake.Provider) provider.Provider
	clock billing.Clock // default DBClock
	// noAccount: the workspace starts without a billing account (self-serve tests).
	noAccount bool
	// cfg adjusts the handlers' config (self-serve, plan limits, the committed hook).
	cfg func(*billinghttp.Config)
	// bank: the Tochka adapter on this fake bank is registered too (BILLING_PROVIDERS
	// stripe:global,tochka:ru); market: the market of the account (default global).
	bank   *tochkatest.Bank
	market string
	// payBank: the Tochka Pay Gateway adapter on this fake site is registered with its matrix
	// row (BILLING_TOCHKA_SBP_BINDING_ENABLED, ADR-0083 phase 3).
	payBank *tochkapaytest.Bank
	// recurring: the Tochka adapter charges saved cards (TOCHKA_RECURRING_ENABLED); charger:
	// one-click top-ups on (BILLING_SAVED_METHOD_TOPUP_ENABLED) through an auto-topup job.
	recurring, charger bool
	// plans: plan transitions are checked (ADR-0086): core.Hooks.Guard and Config.Plans.
	plans *plans.Service
}

func newEnv(t *testing.T, opts ...envOpt) *env {
	t.Helper()
	d := dbtest.Connect(t)
	var b [6]byte
	_, _ = rand.Read(b[:])
	e := &env{t: t, d: d, merchant: "acct_" + hex.EncodeToString(b[:])}
	e.fake = fake.New(fake.Options{ID: provider.Stripe, Account: e.merchant})
	e.fp = e.fake
	var clock billing.Clock = billing.DBClock{}
	noAccount := false
	cfg := billinghttp.Config{
		Checkouts: true, ReturnURL: "https://app.calab.test/api/billing/return", AppURL: "https://app.calab.test",
	}
	spec, market := "stripe:global", "global"
	var tp, pp provider.Provider
	rows := provider.DefaultMatrix()
	charger := false
	var hooks core.Hooks
	for _, o := range opts {
		if o.plans != nil {
			hooks.Guard, cfg.Plans = plans.TransitionGuard{S: o.plans}, o.plans
		}
		noAccount = noAccount || o.noAccount
		charger = charger || o.charger
		if o.bank != nil {
			e.bank = o.bank
			tc := o.bank.Config()
			tc.Recurring = o.recurring
			p, err := tochka.New(tc)
			if err != nil {
				t.Fatal(err)
			}
			tp, e.tochka, spec = p, p, "stripe:global,tochka:ru"
		}
		if o.payBank != nil {
			p, err := tochkapay.New(o.payBank.Config())
			if err != nil {
				t.Fatal(err)
			}
			e.payBank, e.tochkaPay, pp = o.payBank, p, p
			rows = append(rows, provider.SBPBindingRow())
		}
		if o.market != "" {
			market = o.market
		}
		if o.cfg != nil {
			o.cfg(&cfg)
		}
		if o.wrap != nil {
			e.fp = o.wrap(e.fake)
		}
		if o.clock != nil {
			clock = o.clock
		}
	}
	reg, err := provider.NewRegistry(spec, rows, e.fp, tp, pp)
	if err != nil {
		t.Fatal(err)
	}
	e.reg = reg
	// The provider switches are global to the package database: every test starts open.
	_, _ = d.Pool.Exec(ctx, `DELETE FROM billing_provider_settings`)
	t.Cleanup(func() { _, _ = d.Pool.Exec(ctx, `DELETE FROM billing_provider_settings`) })
	e.core = core.New(d, clock, core.Config{Debits: true, Enforcement: true}, hooks)
	e.in = inbox.New(d, reg, e.core, inbox.Options{})
	e.mail = mail.New(mail.Config{Secret: []byte("billing-test-secret-billing-test-secret")}, d, nil, mail.NewFake())
	e.in.Mail = inbox.NewNotifier(d, e.mail, "https://app.calab.test")
	if charger {
		e.job = autotopup.New(d, e.core, reg, e.in, clock, autotopup.Options{Enabled: true, ReturnURL: cfg.ReturnURL})
		e.in.AttemptSettled = e.job.AttemptSettled
		cfg.SavedMethodTopups, cfg.Charger = true, e.job
	}
	svc := billinghttp.New(d, e.core, reg, e.in, clock, cfg)
	h := &billinghttp.Handlers{Enabled: true, Owner: svc.Owner(), Public: svc.Public()}
	mux := http.NewServeMux()
	h.Routes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid, err := uuid.Parse(r.Header.Get("X-Test-User"))
			if err != nil {
				http.Error(w, "no user", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: uid})))
		})
	})
	e.srv = httptest.NewServer(mux)
	t.Cleanup(e.srv.Close)

	e.owner = e.user()
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "t5" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Billing T5", Visibility: "private", OwnerID: e.owner})
	if err != nil {
		t.Fatal(err)
	}
	e.ws = ws.ID
	e.addMember(e.owner, "owner")
	e.member = e.user()
	e.addMember(e.member, "member")
	e.addMember(e.user(), "guest")
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now(), next_due_at = NULL WHERE workspace_id = $1`, ws.ID)
	})
	if noAccount {
		return e
	}
	prov := "stripe"
	if market == "ru" {
		prov = "tochka"
	}
	acc, err := e.core.EnableAccount(ctx, ws.ID, market, prov, &e.owner)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	return e
}

func (e *env) user() uuid.UUID {
	e.t.Helper()
	email := uuid.NewString() + "@billing.test"
	u, err := e.d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "U", Settings: []byte("{}")})
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

func (e *env) addMember(u uuid.UUID, role string) {
	e.t.Helper()
	if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: role}); err != nil {
		e.t.Fatal(err)
	}
}

// do calls a route as user; out is decoded on 2xx. Returns the status and the error reason.
func (e *env) do(user uuid.UUID, method, path string, in, out proto.Message) (int, string) {
	e.t.Helper()
	var body io.Reader = http.NoBody
	if in != nil {
		b, err := protojson.Marshal(in)
		if err != nil {
			e.t.Fatal(err)
		}
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
	if res.StatusCode >= 300 {
		var ae v1.ApiError
		_ = protojson.Unmarshal(raw, &ae)
		return res.StatusCode, ae.GetReason()
	}
	if out != nil && len(raw) > 0 {
		if err := protojson.Unmarshal(raw, out); err != nil {
			e.t.Fatalf("%s %s: %s: %v", method, path, raw, err)
		}
	}
	return res.StatusCode, ""
}

func (e *env) base() string { return "/api/workspaces/" + e.ws.String() + "/billing" }

// webhook posts a signed delivery to the public webhook route.
func (e *env) webhook(w fake.Webhook) int {
	e.t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.srv.URL+"/api/billing/stripe/webhook", bytes.NewReader(w.Body))
	for k, v := range w.Header {
		req.Header[k] = v
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

// process runs the inbox worker until nothing is due.
func (e *env) process() {
	e.t.Helper()
	if _, err := e.in.ProcessOnce(ctx); err != nil {
		e.t.Fatal(err)
	}
}

// topup opens a checkout of amount through the API and returns its id and provider session.
func (e *env) topup(amount int64, save bool) (uuid.UUID, string) {
	e.t.Helper()
	var out v1.CreateTopupResponse
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{
		MethodId: "stripe:card", Amount: &v1.Money{Minor: amount, Currency: "USD"}, RequestId: uuid.NewString(), SaveMethod: save,
	}, &out); st != 200 {
		e.t.Fatalf("topup: %d %s", st, reason)
	}
	id := uuid.MustParse(out.GetCheckoutId())
	co, err := e.d.Q.GetBillingCheckout(ctx, id)
	if err != nil || co.ProviderSessionID == nil || co.Url == nil || *co.Url != out.GetUrl() {
		e.t.Fatalf("checkout row %+v %v", co, err)
	}
	return id, *co.ProviderSessionID
}

// paid tops up amount and delivers every webhook once: the balance has the money.
func (e *env) paid(amount int64) (checkout uuid.UUID, pi string) {
	e.t.Helper()
	cid, sess := e.topup(amount, false)
	pay, err := e.fake.CompleteCheckout(sess, fake.Succeed)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, w := range e.fake.TakeWebhooks() {
		if st := e.webhook(w); st != 200 {
			e.t.Fatalf("webhook %d", st)
		}
	}
	e.process()
	return cid, pay.ID
}

func (e *env) account() sqlc.BillingAccount {
	e.t.Helper()
	a, err := e.d.Q.GetBillingAccount(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

// count runs a count(*) query with args.
func (e *env) count(q string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.d.Pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) lots() int {
	return e.count(`SELECT count(*) FROM billing_funding_lots WHERE account_id = $1`, e.acc)
}

func (e *env) notifications(prefix string) int {
	return e.count(`SELECT count(*) FROM billing_notifications WHERE account_id = $1 AND key LIKE $2`, e.acc, prefix+"%")
}

func (e *env) eventErrors() []string {
	e.t.Helper()
	rows, err := e.d.Pool.Query(ctx, `SELECT error FROM billing_provider_events WHERE provider_account = $1 AND error <> '' ORDER BY received_at`, e.merchant)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		out = append(out, s)
	}
	return out
}
