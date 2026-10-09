//go:build integration

package autotopup_test

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Success: one attempt of debt + 30 days (900), credited once; the webhooks that follow do
// not credit again; the owner gets the payment mail; not_before = +24 h.
func TestSuccessCreditedOnceWebhookAfter(t *testing.T) {
	e := newEnv(t, opts{})
	e.tick(1)
	atts := e.attempts()
	if len(atts) != 1 || atts[0].Status != "succeeded" || atts[0].AmountMinor != 900 || atts[0].ProviderPaymentID == nil {
		t.Fatalf("attempts %+v", atts)
	}
	e.wantBalance(900)
	e.webhooks()
	e.webhooks()
	e.wantBalance(900)
	if n, sum := e.autoPayments(); n != 1 || sum != 900 {
		t.Fatalf("auto payments %d sum %d", n, sum)
	}
	if e.lots() != 2 || e.mails(string(mail.TemplateBillingPaymentReceived)) != 2 {
		t.Fatalf("lots %d payment mails %d", e.lots(), e.mails(string(mail.TemplateBillingPaymentReceived)))
	}
	nb := e.consentRow().NotBefore
	if nb == nil || !nb.Equal(e.clk.Time().Add(24*time.Hour)) {
		t.Fatalf("not_before %v", nb)
	}
	// Nothing more today: the need is gone and not_before holds.
	e.drain()
	e.tick(0)
}

// The webhook is processed before the dispatcher records the answer: still one credit.
func TestSuccessCreditedOnceWebhookFirst(t *testing.T) {
	e := newEnv(t, opts{})
	e.p.hooks(nil, func() { e.webhooks() })
	e.tick(1)
	e.p.hooks(nil, nil)
	e.webhooks()
	e.wantBalance(900)
	if n, _ := e.autoPayments(); n != 1 || e.lots() != 2 {
		t.Fatalf("auto payments %d lots %d", n, e.lots())
	}
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
}

