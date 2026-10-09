package config

import (
	"strings"
	"testing"
)

func billingEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
}

// Placeholder keys built at run time: no key-shaped literal sits in the repository.
func fakeKey(prefix string) string { return prefix + strings.Repeat("x", 24) }

func TestBillingDefaultsOff(t *testing.T) {
	billingEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	b := c.Billing
	if b.Enabled || b.StripeEnabled || b.DebitsEnabled || b.EnforcementEnabled || b.AutoTopupEnabled || b.SelfServe || b.TestClock || b.StripeLivemodeAllowed {
		t.Fatalf("a billing flag is on by default: %+v", b)
	}
	if b.Providers != "stripe:global" {
		t.Fatalf("providers %q", b.Providers)
	}
}

func TestBillingValidation(t *testing.T) {
	billingEnv(t)
	t.Setenv("BILLING_ENABLED", "true")
	t.Setenv("BILLING_STRIPE_ENABLED", "true")
	t.Setenv("STRIPE_SECRET_KEY", fakeKey("sk_test_"))
	t.Setenv("STRIPE_WEBHOOK_SECRET", fakeKey("whsec_"))
	t.Setenv("STRIPE_API_VERSION", "2026-09-30.basil")
	t.Setenv("BILLING_PUBLIC_RETURN_URL", "https://app.calab.test/api/billing/return")
	t.Setenv("BILLING_AUTO_TOPUP_ENABLED", "true")
	if _, err := Load(); err != nil {
		t.Fatalf("valid test configuration: %v", err)
	}

	for _, c := range []struct {
		name, key, value, want string
	}{
		{"live key refused", "STRIPE_SECRET_KEY", fakeKey("sk_live_"), "live key"},
		{"restricted live key refused", "STRIPE_SECRET_KEY", fakeKey("rk_live_"), "live key"},
		{"publishable key refused", "STRIPE_SECRET_KEY", fakeKey("pk_test_"), "STRIPE_SECRET_KEY must be"},
		{"webhook secret", "STRIPE_WEBHOOK_SECRET", "secret", "whsec_"},
		{"api version", "STRIPE_API_VERSION", "latest", "STRIPE_API_VERSION"},
		{"return url", "BILLING_PUBLIC_RETURN_URL", "app.calab.test/return", "BILLING_PUBLIC_RETURN_URL"},
		{"stripe needs key", "STRIPE_SECRET_KEY", "", "STRIPE_SECRET_KEY is required"},
		{"providers", "BILLING_PROVIDERS", "stripe:mars", "BILLING_PROVIDERS"},
		{"master switch", "BILLING_ENABLED", "false", "requires BILLING_ENABLED"},
		{"test clock with live", "STRIPE_LIVEMODE_ALLOWED", "true", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv(c.key, c.value)
			if c.name == "test clock with live" {
				t.Setenv("BILLING_TEST_CLOCK", "true")
				c.want = "BILLING_TEST_CLOCK"
			}
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v, want %q", err, c.want)
			}
			if c.value != "" && strings.Contains(err.Error(), c.value) && strings.HasPrefix(c.value, "sk_") {
				t.Fatal("error text leaks the key")
			}
		})
	}

	// A live key passes only with STRIPE_LIVEMODE_ALLOWED.
	t.Setenv("STRIPE_SECRET_KEY", fakeKey("sk_live_"))
	t.Setenv("STRIPE_LIVEMODE_ALLOWED", "true")
	if _, err := Load(); err != nil {
		t.Fatalf("live key with livemode allowed: %v", err)
	}
	// Auto-topup needs the Stripe adapter.
	t.Setenv("BILLING_STRIPE_ENABLED", "false")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BILLING_AUTO_TOPUP_ENABLED requires BILLING_STRIPE_ENABLED") {
		t.Fatalf("auto-topup without stripe: %v", err)
	}
}
