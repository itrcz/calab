//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// MCP without a bot (ADR-0158): OAuth 2.1 for a person's MCP client.

const mcpTestRedirect = "http://127.0.0.1:33418/callback"

var oaNoFollow = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

type oaResp struct {
	status int
	header http.Header
	body   []byte
}

func oaDo(t *testing.T, method, path string, body io.Reader, header http.Header) oaResp {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), method, srv.URL+path, body)
	for k, v := range header {
		req.Header[k] = v
	}
	if req.Header.Get("X-Forwarded-For") == "" {
		seq++
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("10.58.%d.%d", seq/250, seq%250+1)) // own per-IP limit bucket
	}
	resp, err := oaNoFollow.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return oaResp{resp.StatusCode, resp.Header, b}
}

func oaJSON(t *testing.T, r oaResp) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("not JSON (%d): %s", r.status, r.body)
	}
	return m
}

func mcpRegister(t *testing.T, redirects ...string) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"client_name": "Claude Code (test)", "redirect_uris": redirects, "grant_types": []string{"authorization_code", "refresh_token"}, "token_endpoint_auth_method": "none"})
	r := oaDo(t, "POST", "/api/mcp/oauth/register", bytes.NewReader(b), http.Header{"Content-Type": {"application/json"}})
	if r.status != 201 {
		t.Fatalf("register: %d %s", r.status, r.body)
	}
	return oaJSON(t, r)["client_id"].(string)
}

// mcpFlow is one OAuth round of an MCP client: authorize in a browser, consent as u, the code.
type mcpFlow struct {
	client, verifier, handle, cookie, csrf string
}

func oaPKCE() (verifier, challenge string) {
	verifier = strings.Repeat("v", 20) + base64.RawURLEncoding.EncodeToString([]byte(uniq("pkce-verifier-")))
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func mcpAuthorize(t *testing.T, client string) *mcpFlow {
	t.Helper()
	verifier, challenge := oaPKCE()
	q := url.Values{"response_type": {"code"}, "client_id": {client}, "redirect_uri": {mcpTestRedirect}, "code_challenge": {challenge},
		"code_challenge_method": {"S256"}, "state": {"st-1"}, "scope": {"mcp"}, "resource": {"https://app.example.com/api/mcp"}}
	r := oaDo(t, "GET", "/api/mcp/oauth/authorize?"+q.Encode(), nil, nil)
	if r.status != http.StatusFound {
		t.Fatalf("authorize: %d %s", r.status, r.body)
	}
	loc := r.header.Get("Location")
	prefix := "https://app.example.com/mcp/connect#"
	if !strings.HasPrefix(loc, prefix) {
		t.Fatalf("authorize goes to %q", loc)
	}
	var cookie string
	for _, c := range (&http.Response{Header: r.header}).Cookies() {
		if c.Name == "__Host-calab_mcp" {
			cookie = c.Name + "=" + c.Value
			if !c.Secure || !c.HttpOnly || c.Path != "/" {
				t.Fatalf("binding cookie %+v", c)
			}
		}
	}
	if cookie == "" {
		t.Fatal("no binding cookie")
	}
	return &mcpFlow{client: client, verifier: verifier, handle: strings.TrimPrefix(loc, prefix), cookie: cookie}
}

func (f *mcpFlow) consent(t *testing.T, token, cookie string, allow bool, wantBind int) string {
	t.Helper()
	h := http.Header{"Authorization": {"Bearer " + token}, "Content-Type": {"application/json"}}
	if cookie != "" {
		h.Set("Cookie", cookie)
	}
	r := oaDo(t, "POST", "/api/mcp/oauth/requests/"+f.handle+"/bind", strings.NewReader("{}"), h)
	if r.status != wantBind {
		t.Fatalf("bind: %d %s, want %d", r.status, r.body, wantBind)
	}
	if r.status != 200 {
		return string(r.body)
	}
	snap := oaJSON(t, r)
	if snap["clientName"] != "Claude Code (test)" || snap["redirectUri"] != mcpTestRedirect || snap["loopback"] != true {
		t.Fatalf("snapshot %v", snap)
	}
	f.csrf = snap["csrfToken"].(string)
	b, _ := json.Marshal(map[string]any{"csrfToken": f.csrf, "allow": allow})
	r = oaDo(t, "POST", "/api/mcp/oauth/requests/"+f.handle+"/decision", bytes.NewReader(b), h)
	if r.status != 200 {
		t.Fatalf("decision: %d %s", r.status, r.body)
	}
	return oaJSON(t, r)["redirectUrl"].(string)
}

func codeOf(t *testing.T, redirect string) string {
	t.Helper()
	u, _ := url.Parse(redirect)
	if !strings.HasPrefix(redirect, mcpTestRedirect+"?") || u.Query().Get("state") != "st-1" || u.Query().Get("iss") != "https://app.example.com" {
		t.Fatalf("redirect %q", redirect)
	}
	return u.Query().Get("code")
}

func mcpTokenCall(t *testing.T, form url.Values) (int, map[string]any) {
	t.Helper()
	r := oaDo(t, "POST", "/api/mcp/oauth/token", strings.NewReader(form.Encode()), http.Header{"Content-Type": {"application/x-www-form-urlencoded"}})
	return r.status, oaJSON(t, r)
}

func mcpExchange(t *testing.T, f *mcpFlow, code string) (access, refresh string) {
	t.Helper()
	st, out := mcpTokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {f.client}, "redirect_uri": {mcpTestRedirect}, "code_verifier": {f.verifier}, "resource": {"https://app.example.com/api/mcp"}})
	if st != 200 || out["token_type"] != "Bearer" || out["scope"] != "mcp" {
		t.Fatalf("token: %d %v", st, out)
	}
	return out["access_token"].(string), out["refresh_token"].(string)
}

