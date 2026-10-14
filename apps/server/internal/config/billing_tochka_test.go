package config

import (
	"strings"
	"testing"
)

func TestBillingTochkaValidation(t *testing.T) {
	billingEnv(t)
	t.Setenv("BILLING_ENABLED", "true")
	t.Setenv("BILLING_TOCHKA_ENABLED", "true")
	t.Setenv("BILLING_PROVIDERS", "stripe:global,tochka:ru")
	t.Setenv("TOCHKA_API_TOKEN", "header.payload.signature")
	t.Setenv("TOCHKA_CUSTOMER_CODE", "300123123")
	t.Setenv("TOCHKA_MERCHANT_ID", "200000000001234")
	t.Setenv("BILLING_PUBLIC_RETURN_URL", "https://app.calab.test/api/billing/return")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.Billing.TochkaEnabled || c.Billing.StripeEnabled {
		t.Fatalf("%+v", c.Billing)
	}
	for _, tc := range []struct{ name, key, val, want string }{
		{"spec", "BILLING_PROVIDERS", "stripe:global", "tochka:ru"},
		{"token", "TOCHKA_API_TOKEN", "", "TOCHKA_API_TOKEN"},
		{"customer", "TOCHKA_CUSTOMER_CODE", "12", "TOCHKA_CUSTOMER_CODE"},
		{"merchant", "TOCHKA_MERCHANT_ID", "x", "TOCHKA_MERCHANT_ID"},
		{"return", "BILLING_PUBLIC_RETURN_URL", "", "BILLING_PUBLIC_RETURN_URL"},
		{"master", "BILLING_ENABLED", "false", "requires BILLING_ENABLED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.key, tc.val)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if err != nil && strings.Contains(err.Error(), "header.payload.signature") {
				t.Fatal("token value in the error")
			}
		})
	}
}

func TestBillingTochkaWebhookURL(t *testing.T) {
	billingEnv(t)
	t.Setenv("BILLING_ENABLED", "true")
	t.Setenv("BILLING_TOCHKA_ENABLED", "true")
	t.Setenv("BILLING_PROVIDERS", "tochka:ru")
	t.Setenv("TOCHKA_API_TOKEN", "header.payload.signature")
	t.Setenv("TOCHKA_CUSTOMER_CODE", "300123123")
	t.Setenv("TOCHKA_MERCHANT_ID", "200000000001234")
	t.Setenv("BILLING_PUBLIC_RETURN_URL", "https://app.calab.test/api/billing/return")
	c, err := Load()
	if err != nil || c.Billing.TochkaWebhookURL != "" {
		t.Fatalf("default must be empty: %v", err)
	}
	t.Setenv("TOCHKA_WEBHOOK_URL", "https://app.calab.test/api/billing/tochka/webhook")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://app.calab.test/x", "/api/billing/tochka/webhook", "https://app.calab.test:8443/x", "https://"} {
		t.Setenv("TOCHKA_WEBHOOK_URL", bad)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "TOCHKA_WEBHOOK_URL") {
			t.Fatalf("%q: err = %v", bad, err)
		}
	}
	t.Setenv("TOCHKA_WEBHOOK_URL", "https://app.calab.test/x")
	t.Setenv("BILLING_TOCHKA_ENABLED", "false")
	t.Setenv("BILLING_PROVIDERS", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "TOCHKA_WEBHOOK_URL requires") {
		t.Fatalf("err = %v", err)
	}
}

func TestBillingTochkaDefaultOff(t *testing.T) {
	billingEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Billing.TochkaEnabled {
		t.Fatal("BILLING_TOCHKA_ENABLED on by default")
	}
}
