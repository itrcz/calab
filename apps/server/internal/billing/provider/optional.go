package provider

import (
	"context"
	"time"

	"github.com/calaba/calaba/server/internal/billing/money"
)

// Optional capabilities the webhook inbox uses when a provider has them (type assertion on
// the Provider). Without them the inbox falls back to what the event and the payment carry.

// RefundLister lists the refunds of a payment: resolves events whose object is the charge
// (Stripe charge.refunded) and refunds made in the provider dashboard.
type RefundLister interface {
	ListRefunds(ctx context.Context, paymentID string) ([]RefundFact, error)
}

// DisputeStatus of a dispute as the provider reports it.
type DisputeStatus string

// Dispute statuses.
const (
	DisputeOpen      DisputeStatus = "open"
	DisputeWon       DisputeStatus = "won"
	DisputeLost      DisputeStatus = "lost"
	DisputeWithdrawn DisputeStatus = "withdrawn" // inquiry closed without a chargeback
)

// DisputeFact is a fresh read of a dispute (chargeback).
type DisputeFact struct {
	ID              string // dp_…
	PaymentID       string // pi_…
	ProviderAccount string
	Livemode        bool
	Amount          money.Money
	Status          DisputeStatus
	Created         time.Time
}

// DisputeReader reads a dispute (amount and outcome are not in the event hint).
type DisputeReader interface {
	GetDispute(ctx context.Context, disputeID string) (DisputeFact, error)
}

// LivemodeReporter tells the mode of the provider's credentials before any object exists
// (the billing_customers key). Providers without it run in test mode.
type LivemodeReporter interface {
	Livemode() bool
}
