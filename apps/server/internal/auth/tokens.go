package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const issuer = "calaba"

// issuerMCP signs the access tokens of MCP sessions (ADR-0158): a server without MCP OAuth
// (a rollback, an old instance in a rolling deploy) checks the issuer and refuses them, so it can
// never take an MCP token for an app session.
const issuerMCP = "calaba-mcp"

// mcpRefreshPrefix marks an MCP session's refresh token ("mcp.<session id>.<secret>"): a server
// without MCP OAuth fails to parse it, and the app's refresh, logout and cookie paths refuse it.
const mcpRefreshPrefix = "mcp."

// Claims of the access JWT: sub = user id, sid = session id, rg = the session's refresh
// generation the token was minted for (replay.go; absent in tokens from before migration 00040).
type Claims struct {
	SessionID  string `json:"sid"`
	RefreshGen int64  `json:"rg,omitempty"`
	// Scope "mcp": the token of an MCP session (ADR-0158), valid only on the MCP endpoint and in
	// its tools' in-process calls. Absent for the app's own sessions.
	Scope string `json:"scp,omitempty"`
	jwt.RegisteredClaims
}

// ScopeMCP is the scope of an MCP session (sessions.scope, the access token's scp claim).
const ScopeMCP = "mcp"

// Tokens issues and verifies access JWTs (HS256).
type Tokens struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// NewTokens creates an issuer. secret must be ≥ 32 bytes (validated in config).
func NewTokens(secret []byte, ttl time.Duration) *Tokens {
	return &Tokens{secret: secret, ttl: ttl, now: time.Now}
}

// Issue returns a signed access token and its expiry. refreshGen is the session's current
// refresh generation (0 = none).
func (t *Tokens) Issue(userID, sessionID uuid.UUID, refreshGen int64) (string, time.Time, error) {
	return t.IssueUntil(userID, sessionID, refreshGen, time.Time{})
}

// IssueUntil caps credentials at the authoritative session deadline.
func (t *Tokens) IssueUntil(userID, sessionID uuid.UUID, refreshGen int64, deadline time.Time) (string, time.Time, error) {
	return t.issue(userID, sessionID, refreshGen, deadline, "")
}

func (t *Tokens) issue(userID, sessionID uuid.UUID, refreshGen int64, deadline time.Time, scope string) (string, time.Time, error) {
	now := t.now()
	exp := now.Add(t.ttl)
	if !deadline.IsZero() && deadline.Before(exp) {
		exp = deadline
	}
	if !now.Before(exp) {
		return "", exp, ErrInvalidToken
	}
	iss := issuer
	if scope == ScopeMCP {
		iss = issuerMCP
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		SessionID:  sessionID.String(),
		RefreshGen: refreshGen,
		Scope:      scope,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    iss,
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	})
	s, err := tok.SignedString(t.secret)
	return s, exp, err
}

// Identity is the authenticated principal of a request.
type Identity struct {
	// Principal is loaded from the session row, never from bearer claims.
	Principal identitypolicy.Principal
	UserID    uuid.UUID
	// SessionID is the auth session (device). For a bot it is the id of its current token
	// (bots.token_id, ADR-0031): one "device", revoked together with the token.
	SessionID uuid.UUID
	// IsBot: authenticated with a bot token (ADR-0031); routes decide whether bots may call
	// them (app route table, NoBots).
	IsBot bool
	// ViaBot: a bot's request on behalf of its owner (ADR-0106, header Calab-On-Behalf): UserID
	// is the owner (rights, authorship), IsBot is false, SessionID is the bot's current token
	// id, Principal is zero. The identity policy treats it as a machine (Machine), never as a
	// session of the owner.
	ViaBot uuid.UUID
	// ForMember: with ViaBot, the bot acts for a member who consented (ADR-0111, header
	// Calab-On-Behalf: <user id>), not for its owner: UserID is that member. Such a request
	// stays inside the workspaces of the consent (no DMs, nothing account-wide).
	ForMember bool
	// RefreshGen: the refresh generation the access token was minted for (0 = unknown / bot).
	RefreshGen int64
	// MCP: the person's MCP session (ADR-0158, scope "mcp"): admitted only on the MCP endpoint
	// and in its tools' in-process calls (Require); AuthenticateToken refuses it.
	MCP bool
}

