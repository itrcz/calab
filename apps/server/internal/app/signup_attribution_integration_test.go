//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// metrikaFakeMS is the Measurement Protocol token of the run (any non-empty value enables it).
const metrikaFakeMS = "it-metrika"

// metrikaFake is the Measurement Protocol collector of the whole run (config MetrikaMPURL).
var metrikaFake = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("<!-- OK -->"))
}))

// ADR-0135: a sign-up stores its first-touch attribution and, with a Metrika ClientID, one
// signup conversion; without attribution nothing is stored.
func TestSignupAttribution(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	signup := func(a *v1.SignupAttribution) string {
		seq++
		c := &client{t: t, ip: fmt.Sprintf("10.9.%d.%d", seq/250, seq%250+1)}
		var resp v1.RegisterResponse
		c.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{Email: uniq("attr") + "@example.com", Password: "password123",
			DisplayName: "Attr", InviteCode: code, Attribution: a}, &resp)
		return resp.GetMe().GetUser().GetId()
	}
	count := func(q, id string) int {
		var n int
		if err := testDB.Pool.QueryRow(context.Background(), q, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	const attrQ = `SELECT count(*) FROM user_attribution WHERE user_id = $1`
	const convQ = `SELECT count(*) FROM metrika_conversions WHERE dedupe_key = 'signup:' || $1 AND goal = 'signup'`

	id := signup(&v1.SignupAttribution{UtmSource: "yandex", UtmMedium: "cpc", UtmCampaign: "brand", Yclid: "991", YmClientId: "1710232430899999999"})
	var src, cid string
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT utm_source, ym_client_id FROM user_attribution WHERE user_id = $1`, id).Scan(&src, &cid); err != nil {
		t.Fatal(err)
	}
	if src != "yandex" || cid != "1710232430899999999" || count(convQ, id) != 1 {
		t.Fatalf("attribution %q %q, conversions %d", src, cid, count(convQ, id))
	}
	// UTM only (no consent on the landing → no ClientID): stored, nothing for Metrika.
	id = signup(&v1.SignupAttribution{UtmSource: "telegram", YmClientId: "not-a-number"})
	if count(attrQ, id) != 1 || count(convQ, id) != 0 {
		t.Fatalf("utm-only sign-up: attribution %d, conversions %d", count(attrQ, id), count(convQ, id))
	}
	id = signup(nil)
	if count(attrQ, id) != 0 || count(convQ, id) != 0 {
		t.Fatal("a sign-up without attribution stored something")
	}
}

// ADR-0135 addendum (2026-11-02): a registration whose request carries the phone shell's UA
// marker never gets attribution stored or converted, whatever the client sent — the server's
// own defence against an old or forged client, independent of apps/desktop (docs/mobile/
// store-listing.md "Tracking: No"). A normal user agent is unaffected.
func TestSignupAttributionNativeShell(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	attr := &v1.SignupAttribution{UtmSource: "yandex", YmClientId: "1710232430899999999"}
	signup := func(ua string) string {
		seq++
		c := &client{t: t, ip: fmt.Sprintf("10.9.%d.%d", seq/250, seq%250+1)}
		if ua != "" {
			c.header = http.Header{"User-Agent": {ua}}
		}
		var resp v1.RegisterResponse
		c.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{Email: uniq("shell") + "@example.com", Password: "password123",
			DisplayName: "Shell", InviteCode: code, Attribution: attr}, &resp)
		return resp.GetMe().GetUser().GetId()
	}
	count := func(q, id string) int {
		var n int
		if err := testDB.Pool.QueryRow(context.Background(), q, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	const attrQ = `SELECT count(*) FROM user_attribution WHERE user_id = $1`
	const convQ = `SELECT count(*) FROM metrika_conversions WHERE dedupe_key = 'signup:' || $1 AND goal = 'signup'`

	// Android and iOS shell UAs: the marker alone is the server's signal (DEV-4947).
	for _, ua := range []string{
		"Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 CalabShell/1",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CalabShell/1",
	} {
		id := signup(ua)
		if n := count(attrQ, id); n != 0 {
			t.Fatalf("shell UA %q: attribution row stored (%d)", ua, n)
		}
		if n := count(convQ, id); n != 0 {
			t.Fatalf("shell UA %q: conversion recorded (%d)", ua, n)
		}
	}
	id := signup("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Calab/3.0.6 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36")
	if count(attrQ, id) != 1 || count(convQ, id) != 1 {
		t.Fatalf("normal UA: attribution %d, conversions %d", count(attrQ, id), count(convQ, id))
	}
}
