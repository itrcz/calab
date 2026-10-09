package stripe

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

const (
	testKey     = "sk_test_FIXTUREFIXTUREFIXTURE"
	testAccount = "acct_FIXTURE0001"
)

// Fixture metadata (testdata/*.json were recorded against the test API and anonymized).
var (
	fixAccount = uuid.MustParse("3ec8d17f-f6cb-4706-801f-f21d2fc8a7d0")
	fixAttempt = uuid.MustParse("9d01479d-eb6e-45d0-9f84-17b4108a786a")
)

type mockResp struct {
	status int
	body   []byte
	hijack bool // drop the connection without an answer
}

type mockReq struct {
	method, path string
	form         url.Values
	header       http.Header
}

// mockStripe stands in for api.stripe.com: routes "METHOD /path" → queued answers (the last
// one repeats), every request recorded.
type mockStripe struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	routes map[string][]mockResp
	reqs   []mockReq
}

func newMock(t *testing.T) *mockStripe {
	t.Helper()
	m := &mockStripe{t: t, routes: map[string][]mockResp{}}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockStripe) serve(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	key := r.Method + " " + r.URL.Path
	m.mu.Lock()
	m.reqs = append(m.reqs, mockReq{method: r.Method, path: r.URL.Path, form: r.Form, header: r.Header.Clone()})
	q := m.routes[key]
	var res mockResp
	ok := len(q) > 0
	if ok {
		res = q[0]
		if len(q) > 1 {
			m.routes[key] = q[1:]
		}
	}
	m.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","code":"resource_missing","message":"no route"}}`))
		return
	}
	if res.hijack {
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		_ = conn.Close()
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Request-Id", "req_FIXTURE")
	w.WriteHeader(res.status)
	_, _ = w.Write(res.body)
}

func (m *mockStripe) on(method, path string, status int, body []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := method + " " + path
	m.routes[k] = append(m.routes[k], mockResp{status: status, body: body})
}

func (m *mockStripe) onHijack(method, path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := method + " " + path
	m.routes[k] = append(m.routes[k], mockResp{hijack: true})
}

func (m *mockStripe) requests(method, path string) []mockReq {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []mockReq
	for _, r := range m.reqs {
		if r.method == method && r.path == path {
			out = append(out, r)
		}
	}
	return out
}

func (m *mockStripe) last(t *testing.T, method, path string) mockReq {
	t.Helper()
	rs := m.requests(method, path)
	if len(rs) == 0 {
		t.Fatalf("no %s %s request", method, path)
	}
	return rs[len(rs)-1]
}

func noRetries() *int64 { var n int64; return &n }

