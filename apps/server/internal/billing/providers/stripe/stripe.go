// Package stripe is the Stripe adapter of the billing core: provider.Provider and
// provider.OffSessionCharger over stripe-go with a pinned API version.
//
// The adapter is a pure API client: it keeps no state beyond credentials and the merchant
// account id (resolved once), never touches the database and never logs. Rules it keeps:
//   - every create call carries the caller's idempotency key (IdemKey) and is refused without
//     one; stripe-go retries connection errors (and 429 lock timeouts) with the same key,
//     which Stripe deduplicates for 24h, so a retry never creates a second object;
//   - a lost or indefinite answer (timeout, connection reset, 5xx, 429, 409) is
//     provider.ErrUnknownOutcome; the caller retries with the same key or reconciles;
//   - live keys and livemode objects are provider.ErrLivemodeForbidden unless
//     Config.LivemodeAllowed (STRIPE_LIVEMODE_ALLOWED);
//   - errors carry Stripe's type / code / decline code / request id and a redacted message,
//     never request bodies, client secrets or keys;
//   - webhooks are verified on the raw body against every configured endpoint secret
//     (rotation) and must be rendered with APIVersion.
package stripe

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// APIVersion is the Stripe API version this adapter is written and tested against. stripe-go
// sends it on every request (Stripe-Version) and the webhook endpoint must be created with it:
// events rendered with another version are refused (ErrAPIVersionMismatch). Changing it means
// a stripe-go major upgrade plus a new run of the contract tests (build tag stripetest).
const APIVersion = "2026-08-26.dahlia"

// Defaults.
const (
	DefaultTimeout          = 30 * time.Second
	DefaultMaxRetries       = 2
	DefaultWebhookTolerance = 5 * time.Minute
	// DefaultCheckoutTTL is the hosted page lifetime when CheckoutReq.ExpiresAt is zero
	// (Stripe accepts 30 minutes .. 24 hours).
	DefaultCheckoutTTL = time.Hour
	// DefaultLineItem is the hosted page / receipt line when CheckoutReq.Description is empty.
	DefaultLineItem = "Calab balance top-up"
)

// Caps of the Stripe adapter.
const Caps = provider.CapHostedCheckout | provider.CapSaveMethod | provider.CapOffSession |
	provider.CapIdempotentCharge | provider.CapRefund | provider.CapPartialRefund |
	provider.CapDisputes | provider.CapReceipts | provider.CapListPayments

// Errors of this adapter (besides the provider.Err* sentinels).
var (
	// ErrAPIVersionMismatch: a webhook event rendered with another API version than
	// APIVersion. The endpoint must be recreated with APIVersion; answer 5xx so Stripe
	// redelivers once it is fixed, and alert.
	ErrAPIVersionMismatch = errors.New("stripe: webhook event API version mismatch")
	// ErrIdempotencyMismatch: an idempotency key reused with other parameters (Stripe 400
	// idempotency_error). A bug in the caller: the key must derive from one local row. It also
	// matches provider.ErrUnknownOutcome: the first request may have created the object.
	ErrIdempotencyMismatch = errors.New("stripe: idempotency key reused with other parameters")
	// ErrInvalidRequest: the request is refused locally before any network call.
	ErrInvalidRequest = errors.New("stripe: invalid request")
)

// Config of the adapter. Build it from config.Billing (see FromEnv); keys are never logged.
type Config struct {
	SecretKey string // STRIPE_SECRET_KEY: sk_test_… / rk_test_… (live only with LivemodeAllowed)
	// WebhookSecrets: endpoint signing secrets (whsec_…); several during a rotation.
	WebhookSecrets []string
	// APIVersion: STRIPE_API_VERSION; when set it must equal APIVersion.
	APIVersion      string
	LivemodeAllowed bool // STRIPE_LIVEMODE_ALLOWED

	// Account: the merchant account (acct_…). Empty = resolved once by GET /v1/account.
	Account string
	// HTTPClient for API calls; default has Timeout per request attempt.
	HTTPClient *http.Client
	Timeout    time.Duration // per attempt, default DefaultTimeout
	// MaxRetries of stripe-go network retries (same idempotency key); nil = DefaultMaxRetries.
	MaxRetries *int64
	// BaseURL overrides https://api.stripe.com (tests).
	BaseURL          string
	WebhookTolerance time.Duration // default DefaultWebhookTolerance
}

// FromEnv builds a Config from the env values (config.Billing fields); webhookSecret may be
// a comma-separated list during a rotation.
func FromEnv(secretKey, webhookSecret, apiVersion string, livemodeAllowed bool) Config {
	var secrets []string
	for _, s := range strings.Split(webhookSecret, ",") {
		if s = strings.TrimSpace(s); s != "" {
			secrets = append(secrets, s)
		}
	}
	return Config{SecretKey: secretKey, WebhookSecrets: secrets, APIVersion: apiVersion, LivemodeAllowed: livemodeAllowed}
}

