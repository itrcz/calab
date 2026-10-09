//go:build integration

package billinghttp_test

import (
	"context"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Checkout completed, payment_intent.succeeded and charge.succeeded of one payment, each
// delivered three times in random order and processed in two rounds: one payment row, one
// funding lot, one top-up entry, one mail.
func TestWebhookEventsCreditOnce(t *testing.T) {
	e := newEnv(t)
	_, sess := e.topup(2500, false)
	pay, err := e.fake.CompleteCheckout(sess, fake.Succeed)
	if err != nil {
		t.Fatal(err)
	}
	hooks := e.fake.TakeWebhooks()
	// A charge.succeeded of the same payment (the fake does not emit one): ch_ object, pi_ ref.
	hooks = append(hooks, e.fake.Sign(provider.Event{Provider: provider.Stripe, ProviderAccount: e.merchant, EventID: "evt_" + uuid.NewString(),
		Kind: provider.EventPaymentSucceeded, Type: "charge.succeeded", ObjectID: pay.ChargeID, PaymentID: pay.ID, Created: time.Now()}))
	if len(hooks) < 3 {
		t.Fatalf("want ≥ 3 events, got %d", len(hooks))
	}
	var all []fake.Webhook
	for range 3 {
		all = append(all, hooks...)
	}
	rand.Shuffle(len(all), func(i, j int) { all[i], all[j] = all[j], all[i] }) //nolint:gosec // test order, not a secret
	for i, w := range all {
		if st := e.webhook(w); st != http.StatusOK {
			t.Fatalf("delivery %d: %d", i, st)
		}
		if i == len(all)/2 {
			e.process() // half processed, the rest arrives after
		}
	}
	e.process()
	e.process()
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider_account = $1`, e.merchant); n != len(hooks) {
		t.Fatalf("inbox rows %d, want %d (dedup by event id)", n, len(hooks))
	}
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider_account = $1 AND (processed_at IS NULL OR error <> '')`, e.merchant); n != 0 {
		t.Fatalf("%d events unprocessed or failed: %v", n, e.eventErrors())
	}
	acc := e.account()
	if acc.BalanceMinor != 2500 || e.lots() != 1 {
		t.Fatalf("balance %d lots %d, want 2500 / 1", acc.BalanceMinor, e.lots())
	}
	if n := e.count(`SELECT count(*) FROM billing_payments WHERE account_id = $1 AND status = 'succeeded' AND origin = 'checkout'`, e.acc); n != 1 {
		t.Fatalf("payments %d", n)
	}
	if n := e.count(`SELECT count(*) FROM billing_ledger WHERE account_id = $1 AND kind = 'topup'`, e.acc); n != 1 {
		t.Fatalf("top-up entries %d", n)
	}
	if n := e.notifications("payment:"); n != 1 {
		t.Fatalf("payment mails %d", n)
	}
	if n := e.count(`SELECT count(*) FROM mail_outbox o JOIN billing_notifications b ON b.mail_id = o.id WHERE b.account_id = $1 AND o.template = 'billing_payment_received' AND o.expires_at > now() + interval '6 days'`, e.acc); n != 1 {
		t.Fatalf("queued financial mails %d (7 d lifetime)", n)
	}
	var co v1.CheckoutStatus
	if st, _ := e.do(e.owner, "GET", e.base()+"/checkouts/"+mustCheckout(t, e), nil, &co); st != 200 || !co.GetCredited() ||
		co.GetState() != v1.CheckoutState_CHECKOUT_STATE_COMPLETED {
		t.Fatalf("checkout status %d %v", st, &co)
	}
}

