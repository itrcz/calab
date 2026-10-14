package tochka

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
)

const (
	subID      = "4d401374-410d-42b2-8820-e28783ec9d7f"
	subPath    = "/acquiring/v1.0/payments/" + subID
	chargePath = "/acquiring/v1.0/subscriptions/" + subID + "/charge"
	consumerID = "0199d4a2-0000-7000-8000-000000000001"
)

func newRecurring(t *testing.T, routes map[string]func(http.ResponseWriter, call)) (*Provider, *bank) {
	t.Helper()
	b := &bank{routes: routes}
	srv := httptest.NewServer(b)
	t.Cleanup(srv.Close)
	p, err := New(Config{BaseURL: srv.URL, Token: "test.token.value", CustomerCode: testCustomer, MerchantID: testMerchant,
		ClientID: "client-1", HTTPClient: srv.Client(), Recurring: true})
	if err != nil {
		t.Fatal(err)
	}
	return p, b
}

func customer() provider.CustomerRef {
	return provider.CustomerRef{Provider: provider.Tochka, ProviderAccount: testCustomer, Livemode: true, ID: consumerID}
}

func TestRecurringCapsAndRegistry(t *testing.T) {
	plain, _ := newTest(t, nil)
	if plain.Caps().Has(provider.CapOffSession) || plain.Caps().Has(provider.CapSaveMethod) {
		t.Fatal("phase-1 adapter offers saved cards")
	}
	p, _ := newRecurring(t, nil)
	if !p.Caps().Has(RecurringCaps|provider.CapReconcilableCharge) || p.Caps().SafeRetry() {
		t.Fatalf("caps %b", p.Caps())
	}
	r, err := provider.NewRegistry("tochka:ru", provider.DefaultMatrix(), p)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.OffSession(provider.Tochka); !ok {
		t.Fatal("not an off-session charger")
	}
	if got := r.Methods(provider.MarketRU, money.RUB, "", ""); !got[0].AutoTopupCapable || got[1].AutoTopupCapable {
		t.Fatalf("%+v", got)
	}
}

// A card top-up with «save» opens a subscription without a schedule, with the receipt and
// without saveCard / Options / ttl / paymentMode; SBP or the phase-1 adapter refuse locally.
func TestCreateSubscriptionShape(t *testing.T) {
	p, b := newRecurring(t, map[string]func(http.ResponseWriter, call){
		"POST /acquiring/v1.0/subscriptions_with_receipt": reply(200, fixture(t, "live_create_subscription.json")),
	})
	req := checkoutReq(provider.MethodCard)
	req.SaveForOffSession = true
	sess, err := p.CreateCheckout(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID != subID || !strings.HasPrefix(sess.URL, "https://merch.securepaytb.ru/") {
		t.Fatalf("%+v", sess)
	}
	d := b.calls[0].body["Data"].(map[string]any)
	if d["recurring"] != true || d["paymentLinkId"] != req.Metadata.CheckoutID.String() || d["consumerId"] != consumerID || d["amount"] != 150.0 {
		t.Fatalf("body %v", d)
	}
	for _, k := range []string{"saveCard", "Options", "ttl", "paymentMode", "preAuthorization"} {
		if _, has := d[k]; has {
			t.Errorf("%s sent", k)
		}
	}
	if it := d["Items"].([]any)[0].(map[string]any); it["paymentMethod"] != "full_prepayment" || d["Client"].(map[string]any)["email"] != "owner@calab.test" {
		t.Errorf("receipt %v", d)
	}
	sbp := checkoutReq(provider.MethodSBP)
	sbp.SaveForOffSession = true
	if _, err := p.CreateCheckout(context.Background(), sbp); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("sbp save: %v", err)
	}
	plain, pb := newTest(t, nil)
	if _, err := plain.CreateCheckout(context.Background(), req); !errors.Is(err, ErrInvalidRequest) || len(pb.calls) != 0 {
		t.Fatalf("phase 1 save: %v", err)
	}
}

// The binding payment is the operation itself (method id = the subscription); later charges are
// the approvals after the first one; refunds of subscription payments are not sent.
func TestSubscriptionFacts(t *testing.T) {
	p, b := newRecurring(t, map[string]func(http.ResponseWriter, call){
		"GET " + subPath: reply(200, fixture(t, "subscription_paid.json")),
	})
	ctx := context.Background()
	f, err := p.GetPayment(ctx, subID)
	if err != nil {
		t.Fatal(err)
	}
	if f.Status != provider.PaymentSucceeded || f.PaymentMethodID != subID || f.AmountReceived != money.New(200, money.RUB) {
		t.Fatalf("binding %+v", f)
	}
	charges, err := p.ListCharges(ctx, customer(), subID)
	if err != nil {
		t.Fatal(err)
	}
	if len(charges) != 1 || charges[0].ID != subID+":charge:9002" || charges[0].Amount != money.New(35050, money.RUB) ||
		charges[0].Status != provider.PaymentSucceeded || charges[0].CustomerID != consumerID || charges[0].SucceededAt.IsZero() {
		t.Fatalf("charges %+v", charges)
	}
	got, err := p.GetPayment(ctx, charges[0].ID)
	if err != nil || got.ID != charges[0].ID || got.AmountReceived != charges[0].Amount {
		t.Fatalf("get charge %+v %v", got, err)
	}
	if _, err := p.GetPayment(ctx, subID+":charge:nope"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("unknown charge: %v", err)
	}
	other := customer()
	other.ID = "someone-else"
	if _, err := p.ListCharges(ctx, other, subID); !errors.Is(err, provider.ErrNotFound) || strings.Contains(err.Error(), subID) {
		t.Fatalf("foreign consumer: %v", err)
	}
	for _, id := range []string{subID, charges[0].ID} {
		if _, err := p.Refund(ctx, provider.RefundReq{PaymentID: id, Amount: money.New(100, money.RUB)}); !errors.Is(err, provider.ErrNotSupported) {
			t.Fatalf("refund %s: %v", id, err)
		}
	}
	if rs, err := p.ListRefunds(ctx, charges[0].ID); err != nil || len(rs) != 0 {
		t.Fatalf("charge refunds %v %v", rs, err)
	}
	if b.count("POST", subPath+"/refund") != 0 {
		t.Fatal("refund sent")
	}
}

