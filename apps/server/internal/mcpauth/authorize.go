package mcpauth

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// The browser that started an authorization request keeps a binding to it: one cookie holding
// the newest bindingMax entries "<request key>:<browser token>" (the pattern of the OAuth
// provider, ADR-0054: one cookie, so an authorize loop cannot fill the jar and evict the session
// cookies). The consent routes refuse a request whose binding this browser does not hold.
const (
	bindingCookie = "__Host-calab_mcp"
	bindingMax    = 4
)

var (
	challengeShape = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
	handleShape    = regexp.MustCompile(`^calab_mr_[A-Za-z0-9_-]{43}$`)
)

type binding struct{ key, browser string }

func requestKey(handle string) string { return base64.RawURLEncoding.EncodeToString(hash(handle)[:12]) }

func bindings(r *http.Request) []binding {
	c, err := r.Cookie(bindingCookie)
	if err != nil {
		return nil
	}
	var out []binding
	for _, e := range strings.Split(c.Value, ".") {
		k, b, ok := strings.Cut(e, ":")
		if !ok || len(k) != 16 || !strings.HasPrefix(b, "calab_mb_") || len(b) != len("calab_mb_")+43 || len(out) == bindingMax {
			continue
		}
		out = append(out, binding{k, b})
	}
	return out
}

