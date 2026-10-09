package provider

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/calaba/calaba/server/internal/billing/money"
)

// Markets of billing accounts (billing_accounts.market).
const (
	MarketGlobal = "global"
	MarketRU     = "ru"
)

// Payer types (billing_payers.type).
const (
	PayerPerson  = "person"
	PayerCompany = "company"
)

// AnyCountry matches every payer country in a matrix row.
const AnyCountry = "*"

// MethodOption is one way to pay offered to a payer (GET …/billing methods[]). POST
// …/topups re-validates its id against the matrix for the account (422 otherwise).
type MethodOption struct {
	ID               string // "{provider}:{method}", e.g. "stripe:card"
	Provider         ID
	Method           Method
	Currency         money.Currency
	Min, Max         int64 // minor units per manual top-up
	AutoTopupCapable bool  // the row allows auto-topup and the provider has CapOffSession|CapIdempotentCharge
}

// Row of the capability matrix.
type Row struct {
	Market     string
	Currency   money.Currency
	PayerTypes []string // empty = every payer type
	Country    string   // ISO alpha-2 or AnyCountry
	Provider   ID
	Method     Method
	Min, Max   int64
	AutoTopup  bool
}

// DefaultMatrix is the v1 matrix (owner decisions 2026-10-09): Global/USD, person or company,
// any country → Stripe card, $5..$5000 per manual top-up, auto-topup capable.
func DefaultMatrix() []Row {
	return []Row{{
		Market: MarketGlobal, Currency: money.USD, PayerTypes: []string{PayerPerson, PayerCompany},
		Country: AnyCountry, Provider: Stripe, Method: MethodCard, Min: 500, Max: 500000, AutoTopup: true,
	}}
}

// AutoTopupLimits are the owner cap bounds per attempt: the default cap and the largest one
// the owner may set (USD: $500 and $5000). ok = false: no auto-topup in this currency.
func AutoTopupLimits(cur money.Currency) (defaultMax, limitMax int64, ok bool) {
	if cur == money.USD {
		return 50000, 500000, true
	}
	return 0, 0, false
}

// Registry holds the configured providers and the capability matrix.
type Registry struct {
	providers map[ID]Provider
	markets   map[ID][]string // BILLING_PROVIDERS
	rows      []Row
}

var specPart = regexp.MustCompile(`^([a-z][a-z0-9_]{0,31}):(global|ru)$`)

// ParseSpec parses BILLING_PROVIDERS ("stripe:global" or "stripe:global,tochka:ru"): which
// provider serves which market. Empty = none.
func ParseSpec(spec string) (map[ID][]string, error) {
	out := map[ID][]string{}
	seen := map[string]ID{}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		m := specPart.FindStringSubmatch(part)
		if m == nil {
			return nil, fmt.Errorf("BILLING_PROVIDERS: %q is not provider:market (market global or ru)", part)
		}
		id, market := ID(m[1]), m[2]
		if other, dup := seen[market]; dup {
			return nil, fmt.Errorf("BILLING_PROVIDERS: market %s is served by %s and %s", market, other, id)
		}
		seen[market] = id
		out[id] = append(out[id], market)
	}
	return out, nil
}

// NewRegistry builds a registry from BILLING_PROVIDERS, the matrix rows and the providers
// that are configured (a spec entry without its provider offers nothing).
func NewRegistry(spec string, rows []Row, providers ...Provider) (*Registry, error) {
	markets, err := ParseSpec(spec)
	if err != nil {
		return nil, err
	}
	r := &Registry{providers: map[ID]Provider{}, markets: markets, rows: rows}
	for _, p := range providers {
		if p == nil {
			continue
		}
		if _, dup := r.providers[p.ID()]; dup {
			return nil, fmt.Errorf("billing: provider %s registered twice", p.ID())
		}
		r.providers[p.ID()] = p
	}
	return r, nil
}

// Provider returns a configured provider.
func (r *Registry) Provider(id ID) (Provider, bool) {
	p, ok := r.providers[id]
	return p, ok
}

// OffSession returns the provider as an off-session charger when it has the capabilities
// auto-topup needs (CapOffSession and CapIdempotentCharge).
func (r *Registry) OffSession(id ID) (OffSessionCharger, bool) {
	p, ok := r.providers[id]
	if !ok || !p.Caps().Has(CapOffSession|CapIdempotentCharge) {
		return nil, false
	}
	c, ok := p.(OffSessionCharger)
	return c, ok
}

// ProviderFor returns the provider serving a market (BILLING_PROVIDERS).
func (r *Registry) ProviderFor(market string) (Provider, bool) {
	for id, ms := range r.markets {
		if slices.Contains(ms, market) {
			return r.Provider(id)
		}
	}
	return nil, false
}

// Methods lists the options for an account's market / currency and the payer, in matrix
// order. Rows of providers that are not configured or not serving the market are left out;
// the hosted checkout capability is required for a manual top-up.
func (r *Registry) Methods(market string, cur money.Currency, payerType, country string) []MethodOption {
	var out []MethodOption
	for _, row := range r.rows {
		if row.Market != market || row.Currency != cur {
			continue
		}
		if len(row.PayerTypes) > 0 && payerType != "" && !slices.Contains(row.PayerTypes, payerType) {
			continue
		}
		if row.Country != AnyCountry && !strings.EqualFold(row.Country, country) {
			continue
		}
		p, ok := r.providers[row.Provider]
		if !ok || !slices.Contains(r.markets[row.Provider], market) || !p.Caps().Has(CapHostedCheckout) {
			continue
		}
		_, off := r.OffSession(row.Provider)
		out = append(out, MethodOption{
			ID: string(row.Provider) + ":" + string(row.Method), Provider: row.Provider, Method: row.Method,
			Currency: cur, Min: row.Min, Max: row.Max, AutoTopupCapable: row.AutoTopup && off,
		})
	}
	return out
}

// Method finds the option id among Methods (server-side re-validation of a client choice).
func (r *Registry) Method(id, market string, cur money.Currency, payerType, country string) (MethodOption, bool) {
	for _, o := range r.Methods(market, cur, payerType, country) {
		if o.ID == id {
			return o, true
		}
	}
	return MethodOption{}, false
}
