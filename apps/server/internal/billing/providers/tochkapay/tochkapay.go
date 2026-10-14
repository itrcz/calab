// Package tochkapay is the Tochka Pay Gateway adapter («Приём платежей», ADR-0083 phase 3): SBP
// account binding (an NSPK subscription token) and off-session charges by that token, for the
// RU market's auto-topup. It is a different product of the same bank than package tochka
// (payment links): its own site id (siteUid, issued at onboarding, a test site and a production
// site), a request signature on money-moving calls, its own statuses and webhooks.
//
// Flow:
//   - CreateBinding: POST …/sbp/qrc with qrcType TOKEN — a link (https://qr.nspk.ru/…) the payer
//     opens in their bank app (or scans as a QR code) to bind their account, no payment. Our
//     binding id is the merchant QR id, our ids travel in the metadata;
//   - GetBinding: GET …/sbp/qrc/{binding id}/tokenization/result?qrcIdType=MERCHANT — ACCEPTED
//     with the token and the payer's bank id, or REJECTED. The token is the saved method;
//   - ChargeOffSession: POST …/payments (signed) with paymentMethod SBP_TOKEN; paymentUid is our
//     attempt id, which the bank keeps unique per site. The adapter first reads the paymentUid
//     and never creates a payment the bank already knows; a lost answer is
//     provider.ErrUnknownOutcome, resolved by GetPayment(paymentUid), never by a blind repost;
//   - Refund: POST …/payments/{paymentUid}/refunds (signed), refundUid = our refund id;
//   - webhooks (payment-updated, refund-updated, tokenization-decision) are RS256 JWTs signed
//     with the same key as the bank's other webhooks (package tochka's pinned key): hints only.
//
// Test mode: a test site answers isTest=true and plays scenarios the request names (createQrc in
// the tokenization purpose, payWithToken in the payment comment, see Scenarios). Live mode is
// refused unless TOCHKA_PAY_LIVE=true, and a test answer on a live config is refused too, so
// livemode stamped on our rows is always the bank's.
//
// The adapter is a pure API client: no state beyond credentials, keys and the CA pool. Amounts
// are decimal ruble strings, parsed exactly into kopecks. Errors carry the bank's code and
// request id, never the token, the signing key, request bodies or links.
package tochkapay

import (
	"context"
	"crypto/rsa"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka"
)

// Defaults.
const (
	// DefaultBaseURL is the Pay Gateway API (the test site and the production site share it).
	DefaultBaseURL = "https://enter.tochka.com/uapi/pay"
	APIVersion     = "v1.0"
	DefaultTimeout = 30 * time.Second
	// MaxWebhookBody bounds the webhook body the HTTP handler reads.
	MaxWebhookBody = 64 << 10
	// DefaultServiceName is the subscription name the payer's bank shows (≤ 70 characters).
	DefaultServiceName = "Calab: автопополнение баланса"
	// DefaultPurpose is the binding purpose the payer's bank shows (≤ 140 characters).
	DefaultPurpose = "Привязка счёта для автопополнения баланса Calab"
	// DefaultChargePurpose is the comment of an off-session payment.
	DefaultChargePurpose = "Пополнение баланса Calab"
	// MaxBindingTTL bounds a binding link's life (the bank allows up to 90 days; a binding
	// dialog needs minutes).
	MaxBindingTTL = 24 * time.Hour
)

// Caps of the adapter: off-session charges by a binding, refunds. No hosted checkout (manual
// top-up stays on payment links) and no listing. CapReconcilableCharge, not
// CapIdempotentCharge: the bank keeps paymentUid unique, but its answer to a repeated
// paymentUid is not documented, so Registry.OffSession admits the adapter only together with
// the no-repost dispatch of ADR-0083 (§2), like package tochka.
const Caps = provider.CapOffSession | provider.CapRefund | provider.CapPartialRefund | provider.CapReconcilableCharge

// Errors of this adapter (besides the provider.Err* sentinels).
var (
	// ErrInvalidRequest: refused locally before any network call.
	ErrInvalidRequest = errors.New("tochkapay: invalid request")
	// ErrForeign: the object belongs to another site or account than ours.
	ErrForeign = errors.New("tochkapay: object of another site or account")
	// ErrModeMismatch: a test answer (isTest=true) while TOCHKA_PAY_LIVE=true. The opposite —
	// a live answer on a test config — is provider.ErrLivemodeForbidden.
	ErrModeMismatch = errors.New("tochkapay: test object on a live site config")
)

var siteUIDRe = regexp.MustCompile(`^[0-9a-zA-Z_-]{1,64}$`)

// Scenarios name the bank's test scenarios (test site only; ignored on a live config). Empty =
// the bank's default (createQrc OK_WITHOUT_CALLBACKS, payWithToken OK).
type Scenarios struct {
	CreateQrc    string // e.g. OK_SUBSCRIPTION_ACCEPTED, OK_SUBSCRIPTION_REJECTED
	PayWithToken string // OK, OK_WITHOUT_CALLBACKS, OK_REJECTED, ERROR
	Refund       string // OK_ACCEPTED, OK_REJECTED, ERROR
}

