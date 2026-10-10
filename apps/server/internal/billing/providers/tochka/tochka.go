// Package tochka is the Tochka Bank adapter of the billing core (ADR-0083): RU market, RUB,
// internet acquiring of Tochka.API — hosted payment links with a 54-FZ receipt fiscalized by
// the bank's cloud cash register (payments_with_receipt), paid by card or SBP.
//
// The adapter is a pure API client: no state beyond credentials, the pinned webhook key and the
// CA pool; it never touches the database. What makes it different from Stripe, and how the
// core copes (ADR-0083):
//   - no idempotency keys (CapReconcilableCharge, not CapIdempotentCharge). A payment link
//     carries our checkout id as paymentLinkId, which the bank keeps unique: a second create
//     with the same id is refused (424 «заказ … существует») and the adapter then finds the
//     existing operation by listing. A refund is sent at most once by the core; a lost answer
//     is resolved by reading the payment's operations (Order[]), never by sending again;
//   - webhooks report only successful payments (CapSuccessOnlyWebhooks), signed as an RS256
//     JWT: the body is a hint, the payment is re-read before any credit; expiry, failures and
//     refunds are polled;
//   - live only: there is no test mode for payments (the sandbox answers canned bodies);
//     BILLING_TOCHKA_ENABLED and the configured customer code / merchant id gate it;
//   - the bank's TLS certificate is issued by the Russian Trusted CA, which system stores lack:
//     the HTTP client trusts the system roots plus the embedded Russian Trusted Root / Sub CA;
//     TLS verification is never disabled;
//   - amounts are decimal rubles in JSON numbers: parsed exactly into kopecks (money.ParseDecimal),
//     never through float64;
//   - errors carry the bank's code / request id and a redacted message, never the token, request
//     bodies or payment links.
package tochka