// OnBehalf reports a bot's request on behalf of its owner (ADR-0106) or of a member who
// consented (ADR-0111, ForMember).
func (id Identity) OnBehalf() bool { return id.ViaBot != uuid.Nil }

// Machine reports an identity without a person's session: a bot, or a bot on behalf of its
// owner. The identity policy (SSO proofs, sessions) never evaluates it as a session.
func (id Identity) Machine() bool { return id.IsBot || id.OnBehalf() }

// ErrInvalidToken covers every access-token failure (bad signature, expired, malformed).
var ErrInvalidToken = errors.New("auth: invalid access token")

// Parse verifies an access token and returns its identity.
func (t *Tokens) Parse(token string) (Identity, error) {
	var c Claims
	_, err := jwt.ParseWithClaims(token, &c, func(*jwt.Token) (any, error) { return t.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(5*time.Second),
		jwt.WithTimeFunc(t.now),
	)
	if err != nil {
		return Identity{}, ErrInvalidToken
	}
	uid, err1 := uuid.Parse(c.Subject)
	sid, err2 := uuid.Parse(c.SessionID)
	if err1 != nil || err2 != nil {
		return Identity{}, ErrInvalidToken
	}
	switch {
	case c.Issuer == issuer && c.Scope == "":
	case c.Issuer == issuerMCP && c.Scope == ScopeMCP:
	default:
		return Identity{}, ErrInvalidToken
	}
	return Identity{UserID: uid, SessionID: sid, RefreshGen: c.RefreshGen, MCP: c.Scope == ScopeMCP}, nil
}

// Refresh tokens are "<session_id>.<secret>", secret = 32 random bytes (base64url).
// Only sha256(secret) is stored. Binding the session id into the token makes reuse
// detection O(1): a well-formed token for a live session whose secret is neither the current
// one nor the previous one while the current is unused (replay.go) is a replay of a rotated
// token (or a forgery), and the session is revoked.

// NewRefreshSecret returns a fresh secret and its hash.
func NewRefreshSecret() (secret string, hash []byte, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	secret = base64.RawURLEncoding.EncodeToString(b)
	return secret, HashRefreshSecret(secret), nil
}

// HashRefreshSecret hashes the secret part of a refresh token.
func HashRefreshSecret(secret string) []byte {
	h := sha256.Sum256([]byte(secret))
	return h[:]
}

// FormatRefreshToken joins the session id and the secret.
func FormatRefreshToken(sessionID uuid.UUID, secret string) string {
	return sessionID.String() + "." + secret
}

// formatMCPRefreshToken is FormatRefreshToken of an MCP session.
func formatMCPRefreshToken(sessionID uuid.UUID, secret string) string {
	return mcpRefreshPrefix + FormatRefreshToken(sessionID, secret)
}

// parseMCPRefreshToken splits an MCP session's refresh token; an app's token is malformed here.
func parseMCPRefreshToken(tok string) (sessionID uuid.UUID, secret string, ok bool) {
	rest, found := strings.CutPrefix(tok, mcpRefreshPrefix)
	if !found {
		return uuid.Nil, "", false
	}
	return ParseRefreshToken(rest)
}

// ParseRefreshToken splits a refresh token; ok=false if malformed (an MCP session's token too).
func ParseRefreshToken(tok string) (sessionID uuid.UUID, secret string, ok bool) {
	sid, sec, found := strings.Cut(tok, ".")
	if !found || len(sec) != 43 { // 32 bytes base64url without padding
		return uuid.Nil, "", false
	}
	if _, err := base64.RawURLEncoding.DecodeString(sec); err != nil {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(sid)
	if err != nil {
		return uuid.Nil, "", false
	}
	return id, sec, true
}
