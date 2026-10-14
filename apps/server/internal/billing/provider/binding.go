package provider

import (
	"context"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
)

// TochkaPay is the Tochka Pay Gateway («Приём платежей», ADR-0083 phase 3): SBP account binding
// and charges by the binding token. It is a separate provider from Tochka (payment links): its
// own site id, request signature, statuses and webhooks. It never serves a market's manual
// top-up (no CapHostedCheckout), so it is not named in BILLING_PROVIDERS: its matrix row
// (SBPBindingRow) is added when BILLING_TOCHKA_SBP_BINDING_ENABLED is on.
const TochkaPay ID = "tochkapay"

// BindingStatus of an account binding (an SBP subscription token at the payer's bank).
type BindingStatus string

// Binding statuses. Only BindingAccepted carries a token.
const (
	BindingPending  BindingStatus = "pending" // the payer has not decided yet (or the bank has not told us)
	BindingAccepted BindingStatus = "accepted"
	BindingRejected BindingStatus = "rejected" // refused by the payer or the payer's bank
)

// BindingReq asks the provider for a link / QR code the payer opens in their bank app to bind
// their account for later off-session charges, without a payment.
type BindingReq struct {
	ID          uuid.UUID // local binding id; the provider keeps it (merchant QR id) and GetBinding reads by it
	Customer    CustomerRef
	Purpose     string // shown by the payer's bank, ≤ 140 characters
	ServiceName string // the subscription name in the payer's bank app, ≤ 70 characters
	ReturnURL   string // where the bank app returns the payer (optional)
	ExpiresAt   time.Time
	Metadata    Metadata
}

// Binding is the created link.
type Binding struct {
	ID        string // the provider's id of the link (NSPK QR id)
	URL       string // https://qr.nspk.ru/… — open on a phone, or show as a QR code
	ImagePNG  []byte // optional QR image
	ExpiresAt time.Time
	Livemode  bool
}

// BindingFact is a fresh read of a binding. Method is set only when Status is BindingAccepted:
// Method.ID is the token to charge (a secret-like reference: store it, never log it).
type BindingFact struct {
	ID       string // the local binding id the request carried
	Status   BindingStatus
	Method   SavedMethod
	Livemode bool
	Metadata Metadata
}

// AccountBinder is implemented by providers that bind a payer's account outside a hosted
// checkout (Tochka Pay Gateway SBP). The binding is not a payment: a lost answer of
// CreateBinding is harmless (a new binding is created on the next try), and the token reaches
// the core only through GetBinding — webhooks are hints.
type AccountBinder interface {
	CreateBinding(ctx context.Context, req BindingReq) (Binding, error)
	GetBinding(ctx context.Context, bindingID uuid.UUID) (BindingFact, error)
}

// SBPBindingRow is the matrix row of ADR-0083 phase 3: RU / RUB, person or company, any
// country → Tochka Pay Gateway SBP, auto-topup only (no manual top-up: no hosted checkout).
// Payers who are companies are kept in the row because the bank decides: a binding of a legal
// entity's account is refused by the payer's bank (SUBSCRIPTION_UNAVAILABLE).
func SBPBindingRow() Row {
	return Row{
		Market: MarketRU, Currency: money.RUB, PayerTypes: []string{PayerPerson, PayerCompany},
		Country: AnyCountry, Provider: TochkaPay, Method: MethodSBP, Min: RUBTopupMin, Max: RUBTopupMax, AutoTopup: true,
	}
}

// Binder returns the provider that binds accounts of this method for auto-topup in a market:
// an auto-topup row of the matrix whose provider is configured and implements AccountBinder,
// while the market itself is served (BILLING_PROVIDERS). Charging by the binding still goes
// through OffSession, which admits the provider only with the capabilities auto-topup needs.
func (r *Registry) Binder(market string, cur money.Currency, method Method) (ID, AccountBinder, bool) {
	served := false
	for _, ms := range r.markets {
		served = served || slices.Contains(ms, market)
	}
	if !served {
		return "", nil, false
	}
	for _, row := range r.rows {
		if row.Market != market || row.Currency != cur || row.Method != method || !row.AutoTopup {
			continue
		}
		p, ok := r.providers[row.Provider]
		if !ok {
			continue
		}
		if b, ok := p.(AccountBinder); ok {
			return row.Provider, b, true
		}
	}
	return "", nil, false
}
