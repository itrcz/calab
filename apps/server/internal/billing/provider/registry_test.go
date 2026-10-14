package provider_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
)

func TestParseSpec(t *testing.T) {
	got, err := provider.ParseSpec(" stripe:global , tochka:ru")
	if err != nil || len(got) != 2 || got[provider.Stripe][0] != "global" || got[provider.Tochka][0] != "ru" {
		t.Fatalf("%v %v", got, err)
	}
	if got, err := provider.ParseSpec(""); err != nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	for _, bad := range []string{"stripe", "stripe:eu", "Stripe:global", "stripe:global,fake:global"} {
		if _, err := provider.ParseSpec(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestRegistryV1Matrix(t *testing.T) {
	stripe := fake.New(fake.Options{ID: provider.Stripe})
	r, err := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), stripe)
	if err != nil {
		t.Fatal(err)
	}
	for _, payer := range []string{provider.PayerPerson, provider.PayerCompany, provider.PayerSoleProprietor} {
		got := r.Methods(provider.MarketGlobal, money.USD, payer, "AE")
		if len(got) != 1 {
			t.Fatalf("%s: %v", payer, got)
		}
		o := got[0]
		if o.ID != "stripe:card" || o.Provider != provider.Stripe || o.Method != provider.MethodCard || o.Min != 500 || o.Max != 500000 || !o.AutoTopupCapable {
			t.Fatalf("%s: %+v", payer, o)
		}
	}
	if got := r.Methods(provider.MarketRU, money.RUB, provider.PayerPerson, "RU"); len(got) != 0 {
		t.Fatalf("RUB offered in v1: %v", got)
	}
	if got := r.Methods(provider.MarketGlobal, money.USD, "trust", "US"); len(got) != 0 {
		t.Fatalf("unknown payer type offered: %v", got)
	}
	if _, ok := r.Method("stripe:card", provider.MarketGlobal, money.USD, provider.PayerPerson, "US"); !ok {
		t.Fatal("stripe:card not re-validated")
	}
	if _, ok := r.Method("stripe:sbp", provider.MarketGlobal, money.USD, provider.PayerPerson, "US"); ok {
		t.Fatal("unknown method accepted")
	}
	if p, ok := r.ProviderFor(provider.MarketGlobal); !ok || p.ID() != provider.Stripe {
		t.Fatal("global provider")
	}
	if _, ok := r.OffSession(provider.Stripe); !ok {
		t.Fatal("stripe fake is an off-session charger")
	}
	def, limit, ok := provider.AutoTopupLimits(money.USD)
	if !ok || def != 50000 || limit != 500000 {
		t.Fatalf("auto-topup limits %d %d %v", def, limit, ok)
	}
	if def, limit, ok := provider.AutoTopupLimits(money.RUB); !ok || def != 5000000 || limit != provider.RUBTopupMax {
		t.Fatalf("RUB auto-topup limits %d %d %v", def, limit, ok)
	}
}

func TestRegistryCapabilities(t *testing.T) {
	// Without the idempotent-charge capability there is no auto-topup (Tochka rule).
	noIdem := fake.New(fake.Options{ID: provider.Stripe, Caps: provider.CapHostedCheckout | provider.CapOffSession})
	r, err := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), noIdem)
	if err != nil {
		t.Fatal(err)
	}
	got := r.Methods(provider.MarketGlobal, money.USD, provider.PayerPerson, "US")
	if len(got) != 1 || got[0].AutoTopupCapable {
		t.Fatalf("%v", got)
	}
	// A provider not in BILLING_PROVIDERS, or not configured, offers nothing.
	r, _ = provider.NewRegistry("", provider.DefaultMatrix(), fake.New(fake.Options{ID: provider.Stripe}))
	if got := r.Methods(provider.MarketGlobal, money.USD, provider.PayerPerson, "US"); len(got) != 0 {
		t.Fatalf("unlisted provider offered: %v", got)
	}
	r, _ = provider.NewRegistry("stripe:global", provider.DefaultMatrix())
	if got := r.Methods(provider.MarketGlobal, money.USD, provider.PayerPerson, "US"); len(got) != 0 {
		t.Fatalf("unconfigured provider offered: %v", got)
	}
	if _, err := provider.NewRegistry("", nil, fake.New(fake.Options{}), fake.New(fake.Options{})); err == nil {
		t.Fatal("duplicate provider accepted")
	}
}

func TestMetadataRoundTrip(t *testing.T) {
	m := provider.Metadata{AccountID: uuid.New(), AttemptID: uuid.New(), RefundID: uuid.New(), Kind: provider.MetadataKindAutoTopup}
	kv := m.Map()
	if _, ok := kv[provider.MetaCheckoutID]; ok {
		t.Fatal("unset id rendered")
	}
	if got := provider.ParseMetadata(kv); got != m {
		t.Fatalf("%+v != %+v", got, m)
	}
	if got := provider.ParseMetadata(map[string]string{provider.MetaAccountID: "nope"}); got.AccountID != uuid.Nil {
		t.Fatal("malformed id parsed")
	}
}
