//go:build integration

package app_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

func authorizationWire(t *testing.T, base, method, path, media, body, bearer string, cookies []*http.Cookie) (int, http.Header, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if media != "" {
		r.Header.Set("Content-Type", media)
	}
	r.Header.Set("Origin", "https://client.example")
	r.Header.Set("X-Forwarded-For", "10.97.0.1")
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, data
}

func TestIdentityProviderAuthorizationPOSTBrowserResolverAndRouteCensus(t *testing.T) {
	f := identitySetup(t, "optional")
	a, base := identityHTTP(t)
	pattern := "POST /oidc/workspaces/{workspace}/authorize"
	found := false
	for _, p := range a.Routes {
		found = found || p == pattern
	}
	if !found || !app.IdentityRouteCovered(pattern) {
		t.Fatal("POST authorization is missing from the real App route census")
	}
	c := quotaClient(t, base, f.a.Id, v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE)
	if _, err := testDB.Q.CreateOAuthConsent(context.Background(), sqlc.CreateOAuthConsentParams{WorkspaceID: uuid.MustParse(f.a.Id), UserID: uuid.MustParse(f.local.id), ClientID: uuid.MustParse(c.Client.Id), Scopes: []string{"openid"}}); err != nil {
		t.Fatal(err)
	}
	// The consent records the client name the user saw (prompt=none re-checks it).
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE oauth_consents SET client_name=$1 WHERE client_id=$2", c.Client.Name, uuid.MustParse(c.Client.Id)); err != nil {
		t.Fatal(err)
	}
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	args := url.Values{"client_id": {c.Client.ClientId}, "redirect_uri": {c.Client.RedirectUris[0]}, "response_type": {"code"}, "scope": {"openid"}, "state": {"post-cookie-state"}, "nonce": {"post-cookie-nonce"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "prompt": {"none"}}
	path := "/oidc/workspaces/" + f.a.Id + "/authorize"
	localCookie := &http.Cookie{Name: auth.LocalBrowserCookie, Value: f.local.refresh, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}
	scopedCookie := &http.Cookie{Name: "__Host-calab-workspace-session-" + f.a.Id, Value: f.scoped.refresh, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}
	// A desktop answers its web app's «Sign in with Calab» with the session bearer alone
	// (ADR-0159); a member of another workspace only gets no code for this one that way.
	outsider := register(t, invite(t, owner(t), f.b.Id))
	for _, method := range []string{"GET", "POST"} {
		for _, tc := range []struct {
			name, bearer, want string
			cookies            []*http.Cookie
		}{
			{"local", "", "", []*http.Cookie{localCookie}},
			{"scoped A", "", "", []*http.Cookie{scopedCookie}},
			{"no cookie", "", "login_required", nil},
			{"wrong workspace cookie", "", "login_required", []*http.Cookie{{Name: "__Host-calab-workspace-session-" + f.b.Id, Value: f.scoped.refresh, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}}},
			{"wrong authority cookie", "", "login_required", []*http.Cookie{{Name: auth.LocalBrowserCookie, Value: f.scoped.refresh, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}}},
			{"provider token cookie", "", "login_required", []*http.Cookie{{Name: auth.LocalBrowserCookie, Value: "calab_or_" + strings.Repeat("a", 43), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}}},
			{"account mismatch", owner(t).token, "login_required", []*http.Cookie{localCookie}},
			{"desktop bearer", f.local.token, "", nil},
			{"other workspace bearer", outsider.token, "interaction_required", nil},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				p, body, media := path, args.Encode(), "application/x-www-form-urlencoded"
				if method == "GET" {
					p, body, media = path+"?"+args.Encode(), "", ""
				}
				st, h, raw := authorizationWire(t, base, method, p, media, body, tc.bearer, tc.cookies)
				u, err := url.Parse(h.Get("Location"))
				if st != http.StatusSeeOther || err != nil || u.Query().Get("error") != tc.want || u.Query().Get("state") != args.Get("state") || u.Query().Get("iss") != "https://app.example.com/oidc/workspaces/"+f.a.Id || h.Get("Access-Control-Allow-Origin") != "" {
					t.Fatalf("browser resolver %d %v %s (%v)", st, h, raw, err)
				}
				if tc.want == "" && u.Query().Get("code") == "" {
					t.Fatal("cookie prompt=none did not issue a code")
				}
			})
		}
	}
	// Resolution does not rotate or revoke either first-party refresh secret.
	for _, raw := range []string{f.local.refresh, f.scoped.refresh} {
		if _, err := a.Auth.PrincipalFromRefresh(context.Background(), raw); err != nil {
			t.Fatalf("authorization mutated browser credentials: %v", err)
		}
	}
	for _, endpoint := range []string{"/api/me/oauth-grants", "/api/workspaces/" + f.a.Id + "/oauth/clients"} {
		st, raw, _ := identityRequest(t, base, "GET", endpoint, "", "https://app.example.com", []*http.Cookie{localCookie}, nil)
		if st != 401 {
			t.Fatalf("POST browser resolver broadened management cookie auth: %d %s", st, raw)
		}
	}
	// Both methods use the same existing provider wrapper and authorize quota
	// behavior. No token or management budget is spent by these authorizations.
	for i := range 34 {
		method, p, body, media := "POST", path, args.Encode(), "application/x-www-form-urlencoded"
		if i%2 == 0 {
			method, p, body, media = "GET", path+"?"+args.Encode(), "", ""
		}
		st, h, raw := authorizationWire(t, base, method, p, media, body, "", []*http.Cookie{localCookie})
		if st != 303 || strings.Contains(h.Get("Location"), "error=") || h.Get("Retry-After") != "" {
			t.Fatalf("authorize method quota parity: %d %v %s", st, h, raw)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		p, body, media := path, args.Encode(), "application/x-www-form-urlencoded"
		if method == "GET" {
			p, body, media = path+"?"+args.Encode(), "", ""
		}
		st, h, raw := authorizationWire(t, base, method, p, media, body, "calab_bot_fixture", []*http.Cookie{localCookie})
		if st != 403 || !strings.Contains(string(raw), `"error":"access_denied"`) || h.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("bot wrapper parity: %d %v %s", st, h, raw)
		}
	}
}