import (
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Defaults.
const (
	// DefaultBaseURL is the production API (JWT key of the merchant).
	DefaultBaseURL = "https://enter.tochka.com/uapi"
	// SandboxBaseURL answers canned bodies for format checks (token "sandbox.jwt.token").
	SandboxBaseURL = "https://enter.tochka.com/sandbox/v2"
	// PublicKeyURL is where the bank publishes its webhook signing key (JWK). The adapter does
	// not fetch it at runtime: the key is pinned (DefaultWebhookKey or TOCHKA_WEBHOOK_PUBLIC_KEY)
	// and `server tochka key` compares the pinned key with the published one.
	PublicKeyURL   = "https://enter.tochka.com/doc/openapi/static/keys/public"
	DefaultTimeout = 30 * time.Second
	// DefaultTaxSystem / DefaultVatType: the seller of the RU market is ООО «Громтех», АУСН
	// without VAT (public offer, apps/landing legal.json); АУСН is reported in receipts as the
	// simplified system «доходы» (TOCHKA_TAX_SYSTEM overrides it).
	DefaultTaxSystem = "usn_income"
	DefaultVatType   = "none"
	// DefaultLineItem is the receipt line and payment purpose when CheckoutReq.Description is empty.
	DefaultLineItem = "Пополнение баланса Calab"
	// MaxWebhookBody bounds the webhook body the HTTP handler reads (a JWT of a few KiB).
	MaxWebhookBody = 64 << 10
)

// DefaultWebhookKey is the bank's webhook signing key as published at PublicKeyURL on
// 2026-10-10 (also the key of the examples in the bank's documentation).
const DefaultWebhookKey = `{"kty":"RSA","e":"AQAB","n":"rwm77av7GIttq-JF1itEgLCGEZW_zz16RlUQVYlLbJtyRSu61fCec_rroP6PxjXU2uLzUOaGaLgAPeUZAJrGuVp9nryKgbZceHckdHDYgJd9TsdJ1MYUsXaOb9joN9vmsCscBx1lwSlFQyNQsHUsrjuDk-opf6RCuazRQ9gkoDCX70HV8WBMFoVm-YWQKJHZEaIQxg_DU4gMFyKRkDGKsYKA0POL-UgWA1qkg6nHY5BOMKaqxbc5ky87muWB5nNk4mfmsckyFv9j1gBiXLKekA_y4UwG2o1pbOLpJS3bP_c95rm4M9ZBmGXqfOQhbjz8z-s9C11i-jmOQ2ByohS-ST3E5sqBzIsxxrxyQDTw--bZNhzpbciyYW4GfkkqyeYoOPd_84jPTBDKQXssvj8ZOj2XboS77tvEO1n1WlwUzh8HPCJod5_fEgSXuozpJtOggXBv0C2ps7yXlDZf-7Jar0UYc_NJEHJF-xShlqd6Q3sVL02PhSCM-ibn9DN9BKmD"}`

// Caps of the Tochka adapter (phase 1: manual top-up by card or SBP, refunds, reconciliation).
const Caps = provider.CapHostedCheckout | provider.CapRefund | provider.CapPartialRefund |
	provider.CapListPayments | provider.CapReconcilableCharge | provider.CapSuccessOnlyWebhooks

//go:embed russian_trusted_ca.pem
var russianTrustedCA []byte

// Errors of this adapter (besides the provider.Err* sentinels).
var (
	// ErrInvalidRequest: refused locally before any network call.
	ErrInvalidRequest = errors.New("tochka: invalid request")
	// ErrForeign: the operation belongs to another customer code / merchant than ours.
	ErrForeign = errors.New("tochka: operation of another customer or merchant")
)

var (
	customerCodeRe = regexp.MustCompile(`^[0-9A-Za-z]{9}$`)
	merchantIDRe   = regexp.MustCompile(`^[0-9]{15}$`)
	taxSystems     = map[string]bool{"osn": true, "usn_income": true, "usn_income_outcome": true, "esn": true, "patent": true}
	vatTypes       = map[string]bool{"none": true, "vat0": true, "vat5": true, "vat7": true, "vat10": true, "vat22": true, "vat105": true, "vat107": true, "vat110": true, "vat122": true}
)

// Config of the adapter, from env (config.Billing). The token is never logged.
type Config struct {
	BaseURL      string // TOCHKA_API_URL; default DefaultBaseURL
	Token        string // TOCHKA_API_TOKEN: JWT key of the merchant (Bearer)
	CustomerCode string // TOCHKA_CUSTOMER_CODE: 9 characters, the company as the bank's client
	MerchantID   string // TOCHKA_MERCHANT_ID: 15 digits, the internet-acquiring retail point
	TaxSystem    string // TOCHKA_TAX_SYSTEM; default DefaultTaxSystem
	VatType      string // TOCHKA_VAT_TYPE; default DefaultVatType
	// WebhookKey: the bank's signing key as a JWK (TOCHKA_WEBHOOK_PUBLIC_KEY); default
	// DefaultWebhookKey. Several keys during a rotation: a JSON array or {"keys":[…]}.
	WebhookKey string
	// ClientID of the webhook API; default the token's iss claim.
	ClientID   string
	HTTPClient *http.Client // tests; default: DefaultTimeout + system roots and Russian Trusted CA
	Timeout    time.Duration
}

// Provider is the Tochka adapter. Safe for concurrent use.
type Provider struct {
	base       string
	token      string
	customer   string
	merchant   string
	taxSystem  string
	vatType    string
	clientID   string
	live       bool
	hc         *http.Client
	webhookKey []any // *rsa.PublicKey
}

var (
	_ provider.Provider         = (*Provider)(nil)
	_ provider.RefundLister     = (*Provider)(nil)
	_ provider.LivemodeReporter = (*Provider)(nil)
)

// New validates the config and builds the adapter. It makes no network call.
func New(cfg Config) (*Provider, error) {
	token := strings.TrimSpace(cfg.Token)
	if token == "" {
		return nil, fmt.Errorf("%w: TOCHKA_API_TOKEN is empty", ErrInvalidRequest)
	}
	if !customerCodeRe.MatchString(cfg.CustomerCode) {
		return nil, fmt.Errorf("%w: TOCHKA_CUSTOMER_CODE must be 9 characters", ErrInvalidRequest)
	}
	if !merchantIDRe.MatchString(cfg.MerchantID) {
		return nil, fmt.Errorf("%w: TOCHKA_MERCHANT_ID must be 15 digits", ErrInvalidRequest)
	}
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	if !strings.HasPrefix(base, "https://") && !strings.HasPrefix(base, "http://127.0.0.1") && !strings.HasPrefix(base, "http://localhost") {
		return nil, fmt.Errorf("%w: TOCHKA_API_URL must be https", ErrInvalidRequest)
	}
	tax := cfg.TaxSystem
	if tax == "" {
		tax = DefaultTaxSystem
	}
	if !taxSystems[tax] {
		return nil, fmt.Errorf("%w: TOCHKA_TAX_SYSTEM %q is not a receipt tax system", ErrInvalidRequest, tax)
	}
	vat := cfg.VatType
	if vat == "" {
		vat = DefaultVatType
	}
	if !vatTypes[vat] {
		return nil, fmt.Errorf("%w: TOCHKA_VAT_TYPE %q is not a receipt VAT type", ErrInvalidRequest, vat)
	}
	keySpec := cfg.WebhookKey
	if strings.TrimSpace(keySpec) == "" {
		keySpec = DefaultWebhookKey
	}
	keys, err := ParseKeys(keySpec)
	if err != nil {
		return nil, err
	}
	hc := cfg.HTTPClient
	if hc == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = DefaultTimeout
		}
		pool, err := RootCAs()
		if err != nil {
			return nil, err
		}
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		hc = &http.Client{Timeout: timeout, Transport: tr}
	}
	clientID := cfg.ClientID
	if clientID == "" {
		clientID = tokenIssuer(token)
	}
	return &Provider{
		base: base, token: token, customer: cfg.CustomerCode, merchant: cfg.MerchantID, taxSystem: tax, vatType: vat,
		clientID: clientID, live: !strings.Contains(base, "/sandbox/"), hc: hc, webhookKey: keys,
	}, nil
}

// RootCAs is the system pool plus the Russian Trusted Root and Sub CA (the issuer of
// enter.tochka.com).
func RootCAs() (*x509.CertPool, error) {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(russianTrustedCA) {
		return nil, errors.New("tochka: embedded Russian Trusted CA bundle is invalid")
	}
	return pool, nil
}

// tokenIssuer reads the iss claim (= client_id of the webhook API) of the merchant's JWT key
// without verifying it (the bank verifies it; we only need the id). "" if unreadable.
func tokenIssuer(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var c struct {
		Iss string `json:"iss"`
	}
	if json.Unmarshal(b, &c) != nil {
		return ""
	}
	return c.Iss
}

// ID is provider.Tochka.
func (p *Provider) ID() provider.ID { return provider.Tochka }

// Caps of Tochka.
func (p *Provider) Caps() provider.Cap { return Caps }

// Livemode is true on the production API, which is live (there is no test mode for payments); the sandbox is not.
func (p *Provider) Livemode() bool { return p.live }

// CustomerCode is the provider account of every Tochka object (billing_customers, payments).
func (p *Provider) CustomerCode() string { return p.customer }

// ClientID is the id the webhook API is addressed by ("" if the token has no iss claim and
// TOCHKA_CLIENT_ID is unset).
func (p *Provider) ClientID() string { return p.clientID }
