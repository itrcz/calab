package config

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// Billing is the balance billing configuration (ADR-0080 v5). Every flag defaults to false and
// stays false in production until the rollout step that turns it on. BILLING_ENABLED is the
// master switch: without it the billing routes answer 501 and admission uses billing.NoSeats.
// Kill switch = turn the feature flags off: no new checkouts / debits / auto-topups, while the
// webhook inbox, reconciliation, refunds and read APIs keep working.
type Billing struct {
	Enabled            bool `env:"BILLING_ENABLED"`             // master switch
	StripeEnabled      bool `env:"BILLING_STRIPE_ENABLED"`      // Stripe adapter: checkouts and the webhook
	DebitsEnabled      bool `env:"BILLING_DEBITS_ENABLED"`      // daily seat charges and renewals
	EnforcementEnabled bool `env:"BILLING_ENFORCEMENT_ENABLED"` // seat growth checks and suspension at the deadline
	AutoTopupEnabled   bool `env:"BILLING_AUTO_TOPUP_ENABLED"`  // off-session auto-topup (stays off after a DB restore until reconciled)
	SelfServe          bool `env:"BILLING_SELF_SERVE"`          // owners may start billing themselves (else a superadmin enables a workspace)
	// BILLING_AUTO_TOPUP_REQUIRE_RECONCILE: set to a new unique marker (e.g. "restore-2026-10-09")
	// after a database restore. Auto-topup starts no new charge until a superadmin ran POST
	// /api/admin/billing/auto-topup/reconcile, which records this marker (docs/06 «Резервные копии»).
	AutoTopupRequireReconcile string `env:"BILLING_AUTO_TOPUP_REQUIRE_RECONCILE"`
	// BILLING_PROVIDERS: which provider serves which market, "stripe:global" (v1).
	Providers string `env:"BILLING_PROVIDERS" envDefault:"stripe:global"`
	// BILLING_PUBLIC_RETURN_URL: where hosted checkout returns the payer (GET /api/billing/return
	// of this server's public origin), e.g. https://app.calab.io/api/billing/return.
	PublicReturnURL string `env:"BILLING_PUBLIC_RETURN_URL"`
	// BILLING_TEST_CLOCK=1: POST /api/admin/billing/test-clock may move the billing clock.
	// Development and test stands only; refused together with live Stripe keys.
	TestClock bool `env:"BILLING_TEST_CLOCK"`

	// Stripe. Keys live in the secret store, never in the repository.
	StripeSecretKey     string `env:"STRIPE_SECRET_KEY"`     // sk_test_… / rk_test_… (sk_live_ only with STRIPE_LIVEMODE_ALLOWED)
	StripeWebhookSecret string `env:"STRIPE_WEBHOOK_SECRET"` // whsec_…
	StripeAPIVersion    string `env:"STRIPE_API_VERSION"`    // pinned API version, e.g. 2026-09-30.basil
	// STRIPE_LIVEMODE_ALLOWED: live keys and livemode objects are refused unless true.
	StripeLivemodeAllowed bool `env:"STRIPE_LIVEMODE_ALLOWED"`
}

var (
	stripeKey        = regexp.MustCompile(`^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$`)
	stripeAPIVersion = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$`)
)

// StripeLiveKey reports whether STRIPE_SECRET_KEY is a live key.
func (b *Billing) StripeLiveKey() bool {
	return strings.HasPrefix(b.StripeSecretKey, "sk_live_") || strings.HasPrefix(b.StripeSecretKey, "rk_live_")
}

// validate is called by Config.Validate. Error texts never include the key values.
func (b *Billing) validate() error {
	var errs []error
	if _, err := provider.ParseSpec(b.Providers); err != nil {
		errs = append(errs, err)
	}
	if b.StripeSecretKey != "" && !stripeKey.MatchString(b.StripeSecretKey) {
		errs = append(errs, errors.New("STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_test_… / rk_test_…)"))
	}
	if b.StripeLiveKey() && !b.StripeLivemodeAllowed {
		errs = append(errs, errors.New("STRIPE_SECRET_KEY is a live key: refused unless STRIPE_LIVEMODE_ALLOWED=true"))
	}
	if b.StripeWebhookSecret != "" && !strings.HasPrefix(b.StripeWebhookSecret, "whsec_") {
		errs = append(errs, errors.New("STRIPE_WEBHOOK_SECRET must start with whsec_"))
	}
	if b.StripeAPIVersion != "" && !stripeAPIVersion.MatchString(b.StripeAPIVersion) {
		errs = append(errs, fmt.Errorf("STRIPE_API_VERSION must look like 2026-09-30 or 2026-09-30.name, got %q", b.StripeAPIVersion))
	}
	if b.PublicReturnURL != "" && Origin(b.PublicReturnURL) == "" {
		errs = append(errs, fmt.Errorf("BILLING_PUBLIC_RETURN_URL must be an absolute http(s) URL, got %q", b.PublicReturnURL))
	}
	if !b.Enabled {
		for _, f := range []struct {
			name string
			on   bool
		}{
			{"BILLING_STRIPE_ENABLED", b.StripeEnabled}, {"BILLING_DEBITS_ENABLED", b.DebitsEnabled},
			{"BILLING_ENFORCEMENT_ENABLED", b.EnforcementEnabled}, {"BILLING_AUTO_TOPUP_ENABLED", b.AutoTopupEnabled},
			{"BILLING_SELF_SERVE", b.SelfServe},
		} {
			if f.on {
				errs = append(errs, fmt.Errorf("%s requires BILLING_ENABLED=true", f.name))
			}
		}
	}
	if b.StripeEnabled {
		for _, v := range [][2]string{
			{"STRIPE_SECRET_KEY", b.StripeSecretKey}, {"STRIPE_WEBHOOK_SECRET", b.StripeWebhookSecret},
			{"STRIPE_API_VERSION", b.StripeAPIVersion}, {"BILLING_PUBLIC_RETURN_URL", b.PublicReturnURL},
		} {
			if v[1] == "" {
				errs = append(errs, fmt.Errorf("%s is required for BILLING_STRIPE_ENABLED=true", v[0]))
			}
		}
	}
	if b.AutoTopupEnabled && !b.StripeEnabled {
		errs = append(errs, errors.New("BILLING_AUTO_TOPUP_ENABLED requires BILLING_STRIPE_ENABLED=true"))
	}
	if b.TestClock && (b.StripeLivemodeAllowed || b.StripeLiveKey()) {
		errs = append(errs, errors.New("BILLING_TEST_CLOCK is refused together with live Stripe keys"))
	}
	return errors.Join(errs...)
}
