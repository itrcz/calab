package fake_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
)

var ctx = context.Background()

func setup(t *testing.T, o fake.Options) (*fake.Provider, provider.CustomerRef) {
	t.Helper()
	at := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	if o.Now == nil {
		o.Now = func() time.Time { return at }
	}
	p := fake.New(o)
	acc := uuid.New()
	c, err := p.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + acc.String(), AccountID: acc})
	if err != nil {
		t.Fatal(err)
	}
	again, err := p.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + acc.String(), AccountID: acc})
	if err != nil || again != c {
		t.Fatalf("customer not idempotent: %v %v", again, err)
	}
	return p, c
}

func TestCheckoutSuccessAndWebhooks(t *testing.T) {
	p, c := setup(t, fake.Options{})
	meta := provider.Metadata{AccountID: uuid.New(), CheckoutID: uuid.New(), Kind: provider.MetadataKindCheckout}
	req := provider.CheckoutReq{IdemKey: "checkout:" + meta.CheckoutID.String(), Amount: money.New(1000, money.USD),
		Method: provider.MethodCard, Customer: c, SaveForOffSession: true, Metadata: meta}
	s, err := p.CreateCheckout(ctx, req)
	if err != nil || s.URL == "" {
		t.Fatal(s, err)
	}
	if again, _ := p.CreateCheckout(ctx, req); again.ID != s.ID {
		t.Fatal("checkout not idempotent")
	}
	req.Amount = money.New(2000, money.USD)
	if _, err := p.CreateCheckout(ctx, req); !errors.Is(err, fake.ErrIdempotencyMismatch) || !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatalf("reused key with another amount: %v", err)
	}
	pay, err := p.CompleteCheckout(s.ID, fake.Succeed)
	if err != nil || pay.Status != provider.PaymentSucceeded || pay.AmountReceived.Minor != 1000 || pay.ReceiptURL == "" {
		t.Fatal(pay, err)
	}
	f, err := p.GetCheckout(ctx, s.ID)
	if err != nil || f.Status != provider.CheckoutComplete || f.PaymentID != pay.ID || f.Metadata != meta {
		t.Fatal(f, err)
	}
	hooks := p.TakeWebhooks()
	kinds := map[provider.EventKind]int{}
	for _, w := range hooks {
		ev, err := p.ParseWebhook(ctx, w.Header, w.Body)
		if err != nil {
			t.Fatal(err)
		}
		if ev.EventID != w.Event.EventID || ev.Metadata != w.Event.Metadata {
			t.Fatalf("round trip: %+v vs %+v", ev, w.Event)
		}
		kinds[ev.Kind]++
	}
	if kinds[provider.EventPaymentSucceeded] != 1 || kinds[provider.EventCheckoutCompleted] != 1 || kinds[provider.EventMethodSaved] != 1 {
		t.Fatalf("events %v", kinds)
	}
	// A tampered body fails the signature.
	w := hooks[0]
	bad := append([]byte{}, w.Body...)
	bad[len(bad)-2] ^= 1
	if _, err := p.ParseWebhook(ctx, w.Header, bad); !errors.Is(err, provider.ErrBadSignature) {
		t.Fatalf("tampered: %v", err)
	}
	if methods, _ := p.ListMethods(ctx, c); len(methods) != 1 {
		t.Fatalf("saved methods %v", methods)
	}
}

func TestOffSessionOutcomes(t *testing.T) {
	p, c := setup(t, fake.Options{})
	pm := p.AddMethod(c.ID)
	charge := func(key string) (provider.PaymentFact, error) {
		return p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: key, Customer: c, PaymentMethodID: pm.ID,
			Amount: money.New(3200, money.USD), Metadata: provider.Metadata{Kind: provider.MetadataKindAutoTopup}})
	}
	p.Queue(fake.OpCharge, fake.Unknown, fake.Timeout, fake.Decline, fake.RequiresAction)

	// Unknown: nothing charged; the retry with the same key gets the next outcome (Timeout).
	if _, err := charge("a1"); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatal(err)
	}
	if len(p.Payments()) != 0 {
		t.Fatal("unknown created a payment")
	}
	// Timeout: charged, answer lost; the retry with the same key returns that payment.
	if _, err := charge("a1"); !errors.Is(err, provider.ErrUnknownOutcome) {
		t.Fatal(err)
	}
	got, err := charge("a1")
	if err != nil || got.Status != provider.PaymentSucceeded || len(p.Payments()) != 1 || p.Calls("ChargeOffSession") != 3 {
		t.Fatalf("retry after timeout: %+v %v (%d payments)", got, err, len(p.Payments()))
	}
	list, next, err := p.ListPayments(ctx, provider.ListReq{Customer: c, Kind: provider.MetadataKindAutoTopup})
	if err != nil || len(list) != 1 || next != "" {
		t.Fatalf("list %v %q %v", list, next, err)
	}
	// Decline and requires_action are answers, not errors.
	if d, err := charge("a2"); err != nil || d.Status != provider.PaymentFailed || d.FailureCode == "" {
		t.Fatal(d, err)
	}
	ra, err := charge("a3")
	if err != nil || ra.Status != provider.PaymentRequiresAction {
		t.Fatal(ra, err)
	}
	if cancelled, err := p.CancelPayment(ctx, ra.ID); err != nil || cancelled.Status != provider.PaymentCanceled {
		t.Fatal(cancelled, err)
	}
}

func TestRefundsAndLivemode(t *testing.T) {
	p, c := setup(t, fake.Options{})
	pm := p.AddMethod(c.ID)
	pay, err := p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: "x", Customer: c, PaymentMethodID: pm.ID, Amount: money.New(1000, money.USD)})
	if err != nil {
		t.Fatal(err)
	}
	r, err := p.Refund(ctx, provider.RefundReq{IdemKey: "refund:1", PaymentID: pay.ID, Amount: money.New(600, money.USD)})
	if err != nil || r.Status != provider.RefundSucceeded {
		t.Fatal(r, err)
	}
	if again, _ := p.Refund(ctx, provider.RefundReq{IdemKey: "refund:1", PaymentID: pay.ID, Amount: money.New(600, money.USD)}); again.ID != r.ID {
		t.Fatal("refund not idempotent")
	}
	if _, err := p.Refund(ctx, provider.RefundReq{IdemKey: "refund:2", PaymentID: pay.ID, Amount: money.New(500, money.USD)}); err == nil {
		t.Fatal("over-refund accepted")
	}
	if d, err := p.DashboardRefund(pay.ID, 400); err != nil || d.Amount.Minor != 400 {
		t.Fatal(d, err)
	}

	live := fake.New(fake.Options{Livemode: true})
	if _, err := live.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "c"}); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("live key: %v", err)
	}
	w := fake.New(fake.Options{Livemode: true, AllowLivemode: true}).Sign(provider.Event{EventID: "evt_1", Livemode: true})
	if _, err := fake.New(fake.Options{}).ParseWebhook(ctx, w.Header, w.Body); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("live event: %v", err)
	}
}
