// Package provider is the boundary between the billing core and payment acquirers (Stripe for
// Global / USD, Tochka for RU / RUB, ADR-0083). The core never imports a concrete provider: it
// talks to Provider (and optionally OffSessionCharger) through a Registry built from env.
//
// Contract every adapter keeps:
//   - no state of its own beyond credentials: facts come from the provider API, money effects
//     happen only in the core under the account lock;
//   - every create call takes an idempotency key derived from a local row id (checkout id,
//     refund id, auto-topup attempt id). With CapIdempotentCharge (Stripe) a retry with the
//     same key never creates a second object. Without it (Tochka, CapReconcilableCharge) the
//     key is only a reference the provider keeps (paymentLinkId) or nothing at all: the core
//     sends such a create at most once and resolves a lost answer by reading the payment's
//     operations, never by a blind retry;
//   - a lost answer is ErrUnknownOutcome, never a guessed success or failure;
//   - Stripe: test keys only unless STRIPE_LIVEMODE_ALLOWED (livemode objects are
//     ErrLivemodeForbidden). Tochka has no test mode for payments: it is live only and gated by
//     BILLING_TOCHKA_ENABLED plus the configured customer code / merchant id;
//   - an operation the provider cannot do through its API (Tochka: refund of a digital-ruble
//     payment) is ErrNotSupported: the core keeps the money reserved for a manual operation;
//   - webhooks are verified on the raw body (ErrBadSignature) and parsed into Event; the core
//     re-reads the object (GetPayment / GetCheckout / GetRefund) before acting on it.
package provider

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
)

// ID names a provider ("stripe", "tochka", "manual").
type ID string

// Known provider ids.
const (
	Stripe ID = "stripe"
	Tochka ID = "tochka"
	Manual ID = "manual"
)

// Method is a way to pay ("card", "sbp", "bank_transfer").
type Method string

// Payment methods.
const (
	MethodCard         Method = "card"
	MethodSBP          Method = "sbp"
	MethodBankTransfer Method = "bank_transfer"
)

// Cap is a capability bit set of a provider.
type Cap uint32

// Capabilities.
const (
	CapHostedCheckout   Cap = 1 << iota // hosted payment page (CreateCheckout)
	CapSaveMethod                       // a checkout can save the method for later off-session use
	CapOffSession                       // OffSessionCharger is implemented
	CapIdempotentCharge                 // create calls are idempotent by key (retry of an unknown outcome is safe)
	CapRefund
	CapPartialRefund
	CapDisputes
	CapReceipts // the provider issues the receipt (receipt_url)
	CapListPayments
	// CapReconcilableCharge: create calls are NOT idempotent, but every payment / refund the
	// provider made is visible in the payment's operations (Tochka Order[]), so an unknown
	// outcome is resolved by reading, never by sending again (ADR-0083).
	CapReconcilableCharge
	// CapSuccessOnlyWebhooks: the provider pushes only successful payments (no failure,
	// expiry or refund events): pending checkouts and refunds are polled (ADR-0083).
	CapSuccessOnlyWebhooks
)

// SafeRetry reports whether a create call with an unknown outcome may be sent again with the
// same idempotency key.
func (c Cap) SafeRetry() bool { return c.Has(CapIdempotentCharge) }

// Has reports whether every bit of want is set.
func (c Cap) Has(want Cap) bool { return c&want == want }

// Errors of adapters. Wrap them (fmt.Errorf("…: %w", ErrX)); the core uses errors.Is.
var (
	// ErrBadSignature: a webhook body does not match its signature (answer 400, store nothing).
	ErrBadSignature = errors.New("provider: bad webhook signature")
	// ErrUnknownOutcome: the call may or may not have happened at the provider (timeout, 5xx,
	// connection reset). Retry with the same idempotency key, else reconcile; never assume.
	ErrUnknownOutcome = errors.New("provider: unknown outcome")
	// ErrLivemodeForbidden: a live key or livemode object while STRIPE_LIVEMODE_ALLOWED=false.
	ErrLivemodeForbidden = errors.New("provider: livemode forbidden")
	// ErrNotFound: the provider has no such object.
	ErrNotFound = errors.New("provider: object not found")
	// ErrNotSupported: the provider cannot do this through its API (Tochka: refund of a
	// digital-ruble payment). Nothing was sent; the operation is left to an operator.
	ErrNotSupported = errors.New("provider: operation not supported by the provider API")
)

// Metadata travels with provider objects (PaymentIntent / Checkout metadata) so a webhook or
// a reconciliation finds the local rows. Non-privileged ids only, never secrets or payer data.
type Metadata struct {
	AccountID  uuid.UUID
	CheckoutID uuid.UUID
	AttemptID  uuid.UUID
	RefundID   uuid.UUID // billing_refunds.id of a Calab refund: found by listing when its answer was lost
	Kind       string    // MetadataKindCheckout | MetadataKindAutoTopup
}