func setBindings(w http.ResponseWriter, bs []binding) {
	if len(bs) == 0 {
		http.SetCookie(w, &http.Cookie{Name: bindingCookie, Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
		return
	}
	parts := make([]string, len(bs))
	for i, b := range bs {
		parts[i] = b.key + ":" + b.browser
	}
	http.SetCookie(w, &http.Cookie{Name: bindingCookie, Value: strings.Join(parts, "."), Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(requestTTL / time.Second)})
}

// browserOf is the browser token this browser holds for handle ("" = none).
func browserOf(r *http.Request, handle string) string {
	k := requestKey(handle)
	for _, b := range bindings(r) {
		if b.key == k {
			return b.browser
		}
	}
	return ""
}

// redirectWith builds the client's redirect with the answer (RFC 6749 §4.1.2, RFC 9207 iss).
func redirectWith(raw, state, issuer string, params map[string]string) string {
	u, _ := url.Parse(raw)
	q := u.Query()
	for k, v := range params {
		q.Set(k, v)
	}
	if state != "" {
		q.Set("state", state)
	}
	q.Set("iss", issuer)
	u.RawQuery = q.Encode()
	return u.String()
}

// badRequest is an authorize error that cannot go back to the client (unknown client, redirect
// URI not registered): shown in the browser, never redirected (RFC 6749 §4.1.2.1).
func badRequest(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = w.Write([]byte("Calab: the MCP client's authorization request is invalid: " + msg + "\n"))
}

// authorize starts a consent: validates the request, stores it, binds this browser and sends it
// to the web app's consent page.
func (s *Service) authorize(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if limited(w, r, s.c.AuthorizeLimit) {
		return
	}
	f := r.URL.Query()
	c, err := s.c.DB.Q.GetMCPClient(ctx, f.Get("client_id"))
	if err != nil {
		if db.IsNotFound(err) {
			badRequest(w, "unknown client_id (register the client again)")
			return
		}
		badRequest(w, "try again")
		return
	}
	redirect := f.Get("redirect_uri")
	if redirect == "" && len(c.RedirectUris) == 1 {
		redirect = c.RedirectUris[0]
	}
	if !redirectMatches(c.RedirectUris, redirect) {
		badRequest(w, "redirect_uri is not registered for this client")
		return
	}
	issuer, state := s.origin(r), f.Get("state")
	fail := func(code, desc string) {
		// The redirect URI is one the client registered (redirectMatches above): loopback or an
		// exact allowed https callback, never a value taken from the request alone.
		http.Redirect(w, r, redirectWith(redirect, state, issuer, map[string]string{"error": code, "error_description": desc}), http.StatusFound) //nolint:gosec // G710: see above
	}
	switch {
	case f.Get("response_type") != "code":
		fail("unsupported_response_type", "only response_type=code")
		return
	case f.Get("code_challenge_method") != "S256" || !challengeShape.MatchString(f.Get("code_challenge")):
		fail("invalid_request", "PKCE with code_challenge_method=S256 is required")
		return
	case len(state) > 1000:
		fail("invalid_request", "state is too long")
		return
	}
	if res := f.Get("resource"); res != "" && strings.TrimSuffix(res, "/") != s.resource(r) {
		fail("invalid_target", "resource must be "+s.resource(r))
		return
	}
	for _, sc := range strings.Fields(f.Get("scope")) {
		if sc != auth.ScopeMCP && sc != "offline_access" {
			fail("invalid_scope", "the only scope is "+auth.ScopeMCP)
			return
		}
	}
	ip := httpx.ClientIP(ctx)
	if n, err := s.c.DB.Q.CountMCPRequestsFromIP(ctx, clip(ip, 64)); err != nil || n >= pendingPerIP {
		fail("temporarily_unavailable", "too many pending requests from this address")
		return
	}
	if err := db.GuardExec(ctx, s.c.DB, func(q *sqlc.Queries) error { return q.DeleteExpiredMCPRequests(ctx) }); err != nil {
		slog.WarnContext(ctx, "mcp oauth: request cleanup failed", "err", err)
	}
	handle, browser := opaque("calab_mr_", 32), opaque("calab_mb_", 32)
	if _, err := db.GuardValue(ctx, s.c.DB, func(q *sqlc.Queries) (sqlc.McpOauthRequest, error) {
		return q.CreateMCPRequest(ctx, sqlc.CreateMCPRequestParams{
			HandleHash: hash(handle), BrowserHash: hash(browser), ClientID: c.ID, RedirectUri: redirect,
			// The resource is always this endpoint of this origin: the token exchange checks it is the
			// same (a code issued at one app origin is not exchanged at another).
			CodeChallenge: f.Get("code_challenge"), State: state, Resource: s.resource(r), CreatedIp: clip(ip, 64),
			ExpiresAt: s.now().Add(requestTTL),
		})
	}); err != nil {
		slog.ErrorContext(ctx, "mcp oauth: authorize", "err", err)
		fail("server_error", "try again")
		return
	}
	bs := append([]binding{{requestKey(handle), browser}}, bindings(r)...)
	if len(bs) > bindingMax {
		var evicted [][]byte
		for _, b := range bs[bindingMax:] {
			evicted = append(evicted, hash(b.browser))
		}
		bs = bs[:bindingMax]
		if err := db.GuardExec(ctx, s.c.DB, func(q *sqlc.Queries) error { return q.DeleteMCPRequestsByHashes(ctx, evicted) }); err != nil {
			slog.WarnContext(ctx, "mcp oauth: evicted requests", "err", err)
		}
	}
	setBindings(w, bs)
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, issuer+ConnectPath+"#"+handle, http.StatusFound)
}

// consentError is a refusal of the consent routes, as the page reads it (ApiError shape).
var (
	errExpired      = httpx.Coded(http.StatusGone, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "the request expired or was already answered; start the connection in the MCP client again").WithDetails("MCP_REQUEST_EXPIRED", 0, 0)
	errOtherBrowser = httpx.Forbidden("open the link in the browser that the MCP client opened").WithDetails("MCP_OTHER_BROWSER", 0, 0)
	errLocalOnly    = httpx.Forbidden("sign in with your Calab password to connect an MCP client").WithDetails("MCP_LOCAL_ONLY", 0, 0)
	errCrossOrigin  = httpx.Forbidden("the consent is answered from the Calab app only")
)

// sameOrigin: the consent routes are called by the app's own page — a cross-site request (or one
// from an origin that is not the app's) is refused, as the OAuth provider does (ADR-0102 §3).
func (s *Service) sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	o := r.Header.Get("Origin")
	return o == "" || slices.Contains(s.c.Origins, o)
}

// person authenticates the consent page's session: a person's app session with local authority
// (never a bot, a bot on behalf, an MCP session, a workspace SSO or recovery session).
func (s *Service) person(r *http.Request) (auth.Identity, error) {
	if !s.sameOrigin(r) {
		return auth.Identity{}, errCrossOrigin
	}
	id, err := s.c.Auth.Authenticate(r)
	if err != nil {
		return auth.Identity{}, err
	}
	if id.Machine() || id.MCP || id.Principal.Authority != identitypolicy.LocalAccount {
		return auth.Identity{}, errLocalOnly
	}
	if err := s.c.Auth.CheckGlobal(r.Context(), id, identitypolicy.GlobalWrite); err != nil {
		return auth.Identity{}, err
	}
	return id, nil
}