func (m *mockStripe) provider(t *testing.T, mut ...func(*Config)) *Provider {
	t.Helper()
	cfg := Config{SecretKey: testKey, Account: testAccount, BaseURL: m.srv.URL, MaxRetries: noRetries(),
		WebhookSecrets: []string{"whsec_fixture"}}
	for _, f := range mut {
		f(&cfg)
	}
	p, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name)) //nolint:gosec // test fixtures
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// patch decodes a JSON object, applies f and re-encodes it.
func patch(t *testing.T, b []byte, f func(map[string]any)) []byte {
	t.Helper()
	var o map[string]any
	if err := json.Unmarshal(b, &o); err != nil {
		t.Fatal(err)
	}
	f(o)
	out, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func usd(minor int64) money.Money { return money.New(minor, money.USD) }

var ctx = context.Background()

func TestAPIVersionPinned(t *testing.T) {
	if stripego.APIVersion != APIVersion {
		t.Fatalf("stripe-go is pinned to %s, the adapter to %s: rerun the contract tests and refresh testdata", stripego.APIVersion, APIVersion)
	}
}

func TestNewRefusesLiveAndBadConfig(t *testing.T) {
	for _, key := range []string{"sk_live_FIXTUREFIXTURE", "rk_live_FIXTUREFIXTURE"} {
		if _, err := New(Config{SecretKey: key}); !errors.Is(err, provider.ErrLivemodeForbidden) {
			t.Fatalf("%s: %v", key[:7], err)
		}
		p, err := New(Config{SecretKey: key, LivemodeAllowed: true})
		if err != nil || !p.Livemode() {
			t.Fatalf("allowed live: %v", err)
		}
	}
	for name, cfg := range map[string]Config{
		"empty":       {},
		"publishable": {SecretKey: "pk_test_FIXTUREFIXTURE"}, //nolint:gosec // fake key
		"no mode":     {SecretKey: "sk_FIXTUREFIXTURE"},      //nolint:gosec // fake key
		"whsec":       {SecretKey: testKey, WebhookSecrets: []string{"nope"}},
		"version":     {SecretKey: testKey, APIVersion: "2025-03-31.basil"},
	} {
		_, err := New(cfg)
		if err == nil {
			t.Fatalf("%s: accepted", name)
		}
		if strings.Contains(err.Error(), "FIXTURE") {
			t.Fatalf("%s: error leaks the key: %v", name, err)
		}
	}
	if _, err := New(Config{SecretKey: "rk_test_FIXTUREFIXTURE", APIVersion: APIVersion}); err != nil { //nolint:gosec // fake key
		t.Fatal(err)
	}
}

func TestFromEnv(t *testing.T) {
	c := FromEnv(testKey, " whsec_old , whsec_new,", APIVersion, false)
	if len(c.WebhookSecrets) != 2 || c.WebhookSecrets[0] != "whsec_old" || c.WebhookSecrets[1] != "whsec_new" {
		t.Fatalf("%v", c.WebhookSecrets)
	}
	if _, err := New(c); err != nil {
		t.Fatal(err)
	}
}

func TestIDAndCaps(t *testing.T) {
	p := newMock(t).provider(t)
	if p.ID() != provider.Stripe {
		t.Fatal(p.ID())
	}
	want := provider.CapHostedCheckout | provider.CapSaveMethod | provider.CapOffSession | provider.CapIdempotentCharge |
		provider.CapRefund | provider.CapPartialRefund | provider.CapDisputes | provider.CapReceipts | provider.CapListPayments
	if p.Caps() != want {
		t.Fatalf("caps %b", p.Caps())
	}
	reg, err := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), p)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reg.OffSession(provider.Stripe); !ok {
		t.Fatal("not an off-session charger in the registry")
	}
	ms := reg.Methods(provider.MarketGlobal, money.USD, provider.PayerPerson, "AE")
	if len(ms) != 1 || ms[0].ID != "stripe:card" || !ms[0].AutoTopupCapable {
		t.Fatalf("methods %+v", ms)
	}
}

func TestAccountResolvedOnce(t *testing.T) {
	m := newMock(t)
	m.on("GET", "/v1/account", 500, []byte(`{"error":{"type":"api_error","message":"boom"}}`))
	m.on("GET", "/v1/account", 200, []byte(`{"id":"acct_FIXTURE0009","object":"account"}`))
	p := m.provider(t, func(c *Config) { c.Account = "" })
	if _, err := p.Account(ctx); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("first: %v", err)
	}
	for range 3 {
		a, err := p.Account(ctx)
		if err != nil || a != "acct_FIXTURE0009" {
			t.Fatalf("%v %s", err, a)
		}
	}
	if n := len(m.requests("GET", "/v1/account")); n != 2 {
		t.Fatalf("%d account lookups", n)
	}
}

func TestEnsureCustomer(t *testing.T) {
	m := newMock(t)
	m.on("POST", "/v1/customers", 200, fixture(t, "customer.json"))
	p := m.provider(t)
	acc := uuid.MustParse("abe96dea-e1b8-4677-b15a-2b8026267952")
	ref, err := p.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + acc.String(), AccountID: acc, Email: "payer@example.com", Name: "Fixture Payer"})
	if err != nil {
		t.Fatal(err)
	}
	if ref != (provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: testAccount, ID: "cus_FIXTURE0001"}) {
		t.Fatalf("%+v", ref)
	}
	r := m.last(t, "POST", "/v1/customers")
	if r.header.Get("Idempotency-Key") != "customer:"+acc.String() || r.header.Get("Stripe-Version") != APIVersion {
		t.Fatalf("headers %v", r.header)
	}
	if r.form.Get("metadata[calab_account_id]") != acc.String() || r.form.Get("email") != "payer@example.com" {
		t.Fatalf("form %v", r.form)
	}
	if _, err := p.EnsureCustomer(ctx, provider.CustomerReq{AccountID: acc}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("no key: %v", err)
	}
	if n := len(m.requests("POST", "/v1/customers")); n != 1 {
		t.Fatalf("%d requests", n)
	}
}

