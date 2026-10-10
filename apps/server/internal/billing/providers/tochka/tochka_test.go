package tochka

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Fixtures (testdata): live_* are answers of the production API recorded on 2026-10-10 with
// two unpaid 1 ₽ links (identifiers replaced: customer code 300123123, merchant
// 200000000001234 — the values of the bank's documentation examples); sandbox_* are the
// sandbox's canned answers; webhook_*.jwt are the signed examples of the bank's documentation
// (verifiable with DefaultWebhookKey).
const (
	testCustomer = "300123123"
	testMerchant = "200000000001234"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name) //nolint:gosec // test fixtures
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

// ours rewrites a sandbox fixture to our test customer / merchant.
func ours(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `"1234567ab"`, `"`+testCustomer+`"`), `"merchantId":"200000000001148"`, `"merchantId":"`+testMerchant+`"`)
}

type call struct {
	method, path, query string
	body                map[string]any
	auth                string
}

// bank is a fake Tochka API: routes "METHOD /path" → handler; records every call.
type bank struct {
	mu     sync.Mutex
	calls  []call
	routes map[string]func(w http.ResponseWriter, c call)
}

func (b *bank) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	c := call{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, auth: r.Header.Get("Authorization")}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &c.body)
	}
	b.mu.Lock()
	b.calls = append(b.calls, c)
	h := b.routes[r.Method+" "+r.URL.Path]
	b.mu.Unlock()
	if h == nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"404","id":"x","message":"not found","Errors":[]}`))
		return
	}
	h(w, c)
}

func (b *bank) count(method, path string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, c := range b.calls {
		if c.method == method && c.path == path {
			n++
		}
	}
	return n
}

func reply(status int, body string) func(http.ResponseWriter, call) {
	return func(w http.ResponseWriter, _ call) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func newTest(t *testing.T, routes map[string]func(http.ResponseWriter, call)) (*Provider, *bank) {
	t.Helper()
	b := &bank{routes: routes}
	srv := httptest.NewServer(b)
	t.Cleanup(srv.Close)
	p, err := New(Config{BaseURL: srv.URL, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant, ClientID: "client-1", HTTPClient: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p, b
}

func TestNewValidates(t *testing.T) {
	ok := Config{Token: "t", CustomerCode: testCustomer, MerchantID: testMerchant}
	if _, err := New(ok); err != nil {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*Config){
		"token":    func(c *Config) { c.Token = "" },
		"customer": func(c *Config) { c.CustomerCode = "123" },
		"merchant": func(c *Config) { c.MerchantID = "abc" },
		"http":     func(c *Config) { c.BaseURL = "http://enter.tochka.com/uapi" },
		"tax":      func(c *Config) { c.TaxSystem = "envd" },
		"vat":      func(c *Config) { c.VatType = "vat20" },
		"key":      func(c *Config) { c.WebhookKey = `{"kty":"oct","k":"AAAA"}` },
	} {
		c := ok
		mut(&c)
		if _, err := New(c); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
	p, _ := New(ok)
	if !p.Livemode() || p.Caps().SafeRetry() || !p.Caps().Has(provider.CapReconcilableCharge|provider.CapSuccessOnlyWebhooks|provider.CapHostedCheckout) {
		t.Fatalf("caps / livemode: %v %v", p.Livemode(), p.Caps())
	}
	sb, _ := New(Config{BaseURL: SandboxBaseURL, Token: "sandbox.jwt.token", //nolint:gosec // the public sandbox token
		CustomerCode: "1234567ab", MerchantID: "200000000001097"})
	if sb.Livemode() {
		t.Fatal("sandbox is live")
	}
	if _, err := RootCAs(); err != nil {
		t.Fatal(err)
	}
}

func TestTokenIssuer(t *testing.T) {
	// header.{"iss":"abc","sub":"x"}.sig
	if got := tokenIssuer("eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhYmMiLCJzdWIiOiJ4In0.c2ln"); got != "abc" {
		t.Fatalf("iss = %q", got)
	}
	if tokenIssuer("nope") != "" {
		t.Fatal("garbage parsed")
	}
}

func checkoutReq(method provider.Method) provider.CheckoutReq {
	acc, co := uuid.MustParse("0199d4a2-0000-7000-8000-000000000001"), uuid.MustParse("0199d4a2-7c1e-7a40-9b6e-5f3c2d1e0a01")
	return provider.CheckoutReq{
		IdemKey: "checkout:" + co.String(), Amount: money.New(15000, money.RUB), Method: method,
		Customer:   provider.CustomerRef{Provider: provider.Tochka, ProviderAccount: testCustomer, Livemode: true, ID: acc.String()},
		SuccessURL: "https://app.calab.test/api/billing/return?checkout=" + co.String(), CancelURL: "https://app.calab.test/api/billing/return?checkout=" + co.String(),
		ExpiresAt: time.Now().Add(35 * time.Minute), Metadata: provider.Metadata{AccountID: acc, CheckoutID: co, Kind: provider.MetadataKindCheckout},
		ReceiptEmail: "owner@calab.test",
	}
}

// An organization or a sole proprietor is the named buyer of its receipt (ADR-0080 §0.1).
func TestCreateCheckoutReceiptBuyerName(t *testing.T) {
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){
		"POST /acquiring/v1.0/payments_with_receipt": reply(200, fixture(t, "live_create_with_receipt.json")),
	})
	req := checkoutReq(provider.MethodCard)
	req.ReceiptName = "ООО «Ромашка»"
	if _, err := p.CreateCheckout(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	cl := b.calls[0].body["Data"].(map[string]any)["Client"].(map[string]any)
	if cl["name"] != "ООО «Ромашка»" || cl["email"] != "owner@calab.test" {
		t.Fatalf("client %v", cl)
	}
}

func TestCreateCheckoutRequestShape(t *testing.T) {
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){
		"POST /acquiring/v1.0/payments_with_receipt": reply(200, fixture(t, "live_create_with_receipt.json")),
	})
	sess, err := p.CreateCheckout(context.Background(), checkoutReq(provider.MethodSBP))
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID != "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10" || !strings.HasPrefix(sess.URL, "https://merch.securepaytb.ru/order/") || sess.ProviderAccount != testCustomer || !sess.Livemode {
		t.Fatalf("session %+v", sess)
	}
	c := b.calls[0]
	if c.auth != "Bearer test.token.value" {
		t.Fatalf("auth header %q", c.auth)
	}
	d := c.body["Data"].(map[string]any)
	want := map[string]any{
		"customerCode": testCustomer, "merchantId": testMerchant, "amount": 150.0, "paymentLinkId": "0199d4a2-7c1e-7a40-9b6e-5f3c2d1e0a01",
		"consumerId": "0199d4a2-0000-7000-8000-000000000001", "taxSystemCode": "usn_income", "purpose": DefaultLineItem,
	}
	for k, v := range want {
		if d[k] != v {
			t.Errorf("%s = %v, want %v", k, d[k], v)
		}
	}
	if m := d["paymentMode"].([]any); len(m) != 1 || m[0] != "sbp" {
		t.Errorf("paymentMode %v", m)
	}
	if ttl := d["ttl"].(float64); ttl < 33 || ttl > 35 {
		t.Errorf("ttl %v", ttl)
	}
	if _, has := d["preAuthorization"]; has {
		t.Error("preAuthorization sent")
	}
	if cl := d["Client"].(map[string]any); cl["email"] != "owner@calab.test" || cl["name"] != nil {
		t.Errorf("client %v (a private person is not named)", cl)
	}
	items := d["Items"].([]any)
	it := items[0].(map[string]any)
	if len(items) != 1 || it["amount"] != 150.0 || it["quantity"] != 1.0 || it["vatType"] != "none" || it["paymentMethod"] != "full_prepayment" || it["paymentObject"] != "service" {
		t.Errorf("items %v", items)
	}
	// The amount travels as an exact decimal, never through float formatting.
	r := checkoutReq(provider.MethodCard)
	r.Amount = money.New(50000033, money.RUB)
	if _, err := p.CreateCheckout(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if d := b.calls[1].body["Data"].(map[string]any); d["amount"] != 500000.33 || d["paymentMode"].([]any)[0] != "card" {
		t.Errorf("second body %v", d)
	}
}

func TestCreateCheckoutRefusesLocally(t *testing.T) {
	p, b := newTest(t, nil)
	for name, mut := range map[string]func(*provider.CheckoutReq){
		"usd":     func(r *provider.CheckoutReq) { r.Amount = money.New(500, money.USD) },
		"method":  func(r *provider.CheckoutReq) { r.Method = provider.MethodBankTransfer },
		"email":   func(r *provider.CheckoutReq) { r.ReceiptEmail = "" },
		"expired": func(r *provider.CheckoutReq) { r.ExpiresAt = time.Now().Add(30 * time.Second) },
		"no id":   func(r *provider.CheckoutReq) { r.Metadata.CheckoutID = uuid.Nil },
	} {
		r := checkoutReq(provider.MethodCard)
		mut(&r)
		if _, err := p.CreateCheckout(context.Background(), r); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(b.calls) != 0 {
		t.Fatalf("network calls: %d", len(b.calls))
	}
}

// A create whose answer was lost: the retry hits the duplicate paymentLinkId (424) and the
// adapter finds the existing link by listing.
func TestCreateCheckoutDuplicateFindsExisting(t *testing.T) {
	created := fixture(t, "live_get_created.json")
	var op map[string]any
	_ = json.Unmarshal([]byte(created), &op)
	o := op["Data"].(map[string]any)["Operation"].([]any)[0].(map[string]any)
	o["amount"], o["consumerId"] = 150.0, "0199d4a2-0000-7000-8000-000000000001"
	list, _ := json.Marshal(map[string]any{"Data": map[string]any{"Operation": []any{o}}, "Meta": map[string]any{"totalPages": 1}})
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){
		"POST /acquiring/v1.0/payments_with_receipt": reply(424, fixture(t, "live_create_duplicate_424.json")),
		"GET /acquiring/v1.0/payments":               reply(200, string(list)),
	})
	sess, err := p.CreateCheckout(context.Background(), checkoutReq(provider.MethodCard))
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID != "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10" || sess.URL == "" {
		t.Fatalf("session %+v", sess)
	}
	if q := b.calls[1].query; !strings.Contains(q, "customerCode="+testCustomer) || !strings.Contains(q, "fromDate=") || !strings.Contains(q, "toDate=") {
		t.Fatalf("list query %q", q)
	}
	// Same link id with another amount: never reuse it, the outcome stays unknown.
	r := checkoutReq(provider.MethodCard)
	r.Amount = money.New(20000, money.RUB)
	if _, err := p.CreateCheckout(context.Background(), r); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("other amount: %v", err)
	}
}

func TestErrorMapping(t *testing.T) {
	p, _ := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/missing": reply(424, fixture(t, "live_get_not_found_424.json")),
		"GET /acquiring/v1.0/payments/down":    reply(502, `bad gateway`),
		"GET /acquiring/v1.0/payments/denied":  reply(403, `{"code":"403","id":"r1","message":"Forbidden","Errors":[{"errorCode":"Forbidden","message":"token eyJhbGciOi.eyJzdWIiOi.c2ln at https://x.test/a","url":""}]}`),
		"GET /acquiring/v1.0/payments/garbled": reply(200, `{"Data":`),
		"POST /acquiring/v1.0/payments_with_receipt": func(http.ResponseWriter, call) {
			time.Sleep(300 * time.Millisecond)
		},
	})
	ctx := context.Background()
	if _, err := p.GetPayment(ctx, "missing"); !errors.Is(err, provider.ErrNotFound) {
		t.Errorf("424 not found: %v", err)
	}
	if _, err := p.GetPayment(ctx, "down"); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Errorf("502: %v", err)
	}
	_, err := p.GetPayment(ctx, "denied")
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 403 || errors.Is(err, provider.ErrUnknownOutcome) || strings.Contains(err.Error(), "eyJ") || strings.Contains(err.Error(), "https://") {
		t.Errorf("403: %v", err)
	}
	if _, err := p.GetPayment(ctx, "garbled"); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Errorf("garbled: %v", err)
	}
	if _, err := p.GetPayment(ctx, "a/b"); !errors.Is(err, ErrInvalidRequest) {
		t.Errorf("path injection: %v", err)
	}
	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := p.CreateCheckout(tctx, checkoutReq(provider.MethodCard)); !errors.Is(err, provider.ErrUnknownOutcome) || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("timeout: %v", err)
	}
}

func TestPaymentAndCheckoutFacts(t *testing.T) {
	approved := ours(fixture(t, "sandbox_get_approved.json"))
	approved = strings.Replace(approved, `"Order":[]`, `"Order":[],"consumerId":"0199d4a2-0000-7000-8000-000000000001","paymentLinkId":"0199d4a2-7c1e-7a40-9b6e-5f3c2d1e0a01","paidAt":"2022-10-18T11:30:00+03:00"`, 1)
	foreign := fixture(t, "sandbox_get_approved.json") // customer 1234567ab
	p, _ := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10": reply(200, fixture(t, "live_get_created.json")),
		"GET /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db": reply(200, approved),
	})
	ctx := context.Background()
	f, err := p.GetPayment(ctx, "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10")
	if err != nil || f.Status != provider.PaymentRequiresAction || f.AmountReceived.Minor != 0 || f.Amount != money.New(100, money.RUB) || f.CustomerID != "00000000-0000-4000-8000-000000000001" {
		t.Fatalf("created: %+v %v", f, err)
	}
	if f.Metadata.CheckoutID.String() != "0199d4a2-7c1e-7a40-9b6e-5f3c2d1e0a01" || f.Created.IsZero() {
		t.Fatalf("created metadata: %+v", f)
	}
	f, err = p.GetPayment(ctx, "b26287ee-bdd0-3482-a10d-3c462f5ba6db")
	if err != nil || f.Status != provider.PaymentSucceeded || f.AmountReceived != money.New(10000, money.RUB) || f.ChargeID != "12965545" ||
		f.Metadata.AccountID.String() != "0199d4a2-0000-7000-8000-000000000001" || !f.SucceededAt.Equal(time.Date(2022, 10, 18, 8, 30, 0, 0, time.UTC)) {
		t.Fatalf("approved: %+v %v", f, err)
	}
	cf, err := p.GetCheckout(ctx, "b26287ee-bdd0-3482-a10d-3c462f5ba6db")
	if err != nil || cf.Status != provider.CheckoutComplete || cf.PaymentID != "b26287ee-bdd0-3482-a10d-3c462f5ba6db" {
		t.Fatalf("checkout complete: %+v %v", cf, err)
	}
	cf, err = p.GetCheckout(ctx, "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10")
	if err != nil || cf.Status != provider.CheckoutOpen || cf.PaymentID != "" {
		t.Fatalf("checkout open: %+v %v", cf, err)
	}

	p2, _ := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10": reply(200, fixture(t, "live_get_expired.json")),
		"GET /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db": reply(200, foreign),
	})
	f, err = p2.GetPayment(ctx, "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10")
	if err != nil || f.Status != provider.PaymentCanceled {
		t.Fatalf("expired: %+v %v", f, err)
	}
	if cf, err := p2.GetCheckout(ctx, "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10"); err != nil || cf.Status != provider.CheckoutExpired {
		t.Fatalf("checkout expired: %+v %v", cf, err)
	}
	if _, err := p2.GetPayment(ctx, "b26287ee-bdd0-3482-a10d-3c462f5ba6db"); !errors.Is(err, provider.ErrNotFound) || !errors.Is(err, ErrForeign) {
		t.Fatalf("foreign customer: %v", err)
	}
}

func TestListPayments(t *testing.T) {
	list := ours(fixture(t, "sandbox_list.json"))
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){"GET /acquiring/v1.0/payments": reply(200, list)})
	facts, next, err := p.ListPayments(context.Background(), provider.ListReq{
		Customer: provider.CustomerRef{ID: "ab246f8a-b6b3-4d4a-86ee-8caaf6647c73"}, CreatedAfter: time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil || next != "" || len(facts) != 1 || facts[0].Status != provider.PaymentSucceeded || facts[0].AmountReceived.Minor != 20000 {
		t.Fatalf("%+v %q %v", facts, next, err)
	}
	if q := b.calls[0].query; !strings.Contains(q, "fromDate=2024-02-29") || !strings.Contains(q, "perPage=100") || !strings.Contains(q, "page=1") {
		t.Fatalf("query %q", q)
	}
	if _, _, err := p.ListPayments(context.Background(), provider.ListReq{}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("no customer accepted")
	}
}

func TestRefund(t *testing.T) {
	approved := ours(fixture(t, "sandbox_get_approved.json"))
	refunded := strings.Replace(strings.Replace(approved, `"status":"APPROVED"`, `"status":"REFUNDED_PARTIALLY"`, 1),
		`"Order":[]`, `"Order":[{"orderId":"20","type":"refund","amount":1.0,"time":"2025-04-08T10:00:00+03:00"},{"orderId":"1","type":"approval","amount":100.0,"time":"2022-10-18T08:30:00+00:00"}]`, 1)
	digital := strings.Replace(approved, `"paymentType":"card"`, `"paymentType":"digitalRuble"`, 1)
	var refundCalls int
	state := approved
	// The bank answers orderId 20; the payment then lists the refund (Order[]) or not yet.
	answer, afterPost := fixture(t, "sandbox_refund.json"), refunded
	var mu sync.Mutex
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db": func(w http.ResponseWriter, c call) {
			mu.Lock()
			defer mu.Unlock()
			reply(200, state)(w, c)
		},
		"POST /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db/refund": func(w http.ResponseWriter, c call) {
			refundCalls++
			if d := c.body["Data"].(map[string]any); d["amount"] != 1.0 {
				t.Errorf("refund amount %v", d["amount"])
			}
			mu.Lock()
			state = afterPost
			mu.Unlock()
			reply(200, answer)(w, c)
		},
	})
	ctx := context.Background()
	req := provider.RefundReq{IdemKey: "refund:x", PaymentID: "b26287ee-bdd0-3482-a10d-3c462f5ba6db", Amount: money.New(100, money.RUB)}
	f, err := p.Refund(ctx, req)
	if err != nil || f.ID != "b26287ee-bdd0-3482-a10d-3c462f5ba6db:20" || f.Status != provider.RefundPending || f.Amount.Minor != 100 {
		t.Fatalf("refund %+v %v", f, err)
	}
	// The answer's orderId is not (yet) in Order[], or another one is: no id, pending — the
	// reconciliation matches the listed refund by payment and amount (never a second POST).
	for name, ans := range map[string]string{
		"not listed yet": fixture(t, "sandbox_refund.json"),
		"other order id": strings.Replace(fixture(t, "sandbox_refund.json"), `"orderId":"20"`, `"orderId":"21"`, 1),
	} {
		mu.Lock()
		state, answer, afterPost = approved, ans, approved
		if name == "other order id" {
			afterPost = refunded
		}
		mu.Unlock()
		if u, err := p.Refund(ctx, req); err != nil || u.ID != "" || u.Status != provider.RefundPending || u.PaymentID != req.PaymentID {
			t.Fatalf("%s: %+v %v", name, u, err)
		}
	}
	// The payment turns REFUNDED_PARTIALLY with the refund in Order[]: succeeded.
	mu.Lock()
	state = refunded
	mu.Unlock()
	g, err := p.GetRefund(ctx, f.ID)
	if err != nil || g.Status != provider.RefundSucceeded || g.Amount.Minor != 100 || g.PaymentID != req.PaymentID {
		t.Fatalf("get refund %+v %v", g, err)
	}
	l, err := p.ListRefunds(ctx, req.PaymentID)
	if err != nil || len(l) != 1 || l[0].ID != f.ID {
		t.Fatalf("list refunds %+v %v", l, err)
	}
	if g, err := p.GetRefund(ctx, req.PaymentID+":99"); err != nil || g.Status != provider.RefundPending {
		t.Fatalf("unlisted refund %+v %v", g, err)
	}
	// Digital ruble: not through the API, nothing sent.
	mu.Lock()
	state = digital
	mu.Unlock()
	if _, err := p.Refund(ctx, req); !errors.Is(err, provider.ErrNotSupported) {
		t.Fatalf("digital ruble: %v", err)
	}
	if refundCalls != 3 || b.count("POST", "/acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db/refund") != 3 {
		t.Fatalf("refund POSTs %d", refundCalls)
	}
}

func TestRefundRefusedAndLost(t *testing.T) {
	approved := ours(fixture(t, "sandbox_get_approved.json"))
	p, _ := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db":         reply(200, approved),
		"POST /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db/refund": reply(200, `{"Data":{"isRefund":false,"operationId":"x","amount":1.0,"date":"2025-04-08","orderId":""}}`),
		"GET /acquiring/v1.0/payments/lost":                                         reply(200, strings.ReplaceAll(approved, "b26287ee-bdd0-3482-a10d-3c462f5ba6db", "lost")),
		"POST /acquiring/v1.0/payments/lost/refund":                                 reply(503, ``),
	})
	f, err := p.Refund(context.Background(), provider.RefundReq{PaymentID: "b26287ee-bdd0-3482-a10d-3c462f5ba6db", Amount: money.New(100, money.RUB)})
	if err != nil || f.Status != provider.RefundFailed {
		t.Fatalf("isRefund=false: %+v %v", f, err)
	}
	if _, err := p.Refund(context.Background(), provider.RefundReq{PaymentID: "lost", Amount: money.New(100, money.RUB)}); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("503: %v", err)
	}
}

func TestParseWebhook(t *testing.T) {
	p, _ := newTest(t, nil)
	ctx := context.Background()
	card := []byte(fixture(t, "webhook_card.jwt") + "\n")
	ev, err := p.ParseWebhook(ctx, nil, card)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Kind != provider.EventPaymentSucceeded || ev.ObjectID != "beeac8a4-6047-3f38-8922-a664e6b5c43b" || ev.PaymentID != ev.ObjectID ||
		ev.Provider != provider.Tochka || ev.ProviderAccount != testCustomer || !ev.Livemode || !strings.HasPrefix(ev.EventID, "tw_") {
		t.Fatalf("card: %+v", ev)
	}
	// A redelivery is the same event; another payment type of the same operation is another.
	again, _ := p.ParseWebhook(ctx, nil, card)
	sbp, err := p.ParseWebhook(ctx, nil, []byte(fixture(t, "webhook_sbp.jwt")))
	if err != nil || again.EventID != ev.EventID || sbp.EventID == ev.EventID || sbp.Kind != provider.EventPaymentSucceeded {
		t.Fatalf("dedup ids: %s %s %s %v", ev.EventID, again.EventID, sbp.EventID, err)
	}
	// Other webhook types: verified, ignored.
	if ev, err := p.ParseWebhook(ctx, nil, []byte(fixture(t, "webhook_incoming.jwt"))); err != nil || ev.Kind != provider.EventIgnored {
		t.Fatalf("incoming: %+v %v", ev, err)
	}
	// Tampered payload, garbage, a token signed by another key: bad signature.
	parts := strings.Split(strings.TrimSpace(string(card)), ".")
	flip := []byte(parts[1])
	if flip[20] == 'A' {
		flip[20] = 'B'
	} else {
		flip[20] = 'A'
	}
	tampered := parts[0] + "." + string(flip) + "." + parts[2]
	// Algorithm confusion: the same claims as HS256 with the public key's JWK text as the HMAC
	// secret, and as "none".
	hs, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"webhookType": WebhookTypeAcquiring, "customerCode": testCustomer, "operationId": "x", "status": "APPROVED", "amount": "1.00",
	}).SignedString([]byte(DefaultWebhookKey))
	if err != nil {
		t.Fatal(err)
	}
	none, err := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{"webhookType": WebhookTypeAcquiring, "customerCode": testCustomer}).
		SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"tampered": tampered, "garbage": "hello", "empty": "", "alg none": parts[0] + "." + parts[1] + ".",
		"HS256 with the public key": hs, "none": none} {
		if _, err := p.ParseWebhook(ctx, nil, []byte(body)); !errors.Is(err, provider.ErrBadSignature) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// The same signed webhook for another customer code (the bank's test webhooks at
	// registration): verified and ignored, so the URL answers 200.
	other, err := New(Config{BaseURL: "https://x.test", Token: "t", CustomerCode: "999999999", MerchantID: testMerchant})
	if err != nil {
		t.Fatal(err)
	}
	if ev, err := other.ParseWebhook(ctx, nil, card); err != nil || ev.Kind != provider.EventIgnored {
		t.Fatalf("other customer: %+v %v", ev, err)
	}
}

// webhook_live_test_send.jwt is what the bank really sent on registering a webhook URL on
// 2026-10-10 (its documentation's sample payload, signed by the production key): the pinned key
// verifies it.
func TestParseWebhookLiveTestSend(t *testing.T) {
	p, _ := newTest(t, nil)
	p.webhookKey, _ = ParseKeys(DefaultWebhookKey)
	ev, err := p.ParseWebhook(context.Background(), nil, []byte(fixture(t, "webhook_live_test_send.jwt")))
	if err != nil || ev.ObjectID != "beeac8a4-6047-3f38-8922-a664e6b5c43b" {
		t.Fatalf("%+v %v", ev, err)
	}
}

func TestParseKeys(t *testing.T) {
	one, err := ParseKeys(DefaultWebhookKey)
	if err != nil || len(one) != 1 {
		t.Fatal(one, err)
	}
	two, err := ParseKeys("[" + DefaultWebhookKey + "," + DefaultWebhookKey + "]")
	if err != nil || len(two) != 2 {
		t.Fatal(two, err)
	}
	set, err := ParseKeys(`{"keys":[` + DefaultWebhookKey + `]}`)
	if err != nil || len(set) != 1 {
		t.Fatal(set, err)
	}
	for _, bad := range []string{"", "[]", "{", `{"kty":"RSA","e":"AQAB","n":"AQAB"}`} {
		if _, err := ParseKeys(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestWebhookAdmin(t *testing.T) {
	var got []call
	p, _ := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /webhook/v1.0/client-1": reply(404, `{"code":"404","id":"x","message":"Что-то пошло не так","Errors":[{"errorCode":"Something going wrong","message":"Object of Webhooks does not exists","url":""}]}`),
		"PUT /webhook/v1.0/client-1": func(w http.ResponseWriter, c call) {
			got = append(got, c)
			reply(200, `{"Data":{"webhooksList":["acquiringInternetPayment"],"url":"https://app.calab.test/api/billing/tochka/webhook"}}`)(w, c)
		},
		"DELETE /webhook/v1.0/client-1":         reply(200, `{"Data":{"result":true}}`),
		"POST /webhook/v1.0/client-1/test_send": reply(200, `{"Data":{"result":true}}`),
	})
	ctx := context.Background()
	if _, err := p.GetWebhook(ctx); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("get: %v", err)
	}
	w, err := p.SetWebhook(ctx, "https://app.calab.test/api/billing/tochka/webhook")
	if err != nil || w.URL == "" || len(got) != 1 || got[0].body["url"] != "https://app.calab.test/api/billing/tochka/webhook" {
		t.Fatalf("set: %+v %v %v", w, err, got)
	}
	if _, err := p.SetWebhook(ctx, "http://app.calab.test/x"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("http accepted: %v", err)
	}
	if _, err := p.SetWebhook(ctx, "https://app.calab.test:8443/x"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("port accepted: %v", err)
	}
	if err := p.TestWebhook(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.DeleteWebhook(ctx); err != nil {
		t.Fatal(err)
	}
}
