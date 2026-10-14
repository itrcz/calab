package tochka

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// ScanRefunds: one list call per merchant (all pages, perPage 1000) returns every operation's
// refund lines — a subscription's unattributed, a payment link's as its own; listed = executed;
// an unreadable amount skips its operation only; 429 is rate limited.
func TestScanRefunds(t *testing.T) {
	var answer map[string]any
	if err := json.Unmarshal([]byte(fixture(t, "subscription_paid.json")), &answer); err != nil {
		t.Fatal(err)
	}
	ops := answer["Data"].(map[string]any)["Operation"].([]any)
	sub := ops[0].(map[string]any)
	link := map[string]any{}
	for k, v := range sub {
		link[k] = v
	}
	delete(link, "CofToken")
	link["operationId"], link["status"] = "link-1", "ON-REFUND"
	link["Order"] = []any{map[string]any{"orderId": "77", "type": "refund", "amount": 5.0, "time": "2026-10-11T10:00:00+03:00"}}
	bad := map[string]any{}
	for k, v := range link {
		bad[k] = v
	}
	bad["operationId"] = "bad-1"
	bad["Order"] = []any{map[string]any{"orderId": "78", "type": "refund", "amount": "1e400", "time": "2026-10-11T10:00:00+03:00"}}
	answer["Data"].(map[string]any)["Operation"] = []any{sub, link, bad}
	body, _ := json.Marshal(answer)
	p, b := newTest(t, map[string]func(http.ResponseWriter, call){"GET /acquiring/v1.0/payments": reply(200, string(body))})
	got, err := p.ScanRefunds(context.Background(), time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("operations %+v", got)
	}
	s, l := got[0], got[1]
	if !s.Subscription || s.PaymentID != "4d401374-410d-42b2-8820-e28783ec9d7f" || len(s.Refunds) != 1 || s.Refunds[0].ID != "4d401374-410d-42b2-8820-e28783ec9d7f:9003" ||
		s.Refunds[0].Amount.Minor != 100 || s.Refunds[0].Status != provider.RefundSucceeded {
		t.Fatalf("subscription %+v", s)
	}
	if l.Subscription || l.PaymentID != "link-1" || len(l.Refunds) != 1 || l.Refunds[0].ID != "link-1:77" || l.Refunds[0].Status != provider.RefundSucceeded {
		t.Fatalf("link %+v", l)
	}
	if n := b.count("GET", "/acquiring/v1.0/payments"); n != 1 || !strings.Contains(b.calls[0].query, "perPage=1000") || !strings.Contains(b.calls[0].query, "customerCode="+testCustomer) {
		t.Fatalf("calls %d %+v", n, b.calls)
	}
	if !p.RefundsByHand("op:charge:9", false) || !p.RefundsByHand("op", true) || p.RefundsByHand("op", false) {
		t.Fatal("RefundsByHand")
	}

	limited, _ := newTest(t, map[string]func(http.ResponseWriter, call){"GET /acquiring/v1.0/payments": reply(429, `{"code":"429","id":"x","message":"too many"}`)})
	if _, err := limited.ScanRefunds(context.Background(), time.Now()); !errors.Is(err, provider.ErrRateLimited) || !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("429: %v", err)
	}
}

// The binding payment of a saved card lists the refunds of every charge: never attributed to it
// (audit M4).
func TestListRefundsOfSubscriptionIsEmpty(t *testing.T) {
	p, _ := newTest(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/payments/4d401374-410d-42b2-8820-e28783ec9d7f": reply(200, fixture(t, "subscription_paid.json")),
	})
	facts, err := p.ListRefunds(context.Background(), "4d401374-410d-42b2-8820-e28783ec9d7f")
	if err != nil || len(facts) != 0 {
		t.Fatalf("%+v %v", facts, err)
	}
}
