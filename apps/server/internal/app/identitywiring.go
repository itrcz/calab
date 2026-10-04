package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/directory"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitynet"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/oauthprovider"
	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sso"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// identityRegistrar records all feature routes even on legacy unconfigured deployments.
// Feature handlers retain their own operation-specific source gates; they are not ordinary
// resource read handlers (link/test/recovery bootstrap has a deliberately narrower contract).
type identityRegistrar struct {
	mux     *routeRecorder
	enabled bool
	quota   func(string, *http.Request) error
}

func (x identityRegistrar) Handle(pattern string, h http.Handler) {
	x.mux.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth.IsBotToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) {
			if pattern == "GET /oidc/workspaces/{workspace}/userinfo" || pattern == "POST /oidc/workspaces/{workspace}/userinfo" {
				x.reject(w, r, http.StatusUnauthorized, "invalid_token", auth.ErrInvalidToken)
				return
			}
			x.reject(w, r, 403, "access_denied", auth.ErrBotNotAllowed)
			return
		}
		if !x.enabled {
			// An install without identity operator configuration is a normal state, not a
			// dependency outage: first-party API routes answer 409 IDENTITY_NOT_CONFIGURED
			// (clients show «not configured»); RFC endpoints keep the protocol server_error.
			x.reject(w, r, 503, "server_error", errIdentityNotConfigured)
			return
		}
		if x.quota != nil {
			if err := x.quota(pattern, r); err != nil {
				e := httpx.AsError(err)
				code := "server_error"
				if e.Status == 429 {
					code = "temporarily_unavailable"
				}
				if e.Status == 400 {
					code = "invalid_request"
				}
				x.reject(w, r, e.Status, code, err)
				return
			}
		}
		h.ServeHTTP(w, r)
	}))
}

var errIdentityNotConfigured = httpx.Conflict("identity is not configured on this server").WithDetails(httpx.ReasonIdentityNotConfigured, 0, 0)

func (x identityRegistrar) reject(w http.ResponseWriter, r *http.Request, status int, code string, err error) {
	if strings.HasPrefix(r.URL.Path, "/oidc/") || strings.HasPrefix(r.URL.Path, "/.well-known/") {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Content-Type", "application/json")
		if status == http.StatusUnauthorized && code == "invalid_token" {
			w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		}
		if retry := httpx.AsError(err).RetryAfter; retry > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retry.Seconds()))))
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
		return
	}
	if httpx.AsError(err).Status >= 500 {
		e := httpx.Coded(503, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
		e.Err = err
		err = e
	}
	httpx.WriteError(w, r, err)
}
func (x identityRegistrar) HandleFunc(pattern string, h func(http.ResponseWriter, *http.Request)) {
	x.Handle(pattern, http.HandlerFunc(h))
}