func TestListMethods(t *testing.T) {
	paid := strings.Replace(strings.Replace(fixture(t, "subscription_paid.json"), `"Operation"`, `"Subscription"`, 1), `"status":"APPROVED"`, `"status":"APPROVED","recurring":true`, 1)
	p, b := newRecurring(t, map[string]func(http.ResponseWriter, call){
		"GET /acquiring/v1.0/subscriptions": reply(200, paid),
	})
	ms, err := p.ListMethods(context.Background(), customer())
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 1 || ms[0].ID != subID || ms[0].Brand != "mir" || ms[0].Last4 != "0792" || ms[0].Kind != provider.MethodCard {
		t.Fatalf("%+v", ms)
	}
	if q := b.calls[0].query; !strings.Contains(q, "recurring=true") || !strings.Contains(q, "customerCode="+testCustomer) {
		t.Fatalf("query %s", q)
	}
	other := customer()
	other.ID = "someone-else"
	if ms, _ := p.ListMethods(context.Background(), other); len(ms) != 0 {
		t.Fatalf("foreign %+v", ms)
	}
}

func TestChargeOffSession(t *testing.T) {
	answer := `{"Data":{"result":true}}`
	status := 200
	p, b := newRecurring(t, map[string]func(http.ResponseWriter, call){
		"POST " + chargePath: func(w http.ResponseWriter, c call) { reply(status, answer)(w, c) },
	})
	ctx := context.Background()
	req := provider.OffSessionReq{IdemKey: "a1", Customer: customer(), PaymentMethodID: subID, Amount: money.New(500000, money.RUB)}
	f, err := p.ChargeOffSession(ctx, req)
	if err != nil || f.Status != provider.PaymentProcessing || f.ID != "" {
		t.Fatalf("accepted: %+v %v", f, err)
	}
	if d := b.calls[0].body["Data"].(map[string]any); d["amount"] != 5000.0 || len(d) != 1 {
		t.Fatalf("body %v", d)
	}
	answer = `{"Data":{"result":false}}`
	if f, err := p.ChargeOffSession(ctx, req); err != nil || f.Status != provider.PaymentFailed || f.FailureCode != "declined" {
		t.Fatalf("declined: %+v %v", f, err)
	}
	status, answer = 500, `{"code":"500","id":"x","message":"boom","Errors":[]}`
	if _, err := p.ChargeOffSession(ctx, req); !errors.Is(err, provider.ErrUnknownOutcome) || strings.Contains(err.Error(), subID) {
		t.Fatalf("5xx (no subscription id in the text): %v", err)
	}
	status, answer = 400, `{"code":"400","id":"x","message":"bad","Errors":[{"errorCode":"Validation Error","message":"bad"}]}`
	var ae *APIError
	if _, err := p.ChargeOffSession(ctx, req); !errors.As(err, &ae) || errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("4xx: %v", err)
	}
	if n := b.count("POST", chargePath); n != 4 {
		t.Fatalf("calls %d (never retried by the adapter)", n)
	}
	bad := req
	bad.Amount = money.New(100, money.USD)
	if _, err := p.ChargeOffSession(ctx, bad); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("usd: %v", err)
	}
}

// The bank refuses status changes of subscriptions without a schedule (live 424): detaching is
// local, not an error; a lost answer is returned.
func TestDetachMethod(t *testing.T) {
	status, body := 424, fixture(t, "live_subscription_status_424.json")
	p, b := newRecurring(t, map[string]func(http.ResponseWriter, call){
		"POST /acquiring/v1.0/subscriptions/" + subID + "/status": func(w http.ResponseWriter, c call) { reply(status, body)(w, c) },
	})
	if err := p.DetachMethod(context.Background(), subID); err != nil {
		t.Fatal(err)
	}
	if d := b.calls[0].body["Data"].(map[string]any); d["status"] != "Cancelled" {
		t.Fatalf("body %v", d)
	}
	status = 502
	if err := p.DetachMethod(context.Background(), subID); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("lost: %v", err)
	}
	if _, err := p.CancelPayment(context.Background(), "x"); !errors.Is(err, provider.ErrNotSupported) {
		t.Fatal(err)
	}
}