// A decline: failed with the bank code, one owner mail, no money; the next attempt not before
// 24 h after the first.
func TestDeclineMailAndNextAfter24h(t *testing.T) {
	e := newEnv(t, opts{})
	e.fake.Queue(fake.OpCharge, fake.Decline)
	e.tick(1)
	a := e.attempts()
	if len(a) != 1 || a[0].Status != "failed" || a[0].FailureCode != "card_declined" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(0)
	if e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 1 {
		t.Fatal("decline mail")
	}
	e.webhooks() // payment_intent.payment_failed: nothing to credit
	e.wantBalance(0)
	e.clk.Advance(24*time.Hour - time.Minute)
	e.tick(0)
	e.clk.Advance(2 * time.Minute)
	e.tick(1)
	if a := e.attempts(); len(a) != 2 || a[1].Status != "succeeded" || a[1].AmountMinor != 900 {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(870) // the credit first applies the renewal that fell due meanwhile
	if e.mails(string(mail.TemplateBillingAutoTopupFailed)) != 1 {
		t.Fatal("one decline mail")
	}
}

// The bank asks for authentication: the intent is canceled, the attempt failed, the owner mailed
// with the manual top-up link; never charged.
func TestRequiresActionCanceled(t *testing.T) {
	e := newEnv(t, opts{})
	e.fake.Queue(fake.OpCharge, fake.RequiresAction)
	e.tick(1)
	a := e.attempts()
	if len(a) != 1 || a[0].Status != "failed" || a[0].FailureCode != autotopup.CodeAuthRequired || a[0].ProviderPaymentID == nil {
		t.Fatalf("attempts %+v", a)
	}
	if e.fake.Calls("CancelPayment") != 1 {
		t.Fatalf("cancel calls %d", e.fake.Calls("CancelPayment"))
	}
	pays := e.fake.Payments()
	if len(pays) != 2 || pays[1].Status != provider.PaymentCanceled {
		t.Fatalf("provider payments %+v", pays)
	}
	if e.mails(string(mail.TemplateBillingAutoTopupActionRequired)) != 1 {
		t.Fatal("action required mail")
	}
	e.wantBalance(0)
	e.clk.Advance(time.Hour)
	e.tick(0) // not_before
}

// A lost answer: unknown; the recovery retries with the same key, gets the same payment and
// credits it once; webhooks do not add anything.
func TestUnknownRetriedWithSameKey(t *testing.T) {
	e := newEnv(t, opts{})
	e.fake.Queue(fake.OpCharge, fake.Timeout)
	e.tick(1)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "unknown" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(0)
	e.tick(0) // inside the grace: the dispatcher's own request
	e.clk.Advance(3 * time.Minute)
	e.tick(0)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
	e.webhooks()
	e.wantBalance(900)
	if len(e.fake.Payments()) != 2 || e.fake.Calls("ChargeOffSession") != 2 {
		t.Fatalf("provider payments %d charge calls %d", len(e.fake.Payments()), e.fake.Calls("ChargeOffSession"))
	}
	if n, _ := e.autoPayments(); n != 1 {
		t.Fatalf("auto payments %d", n)
	}
}

// Unknown with auto-topup switched off: no same-key retry, a lookup finds the payment.
func TestUnknownLookupWhenDisabled(t *testing.T) {
	e := newEnv(t, opts{})
	e.fake.Queue(fake.OpCharge, fake.Timeout)
	e.tick(1)
	off := autotopup.New(e.d, e.core, e.reg, e.in, e.clk, autotopup.Options{Enabled: false})
	e.clk.Advance(3 * time.Minute)
	if err := off.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if e.fake.Calls("ChargeOffSession") != 1 || e.fake.Calls("ListPayments") == 0 {
		t.Fatalf("charge calls %d list calls %d", e.fake.Calls("ChargeOffSession"), e.fake.Calls("ListPayments"))
	}
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
}

// An unknown attempt that never reached the provider and whose consent was revoked: lookups
// only; after 24 h without a payment it is closed, and nothing was ever charged.
func TestUnknownNeverSentClosedAfter24h(t *testing.T) {
	e := newEnv(t, opts{})
	e.fake.Queue(fake.OpCharge, fake.Unknown)
	e.tick(1)
	if st, r := e.do(e.owner, "DELETE", e.base()+"/auto-topup", nil, nil); st != 200 {
		t.Fatalf("revoke %d %s", st, r)
	}
	e.clk.Advance(3 * time.Minute)
	e.tick(0)
	if a := e.attempts(); a[0].Status != "unknown" {
		t.Fatalf("attempts %+v", a)
	}
	e.clk.Advance(24 * time.Hour)
	e.tick(0)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "failed" || a[0].FailureCode != autotopup.CodeNotFound {
		t.Fatalf("attempts %+v", a)
	}
	if len(e.fake.Payments()) != 1 || e.fake.Calls("ChargeOffSession") != 1 {
		t.Fatalf("provider payments %d charges %d", len(e.fake.Payments()), e.fake.Calls("ChargeOffSession"))
	}
}

// Two instances racing on one account: one attempt, one PaymentIntent, one credit.
func TestRacingWorkersOneAttempt(t *testing.T) {
	e := newEnv(t, opts{})
	jobs := []*autotopup.Job{e.job, e.newJob(""), e.newJob(""), e.newJob("")}
	var wg sync.WaitGroup
	for _, j := range jobs {
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := j.TryAccount(ctx, e.acc); err != nil {
					t.Error(err)
				}
			}()
		}
	}
	wg.Wait()
	if a := e.attempts(); len(a) != 1 {
		t.Fatalf("attempts %+v", a)
	}
	if e.fake.Calls("ChargeOffSession") != 1 || len(e.fake.Payments()) != 2 {
		t.Fatalf("charges %d payments %d", e.fake.Calls("ChargeOffSession"), len(e.fake.Payments()))
	}
	e.wantBalance(900)
}

// The owner revokes while the charge is in flight: the dispatched charge is settled (credited),
// no new attempt afterwards.
func TestRevokeDuringDispatch(t *testing.T) {
	e := newEnv(t, opts{})
	e.p.hooks(func() {
		if st, r := e.do(e.owner, "DELETE", e.base()+"/auto-topup", nil, nil); st != 200 {
			t.Errorf("revoke %d %s", st, r)
		}
	}, nil)
	e.tick(1)
	e.p.hooks(nil, nil)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
	if e.consentRow().RevokedAt == nil {
		t.Fatal("consent not revoked")
	}
	e.drain()
	e.clk.Advance(25 * time.Hour)
	e.tick(0)
	if len(e.attempts()) != 1 {
		t.Fatal("a new attempt after the revoke")
	}
}

