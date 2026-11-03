package auth

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var secret = []byte("0123456789abcdef0123456789abcdef")

func TestAccessTokenRoundTrip(t *testing.T) {
	tk := NewTokens(secret, 15*time.Minute)
	uid, sid := uuid.New(), uuid.New()
	s, exp, err := tk.Issue(uid, sid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Until(exp); d < 14*time.Minute || d > 15*time.Minute {
		t.Fatalf("unexpected expiry in %v", d)
	}
	id, err := tk.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	if id.UserID != uid || id.SessionID != sid {
		t.Fatalf("got %+v", id)
	}
}

func TestAccessTokenRejects(t *testing.T) {
	tk := NewTokens(secret, 15*time.Minute)
	uid, sid := uuid.New(), uuid.New()
	good, _, _ := tk.Issue(uid, sid, 0)

	expired := NewTokens(secret, 15*time.Minute)
	expired.now = func() time.Time { return time.Now().Add(-time.Hour) }
	old, _, _ := expired.Issue(uid, sid, 0)

	other, _, _ := NewTokens([]byte("another-secret-another-secret-xx"), time.Minute).Issue(uid, sid, 0)

	// alg=none and a different HMAC alg must be rejected.
	none, _ := jwt.NewWithClaims(jwt.SigningMethodNone, Claims{SessionID: sid.String(),
		RegisteredClaims: jwt.RegisteredClaims{Issuer: issuer, Subject: uid.String(),
			IssuedAt: jwt.NewNumericDate(time.Now()), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).
		SignedString(jwt.UnsafeAllowNoneSignatureType)
	hs512, _ := jwt.NewWithClaims(jwt.SigningMethodHS512, Claims{SessionID: sid.String(),
		RegisteredClaims: jwt.RegisteredClaims{Issuer: issuer, Subject: uid.String(),
			IssuedAt: jwt.NewNumericDate(time.Now()), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).
		SignedString(secret)
	noExp, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{SessionID: sid.String(),
		RegisteredClaims: jwt.RegisteredClaims{Issuer: issuer, Subject: uid.String()}}).SignedString(secret)

	for name, tok := range map[string]string{
		"expired": old, "wrong secret": other, "alg none": none, "hs512": hs512, "no exp": noExp,
		"garbage": "abc", "tampered": good[:len(good)-2] + "xx",
	} {
		if _, err := tk.Parse(tok); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRefreshTokenFormat(t *testing.T) {
	sec, hash, err := NewRefreshSecret()
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.New()
	tok := FormatRefreshToken(sid, sec)
	gotSID, gotSec, ok := ParseRefreshToken(tok)
	if !ok || gotSID != sid || gotSec != sec {
		t.Fatalf("round trip failed: %v %v %v", ok, gotSID, gotSec)
	}
	if string(HashRefreshSecret(gotSec)) != string(hash) {
		t.Fatal("hash mismatch")
	}
	sec2, _, _ := NewRefreshSecret()
	if sec2 == sec {
		t.Fatal("secrets repeat")
	}
	for _, bad := range []string{"", sid.String(), "x." + sec, sid.String() + "." + sec[:10], sid.String() + "." + strings.Repeat("!", 43)} {
		if _, _, ok := ParseRefreshToken(bad); ok {
			t.Errorf("accepted %q", bad)
		}
	}
}

// ADR-0135 addendum (2026-11-02): the server's own attribution defence keys only on the shell's
// UA marker (apps/desktop/src/shared/nativeShell.ts SHELL_UA_MARKER).
func TestFromNativeShell(t *testing.T) {
	for ua, want := range map[string]bool{
		"": false,
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Calab/3.0.6 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36":  false,
		"Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 CalabShell/1": true,
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CalabShell/1":                         true,
	} {
		if got := fromNativeShell(ua); got != want {
			t.Errorf("fromNativeShell(%q) = %v, want %v", ua, got, want)
		}
	}
}

func TestPassword(t *testing.T) {
	ctx := context.Background()
	h, err := HashPassword(ctx, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected format %q", h)
	}
	if ok, err := VerifyPassword(ctx, "correct horse", h); err != nil || !ok {
		t.Fatalf("verify good: %v %v", ok, err)
	}
	if ok, _ := VerifyPassword(ctx, "wrong horse", h); ok {
		t.Fatal("verify bad accepted")
	}
	if _, err := VerifyPassword(ctx, "x", "$argon2id$v=19$m=99999999,t=1,p=1$AAAA$AAAA"); err == nil {
		t.Fatal("absurd params accepted")
	}
	h2, _ := HashPassword(ctx, "correct horse")
	if h2 == h {
		t.Fatal("salt not random")
	}
}

func TestValidation(t *testing.T) {
	for _, e := range []string{"a@b.co", " Ann@Example.com "} {
		if _, err := NormalizeEmail(e); err != nil {
			t.Errorf("%q rejected: %v", e, err)
		}
	}
	for _, e := range []string{"", "a", "a@b", "Ann <a@b.co>", "a@@b.co"} {
		if _, err := NormalizeEmail(e); err == nil {
			t.Errorf("%q accepted", e)
		}
	}
	if _, err := ValidateDisplayName("  "); err == nil {
		t.Error("blank name accepted")
	}
	if n, err := ValidateDisplayName(" Иван "); err != nil || n != "Иван" {
		t.Errorf("got %q %v", n, err)
	}
	if clip("абвгд", 3) != "а" {
		t.Errorf("clip cut a rune: %q", clip("абвгд", 3))
	}
}
