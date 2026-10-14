package tochka

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/golang-jwt/jwt/v5"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// WebhookTypeAcquiring is the only webhook type the adapter processes: a payment by a payment
// link (card, SBP, digital ruble). Other types are stored and ignored.
const WebhookTypeAcquiring = "acquiringInternetPayment"

// ParseKeys reads the bank's webhook signing key(s): one JWK, a JSON array of JWKs or a JWK set
// ({"keys":[…]}); RSA keys only (RS256).
func ParseKeys(spec string) ([]any, error) {
	spec = strings.TrimSpace(spec)
	var raws []json.RawMessage
	switch {
	case strings.HasPrefix(spec, "["):
		if err := json.Unmarshal([]byte(spec), &raws); err != nil {
			return nil, fmt.Errorf("%w: TOCHKA_WEBHOOK_PUBLIC_KEY: %w", ErrInvalidRequest, err)
		}
	case strings.Contains(spec, `"keys"`):
		var set struct {
			Keys []json.RawMessage `json:"keys"`
		}
		if err := json.Unmarshal([]byte(spec), &set); err != nil {
			return nil, fmt.Errorf("%w: TOCHKA_WEBHOOK_PUBLIC_KEY: %w", ErrInvalidRequest, err)
		}
		raws = set.Keys
	default:
		raws = []json.RawMessage{json.RawMessage(spec)}
	}
	var out []any
	for _, r := range raws {
		var k jose.JSONWebKey
		if err := k.UnmarshalJSON(r); err != nil {
			return nil, fmt.Errorf("%w: TOCHKA_WEBHOOK_PUBLIC_KEY: %w", ErrInvalidRequest, err)
		}
		pub, ok := k.Key.(*rsa.PublicKey)
		if !ok || pub.N.BitLen() < 2048 {
			return nil, fmt.Errorf("%w: TOCHKA_WEBHOOK_PUBLIC_KEY must be RSA public keys of at least 2048 bits", ErrInvalidRequest)
		}
		out = append(out, pub)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: TOCHKA_WEBHOOK_PUBLIC_KEY has no key", ErrInvalidRequest)
	}
	return out, nil
}

// webhookClaims is the body of acquiringInternetPayment (and the fields other types share).
type webhookClaims struct {
	WebhookType   string  `json:"webhookType"`
	CustomerCode  string  `json:"customerCode"`
	MerchantID    string  `json:"merchantId"`
	OperationID   string  `json:"operationId"`
	PaymentLinkID string  `json:"paymentLinkId"`
	ConsumerID    string  `json:"consumerId"`
	Status        string  `json:"status"`
	PaymentType   string  `json:"paymentType"`
	Amount        decimal `json:"amount"`
	TransactionID string  `json:"transactionId"`
	jwt.RegisteredClaims
}

// verify checks the RS256 signature of a webhook body against the pinned key(s) and decodes its
// claims. The body is the bare JWT (Content-Type text/plain).
func (p *Provider) verify(raw []byte) (webhookClaims, error) {
	tok := strings.TrimSpace(string(raw))
	var lastErr error
	for _, key := range p.webhookKey {
		var c webhookClaims
		_, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return key, nil },
			jwt.WithValidMethods([]string{"RS256"}), jwt.WithoutClaimsValidation())
		if err == nil {
			return c, nil
		}
		lastErr = err
	}
	return webhookClaims{}, lastErr
}

// ParseWebhook verifies a webhook (RS256 JWT signed by the bank) and normalizes it. The event is
// only a hint: the core re-reads the operation (GetPayment) before any credit and never takes the
// amount from the body. Errors: provider.ErrBadSignature for a body that is not a JWT signed by
// a pinned key (answer 400, store nothing). Verified events that are not ours to process — other
// webhook types, another customer code / retail point (the bank's test webhooks), AUTHORIZED —
// are EventIgnored (stored, answered 200: the bank needs a 200 to register the URL).
//
// EventID is a digest of the operation, status, payment type, amount and SBP transaction id, so a
// redelivery of the same payment is one inbox row; the credit itself is unique per operation.
func (p *Provider) ParseWebhook(_ context.Context, _ http.Header, raw []byte) (provider.Event, error) {
	c, err := p.verify(raw)
	if err != nil {
		reason := "unverifiable body"
		switch {
		case errors.Is(err, jwt.ErrTokenMalformed):
			reason = "not a JWT"
		case errors.Is(err, jwt.ErrTokenSignatureInvalid), errors.Is(err, jwt.ErrTokenUnverifiable):
			reason = "signature does not match the pinned key"
		}
		return provider.Event{}, fmt.Errorf("tochka webhook: %s: %w", reason, provider.ErrBadSignature)
	}
	h := sha256.Sum256([]byte(strings.Join([]string{c.WebhookType, c.OperationID, c.Status, c.PaymentType, string(c.Amount), c.TransactionID, c.CustomerCode}, "|")))
	ev := provider.Event{
		Provider: provider.Tochka, ProviderAccount: p.customer, Livemode: p.live, EventID: "tw_" + hex.EncodeToString(h[:16]),
		Kind: provider.EventIgnored, Type: c.WebhookType + "." + strings.ToLower(c.Status), ObjectID: c.OperationID,
		PaymentID: c.OperationID, Created: time.Now().UTC(),
		Metadata: metadata(operation{PaymentLinkID: c.PaymentLinkID, ConsumerID: c.ConsumerID}),
	}
	if c.WebhookType != WebhookTypeAcquiring || c.OperationID == "" || c.CustomerCode != p.customer ||
		(c.MerchantID != "" && c.MerchantID != p.merchant) {
		return ev, nil
	}
	if c.Status == statusApproved {
		ev.Kind = provider.EventPaymentSucceeded
	}
	return ev, nil
}