// Config of the adapter, from env (config.Billing). Secrets are never logged.
type Config struct {
	BaseURL string // TOCHKA_PAY_API_URL; default DefaultBaseURL
	Token   string // TOCHKA_PAY_API_TOKEN, else TOCHKA_API_TOKEN: the merchant's JWT key (Bearer)
	SiteUID string // TOCHKA_PAY_SITE_UID: the site issued at onboarding (test or production)
	// SigningKey: TOCHKA_PAY_SIGNING_KEY, our RSA private key (PEM, PKCS#1 or PKCS#8, ≥ 2048
	// bits) whose public half the bank registered for the site (Signature header).
	SigningKey string
	// Live: TOCHKA_PAY_LIVE. false (default): the site must be a test site (every answer
	// isTest=true, else provider.ErrLivemodeForbidden). true: a production site.
	Live bool
	// WebhookKey: the bank's webhook signing key(s) as JWK (TOCHKA_WEBHOOK_PUBLIC_KEY, shared
	// with package tochka); default tochka.DefaultWebhookKey.
	WebhookKey string
	// CallbackURL: where the bank sends this site's webhooks (optional; else the URL given at
	// onboarding).
	CallbackURL string
	Scenarios   Scenarios
	HTTPClient  *http.Client // tests; default: DefaultTimeout + system roots and Russian Trusted CA
	Timeout     time.Duration
}

// Provider is the Pay Gateway adapter. Safe for concurrent use.
type Provider struct {
	base       string
	token      string
	site       string
	key        *rsa.PrivateKey
	live       bool
	callback   string
	scenarios  Scenarios
	hc         *http.Client
	webhookKey []any
}

var (
	_ provider.Provider          = (*Provider)(nil)
	_ provider.OffSessionCharger = (*Provider)(nil)
	_ provider.AccountBinder     = (*Provider)(nil)
	_ provider.RefundLister      = (*Provider)(nil)
	_ provider.LivemodeReporter  = (*Provider)(nil)
)

// New validates the config and builds the adapter. It makes no network call.
func New(cfg Config) (*Provider, error) {
	token := strings.TrimSpace(cfg.Token)
	if token == "" {
		return nil, fmt.Errorf("%w: TOCHKA_PAY_API_TOKEN / TOCHKA_API_TOKEN is empty", ErrInvalidRequest)
	}
	if !siteUIDRe.MatchString(cfg.SiteUID) {
		return nil, fmt.Errorf("%w: TOCHKA_PAY_SITE_UID must be the site id issued by the bank", ErrInvalidRequest)
	}
	key, err := ParseSigningKey(cfg.SigningKey)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	if !strings.HasPrefix(base, "https://") && !strings.HasPrefix(base, "http://127.0.0.1") && !strings.HasPrefix(base, "http://localhost") {
		return nil, fmt.Errorf("%w: TOCHKA_PAY_API_URL must be https", ErrInvalidRequest)
	}
	if cfg.CallbackURL != "" && !strings.HasPrefix(cfg.CallbackURL, "https://") && !strings.HasPrefix(cfg.CallbackURL, "http://127.0.0.1") {
		return nil, fmt.Errorf("%w: the Pay Gateway callback URL must be https", ErrInvalidRequest)
	}
	keySpec := cfg.WebhookKey
	if strings.TrimSpace(keySpec) == "" {
		keySpec = tochka.DefaultWebhookKey
	}
	keys, err := tochka.ParseKeys(keySpec)
	if err != nil {
		return nil, err
	}
	hc := cfg.HTTPClient
	if hc == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = DefaultTimeout
		}
		pool, err := tochka.RootCAs()
		if err != nil {
			return nil, err
		}
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		hc = &http.Client{Timeout: timeout, Transport: tr}
	}
	sc := cfg.Scenarios
	if cfg.Live {
		sc = Scenarios{} // scenarios exist on test sites only
	}
	return &Provider{
		base: base, token: token, site: cfg.SiteUID, key: key, live: cfg.Live, callback: cfg.CallbackURL,
		scenarios: sc, hc: hc, webhookKey: keys,
	}, nil
}

// ID is provider.TochkaPay.
func (p *Provider) ID() provider.ID { return provider.TochkaPay }

// Caps of the adapter.
func (p *Provider) Caps() provider.Cap { return Caps }

// Livemode is TOCHKA_PAY_LIVE: every answer is checked against it (isTest).
func (p *Provider) Livemode() bool { return p.live }

// SiteUID is the provider account of every Pay Gateway object.
func (p *Provider) SiteUID() string { return p.site }

// EnsureCustomer makes no call: the gateway has no customer objects; the customer is our billing account id,
// sent as customer.account with every payment and read back by GetPayment. No network call.
func (p *Provider) EnsureCustomer(_ context.Context, req provider.CustomerReq) (provider.CustomerRef, error) {
	if req.AccountID == [16]byte{} {
		return provider.CustomerRef{}, fmt.Errorf("%w: customer without an account id", ErrInvalidRequest)
	}
	return provider.CustomerRef{Provider: provider.TochkaPay, ProviderAccount: p.site, Livemode: p.live, ID: req.AccountID.String()}, nil
}

// CreateCheckout is not offered: manual top-up stays on payment links (package tochka), which
// carry the bank's 54-FZ receipt.
func (p *Provider) CreateCheckout(context.Context, provider.CheckoutReq) (provider.CheckoutSession, error) {
	return provider.CheckoutSession{}, fmt.Errorf("tochkapay: hosted checkout: %w", provider.ErrNotSupported)
}

// GetCheckout is not supported, see CreateCheckout.
func (p *Provider) GetCheckout(context.Context, string) (provider.CheckoutFact, error) {
	return provider.CheckoutFact{}, fmt.Errorf("tochkapay: hosted checkout: %w", provider.ErrNotSupported)
}

// ListPayments is not supported: the gateway lists payments only per QR code, not per site; reconciliation reads
// every payment by its paymentUid (our attempt id).
func (p *Provider) ListPayments(context.Context, provider.ListReq) ([]provider.PaymentFact, string, error) {
	return nil, "", fmt.Errorf("tochkapay: list payments: %w", provider.ErrNotSupported)
}