// pending locks the request of the path's handle for this browser: live, undecided, bound to it.
func (s *Service) pending(r *http.Request, q *sqlc.Queries) (sqlc.McpOauthRequest, string, error) {
	handle := r.PathValue("request")
	if !handleShape.MatchString(handle) {
		return sqlc.McpOauthRequest{}, "", errExpired
	}
	req, err := q.GetMCPRequestForUpdate(r.Context(), hash(handle))
	if db.IsNotFound(err) {
		return req, "", errExpired
	}
	if err != nil {
		return req, "", err
	}
	if req.DecidedAt != nil || !s.now().Before(req.ExpiresAt) {
		return req, "", errExpired
	}
	b := browserOf(r, handle)
	if b == "" || subtle.ConstantTimeCompare(hash(b), req.BrowserHash) != 1 {
		return req, "", errOtherBrowser
	}
	return req, handle, nil
}

// consentSnapshot is what the consent page shows.
type consentSnapshot struct {
	ClientName  string    `json:"clientName"`
	RedirectURI string    `json:"redirectUri"`
	Loopback    bool      `json:"loopback"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
	CsrfToken   string    `json:"csrfToken"`
}

// bind attaches the request to the signed-in person and returns what the page shows.
func (s *Service) bind(w http.ResponseWriter, r *http.Request) {
	id, err := s.person(r)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	ctx := r.Context()
	var out consentSnapshot
	err = s.c.DB.Tx(ctx, func(q *sqlc.Queries) error {
		req, _, err := s.pending(r, q)
		if err != nil {
			return err
		}
		c, err := q.GetMCPClient(ctx, req.ClientID)
		if db.IsNotFound(err) {
			return errExpired
		}
		if err != nil {
			return err
		}
		u, err := q.GetUser(ctx, id.UserID)
		if db.IsNotFound(err) {
			return errExpired
		}
		if err != nil {
			return err
		}
		csrf := opaque("calab_mx_", 32)
		uid, sid := id.UserID, id.SessionID
		if err := q.BindMCPRequest(ctx, sqlc.BindMCPRequestParams{ID: req.ID, UserID: &uid, BoundSession: &sid, CsrfHash: hash(csrf)}); err != nil {
			return err
		}
		loop, _ := s.redirectKind(req.RedirectUri)
		email := ""
		if u.Email != nil {
			email = *u.Email
		}
		out = consentSnapshot{ClientName: c.Name, RedirectURI: req.RedirectUri, Loopback: loop, DisplayName: u.DisplayName, Email: email, CreatedAt: req.CreatedAt, ExpiresAt: req.ExpiresAt, CsrfToken: csrf}
		return nil
	})
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// decide answers the request: allow issues a one-time code, deny sends access_denied; either way
// the page navigates to the returned address.
func (s *Service) decide(w http.ResponseWriter, r *http.Request) {
	id, err := s.person(r)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	var in struct {
		CsrfToken string `json:"csrfToken"`
		Allow     bool   `json:"allow"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("invalid JSON"))
		return
	}
	ctx := r.Context()
	var redirect, handle string
	err = s.c.DB.Tx(ctx, func(q *sqlc.Queries) error {
		req, h, err := s.pending(r, q)
		if err != nil {
			return err
		}
		handle = h
		if req.BoundSession == nil || *req.BoundSession != id.SessionID || req.UserID == nil || *req.UserID != id.UserID ||
			req.CsrfHash == nil || subtle.ConstantTimeCompare(hash(in.CsrfToken), req.CsrfHash) != 1 {
			return errExpired
		}
		issuer := s.origin(r)
		if !in.Allow {
			if err := q.DecideMCPRequest(ctx, sqlc.DecideMCPRequestParams{ID: req.ID}); err != nil {
				return err
			}
			redirect = redirectWith(req.RedirectUri, req.State, issuer, map[string]string{"error": "access_denied", "error_description": "the person declined"})
			return nil
		}
		code := opaque("calab_mo_", 32)
		exp := s.now().Add(codeTTL)
		if err := q.DecideMCPRequest(ctx, sqlc.DecideMCPRequestParams{ID: req.ID, CodeHash: hash(code), CodeExpiresAt: &exp}); err != nil {
			return err
		}
		redirect = redirectWith(req.RedirectUri, req.State, issuer, map[string]string{"code": code})
		return nil
	})
	if err != nil {
		var he *httpx.Error
		if !errors.As(err, &he) {
			slog.ErrorContext(ctx, "mcp oauth: decision", "err", err)
		}
		httpx.WriteError(w, r, err)
		return
	}
	k := requestKey(handle)
	var kept []binding
	for _, b := range bindings(r) {
		if b.key != k {
			kept = append(kept, b)
		}
	}
	setBindings(w, kept)
	writeJSON(w, http.StatusOK, map[string]string{"redirectUrl": redirect})
}