func workspaceCookie(ws uuid.UUID) string { return "__Host-calab-workspace-session-" + ws.String() }
func clearWorkspaceCookie(w http.ResponseWriter, ws uuid.UUID) {
	http.SetCookie(w, &http.Cookie{Name: workspaceCookie(ws), Path: "/", MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}
func identityTokens(w http.ResponseWriter, r *http.Request, t *v1.AuthTokens) {
	if t != nil && auth.IsWeb(r) {
		ws := t.GetAuthority().GetWorkspaceId()
		name := "__Host-calab-recovery-session-" + ws
		if t.GetAuthority().GetKind() == v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_WORKSPACE_SSO {
			name = workspaceCookie(uuid.MustParse(ws))
		}
		exp := t.GetRefreshExpiresAt().AsTime()
		http.SetCookie(w, &http.Cookie{Name: name, Value: t.RefreshToken, Path: "/", Expires: exp, MaxAge: int(time.Until(exp).Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
		if t.GetAuthority().GetKind() == v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_WORKSPACE_SSO {
			id := uuid.MustParse(ws)
			http.SetCookie(w, &http.Cookie{Name: workspaceRefreshCookie(id), Value: t.RefreshToken, Path: workspaceRefreshPath(id), Expires: exp, MaxAge: int(time.Until(exp).Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
		}
		t.RefreshToken = ""
	}
}

func wireIdentity(d Deps, mux *routeRecorder, a *auth.Service) (*sso.Service, *directory.Service, *oauthprovider.Service) {
	settings, err := d.Config.IdentitySettings()
	if err != nil {
		panic(err)
	}
	enabled := settings != nil
	registrar := identityRegistrar{mux: mux, enabled: enabled}
	var rp *sso.Service
	var ds *directory.Service
	var op *oauthprovider.Service
	if enabled {
		// Validate every operator endpoint against the transport's complete policy
		// at startup. The trusted Go test override does not weaken env validation.
		if len(settings.Endpoints) > 0 {
			endpoints := make([]identitynet.Endpoint, 0, len(settings.Endpoints))
			for raw, ep := range settings.Endpoints {
				endpoints = append(endpoints, identitynet.Endpoint{URL: raw, ApprovedCIDRs: ep.ApprovedCIDRs, PrivateCIDRs: ep.PrivateCIDRs, RootCAs: ep.RootCAs})
			}
			transport, err := identitynet.NewTransport(identitynet.Config{Endpoints: endpoints})
			if err != nil {
				panic("invalid identity operator endpoint policy")
			}
			transport.CloseIdleConnections()
		}
		policy := d.IdentityEndpointPolicy
		if policy == nil {
			policy = func(ws uuid.UUID, raw string) (identitynet.Endpoint, error) {
				// An override bound to other workspaces does not apply: the URL is public-only.
				if ep, ok := settings.EndpointFor(ws, raw); ok {
					return identitynet.Endpoint{URL: raw, ApprovedCIDRs: ep.ApprovedCIDRs, PrivateCIDRs: ep.PrivateCIDRs, RootCAs: ep.RootCAs}, nil
				}
				return identitynet.Endpoint{URL: raw}, nil // public endpoints still undergo DNS/dial/TLS validation
			}
		}
		rp = &sso.Service{DB: d.DB, Keys: settings.Encryption, Protocol: &sso.OIDC{Policy: policy, Origin: settings.Origin}, Edition: d.Config.IdentityEntitlements(), Sessions: a}
		hosts := map[string]directory.HostPolicy{}
		cas := map[string]string{}
		for host, policy := range settings.DirectoryHosts {
			hosts[host] = directory.HostPolicy{Networks: policy.Networks, Workspaces: policy.Workspaces}
			cas[host] = policy.CAPEM
		}
		scanner := d.IdentityDirectoryScanner
		if scanner == nil {
			scanner = &directory.LDAP{Hosts: hosts}
		}
		ds = &directory.Service{Identity: rp, LDAP: scanner, OperatorCAs: cas, OnError: func(error) { slog.Warn("identity directory dependency unavailable") }}
		// Immutable signer snapshots are cached by exact workspace issuer, bounded by the
		// durable workspace lifecycle rather than request-supplied issuer claims.
		var mu sync.Mutex
		signers := map[uuid.UUID]*signing.Keyring{}
		signer := func(ws uuid.UUID) (*signing.Keyring, error) {
			mu.Lock()
			defer mu.Unlock()
			if ring := signers[ws]; ring != nil {
				return ring, nil
			}
			ring, err := signing.New(signing.Config{Issuer: settings.Origin + "/oidc/workspaces/" + ws.String(), ActiveKID: settings.SigningActiveKID, Keys: settings.SigningKeys})
			if err != nil {
				return nil, err
			}
			if len(signers) >= 1000 {
				clear(signers)
			}
			signers[ws] = ring
			return ring, nil
		}
		op, err = oauthprovider.New(oauthprovider.Config{DB: d.DB, PublicOrigin: settings.Origin, Entitlements: d.Config.IdentityEntitlements(), SignerForWorkspace: signer, ResolveSession: providerSessionResolver(a), Quota: providerClientQuota(d)})
		if err != nil {
			panic(err)
		}
	}
	h := &sso.HTTP{Service: rp, Deps: sso.HTTPDeps{
		Principal: func(r *http.Request, optional bool) (identitypolicy.Principal, error) {
			if optional && !auth.HasBearer(r) {
				return identitypolicy.Principal{}, nil
			}
			id, err := a.Authenticate(r)
			if err != nil {
				return identitypolicy.Principal{}, err
			}
			return a.ResolvePrincipal(r.Context(), id)
		}, RateLimit: func(ctx context.Context, key string, limit int) (time.Duration, error) {
			_, retry, err := redisx.NewRateLimiter(d.Redis, "rl:identity:", limit, float64(limit)).Allow(ctx, key)
			return retry, err
		}, TrustedIP: func(r *http.Request) string { return httpx.ClientIP(r.Context()) },
		WriteResult: func(w http.ResponseWriter, r *http.Request, result sso.Result) {
			identityTokens(w, r, result.Tokens)
			httpx.Write(w, 200, &v1.SSOCompleteResponse{Tokens: result.Tokens, Assurance: result.Assurance, Tested: result.Tested})
		},
		WriteError: func(w http.ResponseWriter, r *http.Request, err error) {
			var denied *sso.AccessError
			if errors.As(err, &denied) {
				p := identitypolicy.Principal{}
				if auth.HasBearer(r) {
					if id, e := a.Authenticate(r); e == nil {
						p = id.Principal
					}
				}
				httpx.WriteError(w, r, auth.IdentityError(p, denied.Decision, nil))
				return
			}
			switch {
			case errors.Is(err, sso.ErrChanged):
				err = httpx.Coded(409, v1.ErrorCode_ERROR_CODE_IDENTITY_CONFIG_CHANGED, "identity configuration changed")
			case errors.Is(err, sso.ErrNotLinked):
				err = httpx.Coded(409, v1.ErrorCode_ERROR_CODE_IDENTITY_NOT_LINKED, "identity not linked")
			case errors.Is(err, sso.ErrInvalid):
				err = httpx.BadRequest("invalid identity request")
			case errors.Is(err, sso.ErrDenied), errors.Is(err, sso.ErrInvalidProof), errors.Is(err, identitypolicy.ErrDenied):
				err = httpx.Forbidden("identity access denied")
			case errors.Is(err, directory.ErrDirectory), errors.Is(err, identitynet.ErrNetwork):
				err = httpx.Unavailable(nil)
			default:
				var api *httpx.Error
				if !errors.As(err, &api) {
					err = httpx.Coded(503, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
				}
			}
			if httpx.AsError(err).Status >= 500 {
				e := httpx.Coded(503, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
				e.Err = err
				err = e
			}
			httpx.WriteError(w, r, err)
		},
	}}
	h.Routes(registrar)
	(&directory.HTTP{Service: ds, Gate: h}).Routes(registrar)
	// RegisterRoutes itself only binds method handlers; nil service never executes behind
	// the explicitly disabled registrar, retaining complete route census on old installs.
	op.RegisterRoutes(identityRegistrar{mux: mux, enabled: enabled, quota: providerQuotas(d, a)})
	// Independent local password proof remains available on operator-off installs.
	// This does not enable SSO/provider routes or accept absent/native null origins.
	reauthOrigins := map[string]bool{}
	for _, origin := range d.Config.AllowedOrigins() {
		reauthOrigins[origin] = true
	}
	if settings != nil {
		reauthOrigins[settings.Origin] = true
	}
	(identityRegistrar{mux: mux, enabled: true}).Handle("POST /api/auth/local/reauth", httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		if origin := r.Header.Get("Origin"); origin == "" || !reauthOrigins[origin] {
			return httpx.Forbidden("cross-origin request rejected")
		}
		id, err := a.Authenticate(r)
		if err != nil {
			return err
		}
		if err := redisx.NewRateLimiter(d.Redis, "rl:identity:reauth:", 10, 10).Take(r.Context(), id.UserID.String()); err != nil {
			return err
		}
		var req v1.LocalReauthRequest
		if err := httpx.Decode(w, r, &req); err != nil {
			return err
		}
		at, err := a.LocalReauthenticate(r.Context(), id, req.CurrentPassword)
		if err != nil {
			return err
		}
		httpx.Write(w, 200, &v1.LocalReauthResponse{AuthenticatedAt: timestamppb.New(at), ValidUntil: timestamppb.New(at.Add(identitypolicy.ManagementMaxAge))})
		return nil
	}))
	origin := ""
	if settings != nil {
		origin = settings.Origin
	}
	scopedSessionRoutes(registrar, a, origin)
	return rp, ds, op
}

func workspaceRefreshCookie(ws uuid.UUID) string {
	return "__Secure-calab-workspace-refresh-" + ws.String()
}
func workspaceRefreshPath(ws uuid.UUID) string { return "/api/auth/sso/workspaces/" + ws.String() }
func scopedSessionRoutes(mux identityRegistrar, a *auth.Service, origin string) {
	mux.Handle("POST /api/auth/sso/workspaces/{id}/refresh", httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		ws, err := httpx.PathUUID(r, "id", "workspace")
		if err != nil {
			return err
		}
		var req v1.RefreshRequest
		if err := httpx.Decode(w, r, &req); err != nil {
			return err
		}
		cookieMode := req.RefreshToken == ""
		if cookieMode {
			if r.Header.Get("Origin") != origin {
				return httpx.Forbidden("cross-origin request rejected")
			}
			cookie, err := r.Cookie(workspaceRefreshCookie(ws))
			if err != nil {
				return httpx.Unauthenticated("missing workspace session")
			}
			req.RefreshToken = cookie.Value
		}
		result, err := a.RefreshWorkspace(r.Context(), ws, &req, auth.Client{IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent()})
		if err != nil {
			if cookieMode && (errors.Is(err, auth.ErrInvalidToken) || errors.Is(err, auth.ErrSessionRevoked)) {
				clearWorkspaceCookie(w, ws)
				http.SetCookie(w, &http.Cookie{Name: workspaceRefreshCookie(ws), Path: workspaceRefreshPath(ws), MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
			}
			return err
		}
		if cookieMode {
			r.Header.Set("X-Client", "web")
		}
		identityTokens(w, r, result.Tokens)
		httpx.Write(w, 200, result)
		return nil
	}))
	mux.Handle("POST /api/auth/sso/workspaces/{id}/logout", httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		ws, err := httpx.PathUUID(r, "id", "workspace")
		if err != nil {
			return err
		}
		var req v1.LogoutRequest
		if err := httpx.Decode(w, r, &req); err != nil {
			return err
		}
		if req.AllSessions {
			return httpx.Forbidden("workspace logout affects one session")
		}
		var p identitypolicy.Principal
		if auth.HasBearer(r) {
			id, err := a.Authenticate(r)
			if err != nil {
				return err
			}
			p, err = a.ResolvePrincipal(r.Context(), id)
			if err != nil {
				return err
			}
		} else {
			if req.RefreshToken == "" {
				if r.Header.Get("Origin") != origin {
					return httpx.Forbidden("cross-origin request rejected")
				}
				cookie, err := r.Cookie(workspaceRefreshCookie(ws))
				if err != nil {
					return httpx.Unauthenticated("missing workspace session")
				}
				req.RefreshToken = cookie.Value
			}
			p, err = a.PrincipalFromRefresh(r.Context(), req.RefreshToken)
			if err != nil {
				return httpx.Unauthenticated("invalid workspace session")
			}
		}
		if p.Authority != identitypolicy.WorkspaceSSO || p.WorkspaceID != ws {
			return httpx.Coded(403, v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED, "workspace session scope denied")
		}
		if err := a.LogoutWorkspace(r.Context(), auth.Identity{UserID: p.UserID, SessionID: p.SessionID, Principal: p}, ws); err != nil {
			return err
		}
		clearWorkspaceCookie(w, ws)
		http.SetCookie(w, &http.Cookie{Name: workspaceRefreshCookie(ws), Path: workspaceRefreshPath(ws), MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
		httpx.NoContent(w)
		return nil
	}))
}

func providerSessionResolver(a *auth.Service) oauthprovider.SessionResolver {
	return func(ctx context.Context, r *http.Request) (identitypolicy.Principal, error) {
		var bearer identitypolicy.Principal
		if auth.HasBearer(r) {
			id, err := a.Authenticate(r)
			if err != nil {
				return bearer, err
			}
			bearer, err = a.ResolvePrincipal(ctx, id)
			if err != nil {
				return identitypolicy.Principal{}, err
			}
		}
		authorize := (r.Method == http.MethodGet || r.Method == http.MethodPost) && strings.HasSuffix(r.URL.Path, "/authorize")
		if !authorize {
			if bearer.SessionID == uuid.Nil {
				return bearer, auth.ErrInvalidToken
			}
			return bearer, nil
		}
		ws, err := uuid.Parse(r.PathValue("workspace"))
		if err != nil {
			return identitypolicy.Principal{}, auth.ErrInvalidToken
		}
		var browser identitypolicy.Principal
		for _, name := range []string{workspaceCookie(ws), auth.LocalBrowserCookie} {
			cookie, err := r.Cookie(name)
			if err != nil {
				continue
			}
			p, err := a.PrincipalFromRefresh(ctx, cookie.Value)
			if err != nil {
				return identitypolicy.Principal{}, auth.ErrInvalidToken
			}
			validLocal := p.Authority == identitypolicy.LocalAccount && name == auth.LocalBrowserCookie
			validWorkspace := p.Authority == identitypolicy.WorkspaceSSO && p.WorkspaceID == ws && name == workspaceCookie(ws)
			if !validLocal && !validWorkspace {
				return identitypolicy.Principal{}, auth.ErrInvalidToken
			}
			if browser.UserID != uuid.Nil && browser.UserID != p.UserID || bearer.UserID != uuid.Nil && bearer.UserID != p.UserID {
				return identitypolicy.Principal{}, auth.ErrInvalidToken
			}
			if browser.SessionID == uuid.Nil {
				browser = p
			}
		}
		if bearer.SessionID != uuid.Nil {
			return bearer, nil
		}
		prompt := r.URL.Query().Get("prompt")
		if r.Method == http.MethodPost {
			// The provider validates the bounded, single-valued body before
			// calling this resolver. Never parse or merge query/body here.
			prompt = r.PostForm.Get("prompt")
		}
		if prompt != "none" || browser.SessionID == uuid.Nil {
			return identitypolicy.Principal{}, auth.ErrInvalidToken
		}
		return browser, nil
	}
}