// mcpCall is a tools/call (or any method) with the MCP session's access token.
func mcpCall(t *testing.T, access, method string, params any) (int, map[string]any, http.Header) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	h := http.Header{"Content-Type": {"application/json"}}
	if access != "" {
		h.Set("Authorization", "Bearer "+access)
		// The connection's request limit (BOT_RATE_PER_SEC per session): tests call back to back.
		if parts := strings.Split(access, "."); len(parts) == 3 {
			raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
			var c struct {
				Sid string `json:"sid"`
			}
			_ = json.Unmarshal(raw, &c)
			_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:bot:req:mcp:"+c.Sid)).Build()).Error()
		}
	}
	r := oaDo(t, "POST", "/api/mcp", bytes.NewReader(b), h)
	var m map[string]any
	_ = json.Unmarshal(r.body, &m)
	return r.status, m, r.header
}

func mcpToolText(t *testing.T, access, name string, args map[string]any) string {
	t.Helper()
	st, out, _ := mcpCall(t, access, "tools/call", map[string]any{"name": name, "arguments": args})
	res, _ := out["result"].(map[string]any)
	if st != 200 || res == nil || res["isError"] == true {
		t.Fatalf("%s: %d %v", name, st, out)
	}
	return res["content"].([]any)[0].(map[string]any)["text"].(string)
}

