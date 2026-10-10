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
	// BILLING_TOCHKA_ENABLED: the Tochka adapter (RU market, RUB; ADR-0083): checkouts, its
	// webhook and polling. Needs BILLING_PROVIDERS with tochka:ru.
	TochkaEnabled bool `env:"BILLING_TOCHKA_ENABLED"`
	// BILLING_PROVIDERS: which provider serves which market, "stripe:global" (v1),
	// "stripe:global,tochka:ru" with Tochka.
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

	// Tochka (ADR-0083). The token lives in the secret store, never in the repository; it is
	// live only (the bank has no test mode for payments).
	TochkaAPIToken     string `env:"TOCHKA_API_TOKEN"`     // JWT key of the merchant (Bearer)
	TochkaCustomerCode string `env:"TOCHKA_CUSTOMER_CODE"` // 9 characters: the company as the bank's client
	TochkaMerchantID   string `env:"TOCHKA_MERCHANT_ID"`   // 15 digits: the internet-acquiring retail point
	// TOCHKA_API_URL: default https://enter.tochka.com/uapi (sandbox: …/sandbox/v2, canned answers).
	TochkaAPIURL string `env:"TOCHKA_API_URL"`
	// TOCHKA_TAX_SYSTEM / TOCHKA_VAT_TYPE: 54-FZ receipt of the bank's cloud cash register;
	// defaults usn_income / none (ООО «Громтех», АУСН without VAT, public offer).
	TochkaTaxSystem string `env:"TOCHKA_TAX_SYSTEM"`
	TochkaVatType   string `env:"TOCHKA_VAT_TYPE"`
	// TOCHKA_WEBHOOK_PUBLIC_KEY: the bank's webhook signing key (JWK, or a JSON array / JWK set
	// during a rotation); empty = the key pinned in the adapter (published 2026-10-10).
	TochkaWebhookKey string `env:"TOCHKA_WEBHOOK_PUBLIC_KEY"`
	// TOCHKA_CLIENT_ID: client id of the webhook API; empty = the token's iss claim.
	TochkaClientID string `env:"TOCHKA_CLIENT_ID"`

	// BILLING_TOCHKA_SBP_BINDING_ENABLED: Tochka Pay Gateway SBP account binding for RU auto-topup
	// (ADR-0083 phase 3): the tochkapay provider, its matrix row and its webhook. Needs
	// BILLING_TOCHKA_ENABLED (RU served) and the site the bank issues at onboarding.
	TochkaSBPBindingEnabled bool `env:"BILLING_TOCHKA_SBP_BINDING_ENABLED"`
	// TOCHKA_PAY_SITE_UID: the Pay Gateway site (test or production) issued at onboarding.
	TochkaPaySiteUID string `env:"TOCHKA_PAY_SITE_UID"`
	// TOCHKA_PAY_SIGNING_KEY: our RSA private key (PEM or base64 of PEM, ≥ 2048 bits) whose public
	// half the bank registered for the site; signs create payment / refund. Secret store only.
	TochkaPaySigningKey string `env:"TOCHKA_PAY_SIGNING_KEY"`
	// TOCHKA_PAY_LIVE: the site is a production site. false (default): a test site — every
	// answer must be isTest=true, live objects are refused.
	TochkaPayLive bool `env:"TOCHKA_PAY_LIVE"`
	// TOCHKA_PAY_API_TOKEN: the gateway JWT if the bank issues a separate one; empty =
	// TOCHKA_API_TOKEN (the payment-links key is accepted by the gateway, checked 2026-10-10).
	TochkaPayAPIToken string `env:"TOCHKA_PAY_API_TOKEN"`
	// TOCHKA_PAY_API_URL: default https://enter.tochka.com/uapi/pay.
	TochkaPayAPIURL string `env:"TOCHKA_PAY_API_URL"`
	// TOCHKA_PAY_CALLBACK_URL: the gateway webhook URL sent with every operation
	// (…/api/billing/tochkapay/webhook); empty = the URL given to the bank at onboarding.
	TochkaPayCallbackURL string `env:"TOCHKA_PAY_CALLBACK_URL"`
}

