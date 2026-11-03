// Package mcpauth is the OAuth 2.1 authorization server of the MCP endpoint (ADR-0158): a person
// connects an MCP client (Claude Code, Codex, Cursor, claude.ai…) to Calab without a bot.
//
// It follows the MCP authorization spec (2025-06-18): protected resource metadata (RFC 9728) and
// authorization server metadata (RFC 8414), dynamic client registration (RFC 7591, public clients
// only), Authorization Code with PKCE S256 and the resource indicator (RFC 8707), refresh token
// rotation and revocation (RFC 7009). The consent is a page of the web app (/mcp/connect) signed in
// as the person; the request is bound to the browser that started it (the __Host-calab_mcp cookie),
// so a consent link sent to someone else opens nothing.
//
// The grant is a session of the person (auth.MCPSessionTokens): its tokens carry scp=mcp, and
// auth.Require admits them only on the MCP endpoint and in its tools' in-process calls.
package mcpauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

const (
	// requestTTL: how long a consent page may stay open.
	requestTTL = 10 * time.Minute
	// codeTTL: an authorization code is exchanged at once by the client.
	codeTTL = 60 * time.Second
	// pendingPerIP caps live, undecided authorization requests from one IP.
	pendingPerIP = 100
	// maxRedirects per client (RFC 7591 redirect_uris).
	maxRedirects = 10
)

// Config wires the service.
type Config struct {
	DB   *db.DB
	Auth *auth.Service
	// Origins are the web app's origins (config.AllowedOrigins: PUBLIC_APP_URL first). The issuer
	// and the resource are the origin the request came to, the first one otherwise.
	Origins []string
	// RedirectURIs are the exact https redirect URIs a client may register besides loopback
	// (MCP_OAUTH_REDIRECT_URIS: the callbacks of the claude.ai / claude.com web connectors).
	RedirectURIs []string
	// Per-IP limits (an IPv6 address counts by its /64); nil = none.
	RegisterLimit, AuthorizeLimit, TokenLimit *redisx.RateLimiter
	// Now is the clock (tests); nil = time.Now.
	Now func() time.Time
}

// Service serves the MCP OAuth routes.
type Service struct{ c Config }

// New returns the service.
func New(c Config) *Service {
	if c.Now == nil {
		c.Now = time.Now
	}
	return &Service{c: c}
}

// Paths of the published endpoints.
const (
	resourceMetadataPath = "/.well-known/oauth-protected-resource"
	serverMetadataPath   = "/.well-known/oauth-authorization-server"
	base                 = "/api/mcp/oauth"
	// ConnectPath is the web app's consent page: /mcp/connect#<request handle>.
	ConnectPath = "/mcp/connect"
)

// Routes registers the endpoints. All are public: the consent routes authenticate the person's
// session themselves (auth.Authenticate: people only, never a bot or an MCP token).
func (s *Service) Routes(mux httpx.Router) {
	mux.HandleFunc("GET "+resourceMetadataPath, s.resourceMetadata)
	mux.HandleFunc("GET "+resourceMetadataPath+auth.MCPPath, s.resourceMetadata)
	mux.HandleFunc("GET "+serverMetadataPath, s.serverMetadata)
	mux.HandleFunc("OPTIONS "+resourceMetadataPath, preflight)
	mux.HandleFunc("OPTIONS "+resourceMetadataPath+auth.MCPPath, preflight)
	mux.HandleFunc("OPTIONS "+serverMetadataPath, preflight)
	mux.HandleFunc("POST "+base+"/register", s.register)
	mux.HandleFunc("OPTIONS "+base+"/register", preflight)
	mux.HandleFunc("GET "+base+"/authorize", s.authorize)
	mux.HandleFunc("POST "+base+"/token", s.token)
	mux.HandleFunc("OPTIONS "+base+"/token", preflight)
	mux.HandleFunc("POST "+base+"/revoke", s.revoke)
	mux.HandleFunc("OPTIONS "+base+"/revoke", preflight)
	mux.HandleFunc("POST "+base+"/requests/{request}/bind", s.bind)
	mux.HandleFunc("POST "+base+"/requests/{request}/decision", s.decide)
}