func mustCheckout(t *testing.T, e *env) string {
	t.Helper()
	var id uuid.UUID
	if err := e.d.Pool.QueryRow(ctx, `SELECT id FROM billing_checkouts WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, e.acc).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id.String()
}

// A body that does not match its signature is 400 and nothing is stored; a redelivery is
// 200 and stored once.
func TestWebhookSignature(t *testing.T) {
	e := newEnv(t)
	_, sess := e.topup(1000, false)
	if _, err := e.fake.CompleteCheckout(sess, fake.Succeed); err != nil {
		t.Fatal(err)
	}
	w := e.fake.TakeWebhooks()[0]
	bad := w
	bad.Body = []byte(strings.Replace(string(w.Body), `"livemode":false`, `"livemode":false `, 1))
	if st := e.webhook(bad); st != http.StatusBadRequest {
		t.Fatalf("tampered body: %d", st)
	}
	forged := fake.Webhook{Header: http.Header{}, Body: w.Body}
	forged.Header.Set(fake.SignatureHeader, strings.Repeat("ab", 32))
	if st := e.webhook(forged); st != http.StatusBadRequest {
		t.Fatalf("forged signature: %d", st)
	}
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider_account = $1`, e.merchant); n != 0 {
		t.Fatalf("stored %d events from bad deliveries", n)
	}
	for range 2 {
		if st := e.webhook(w); st != http.StatusOK {
			t.Fatalf("valid delivery: %d", st)
		}
	}
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider_account = $1`, e.merchant); n != 1 {
		t.Fatalf("stored %d, want 1", n)
	}
	// Too large a body is refused before verification.
	big := fake.Webhook{Header: w.Header, Body: make([]byte, 300<<10)}
	if st := e.webhook(big); st != http.StatusRequestEntityTooLarge {
		t.Fatalf("large body: %d", st)
	}
}

// A payment of a customer that is not ours, in another currency, or of the other mode never
// credits: the event is recorded with its error and not retried.
func TestWebhookMismatchesNeverCredit(t *testing.T) {
	e := newEnv(t)
	e.paid(1000) // creates our customer mapping
	cust, err := e.d.Q.GetBillingCustomer(ctx, sqlc.GetBillingCustomerParams{AccountID: e.acc, Provider: "stripe", Livemode: false})
	if err != nil {
		t.Fatal(err)
	}
	ours := provider.CustomerRef{Provider: provider.Stripe, ProviderAccount: e.merchant, ID: cust.CustomerID}

	// 1. Another customer of the same merchant (no mapping), with our account in the metadata.
	other, err := e.fake.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "customer:" + uuid.NewString(), AccountID: uuid.New()})
	if err != nil {
		t.Fatal(err)
	}
	e.payOutside(other, money.New(700, money.USD), provider.Metadata{AccountID: e.acc, Kind: provider.MetadataKindCheckout})
	// 2. Our customer, another currency.
	e.payOutside(ours, money.New(800, money.RUB), provider.Metadata{AccountID: e.acc})
	// 3. Our customer's id, but a livemode object (the mapping is per mode).
	live := fake.New(fake.Options{ID: provider.Stripe, Account: e.merchant, Livemode: true, AllowLivemode: true})
	liveCust, _ := live.EnsureCustomer(ctx, provider.CustomerReq{IdemKey: "c", AccountID: e.acc})
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_customers (account_id, provider, provider_account, livemode, customer_id)
		SELECT id, 'stripe', $2, false, $3 FROM billing_accounts WHERE id = $1 ON CONFLICT DO NOTHING`, e.acc, e.merchant, liveCust.ID); err != nil {
		t.Fatal(err)
	}
	livePay := e.payWith(live, liveCust, money.New(900, money.USD))
	// The live event is checked by a fresh read through the live fake (same provider id): the
	// mapping lookup includes livemode, so the test-mode row does not match.
	_ = livePay

	e.process()
	acc := e.account()
	if acc.BalanceMinor != 1000 || e.lots() != 1 {
		t.Fatalf("balance %d lots %d: a mismatched payment was credited", acc.BalanceMinor, e.lots())
	}
	errs := strings.Join(e.eventErrors(), "\n")
	for _, want := range []string{"no local customer", "does not match the account"} {
		if !strings.Contains(errs, want) {
			t.Errorf("errors %q: missing %q", errs, want)
		}
	}
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider_account = $1 AND processed_at IS NULL`, e.merchant); n != 0 {
		t.Fatalf("%d mismatched events left for retry", n)
	}
	// Livemode: the inbox applying the live fact directly finds no mapping.
	fact, err := live.GetPayment(ctx, livePay)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.in.ApplyPaymentFact(ctx, live, fact); err == nil || !strings.Contains(err.Error(), "no local customer") {
		t.Fatalf("live payment: %v", err)
	}
	if e.lots() != 1 {
		t.Fatal("livemode payment credited")
	}
}

// payOutside creates a succeeded payment on the fake for cust (as if paid outside our
// checkout) and delivers its webhooks.
func (e *env) payOutside(cust provider.CustomerRef, amount money.Money, meta provider.Metadata) string {
	e.t.Helper()
	sess, err := e.fake.CreateCheckout(ctx, provider.CheckoutReq{IdemKey: uuid.NewString(), Amount: amount, Method: provider.MethodCard, Customer: cust, Metadata: meta})
	if err != nil {
		e.t.Fatal(err)
	}
	pay, err := e.fake.CompleteCheckout(sess.ID, fake.Succeed)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, w := range e.fake.TakeWebhooks() {
		if st := e.webhook(w); st != 200 {
			e.t.Fatalf("webhook %d", st)
		}
	}
	return pay.ID
}

func (e *env) payWith(p *fake.Provider, cust provider.CustomerRef, amount money.Money) string {
	e.t.Helper()
	sess, err := p.CreateCheckout(ctx, provider.CheckoutReq{IdemKey: uuid.NewString(), Amount: amount, Method: provider.MethodCard, Customer: cust})
	if err != nil {
		e.t.Fatal(err)
	}
	pay, err := p.CompleteCheckout(sess.ID, fake.Succeed)
	if err != nil {
		e.t.Fatal(err)
	}
	return pay.ID
}

// The success redirect's pull-sync and the webhook worker race on one payment: one credit.
func TestPullSyncRacesWebhook(t *testing.T) {
	e := newEnv(t)
	cid, sess := e.topup(4000, false)
	if _, err := e.fake.CompleteCheckout(sess, fake.Succeed); err != nil {
		t.Fatal(err)
	}
	hooks := e.fake.TakeWebhooks()
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var co v1.CheckoutStatus
			if st, r := e.do(e.owner, "GET", e.base()+"/checkouts/"+cid.String(), nil, &co); st != 200 {
				t.Errorf("pull %d: %d %s", i, st, r)
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for _, w := range hooks {
			e.webhook(w)
		}
		_, _ = e.in.ProcessOnce(context.Background())
	}()
	wg.Wait()
	e.process()
	if acc := e.account(); acc.BalanceMinor != 4000 || e.lots() != 1 {
		t.Fatalf("balance %d lots %d", acc.BalanceMinor, e.lots())
	}
	if n := e.notifications("payment:"); n != 1 {
		t.Fatalf("payment mails %d", n)
	}
}

// A refund made in the provider dashboard is imported once (refund.updated three times):
// origin dashboard, the money leaves the balance, one mail.
func TestDashboardRefundImportedOnce(t *testing.T) {
	e := newEnv(t)
	_, pi := e.paid(3000)
	if _, err := e.fake.DashboardRefund(pi, 1200); err != nil {
		t.Fatal(err)
	}
	hooks := e.fake.TakeWebhooks()
	for range 3 {
		for _, w := range hooks {
			e.webhook(w)
		}
	}
	e.process()
	if n := e.count(`SELECT count(*) FROM billing_refunds WHERE account_id = $1 AND origin = 'dashboard' AND status = 'succeeded' AND amount_minor = 1200`, e.acc); n != 1 {
		t.Fatalf("dashboard refunds %d: %v", n, e.eventErrors())
	}
	if acc := e.account(); acc.BalanceMinor != 1800 {
		t.Fatalf("balance %d, want 1800", acc.BalanceMinor)
	}
	if n := e.count(`SELECT count(*) FROM billing_ledger WHERE account_id = $1 AND kind = 'refund'`, e.acc); n != 1 {
		t.Fatalf("refund entries %d", n)
	}
	if n := e.count(`SELECT refunded_minor FROM billing_payments WHERE account_id = $1`, e.acc); n != 1200 {
		t.Fatalf("payment refunded %d", n)
	}
	if n := e.notifications("refund:"); n != 1 {
		t.Fatalf("refund mails %d", n)
	}
}

// disputes wraps the fake with a provider.DisputeReader whose status the test sets.
type disputes struct {
	*fake.Provider
	mu     sync.Mutex
	status map[string]provider.DisputeStatus
	amount map[string]money.Money
	pay    map[string]string
}

func (d *disputes) GetDispute(_ context.Context, id string) (provider.DisputeFact, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	st, ok := d.status[id]
	if !ok {
		return provider.DisputeFact{}, provider.ErrNotFound
	}
	return provider.DisputeFact{ID: id, PaymentID: d.pay[id], Amount: d.amount[id], Status: st}, nil
}

func (d *disputes) set(id, pi string, amount money.Money, st provider.DisputeStatus) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status[id], d.amount[id], d.pay[id] = st, amount, pi
}

// A dispute takes its amount off the balance once and holds the account; won, the money
// comes back and the hold ends.
func TestDisputeOpenedWon(t *testing.T) {
	var dr *disputes
	e := newEnv(t, envOpt{wrap: func(f *fake.Provider) provider.Provider {
		dr = &disputes{Provider: f, status: map[string]provider.DisputeStatus{}, amount: map[string]money.Money{}, pay: map[string]string{}}
		return dr
	}})
	_, pi := e.paid(2000)
	dp, err := e.fake.OpenDispute(pi)
	if err != nil {
		t.Fatal(err)
	}
	dr.set(dp, pi, money.New(2000, money.USD), provider.DisputeOpen)
	open := e.fake.TakeWebhooks()
	for range 2 {
		for _, w := range open {
			e.webhook(w)
		}
	}
	e.process()
	acc := e.account()
	if acc.BalanceMinor != 0 || !acc.DisputeHold {
		t.Fatalf("after open: balance %d hold %t (%v)", acc.BalanceMinor, acc.DisputeHold, e.eventErrors())
	}
	if n := e.count(`SELECT count(*) FROM billing_disputes WHERE account_id = $1 AND status = 'open'`, e.acc); n != 1 {
		t.Fatalf("open disputes %d", n)
	}
	dr.set(dp, pi, money.New(2000, money.USD), provider.DisputeWon)
	e.fake.CloseDispute(dp, pi)
	for _, w := range e.fake.TakeWebhooks() {
		e.webhook(w)
		e.webhook(w)
	}
	e.process()
	acc = e.account()
	if acc.BalanceMinor != 2000 || acc.DisputeHold {
		t.Fatalf("after won: balance %d hold %t", acc.BalanceMinor, acc.DisputeHold)
	}
	if n := e.count(`SELECT count(*) FROM billing_disputes WHERE account_id = $1 AND status = 'closed' AND outcome = 'won'`, e.acc); n != 1 {
		t.Fatalf("won disputes %d", n)
	}
	if n := e.count(`SELECT count(*) FROM billing_ledger WHERE account_id = $1 AND kind IN ('dispute', 'dispute_reversal')`, e.acc); n != 2 {
		t.Fatalf("dispute entries %d", n)
	}
	if n := e.notifications("dispute:"); n != 1 {
		t.Fatalf("dispute mails %d", n)
	}
}

// A checkout with save_method stores the card (for T7), listed for the owner; deleting it
// detaches it at the provider and revokes nothing else.
func TestSavedCard(t *testing.T) {
	e := newEnv(t)
	_, sess := e.topup(1500, true)
	if _, err := e.fake.CompleteCheckout(sess, fake.Succeed); err != nil {
		t.Fatal(err)
	}
	for _, w := range e.fake.TakeWebhooks() {
		e.webhook(w)
	}
	e.process()
	var ms v1.SavedPaymentMethods
	if st, _ := e.do(e.owner, "GET", e.base()+"/payment-methods", nil, &ms); st != 200 || len(ms.GetMethods()) != 1 ||
		ms.GetMethods()[0].GetLast4() != "4242" || ms.GetMethods()[0].GetKind() != v1.PaymentMethodKind_PAYMENT_METHOD_KIND_CARD {
		t.Fatalf("methods %d %v", st, &ms)
	}
	id := ms.GetMethods()[0].GetId()
	if st, _ := e.do(e.member, "DELETE", e.base()+"/payment-methods/"+id, nil, nil); st != 403 {
		t.Fatalf("member delete: %d", st)
	}
	if st, r := e.do(e.owner, "DELETE", e.base()+"/payment-methods/"+id, nil, nil); st != 204 {
		t.Fatalf("delete: %d %s", st, r)
	}
	if e.fake.Calls("DetachMethod") != 1 {
		t.Fatal("not detached at the provider")
	}
	if st, _ := e.do(e.owner, "GET", e.base()+"/payment-methods", nil, &ms); st != 200 || len(ms.GetMethods()) != 0 {
		t.Fatalf("after delete: %v", &ms)
	}
	// The detach webhook is a no-op now.
	for _, w := range e.fake.TakeWebhooks() {
		e.webhook(w)
	}
	e.process()
	if errs := e.eventErrors(); len(errs) != 0 {
		t.Fatal(errs)
	}
}

// Reconciliation finds a payment whose webhooks never arrived (import by customer) and an
// expired checkout.
func TestReconcileImportsLostPayment(t *testing.T) {
	e := newEnv(t)
	_, sess := e.topup(1100, false)
	if _, err := e.fake.CompleteCheckout(sess, fake.Succeed); err != nil {
		t.Fatal(err)
	}
	e.fake.TakeWebhooks() // lost
	e.in.Import(ctx)
	if acc := e.account(); acc.BalanceMinor != 1100 || e.lots() != 1 {
		t.Fatalf("import: balance %d lots %d", acc.BalanceMinor, e.lots())
	}
	e.in.Import(ctx)
	if e.lots() != 1 {
		t.Fatal("imported twice")
	}
	_, sess2 := e.topup(600, false)
	if err := e.fake.ExpireCheckout(sess2); err != nil {
		t.Fatal(err)
	}
	e.fake.TakeWebhooks()
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_checkouts SET created_at = now() - interval '2 hours' WHERE account_id = $1 AND status = 'open'`, e.acc); err != nil {
		t.Fatal(err)
	}
	e.in.Reconcile(ctx)
	if n := e.count(`SELECT count(*) FROM billing_checkouts WHERE account_id = $1 AND status = 'expired'`, e.acc); n != 1 {
		t.Fatalf("expired checkouts %d", n)
	}
}
