package config

import (
	"strings"
	"testing"
	"time"
)

func TestAllowedOrigins(t *testing.T) {
	c := &Config{PublicAppURL: "https://App.Example.com/", PublicAppURLAlt: "https://app.example.ru:8443/x"}
	got := c.AllowedOrigins()
	if len(got) != 2 || got[0] != "https://app.example.com" || got[1] != "https://app.example.ru:8443" {
		t.Fatalf("%v", got)
	}
	for _, bad := range []string{"app.example.com", "ftp://x", "", "https://"} {
		if Origin(bad) != "" {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPublicAppURLs(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUBLIC_APP_URL", "https://app.calab.io")
	t.Setenv("PUBLIC_APP_URL_ALT", "https://colaba.gptunnel.ai")
	t.Setenv("PUBLIC_APP_URLS", "https://app.calab.io, https://App.Calab.ru/, https://Colaba.GPTunnel.ru/ ,https://colaba.gptunnel.ai")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(c.AllowedOrigins(), " ")
	if got != "https://app.calab.io https://colaba.gptunnel.ai https://app.calab.ru https://colaba.gptunnel.ru" {
		t.Fatalf("origins: %s", got)
	}
	t.Setenv("PUBLIC_APP_URLS", "https://ok.example, calab.io")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "PUBLIC_APP_URLS") {
		t.Fatalf("bad entry accepted: %v", err)
	}
}

// Token lifetimes: 24 h / 1 year by default (owner, 2026-09-29), tightened via env,
// access ≥ 1m and refresh ≥ access.
func TestTokenTTLs(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessTokenTTL != 24*time.Hour || c.RefreshTokenTTL != 8760*time.Hour {
		t.Fatalf("defaults: access %v refresh %v", c.AccessTokenTTL, c.RefreshTokenTTL)
	}
	// Set but empty (a compose/.env line without a value) = the default, not a parse error.
	t.Setenv("ACCESS_TOKEN_TTL", "")
	t.Setenv("REFRESH_TOKEN_TTL", "")
	if c, err = Load(); err != nil {
		t.Fatalf("empty TTLs: %v", err)
	}
	if c.AccessTokenTTL != 24*time.Hour || c.RefreshTokenTTL != 8760*time.Hour {
		t.Fatalf("empty TTLs: access %v refresh %v", c.AccessTokenTTL, c.RefreshTokenTTL)
	}
	t.Setenv("ACCESS_TOKEN_TTL", "15m")
	t.Setenv("REFRESH_TOKEN_TTL", "720h")
	if c, err = Load(); err != nil {
		t.Fatal(err)
	}
	if c.AccessTokenTTL != 15*time.Minute || c.RefreshTokenTTL != 720*time.Hour {
		t.Fatalf("tightened: access %v refresh %v", c.AccessTokenTTL, c.RefreshTokenTTL)
	}
	for _, bad := range [][2]string{{"30s", "720h"}, {"48h", "24h"}} {
		t.Setenv("ACCESS_TOKEN_TTL", bad[0])
		t.Setenv("REFRESH_TOKEN_TTL", bad[1])
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "ACCESS_TOKEN_TTL") {
			t.Fatalf("%v accepted: %v", bad, err)
		}
	}
}

// EMAIL_VERIFICATION (ADR-0065): required by default, optional on request, anything else
// is a startup error.
func TestEmailVerificationMode(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.EmailVerification != EmailVerificationRequired {
		t.Fatalf("default: %q", c.EmailVerification)
	}
	t.Setenv("EMAIL_VERIFICATION", "optional")
	if c, err = Load(); err != nil || c.EmailVerification != EmailVerificationOptional {
		t.Fatalf("optional: %q %v", c.EmailVerification, err)
	}
	for _, bad := range []string{"off", "Optional", "none"} {
		t.Setenv("EMAIL_VERIFICATION", bad)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "EMAIL_VERIFICATION") {
			t.Fatalf("%q accepted: %v", bad, err)
		}
	}
}
