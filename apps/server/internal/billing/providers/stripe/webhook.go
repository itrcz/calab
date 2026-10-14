package stripe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
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

var (
	foreignVersionEvents = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "calaba_billing_stripe_foreign_version_events_total",
		Help: "Stripe webhook events rendered with another API version than the adapter's pinned one (accepted: only envelope ids are read).",
	}, []string{"api_version"})
	// warnedVersions: one warning per foreign API version and process.
	warnedVersions sync.Map
)

// ParseWebhook verifies a webhook against every configured endpoint secret (rotation) on the
// raw body, within the timestamp tolerance, and normalizes it. Errors:
//   - provider.ErrBadSignature: no secret matches, the header is missing / malformed, or the
//     timestamp is outside the tolerance (answer 400, store nothing);
//   - provider.ErrLivemodeForbidden: a livemode event while live mode is not allowed;
//   - any other error: a signed body that is not a JSON event at all (answer 5xx).
//
// Events of any API version are accepted (the account default, `stripe listen`, an endpoint
// created with another version): the event is only a hint — we read the stable envelope (id,
// type, account, livemode, created) and the ids / our metadata of data.object, leniently, and
// re-read the object itself (GetPayment, GetRefund, GetDispute …) with the pinned APIVersion.
// Never credit from the payload.
func (p *Provider) ParseWebhook(ctx context.Context, h http.Header, raw []byte) (provider.Event, error) {
	if len(p.secrets) == 0 {
		return provider.Event{}, fmt.Errorf("stripe webhook: no STRIPE_WEBHOOK_SECRET configured: %w", provider.ErrBadSignature)
	}
	sig := h.Get(SignatureHeader)
	if sig == "" {
		return provider.Event{}, fmt.Errorf("stripe webhook: no %s header: %w", SignatureHeader, provider.ErrBadSignature)
	}
	var lastErr error
	ok := false
	for _, secret := range p.secrets {
		err := webhook.ValidatePayloadWithTolerance(raw, sig, secret, p.tolerance)
		if err == nil {
			ok = true
			break
		}
		lastErr = err
		if !errors.Is(err, webhook.ErrNoValidSignature) {
			// Missing / malformed header, too old: no other secret helps.
			break
		}
	}
	if !ok {
		return provider.Event{}, fmt.Errorf("stripe webhook: %s: %w", webhookReason(lastErr), provider.ErrBadSignature)
	}
	var ev envelope
	if err := json.Unmarshal(raw, &ev); err != nil || ev.ID == "" {
		return provider.Event{}, errors.New("stripe webhook: signed body is not an event")
	}
	if ev.APIVersion != APIVersion {
		foreignVersionEvents.WithLabelValues(ev.APIVersion).Inc()
		if _, seen := warnedVersions.LoadOrStore(ev.APIVersion, true); !seen {
			slog.WarnContext(ctx, "stripe webhook: event rendered with another API version; reading only the envelope, objects are re-fetched with the pinned version",
				"event_api_version", ev.APIVersion, "pinned", APIVersion, "event", ev.ID)
		}
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
		Type: ev.Type, Created: time.Unix(ev.Created, 0).UTC(),
	}
	kind, known := eventKinds[out.Type]
	if !known || ev.Object != "event" { // thin (v2) notifications carry no object: ignored
		out.Kind = provider.EventIgnored
		return out, nil
	}
	out.Kind = kind
	obj := ev.Data.Object
	out.ObjectID = obj.ID.id()
	out.Metadata = provider.ParseMetadata(obj.Metadata.strings())
	switch {
	case strings.HasPrefix(out.Type, "payment_intent."):
		out.PaymentID = out.ObjectID
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

// envelope is the part of an event we read. Every field is decoded leniently: a field whose
// shape changed between API versions reads as empty instead of failing the event.
type envelope struct {
	ID         string    `json:"id"`
	Object     string    `json:"object"`
	Type       string    `json:"type"`
	Account    string    `json:"account"`
	Livemode   bool      `json:"livemode"`
	Created    int64     `json:"created"`
	APIVersion string    `json:"api_version"`
	Data       eventData `json:"data"`
}

func (e *envelope) UnmarshalJSON(b []byte) error {
	var f map[string]json.RawMessage
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	lenient(f["id"], &e.ID)
	lenient(f["object"], &e.Object)
	lenient(f["type"], &e.Type)
	lenient(f["account"], &e.Account)
	lenient(f["livemode"], &e.Livemode)
	lenient(f["created"], &e.Created)
	lenient(f["api_version"], &e.APIVersion)
	var d map[string]json.RawMessage
	lenient(f["data"], &d)
	var o map[string]json.RawMessage
	lenient(d["object"], &o)
	e.Data.Object = eventObject{ID: ref(o["id"]), Metadata: meta(o["metadata"]), PaymentIntent: ref(o["payment_intent"]), PaymentMethod: ref(o["payment_method"])}
	return nil
}

// lenient decodes raw into v, leaving v zero when the field is absent or of another shape.
func lenient(raw json.RawMessage, v any) {
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, v)
	}
}

type eventData struct {
	Object eventObject
}

// eventObject is the part of an event object we read: ids and our metadata.
type eventObject struct {
	ID            ref
	Metadata      meta
	PaymentIntent ref
	PaymentMethod ref
}

// meta is a metadata object; values that are not strings are dropped.
type meta json.RawMessage

func (m meta) strings() map[string]string {
	var all map[string]json.RawMessage
	lenient(json.RawMessage(m), &all)
	out := make(map[string]string, len(all))
	for k, v := range all {
		var s string
		if json.Unmarshal(v, &s) == nil {
			out[k] = s
		}
	}
	return out
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
