package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// LocalBrowserCookie is never accepted on ordinary API, consent or management routes.
const LocalBrowserCookie = "__Host-calab-local-session"

// PrincipalFromRefresh resolves a browser session read-only. Only its current secret is
// valid; stale cookies neither rotate tokens nor revoke the current session through reuse.
func (s *Service) PrincipalFromRefresh(ctx context.Context, token string) (identitypolicy.Principal, error) {
	sid, secret, ok := ParseRefreshToken(token)
	if !ok {
		return identitypolicy.Principal{}, ErrInvalidToken
	}
	row, err := s.db.Q.GetSession(ctx, sid)
	if db.IsNotFound(err) {
		return identitypolicy.Principal{}, ErrInvalidToken
	}
	if err != nil {
		return identitypolicy.Principal{}, err
	}
	if subtle.ConstantTimeCompare(row.RefreshTokenHash, HashRefreshSecret(secret)) != 1 || !mcpSessionOf(row, "") {
		return identitypolicy.Principal{}, ErrInvalidToken // an MCP connection is not a browser session (ADR-0158)
	}
	return s.ResolvePrincipal(ctx, Identity{UserID: row.UserID, SessionID: sid})
}
func (h *Handlers) browserRefreshCookie(w http.ResponseWriter, t *v1.AuthTokens) {
	if h.IdentityOrigin != "" {
		exp := t.GetRefreshExpiresAt().AsTime()
		http.SetCookie(w, &http.Cookie{Name: LocalBrowserCookie, Value: t.GetRefreshToken(), Path: "/", Expires: exp, MaxAge: int(time.Until(exp).Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	}
	setRefreshCookie(w, t)
}
func (h *Handlers) clearBrowserRefreshCookie(w http.ResponseWriter) {
	if h.IdentityOrigin != "" {
		http.SetCookie(w, &http.Cookie{Name: LocalBrowserCookie, Path: "/", MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	}
	clearRefreshCookie(w)
}
