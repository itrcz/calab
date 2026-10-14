package tochkapay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Webhook events of the gateway (the decoded JWT's event).
const (
	EventPaymentUpdated = "payment-updated"
	EventRefundUpdated  = "refund-updated"
	EventTokenIssued    = "sbp-token-issued"   //nolint:gosec // an event name, not a credential
	EventTokenDeclined  = "sbp-token-declined" //nolint:gosec // an event name, not a credential
)

// notification is the decoded body of every gateway webhook.
type notification struct {
	Version     string          `json:"version"`
	SiteUID     string          `json:"siteUid"`
	PaymentUID  string          `json:"paymentUid"` // refund-updated
	Event       string          `json:"event"`
	CreatedAt   string          `json:"createdAt"`
	PayloadType string          `json:"payloadType"`
	Payload     json.RawMessage `json:"payload"`
	jwt.RegisteredClaims
}

func (p *Provider) verify(raw []byte) (notification, error) {
	tok := strings.TrimSpace(string(raw))
	var lastErr error
	for _, key := range p.webhookKey {
		var n notification
		_, err := jwt.ParseWithClaims(tok, &n, func(*jwt.Token) (any, error) { return key, nil },
			jwt.WithValidMethods([]string{"RS256"}), jwt.WithoutClaimsValidation())
		if err == nil {
			return n, nil
		}
		lastErr = err
	}
	return notification{}, lastErr
}

// ParseWebhook verifies a gateway webhook (a bare RS256 JWT, Content-Type text/plain, signed
// with the bank's webhook key) and normalizes it. It is a hint: the core re-reads the payment /
// refund / binding before acting, and the binding token is never taken from the body.
//   - payment-updated: COMPLETED → payment_succeeded, DECLINED → payment_failed, WAITING →
//     payment_processing; ObjectID = PaymentID = paymentUid (our attempt id);
//   - refund-updated: refund_updated, ObjectID "{paymentUid}/{refundUid}";
//   - sbp-token-issued: method_saved, ObjectID = our binding id (merchant QR id); declined:
//     ignored;
//   - another site, another type, or an empty object id: ignored (stored, answered 200);
//   - a live event on a test config: provider.ErrLivemodeForbidden (400, nothing stored).
//
// Errors: provider.ErrBadSignature for a body that is not a JWT signed by a pinned key.
func (p *Provider) ParseWebhook(_ context.Context, _ http.Header, raw []byte) (provider.Event, error) {
	n, err := p.verify(raw)
	if err != nil {
		reason := "unverifiable body"
		switch {
		case errors.Is(err, jwt.ErrTokenMalformed):
			reason = "not a JWT"
		case errors.Is(err, jwt.ErrTokenSignatureInvalid), errors.Is(err, jwt.ErrTokenUnverifiable):
			reason = "signature does not match the pinned key"
		}
		return provider.Event{}, fmt.Errorf("tochkapay webhook: %s: %w", reason, provider.ErrBadSignature)
	}
	created := parseTime(n.CreatedAt)
	if created.IsZero() {
		created = time.Now().UTC()
	}
	ev := provider.Event{
		Provider: provider.TochkaPay, ProviderAccount: p.site, Livemode: p.live, Kind: provider.EventIgnored,
		Type: n.Event, Created: created,
	}
	var digest []string
	testOnLive := false
	switch n.Event {
	case EventPaymentUpdated:
		var d paymentDTO
		if json.Unmarshal(n.Payload, &d) == nil {
			if err := p.webhookMode(d.IsTest); err != nil {
				return provider.Event{}, err
			}
			testOnLive = d.IsTest != nil && *d.IsTest && p.live
			ev.ObjectID, ev.PaymentID, ev.Metadata = d.PaymentUID, d.PaymentUID, parseMetadata(d.Metadata)
			ev.Type += "." + strings.ToLower(d.Status.Value)
			switch d.Status.Value {
			case statusCompleted:
				ev.Kind = provider.EventPaymentSucceeded
			case statusDeclined:
				ev.Kind = provider.EventPaymentFailed
			case statusWaiting:
				ev.Kind = provider.EventPaymentProcessing
			}
			digest = []string{d.PaymentUID, d.Status.Value, d.Status.ChangedDateTime, d.Amount.Amount}
		}
	case EventRefundUpdated:
		var d refundDTO
		if json.Unmarshal(n.Payload, &d) == nil && d.RefundUID != "" && n.PaymentUID != "" {
			ev.ObjectID, ev.PaymentID, ev.Metadata = n.PaymentUID+"/"+d.RefundUID, n.PaymentUID, parseMetadata(d.Metadata)
			ev.Type += "." + strings.ToLower(d.Status.Value)
			ev.Kind = provider.EventRefundUpdated
			digest = []string{n.PaymentUID, d.RefundUID, d.Status.Value, d.Status.ChangedDateTime}
		}
	case EventTokenIssued, EventTokenDeclined:
		var d tokenizationDTO
		if json.Unmarshal(n.Payload, &d) == nil {
			ev.ObjectID, ev.Metadata = d.MerchantQrcID, parseMetadata(d.Metadata)
			if n.Event == EventTokenIssued && d.Status == tokenAccepted {
				ev.Kind = provider.EventMethodSaved
			}
			digest = []string{d.QrcID, d.MerchantQrcID, d.Status} // never the token
		}
	}
	if testOnLive || n.SiteUID != p.site || !validObject(ev.ObjectID) {
		ev.Kind = provider.EventIgnored
	}
	h := sha256.Sum256([]byte(strings.Join(append([]string{n.SiteUID, n.Event, n.CreatedAt}, digest...), "|")))
	ev.EventID = "tpw_" + hex.EncodeToString(h[:16])
	return ev, nil
}

// webhookMode: a live payment on a test config is refused like Stripe's livemode events (a test
// payment on a live config is ignored by ParseWebhook).
func (p *Provider) webhookMode(isTest *bool) error {
	if isTest != nil && !*isTest && !p.live {
		return fmt.Errorf("tochkapay webhook: live payment while TOCHKA_PAY_LIVE=false: %w", provider.ErrLivemodeForbidden)
	}
	return nil
}

// validObject: an object id is one or two ("{paymentUid}/{refundUid}") bank uids.
func validObject(id string) bool {
	a, b, two := strings.Cut(id, "/")
	return uidRe.MatchString(a) && (!two || uidRe.MatchString(b))
}
