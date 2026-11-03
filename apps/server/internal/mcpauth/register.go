package mcpauth

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// loopbackHosts: redirects to the client's own machine (RFC 8252 §7.3), the way CLI clients
// (Claude Code, Codex) receive the code.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// redirectKind checks a redirect URI: loopback http (any port), or https on an allowed host.
// No fragment, no credentials. ok=false: refused.
func (s *Service) redirectKind(raw string) (loopback, ok bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.User != nil || u.Opaque != "" || u.Host == "" || len(raw) > 2000 {
		return false, false
	}
	host := strings.ToLower(u.Hostname())
	switch u.Scheme {
	case "http":
		return true, slices.Contains(loopbackHosts, host)
	case "https":
		for _, h := range s.c.RedirectHosts {
			if strings.EqualFold(strings.TrimSpace(h), host) {
				return false, true
			}
		}
	}
	return false, false
}

// redirectMatches: presented is one of the client's redirect URIs; for loopback the port may
// differ (RFC 8252 §7.3: a CLI listens on whatever port is free).
func redirectMatches(registered []string, presented string) bool {
	if slices.Contains(registered, presented) {
		return true
	}
	p, err := url.Parse(presented)
	if err != nil || p.Scheme != "http" || !slices.Contains(loopbackHosts, strings.ToLower(p.Hostname())) {
		return false
	}
	for _, r := range registered {
		u, err := url.Parse(r)
		if err == nil && u.Scheme == "http" && strings.EqualFold(u.Hostname(), p.Hostname()) && u.Path == p.Path && u.RawQuery == p.RawQuery {
			return true
		}
	}
	return false
}

type registration struct {
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
}

// register is dynamic client registration (RFC 7591). Only public clients: the answer always says
// token_endpoint_auth_method "none" and no secret (§3.2.1 lets the server override metadata).
func (s *Service) register(w http.ResponseWriter, r *http.Request) {
	cors(w)
	var in registration
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "the body must be a JSON object")
		return
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > maxRedirects {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "1 to 10 redirect_uris are required")
		return
	}
	for _, u := range in.RedirectURIs {
		if _, ok := s.redirectKind(u); !ok {
			oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "redirect_uris must be http://localhost, http://127.0.0.1 or http://[::1] (any port), or https on an allowed host: "+u)
			return
		}
	}
	for _, g := range in.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "only authorization_code and refresh_token grants")
			return
		}
	}
	for _, t := range in.ResponseTypes {
		if t != "code" {
			oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "only the code response type")
			return
		}
	}
	name := clip(in.ClientName, 100)
	if name == "" {
		name = "MCP client"
	}
	ctx := r.Context()
	ip := httpx.ClientIP(ctx)
	n, err := s.c.DB.Q.CountMCPClientsFromIP(ctx, ip)
	if err != nil {
		oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "try again")
		return
	}
	if n >= registrationsPerHour {
		w.Header().Set("Retry-After", "3600")
		oauthError(w, http.StatusTooManyRequests, "temporarily_unavailable", "too many registrations from this address")
		return
	}
	if err := db.GuardExec(ctx, s.c.DB, func(q *sqlc.Queries) error { return q.DeleteUnusedMCPClients(ctx) }); err != nil {
		slog.WarnContext(ctx, "mcp oauth: client cleanup failed", "err", err)
	}
	c, err := db.GuardValue(ctx, s.c.DB, func(q *sqlc.Queries) (sqlc.McpOauthClient, error) {
		return q.CreateMCPClient(ctx, sqlc.CreateMCPClientParams{ID: opaque("calab_mc_", 24), Name: name, RedirectUris: in.RedirectURIs, CreatedIp: clip(ip, 64)})
	})
	if err != nil {
		slog.ErrorContext(ctx, "mcp oauth: register", "err", err)
		oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "try again")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  c.ID,
		"client_id_issued_at":        c.CreatedAt.Unix(),
		"client_name":                c.Name,
		"redirect_uris":              c.RedirectUris,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

func (s *Service) now() time.Time { return s.c.Now() }
