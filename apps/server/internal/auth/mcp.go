package auth

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

// MCP sessions (ADR-0158): a person connects an MCP client through OAuth (internal/mcpauth); the
// grant is a session of the person with scope "mcp". Its access tokens carry scp=mcp and are
// admitted only on the MCP endpoint and in its tools' in-process calls (channel mcp, ADR-0156);
// everything else about the session — rights, the identity policy, revocation, refresh rotation
// and replay detection — is the app session's.

// MCPPath is the MCP endpoint (mcp.Path): the one route an MCP token is presented to directly.
const MCPPath = "/api/mcp"

// ReasonMCPToken marks a route refused to an MCP token (403).
const ReasonMCPToken = "MCP_TOKEN"

// RevokeMCPCodeReuse is the revocation reason when the authorization code that created the
// session was presented again (RFC 6749 §4.1.2).
const RevokeMCPCodeReuse = "MCP_CODE_REUSE"

// RevokeMCPReplaced is the revocation reason when a newer consent of the same person for the same
// client replaced the session.
const RevokeMCPReplaced = "MCP_REPLACED"

// errMCPToken answers an MCP token anywhere but the MCP endpoint and its tools.
var errMCPToken = httpx.Forbidden("this token is valid only for the MCP endpoint").WithDetails(ReasonMCPToken, 0, 0)

// mcpSessionOf: the session is an MCP session of client (client "" = an app session).
func mcpSessionOf(sess sqlc.Session, client string) bool {
	if client == "" {
		return sess.Scope == nil && sess.McpClientID == nil
	}
	return sess.Scope != nil && *sess.Scope == ScopeMCP && sess.McpClientID != nil && *sess.McpClientID == client
}

// mcpRequest admits an MCP identity on the MCP endpoint (POST only, the transport) and in the
// tools' in-process calls (the channel is a server-only context value: no header or token sets
// it), and applies the per-session request limit (BOT_RATE_PER_SEC, like a bot).
//
// The tools' calls are further confined to the routes the tools use (MCPInnerRoutes, the patterns
// of the route table): the session is the person's, so a route no tool calls stays closed to it
// even if a tool were to build a wrong path.
func (s *Service) mcpRequest(r *http.Request, id Identity) error {
	inner := Channel(r.Context())
	switch {
	case r.Pattern == MCPPath && r.URL.Path == MCPPath && inner == nil:
	case inner != nil && *inner == ChannelMCP && s.MCPInnerRoutes[r.Pattern]:
	default:
		return errMCPToken
	}
	if s.BotLimiter != nil {
		if err := s.BotLimiter.Take(r.Context(), "mcp:"+id.SessionID.String()); err != nil {
			return err
		}
	}
	return nil
}

// MCPSessionTokens creates the MCP session of userID for an OAuth client (inside the token
// exchange's transaction) and returns its first token pair. The session is local_account without
// local_authenticated_at: routes that ask for a fresh password stay closed to it.
//
// replaced are the person's earlier live MCP sessions of this client, revoked in the same
// transaction (RevokeMCPReplaced makes it effective after the commit).
func (s *Service) MCPSessionTokens(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, clientID, clientName string, c Client) (t *v1.AuthTokens, sid uuid.UUID, replaced []uuid.UUID, err error) {
	u, err := q.GetUser(ctx, userID)
	if err != nil {
		return nil, uuid.Nil, nil, err
	}
	if u.IsBot || u.IsGuest || u.DisabledAt != nil {
		return nil, uuid.Nil, nil, errInvalidRefresh
	}
	secret, hash, err := NewRefreshSecret()
	if err != nil {
		return nil, uuid.Nil, nil, err
	}
	cid := clientID
	sess, err := q.CreateMCPSession(ctx, sqlc.CreateMCPSessionParams{
		UserID:           userID,
		RefreshTokenHash: hash,
		DeviceName:       clip("MCP · "+clientName, 64),
		Ip:               clip(c.IP, 64),
		UserAgent:        clip(c.UserAgent, 256),
		ExpiresAt:        s.now().Add(s.refresh),
		McpClientID:      &cid,
	})
	if err != nil {
		return nil, uuid.Nil, nil, fmt.Errorf("create MCP session: %w", err)
	}
	if replaced, err = q.RevokeReplacedMCPSessions(ctx, sqlc.RevokeReplacedMCPSessionsParams{UserID: userID, McpClientID: cid, ID: sess.ID, Reason: RevokeMCPReplaced}); err != nil {
		return nil, uuid.Nil, nil, err
	}
	t, err = s.tokenPair(sess, secret)
	return t, sess.ID, replaced, err
}

// RefreshMCP rotates an MCP session of clientID (the token endpoint's refresh_token grant): the
// app's refresh logic (rotation, the lost-answer replay, reuse revocation, disabled accounts) for
// MCP sessions of that client only.
func (s *Service) RefreshMCP(ctx context.Context, refreshToken, clientID string, c Client) (*v1.AuthTokens, error) {
	if clientID == "" {
		return nil, errInvalidRefresh
	}
	r, err := s.refreshAuthority(ctx, &v1.RefreshRequest{RefreshToken: refreshToken}, c, identitypolicy.LocalAccount, uuid.Nil, clientID)
	if err != nil {
		return nil, err
	}
	return r.GetTokens(), nil
}

// RevokeMCPRefresh revokes the MCP session of clientID a refresh token belongs to (RFC 7009):
// the current token, or the previous one while the current is unused. Anything else is a no-op
// (the endpoint answers 200 either way).
func (s *Service) RevokeMCPRefresh(ctx context.Context, token, clientID string) error {
	if clientID == "" {
		return nil // "" would mean an app session (mcpSessionOf): never through this endpoint
	}
	sid, secret, ok := parseMCPRefreshToken(token)
	if !ok {
		return nil
	}
	sess, err := s.db.Q.GetSession(ctx, sid)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !mcpSessionOf(sess, clientID) || sess.RevokedAt != nil {
		return nil
	}
	h := HashRefreshSecret(secret)
	current := subtle.ConstantTimeCompare(h, sess.RefreshTokenHash) == 1
	recent := sess.PrevRefreshTokenHash != nil && sess.RefreshUsedAt == nil && subtle.ConstantTimeCompare(h, sess.PrevRefreshTokenHash) == 1
	if !current && !recent {
		return nil
	}
	return s.Logout(ctx, Identity{UserID: sess.UserID, SessionID: sess.ID}, false)
}

// RevokeMCPReplaced revokes the person's earlier MCP sessions of the same client: a new consent
// replaces them (the client lost or dropped its tokens). Call after the creating transaction.
func (s *Service) RevokeMCPReplaced(ctx context.Context, ids []uuid.UUID) {
	if len(ids) > 0 {
		s.afterRevokeMany(ctx, ids, RevokeMCPReplaced)
	}
}

// RevokeMCPSession revokes an MCP session created from a replayed authorization code.
func (s *Service) RevokeMCPSession(ctx context.Context, sid uuid.UUID) error {
	if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RevokeSession(ctx, sqlc.RevokeSessionParams{ID: sid, Reason: RevokeMCPCodeReuse})
	}); err != nil {
		return err
	}
	s.afterRevoke(ctx, sid, RevokeMCPCodeReuse)
	return nil
}

// Now is the service clock (tests move it).
func (s *Service) Now() time.Time { return s.now() }
