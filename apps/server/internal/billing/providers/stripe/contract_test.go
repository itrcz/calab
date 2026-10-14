//go:build stripetest

// Contract tests against the real Stripe TEST API. They need STRIPE_SECRET_KEY (sk_test_… /
// rk_test_…) in the environment and are skipped without it:
//
//	set -a; . /path/to/.env; set +a
//	go test -tags stripetest -run Contract -v ./internal/billing/providers/stripe/
//
// STRIPE_RECORD_DIR=dir additionally dumps the raw responses (for refreshing testdata/ after
// an API version change; anonymize before committing). Every object they create is test mode.
package stripe

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
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

type recorder struct {
	mu   sync.Mutex
	last []byte
	base http.RoundTripper
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := r.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	b, rerr := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if rerr != nil {
		return nil, rerr
	}
	res.Body = io.NopCloser(bytes.NewReader(b))
	r.mu.Lock()
	r.last = b
	r.mu.Unlock()
	return res, nil
}

func (r *recorder) save(t *testing.T, name string) {
	t.Helper()
	dir := os.Getenv("STRIPE_RECORD_DIR")
	if dir == "" {
		return
	}
	r.mu.Lock()
	b := r.last
	r.mu.Unlock()
	if err := os.WriteFile(filepath.Join(dir, name+".json"), b, 0o600); err != nil { //nolint:gosec // operator-set dump dir, fixed names
		t.Fatal(err)
	}
}

