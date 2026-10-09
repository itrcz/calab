package stripe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	stripego "github.com/stripe/stripe-go/v86"
	"github.com/stripe/stripe-go/v86/webhook"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// SignatureHeader is the webhook signature header.
const SignatureHeader = "Stripe-Signature"

// eventKinds maps the Stripe event types we process. Anything else is EventIgnored.
//
// Object ids per kind: checkout_* and the checkout.session.async_payment_failed case of
// payment_failed carry the cs_ session (PaymentID = its pi_ when set); payment_* the pi_;
// refund_updated the re_ (refund.*) or the ch_ (charge.refunded: list the refunds of
// PaymentID); dispute_* the dp_; method_* the pm_ (setup_intent.succeeded: its payment method).
var eventKinds = map[string]provider.EventKind{
	"checkout.session.completed":               provider.EventCheckoutCompleted,
	"checkout.session.async_payment_succeeded": provider.EventCheckoutCompleted,
	"checkout.session.async_payment_failed":    provider.EventPaymentFailed,
	"checkout.session.expired":                 provider.EventCheckoutExpired,
	"payment_intent.succeeded":                 provider.EventPaymentSucceeded,
	"payment_intent.payment_failed":            provider.EventPaymentFailed,
	"payment_intent.processing":                provider.EventPaymentProcessing,
	"payment_intent.canceled":                  provider.EventPaymentFailed,
	"charge.refunded":                          provider.EventRefundUpdated,
	"refund.created":                           provider.EventRefundUpdated,
	"refund.updated":                           provider.EventRefundUpdated,
	"refund.failed":                            provider.EventRefundUpdated,
	"charge.dispute.created":                   provider.EventDisputeOpened,
	"charge.dispute.funds_withdrawn":           provider.EventDisputeOpened,
	"charge.dispute.closed":                    provider.EventDisputeClosed,
	"charge.dispute.funds_reinstated":          provider.EventDisputeClosed,
	"payment_method.attached":                  provider.EventMethodSaved,
	"payment_method.detached":                  provider.EventMethodDetached,
	"setup_intent.succeeded":                   provider.EventMethodSaved,
}

// MaxWebhookBody is the largest webhook body the HTTP handler should read (Stripe events are
// far smaller; the handler enforces it with http.MaxBytesReader before ParseWebhook).
const MaxWebhookBody = 256 << 10

// ParseWebhook verifies a webhook against every configured endpoint secret (rotation) on the
// raw body, within the timestamp tolerance, and normalizes it. Errors:
//   - provider.ErrBadSignature: no secret matches, the header is missing / malformed, or the
//     timestamp is outside the tolerance (answer 400, store nothing);
//   - ErrAPIVersionMismatch: signed, but rendered with another API version (answer 5xx);
//   - provider.ErrLivemodeForbidden: a livemode event while live mode is not allowed.
//
// The event is a hint: never credit from its payload, re-read the object (GetPayment …).
func (p *Provider) ParseWebhook(ctx context.Context, h http.Header, raw []byte) (provider.Event, error) {
	if len(p.secrets) == 0 {
		return provider.Event{}, fmt.Errorf("stripe webhook: no STRIPE_WEBHOOK_SECRET configured: %w", provider.ErrBadSignature)
	}
	sig := h.Get(SignatureHeader)
	if sig == "" {
		return provider.Event{}, fmt.Errorf("stripe webhook: no %s header: %w", SignatureHeader, provider.ErrBadSignature)
	}
	opts := webhook.ConstructEventOptions{Tolerance: p.tolerance, IgnoreAPIVersionMismatch: true}
	var (
		ev      stripego.Event
		lastErr error
		ok      bool
	)
	for _, secret := range p.secrets {
		e, err := webhook.ConstructEventWithOptions(raw, sig, secret, opts)
		if err == nil {
			ev, ok = e, true
			break
		}
		lastErr = err
		if !errors.Is(err, webhook.ErrNoValidSignature) {
			// Missing / malformed header, too old, unparsable body: no other secret helps.
			break
		}
	}
	if !ok {
		return provider.Event{}, fmt.Errorf("stripe webhook: %s: %w", webhookReason(lastErr), provider.ErrBadSignature)
	}
	if ev.APIVersion != APIVersion {
		return provider.Event{}, fmt.Errorf("stripe webhook: event %s rendered with API version %q, the adapter is pinned to %s (recreate the endpoint with this version): %w",
			ev.ID, ev.APIVersion, APIVersion, ErrAPIVersionMismatch)
	}
	if err := p.checkLive("webhook", ev.Livemode); err != nil {
		return provider.Event{}, err
	}
	acct := ev.Account
	if acct == "" {
		a, err := p.Account(ctx)
		if err != nil {
			return provider.Event{}, err
		}
		acct = a
	}
	out := provider.Event{
		Provider: provider.Stripe, ProviderAccount: acct, Livemode: ev.Livemode, EventID: ev.ID,
		Type: string(ev.Type), Created: time.Unix(ev.Created, 0).UTC(),
	}
	kind, known := eventKinds[out.Type]
	if !known {
		out.Kind = provider.EventIgnored
		return out, nil
	}
	out.Kind = kind
	var obj eventObject
	if ev.Data != nil && len(ev.Data.Raw) > 0 {
		if err := json.Unmarshal(ev.Data.Raw, &obj); err != nil {
			return provider.Event{}, fmt.Errorf("stripe webhook: event %s: undecodable object", ev.ID)
		}
	}
	out.ObjectID = obj.ID
	out.Metadata = provider.ParseMetadata(obj.Metadata)
	switch {
	case strings.HasPrefix(out.Type, "payment_intent."):
		out.PaymentID = obj.ID
	case out.Type == "setup_intent.succeeded":
		out.ObjectID = obj.PaymentMethod.id()
	default:
		out.PaymentID = obj.PaymentIntent.id()
	}
	return out, nil
}

func webhookReason(err error) string {
	switch {
	case err == nil:
		return "unverified"
	case errors.Is(err, webhook.ErrNotSigned):
		return "not signed"
	case errors.Is(err, webhook.ErrInvalidHeader):
		return "malformed signature header"
	case errors.Is(err, webhook.ErrTooOld):
		return "timestamp outside tolerance"
	case errors.Is(err, webhook.ErrNoValidSignature):
		return "no matching signature"
	}
	return "unverifiable body"
}

// eventObject is the part of an event object we read: ids and our metadata.
type eventObject struct {
	ID            string            `json:"id"`
	Metadata      map[string]string `json:"metadata"`
	PaymentIntent ref               `json:"payment_intent"`
	PaymentMethod ref               `json:"payment_method"`
}

// ref is an id or an expanded object with an id.
type ref json.RawMessage

func (r *ref) UnmarshalJSON(b []byte) error {
	*r = append((*r)[:0], b...)
	return nil
}

func (r ref) id() string {
	if len(r) == 0 || string(r) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	var o struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(r, &o) == nil {
		return o.ID
	}
	return ""
}
