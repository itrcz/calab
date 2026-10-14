//go:build integration && stripetest

// Auto-topup against the real Stripe TEST API (needs STRIPE_SECRET_KEY = sk_test_… / rk_test_…,
// skipped without it):
//
//	set -a; . /path/to/.env; set +a
//	TEST_PG_URL=… go test -tags 'integration stripetest' -run Stripe -v ./internal/billing/autotopup/
//
// A test customer gets saved cards attached server-side (what a checkout with
// setup_future_usage leaves behind): pm_card_visa charges off-session, pm_card_authenticationRequired
// asks for authentication (the intent is canceled), pm_card_chargeCustomerFail is declined.
package autotopup_test

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/inbox"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/stripe"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

func TestStripeAutoTopup(t *testing.T) {
	key := os.Getenv("STRIPE_SECRET_KEY")
	if key == "" {
		t.Skip("STRIPE_SECRET_KEY is not set")
	}
	if !strings.HasPrefix(key, "sk_test_") && !strings.HasPrefix(key, "rk_test_") {
		t.Fatal("test keys only")
	}
	var b [16]byte
	_, _ = rand.Read(b[:])
	sp, err := stripe.New(stripe.Config{SecretKey: key, WebhookSecrets: []string{"whsec_" + hex.EncodeToString(b[:])}})
	if err != nil {
		t.Fatal(err)
	}
	acct, err := sp.Account(ctx)
	if err != nil {
		t.Fatal(err)
	}
	d := dbtest.Connect(t)
	e := &env{t: t, d: d, clk: billing.NewFakeClock(time.Now().UTC().Truncate(time.Second)), merchant: acct}
	if e.reg, err = provider.NewRegistry("stripe:global", provider.DefaultMatrix(), sp); err != nil {
		t.Fatal(err)
	}
	e.core = core.New(d, e.clk, core.Config{Debits: true, Enforcement: true}, core.Hooks{})
	e.in = inbox.New(d, e.reg, e.core, inbox.Options{})
	e.in.Mail = inbox.NewNotifier(d, mail.New(mail.Config{Secret: []byte("billing-test-secret-billing-test-secret")}, d, nil, mail.NewFake()), "https://app.calab.test")
	e.job = e.newJob("")
	e.owner = e.user()
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "t7s" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Billing T7 Stripe", Visibility: "private", OwnerID: e.owner})
	if err != nil {
		t.Fatal(err)
	}
	e.ws = ws.ID
	e.addMember(e.owner, "owner")
	e.addMember(e.user(), "member")
	e.addMember(e.user(), "member")
	acc, err := e.core.EnableAccount(ctx, ws.ID, "global", "stripe", &e.owner)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_autotopup SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, acc.ID)
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now(), next_due_at = NULL WHERE id = $1 AND status <> 'closed'`, acc.ID)
	})
	ref, err := sp.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + acc.ID.String(), AccountID: acc.ID, Email: "t7@billing.test"})
	if err != nil {
		t.Fatal(err)
	}
	cust, err := d.Q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{AccountID: acc.ID, Provider: "stripe", ProviderAccount: acct, CustomerID: ref.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.core.AdminCredit(ctx, acc.ID, 30, "first day for the test", uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := e.core.Activate(ctx, acc.ID, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	e.wantBalance(0)

	sc := stripego.NewClient(key)
	card := func(token string) uuid.UUID {
		t.Helper()
		pm, err := sc.V1PaymentMethods.Attach(ctx, token, &stripego.PaymentMethodAttachParams{Customer: stripego.String(ref.ID)})
		if err != nil {
			t.Fatalf("attach %s: %v", token, err)
		}
		last4 := pm.Card.Last4
		row, err := d.Q.UpsertBillingPaymentMethod(ctx, sqlc.UpsertBillingPaymentMethodParams{
			AccountID: acc.ID, CustomerID: cust.ID, Provider: "stripe", ProviderPmID: pm.ID, Kind: "card", Brand: string(pm.Card.Brand), Last4: &last4,
		})
		if err != nil {
			t.Fatal(err)
		}
		e.pm = row.ID
		e.consentAs(e.owner)
		return row.ID
	}

	// 1. A chargeable card: one off-session PaymentIntent of 30 days (900), credited once.
	card("pm_card_visa")
	e.tick(1)
	a := e.attempts()
	if len(a) != 1 || a[0].Status != "succeeded" || a[0].AmountMinor != 900 || a[0].ProviderPaymentID == nil {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
	pi, err := sp.GetPayment(ctx, *a[0].ProviderPaymentID)
	if err != nil || pi.Status != provider.PaymentSucceeded || pi.Metadata.AttemptID != a[0].ID || pi.Metadata.Kind != provider.MetadataKindAutoTopup {
		t.Fatalf("payment intent %+v %v", pi, err)
	}
	// The same key again returns the same PaymentIntent (what an unknown-outcome retry relies on).
	again, err := sp.ChargeOffSession(ctx, provider.OffSessionReq{
		IdemKey: a[0].ID.String(), Customer: ref, PaymentMethodID: pi.PaymentMethodID, Amount: pi.Amount, Description: "Calab balance auto top-up",
		Metadata: provider.Metadata{AccountID: acc.ID, AttemptID: a[0].ID, Kind: provider.MetadataKindAutoTopup},
	})
	if err != nil || again.ID != pi.ID {
		t.Fatalf("same key: %s vs %s, %v", again.ID, pi.ID, err)
	}

	// 2. The bank asks for authentication: canceled, failed, owner mailed.
	e.drain()
	e.clk.Advance(25 * time.Hour)
	card("pm_card_authenticationRequired")
	e.tick(1)
	a = e.attempts()
	if len(a) != 2 || a[1].Status != "failed" || a[1].FailureCode != autotopup.CodeAuthRequired || a[1].ProviderPaymentID == nil {
		t.Fatalf("attempts %+v", a)
	}
	if f, err := sp.GetPayment(ctx, *a[1].ProviderPaymentID); err != nil || f.Status != provider.PaymentCanceled {
		t.Fatalf("authentication intent %+v %v", f, err)
	}
	if e.mails(string(mail.TemplateBillingAutoTopupActionRequired)) != 1 {
		t.Fatal("action required mail")
	}

	// 3. A declined card: failed with the decline code, owner mailed, no money.
	e.clk.Advance(25 * time.Hour)
	card("pm_card_chargeCustomerFail")
	e.tick(1)
	a = e.attempts()
	if len(a) != 3 || a[2].Status != "failed" || a[2].FailureCode == "" || a[2].FailureCode == autotopup.CodeAuthRequired {
		t.Fatalf("attempts %+v", a)
	}
	if e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 1 {
		t.Fatal("decline mail")
	}
	if bal := e.account().BalanceMinor; bal > 0 {
		t.Fatalf("balance %d after a decline", bal)
	}
	t.Logf("auto-topup on Stripe test mode: %s succeeded, %s canceled, decline %s (merchant %s)",
		*a[0].ProviderPaymentID, *a[1].ProviderPaymentID, a[2].FailureCode, acct)
}
