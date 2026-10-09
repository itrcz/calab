//go:build integration && stripetest

// End-to-end against the real Stripe TEST API (needs STRIPE_SECRET_KEY = sk_test_… / rk_test_…,
// skipped without it):
//
//	set -a; . /path/to/.env; set +a
//	TEST_PG_URL=… go test -tags 'integration stripetest' -run Stripe -v ./internal/billing/http/
//
// A hosted Checkout cannot be paid server-side, so the test opens one through our API (real
// customer + session), then pays a PaymentIntent of the same customer with pm_card_visa and
// feeds a payment_intent.succeeded event signed with a test endpoint secret through the
// webhook route: the inbox re-reads the PaymentIntent from Stripe and credits it once.
package billinghttp_test

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	stripego "github.com/stripe/stripe-go/v86"
	"github.com/stripe/stripe-go/v86/webhook"

	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/billing/providers/stripe"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestStripeEndToEnd(t *testing.T) {
	key := os.Getenv("STRIPE_SECRET_KEY")
	if key == "" {
		t.Skip("STRIPE_SECRET_KEY is not set")
	}
	if !strings.HasPrefix(key, "sk_test_") && !strings.HasPrefix(key, "rk_test_") {
		t.Fatal("test keys only")
	}
	var b [16]byte
	_, _ = rand.Read(b[:])
	secret := "whsec_" + hex.EncodeToString(b[:])
	sp, err := stripe.New(stripe.Config{SecretKey: key, WebhookSecrets: []string{secret}})
	if err != nil {
		t.Fatal(err)
	}
	acct, err := sp.Account(ctx)
	if err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, envOpt{wrap: func(*fake.Provider) provider.Provider { return sp }})
	e.merchant = acct

	cid, _ := e.topup(1200, false)
	co, err := e.d.Q.GetBillingCheckout(ctx, cid)
	if err != nil || co.Url == nil || !strings.HasPrefix(*co.Url, "https://checkout.stripe.com/") {
		t.Fatalf("checkout %+v %v", co, err)
	}
	cust, err := e.d.Q.GetBillingCustomer(ctx, sqlc.GetBillingCustomerParams{AccountID: e.acc, Provider: "stripe", Livemode: false})
	if err != nil {
		t.Fatal(err)
	}

	sc := stripego.NewClient(key)
	params := &stripego.PaymentIntentCreateParams{
		Amount: stripego.Int64(1200), Currency: stripego.String("usd"), Customer: stripego.String(cust.CustomerID),
		PaymentMethod: stripego.String("pm_card_visa"), PaymentMethodTypes: stripego.StringSlice([]string{"card"}),
		Confirm: stripego.Bool(true),
		Metadata: provider.Metadata{AccountID: e.acc, Kind: provider.MetadataKindCheckout}.Map(),
	}
	params.SetIdempotencyKey("t5-e2e-" + hex.EncodeToString(b[:8]))
	pi, err := sc.V1PaymentIntents.Create(ctx, params)
	if err != nil {
		t.Fatalf("create payment intent: %v", err)
	}
	if pi.Status != stripego.PaymentIntentStatusSucceeded {
		t.Fatalf("payment intent %s", pi.Status)
	}

	event := func(id string) []byte {
		body, _ := json.Marshal(map[string]any{
			"id": id, "object": "event", "api_version": stripe.APIVersion, "created": time.Now().Unix(), "livemode": false,
			"type": "payment_intent.succeeded", "pending_webhooks": 1,
			"data": map[string]any{"object": map[string]any{"id": pi.ID, "object": "payment_intent", "metadata": pi.Metadata}},
		})
		return body
	}
	post := func(body []byte, header string) int {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.srv.URL+"/api/billing/stripe/webhook", bytes.NewReader(body))
		req.Header.Set("Stripe-Signature", header)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode
	}
	body := event("evt_t5_" + hex.EncodeToString(b[:6]))
	signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body, Secret: secret, Timestamp: time.Now()})
	wrong := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body, Secret: "whsec_wrong", Timestamp: time.Now()})
	if st := post(body, wrong.Header); st != http.StatusBadRequest {
		t.Fatalf("wrong secret: %d", st)
	}
	for range 2 {
		if st := post(body, signed.Header); st != http.StatusOK {
			t.Fatalf("webhook: %d", st)
		}
	}
	// A second event of the same payment (another event id).
	body2 := event("evt_t5b_" + hex.EncodeToString(b[:6]))
	if st := post(body2, webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body2, Secret: secret}).Header); st != http.StatusOK {
		t.Fatalf("second event: %d", st)
	}
	e.process()
	if errs := e.eventErrors(); len(errs) != 0 {
		t.Fatal(errs)
	}
	acc := e.account()
	if acc.BalanceMinor != 1200 || e.lots() != 1 {
		t.Fatalf("balance %d lots %d", acc.BalanceMinor, e.lots())
	}
	var receipt string
	if err := e.d.Pool.QueryRow(ctx, `SELECT receipt_url FROM billing_payments WHERE account_id = $1 AND provider_payment_id = $2`, e.acc, pi.ID).Scan(&receipt); err != nil || receipt == "" {
		t.Fatalf("receipt %q %v", receipt, err)
	}
	t.Logf("credited %s once (merchant %s)", pi.ID, acct)
}