func contractProvider(t *testing.T) (*Provider, *recorder) {
	t.Helper()
	key := os.Getenv("STRIPE_SECRET_KEY")
	if key == "" {
		t.Skip("STRIPE_SECRET_KEY is not set")
	}
	if !strings.HasPrefix(key, "sk_test_") && !strings.HasPrefix(key, "rk_test_") {
		t.Fatal("contract tests run with test keys only")
	}
	rec := &recorder{base: http.DefaultTransport}
	p, err := New(Config{SecretKey: key, HTTPClient: &http.Client{Transport: rec, Timeout: 60 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	return p, rec
}

func contractCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func newCustomer(ctx context.Context, t *testing.T, p *Provider) (provider.CustomerRef, uuid.UUID) {
	t.Helper()
	acc := uuid.New()
	ref, err := p.EnsureCustomer(ctx, provider.CustomerReq{
		IdemKey: "customer:" + acc.String(), AccountID: acc, Name: "Contract test " + acc.String()[:8],
		Email: "contract+" + acc.String()[:8] + "@example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ref.ID, "cus_") || ref.Livemode || !strings.HasPrefix(ref.ProviderAccount, "acct_") {
		t.Fatalf("customer ref %+v", ref)
	}
	return ref, acc
}

func attachCard(ctx context.Context, t *testing.T, p *Provider, customer, token string) string {
	t.Helper()
	pm, err := p.sc.V1PaymentMethods.Attach(ctx, token, &stripego.PaymentMethodAttachParams{Customer: stripego.String(customer)})
	if err != nil {
		t.Fatalf("attach %s: %v", token, mapErr("attach", err))
	}
	return pm.ID
}

func TestContractCustomerAndCheckout(t *testing.T) {
	p, rec := contractProvider(t)
	ctx := contractCtx(t)
	acc := uuid.New()
	req := provider.CustomerReq{IdemKey: "customer:" + acc.String(), AccountID: acc, Name: "Contract checkout"}
	c1, err := p.EnsureCustomer(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	rec.save(t, "customer")
	c2, err := p.EnsureCustomer(ctx, req)
	if err != nil || c2.ID != c1.ID {
		t.Fatalf("idempotent customer: %v %s != %s", err, c2.ID, c1.ID)
	}

	checkout := uuid.New()
	sess, err := p.CreateCheckout(ctx, provider.CheckoutReq{
		IdemKey: "checkout:" + checkout.String(), Amount: money.New(500, money.USD), Method: provider.MethodCard,
		Customer: c1, SuccessURL: "https://app.calab.test/api/billing/return?checkout=" + checkout.String(),
		CancelURL: "https://app.calab.test/api/billing/return?checkout=" + checkout.String(), SaveForOffSession: true,
		Metadata: provider.Metadata{AccountID: acc, CheckoutID: checkout, Kind: provider.MetadataKindCheckout},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec.save(t, "checkout_session_created")
	if !strings.HasPrefix(sess.ID, "cs_test_") || !strings.HasPrefix(sess.URL, "https://checkout.stripe.com/") || sess.Livemode {
		t.Fatalf("session %+v", sess)
	}
	if d := time.Until(sess.ExpiresAt); d < 50*time.Minute || d > 70*time.Minute {
		t.Fatalf("expires in %s", d)
	}
	f, err := p.GetCheckout(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if f.Status != provider.CheckoutOpen || f.Amount != money.New(500, money.USD) || f.CustomerID != c1.ID ||
		f.Metadata.CheckoutID != checkout || f.Metadata.AccountID != acc || f.Metadata.Kind != provider.MetadataKindCheckout {
		t.Fatalf("checkout fact %+v", f)
	}
	raw, err := p.sc.V1CheckoutSessions.Retrieve(ctx, sess.ID, &stripego.CheckoutSessionRetrieveParams{})
	if err != nil {
		t.Fatal(err)
	}
	if raw.Mode != stripego.CheckoutSessionModePayment || raw.Currency != "usd" || raw.ClientReferenceID != checkout.String() ||
		raw.BillingAddressCollection != stripego.CheckoutSessionBillingAddressCollectionRequired ||
		raw.TaxIDCollection == nil || !raw.TaxIDCollection.Enabled || raw.AutomaticTax == nil || raw.AutomaticTax.Enabled ||
		(raw.InvoiceCreation != nil && raw.InvoiceCreation.Enabled) || len(raw.PaymentMethodTypes) != 1 || raw.PaymentMethodTypes[0] != "card" ||
		(raw.AdaptivePricing != nil && raw.AdaptivePricing.Enabled) || raw.Locale != "auto" {
		t.Fatalf("session fields: mode=%s cur=%s ref=%s bac=%s tax_id=%+v auto_tax=%+v invoice=%+v pmt=%v adaptive=%+v locale=%s",
			raw.Mode, raw.Currency, raw.ClientReferenceID, raw.BillingAddressCollection, raw.TaxIDCollection, raw.AutomaticTax,
			raw.InvoiceCreation, raw.PaymentMethodTypes, raw.AdaptivePricing, raw.Locale)
	}
	// Same key → same session.
	again, err := p.CreateCheckout(ctx, provider.CheckoutReq{
		IdemKey: "checkout:" + checkout.String(), Amount: money.New(500, money.USD), Method: provider.MethodCard,
		Customer: c1, SuccessURL: "https://app.calab.test/api/billing/return?checkout=" + checkout.String(),
		CancelURL: "https://app.calab.test/api/billing/return?checkout=" + checkout.String(), SaveForOffSession: true,
		ExpiresAt: sess.ExpiresAt,
		Metadata:  provider.Metadata{AccountID: acc, CheckoutID: checkout, Kind: provider.MetadataKindCheckout},
	})
	if err == nil && again.ID != sess.ID {
		t.Fatalf("same key, other session %s != %s", again.ID, sess.ID)
	}
	if err != nil && !errors.Is(err, ErrIdempotencyMismatch) {
		t.Fatalf("same key: %v", err)
	}
	// Expire it so the test account does not accumulate open sessions.
	if _, err := p.sc.V1CheckoutSessions.Expire(ctx, sess.ID, &stripego.CheckoutSessionExpireParams{}); err != nil {
		t.Fatal(mapErr("expire", err))
	}
	f, err = p.GetCheckout(ctx, sess.ID)
	if err != nil || f.Status != provider.CheckoutExpired {
		t.Fatalf("expired: %v %+v", err, f)
	}
}

func TestContractOffSessionSucceededRefundsAndList(t *testing.T) {
	p, rec := contractProvider(t)
	ctx := contractCtx(t)
	since := time.Now().Add(-time.Minute)
	cus, acc := newCustomer(ctx, t, p)
	pm := attachCard(ctx, t, p, cus.ID, "pm_card_visa")

	methods, err := p.ListMethods(ctx, cus)
	if err != nil || len(methods) != 1 || methods[0].ID != pm || methods[0].Last4 != "4242" || methods[0].Brand != "visa" ||
		methods[0].ExpYear == 0 || methods[0].Kind != provider.MethodCard {
		t.Fatalf("methods %v %+v", err, methods)
	}

	attempt := uuid.New()
	req := provider.OffSessionReq{
		IdemKey: attempt.String(), Customer: cus, PaymentMethodID: pm, Amount: money.New(1000, money.USD),
		Description: "Calab auto top-up", Metadata: provider.Metadata{AccountID: acc, AttemptID: attempt, Kind: provider.MetadataKindAutoTopup},
	}
	f, err := p.ChargeOffSession(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	rec.save(t, "pi_offsession_succeeded")
	if f.Status != provider.PaymentSucceeded || f.AmountReceived != money.New(1000, money.USD) || f.CustomerID != cus.ID ||
		!strings.HasPrefix(f.ChargeID, "ch_") || f.ReceiptURL == "" || f.PaymentMethodID != pm || f.SucceededAt.IsZero() ||
		f.Metadata.AttemptID != attempt || f.Metadata.Kind != provider.MetadataKindAutoTopup || f.ProviderAccount != cus.ProviderAccount {
		t.Fatalf("charge fact %+v", f)
	}
	again, err := p.ChargeOffSession(ctx, req)
	if err != nil || again.ID != f.ID {
		t.Fatalf("same idempotency key: %v %s != %s", err, again.ID, f.ID)
	}
	got, err := p.GetPayment(ctx, f.ID)
	if err != nil || got.Status != provider.PaymentSucceeded || got.ReceiptURL == "" || got.ChargeID != f.ChargeID {
		t.Fatalf("get payment %v %+v", err, got)
	}
	rec.save(t, "pi_get_succeeded")

	// Partial, then the rest, then nothing left.
	r1, err := p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + uuid.NewString(), PaymentID: f.ID, Amount: money.New(300, money.USD),
		Metadata: provider.Metadata{AccountID: acc}})
	if err != nil {
		t.Fatal(err)
	}
	rec.save(t, "refund_created")
	if r1.PaymentID != f.ID || r1.Amount != money.New(300, money.USD) || (r1.Status != provider.RefundSucceeded && r1.Status != provider.RefundPending) {
		t.Fatalf("refund 1 %+v", r1)
	}
	r2, err := p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + uuid.NewString(), PaymentID: f.ID, Amount: money.New(700, money.USD)})
	if err != nil || r2.Amount.Minor != 700 {
		t.Fatalf("refund 2 %v %+v", err, r2)
	}
	_, err = p.Refund(ctx, provider.RefundReq{IdemKey: "refund:" + uuid.NewString(), PaymentID: f.ID, Amount: money.New(1, money.USD)})
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != http.StatusBadRequest {
		t.Fatalf("over-refund: %v", err)
	}
	if strings.Contains(err.Error(), "sk_") {
		t.Fatal("error leaks a key")
	}
	gr, err := p.GetRefund(ctx, r1.ID)
	if err != nil || gr.ID != r1.ID || gr.PaymentID != f.ID {
		t.Fatalf("get refund %v %+v", err, gr)
	}
	refunds, err := p.ListRefunds(ctx, f.ID)
	if err != nil || len(refunds) != 2 {
		t.Fatalf("list refunds %v %d", err, len(refunds))
	}

	// A second payment, then list by customer.
	second, err := p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: uuid.NewString(), Customer: cus, PaymentMethodID: pm,
		Amount: money.New(600, money.USD), Metadata: provider.Metadata{AccountID: acc, Kind: provider.MetadataKindAutoTopup}})
	if err != nil || second.Status != provider.PaymentSucceeded {
		t.Fatalf("second %v %+v", err, second)
	}
	var all []provider.PaymentFact
	cursor := ""
	for range 5 {
		page, next, err := p.ListPayments(ctx, provider.ListReq{Customer: cus, CreatedAfter: since, Kind: provider.MetadataKindAutoTopup, Cursor: cursor, Limit: 1})
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, page...)
		if next == "" {
			break
		}
		cursor = next
	}
	if len(all) != 2 || all[0].ID != second.ID || all[1].ID != f.ID {
		t.Fatalf("list payments %+v", all)
	}

	if err := p.DetachMethod(ctx, pm); err != nil {
		t.Fatal(err)
	}
	if err := p.DetachMethod(ctx, pm); err != nil {
		t.Fatalf("second detach: %v", err)
	}
	methods, err = p.ListMethods(ctx, cus)
	if err != nil || len(methods) != 0 {
		t.Fatalf("after detach %v %+v", err, methods)
	}
}

func TestContractOffSessionDeclined(t *testing.T) {
	p, rec := contractProvider(t)
	ctx := contractCtx(t)
	cus, acc := newCustomer(ctx, t, p)
	// This test card refuses attachment, so it is charged as an unattached token.
	pm := "pm_card_chargeDeclinedInsufficientFunds"
	attempt := uuid.New()
	req := provider.OffSessionReq{IdemKey: attempt.String(), Customer: cus, PaymentMethodID: pm, Amount: money.New(1000, money.USD),
		Metadata: provider.Metadata{AccountID: acc, AttemptID: attempt, Kind: provider.MetadataKindAutoTopup}}
	f, err := p.ChargeOffSession(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	rec.save(t, "pi_offsession_declined")
	if f.Status != provider.PaymentFailed || f.FailureCode != "insufficient_funds" || !strings.HasPrefix(f.ID, "pi_") || f.AmountReceived.Minor != 0 {
		t.Fatalf("decline fact %+v", f)
	}
	again, err := p.ChargeOffSession(ctx, req)
	if err != nil || again.ID != f.ID || again.Status != provider.PaymentFailed {
		t.Fatalf("replayed decline %v %+v", err, again)
	}
	got, err := p.GetPayment(ctx, f.ID)
	if err != nil || got.Status != provider.PaymentFailed || got.FailureCode != "insufficient_funds" {
		t.Fatalf("get declined %v %+v", err, got)
	}
	rec.save(t, "pi_get_declined")

	// A card that attaches and then declines every charge.
	pm = attachCard(ctx, t, p, cus.ID, "pm_card_chargeCustomerFail")
	f, err = p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: uuid.NewString(), Customer: cus, PaymentMethodID: pm,
		Amount: money.New(1000, money.USD), Metadata: provider.Metadata{AccountID: acc, Kind: provider.MetadataKindAutoTopup}})
	if err != nil || f.Status != provider.PaymentFailed || f.FailureCode == "" {
		t.Fatalf("attached decline %v %+v", err, f)
	}
}

func TestContractOffSessionAuthenticationRequired(t *testing.T) {
	p, rec := contractProvider(t)
	ctx := contractCtx(t)
	cus, acc := newCustomer(ctx, t, p)
	pm := attachCard(ctx, t, p, cus.ID, "pm_card_authenticationRequired")
	attempt := uuid.New()
	f, err := p.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: attempt.String(), Customer: cus, PaymentMethodID: pm,
		Amount: money.New(1000, money.USD), Metadata: provider.Metadata{AccountID: acc, AttemptID: attempt, Kind: provider.MetadataKindAutoTopup}})
	if err != nil {
		t.Fatal(err)
	}
	rec.save(t, "pi_offsession_requires_action")
	if f.Status != provider.PaymentRequiresAction || f.FailureCode != "authentication_required" {
		t.Fatalf("auth fact %+v", f)
	}
	got, err := p.GetPayment(ctx, f.ID)
	if err != nil || got.Status != provider.PaymentRequiresAction {
		t.Fatalf("get requires_action %v %+v", err, got)
	}
	c, err := p.CancelPayment(ctx, f.ID)
	if err != nil || c.Status != provider.PaymentCanceled {
		t.Fatalf("cancel %v %+v", err, c)
	}
	rec.save(t, "pi_canceled")
	c, err = p.CancelPayment(ctx, f.ID)
	if err != nil || c.Status != provider.PaymentCanceled {
		t.Fatalf("second cancel %v %+v", err, c)
	}
}

func TestContractNotFound(t *testing.T) {
	p, _ := contractProvider(t)
	ctx := contractCtx(t)
	if _, err := p.GetPayment(ctx, "pi_does_not_exist"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("missing payment: %v", err)
	}
}
