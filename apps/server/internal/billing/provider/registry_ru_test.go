package provider_test

import (
	"testing"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
)

// ADR-0083: RU / RUB offers Tochka card and SBP as two options, 150..500 000 ₽, no auto-topup.
func TestRegistryRUMatrix(t *testing.T) {
	stripe := fake.New(fake.Options{ID: provider.Stripe})
	tochka := fake.New(fake.Options{ID: provider.Tochka, Caps: provider.CapHostedCheckout | provider.CapRefund |
		provider.CapPartialRefund | provider.CapListPayments | provider.CapReconcilableCharge | provider.CapSuccessOnlyWebhooks})
	r, err := provider.NewRegistry("stripe:global,tochka:ru", provider.DefaultMatrix(), stripe, tochka)
	if err != nil {
		t.Fatal(err)
	}
	got := r.Methods(provider.MarketRU, money.RUB, provider.PayerCompany, "RU")
	if len(got) != 2 || got[0].ID != "tochka:card" || got[1].ID != "tochka:sbp" {
		t.Fatalf("%+v", got)
	}
	for _, o := range got {
		if o.Min != 15000 || o.Max != 50000000 || o.AutoTopupCapable || o.Currency != money.RUB {
			t.Fatalf("%+v", o)
		}
	}
	if got := r.Methods(provider.MarketGlobal, money.USD, provider.PayerPerson, "RU"); len(got) != 1 || got[0].ID != "stripe:card" {
		t.Fatalf("global: %+v", got)
	}
	if _, ok := r.OffSession(provider.Tochka); ok {
		t.Fatal("tochka admitted to off-session in phase 1")
	}
	if tochka.Caps().SafeRetry() || !stripe.Caps().SafeRetry() {
		t.Fatal("SafeRetry")
	}
	if p, ok := r.ProviderFor(provider.MarketRU); !ok || p.ID() != provider.Tochka {
		t.Fatal("ProviderFor ru")
	}
	// Without tochka:ru in BILLING_PROVIDERS RU offers nothing.
	r2, _ := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), stripe, tochka)
	if got := r2.Methods(provider.MarketRU, money.RUB, provider.PayerPerson, "RU"); len(got) != 0 {
		t.Fatalf("not served: %+v", got)
	}
}