// The owner's cap limits the charge; the API refuses caps outside [method min, $5000] and an
// unknown consent version.
func TestCapRespectedAndValidated(t *testing.T) {
	e := newEnv(t, opts{noConsent: true})
	for _, c := range []struct {
		capMinor int64
		version  uint32
	}{{499, 1}, {500001, 1}, {50000, 2}, {50000, 0}} {
		st, _ := e.do(e.owner, "PUT", e.base()+"/auto-topup", &v1.PutAutoTopupRequest{
			PaymentMethodId: e.pm.String(), MaxAmount: &v1.Money{Minor: c.capMinor, Currency: "USD"}, ConsentVersion: c.version, RequestId: uuid.NewString(),
		}, nil)
		if st != http.StatusUnprocessableEntity {
			t.Fatalf("cap %d version %d: %d", c.capMinor, c.version, st)
		}
	}
	if st, r := e.do(e.owner, "PUT", e.base()+"/auto-topup", &v1.PutAutoTopupRequest{
		PaymentMethodId: uuid.NewString(), MaxAmount: &v1.Money{Minor: 50000, Currency: "USD"}, ConsentVersion: 1, RequestId: uuid.NewString(),
	}, nil); st != http.StatusUnprocessableEntity {
		t.Fatalf("foreign card %d %s", st, r)
	}
	e.tick(0) // no consent
	if st, r := e.consent(500); st != 200 {
		t.Fatalf("consent %d %s", st, r)
	}
	e.tick(1)
	if a := e.attempts(); len(a) != 1 || a[0].AmountMinor != 500 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(500)
}

