//go:build integration

package autotopup_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/mail"
)

// reconcilableCaps: a Tochka-like provider (no idempotency keys, charges found by reading the
// method's charges) registered under the Stripe matrix row, so the USD env exercises the same
// dispatcher paths as RU.
const reconcilableCaps = provider.CapHostedCheckout | provider.CapSaveMethod | provider.CapOffSession |
	provider.CapRefund | provider.CapListPayments | provider.CapReconcilableCharge | provider.CapSuccessOnlyWebhooks

// ADR-0083 phase 2: an auto-topup charge of a reconcilable provider is sent once; its payment is
// the new charge of the method (snapshot before the call) and is credited once with the attempt.
func TestReconcilableAutoTopupCredited(t *testing.T) {
	e := newEnv(t, opts{caps: reconcilableCaps})
	e.tick(1)
	a := e.attempts()
	if len(a) != 1 || a[0].Status != "succeeded" || a[0].ProviderPaymentID == nil {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
	if n, sum := e.autoPayments(); n != 1 || sum != 900 {
		t.Fatalf("auto payments %d %d", n, sum)
	}
	if e.fake.Calls("ChargeOffSession") != 1 || e.fake.Calls("ListCharges") < 2 {
		t.Fatalf("charge %d list %d", e.fake.Calls("ChargeOffSession"), e.fake.Calls("ListCharges"))
	}
	e.webhooks()
	e.wantBalance(900)
}

// A lost answer of a reconcilable provider is never sent again: the recovery only reads, finds
// the charge and credits it once.
func TestReconcilableUnknownResolvedByReading(t *testing.T) {
	e := newEnv(t, opts{caps: reconcilableCaps})
	e.fake.Queue(fake.OpCharge, fake.Timeout)
	// The read right after the call fails too.
	e.p.hooks(nil, func() { e.fake.Queue(fake.OpGet, fake.Unknown) })
	e.tick(1)
	e.p.hooks(nil, nil)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "unknown" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(0)
	e.clk.Advance(3 * time.Minute)
	e.tick(0)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
	if e.fake.Calls("ChargeOffSession") != 1 {
		t.Fatalf("charge sent %d times", e.fake.Calls("ChargeOffSession"))
	}
}

// Nothing was charged and the answer was lost: the attempt stays open (blocking any other charge)
// past GiveUpAfter, never re-sent, and is closed as not_found after ReconcileGiveUp.
func TestReconcilableUnknownNotFound(t *testing.T) {
	e := newEnv(t, opts{caps: reconcilableCaps})
	e.fake.Queue(fake.OpCharge, fake.Unknown)
	e.tick(1)
	for _, step := range []time.Duration{3 * time.Minute, 25 * time.Hour, 3 * 24 * time.Hour} {
		e.clk.Advance(step)
		e.tick(0)
		if a := e.attempts(); len(a) != 1 || a[0].Status != "unknown" {
			t.Fatalf("after %v: %+v", step, a)
		}
	}
	e.clk.Advance(4 * 24 * time.Hour)
	if err := e.job.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if a := e.attempts(); a[0].Status != "failed" || a[0].FailureCode != autotopup.CodeNotFound {
		t.Fatalf("attempts %+v", a)
	}
	if e.fake.Calls("ChargeOffSession") != 1 || e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 0 {
		t.Fatalf("charges %d mails %d", e.fake.Calls("ChargeOffSession"), e.mails(string(mail.TemplateBillingAutoTopupFailed)))
	}
}

// «declined» with no new charge visible: failed + owner mail.
func TestReconcilableDeclined(t *testing.T) {
	e := newEnv(t, opts{caps: reconcilableCaps})
	e.fake.Queue(fake.OpCharge, fake.Decline)
	e.tick(1)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "failed" || a[0].FailureCode != "declined" {
		t.Fatalf("attempts %+v", a)
	}
	if e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 1 {
		t.Fatal("mail")
	}
	e.wantBalance(0)
}

func (e *env) savedTopup(reqID string, amount int64, out *v1.SavedMethodTopup) (int, string) {
	e.t.Helper()
	if out == nil {
		out = &v1.SavedMethodTopup{}
	}
	return e.do(e.owner, "POST", e.base()+"/saved-method-topups", &v1.CreateSavedMethodTopupRequest{
		PaymentMethodId: e.pm.String(), Amount: &v1.Money{Minor: amount, Currency: "USD"}, RequestId: reqID,
	}, out)
}

func (e *env) savedPayments() int {
	return e.count(`SELECT count(*) FROM billing_payments WHERE account_id = $1 AND origin = 'saved_method'`, e.acc)
}

// One-click top-up (owner 2026-10-10): charged at once, credited, replay-safe.
func TestOneClickTopup(t *testing.T) {
	e := newEnv(t, opts{noConsent: true})
	var out v1.SavedMethodTopup
	reqID := uuid.NewString()
	if st, r := e.savedTopup(reqID, 2000, &out); st != 200 {
		t.Fatalf("%d %s", st, r)
	}
	if out.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_SUCCEEDED || !out.GetCredited() || out.GetAmount().GetMinor() != 2000 {
		t.Fatalf("%+v", &out)
	}
	e.wantBalance(2000)
	if e.savedPayments() != 1 {
		t.Fatal("payment origin saved_method")
	}
	var again v1.SavedMethodTopup
	if st, _ := e.savedTopup(reqID, 2000, &again); st != 200 || again.GetId() != out.GetId() {
		t.Fatalf("replay %d %+v", st, &again)
	}
	if st, r := e.savedTopup(reqID, 3000, nil); st != http.StatusConflict {
		t.Fatalf("reused request id: %d %s", st, r)
	}
	if e.fake.Calls("ChargeOffSession") != 1 {
		t.Fatalf("charges %d", e.fake.Calls("ChargeOffSession"))
	}
	if st, _ := e.savedTopup(uuid.NewString(), 100, nil); st != http.StatusUnprocessableEntity {
		t.Fatalf("below minimum: %d", st)
	}
	var sum v1.GetBillingResponse
	e.do(e.owner, "GET", e.base(), nil, &sum)
	ms := sum.GetSummary().GetSavedMethods()
	if len(ms) != 1 || !ms[0].GetOneClick() || !ms[0].GetAutoTopupCapable() || ms[0].GetLast4() != "4242" || sum.GetSummary().GetPendingSavedTopup() != nil {
		t.Fatalf("summary methods %+v", ms)
	}
	if st, _ := e.do(e.member, "POST", e.base()+"/saved-method-topups", &v1.CreateSavedMethodTopupRequest{
		PaymentMethodId: e.pm.String(), Amount: &v1.Money{Minor: 2000, Currency: "USD"}, RequestId: uuid.NewString(),
	}, nil); st != http.StatusForbidden {
		t.Fatalf("member: %d", st)
	}
}

// 3-D Secure: the answer carries the provider's page; while it waits, no other charge (one-click
// or auto) starts; after confirmation the GET credits it.
func TestOneClickThreeDS(t *testing.T) {
	e := newEnv(t, opts{})
	e.fake.Queue(fake.OpCharge, fake.RequiresAction)
	var out v1.SavedMethodTopup
	if st, r := e.savedTopup(uuid.NewString(), 2000, &out); st != 200 {
		t.Fatalf("%d %s", st, r)
	}
	if out.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_REQUIRES_ACTION || out.GetActionUrl() == "" {
		t.Fatalf("%+v", &out)
	}
	if st, r := e.savedTopup(uuid.NewString(), 3000, nil); st != http.StatusConflict || r != "BILLING_PAYMENT_PENDING" {
		t.Fatalf("second charge: %d %s", st, r)
	}
	e.tick(0) // auto-topup waits for the open charge
	var sum v1.GetBillingResponse
	e.do(e.owner, "GET", e.base(), nil, &sum)
	if p := sum.GetSummary().GetPendingSavedTopup(); p.GetId() != out.GetId() {
		t.Fatalf("pending %+v", p)
	}
	pays := e.fake.Payments()
	if err := e.fake.SettlePayment(pays[len(pays)-1].ID, fake.Succeed); err != nil {
		t.Fatal(err)
	}
	var got v1.SavedMethodTopup
	if st, _ := e.do(e.owner, "GET", e.base()+"/saved-method-topups/"+out.GetId(), nil, &got); st != 200 ||
		got.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_SUCCEEDED || !got.GetCredited() {
		t.Fatalf("after 3ds %d %+v", st, &got)
	}
	e.webhooks()
	e.wantBalance(2000)
	if e.savedPayments() != 1 {
		t.Fatal("one payment")
	}
}

// 3-D Secure never confirmed: canceled after ActionTimeout, failed, no owner mail.
func TestOneClickThreeDSAbandoned(t *testing.T) {
	e := newEnv(t, opts{noConsent: true})
	e.fake.Queue(fake.OpCharge, fake.RequiresAction)
	var out v1.SavedMethodTopup
	e.savedTopup(uuid.NewString(), 2000, &out)
	e.clk.Advance(10 * time.Minute)
	e.tick(0)
	var got v1.SavedMethodTopup
	e.do(e.owner, "GET", e.base()+"/saved-method-topups/"+out.GetId(), nil, &got)
	if got.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_REQUIRES_ACTION {
		t.Fatalf("too early: %+v", &got)
	}
	e.clk.Advance(time.Hour)
	e.tick(0)
	e.do(e.owner, "GET", e.base()+"/saved-method-topups/"+out.GetId(), nil, &got)
	if got.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_FAILED || got.GetFailureCode() != autotopup.CodeAuthRequired {
		t.Fatalf("%+v", &got)
	}
	if e.fake.Calls("CancelPayment") != 1 || e.mails(string(mail.TemplateBillingAutoTopupActionRequired)) != 0 {
		t.Fatal("cancel / mail")
	}
	e.wantBalance(0)
	// The slot is free again.
	if st, r := e.savedTopup(uuid.NewString(), 2000, nil); st != 200 {
		t.Fatalf("next: %d %s", st, r)
	}
}

// A decline is shown, not mailed.
func TestOneClickDeclined(t *testing.T) {
	e := newEnv(t, opts{noConsent: true})
	e.fake.Queue(fake.OpCharge, fake.Decline)
	var out v1.SavedMethodTopup
	e.savedTopup(uuid.NewString(), 2000, &out)
	if out.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_FAILED || out.GetFailureCode() != "card_declined" {
		t.Fatalf("%+v", &out)
	}
	if e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 0 {
		t.Fatal("mailed")
	}
}

// Reconcilable provider: the one-click charge is attributed by reading, credited at once.
func TestOneClickReconcilable(t *testing.T) {
	e := newEnv(t, opts{caps: reconcilableCaps, noConsent: true})
	var out v1.SavedMethodTopup
	if st, r := e.savedTopup(uuid.NewString(), 2000, &out); st != 200 {
		t.Fatalf("%d %s", st, r)
	}
	if out.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_SUCCEEDED || !out.GetCredited() {
		t.Fatalf("%+v", &out)
	}
	e.wantBalance(2000)
	if e.savedPayments() != 1 || e.fake.Calls("ChargeOffSession") != 1 {
		t.Fatal("one payment, one call")
	}
}

// The flag off: the route answers BILLING_DISABLED and the summary offers no one-click.
func TestOneClickDisabled(t *testing.T) {
	e := newEnv(t, opts{noOneClick: true, noConsent: true})
	if st, r := e.savedTopup(uuid.NewString(), 2000, nil); st != http.StatusNotImplemented || r != "BILLING_DISABLED" {
		t.Fatalf("%d %s", st, r)
	}
	var sum v1.GetBillingResponse
	e.do(e.owner, "GET", e.base(), nil, &sum)
	if ms := sum.GetSummary().GetSavedMethods(); len(ms) != 1 || ms[0].GetOneClick() {
		t.Fatalf("%+v", ms)
	}
}