func TestIdentityProviderAuthorizationPOSTRejectsInvalidForms(t *testing.T) {
	f := identitySetup(t, "optional")
	_, base := identityHTTP(t)
	c := quotaClient(t, base, f.a.Id, v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE)
	path := "/oidc/workspaces/" + f.a.Id + "/authorize"
	form := url.Values{"client_id": {c.Client.ClientId}, "redirect_uri": {c.Client.RedirectUris[0]}, "response_type": {"code"}, "scope": {"openid"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(make([]byte, 32))}}
	for _, tc := range []struct{ name, query, media, body string }{
		{"duplicate", "", "application/x-www-form-urlencoded", form.Encode() + "&prompt=none&prompt=consent"},
		{"query ambiguity", "?prompt=none", "application/x-www-form-urlencoded", form.Encode()},
		{"oversize", "", "application/x-www-form-urlencoded", strings.Repeat("x", (16<<10)+1)},
		{"malformed", "", "application/x-www-form-urlencoded", form.Encode() + "&unknown=%zz"},
		{"JSON", "", "application/json", `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, h, raw := authorizationWire(t, base, "POST", path+tc.query, tc.media, tc.body, "", []*http.Cookie{{Name: auth.LocalBrowserCookie, Value: f.local.refresh, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}})
			if st != 400 || h.Get("Location") != "" || h.Get("Access-Control-Allow-Origin") != "" || !strings.Contains(string(raw), `"error":"invalid_request"`) {
				t.Fatalf("invalid App POST: %d %v %s", st, h, raw)
			}
		})
	}
}