// Provider is the Stripe adapter. Safe for concurrent use.
type Provider struct {
	sc        *stripego.Client
	secrets   []string
	live      bool // the key is a live key
	allowLive bool
	tolerance time.Duration
	mu        sync.Mutex
	account   string
}

var (
	_ provider.Provider          = (*Provider)(nil)
	_ provider.OffSessionCharger = (*Provider)(nil)
)

// New validates the config and builds the adapter. It makes no network call.
func New(cfg Config) (*Provider, error) {
	key := strings.TrimSpace(cfg.SecretKey)
	switch {
	case key == "":
		return nil, fmt.Errorf("%w: STRIPE_SECRET_KEY is empty", ErrInvalidRequest)
	case !strings.HasPrefix(key, "sk_") && !strings.HasPrefix(key, "rk_"):
		return nil, fmt.Errorf("%w: STRIPE_SECRET_KEY must be a secret or restricted key", ErrInvalidRequest)
	}
	live := strings.HasPrefix(key, "sk_live_") || strings.HasPrefix(key, "rk_live_")
	if live && !cfg.LivemodeAllowed {
		return nil, fmt.Errorf("stripe: live key while STRIPE_LIVEMODE_ALLOWED=false: %w", provider.ErrLivemodeForbidden)
	}
	if !live && !strings.HasPrefix(key, "sk_test_") && !strings.HasPrefix(key, "rk_test_") {
		return nil, fmt.Errorf("%w: STRIPE_SECRET_KEY has an unknown mode prefix", ErrInvalidRequest)
	}
	if stripego.APIVersion != APIVersion {
		return nil, fmt.Errorf("stripe: stripe-go is pinned to %s, the adapter to %s", stripego.APIVersion, APIVersion)
	}
	if cfg.APIVersion != "" && cfg.APIVersion != APIVersion {
		return nil, fmt.Errorf("stripe: STRIPE_API_VERSION %q does not match the adapter's pinned %s", cfg.APIVersion, APIVersion)
	}
	for _, s := range cfg.WebhookSecrets {
		if !strings.HasPrefix(s, "whsec_") {
			return nil, fmt.Errorf("%w: STRIPE_WEBHOOK_SECRET entries must start with whsec_", ErrInvalidRequest)
		}
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: timeout}
	}
	retries := int64(DefaultMaxRetries)
	if cfg.MaxRetries != nil {
		retries = *cfg.MaxRetries
	}
	bc := &stripego.BackendConfig{
		HTTPClient:        hc,
		MaxNetworkRetries: stripego.Int64(retries),
		// Silent: stripe-go's logger prints error bodies, which may carry client secrets.
		LeveledLogger:   &stripego.LeveledLogger{Level: stripego.LevelNull},
		EnableTelemetry: stripego.Bool(false),
	}
	if cfg.BaseURL != "" {
		bc.URL = stripego.String(strings.TrimRight(cfg.BaseURL, "/"))
	}
	backends := stripego.NewBackendsWithConfig(bc)
	tol := cfg.WebhookTolerance
	if tol <= 0 {
		tol = DefaultWebhookTolerance
	}
	return &Provider{
		sc:        stripego.NewClient(key, stripego.WithBackends(backends)),
		secrets:   append([]string(nil), cfg.WebhookSecrets...),
		live:      live,
		allowLive: cfg.LivemodeAllowed,
		tolerance: tol,
		account:   cfg.Account,
	}, nil
}

// ID is provider.Stripe.
func (p *Provider) ID() provider.ID { return provider.Stripe }

// Caps of Stripe.
func (p *Provider) Caps() provider.Cap { return Caps }

// Livemode reports whether the adapter runs with a live key.
func (p *Provider) Livemode() bool { return p.live }

// Account returns the merchant account id (acct_…), resolving it once by GET /v1/account.
// Call it at startup so webhooks do not depend on the first lookup. A failed lookup is
// retried on the next call.
func (p *Provider) Account(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.account != "" {
		return p.account, nil
	}
	a, err := p.sc.V1Accounts.Retrieve(ctx, &stripego.AccountRetrieveParams{})
	if err != nil {
		return "", mapErr("account", err)
	}
	if a.ID == "" {
		return "", fmt.Errorf("stripe account: empty id: %w", provider.ErrUnknownOutcome)
	}
	p.account = a.ID
	return p.account, nil
}

// checkLive refuses livemode objects unless allowed.
func (p *Provider) checkLive(op string, livemode bool) error {
	if livemode && !p.allowLive {
		return fmt.Errorf("stripe %s: livemode object while STRIPE_LIVEMODE_ALLOWED=false: %w", op, provider.ErrLivemodeForbidden)
	}
	return nil
}

func requireKey(op, key string) error {
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("%w: %s needs an idempotency key", ErrInvalidRequest, op)
	}
	if len(key) > 255 {
		return fmt.Errorf("%w: %s idempotency key longer than 255", ErrInvalidRequest, op)
	}
	return nil
}