// TestMCPOAuthPersonConnects: discovery, registration, consent in the browser that started it,
// the code for the person's MCP session; the tools work as the person with «via MCP» and no bot;
// the token is for the MCP endpoint only; refresh rotation, reuse and code replay revoke.
func TestMCPOAuthPersonConnects(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	board := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Dev", Key: "MOA", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)

	// Discovery: a 401 points to the resource metadata; it names this server; the server metadata.
	st, _, hdr := mcpCall(t, "", "initialize", map[string]any{})
	if st != 401 || !strings.Contains(hdr.Get("WWW-Authenticate"), `resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/api/mcp"`) {
		t.Fatalf("challenge: %d %q", st, hdr.Get("WWW-Authenticate"))
	}
	prm := oaJSON(t, oaDo(t, "GET", "/.well-known/oauth-protected-resource/api/mcp", nil, nil))
	if prm["resource"] != "https://app.example.com/api/mcp" || prm["authorization_servers"].([]any)[0] != "https://app.example.com" {
		t.Fatalf("resource metadata %v", prm)
	}
	asm := oaJSON(t, oaDo(t, "GET", "/.well-known/oauth-authorization-server", nil, nil))
	if asm["issuer"] != "https://app.example.com" || asm["token_endpoint"] != "https://app.example.com/api/mcp/oauth/token" || asm["code_challenge_methods_supported"].([]any)[0] != "S256" {
		t.Fatalf("server metadata %v", asm)
	}

	// Registration: loopback and the allowed https hosts only.
	for _, bad := range []string{"https://evil.example/cb", "http://evil.example/cb", "calab://cb", "http://127.0.0.1:1/cb#frag"} {
		b, _ := json.Marshal(map[string]any{"client_name": "x", "redirect_uris": []string{bad}})
		if r := oaDo(t, "POST", "/api/mcp/oauth/register", bytes.NewReader(b), nil); r.status != 400 {
			t.Fatalf("redirect %q registered: %d", bad, r.status)
		}
	}
	cid := mcpRegister(t, mcpTestRedirect)

	// Authorize: an unknown client or redirect is shown, never redirected; no PKCE goes back as an error.
	if r := oaDo(t, "GET", "/api/mcp/oauth/authorize?client_id="+cid+"&redirect_uri="+url.QueryEscape("http://127.0.0.1:1/other")+"&response_type=code", nil, nil); r.status != 400 {
		t.Fatalf("unregistered redirect: %d", r.status)
	}
	if r := oaDo(t, "GET", "/api/mcp/oauth/authorize?client_id="+cid+"&redirect_uri="+url.QueryEscape(mcpTestRedirect)+"&response_type=code&state=st-1", nil, nil); r.status != 302 || !strings.Contains(r.header.Get("Location"), "error=invalid_request") {
		t.Fatalf("no PKCE: %d %s", r.status, r.header.Get("Location"))
	}

	f := mcpAuthorize(t, cid)
	// Another browser (no binding cookie), a bot and a bot on behalf cannot consent.
	if body := f.consent(t, bob.token, "", true, 403); !strings.Contains(body, "MCP_OTHER_BROWSER") {
		t.Fatalf("other browser: %s", body)
	}
	bt := createBot(t, o, ws.GetId(), "mcpoauthbot")
	f.consent(t, bt.token, f.cookie, true, 403)

	code := codeOf(t, f.consent(t, bob.token, f.cookie, true, 200))
	// A wrong verifier, another client or redirect: invalid_grant, the code stays usable.
	if st, out := mcpTokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {cid}, "redirect_uri": {mcpTestRedirect}, "code_verifier": {strings.Repeat("x", 43)}}); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier: %d %v", st, out)
	}
	if st, _ := mcpTokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {mcpRegister(t, mcpTestRedirect)}, "redirect_uri": {mcpTestRedirect}, "code_verifier": {f.verifier}}); st != 400 {
		t.Fatalf("another client: %d", st)
	}
	access, refresh := mcpExchange(t, f, code)

	// The tools as bob, marked «via MCP», no bot.
	if st, out, _ := mcpCall(t, access, "tools/list", map[string]any{}); st != 200 || len(out["result"].(map[string]any)["tools"].([]any)) != 9 {
		t.Fatalf("tools/list: %d %v", st, out)
	}
	text := mcpToolText(t, access, "create_task", map[string]any{"board": "MOA", "title": "через OAuth"})
	var created struct{ ID, Key string }
	_ = json.Unmarshal([]byte(text), &created)
	mcpToolText(t, access, "comment_task", map[string]any{"task": created.Key, "text": "взял"})
	if text = mcpToolText(t, access, "assign", map[string]any{"task": created.Key, "users": []string{"me"}}); !strings.Contains(text, bob.id) {
		t.Fatalf("assign me: %s", text)
	}
	if text = mcpToolText(t, access, "list_tasks", map[string]any{"mine": true}); !strings.Contains(text, created.Key) {
		t.Fatalf("mine: %s", text)
	}
	var tr v1.TaskResponse
	o.must(200, "GET", "/api/tasks/"+created.ID, nil, &tr)
	if tr.GetTask().GetCreatedBy() != bob.id || tr.GetTask().GetBoardId() != board.GetId() {
		t.Fatalf("created_by %s", tr.GetTask().GetCreatedBy())
	}
	var page v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+created.ID+"/activity?limit=100", nil, &page)
	seen := map[string]bool{}
	for _, it := range page.GetItems() {
		if m := it.GetMessage(); m != nil && m.GetContent() == "взял" {
			seen["comment"] = m.GetAuthorId() == bob.id && m.GetVia() == "mcp" && m.GetViaBotId() == ""
		}
		if a := it.GetActivity(); a != nil && (a.GetKind() == "created" || a.GetKind() == "assignees") {
			seen[a.GetKind()] = a.GetActorId() == bob.id && a.GetVia() == "mcp" && a.GetViaBotId() == ""
		}
	}
	for _, k := range []string{"comment", "created", "assignees"} {
		if !seen[k] {
			t.Errorf("%s: not bob via MCP without a bot (%v)", k, seen)
		}
	}

	// Every tool works through the connection (the inner routes are an allowlist, ADR-0158).
	room := textRoom(t, o, ws.GetId(), uniq("mcp-oauth-"), false)
	mcpToolText(t, access, "send_message", map[string]any{"room": room, "text": "привет из MCP"})
	mcpToolText(t, access, "read", map[string]any{"room": room})
	mcpToolText(t, access, "find", map[string]any{"q": "OAuth", "kind": "tasks"})
	mcpToolText(t, access, "update_task", map[string]any{"task": created.Key, "priority": "high", "description": "из MCP"})
	mcpToolText(t, access, "set_task_status", map[string]any{"task": created.Key, "status": "Backlog"})
	if text = mcpToolText(t, access, "list_tasks", map[string]any{"board": "MOA", "assignee": "me"}); !strings.Contains(text, created.Key) {
		t.Fatalf("list_tasks board: %s", text)
	}

	// The MCP token is for the MCP endpoint only: REST and the app's refresh refuse it.
	mc := &client{t: t, token: access}
	if st := mc.do("GET", "/api/me", nil, nil); st != 403 || !strings.Contains(string(mc.lastBody), "MCP_TOKEN") {
		t.Fatalf("REST with the MCP token: %d %s", st, mc.lastBody)
	}
	if st := mc.do("GET", "/api/workspaces/"+ws.GetId()+"/boards", nil, nil); st != 403 {
		t.Fatalf("REST list with the MCP token: %d", st)
	}
	anon := &client{t: t}
	if !strings.HasPrefix(refresh, "mcp.") {
		t.Fatalf("MCP refresh token format: %q", refresh[:8])
	}
	if st := anon.do("POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: refresh}, nil); st < 400 {
		t.Fatalf("app refresh took the MCP refresh token: %d", st)
	}
	// Nor logs it the person out (of everything): only the MCP revocation ends an MCP session.
	if st := anon.do("POST", "/api/auth/logout", &v1.LogoutRequest{RefreshToken: refresh, AllSessions: true}, nil); st < 400 {
		t.Fatalf("logout with the MCP refresh token: %d", st)
	}
	bob.must(200, "GET", "/api/me", nil, nil)
	// And the MCP revocation without a client never touches an app session.
	if r := oaDo(t, "POST", "/api/mcp/oauth/revoke", strings.NewReader(url.Values{"token": {bob.refresh}}.Encode()), http.Header{"Content-Type": {"application/x-www-form-urlencoded"}}); r.status != 200 {
		t.Fatalf("revoke without client: %d", r.status)
	}
	bob.must(200, "GET", "/api/me", nil, nil)
	// Nor does the MCP token endpoint take the app's refresh token, or another client's.
	if st, _ := mcpTokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {bob.refresh}, "client_id": {cid}}); st != 400 {
		t.Fatalf("MCP refresh took an app refresh token: %d", st)
	}
	// The app session's token is still not an MCP token.
	if st, _, _ := mcpCall(t, bob.token, "tools/list", map[string]any{}); st != 403 {
		t.Fatalf("app session on MCP: %d", st)
	}

	// Refresh rotates; the old refresh token again is reuse: the session ends.
	st, out := mcpTokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {cid}})
	if st != 200 || out["refresh_token"] == refresh {
		t.Fatalf("refresh: %d %v", st, out)
	}
	access2 := out["access_token"].(string)
	mcpToolText(t, access2, "read", map[string]any{"task": created.Key})
	var sessions v1.ListSessionsResponse
	bob.must(200, "GET", "/api/me/sessions", nil, &sessions)
	found := false
	for _, s := range sessions.GetSessions() {
		found = found || s.GetDeviceName() == "MCP · Claude Code (test)"
	}
	if !found {
		t.Fatalf("the MCP session is not in «Сеансы»: %v", sessions.GetSessions())
	}
	_, _ = mcpTokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {cid}})
	_, _ = mcpTokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {cid}})
	if st, _, _ := mcpCall(t, access2, "tools/list", map[string]any{}); st != 401 {
		t.Fatalf("after refresh reuse: %d", st)
	}

	// A consent from another site is refused; an unknown scope goes back as invalid_scope.
	fx := mcpAuthorize(t, cid)
	h := http.Header{"Authorization": {"Bearer " + bob.token}, "Content-Type": {"application/json"}, "Cookie": {fx.cookie}, "Sec-Fetch-Site": {"cross-site"}}
	if r := oaDo(t, "POST", "/api/mcp/oauth/requests/"+fx.handle+"/bind", strings.NewReader("{}"), h); r.status != 403 {
		t.Fatalf("cross-site bind: %d %s", r.status, r.body)
	}
	_, ch := oaPKCE()
	if r := oaDo(t, "GET", "/api/mcp/oauth/authorize?"+url.Values{"response_type": {"code"}, "client_id": {cid}, "redirect_uri": {mcpTestRedirect}, "code_challenge": {ch}, "code_challenge_method": {"S256"}, "scope": {"admin"}}.Encode(), nil, nil); !strings.Contains(r.header.Get("Location"), "error=invalid_scope") {
		t.Fatalf("scope admin: %s", r.header.Get("Location"))
	}
	// https: only the exact allowed callbacks.
	for _, u := range []string{"https://claude.ai/other", "https://claude.ai:8443/api/mcp/auth_callback"} {
		b, _ := json.Marshal(map[string]any{"client_name": "x", "redirect_uris": []string{u}})
		if r := oaDo(t, "POST", "/api/mcp/oauth/register", bytes.NewReader(b), nil); r.status != 400 {
			t.Fatalf("https %q registered: %d", u, r.status)
		}
	}
	if c := mcpRegister(t, "https://claude.ai/api/mcp/auth_callback"); c == "" {
		t.Fatal("claude.ai callback refused")
	}

	// A code presented again revokes the session it made.
	f2 := mcpAuthorize(t, cid)
	code2 := codeOf(t, f2.consent(t, bob.token, f2.cookie, true, 200))
	access3, refresh3 := mcpExchange(t, f2, code2)
	if st, _ := mcpTokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {code2}, "client_id": {cid}, "redirect_uri": {mcpTestRedirect}, "code_verifier": {f2.verifier}}); st != 400 {
		t.Fatalf("code replay: %d", st)
	}
	if st, _, _ := mcpCall(t, access3, "tools/list", map[string]any{}); st != 401 {
		t.Fatalf("after code replay: %d", st)
	}
	_ = refresh3

	// A new consent of the same person for the same client replaces the earlier session.
	fa := mcpAuthorize(t, cid)
	accessA, _ := mcpExchange(t, fa, codeOf(t, fa.consent(t, bob.token, fa.cookie, true, 200)))
	fb := mcpAuthorize(t, cid)
	accessB, _ := mcpExchange(t, fb, codeOf(t, fb.consent(t, bob.token, fb.cookie, true, 200)))
	if st, _, _ := mcpCall(t, accessA, "tools/list", map[string]any{}); st != 401 {
		t.Fatalf("replaced session still works: %d", st)
	}
	if st, _, _ := mcpCall(t, accessB, "tools/list", map[string]any{}); st != 200 {
		t.Fatalf("new session: %d", st)
	}

	// Deny: access_denied back to the client; revoke ends a session.
	f3 := mcpAuthorize(t, cid)
	if redirect := f3.consent(t, bob.token, f3.cookie, false, 200); !strings.Contains(redirect, "error=access_denied") {
		t.Fatalf("deny: %s", redirect)
	}
	f4 := mcpAuthorize(t, cid)
	access4, refresh4 := mcpExchange(t, f4, codeOf(t, f4.consent(t, bob.token, f4.cookie, true, 200)))
	if r := oaDo(t, "POST", "/api/mcp/oauth/revoke", strings.NewReader(url.Values{"token": {refresh4}, "client_id": {cid}}.Encode()), http.Header{"Content-Type": {"application/x-www-form-urlencoded"}}); r.status != 200 {
		t.Fatalf("revoke: %d", r.status)
	}
	if st, _, _ := mcpCall(t, access4, "tools/list", map[string]any{}); st != 401 {
		t.Fatalf("after revoke: %d", st)
	}
	// A decided request cannot be consented again.
	f4.consent(t, bob.token, f4.cookie, true, 410)
}
