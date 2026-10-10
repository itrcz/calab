//go:build integration

package autotopup_test

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
	"sync"
	"testing"
	"time"

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
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/mail"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var ctx = context.Background()

// hooked is the fake provider with hooks around ChargeOffSession (webhook first, revoke during
// dispatch). Registered as "stripe".
type hooked struct {
	*fake.Provider
	mu            sync.Mutex
	before, after func()
}

func (h *hooked) ChargeOffSession(c context.Context, req provider.OffSessionReq) (provider.PaymentFact, error) {
	h.mu.Lock()
	before, after := h.before, h.after
	h.mu.Unlock()
	if before != nil {
		before()
	}
	f, err := h.Provider.ChargeOffSession(c, req)
	if after != nil {
		after()
	}
	return f, err
}

func (h *hooked) hooks(before, after func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.before, h.after = before, after
}

// env: owner + 2 members (+ a guest) with an active Team account (daily 30 cents), a card saved
// by a checkout, balance 0 and an auto-topup consent with cap $500: an attempt now charges
// 30 days = 900.
type env struct {
	t        *testing.T
	d        *db.DB
	clk      *billing.FakeClock
	fake     *fake.Provider
	p        *hooked
	reg      *provider.Registry
	core     *core.Core
	in       *inbox.Inbox
	job      *autotopup.Job
	srv      *httptest.Server
	ws       uuid.UUID
	owner    uuid.UUID
	member   uuid.UUID
	acc      uuid.UUID
	pm       uuid.UUID
	merchant string
}

type opts struct {
	marker     string
	noConsent  bool         // no consent yet
	caps       provider.Cap // fake capabilities (0: Stripe-like defaults)
	noOneClick bool         // BILLING_SAVED_METHOD_TOPUP_ENABLED off
}

func newEnv(t *testing.T, o opts) *env {
	t.Helper()
	d := dbtest.Connect(t)
	var b [6]byte
	_, _ = rand.Read(b[:])
	e := &env{t: t, d: d, clk: billing.NewFakeClock(time.Now().UTC().Truncate(time.Second)), merchant: "acct_" + hex.EncodeToString(b[:])}
	e.fake = fake.New(fake.Options{ID: provider.Stripe, Account: e.merchant, Now: e.clk.Time, Caps: o.caps})
	e.p = &hooked{Provider: e.fake}
	reg, err := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), e.p)
	if err != nil {
		t.Fatal(err)
	}
	e.reg = reg
	e.core = core.New(d, e.clk, core.Config{Debits: true, Enforcement: true}, core.Hooks{})
	e.in = inbox.New(d, reg, e.core, inbox.Options{})
	ms := mail.New(mail.Config{Secret: []byte("billing-test-secret-billing-test-secret")}, d, nil, mail.NewFake())
	e.in.Mail = inbox.NewNotifier(d, ms, "https://app.calab.test")
	e.job = e.newJob(o.marker)
	svc := billinghttp.New(d, e.core, reg, e.in, e.clk, billinghttp.Config{
		Checkouts: true, ReturnURL: "https://app.calab.test/api/billing/return", AppURL: "https://app.calab.test",
		SavedMethodTopups: !o.noOneClick, Charger: e.job,
	})
	h := &billinghttp.Handlers{Enabled: true, Owner: svc.Owner(), Public: svc.Public(),
		Admin: map[string]httpx.HandlerFunc{}}
	h.Admin[autotopup.ReconcileRoute] = e.job.ReconcileHandler()
	mux := http.NewServeMux()
	h.Routes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid, err := uuid.Parse(r.Header.Get("X-Test-User"))
			if err != nil {
				http.Error(w, "no user", http.StatusUnauthorized)
				return
			}
			id := auth.Identity{UserID: uid, Principal: identitypolicy.Principal{UserID: uid, Authority: identitypolicy.LocalAccount}}
			next.ServeHTTP(w, r.WithContext(auth.WithIdentity(r.Context(), id)))
		})
	})
	e.srv = httptest.NewServer(mux)
	t.Cleanup(e.srv.Close)

	e.owner = e.user()
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "t7" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Billing T7", Visibility: "private", OwnerID: e.owner})
	if err != nil {
		t.Fatal(err)
	}
	e.ws = ws.ID
	e.addMember(e.owner, "owner")
	e.member = e.user()
	e.addMember(e.member, "member")
	e.addMember(e.user(), "member")
	e.addMember(e.user(), "guest")
	acc, err := e.core.EnableAccount(ctx, ws.ID, "global", "stripe", &e.owner)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	t.Cleanup(func() {
		// Nothing of this test is picked up by the job of a later one.
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_autotopup_attempts SET status = 'failed', finished_at = now()
			WHERE account_id = $1 AND status IN ('prepared', 'dispatched', 'requires_action', 'unknown')`, acc.ID)
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_autotopup SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, acc.ID)
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now(), next_due_at = NULL WHERE id = $1 AND status <> 'closed'`, acc.ID)
	})

	// A card saved by a $5 checkout, then the Team plan (first day 30), then the balance
	// drained to 0 by a superadmin debit.
	e.topup(500, true)
	if _, err := e.core.Activate(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	if bal := e.account().BalanceMinor; bal > 0 {
		if _, err := e.core.AdminDebit(ctx, e.acc, bal, "drain for the test", uuid.New(), &e.owner); err != nil {
			t.Fatal(err)
		}
	}
	ms2, err := d.Q.ListBillingPaymentMethods(ctx, e.acc)
	if err != nil || len(ms2) != 1 {
		t.Fatalf("saved methods %v %v", ms2, err)
	}
	e.pm = ms2[0].ID
	if !o.noConsent {
		e.consent(50000)
	}
	return e
}

