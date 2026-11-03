package mcpauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

var verifierShape = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

// maxForm caps the token and revocation request bodies.
const maxForm = 8 << 10

// errGrant is an invalid_grant (code unknown, used, expired, for another client or redirect, a
// wrong verifier; a refresh token that is not this client's live MCP session).
var errGrant = errors.New("invalid_grant")

// token is the token endpoint (form-encoded, public clients: client_id identifies, PKCE proves).
func (s *Service) token(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if limited(w, r, s.c.TokenLimit) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxForm)
	if err := r.ParseForm(); err != nil || r.PostForm == nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", "the body must be application/x-www-form-urlencoded")
		return
	}
	f := r.PostForm
	ctx := r.Context()
	c := auth.Client{IP: httpx.ClientIP(ctx), UserAgent: r.UserAgent()}
	var (
		tokens *v1.AuthTokens
		err    error
	)
	switch f.Get("grant_type") {
	case "authorization_code":
		tokens, err = s.exchange(r, c)
	case "refresh_token":
		if f.Get("client_id") == "" || f.Get("refresh_token") == "" {
			err = errGrant
			break
		}
		tokens, err = s.c.Auth.RefreshMCP(ctx, f.Get("refresh_token"), f.Get("client_id"), c)
	default:
		oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "authorization_code or refresh_token")
		return
	}
	if err != nil {
		var he *httpx.Error
		switch {
		case errors.As(err, &he) && he.Status == http.StatusConflict:
			// Two refreshes raced (the session lives): retry, do not drop the tokens.
			oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "the refresh token was just rotated; retry")
		case errors.Is(err, errGrant), errors.As(err, &he) && he.Status < 500:
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the code or refresh token is invalid, expired or was already used")
		default:
			slog.ErrorContext(ctx, "mcp oauth: token", "err", err)
			oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "try again")
		}
		return
	}
	exp := int64(time.Until(tokens.GetAccessExpiresAt().AsTime()).Seconds())
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  tokens.GetAccessToken(),
		"token_type":    "Bearer",
		"expires_in":    max(exp, 1),
		"refresh_token": tokens.GetRefreshToken(),
		"scope":         auth.ScopeMCP,
	})
}

// exchange trades a code for the person's MCP session. A code presented again revokes the session
// it created (RFC 6749 §4.1.2).
func (s *Service) exchange(r *http.Request, c auth.Client) (*v1.AuthTokens, error) {
	f, ctx := r.PostForm, r.Context()
	code, verifier, client := f.Get("code"), f.Get("code_verifier"), f.Get("client_id")
	if code == "" || client == "" || !verifierShape.MatchString(verifier) {
		return nil, errGrant
	}
	var (
		tokens   *v1.AuthTokens
		replay   *uuid.UUID
		replaced []uuid.UUID
	)
	err := s.c.DB.Tx(ctx, func(q *sqlc.Queries) error {
		req, err := q.GetMCPRequestByCodeForUpdate(ctx, hash(code))
		if db.IsNotFound(err) {
			return errGrant
		}
		if err != nil {
			return err
		}
		if req.CodeUsedAt != nil {
			replay = req.SessionID
			return nil
		}
		if req.CodeExpiresAt == nil || !s.now().Before(*req.CodeExpiresAt) || req.UserID == nil ||
			subtle.ConstantTimeCompare([]byte(client), []byte(req.ClientID)) != 1 {
			return errGrant
		}
		if ru := f.Get("redirect_uri"); ru != "" && ru != req.RedirectUri {
			return errGrant
		}
		if res := strings.TrimSuffix(f.Get("resource"), "/"); req.Resource != s.resource(r) || (res != "" && res != req.Resource) {
			return errGrant
		}
		// The consent's session must still be live: «выйти везде» during the code's minute wins.
		if req.BoundSession == nil {
			return errGrant
		}
		if live, err := q.IsSessionLive(ctx, *req.BoundSession); err != nil {
			return err
		} else if !live {
			return errGrant
		}
		sum := sha256.Sum256([]byte(verifier))
		if subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(req.CodeChallenge)) != 1 {
			return errGrant
		}
		cl, err := q.GetMCPClient(ctx, req.ClientID)
		if err != nil {
			return err
		}
		t, sid, rep, err := s.c.Auth.MCPSessionTokens(ctx, q, *req.UserID, cl.ID, cl.Name, c)
		if err != nil {
			return err
		}
		replaced = rep
		if err := q.UseMCPCode(ctx, sqlc.UseMCPCodeParams{ID: req.ID, SessionID: &sid}); err != nil {
			return err
		}
		if err := q.TouchMCPClient(ctx, cl.ID); err != nil {
			return err
		}
		tokens = t
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.c.Auth.RevokeMCPReplaced(ctx, replaced)
	if replay != nil || tokens == nil {
		if replay != nil {
			slog.WarnContext(ctx, "mcp oauth: authorization code replayed, session revoked", "session_id", *replay)
			if err := s.c.Auth.RevokeMCPSession(ctx, *replay); err != nil {
				return nil, err
			}
		}
		return nil, errGrant
	}
	return tokens, nil
}

// revoke is RFC 7009: the refresh token's MCP session ends. Always 200 (unknown tokens too).
func (s *Service) revoke(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if limited(w, r, s.c.TokenLimit) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxForm)
	if err := r.ParseForm(); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", "form body expected")
		return
	}
	if err := s.c.Auth.RevokeMCPRefresh(r.Context(), r.PostForm.Get("token"), r.PostForm.Get("client_id")); err != nil {
		slog.ErrorContext(r.Context(), "mcp oauth: revoke", "err", err)
		oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "try again")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}