// Debt: the amount covers the debt and 30 days.
func TestDebtCoveredPlus30Days(t *testing.T) {
	e := newEnv(t, opts{})
	e.clk.Advance(24 * time.Hour) // renewal of the 3 seats into debt
	w := core.DueRenewal
	if _, ok, _, err := e.core.ProcessDue(ctx, w, nil); err != nil || !ok {
		t.Fatalf("renewal %t %v", ok, err)
	}
	e.wantBalance(-30)
	e.tick(1)
	if a := e.attempts(); len(a) != 1 || a[0].AmountMinor != 930 {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
	if acc := e.account(); acc.NegativeSince != nil {
		t.Fatalf("debt episode still open %+v", acc)
	}
}

// A manual top-up between prepare and the fence cancels the unsent attempt.
func TestManualTopupSupersedesUnsentAttempt(t *testing.T) {
	e := newEnv(t, opts{})
	att, err := e.job.Prepare(ctx, e.acc)
	if err != nil || att == nil || att.Status != "prepared" {
		t.Fatalf("prepare %+v %v", att, err)
	}
	e.topup(5000, false)
	sent, err := e.job.Dispatch(ctx, *att)
	if err != nil || sent {
		t.Fatalf("dispatch %t %v", sent, err)
	}
	if a := e.attempts(); a[0].Status != "failed" || a[0].FailureCode != autotopup.CodeSuperseded {
		t.Fatalf("attempts %+v", a)
	}
	if e.fake.Calls("ChargeOffSession") != 0 {
		t.Fatal("charged")
	}
	e.wantBalance(5000)
}

// The owner lowers the cap between prepare and the fence: the prepared amount is above the
// new cap, so the attempt is not sent.
func TestCapLoweredBeforeFence(t *testing.T) {
	e := newEnv(t, opts{})
	att, err := e.job.Prepare(ctx, e.acc)
	if err != nil || att == nil || att.AmountMinor <= 500 {
		t.Fatalf("prepare %+v %v", att, err)
	}
	if st, r := e.consent(500); st != 200 {
		t.Fatalf("consent %d %s", st, r)
	}
	sent, err := e.job.Dispatch(ctx, *att)
	if err != nil || sent {
		t.Fatalf("dispatch %t %v", sent, err)
	}
	if a := e.attempts(); a[0].Status != "failed" || a[0].FailureCode != "cap_lowered" {
		t.Fatalf("attempts %+v", a)
	}
	if e.fake.Calls("ChargeOffSession") != 0 {
		t.Fatal("charged above the cap")
	}
}

// A tick walks every live consent page by page: with a batch of one, the accounts sorted
// before this one (other tests' consents in the shared database) do not starve it.
func TestCandidatesPagedNoStarvation(t *testing.T) {
	e := newEnv(t, opts{})
	other := newEnv(t, opts{}) // a second live consent in the same database
	_ = other
	j := autotopup.New(e.d, e.core, e.reg, e.in, e.clk, autotopup.Options{Enabled: true, Batch: 1})
	e.in.AttemptSettled = j.AttemptSettled
	j.Tick(ctx)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
}

// A prepared attempt abandoned by a crash is closed by the recovery, never sent.
func TestAbandonedPreparedClosed(t *testing.T) {
	e := newEnv(t, opts{})
	if _, err := e.job.Prepare(ctx, e.acc); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(3 * time.Minute)
	e.tick(0)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "failed" || a[0].FailureCode != autotopup.CodeAbandoned {
		t.Fatalf("attempts %+v", a)
	}
	if e.fake.Calls("ChargeOffSession") != 0 {
		t.Fatal("charged")
	}
}

// A consent given by a previous owner is revoked at dispatch.
func TestOwnerChangeRevokes(t *testing.T) {
	e := newEnv(t, opts{})
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET owner_id = $1 WHERE id = $2`, e.member, e.ws); err != nil {
		t.Fatal(err)
	}
	e.tick(0)
	if c := e.consentRow(); c.RevokedAt == nil || c.RevokedReason != "owner_changed" {
		t.Fatalf("consent %+v", c)
	}
	if len(e.attempts()) != 0 {
		t.Fatal("attempt")
	}
	// The explicit hook a future ownership transfer calls.
	e.consentAs(e.member)
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error { return autotopup.OwnerChanged(ctx, q, e.ws) }); err != nil {
		t.Fatal(err)
	}
	if c := e.consentRow(); c.RevokedAt == nil {
		t.Fatalf("consent %+v", c)
	}
}

// Deleting the workspace closes the account: no attempts, consent revoked, money history kept.
func TestWorkspaceDeleteClosesAccount(t *testing.T) {
	e := newEnv(t, opts{})
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		if err := core.CloseWorkspaceAccount(ctx, q, e.ws); err != nil {
			return err
		}
		_, err := q.DeleteWorkspace(ctx, e.ws)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	acc := e.account()
	if acc.Status != core.StatusClosed || acc.ClosedAt == nil || acc.WorkspaceID != nil || acc.NextDueAt != nil {
		t.Fatalf("account %+v", acc)
	}
	if e.consentRow().RevokedAt == nil {
		t.Fatal("consent")
	}
	e.tick(0)
	if e.count(`SELECT count(*) FROM billing_ledger WHERE account_id = $1`, e.acc) == 0 {
		t.Fatal("ledger gone")
	}
}

// Restore drill: the provider charged an attempt whose rows the restored database lacks. With
// the restore marker nothing new is charged until the reconcile; the reconcile imports the
// payment once and holds not_before; no second charge.
func TestRestoreDrillLostAttempt(t *testing.T) {
	marker := "drill-" + uuid.NewString()
	e := newEnv(t, opts{marker: marker})
	cust, err := e.d.Q.GetBillingCustomer(ctx, sqlc.GetBillingCustomerParams{AccountID: e.acc, Provider: "stripe", Livemode: false})
	if err != nil {
		t.Fatal(err)
	}
	pm, _ := e.d.Q.GetBillingPaymentMethod(ctx, e.pm)
	lost := uuid.New() // the attempt id the restored database forgot
	if _, err := e.fake.ChargeOffSession(ctx, provider.OffSessionReq{
		IdemKey: lost.String(), Customer: provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: cust.ProviderAccount, ID: cust.CustomerID},
		PaymentMethodID: pm.ProviderPmID, Amount: money.New(900, money.USD),
		Metadata: provider.Metadata{AccountID: e.acc, AttemptID: lost, Kind: provider.MetadataKindAutoTopup},
	}); err != nil {
		t.Fatal(err)
	}
	_ = e.fake.TakeWebhooks() // lost with the database
	e.tick(0)
	if paused, _ := e.job.Paused(ctx); !paused {
		t.Fatal("not paused")
	}
	e.reconcile(http.StatusOK)
	e.wantBalance(900)
	if paused, _ := e.job.Paused(ctx); paused {
		t.Fatal("still paused")
	}
	if paused, _ := e.newJob(marker).Paused(ctx); paused {
		t.Fatal("another instance still paused")
	}
	e.drain()
	e.tick(0) // not_before = the payment + 24 h
	if e.fake.Calls("ChargeOffSession") != 1 {
		t.Fatalf("charges %d", e.fake.Calls("ChargeOffSession"))
	}
	if n, sum := e.autoPayments(); n != 1 || sum != 900 {
		t.Fatalf("payments %d %d", n, sum)
	}
	e.reconcile(http.StatusOK) // a second run imports nothing
	if n, _ := e.autoPayments(); n != 1 {
		t.Fatal("imported twice")
	}
}

// Restore drill with the attempt row from before the fence (snapshot: prepared): the provider
// charged it; the recovery first closes it as abandoned, the reconcile finds the payment and
// the attempt becomes succeeded (a late success is not hidden), credited once.
func TestRestoreDrillPreparedAttempt(t *testing.T) {
	marker := "drill-" + uuid.NewString()
	e := newEnv(t, opts{marker: marker})
	open := autotopup.New(e.d, e.core, e.reg, e.in, e.clk, autotopup.Options{Enabled: true})
	att, err := open.Prepare(ctx, e.acc)
	if err != nil || att == nil {
		t.Fatal(err)
	}
	cust, _ := e.d.Q.GetBillingCustomer(ctx, sqlc.GetBillingCustomerParams{AccountID: e.acc, Provider: "stripe", Livemode: false})
	pm, _ := e.d.Q.GetBillingPaymentMethod(ctx, e.pm)
	if _, err := e.fake.ChargeOffSession(ctx, provider.OffSessionReq{
		IdemKey: att.ID.String(), Customer: provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: cust.ProviderAccount, ID: cust.CustomerID},
		PaymentMethodID: pm.ProviderPmID, Amount: money.New(att.AmountMinor, money.USD), Description: "Calab balance auto top-up",
		Metadata: provider.Metadata{AccountID: e.acc, AttemptID: att.ID, Kind: provider.MetadataKindAutoTopup},
	}); err != nil {
		t.Fatal(err)
	}
	_ = e.fake.TakeWebhooks()
	e.clk.Advance(3 * time.Minute)
	e.tick(0)
	if a := e.attempts(); a[0].Status != "failed" {
		t.Fatalf("attempts %+v", a)
	}
	e.reconcile(http.StatusOK)
	if a := e.attempts(); len(a) != 1 || a[0].Status != "succeeded" {
		t.Fatalf("attempts %+v", a)
	}
	e.wantBalance(900)
	if e.fake.Calls("ChargeOffSession") != 1 {
		t.Fatal("charged again")
	}
}

func (e *env) reconcile(want int) {
	e.t.Helper()
	var out v1.AdminBillingMutationResult
	req := &v1.AdminReconcileRequest{Reason: "restore drill", RequestId: uuid.NewString()}
	if st, r := e.do(e.owner, "POST", "/api/admin/billing/auto-topup/reconcile", req, &out); st != want {
		e.t.Fatalf("reconcile %d %s", st, r)
	}
	// A replay of the same request answers replayed.
	var again v1.AdminBillingMutationResult
	if st, _ := e.do(e.owner, "POST", "/api/admin/billing/auto-topup/reconcile", req, &again); st != want || (want == 200 && !again.GetReplayed()) {
		e.t.Fatalf("replay %d %+v", st, &again)
	}
}

func (e *env) consentAs(user uuid.UUID) {
	e.t.Helper()
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockBillingAccount(ctx, e.acc); err != nil {
			return err
		}
		_, err := q.UpsertBillingAutoTopupConsent(ctx, sqlc.UpsertBillingAutoTopupConsentParams{
			AccountID: e.acc, PmID: e.pm, MaxMinor: 50000, ConsentVersion: 1, ConsentBy: &user, Now: e.clk.Time(),
		})
		return err
	}); err != nil {
		e.t.Fatal(err)
	}
}
