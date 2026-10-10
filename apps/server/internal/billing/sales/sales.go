// Package sales decides which markets a NEW billing account may be opened in (ADR-0083): a
// market is open when its provider is configured (env: BILLING_STRIPE_ENABLED /
// BILLING_TOCHKA_ENABLED and BILLING_PROVIDERS) and the superadmin has not closed it for new
// clients (billing_provider_settings.accept_new, a runtime switch). An account whose market is
// fixed by a payment keeps its provider whatever this says.
//
// Modes: both markets open, only RU, only Global, or none («contact»: paid plans are sold by
// contacting us; prices are shown from the Global catalog).
package sales

import (
	"context"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Markets in the order the UI shows them (Global first).
var allMarkets = []string{provider.MarketGlobal, provider.MarketRU}

// Querier is the part of sqlc.Queries sales reads.
type Querier interface {
	ListBillingProviderSettings(ctx context.Context) ([]sqlc.BillingProviderSetting, error)
}

// Sales answers which markets are open for new accounts.
type Sales struct {
	reg *provider.Registry
}

// New creates the sales view over the configured providers (nil registry: nothing open).
func New(reg *provider.Registry) *Sales { return &Sales{reg: reg} }

// ProviderOf is the configured provider serving market (BILLING_PROVIDERS), "" if none.
func (s *Sales) ProviderOf(market string) provider.ID {
	if s == nil || s.reg == nil {
		return ""
	}
	p, ok := s.reg.ProviderFor(market)
	if !ok {
		return ""
	}
	return p.ID()
}

// Served are the markets with a configured provider (open or closed for new clients).
func (s *Sales) Served() []string {
	var out []string
	for _, m := range allMarkets {
		if s.ProviderOf(m) != "" {
			out = append(out, m)
		}
	}
	return out
}

// AcceptsNew reads the superadmin switches: provider → accepts new clients. A provider without
// a row accepts them.
func AcceptsNew(ctx context.Context, q Querier) (map[provider.ID]bool, error) {
	rows, err := q.ListBillingProviderSettings(ctx)
	if err != nil {
		return nil, err
	}
	out := map[provider.ID]bool{}
	for _, r := range rows {
		out[provider.ID(r.Provider)] = r.AcceptNew
	}
	return out, nil
}

// Open are the markets a new account may be opened in now, Global first.
func (s *Sales) Open(ctx context.Context, q Querier) ([]string, error) {
	accept, err := AcceptsNew(ctx, q)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range s.Served() {
		if open, set := accept[s.ProviderOf(m)]; !set || open {
			out = append(out, m)
		}
	}
	return out, nil
}

// IsOpen reports whether market is open for new accounts.
func (s *Sales) IsOpen(ctx context.Context, q Querier, market string) (bool, error) {
	open, err := s.Open(ctx, q)
	if err != nil {
		return false, err
	}
	for _, m := range open {
		if m == market {
			return true, nil
		}
	}
	return false, nil
}

// Mode of a set of open markets.
func Mode(open []string) v1.BillingSalesMode {
	ru, global := false, false
	for _, m := range open {
		switch m {
		case provider.MarketRU:
			ru = true
		case provider.MarketGlobal:
			global = true
		}
	}
	switch {
	case ru && global:
		return v1.BillingSalesMode_BILLING_SALES_MODE_BOTH
	case ru:
		return v1.BillingSalesMode_BILLING_SALES_MODE_RU_ONLY
	case global:
		return v1.BillingSalesMode_BILLING_SALES_MODE_GLOBAL_ONLY
	}
	return v1.BillingSalesMode_BILLING_SALES_MODE_CONTACT
}

// CatalogMarkets are the markets whose prices are shown to a new client: the open ones, or the
// Global catalog in contact mode.
func CatalogMarkets(open []string) []string {
	if len(open) == 0 {
		return []string{provider.MarketGlobal}
	}
	return open
}

// DefaultMarket is the market the server picks without an explicit choice: the only open one,
// else Global (the client preselects by language only when both are open).
func DefaultMarket(open []string) string {
	if len(open) == 1 {
		return open[0]
	}
	return provider.MarketGlobal
}