// Metadata kinds.
const (
	MetadataKindCheckout  = "checkout"
	MetadataKindAutoTopup = "auto_topup"
)

// Metadata keys on the provider side.
const (
	MetaAccountID  = "calab_account_id"
	MetaCheckoutID = "calab_checkout_id"
	MetaAttemptID  = "calab_attempt_id"
	MetaRefundID   = "calab_refund_id"
	MetaKind       = "kind"
)

// Map renders metadata as provider key/values (unset ids are left out).
func (m Metadata) Map() map[string]string {
	out := map[string]string{}
	if m.AccountID != uuid.Nil {
		out[MetaAccountID] = m.AccountID.String()
	}
	if m.CheckoutID != uuid.Nil {
		out[MetaCheckoutID] = m.CheckoutID.String()
	}
	if m.AttemptID != uuid.Nil {
		out[MetaAttemptID] = m.AttemptID.String()
	}
	if m.RefundID != uuid.Nil {
		out[MetaRefundID] = m.RefundID.String()
	}
	if m.Kind != "" {
		out[MetaKind] = m.Kind
	}
	return out
}

// ParseMetadata reads Map's keys back; malformed ids stay uuid.Nil.
func ParseMetadata(kv map[string]string) Metadata {
	id := func(k string) uuid.UUID {
		u, err := uuid.Parse(kv[k])
		if err != nil {
			return uuid.Nil
		}
		return u
	}
	return Metadata{AccountID: id(MetaAccountID), CheckoutID: id(MetaCheckoutID), AttemptID: id(MetaAttemptID), RefundID: id(MetaRefundID), Kind: kv[MetaKind]}
}

// CustomerRef identifies a provider customer of one merchant account and mode.
type CustomerRef struct {
	Provider        ID
	ProviderAccount string // merchant account (acct_…)
	Livemode        bool
	ID              string // cus_…
}

// CustomerReq creates (idempotently) the customer of a billing account.
type CustomerReq struct {
	IdemKey   string // "customer:{account_id}"
	AccountID uuid.UUID
	Email     string
	Name      string
	Metadata  Metadata
}

// CheckoutReq opens a hosted payment page for a fixed amount.
type CheckoutReq struct {
	IdemKey           string // "checkout:{checkout_id}"
	Amount            money.Money
	Method            Method
	Customer          CustomerRef
	SuccessURL        string
	CancelURL         string
	SaveForOffSession bool // setup_future_usage=off_session
	ExpiresAt         time.Time
	Metadata          Metadata
	Description       string // line item text shown on the hosted page and receipt
	// ReceiptEmail: where a provider that fiscalizes the payment itself (Tochka, 54-FZ) sends
	// the receipt — the payer's e-mail, else the owner's. Stripe collects it on its page.
	ReceiptEmail string
}

// CheckoutSession is the created page.
type CheckoutSession struct {
	ID              string // cs_…
	URL             string
	ExpiresAt       time.Time
	ProviderAccount string
	Livemode        bool
}

// CheckoutStatus of a hosted session.
type CheckoutStatus string

// Checkout statuses.
const (
	CheckoutOpen     CheckoutStatus = "open"
	CheckoutComplete CheckoutStatus = "complete"
	CheckoutExpired  CheckoutStatus = "expired"
)

// CheckoutFact is a fresh read of a session.
type CheckoutFact struct {
	ID              string
	Status          CheckoutStatus
	PaymentID       string // PaymentIntent of the session, once there is one
	CustomerID      string
	Amount          money.Money
	ExpiresAt       time.Time
	ProviderAccount string
	Livemode        bool
	Metadata        Metadata
}

// PaymentStatus of a payment (PaymentIntent).
type PaymentStatus string

// Payment statuses. Only PaymentSucceeded with AmountReceived credits the balance.
const (
	PaymentProcessing     PaymentStatus = "processing"
	PaymentRequiresAction PaymentStatus = "requires_action" // includes requires_payment_method after a decline
	PaymentSucceeded      PaymentStatus = "succeeded"
	PaymentFailed         PaymentStatus = "failed"
	PaymentCanceled       PaymentStatus = "canceled"
)

// PaymentFact is a fresh read of a payment. The core checks Customer, currency, livemode,
// Status and AmountReceived against its own rows before crediting.
type PaymentFact struct {
	ID              string // pi_…
	ProviderAccount string
	Livemode        bool
	CustomerID      string
	Status          PaymentStatus
	Amount          money.Money // requested
	AmountReceived  money.Money
	ChargeID        string // ch_… (reference)
	PaymentMethodID string // pm_…
	ReceiptURL      string
	FailureCode     string // decline / authentication code, for the owner mail
	Created         time.Time
	SucceededAt     time.Time
	Metadata        Metadata
}