func (e *env) newJob(marker string) *autotopup.Job {
	j := autotopup.New(e.d, e.core, e.reg, e.in, e.clk, autotopup.Options{Enabled: true, RestoreMarker: marker,
		ReturnURL: "https://app.calab.test/api/billing/return"})
	e.in.AttemptSettled = j.AttemptSettled
	return j
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

func (e *env) base() string { return "/api/workspaces/" + e.ws.String() + "/billing" }

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

// topup pays a checkout of amount on the hosted page and delivers its webhooks.
func (e *env) topup(amount int64, save bool) {
	e.t.Helper()
	var out v1.CreateTopupResponse
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{
		MethodId: "stripe:card", Amount: &v1.Money{Minor: amount, Currency: "USD"}, RequestId: uuid.NewString(), SaveMethod: save,
	}, &out); st != 200 {
		e.t.Fatalf("topup: %d %s", st, reason)
	}
	co, err := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	if err != nil || co.ProviderSessionID == nil {
		e.t.Fatalf("checkout %+v %v", co, err)
	}
	if _, err := e.fake.CompleteCheckout(*co.ProviderSessionID, fake.Succeed); err != nil {
		e.t.Fatal(err)
	}
	e.webhooks()
}

// webhooks delivers every pending webhook through the inbox and processes them.
func (e *env) webhooks() {
	e.t.Helper()
	for _, w := range e.fake.TakeWebhooks() {
		if _, _, err := e.in.Receive(ctx, e.fake, w.Header, w.Body); err != nil {
			e.t.Fatal(err)
		}
	}
	if _, err := e.in.ProcessOnce(ctx); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) consent(capMinor int64) (int, string) {
	e.t.Helper()
	return e.do(e.owner, "PUT", e.base()+"/auto-topup", &v1.PutAutoTopupRequest{
		PaymentMethodId: e.pm.String(), MaxAmount: &v1.Money{Minor: capMinor, Currency: "USD"}, ConsentVersion: autotopup.ConsentVersion,
		RequestId: uuid.NewString(),
	}, nil)
}

func (e *env) account() sqlc.BillingAccount {
	e.t.Helper()
	a, err := e.d.Q.GetBillingAccount(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

func (e *env) count(q string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.d.Pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) attempts() []sqlc.BillingAutotopupAttempt {
	e.t.Helper()
	rows, err := e.d.Pool.Query(ctx, `SELECT id, status, amount_minor, failure_code, coalesce(provider_payment_id, '') FROM billing_autotopup_attempts
		WHERE account_id = $1 ORDER BY created_at, id`, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []sqlc.BillingAutotopupAttempt
	for rows.Next() {
		var a sqlc.BillingAutotopupAttempt
		var pi string
		if err := rows.Scan(&a.ID, &a.Status, &a.AmountMinor, &a.FailureCode, &pi); err != nil {
			e.t.Fatal(err)
		}
		if pi != "" {
			a.ProviderPaymentID = &pi
		}
		out = append(out, a)
	}
	return out
}

// autoPayments counts payments of auto-topups (any origin) and their credited sum.
func (e *env) autoPayments() (n int, sum int64) {
	e.t.Helper()
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*), coalesce(sum(amount_minor), 0) FROM billing_payments
		WHERE account_id = $1 AND (origin = 'auto_topup' OR origin = 'import')`, e.acc).Scan(&n, &sum); err != nil {
		e.t.Fatal(err)
	}
	return n, sum
}

func (e *env) lots() int {
	return e.count(`SELECT count(*) FROM billing_funding_lots WHERE account_id = $1`, e.acc)
}

func (e *env) mails(template string) int {
	return e.count(`SELECT count(*) FROM billing_notifications WHERE account_id = $1 AND template = $2`, e.acc, template)
}

func (e *env) tick(want int) {
	e.t.Helper()
	if got := e.job.Tick(ctx); got != want {
		e.t.Fatalf("tick dispatched %d attempts, want %d (attempts %+v)", got, want, e.attempts())
	}
}

func (e *env) wantBalance(want int64) {
	e.t.Helper()
	if got := e.account().BalanceMinor; got != want {
		e.t.Fatalf("balance %d, want %d", got, want)
	}
}

func (e *env) consentRow() sqlc.BillingAutotopup {
	e.t.Helper()
	c, err := e.d.Q.GetBillingAutoTopup(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// drain debits the whole positive balance (superadmin), so the account needs a top-up again.
func (e *env) drain() {
	e.t.Helper()
	if bal := e.account().BalanceMinor; bal > 0 {
		if _, err := e.core.AdminDebit(ctx, e.acc, bal, "drain for the test", uuid.New(), &e.owner); err != nil {
			e.t.Fatal(err)
		}
	}
}