// origin is the app origin this request came to (its Host among Origins), else the first one.
func (s *Service) origin(r *http.Request) string {
	for _, o := range s.c.Origins {
		if u, err := url.Parse(o); err == nil && strings.EqualFold(u.Host, r.Host) {
			return o
		}
	}
	if len(s.c.Origins) > 0 {
		return s.c.Origins[0]
	}
	return ""
}

func (s *Service) resource(r *http.Request) string { return s.origin(r) + auth.MCPPath }

// ResourceMetadataURL is what a 401 of the MCP endpoint points to (WWW-Authenticate).
func (s *Service) ResourceMetadataURL(r *http.Request) string {
	return s.origin(r) + resourceMetadataPath + auth.MCPPath
}

func (s *Service) resourceMetadata(w http.ResponseWriter, r *http.Request) {
	cors(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 s.resource(r),
		"authorization_servers":    []string{s.origin(r)},
		"scopes_supported":         []string{auth.ScopeMCP},
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Calab",
	})
}

func (s *Service) serverMetadata(w http.ResponseWriter, r *http.Request) {
	cors(w)
	o := s.origin(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         o,
		"authorization_endpoint":                         o + base + "/authorize",
		"token_endpoint":                                 o + base + "/token",
		"registration_endpoint":                          o + base + "/register",
		"revocation_endpoint":                            o + base + "/revoke",
		"response_types_supported":                       []string{"code"},
		"response_modes_supported":                       []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"revocation_endpoint_auth_methods_supported":     []string{"none"},
		"scopes_supported":                               []string{auth.ScopeMCP},
		"authorization_response_iss_parameter_supported": true,
	})
}

// Challenge wraps the MCP endpoint: a 401 tells the client where to start OAuth (RFC 9728 §5.1).
func (s *Service) Challenge(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&challengeWriter{ResponseWriter: w, header: `Bearer resource_metadata="` + s.ResourceMetadataURL(r) + `", scope="` + auth.ScopeMCP + `"`}, r)
	})
}

type challengeWriter struct {
	http.ResponseWriter
	header string
	wrote  bool
}

func (c *challengeWriter) WriteHeader(code int) {
	if !c.wrote && code == http.StatusUnauthorized {
		c.Header().Set("WWW-Authenticate", c.header)
	}
	c.wrote = true
	c.ResponseWriter.WriteHeader(code)
}

func (c *challengeWriter) Write(b []byte) (int, error) {
	c.wrote = true
	return c.ResponseWriter.Write(b)
}

func (c *challengeWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

// cors: the metadata, registration, token and revocation endpoints carry no ambient credential
// (no cookie is read), so browser-based MCP clients may call them from any origin.
func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	cors(w)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// oauthError is an RFC 6749 §5.2 error answer.
func oauthError(w http.ResponseWriter, status int, code, desc string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

func hash(v string) []byte {
	h := sha256.Sum256([]byte(v))
	return h[:]
}

// opaque returns prefix + n random bytes in base64url.
func opaque(prefix string, n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

// ipKey is the rate-limit key of a client address: an IPv6 address by its /64 (one host usually
// owns the whole prefix), IPv4 as is.
func ipKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	if a.Is4() || a.Is4In6() {
		return a.Unmap().String()
	}
	p, _ := a.Prefix(64)
	return p.String()
}

// limited takes a token of l for the request's address; false = answered 429.
func limited(w http.ResponseWriter, r *http.Request, l *redisx.RateLimiter) bool {
	if l == nil {
		return false
	}
	ok, wait, err := l.Allow(r.Context(), ipKey(httpx.ClientIP(r.Context())))
	if err != nil {
		oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "try again")
		return true
	}
	if !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait/time.Second)+1))
		oauthError(w, http.StatusTooManyRequests, "temporarily_unavailable", "too many requests from this address")
		return true
	}
	return false
}

// displayName cleans a client's self-declared name for the consent page and «Сеансы»: no control,
// format (bidi overrides, zero-width) or line-breaking characters; runs of spaces collapse.
func displayName(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			space = b.Len() > 0
			continue
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r), unicode.Is(unicode.Co, r), r == utf8.RuneError:
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return clip(b.String(), 100)
}

func clip(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}
