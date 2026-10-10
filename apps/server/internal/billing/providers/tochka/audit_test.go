package tochka

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Audit M6: only a connection that was never obtained is «not sent» (wrapped with
// ErrUnknownOutcome too). A 429 (the bank documents none, so it may come after processing), a
// 5xx, a connection lost after the request was written and a deadline while the bank holds a
// fully sent request (HTTP/1 and HTTP/2) all stay a plain unknown outcome.
func TestNotSentClassification(t *testing.T) {
	ctx := context.Background()
	req := provider.OffSessionReq{IdemKey: "a1", Customer: customer(), PaymentMethodID: subID, Amount: money.New(15000, money.RUB)}
	status := 429
	p, _ := newRecurring(t, map[string]func(http.ResponseWriter, call){
		"POST " + chargePath: func(w http.ResponseWriter, c call) {
			reply(status, `{"code":"429","id":"x","message":"Too Many Requests","Errors":[]}`)(w, c)
		},
	})
	_, err := p.ChargeOffSession(ctx, req)
	if errors.Is(err, provider.ErrNotSent) || !errors.Is(err, provider.ErrUnknownOutcome) || !errors.Is(err, provider.ErrRateLimited) || strings.Contains(err.Error(), subID) {
		t.Fatalf("429: %v", err)
	}
	status = 503
	if _, err := p.ChargeOffSession(ctx, req); !errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, provider.ErrNotSent) {
		t.Fatalf("503: %v", err)
	}

	// Nobody listens: the request never left.
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + ln.Addr().String()
	_ = ln.Close()
	pd, err := New(Config{BaseURL: dead, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant, ClientID: "client-1", Recurring: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pd.ChargeOffSession(ctx, req); !errors.Is(err, provider.ErrNotSent) || !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("refused connection: %v", err)
	}

	// The bank read the whole request and dropped the connection: it may have charged.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		_, _ = r.Body.Read(buf)
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("no hijacker")
			return
		}
		c, _, err := hj.Hijack()
		if err == nil {
			_ = c.Close()
		}
	}))
	t.Cleanup(srv.Close)
	pl, err := New(Config{BaseURL: srv.URL, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant, ClientID: "client-1", HTTPClient: srv.Client(), Recurring: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pl.ChargeOffSession(ctx, req); !errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, provider.ErrNotSent) {
		t.Fatalf("dropped after the request: %v", err)
	}

	// The bank read the whole request and holds it past the deadline: it may be charging.
	for _, h2 := range []bool{false, true} {
		got := make(chan struct{}, 1)
		release := make(chan struct{})
		hs := httptest.NewUnstartedServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			_, _ = io.ReadAll(r.Body)
			got <- struct{}{}
			<-release
		}))
		hs.EnableHTTP2 = h2
		hs.StartTLS()
		ph, err := New(Config{BaseURL: hs.URL, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant, ClientID: "client-1", HTTPClient: hs.Client(), Recurring: true})
		if err != nil {
			t.Fatal(err)
		}
		cctx, cancel := context.WithCancel(ctx)
		go func() { <-got; cancel() }()
		_, err = ph.ChargeOffSession(cctx, req)
		cancel()
		close(release)
		hs.Close()
		if !errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, provider.ErrNotSent) {
			t.Fatalf("held after the request (h2 %t): %v", h2, err)
		}
	}

	// A TLS handshake that fails never carried the request.
	bad := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(bad.Close)
	pt, err := New(Config{BaseURL: bad.URL, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant, ClientID: "client-1", Recurring: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pt.ChargeOffSession(ctx, req); !errors.Is(err, provider.ErrNotSent) || !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("untrusted certificate: %v", err)
	}
}

// Audit M7: the receipt's «признак способа расчёта» comes from TOCHKA_RECEIPT_PAYMENT_METHOD,
// limited to what the bank's API accepts.
func TestReceiptPaymentMethod(t *testing.T) {
	for _, v := range []string{"advance", "prepayment", "FULL_PAYMENT"} {
		if _, err := New(Config{Token: "t", CustomerCode: testCustomer, MerchantID: testMerchant, ReceiptPaymentMethod: v}); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", v, err)
		}
	}
	b := &bank{routes: map[string]func(http.ResponseWriter, call){
		"POST /acquiring/v1.0/payments_with_receipt": reply(200, fixture(t, "live_create_with_receipt.json")),
	}}
	srv := httptest.NewServer(b)
	t.Cleanup(srv.Close)
	p, err := New(Config{BaseURL: srv.URL, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant,
		ClientID: "client-1", HTTPClient: srv.Client(), ReceiptPaymentMethod: "full_payment"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CreateCheckout(context.Background(), checkoutReq(provider.MethodCard)); err != nil {
		t.Fatal(err)
	}
	it := b.calls[0].body["Data"].(map[string]any)["Items"].([]any)[0].(map[string]any)
	if it["paymentMethod"] != "full_payment" || it["paymentObject"] != "service" {
		t.Fatalf("item %v", it)
	}
}

// Audit m8: a JSON float with binary noise past the kopecks is read as the kopecks; anything
// that is not a kopeck amount is still refused.
func TestDenoise(t *testing.T) {
	for in, want := range map[string]int64{"150.29999999999998": 15030, "1.5e2": 15000, "0.30000000000000004": 30, "2": 200} {
		m, err := decimal(in).money()
		if err != nil || m.Minor != want {
			t.Errorf("%s: %v %v, want %d", in, m, err, want)
		}
	}
	for _, in := range []string{"0.333", "abc", "NaN", "1e300"} {
		if _, err := decimal(in).money(); err == nil {
			t.Errorf("%s accepted", in)
		}
	}
}

// Audit m1: the refund answer's amount may be the payment's (as documented).
func TestRefundAnswerPaymentAmount(t *testing.T) {
	approved := ours(fixture(t, "sandbox_get_approved.json"))
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db": reply(200, approved),
		"POST /acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db/refund": reply(200,
			strings.Replace(fixture(t, "sandbox_refund.json"), `"amount":1.0`, `"amount":100.0`, 1)),
	})
	ctx := context.Background()
	req := provider.RefundReq{PaymentID: "b26287ee-bdd0-3482-a10d-3c462f5ba6db", Amount: money.New(100, money.RUB)}
	if f, err := p.Refund(ctx, req); err != nil || f.Status != provider.RefundPending {
		t.Fatalf("payment amount in the answer: %+v %v", f, err)
	}
	if n := b.count("POST", "/acquiring/v1.0/payments/b26287ee-bdd0-3482-a10d-3c462f5ba6db/refund"); n != 1 {
		t.Fatalf("refund POSTs %d", n)
	}
}

// Audit m4: the binding payment is the approval of the operation's amount at paidAt, not
// whichever approval the bank lists (or dates) first.
func TestListChargesSkipsTheBindingByPaidAt(t *testing.T) {
	body := strings.Replace(fixture(t, "subscription_paid.json"), `"time":"2026-10-11T09:00:00+05:00"`, `"time":"2026-10-10T08:00:00+00:00"`, 1)
	p, _ := newRecurring(t, map[string]func(http.ResponseWriter, call){"GET " + subPath: reply(200, body)})
	charges, err := p.ListCharges(context.Background(), customer(), subID)
	if err != nil || len(charges) != 1 || charges[0].ID != subID+":charge:9002" {
		t.Fatalf("charges %+v %v", charges, err)
	}
}