// ListReq lists payments of a customer (reconciliation after a restore or an unknown outcome).
type ListReq struct {
	Customer     CustomerRef
	CreatedAfter time.Time
	Kind         string // metadata kind filter, "" = all
	Cursor       string
	Limit        int
}

// RefundReq refunds part or all of a payment.
type RefundReq struct {
	IdemKey   string // "refund:{refund_id}"
	PaymentID string
	Amount    money.Money
	Reason    string
	Metadata  Metadata
}

// RefundStatus of a refund.
type RefundStatus string

// Refund statuses.
const (
	RefundPending        RefundStatus = "pending"
	RefundRequiresAction RefundStatus = "requires_action"
	RefundSucceeded      RefundStatus = "succeeded"
	RefundFailed         RefundStatus = "failed"
	RefundCanceled       RefundStatus = "canceled"
)

// RefundFact is a fresh read of a refund.
type RefundFact struct {
	ID              string // re_…
	PaymentID       string
	ProviderAccount string
	Livemode        bool
	Amount          money.Money
	Status          RefundStatus
	FailureReason   string
	Created         time.Time
	Metadata        Metadata
}

// SavedMethod is a payment method saved for off-session use.
type SavedMethod struct {
	ID         string // pm_…
	CustomerID string
	Kind       Method
	Brand      string
	Last4      string
	ExpMonth   int
	ExpYear    int
}

// OffSessionReq charges a saved method without the payer (auto-topup).
type OffSessionReq struct {
	IdemKey         string // the auto-topup attempt id
	Customer        CustomerRef
	PaymentMethodID string
	Amount          money.Money
	Description     string
	Metadata        Metadata
}

// EventKind is the provider-neutral kind of a webhook event.
type EventKind string

// Event kinds. Anything else is EventIgnored (stored, ACKed, not processed).
const (
	EventPaymentSucceeded  EventKind = "payment_succeeded"
	EventPaymentFailed     EventKind = "payment_failed"
	EventPaymentProcessing EventKind = "payment_processing"
	EventCheckoutCompleted EventKind = "checkout_completed"
	EventCheckoutExpired   EventKind = "checkout_expired"
	EventRefundUpdated     EventKind = "refund_updated"
	EventDisputeOpened     EventKind = "dispute_opened"
	EventDisputeClosed     EventKind = "dispute_closed"
	EventMethodSaved       EventKind = "method_saved"
	EventMethodDetached    EventKind = "method_detached"
	EventIgnored           EventKind = "ignored"
)

// Event is a verified webhook. It is a hint only: the core re-reads ObjectID before acting.
type Event struct {
	Provider        ID
	ProviderAccount string
	Livemode        bool
	EventID         string // evt_… (inbox dedup key with Provider, ProviderAccount)
	Kind            EventKind
	Type            string // raw provider type ("payment_intent.succeeded")
	ObjectID        string // pi_… / cs_… / re_… / dp_… / pm_…
	PaymentID       string // the payment the object belongs to, when the event carries it
	Created         time.Time
	Metadata        Metadata
}

// Provider is a payment acquirer.
type Provider interface {
	ID() ID
	Caps() Cap
	EnsureCustomer(ctx context.Context, req CustomerReq) (CustomerRef, error)
	CreateCheckout(ctx context.Context, req CheckoutReq) (CheckoutSession, error)
	GetCheckout(ctx context.Context, sessionID string) (CheckoutFact, error)
	GetPayment(ctx context.Context, paymentID string) (PaymentFact, error)
	// ListPayments returns a page and the cursor of the next one ("" = last page).
	ListPayments(ctx context.Context, req ListReq) ([]PaymentFact, string, error)
	Refund(ctx context.Context, req RefundReq) (RefundFact, error)
	GetRefund(ctx context.Context, refundID string) (RefundFact, error)
	ParseWebhook(ctx context.Context, h http.Header, raw []byte) (Event, error)
}

// OffSessionCharger is implemented by providers with CapOffSession (auto-topup). An off-session
// requires_action is returned as a PaymentFact with PaymentRequiresAction: the core cancels it
// (CancelPayment) and mails the owner a manual checkout link — never retried with a new key.
type OffSessionCharger interface {
	ListMethods(ctx context.Context, customer CustomerRef) ([]SavedMethod, error)
	ChargeOffSession(ctx context.Context, req OffSessionReq) (PaymentFact, error)
	CancelPayment(ctx context.Context, paymentID string) (PaymentFact, error)
	DetachMethod(ctx context.Context, paymentMethodID string) error
}
