package oauthprovider

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func dbNoRows() error { return pgx.ErrNoRows }

// RegisterRoutes installs routes before the application's SPA fallback. The
// integrator must apply its standard rate limits and redact protocol query logs.
func (s *Service) RegisterRoutes(mux httpx.Router) {
	base := "/oidc/workspaces/{workspace}"
	mux.HandleFunc("GET "+base+"/.well-known/openid-configuration", s.metadata)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server/oidc/workspaces/{workspace}", s.metadata)
	mux.HandleFunc("GET "+base+"/jwks", s.jwks)
	mux.HandleFunc("GET "+base+"/authorize", s.authorize)
	mux.HandleFunc("POST "+base+"/authorize", s.authorize)
	mux.HandleFunc("POST "+base+"/token", s.token)
	mux.HandleFunc("GET "+base+"/userinfo", s.userinfo)
	mux.HandleFunc("POST "+base+"/userinfo", s.userinfo)
	mux.HandleFunc("POST "+base+"/revoke", s.revoke)
	mux.HandleFunc("OPTIONS "+base+"/{endpoint}", s.preflight)
	mux.HandleFunc("POST /api/oauth/requests/{request}/bind", s.bind)
	mux.HandleFunc("POST /api/oauth/requests/{request}/decision", s.decide)
	mux.HandleFunc("GET /api/workspaces/{workspace}/oauth/clients", s.listClients)
	mux.HandleFunc("POST /api/workspaces/{workspace}/oauth/clients", s.createClient)
	mux.HandleFunc("GET /api/workspaces/{workspace}/oauth/clients/{client}", s.getClient)
	mux.HandleFunc("PATCH /api/workspaces/{workspace}/oauth/clients/{client}", s.updateClient)
	mux.HandleFunc("DELETE /api/workspaces/{workspace}/oauth/clients/{client}", s.deleteClient)
	mux.HandleFunc("POST /api/workspaces/{workspace}/oauth/clients/{client}/rotate-secret", s.rotateSecret)
	mux.HandleFunc("GET /api/me/oauth-grants", s.listGrants)
	mux.HandleFunc("DELETE /api/me/oauth-grants/{grant}", s.deleteGrant)
}

func headers(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	headers(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, err error) {
	var e *protocolError
	var api *httpx.Error
	if errors.As(err, &api) && api.Status == http.StatusTooManyRequests {
		if api.RetryAfter > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(api.RetryAfter.Seconds()))))
		}
		e = &protocolError{code: "temporarily_unavailable", status: http.StatusTooManyRequests}
	}
	if e == nil && !errors.As(err, &e) {
		e = &protocolError{code: "server_error", status: http.StatusServiceUnavailable}
	}
	if e.code == "invalid_client" {
		w.Header().Set("WWW-Authenticate", `Basic realm="oauth"`)
	}
	if e.code == "invalid_token" {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
	}
	jsonResponse(w, e.status, map[string]string{"error": e.code})
}

