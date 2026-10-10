package tochka

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Fixtures live_retailers / live_customers / live_retailers_forbidden_403 are answers of the
// production API recorded on 2026-10-10 (identifiers and names replaced): the retail points of
// the company, the customers the token sees (the company and the owner's personal account), and
// the retailers of the personal account — refused by consent.

const personalCustomer = "300999999"

func newVerifyTest(t *testing.T, customer, merchant string, routes map[string]func(http.ResponseWriter, call)) (*Provider, *bank) {
	t.Helper()
	b := &bank{routes: routes}
	srv := httptest.NewServer(b)
	t.Cleanup(srv.Close)
	p, err := New(Config{BaseURL: srv.URL, Token: "test.token.value", CustomerCode: customer, MerchantID: merchant, ClientID: "client-1", HTTPClient: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return p, b
}

func TestVerifyConfigOK(t *testing.T) {
	p, b := newVerifyTest(t, testCustomer, testMerchant, map[string]func(http.ResponseWriter, call){
		"GET /open-banking/v1.0/customers": reply(200, fixture(t, "live_customers.json")),
		"GET /acquiring/v1.0/retailers":    reply(200, fixture(t, "live_retailers.json")),
	})
	v, err := p.VerifyConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v.Retailer.TerminalID != "20001234" || !v.Retailer.IsActive || len(v.Warnings) != 0 || len(v.Customers) != 2 {
		t.Fatalf("verification %+v", v)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range b.calls {
		if c.method != http.MethodGet {
			t.Fatalf("not read-only: %s %s", c.method, c.path)
		}
		if c.path == "/acquiring/v1.0/retailers" && c.query != "customerCode="+testCustomer {
			t.Fatalf("retailers query %q", c.query)
		}
	}
}

func TestVerifyConfigConsentRefused(t *testing.T) {
	// The incident of 2026-10-10: TOCHKA_CUSTOMER_CODE named the personal account.
	p, _ := newVerifyTest(t, personalCustomer, testMerchant, map[string]func(http.ResponseWriter, call){
		"GET /open-banking/v1.0/customers": reply(200, fixture(t, "live_customers.json")),
		"GET /acquiring/v1.0/retailers":    reply(403, fixture(t, "live_retailers_forbidden_403.json")),
	})
	_, err := p.VerifyConfig(context.Background())
	if !errors.Is(err, ErrMisconfigured) {
		t.Fatalf("err %v", err)
	}
	for _, want := range []string{"consent", personalCustomer, "business customers of the token: " + testCustomer} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("%q lacks %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "test.token.value") {
		t.Fatal("token in the error")
	}
}

func TestVerifyConfigForeignMerchant(t *testing.T) {
	p, _ := newVerifyTest(t, testCustomer, "200000000009999", map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/retailers": reply(200, fixture(t, "live_retailers.json")), // customers: 404, only a hint
	})
	_, err := p.VerifyConfig(context.Background())
	if !errors.Is(err, ErrMisconfigured) || !strings.Contains(err.Error(), "200000000009999 is not a retail point") || !strings.Contains(err.Error(), testMerchant) {
		t.Fatalf("err %v", err)
	}
}

func TestVerifyConfigWarnings(t *testing.T) {
	inactive := strings.Replace(fixture(t, "live_retailers.json"), `"isActive":true`, `"isActive":false`, 1)
	inactive = strings.Replace(inactive, `"merchantId":"200000000001234"`, `"merchantId":"200000000005678"`, 1)
	p, _ := newVerifyTest(t, personalCustomer, "200000000005678", map[string]func(http.ResponseWriter, call){
		"GET /open-banking/v1.0/customers": reply(200, fixture(t, "live_customers.json")),
		"GET /acquiring/v1.0/retailers":    reply(200, inactive),
	})
	v, err := p.VerifyConfig(context.Background())
	if err != nil || len(v.Warnings) != 2 || !strings.Contains(v.Warnings[0], "not active") || !strings.Contains(v.Warnings[1], "Personal") {
		t.Fatalf("%+v %v", v, err)
	}
}

func TestVerifyConfigUnknown(t *testing.T) {
	p, _ := newVerifyTest(t, testCustomer, testMerchant, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/retailers": reply(502, ``),
	})
	_, err := p.VerifyConfig(context.Background())
	if !errors.Is(err, provider.ErrUnknownOutcome) || errors.Is(err, ErrMisconfigured) {
		t.Fatalf("err %v", err)
	}
}

// syncBuf is a goroutine-safe log sink.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func captureLogs(t *testing.T) *syncBuf {
	t.Helper()
	buf := &syncBuf{}
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return buf
}

func TestLogConfig(t *testing.T) {
	t.Run("mismatch is an ERROR, no crash", func(t *testing.T) {
		logs := captureLogs(t)
		p, _ := newVerifyTest(t, personalCustomer, testMerchant, map[string]func(http.ResponseWriter, call){
			"GET /acquiring/v1.0/retailers": reply(403, fixture(t, "live_retailers_forbidden_403.json")),
		})
		p.LogConfig(context.Background(), time.Millisecond)
		out := logs.String()
		if !strings.Contains(out, "customer_code="+personalCustomer) || !strings.Contains(out, "merchant_id="+testMerchant) ||
			!strings.Contains(out, "level=ERROR") || strings.Contains(out, "test.token.value") {
			t.Fatalf("logs:\n%s", out)
		}
	})
	t.Run("retried until the bank answers", func(t *testing.T) {
		logs := captureLogs(t)
		var mu sync.Mutex
		n := 0
		p, _ := newVerifyTest(t, testCustomer, testMerchant, map[string]func(http.ResponseWriter, call){
			"GET /acquiring/v1.0/retailers": func(w http.ResponseWriter, c call) {
				mu.Lock()
				n++
				first := n == 1
				mu.Unlock()
				if first {
					reply(503, ``)(w, c)
					return
				}
				reply(200, fixture(t, "live_retailers.json"))(w, c)
			},
		})
		p.LogConfig(context.Background(), time.Millisecond)
		out := logs.String()
		if !strings.Contains(out, "not verified yet") || !strings.Contains(out, "acquiring config verified") || strings.Contains(out, "level=ERROR") {
			t.Fatalf("logs:\n%s", out)
		}
	})
}