var tochkaPaySiteUID = regexp.MustCompile(`^[0-9a-zA-Z_-]{1,64}$`)

// TochkaPayToken is the JWT the gateway adapter uses.
func (b *Billing) TochkaPayToken() string {
	if b.TochkaPayAPIToken != "" {
		return b.TochkaPayAPIToken
	}
	return b.TochkaAPIToken
}

// validateTochkaPay checks BILLING_TOCHKA_SBP_BINDING_ENABLED (ADR-0083 phase 3). Texts never
// include key or token values.
func (b *Billing) validateTochkaPay() []error {
	if !b.TochkaSBPBindingEnabled {
		return nil
	}
	var errs []error
	if !b.TochkaEnabled {
		errs = append(errs, errors.New("BILLING_TOCHKA_SBP_BINDING_ENABLED requires BILLING_TOCHKA_ENABLED=true (the RU market)"))
	}
	if !tochkaPaySiteUID.MatchString(b.TochkaPaySiteUID) {
		errs = append(errs, errors.New("TOCHKA_PAY_SITE_UID must be the site id issued by the bank (BILLING_TOCHKA_SBP_BINDING_ENABLED=true)"))
	}
	if strings.TrimSpace(b.TochkaPaySigningKey) == "" {
		errs = append(errs, errors.New("TOCHKA_PAY_SIGNING_KEY is required for BILLING_TOCHKA_SBP_BINDING_ENABLED=true"))
	}
	if b.TochkaPayToken() == "" {
		errs = append(errs, errors.New("TOCHKA_PAY_API_TOKEN or TOCHKA_API_TOKEN is required for BILLING_TOCHKA_SBP_BINDING_ENABLED=true"))
	}
	if b.TochkaPayCallbackURL != "" && !strings.HasPrefix(b.TochkaPayCallbackURL, "https://") {
		errs = append(errs, errors.New("TOCHKA_PAY_CALLBACK_URL must be an https URL"))
	}
	return errs
}

var (
	tochkaCustomerCode = regexp.MustCompile(`^[0-9A-Za-z]{9}$`)
	tochkaMerchantID   = regexp.MustCompile(`^[0-9]{15}$`)
)

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
	spec, err := provider.ParseSpec(b.Providers)
	if err != nil {
		errs = append(errs, err)
	}
	if b.TochkaEnabled {
		if err == nil && len(spec[provider.Tochka]) == 0 {
			errs = append(errs, errors.New("BILLING_TOCHKA_ENABLED requires BILLING_PROVIDERS to include tochka:ru"))
		}
		for _, v := range [][2]string{
			{"TOCHKA_API_TOKEN", b.TochkaAPIToken}, {"BILLING_PUBLIC_RETURN_URL", b.PublicReturnURL},
		} {
			if v[1] == "" {
				errs = append(errs, fmt.Errorf("%s is required for BILLING_TOCHKA_ENABLED=true", v[0]))
			}
		}
		if !tochkaCustomerCode.MatchString(b.TochkaCustomerCode) {
			errs = append(errs, errors.New("TOCHKA_CUSTOMER_CODE must be the 9-character customer code (BILLING_TOCHKA_ENABLED=true)"))
		}
		if !tochkaMerchantID.MatchString(b.TochkaMerchantID) {
			errs = append(errs, errors.New("TOCHKA_MERCHANT_ID must be the 15-digit merchant id (BILLING_TOCHKA_ENABLED=true)"))
		}
	}
	errs = append(errs, b.validateTochkaPay()...)
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
			{"BILLING_STRIPE_ENABLED", b.StripeEnabled}, {"BILLING_TOCHKA_ENABLED", b.TochkaEnabled}, {"BILLING_DEBITS_ENABLED", b.DebitsEnabled},
			{"BILLING_TOCHKA_SBP_BINDING_ENABLED", b.TochkaSBPBindingEnabled},
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
