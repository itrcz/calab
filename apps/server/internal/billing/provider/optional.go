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

// ChargeLister lists the charges made on a saved method (Tochka: the approvals in Order[] of the
// card's subscription), newest last. Ids are stable; the binding payment of the method may be
// among them. Required of an OffSessionCharger without CapIdempotentCharge (Registry.OffSession).
type ChargeLister interface {
	ListCharges(ctx context.Context, customer CustomerRef, paymentMethodID string) ([]PaymentFact, error)
}

// LivemodeReporter tells the mode of the provider's credentials before any object exists
// (the billing_customers key). Providers without it run in test mode.
type LivemodeReporter interface {
	Livemode() bool
}

// AccountReporter tells the provider account the adapter's credentials act for, from its
// config, without a network call (Tochka: TOCHKA_CUSTOMER_CODE). Only providers whose customer
// ids are ours, not provider objects (Tochka: consumerId = billing account id), implement it:
// their billing_customers row may move to another provider account in place when the operator
// changed the config before the account had anything there (billinghttp ensureCustomer).
// Stripe does not: a cus_ id lives in one merchant account.
type AccountReporter interface {
	ProviderAccount() string
}

// HandRefunder is a provider whose subscription payments (a saved card's binding payment and its
// charges) are refunded only in its own interface (Tochka: «Платежи, поступившие через подписки,
// можно вернуть только в интернет-банке»). The admin refund never sends such a refund: it shows
// what to refund in the bank; the refund polling books it once the bank lists it.
type HandRefunder interface {
	// RefundsByHand tells from the payment id alone (no call) whether it is refunded only by hand;
	// savedMethod: the payment is the binding payment of a saved method (billing_payment_methods).
	RefundsByHand(paymentID string, savedMethod bool) bool
}

// OperationRefunds are the refunds the provider lists on one payment operation.
type OperationRefunds struct {
	// PaymentID: the operation (Tochka: the payment link's operation id, or the subscription's).
	PaymentID string
	// Subscription: the refunds do not name the approval they return (provider.HandRefunder).
	Subscription bool
	Refunds      []RefundFact
}

// RefundScanner lists, in one pass, the refunds of every payment operation created since `since`
// (Tochka: GET payments?customerCode&fromDate returns Order[] of each operation). A provider
// that sends no refund webhooks is read this way on a schedule (ADR-0083, 2026-10-10).
type RefundScanner interface {
	ScanRefunds(ctx context.Context, since time.Time) ([]OperationRefunds, error)
}
