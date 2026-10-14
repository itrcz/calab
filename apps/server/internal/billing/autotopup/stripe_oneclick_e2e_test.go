//go:build integration && stripetest

// One-click top-up against the real Stripe TEST API (ADR-0083 phase 2), same setup as
// stripe_e2e_test.go: pm_card_visa is charged on-session at once; pm_card_authenticationRequired
// (4000 0025 0000 3155) answers requires_action with Stripe's hosted 3-D Secure page, canceled when
// nobody confirms it; pm_card_chargeCustomerFail (4000 0000 0000 0341) is declined.
package autotopup_test

import (
	"crypto/rand"
	"encoding/hex"
	"net/url"
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

func TestStripeOneClickTopup(t *testing.T) {
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
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "t8s" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Billing one-click Stripe", Visibility: "private", OwnerID: e.owner})
	if err != nil {
		t.Fatal(err)
	}
	e.ws = ws.ID
	e.addMember(e.owner, "owner")
	acc, err := e.core.EnableAccount(ctx, ws.ID, "global", "stripe", &e.owner)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_autotopup_attempts SET status = 'failed', finished_at = now()
			WHERE account_id = $1 AND status IN ('prepared', 'dispatched', 'requires_action', 'unknown')`, acc.ID)
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now(), next_due_at = NULL WHERE id = $1 AND status <> 'closed'`, acc.ID)
	})
	ref, err := sp.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + acc.ID.String(), AccountID: acc.ID, Email: "t8@billing.test"})
	if err != nil {
		t.Fatal(err)
	}
	cust, err := d.Q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{AccountID: acc.ID, Provider: "stripe", ProviderAccount: acct, CustomerID: ref.ID})
	if err != nil {
		t.Fatal(err)
	}
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
		return row.ID
	}
	charge := func(pm uuid.UUID, minor int64) sqlc.BillingAutotopupAttempt {
		t.Helper()
		att, err := e.job.StartManual(ctx, autotopup.ManualRequest{AccountID: acc.ID, UserID: e.owner, RequestID: uuid.New(),
			BodyHash: []byte(uuid.NewString()), PmID: pm, AmountMinor: minor, Currency: "USD"})
		if err != nil {
			t.Fatal(err)
		}
		return att
	}

	// 1. A card without 3-D Secure: charged at once, credited.
	a := charge(card("pm_card_visa"), 1500)
	if a.Status != "succeeded" || a.ProviderPaymentID == nil {
		t.Fatalf("visa %+v", a)
	}
	e.wantBalance(1500)
	if f, err := sp.GetPayment(ctx, *a.ProviderPaymentID); err != nil || f.Metadata.Kind != provider.MetadataKindSavedMethod {
		t.Fatalf("intent %+v %v", f, err)
	}

	// 2. 3-D Secure: requires_action with Stripe's page; nobody confirms → canceled after the timeout.
	a = charge(card("pm_card_authenticationRequired"), 1500)
	u, err := url.Parse(a.ActionUrl)
	if a.Status != "requires_action" || err != nil || u.Scheme != "https" || !strings.HasSuffix(u.Host, "stripe.com") {
		t.Fatalf("3ds %+v", a)
	}
	t.Logf("3-D Secure page host: %s", u.Host)
	e.clk.Advance(autotopup.DefaultActionTimeout + time.Minute)
	if err := e.job.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := d.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: a.ID, AccountID: acc.ID}); got.Status != "failed" {
		t.Fatalf("abandoned 3ds %+v", got)
	}
	if f, err := sp.GetPayment(ctx, *a.ProviderPaymentID); err != nil || f.Status != provider.PaymentCanceled {
		t.Fatalf("3ds intent %+v %v", f, err)
	}

	// 3. A declined card: failed, no money.
	a = charge(card("pm_card_chargeCustomerFail"), 1500)
	if a.Status != "failed" || a.FailureCode == "" {
		t.Fatalf("declined %+v", a)
	}
	e.wantBalance(1500)
}