func writeAPIError(w http.ResponseWriter, err error) {
	var api *httpx.Error
	if !errors.As(err, &api) {
		var e *protocolError
		if !errors.As(err, &e) {
			api = httpx.Coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
		} else {
			switch e.code {
			case "invalid_token":
				api = httpx.Unauthenticated("invalid session")
			case "access_denied":
				api = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED, "identity access denied")
			case "interaction_required":
				api = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_SSO_REQUIRED, "workspace authentication required")
			case "login_required":
				api = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_RECENT_AUTH_REQUIRED, "fresh authentication required")
			case "client_limit":
				api = httpx.Conflict("OAuth client limit reached").WithDetails("PLAN_LIMIT", 20, 20)
			case "secret_limit":
				api = httpx.Conflict("OAuth secret limit reached").WithDetails("PLAN_LIMIT", 2, 2)
			case "config_changed":
				api = httpx.Conflict("OAuth configuration changed").WithDetails("IDENTITY_CONFIG_CHANGED", 0, 0)
			default:
				if e.status == http.StatusNotFound {
					api = httpx.NotFound("OAuth object")
				} else {
					api = httpx.Validation("", "invalid OAuth request")
				}
			}
		}
	}
	protoResponse(w, api.Status, api.Proto())
}
func protoResponse(w http.ResponseWriter, status int, m proto.Message) {
	data, err := (protojson.MarshalOptions{}).Marshal(m)
	if err != nil {
		writeError(w, err)
		return
	}
	headers(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
func readProto(w http.ResponseWriter, r *http.Request, m proto.Message) error {
	if !contentType(r, "application/json") {
		return oauthError("invalid_request")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return oauthError("invalid_request")
	}
	if err = (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(b, m); err != nil {
		return oauthError("invalid_request")
	}
	return nil
}
func contentType(r *http.Request, want string) bool {
	t, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && t == want
}
func form(w http.ResponseWriter, r *http.Request) (url.Values, error) {
	if !contentType(r, "application/x-www-form-urlencoded") || r.URL.RawQuery != "" {
		return nil, oauthError("invalid_request")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		return nil, oauthError("invalid_request")
	}
	for _, values := range r.PostForm {
		if len(values) != 1 || len(values[0]) > 4096 {
			return nil, oauthError("invalid_request")
		}
	}
	return r.PostForm, nil
}
func pathWorkspace(r *http.Request) (uuid.UUID, error) {
	raw := r.PathValue("workspace")
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil || raw != id.String() {
		return uuid.Nil, oauthError("invalid_request")
	}
	return id, nil
}
func (s *Service) sameOrigin(r *http.Request) bool {
	return r.Header.Get("Origin") == s.c.PublicOrigin && r.Header.Get("Sec-Fetch-Site") != "cross-site"
}
func (s *Service) checkCORS(r *http.Request, c sqlc.OauthClient) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return nil
	}
	if c.ClientType != "public_spa" || !validOrigin(origin) || !subset([]string{origin}, c.AllowedOrigins) {
		return oauthError("invalid_request")
	}
	return nil
}
func cors(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
}

// Public documents have no client credential to bind CORS to. Permit only an
// exact origin of an active SPA in this issuer's workspace, including Vary on
// requests without Origin so a cached JWKS cannot reuse another CORS decision.
func (s *Service) publicDocumentCORS(w http.ResponseWriter, r *http.Request, ws uuid.UUID) error {
	w.Header().Add("Vary", "Origin")
	if r.Header.Get("Origin") == "" || r.Header.Get("Origin") == s.c.PublicOrigin {
		// Same-origin readers need no CORS grant. Preserve public readability
		// without reflecting an origin unless it belongs to an active SPA.
		return nil
	}
	clients, err := s.c.DB.Q.ListOAuthClients(r.Context(), ws)
	if err != nil {
		return err
	}
	for _, c := range clients {
		if c.DisabledAt == nil && s.checkCORS(r, c) == nil {
			w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
			return nil
		}
	}
	return oauthError("invalid_request")
}

func (s *Service) metadata(w http.ResponseWriter, r *http.Request) {
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err = s.c.DB.Q.GetWorkspace(r.Context(), ws); err != nil {
		writeError(w, &protocolError{code: "invalid_request", status: http.StatusNotFound})
		return
	}
	if err = s.publicDocumentCORS(w, r, ws); err != nil {
		writeError(w, err)
		return
	}
	i := s.issuer(ws)
	jsonResponse(w, http.StatusOK, map[string]any{"request_uri_parameter_supported": false, "authorization_response_iss_parameter_supported": true, "issuer": i, "authorization_endpoint": i + "/authorize", "token_endpoint": i + "/token", "userinfo_endpoint": i + "/userinfo", "revocation_endpoint": i + "/revoke", "jwks_uri": i + "/jwks", "scopes_supported": []string{"openid", "profile", "email"}, "response_types_supported": []string{"code"}, "response_modes_supported": []string{"query"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "none"}, "revocation_endpoint_auth_methods_supported": []string{"client_secret_basic", "none"}, "code_challenge_methods_supported": []string{"S256"}, "claims_supported": []string{"iss", "sub", "aud", "iat", "exp", "nonce", "auth_time", "name", "email", "email_verified"}})
}
func (s *Service) jwks(w http.ResponseWriter, r *http.Request) {
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err = s.c.DB.Q.GetWorkspace(r.Context(), ws); err != nil {
		writeError(w, &protocolError{code: "invalid_request", status: http.StatusNotFound})
		return
	}
	if err = s.publicDocumentCORS(w, r, ws); err != nil {
		writeError(w, err)
		return
	}
	k, err := s.c.SignerForWorkspace(ws)
	if err != nil || k == nil {
		writeError(w, errors.New("signer unavailable"))
		return
	}
	headers(w)
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Header().Del("Pragma")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(k.PublicJWKS())
}
func (s *Service) token(w http.ResponseWriter, r *http.Request) {
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	f, err := form(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	out, client, err := s.exchange(r.Context(), ws, r, f)
	if client != nil {
		cors(w, r)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	jsonResponse(w, http.StatusOK, out)
}
func (s *Service) preflight(w http.ResponseWriter, r *http.Request) {
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	endpoint := r.PathValue("endpoint")
	if endpoint != "token" && endpoint != "revoke" && endpoint != "userinfo" {
		writeError(w, oauthError("invalid_request"))
		return
	}
	// The actual token identifies its client at userinfo; preflight can only
	// permit an origin registered on some enabled SPA in this exact workspace.
	clients, err := s.c.DB.Q.ListOAuthClients(r.Context(), ws)
	if err != nil {
		writeError(w, err)
		return
	}
	for _, c := range clients {
		if c.DisabledAt == nil && c.ClientType == "public_spa" && r.Header.Get("Origin") != "" && s.checkCORS(r, c) == nil {
			cors(w, r)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, oauthError("invalid_request"))
}

func bearer(r *http.Request) string {
	a := r.Header.Values("Authorization")
	if len(a) != 1 || len(a[0]) < 7 || !strings.EqualFold(a[0][:7], "Bearer ") {
		return ""
	}
	return a[0][7:]
}

// apiIdentityError preserves the first-party generated error contract. External
// OIDC handlers continue to emit RFC protocol errors through writeError.
func apiIdentityError(st identitypolicy.State, d identitypolicy.Decision, err error) error {
	if err != nil && !errors.Is(err, identitypolicy.ErrDenied) && !errors.Is(err, dbNoRows()) || d.Reason == identitypolicy.StateUnavailable {
		e := httpx.Coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
		e.Err = err
		return e
	}
	if errors.Is(err, dbNoRows()) || d.Reason == identitypolicy.InvalidSession {
		return httpx.Unauthenticated("invalid session")
	}
	code := v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED
	switch d.Reason {
	case identitypolicy.SSORequired:
		code = v1.ErrorCode_ERROR_CODE_SSO_REQUIRED
	case identitypolicy.RecentAuthRequired:
		code = v1.ErrorCode_ERROR_CODE_RECENT_AUTH_REQUIRED
	case identitypolicy.DirectoryStale, identitypolicy.MembershipSuspended:
		code = v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED
	case identitypolicy.EntitlementRequired:
		return httpx.Conflict("Business or Enterprise is required").WithDetails(httpx.ReasonPlanLimit, 0, 0)
	case identitypolicy.WorkspaceSuspended, identitypolicy.BillingSuspended:
		code = v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED
	}
	if st.Principal.Authority == identitypolicy.Recovery {
		code = v1.ErrorCode_ERROR_CODE_RECOVERY_ONLY
	}
	return httpx.Coded(http.StatusForbidden, code, "identity access denied")
}
func apiSessionError(err error) error {
	if errors.Is(err, identitypolicy.ErrDenied) || errors.Is(err, dbNoRows()) {
		return httpx.Unauthenticated("invalid session")
	}
	return apiIdentityError(identitypolicy.State{}, identitypolicy.Decision{}, err)
}
