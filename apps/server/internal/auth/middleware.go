package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

type ctxKey struct{}

// FromContext returns the request identity; ok=false on unauthenticated routes.
func FromContext(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// MustFromContext returns the identity or panics (wiring bug: route not behind Require).
func MustFromContext(ctx context.Context) Identity {
	id, ok := FromContext(ctx)
	if !ok {
		panic("auth: no identity in context")
	}
	return id
}

// WithIdentity stores id in ctx (tests, gateway).
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// Require authenticates `Authorization: Bearer <access JWT | bot token>` and rejects revoked
// sessions and tokens (Valkey marker + a periodic DB recheck, sessioncheck.go). With Valkey
// down the DB decides; with both down it fails closed (503): a revoked session must not slip
// through. Bot identities (ADR-0031) pass here; whether a route admits them is decided by
// the route table of the app (NoBots). Bots are rate limited per bot (BotLimiter). A bot
// request with Calab-On-Behalf runs as the bot's owner or is refused (ADR-0106, onbehalf.go).
func (s *Service) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := s.authenticate(r, true)
		if err == nil && id.MCP {
			err = s.mcpRequest(r, id) // ADR-0158: the MCP endpoint and its tools only
		}
		if err == nil && id.IsBot {
			err = s.botRequest(r.Context(), id) // on behalf of the owner too: the bot's limits (ADR-0106)
		}
		if err == nil {
			id, err = s.onBehalf(r, id)
		}
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// botRequest applies the per-bot request limit and reports the activity (presence).
func (s *Service) botRequest(ctx context.Context, id Identity) error {
	if s.BotLimiter != nil {
		if err := s.BotLimiter.Take(ctx, id.UserID.String()); err != nil {
			return err
		}
	}
	if s.OnBotRequest != nil {
		s.OnBotRequest(ctx, id)
	}
	return nil
}

// HasBearer reports whether the request carries an Authorization bearer token.
func HasBearer(r *http.Request) bool {
	return strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// Authenticate validates the bearer access token of r for routes that do their own
// authentication (logout, room links). Those are for people only: a bot token gets 403.
func (s *Service) Authenticate(r *http.Request) (Identity, error) {
	id, err := s.authenticate(r, false)
	if err == nil && id.IsBot {
		return Identity{}, ErrBotNotAllowed
	}
	return id, err
}

// allowMCP admits an MCP session's token (ADR-0158; Require then confines it to the MCP endpoint).
func (s *Service) authenticate(r *http.Request, allowMCP bool) (Identity, error) {
	tok, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found || tok == "" {
		return Identity{}, httpx.Unauthenticated("missing bearer token")
	}
	id, err := s.authenticateToken(r.Context(), tok, allowMCP)
	switch {
	case err == nil:
		return id, nil
	case errors.Is(err, ErrInvalidToken):
		return Identity{}, httpx.Unauthenticated("invalid or expired access token")
	case errors.Is(err, ErrSessionRevoked):
		return Identity{}, httpx.Unauthenticated("session revoked")
	default:
		slog.ErrorContext(r.Context(), "token check failed", "err", err)
		return Identity{}, httpx.Unavailable(err)
	}
}

// AuthenticateToken validates an access JWT or a bot token (REST and gateway IDENTIFY).
// Errors: ErrInvalidToken, ErrSessionRevoked, or a dependency failure (fail closed). An MCP
// session's token (ADR-0158) is ErrInvalidToken here: it is for the MCP endpoint only.
func (s *Service) AuthenticateToken(ctx context.Context, tok string) (Identity, error) {
	return s.authenticateToken(ctx, tok, false)
}

func (s *Service) authenticateToken(ctx context.Context, tok string, allowMCP bool) (Identity, error) {
	if IsBotToken(tok) {
		return s.authenticateBot(ctx, tok)
	}
	id, err := s.tokens.Parse(tok)
	if err != nil || (id.MCP && !allowMCP) {
		return Identity{}, ErrInvalidToken
	}
	if err := s.checkSession(ctx, id.SessionID); err != nil {
		return Identity{}, err
	}
	liveSessions.mu.Lock()
	p := liveSessions.principals[id.SessionID]
	mcpSession := liveSessions.mcp[id.SessionID]
	liveSessions.mu.Unlock()
	if p.UserID != id.UserID || mcpSession != id.MCP || !identitypolicy.CheckSession(s.now(), p).Allowed {
		return Identity{}, ErrInvalidToken
	}
	id.Principal = p
	// The pair this token came with has arrived: its previous refresh token is reuse now.
	s.markGenUsed(ctx, id)
	return id, nil
}
