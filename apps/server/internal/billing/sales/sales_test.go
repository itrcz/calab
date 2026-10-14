package sales

import (
	"context"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

type rows []sqlc.BillingProviderSetting

func (r rows) ListBillingProviderSettings(context.Context) ([]sqlc.BillingProviderSetting, error) {
	return r, nil
}

func TestOpenMarkets(t *testing.T) {
	reg, err := provider.NewRegistry("stripe:global,tochka:ru", provider.DefaultMatrix(),
		fake.New(fake.Options{ID: provider.Stripe}), fake.New(fake.Options{ID: provider.Tochka}))
	if err != nil {
		t.Fatal(err)
	}
	s := New(reg)
	ctx := context.Background()
	for _, c := range []struct {
		name    string
		rows    rows
		mode    v1.BillingSalesMode
		def     string
		catalog []string
	}{
		{"no rows", nil, v1.BillingSalesMode_BILLING_SALES_MODE_BOTH, "global", []string{"global", "ru"}},
		{"stripe closed", rows{{Provider: "stripe", AcceptNew: false}}, v1.BillingSalesMode_BILLING_SALES_MODE_RU_ONLY, "ru", []string{"ru"}},
		{"tochka closed", rows{{Provider: "tochka", AcceptNew: false}, {Provider: "stripe", AcceptNew: true}}, v1.BillingSalesMode_BILLING_SALES_MODE_GLOBAL_ONLY, "global", []string{"global"}},
		{"both closed", rows{{Provider: "tochka"}, {Provider: "stripe"}}, v1.BillingSalesMode_BILLING_SALES_MODE_CONTACT, "global", []string{"global"}},
	} {
		open, err := s.Open(ctx, c.rows)
		if err != nil {
			t.Fatal(err)
		}
		cat := CatalogMarkets(open)
		if Mode(open) != c.mode || DefaultMarket(open) != c.def || len(cat) != len(c.catalog) || cat[0] != c.catalog[0] {
			t.Errorf("%s: open %v mode %v def %s catalog %v", c.name, open, Mode(open), DefaultMarket(open), cat)
		}
	}
	// Only Stripe configured: RU is not served at all.
	one, _ := provider.NewRegistry("stripe:global", provider.DefaultMatrix(), fake.New(fake.Options{ID: provider.Stripe}))
	if open, _ := New(one).Open(ctx, rows(nil)); len(open) != 1 || open[0] != "global" {
		t.Fatalf("%v", open)
	}
	if New(nil).Served() != nil {
		t.Fatal("nil registry serves")
	}
}
