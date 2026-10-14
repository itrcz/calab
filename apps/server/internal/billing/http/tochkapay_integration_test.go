//go:build integration

package billinghttp_test

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka/tochkatest"
	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay/tochkapaytest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ADR-0083 phase 3: Tochka Pay Gateway (SBP binding) behind the real adapter and an in-memory
// test site, wired like BILLING_TOCHKA_SBP_BINDING_ENABLED=true.

func payEnv(t *testing.T) *env {
	t.Helper()
	return newEnv(t, envOpt{bank: tochkatest.New(t), payBank: tochkapaytest.New(t), market: "ru"})
}

func (e *env) payWebhook(body []byte) int {
	e.t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.srv.URL+"/api/billing/tochkapay/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "text/plain")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func (e *env) payEvents() int {
	return e.count(`SELECT count(*) FROM billing_provider_events WHERE provider = 'tochkapay' AND provider_account = $1`, tochkapaytest.Site)
}

func TestTochkaPayWiring(t *testing.T) {
	e := payEnv(t)
	// Manual top-up options are unchanged; the binder is there for RU / SBP.
	sum := e.summary()
	if len(sum.GetMethods()) != 2 || sum.GetMethods()[0].GetId() != "tochka:card" || sum.GetMethods()[1].GetId() != "tochka:sbp" {
		t.Fatalf("methods %v", sum.GetMethods())
	}
	if id, _, ok := e.reg.Binder(provider.MarketRU, money.RUB, provider.MethodSBP); !ok || id != provider.TochkaPay {
		t.Fatal("no binder")
	}
	if _, ok := e.reg.OffSession(provider.TochkaPay); ok {
		t.Fatal("off-session admitted before the no-repost dispatch")
	}
}

// A binding decision and an SBP token payment arrive by webhook: stored once, the token never
// stored, the payment re-read and credited once to the account of its customer.
func TestTochkaPayWebhooksCreditOnce(t *testing.T) {
	e := payEnv(t)
	cust, err := e.tochkaPay.EnsureCustomer(ctx, provider.CustomerReq{AccountID: e.acc})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{
		AccountID: e.acc, Provider: string(provider.TochkaPay), ProviderAccount: cust.ProviderAccount, Livemode: cust.Livemode, CustomerID: cust.ID,
	}); err != nil {
		t.Fatal(err)
	}
	bindingID := uuid.New()
	if _, err := e.tochkaPay.CreateBinding(ctx, provider.BindingReq{ID: bindingID, Customer: cust, ExpiresAt: time.Now().Add(15 * time.Minute),
		Metadata: provider.Metadata{AccountID: e.acc, Kind: provider.MetadataKindAutoTopup}}); err != nil {
		t.Fatal(err)
	}
	e.payBank.Decide(bindingID.String(), true)
	fact, err := e.tochkaPay.GetBinding(ctx, bindingID)
	if err != nil || fact.Status != provider.BindingAccepted {
		t.Fatalf("%+v %v", fact, err)
	}

	tokenHook := e.payBank.TokenWebhook(bindingID.String(), tochkapaytest.Site)
	if st := e.payWebhook(tokenHook); st != 200 {
		t.Fatalf("token webhook: %d", st)
	}
	if st := e.payWebhook(tokenHook); st != 200 || e.payEvents() != 1 {
		t.Fatalf("redelivery: %d events=%d", st, e.payEvents())
	}
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider = 'tochkapay' AND (payload::text LIKE '%' || $1 || '%' OR object_id = $1)`, fact.Method.ID); n != 0 {
		t.Fatal("binding token stored in the inbox")
	}

	before := e.account().BalanceMinor
	key := uuid.New()
	pay, err := e.tochkaPay.ChargeOffSession(ctx, provider.OffSessionReq{IdemKey: key.String(), Customer: cust, PaymentMethodID: fact.Method.ID,
		Amount: money.New(50000, money.RUB), Metadata: provider.Metadata{AccountID: e.acc, AttemptID: key, Kind: provider.MetadataKindAutoTopup}})
	if err != nil || pay.Status != provider.PaymentSucceeded {
		t.Fatalf("%+v %v", pay, err)
	}
	hook := e.payBank.PaymentWebhook(key.String())
	for range 2 {
		if st := e.payWebhook(hook); st != 200 {
			t.Fatalf("payment webhook: %d", st)
		}
	}
	e.process()
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider = 'tochkapay' AND error <> '' AND object_id IN ($1, $2)`,
		key.String(), bindingID.String()); n != 0 {
		t.Fatalf("event errors: %d", n)
	}
	if n := e.count(`SELECT count(*) FROM billing_payments WHERE provider = 'tochkapay' AND provider_payment_id = $1 AND status = 'succeeded' AND amount_minor = 50000`, key.String()); n != 1 {
		t.Fatalf("payments %d", n)
	}
	if got := e.account().BalanceMinor; got != before+50000 {
		t.Fatalf("balance %d -> %d", before, got)
	}

	// Bad signature: 400, nothing stored. Another site: stored as ignored, 200.
	n := e.payEvents()
	if st := e.payWebhook(tochkapaytest.ForeignSignedWebhook(t)); st != 400 || e.payEvents() != n {
		t.Fatalf("bad signature: %d", st)
	}
	if st := e.payWebhook(e.payBank.TokenWebhook(bindingID.String(), "other-site")); st != 200 {
		t.Fatalf("foreign site: %d", st)
	}
	if k := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider = 'tochkapay' AND kind = 'ignored'`); k < 1 {
		t.Fatal("foreign webhook not stored as ignored")
	}
	// A live payment on a test site config: refused.
	e.payBank.Live = true
	if st := e.payWebhook(e.payBank.PaymentWebhook(key.String())); st != 400 {
		t.Fatalf("live on test config: %d", st)
	}
}
