package config

import (
	"strings"
	"testing"
)

// ADR-0083 phase 3: the SBP binding flag needs RU (Tochka) on, the site and our signing key.
func TestBillingTochkaPayValidation(t *testing.T) {
	billingEnv(t)
	t.Setenv("BILLING_ENABLED", "true")
	t.Setenv("BILLING_TOCHKA_ENABLED", "true")
	t.Setenv("BILLING_PROVIDERS", "stripe:global,tochka:ru")
	t.Setenv("TOCHKA_API_TOKEN", "header.payload.signature")
	t.Setenv("TOCHKA_CUSTOMER_CODE", "300123123")
	t.Setenv("TOCHKA_MERCHANT_ID", "200000000001234")
	t.Setenv("BILLING_PUBLIC_RETURN_URL", "https://app.calab.test/api/billing/return")
	t.Setenv("BILLING_TOCHKA_SBP_BINDING_ENABLED", "true")
	t.Setenv("TOCHKA_PAY_SITE_UID", "calab-test-site")
	t.Setenv("TOCHKA_PAY_SIGNING_KEY", "placeholder-not-a-key-secretvalue")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.Billing.TochkaSBPBindingEnabled || c.Billing.TochkaPayLive || c.Billing.TochkaPayToken() != "header.payload.signature" {
		t.Fatalf("%+v", c.Billing)
	}
	for _, tc := range []struct{ name, key, val, want string }{
		{"tochka off", "BILLING_TOCHKA_ENABLED", "false", "requires BILLING_TOCHKA_ENABLED"},
		{"site", "TOCHKA_PAY_SITE_UID", "", "TOCHKA_PAY_SITE_UID"},
		{"site chars", "TOCHKA_PAY_SITE_UID", "a/b", "TOCHKA_PAY_SITE_UID"},
		{"key", "TOCHKA_PAY_SIGNING_KEY", " ", "TOCHKA_PAY_SIGNING_KEY"},
		{"callback", "TOCHKA_PAY_CALLBACK_URL", "http://app.calab.test/x", "TOCHKA_PAY_CALLBACK_URL"},
		{"master", "BILLING_ENABLED", "false", "BILLING_TOCHKA_SBP_BINDING_ENABLED requires BILLING_ENABLED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.key, tc.val)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if strings.Contains(err.Error(), "secretvalue") || strings.Contains(err.Error(), "header.payload.signature") {
				t.Fatal("secret in the error")
			}
		})
	}
	t.Setenv("TOCHKA_PAY_API_TOKEN", "gateway.only.token")
	c, err = Load()
	if err != nil || c.Billing.TochkaPayToken() != "gateway.only.token" {
		t.Fatalf("separate token: %v", err)
	}
}

func TestBillingTochkaPayDefaultOff(t *testing.T) {
	billingEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Billing.TochkaSBPBindingEnabled || c.Billing.TochkaPayLive {
		t.Fatal("SBP binding on by default")
	}
}
