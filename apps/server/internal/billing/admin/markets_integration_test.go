//go:build integration

package admin_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// marketsEnv is newEnv with Tochka (a fake under the tochka id) serving RU next to Stripe.
func marketsEnv(t *testing.T) *env {
	t.Helper()
	e := newEnv(t, 2)
	tochka := fake.New(fake.Options{ID: provider.Tochka, Account: "300123123"})
	reg, err := provider.NewRegistry("stripe:global,tochka:ru", provider.DefaultMatrix(), e.fp, tochka)
	if err != nil {
		t.Fatal(err)
	}
	h := admin.New(admin.Deps{
		DB: e.d, Core: e.c, Clock: e.clk, Providers: reg, ProviderSpec: "stripe:global,tochka:ru", Reconciler: e.rec,
		Committed: func(context.Context, sqlc.BillingAccount) { e.committed++ },
	})
	e.mux = newMux(e, h)
	_, _ = e.d.Pool.Exec(ctx, `DELETE FROM billing_provider_settings`)
	t.Cleanup(func() { _, _ = e.d.Pool.Exec(ctx, `DELETE FROM billing_provider_settings`) })
	return e
}

func (e *env) changeMarket(market string, rev uint64) (int, *v1.ApiError, *v1.AdminBillingMutationResult) {
	e.t.Helper()
	var res v1.AdminBillingMutationResult
	st, ae := e.call("POST", "/api/admin/billing/accounts/"+e.acc.String()+"/market",
		&v1.AdminChangeMarketRequest{RequestId: uuid.NewString(), Reason: "customer asked for RUB", Market: market, ExpectedRevision: rev}, &res)
	return st, ae, &res
}

func TestAdminChangeMarket(t *testing.T) {
	e := marketsEnv(t)
	e.enable()
	a := e.account()
	if a.Market != "global" {
		t.Fatalf("enabled in %s", a.Market)
	}
	rev := uint64(a.Revision) //nolint:gosec // revision >= 1 (CHECK)
	if st, ae, _ := e.changeMarket("ru", rev+5); st != 409 || ae.GetReason() != billing.ReasonRevisionConflict {
		t.Fatalf("stale revision: %d %v", st, ae)
	}
	st, ae, res := e.changeMarket("ru", rev)
	if st != 200 || res.GetAuditId() == "" {
		t.Fatalf("change: %d %v", st, ae)
	}
	a = e.account()
	if a.Market != "ru" || a.Currency != "RUB" || a.Provider != "tochka" {
		t.Fatalf("account %+v", a)
	}
	var raw []byte
	if err := e.d.Pool.QueryRow(ctx, `SELECT details FROM billing_audit WHERE id = $1`, uuid.MustParse(res.GetAuditId())).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var det struct {
		Target map[string]string       `json:"target"`
		Before struct{ Market string } `json:"before"`
		After  struct{ Market string } `json:"after"`
	}
	_ = json.Unmarshal(raw, &det)
	if det.Target["from"] != "global/USD/stripe" || det.Target["to"] != "ru/RUB/tochka" || det.Before.Market != "global" || det.After.Market != "ru" {
		t.Fatalf("audit %s", raw)
	}
	// After the first credit the market is fixed.
	e.c2ru()
	if st, ae, _ := e.changeMarket("global", 0); st != 409 || ae.GetReason() != billing.ReasonMarketFixed {
		t.Fatalf("after a credit: %d %v", st, ae)
	}
	if a := e.account(); a.Market != "ru" {
		t.Fatal("moved after a credit")
	}
}

// c2ru credits 150 ₽ to the account (a recorded tochka payment).
func (e *env) c2ru() {
	e.t.Helper()
	at := e.clk.Time()
	p, err := e.d.Q.InsertBillingPayment(ctx, sqlc.InsertBillingPaymentParams{AccountID: e.acc, Provider: "tochka",
		ProviderAccount: "300123123", Livemode: true, ProviderPaymentID: uuid.NewString(), AmountMinor: 15000, Currency: "RUB",
		Status: "succeeded", Origin: "import", SucceededAt: &at})
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.c.CreditPaymentTx(ctx, p.ID); err != nil {
		e.t.Fatal(err)
	}
}

func TestAdminChangeMarketClosedProvider(t *testing.T) {
	e := marketsEnv(t)
	e.enable()
	var res v1.AdminBillingMutationResult
	e.must("PUT", "/api/admin/billing/providers/tochka", &v1.AdminSetProviderRequest{RequestId: uuid.NewString(), Reason: "pause RU sales", AcceptNew: false}, &res)
	if st, ae, _ := e.changeMarket("ru", 0); st != 422 || ae.GetReason() != billing.ReasonMarketUnavailable {
		t.Fatalf("to a closed market: %d %v", st, ae)
	}
}

func TestAdminProviderSwitch(t *testing.T) {
	e := marketsEnv(t)
	var view v1.AdminBillingProviders
	e.must("GET", "/api/admin/billing/providers", nil, &view)
	if len(view.GetProviders()) != 2 || view.GetMode() != v1.BillingSalesMode_BILLING_SALES_MODE_BOTH || !view.GetProviders()[0].GetAcceptNew() {
		t.Fatalf("view %v", &view)
	}
	set := func(id string, open bool) *v1.AdminBillingMutationResult {
		t.Helper()
		var res v1.AdminBillingMutationResult
		e.must("PUT", "/api/admin/billing/providers/"+id, &v1.AdminSetProviderRequest{RequestId: uuid.NewString(), Reason: "sales decision", AcceptNew: open}, &res)
		return &res
	}
	if r := set("stripe", false); r.GetProviders().GetMode() != v1.BillingSalesMode_BILLING_SALES_MODE_RU_ONLY || r.GetAuditId() == "" {
		t.Fatalf("stripe closed: %v", r)
	}
	// Closing the last open one is allowed: contact mode.
	if r := set("tochka", false); r.GetProviders().GetMode() != v1.BillingSalesMode_BILLING_SALES_MODE_CONTACT {
		t.Fatalf("both closed: %v", r.GetProviders())
	}
	// A new account cannot be opened now.
	e.wantErr(422, billing.ReasonMarketUnavailable, "POST", "/api/admin/billing/workspaces/"+e.ws.String()+"/enable",
		&v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: uuid.NewString()})
	set("tochka", true)
	// Only RU open: an enable without a market opens RU.
	var res v1.AdminBillingMutationResult
	e.must("POST", "/api/admin/billing/workspaces/"+e.ws.String()+"/enable", &v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: uuid.NewString()}, &res)
	e.acc = uuid.MustParse(res.GetAccount().GetAccountId())
	if a := e.account(); a.Market != "ru" || a.Currency != "RUB" {
		t.Fatalf("enabled %s", a.Market)
	}
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM billing_audit WHERE action = 'provider_accept_new' AND details->'target'->>'provider' IN ('stripe', 'tochka')`).Scan(&n); err != nil || n < 3 {
		t.Fatalf("audit rows %d %v", n, err)
	}
	e.wantErr(404, "", "PUT", "/api/admin/billing/providers/paypal", &v1.AdminSetProviderRequest{RequestId: uuid.NewString(), Reason: "sales decision"})
}