func checkoutReq(save bool) provider.CheckoutReq {
	chk := uuid.MustParse("e21679b8-ab27-41b3-bb43-c9e4cc62825c")
	ret := "https://app.calab.test/api/billing/return?checkout=" + chk.String()
	return provider.CheckoutReq{
		IdemKey: "checkout:" + chk.String(), Amount: usd(500), Method: provider.MethodCard,
		Customer:   provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: testAccount, ID: "cus_FIXTURE0001"},
		SuccessURL: ret, CancelURL: ret, SaveForOffSession: save, ExpiresAt: time.Unix(1791565200, 0),
		Metadata: provider.Metadata{AccountID: uuid.MustParse("abe96dea-e1b8-4677-b15a-2b8026267952"), CheckoutID: chk, Kind: provider.MetadataKindCheckout},
	}
}

func TestCreateCheckout(t *testing.T) {
	m := newMock(t)
	m.on("POST", "/v1/checkout/sessions", 200, fixture(t, "checkout_session_created.json"))
	p := m.provider(t)
	req := checkoutReq(true)
	s, err := p.CreateCheckout(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "cs_test_FIXTURE0001" || !strings.HasPrefix(s.URL, "https://checkout.stripe.com/") || s.ProviderAccount != testAccount || s.Livemode || s.ExpiresAt.IsZero() {
		t.Fatalf("%+v", s)
	}
	r := m.last(t, "POST", "/v1/checkout/sessions")
	if r.header.Get("Idempotency-Key") != req.IdemKey {
		t.Fatalf("idempotency key %q", r.header.Get("Idempotency-Key"))
	}
	want := map[string]string{
		"mode":                                             "payment",
		"customer":                                         "cus_FIXTURE0001",
		"client_reference_id":                              req.Metadata.CheckoutID.String(),
		"payment_method_types[0]":                          "card",
		"line_items[0][quantity]":                          "1",
		"line_items[0][price_data][currency]":              "usd",
		"line_items[0][price_data][unit_amount]":           "500",
		"line_items[0][price_data][product_data][name]":    DefaultLineItem,
		"metadata[calab_account_id]":                       req.Metadata.AccountID.String(),
		"metadata[calab_checkout_id]":                      req.Metadata.CheckoutID.String(),
		"metadata[kind]":                                   provider.MetadataKindCheckout,
		"payment_intent_data[metadata][calab_checkout_id]": req.Metadata.CheckoutID.String(),
		"payment_intent_data[metadata][kind]":              provider.MetadataKindCheckout,
		"payment_intent_data[setup_future_usage]":          "off_session",
		"billing_address_collection":                       "required",
		"tax_id_collection[enabled]":                       "true",
		"customer_update[name]":                            "auto",
		"customer_update[address]":                         "auto",
		"automatic_tax[enabled]":                           "false",
		"adaptive_pricing[enabled]":                        "false",
		"success_url":                                      req.SuccessURL,
		"cancel_url":                                       req.CancelURL,
		"expires_at":                                       "1791565200",
		"locale":                                           "auto",
	}
	for k, v := range want {
		if got := r.form.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	for k := range r.form {
		if strings.HasPrefix(k, "invoice_creation") {
			t.Errorf("unexpected %s", k)
		}
	}

	// Without saving the method: no setup_future_usage; default expiry ≈ 1h.
	req = checkoutReq(false)
	req.ExpiresAt = time.Time{}
	if _, err := p.CreateCheckout(ctx, req); err != nil {
		t.Fatal(err)
	}
	r = m.last(t, "POST", "/v1/checkout/sessions")
	if _, ok := r.form["payment_intent_data[setup_future_usage]"]; ok {
		t.Error("setup_future_usage without SaveForOffSession")
	}
	if exp := r.form.Get("expires_at"); exp == "" {
		t.Error("no expires_at")
	}

	// Local refusals never reach Stripe.
	n := len(m.requests("POST", "/v1/checkout/sessions"))
	for name, mut := range map[string]func(*provider.CheckoutReq){
		"no key":   func(r *provider.CheckoutReq) { r.IdemKey = "" },
		"sbp":      func(r *provider.CheckoutReq) { r.Method = provider.MethodSBP },
		"zero":     func(r *provider.CheckoutReq) { r.Amount = usd(0) },
		"currency": func(r *provider.CheckoutReq) { r.Amount = money.New(500, "EUR") },
		"customer": func(r *provider.CheckoutReq) { r.Customer.ID = "" },
	} {
		req := checkoutReq(false)
		mut(&req)
		if _, err := p.CreateCheckout(ctx, req); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
	req = checkoutReq(false)
	req.Customer.Livemode = true
	if _, err := p.CreateCheckout(ctx, req); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Errorf("live customer: %v", err)
	}
	if got := len(m.requests("POST", "/v1/checkout/sessions")); got != n {
		t.Fatalf("refused requests reached Stripe: %d", got-n)
	}
}

func TestGetCheckout(t *testing.T) {
	m := newMock(t)
	created := fixture(t, "checkout_session_created.json")
	m.on("GET", "/v1/checkout/sessions/cs_test_FIXTURE0001", 200, created)
	m.on("GET", "/v1/checkout/sessions/cs_test_FIXTURE0001", 200, patch(t, created, func(o map[string]any) {
		o["status"] = "complete"
		o["payment_status"] = "paid"
		o["payment_intent"] = "pi_FIXTURE0004"
	}))
	p := m.provider(t)
	f, err := p.GetCheckout(ctx, "cs_test_FIXTURE0001")
	if err != nil {
		t.Fatal(err)
	}
	if f.Status != provider.CheckoutOpen || f.Amount != usd(500) || f.CustomerID != "cus_FIXTURE0001" || f.PaymentID != "" ||
		f.Metadata.Kind != provider.MetadataKindCheckout || f.Metadata.CheckoutID == uuid.Nil || f.ProviderAccount != testAccount {
		t.Fatalf("%+v", f)
	}
	f, err = p.GetCheckout(ctx, "cs_test_FIXTURE0001")
	if err != nil || f.Status != provider.CheckoutComplete || f.PaymentID != "pi_FIXTURE0004" {
		t.Fatalf("%v %+v", err, f)
	}
	if _, err := p.GetCheckout(ctx, "cs_test_missing"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}

func TestGetPaymentSucceeded(t *testing.T) {
	m := newMock(t)
	m.on("GET", "/v1/payment_intents/pi_FIXTURE0003", 200, fixture(t, "pi_get_succeeded.json"))
	p := m.provider(t)
	f, err := p.GetPayment(ctx, "pi_FIXTURE0003")
	if err != nil {
		t.Fatal(err)
	}
	if f.Status != provider.PaymentSucceeded || f.Amount != usd(1000) || f.AmountReceived != usd(1000) ||
		f.CustomerID != "cus_FIXTURE0004" || f.ChargeID != "ch_FIXTURE0002" || f.ReceiptURL == "" ||
		f.PaymentMethodID != "pm_FIXTURE0002" || f.SucceededAt.IsZero() || f.Created.IsZero() || f.FailureCode != "" ||
		f.Metadata != (provider.Metadata{AccountID: fixAccount, AttemptID: fixAttempt, Kind: provider.MetadataKindAutoTopup}) ||
		f.ProviderAccount != testAccount || f.Livemode {
		t.Fatalf("%+v", f)
	}
	r := m.last(t, "GET", "/v1/payment_intents/pi_FIXTURE0003")
	if r.form.Get("expand[0]") != "latest_charge" || r.form.Get("expand[1]") != "payment_method" {
		t.Fatalf("expand %v", r.form)
	}
}

func TestGetPaymentDeclinedByKind(t *testing.T) {
	m := newMock(t)
	declined := fixture(t, "pi_get_declined.json")
	m.on("GET", "/v1/payment_intents/pi_FIXTURE0002", 200, declined)
	m.on("GET", "/v1/payment_intents/pi_FIXTURE0002", 200, patch(t, declined, func(o map[string]any) {
		o["metadata"].(map[string]any)["kind"] = provider.MetadataKindCheckout
	}))
	p := m.provider(t)
	f, err := p.GetPayment(ctx, "pi_FIXTURE0002")
	if err != nil || f.Status != provider.PaymentFailed || f.FailureCode != "insufficient_funds" || f.AmountReceived.Minor != 0 {
		t.Fatalf("auto-topup decline %v %+v", err, f)
	}
	// A checkout payment may still be retried by the payer on the hosted page.
	f, err = p.GetPayment(ctx, "pi_FIXTURE0002")
	if err != nil || f.Status != provider.PaymentRequiresAction || f.FailureCode != "insufficient_funds" {
		t.Fatalf("checkout decline %v %+v", err, f)
	}
}

func offReq() provider.OffSessionReq {
	return provider.OffSessionReq{
		IdemKey: fixAttempt.String(), Customer: provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: testAccount, ID: "cus_FIXTURE0004"},
		PaymentMethodID: "pm_FIXTURE0002", Amount: usd(1000), Description: "Calab auto top-up",
		Metadata: provider.Metadata{AccountID: fixAccount, AttemptID: fixAttempt},
	}
}

func TestChargeOffSession(t *testing.T) {
	m := newMock(t)
	m.on("POST", "/v1/payment_intents", 200, fixture(t, "pi_offsession_succeeded.json"))
	m.on("POST", "/v1/payment_intents", 402, fixture(t, "pi_offsession_declined.json"))
	m.on("POST", "/v1/payment_intents", 402, fixture(t, "pi_offsession_requires_action.json"))
	p := m.provider(t)

	f, err := p.ChargeOffSession(ctx, offReq())
	if err != nil {
		t.Fatal(err)
	}
	if f.Status != provider.PaymentSucceeded || f.AmountReceived != usd(1000) || f.ChargeID != "ch_FIXTURE0002" || f.ReceiptURL == "" {
		t.Fatalf("succeeded %+v", f)
	}
	r := m.last(t, "POST", "/v1/payment_intents")
	for k, v := range map[string]string{
		"amount": "1000", "currency": "usd", "customer": "cus_FIXTURE0004", "payment_method": "pm_FIXTURE0002",
		"confirm": "true", "off_session": "true", "payment_method_types[0]": "card", "description": "Calab auto top-up",
		"metadata[calab_attempt_id]": fixAttempt.String(), "metadata[calab_account_id]": fixAccount.String(),
		"metadata[kind]": provider.MetadataKindAutoTopup,
	} {
		if got := r.form.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if r.header.Get("Idempotency-Key") != fixAttempt.String() {
		t.Fatalf("idempotency key %q", r.header.Get("Idempotency-Key"))
	}

	f, err = p.ChargeOffSession(ctx, offReq())
	if err != nil || f.Status != provider.PaymentFailed || f.FailureCode != "insufficient_funds" || f.ID != "pi_FIXTURE0002" {
		t.Fatalf("declined %v %+v", err, f)
	}
	f, err = p.ChargeOffSession(ctx, offReq())
	if err != nil || f.Status != provider.PaymentRequiresAction || f.FailureCode != "authentication_required" || f.ID != "pi_FIXTURE0001" {
		t.Fatalf("requires_action %v %+v", err, f)
	}

	req := offReq()
	req.IdemKey = ""
	if _, err := p.ChargeOffSession(ctx, req); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("no key: %v", err)
	}
}

func TestChargeOffSessionUnknownOutcome(t *testing.T) {
	m := newMock(t)
	m.onHijack("POST", "/v1/payment_intents")
	m.on("POST", "/v1/payment_intents", 500, []byte(`{"error":{"type":"api_error","message":"internal"}}`))
	m.on("POST", "/v1/payment_intents", 429, []byte(`{"error":{"type":"invalid_request_error","code":"rate_limit","message":"slow down"}}`))
	m.on("POST", "/v1/payment_intents", 409, []byte(`{"error":{"type":"invalid_request_error","code":"idempotency_key_in_use","message":"in use"}}`))
	p := m.provider(t)
	for i := range 4 {
		if _, err := p.ChargeOffSession(ctx, offReq()); !errors.Is(err, provider.ErrUnknownOutcome) {
			t.Fatalf("%d: %v", i, err)
		}
	}
	// A canceled context is unknown too, and still matches context.Canceled.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	_, err := p.ChargeOffSession(cctx, offReq())
	if !errors.Is(err, provider.ErrUnknownOutcome) || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
}

func TestRetriesKeepIdempotencyKey(t *testing.T) {
	m := newMock(t)
	m.onHijack("POST", "/v1/payment_intents") // connection lost: stripe-go retries it
	m.on("POST", "/v1/payment_intents", 200, fixture(t, "pi_offsession_succeeded.json"))
	one := int64(1)
	p := m.provider(t, func(c *Config) { c.MaxRetries = &one })
	f, err := p.ChargeOffSession(ctx, offReq())
	if err != nil || f.Status != provider.PaymentSucceeded {
		t.Fatalf("%v %+v", err, f)
	}
	rs := m.requests("POST", "/v1/payment_intents")
	if len(rs) != 2 || rs[0].header.Get("Idempotency-Key") != fixAttempt.String() || rs[1].header.Get("Idempotency-Key") != fixAttempt.String() {
		t.Fatalf("%d requests", len(rs))
	}
}

func TestCancelPayment(t *testing.T) {
	m := newMock(t)
	m.on("POST", "/v1/payment_intents/pi_FIXTURE0001/cancel", 200, fixture(t, "pi_canceled.json"))
	m.on("POST", "/v1/payment_intents/pi_FIXTURE0001/cancel", 400, []byte(`{"error":{"type":"invalid_request_error","code":"payment_intent_unexpected_state","message":"You cannot cancel this PaymentIntent because it has a status of canceled."}}`))
	m.on("GET", "/v1/payment_intents/pi_FIXTURE0001", 200, fixture(t, "pi_canceled.json"))
	p := m.provider(t)
	for i := range 2 {
		f, err := p.CancelPayment(ctx, "pi_FIXTURE0001")
		if err != nil || f.Status != provider.PaymentCanceled {
			t.Fatalf("%d: %v %+v", i, err, f)
		}
	}
	if r := m.last(t, "POST", "/v1/payment_intents/pi_FIXTURE0001/cancel"); r.form.Get("cancellation_reason") != "abandoned" {
		t.Fatalf("form %v", r.form)
	}
}

func TestRefunds(t *testing.T) {
	m := newMock(t)
	m.on("POST", "/v1/refunds", 200, fixture(t, "refund_created.json"))
	m.on("GET", "/v1/refunds/re_FIXTURE0001", 200, patch(t, fixture(t, "refund_created.json"), func(o map[string]any) {
		o["status"] = "failed"
		o["failure_reason"] = "expired_or_canceled_card"
	}))
	m.on("GET", "/v1/refunds", 200, []byte(`{"object":"list","has_more":false,"url":"/v1/refunds","data":[`+string(fixture(t, "refund_created.json"))+`]}`))
	p := m.provider(t)
	key := "refund:" + uuid.NewString()
	f, err := p.Refund(ctx, provider.RefundReq{IdemKey: key, PaymentID: "pi_FIXTURE0003", Amount: usd(300), Reason: "owner asked", Metadata: provider.Metadata{AccountID: fixAccount}})
	if err != nil {
		t.Fatal(err)
	}
	if f.ID != "re_FIXTURE0001" || f.PaymentID != "pi_FIXTURE0003" || f.Amount != usd(300) || f.Status != provider.RefundSucceeded ||
		f.Metadata.AccountID != fixAccount || f.ProviderAccount != testAccount || f.Livemode {
		t.Fatalf("%+v", f)
	}
	r := m.last(t, "POST", "/v1/refunds")
	if r.header.Get("Idempotency-Key") != key || r.form.Get("reason") != "requested_by_customer" || r.form.Get("amount") != "300" ||
		r.form.Get("payment_intent") != "pi_FIXTURE0003" || r.form.Get("metadata[calab_account_id]") != fixAccount.String() {
		t.Fatalf("%v %v", r.header, r.form)
	}
	if _, err := p.Refund(ctx, provider.RefundReq{IdemKey: key, PaymentID: "pi_FIXTURE0003", Amount: usd(300), Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	if r := m.last(t, "POST", "/v1/refunds"); r.form.Get("reason") != "duplicate" {
		t.Fatalf("reason %q", r.form.Get("reason"))
	}
	g, err := p.GetRefund(ctx, "re_FIXTURE0001")
	if err != nil || g.Status != provider.RefundFailed || g.FailureReason != "expired_or_canceled_card" {
		t.Fatalf("%v %+v", err, g)
	}
	list, err := p.ListRefunds(ctx, "pi_FIXTURE0003")
	if err != nil || len(list) != 1 || list[0].ID != "re_FIXTURE0001" {
		t.Fatalf("%v %+v", err, list)
	}
	if r := m.last(t, "GET", "/v1/refunds"); r.form.Get("payment_intent") != "pi_FIXTURE0003" {
		t.Fatalf("%v", r.form)
	}
	for name, req := range map[string]provider.RefundReq{
		"no key":  {PaymentID: "pi_x", Amount: usd(1)},
		"zero":    {IdemKey: "k", PaymentID: "pi_x", Amount: usd(0)},
		"payment": {IdemKey: "k", Amount: usd(1)},
	} {
		if _, err := p.Refund(ctx, req); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func listOf(t *testing.T, hasMore bool, items ...[]byte) []byte {
	t.Helper()
	parts := make([]string, len(items))
	for i, b := range items {
		parts[i] = string(b)
	}
	hm := "false"
	if hasMore {
		hm = "true"
	}
	return []byte(`{"object":"list","url":"/v1/x","has_more":` + hm + `,"data":[` + strings.Join(parts, ",") + `]}`)
}

func TestListPayments(t *testing.T) {
	m := newMock(t)
	auto := fixture(t, "pi_get_succeeded.json")
	checkout := patch(t, auto, func(o map[string]any) {
		o["id"] = "pi_FIXTURE0099"
		o["metadata"] = map[string]any{"kind": provider.MetadataKindCheckout}
	})
	m.on("GET", "/v1/payment_intents", 200, listOf(t, true, checkout, auto))
	m.on("GET", "/v1/payment_intents", 200, listOf(t, false))
	p := m.provider(t)
	cus := provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: testAccount, ID: "cus_FIXTURE0004"}
	since := time.Unix(1791500000, 0)
	page, next, err := p.ListPayments(ctx, provider.ListReq{Customer: cus, CreatedAfter: since, Kind: provider.MetadataKindAutoTopup, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 1 || page[0].ID != "pi_FIXTURE0003" || next != "pi_FIXTURE0003" {
		t.Fatalf("page %+v next %q", page, next)
	}
	r := m.last(t, "GET", "/v1/payment_intents")
	if r.form.Get("customer") != "cus_FIXTURE0004" || r.form.Get("created[gte]") != "1791500000" || r.form.Get("limit") != "2" ||
		r.form.Get("starting_after") != "" {
		t.Fatalf("query %v", r.form)
	}
	page, next, err = p.ListPayments(ctx, provider.ListReq{Customer: cus, Cursor: next})
	if err != nil || len(page) != 0 || next != "" {
		t.Fatalf("%v %+v %q", err, page, next)
	}
	r = m.last(t, "GET", "/v1/payment_intents")
	if r.form.Get("starting_after") != "pi_FIXTURE0003" || r.form.Get("limit") != "100" {
		t.Fatalf("query %v", r.form)
	}
	if n := len(m.requests("GET", "/v1/payment_intents")); n != 2 {
		t.Fatalf("auto-paginated: %d requests", n)
	}
}

const pmJSON = `{"id":"pm_FIXTURE0003","object":"payment_method","type":"card","customer":"cus_FIXTURE0004","livemode":false,
"card":{"brand":"visa","last4":"4242","exp_month":12,"exp_year":2030,"funding":"credit","country":"US"},"metadata":{}}`

func TestMethods(t *testing.T) {
	m := newMock(t)
	m.on("GET", "/v1/customers/cus_FIXTURE0004/payment_methods", 200, listOf(t, false, []byte(pmJSON)))
	detached := []byte(strings.Replace(pmJSON, `"customer":"cus_FIXTURE0004"`, `"customer":null`, 1))
	m.on("GET", "/v1/payment_methods/pm_FIXTURE0003", 200, []byte(pmJSON)) // GetMethod
	m.on("GET", "/v1/payment_methods/pm_FIXTURE0003", 200, []byte(pmJSON)) // read after the 2nd detach
	m.on("GET", "/v1/payment_methods/pm_FIXTURE0003", 200, detached)       // read after the 3rd detach
	m.on("POST", "/v1/payment_methods/pm_FIXTURE0003/detach", 200, []byte(strings.Replace(pmJSON, `"customer":"cus_FIXTURE0004"`, `"customer":null`, 1)))
	m.on("POST", "/v1/payment_methods/pm_FIXTURE0003/detach", 400, []byte(`{"error":{"type":"invalid_request_error","message":"The payment method you provided is not attached to a customer so detachment is impossible."}}`))
	p := m.provider(t)
	cus := provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: testAccount, ID: "cus_FIXTURE0004"}
	ms, err := p.ListMethods(ctx, cus)
	want := provider.SavedMethod{ID: "pm_FIXTURE0003", CustomerID: "cus_FIXTURE0004", Kind: provider.MethodCard, Brand: "visa", Last4: "4242", ExpMonth: 12, ExpYear: 2030}
	if err != nil || len(ms) != 1 || ms[0] != want {
		t.Fatalf("%v %+v", err, ms)
	}
	if r := m.last(t, "GET", "/v1/customers/cus_FIXTURE0004/payment_methods"); r.form.Get("type") != "card" {
		t.Fatalf("%v", r.form)
	}
	got, err := p.GetMethod(ctx, "pm_FIXTURE0003")
	if err != nil || got != want {
		t.Fatalf("%v %+v", err, got)
	}
	if err := p.DetachMethod(ctx, "pm_FIXTURE0003"); err != nil {
		t.Fatal(err)
	}
	// A 400 on detach: success only if a fresh read shows the method without a customer.
	if err := p.DetachMethod(ctx, "pm_FIXTURE0003"); err == nil {
		t.Fatal("400 on a still attached method reported as success")
	}
	if err := p.DetachMethod(ctx, "pm_FIXTURE0003"); err != nil {
		t.Fatalf("detach of a detached method: %v", err)
	}
}

func TestLivemodeObjectsRefused(t *testing.T) {
	live := patch(t, fixture(t, "pi_get_succeeded.json"), func(o map[string]any) { o["livemode"] = true })
	m := newMock(t)
	m.on("GET", "/v1/payment_intents/pi_FIXTURE0003", 200, live)
	m.on("GET", "/v1/payment_methods/pm_FIXTURE0003", 200, []byte(strings.Replace(pmJSON, `"livemode":false`, `"livemode":true`, 1)))
	m.on("POST", "/v1/customers", 200, patch(t, fixture(t, "customer.json"), func(o map[string]any) { o["livemode"] = true }))
	p := m.provider(t)
	if _, err := p.GetPayment(ctx, "pi_FIXTURE0003"); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("payment: %v", err)
	}
	if _, err := p.GetMethod(ctx, "pm_FIXTURE0003"); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("method: %v", err)
	}
	if _, err := p.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:x", AccountID: fixAccount}); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("customer: %v", err)
	}
	allowed := m.provider(t, func(c *Config) { c.LivemodeAllowed = true })
	f, err := allowed.GetPayment(ctx, "pi_FIXTURE0003")
	if err != nil || !f.Livemode {
		t.Fatalf("allowed: %v %+v", err, f)
	}
}

func TestErrorMapping(t *testing.T) {
	m := newMock(t)
	m.on("GET", "/v1/payment_intents/pi_idem", 400, []byte(`{"error":{"type":"idempotency_error","message":"Keys for idempotent requests can only be used with the same parameters"}}`))
	m.on("GET", "/v1/payment_intents/pi_leak", 400, []byte(`{"error":{"type":"invalid_request_error","code":"parameter_invalid","param":"amount",
		"message":"Invalid API Key provided: sk_test_abcdefghijklmnop; secret pi_123_secret_ABCDEFGH; whsec_ABCDEF123",
		"payment_intent":{"id":"pi_leak","object":"payment_intent","client_secret":"pi_leak_secret_TOPSECRET","amount":1,"currency":"usd","status":"requires_payment_method"}}}`))
	m.on("GET", "/v1/payment_intents/pi_auth", 401, []byte(`{"error":{"type":"invalid_request_error","message":"Invalid API Key provided: sk_test_****MNOP"}}`))
	p := m.provider(t)

	if _, err := p.GetPayment(ctx, "pi_missing"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("404: %v", err)
	}
	if _, err := p.GetPayment(ctx, "pi_idem"); !errors.Is(err, ErrIdempotencyMismatch) || !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("idempotency: %v", err)
	}
	_, err := p.GetPayment(ctx, "pi_leak")
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 400 || ae.Code != "parameter_invalid" || ae.Param != "amount" || ae.RequestID != "req_FIXTURE" {
		t.Fatalf("api error: %#v", err)
	}
	for _, s := range []string{"sk_test_abc", "TOPSECRET", "_secret_ABC", "whsec_ABC", "client_secret"} {
		if strings.Contains(err.Error(), s) {
			t.Fatalf("error leaks %q: %v", s, err)
		}
	}
	if errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("definite refusal mapped as %v", err)
	}
	_, err = p.GetPayment(ctx, "pi_auth")
	if !errors.As(err, &ae) || ae.Status != 401 || strings.Contains(err.Error(), "MNOP") {
		t.Fatalf("auth error: %v", err)
	}
}
