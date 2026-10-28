package calendar

import (
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"strings"
	"testing"
	"time"
)

func TestWidgetGrantPurposeAndExpiry(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	secret := []byte("calendar-test-secret-calendar-test-secret")
	uid, sid := uuid.New(), uuid.New()
	claims := widgetClaims{Session: sid.String(), RegisteredClaims: jwt.RegisteredClaims{Issuer: widgetPurpose, Subject: uid.String(), Audience: jwt.ClaimStrings{"calendar-widget"}, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour))}}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tok.Header["typ"] = "calendar-widget"
	signed, err := tok.SignedString(widgetKey(secret))
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := parseWidgetGrant(secret, signed, now)
	if err != nil || id.UserID != uid || id.SessionID != sid {
		t.Fatalf("grant failed %v %v", id, err)
	}
	if _, err = auth.NewTokens(secret, time.Hour).Parse(signed); err == nil {
		t.Fatal("widget token accepted as API access")
	}
	access, _, err := auth.NewTokens(secret, time.Hour).Issue(uid, sid, 0)
	if err != nil {
		t.Fatal(err)
	}
	rsvp := signRSVP(tokenKey(secret), rsvpClaims{Event: uid, Status: statusView, Email: "example@example.org", Exp: now.Add(time.Hour)})
	for _, raw := range []string{access, rsvp, "", strings.Repeat("x", 2049), signed[:len(signed)-10] + "AAAAAAAAAA"} {
		if _, _, e := parseWidgetGrant(secret, raw, now); e == nil {
			t.Fatal("foreign/malformed credential accepted")
		}
	}
	if _, _, err = parseWidgetGrant(secret, signed, now.Add(time.Hour)); err == nil {
		t.Fatal("expired grant accepted")
	}
	if _, _, err = parseWidgetGrant([]byte("other-key"), signed, now); err == nil {
		t.Fatal("other deployment grant accepted")
	}
}
