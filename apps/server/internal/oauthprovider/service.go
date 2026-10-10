// Package oauthprovider implements the workspace-scoped OAuth/OIDC identity provider.
// It deliberately does not authenticate first-party API, bot, or RTC requests.
package oauthprovider

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/google/uuid"
)

// SessionResolver resolves a first-party human session from trusted authentication.
// The provider reloads its authoritative state; it never trusts supplied role claims.
// ResolveSession must reject provider tokens and require a bearer on consent/management
// routes. An optional browser session may be resolved on authorize for prompt=none.
type SessionResolver func(context.Context, *http.Request) (identitypolicy.Principal, error)

// Config consists exclusively of trusted server dependencies and operator config.
type Config struct {
	DB                 *db.DB
	PublicOrigin       string
	Entitlements       identitypolicy.EntitlementConfig
	ResolveSession     SessionResolver
	SignerForWorkspace func(uuid.UUID) (*signing.Keyring, error)
	Now                func() time.Time
	// Quota charges a per-(client,user) bucket after the provider authenticated the
	// client and found a live code/refresh/access token, so an anonymous caller
	// knowing a public client_id cannot exhaust it. Endpoint is "token" or
	// "userinfo". An *httpx.Error with status 429 becomes temporarily_unavailable;
	// nil disables (unit fixtures). Pre-authentication limits are keyed by IP and
	// applied by the integrator before the handler.
	Quota func(ctx context.Context, endpoint string, ws, client, user uuid.UUID) error
	// PlanActive refuses creating a client in a workspace in the restricted mode («тариф не
	// активен», ADR-0086 amendment 1; plans.Service.CheckActive): the route is public for the
	// identity gate, so the provider asks after its own authorization. The action names what is
	// refused. nil disables (unit fixtures).
	PlanActive func(ctx context.Context, ws uuid.UUID, action string) error
}

// Service exposes protocol routes and Calaba consent/management routes.
type Service struct{ c Config }

// New rejects a partial configuration. No feature can fall back to plaintext keys
// or a public origin derived from request Host or forwarded headers.
func New(c Config) (*Service, error) {
	u, err := url.Parse(c.PublicOrigin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(c.PublicOrigin, "#") || u.Opaque != "" || c.DB == nil || c.DB.Pool == nil || c.DB.Q == nil || c.ResolveSession == nil || c.SignerForWorkspace == nil {
		return nil, errors.New("oauthprovider: invalid configuration")
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	// Detach mutable operator maps from the configuration caller.
	copied := make(map[uuid.UUID]bool, len(c.Entitlements.EnterpriseWorkspaceIDs))
	for k, v := range c.Entitlements.EnterpriseWorkspaceIDs {
		copied[k] = v
	}
	c.Entitlements.EnterpriseWorkspaceIDs = copied
	return &Service{c: c}, nil
}

func (s *Service) issuer(ws uuid.UUID) string {
	return s.c.PublicOrigin + "/oidc/workspaces/" + ws.String()
}
func opaque(prefix string) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("oauthprovider: operating system random source failed")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}
func hash(raw string) []byte     { v := sha256.Sum256([]byte(raw)); return v[:] }
func equalHash(a, b []byte) bool { return subtle.ConstantTimeCompare(a, b) == 1 }
func tokenShape(raw, prefix string) bool {
	if !strings.HasPrefix(raw, prefix) || len(raw) != len(prefix)+43 {
		return false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(strings.TrimPrefix(raw, prefix))
	return err == nil && len(b) == 32
}
func subset(a, b []string) bool {
	for _, v := range a {
		if !slices.Contains(b, v) {
			return false
		}
	}
	return true
}
func minimum(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

func (s *Service) state(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID, op identitypolicy.Operation) (identitypolicy.State, identitypolicy.Decision, error) {
	_, lockErr := q.LockIdentityBoundary(ctx, sqlc.LockIdentityBoundaryParams{WorkspaceID: ws, UserID: p.UserID, SessionID: p.SessionID})
	if lockErr != nil && !errors.Is(lockErr, dbNoRows()) {
		return identitypolicy.State{}, identitypolicy.Decision{}, lockErr
	}
	st, err := identitypolicy.NewSQLLoader(q, s.c.Entitlements).LoadIdentityState(ctx, p.SessionID, p.UserID, ws)
	if err != nil {
		return st, identitypolicy.Decision{}, err
	}
	if st.Principal.UserID != p.UserID || st.Principal.SessionID != p.SessionID || st.WorkspaceID != ws {
		return st, identitypolicy.Decision{}, identitypolicy.ErrDenied
	}
	now, err := s.policyNow(ctx, q)
	if err != nil {
		return st, identitypolicy.Decision{}, err
	}
	d := identitypolicy.Evaluate(now, st, op)
	if lockErr != nil && d.Allowed {
		d = identitypolicy.Decision{Reason: identitypolicy.MembershipRequired}
	}
	if !d.Allowed {
		return st, d, identitypolicy.ErrDenied
	}
	return st, d, nil
}

// A deadline expired on either trusted clock is expired for policy. Read this
// only after boundary locks and the authoritative state snapshot are acquired.
func (s *Service) policyNow(ctx context.Context, q *sqlc.Queries) (time.Time, error) {
	dbNow, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return time.Time{}, err
	}
	now := s.c.Now()
	if dbNow.After(now) {
		now = dbNow
	}
	return now, nil
}

// All provider transactions acquire workspace, then client, grant, session/member
// locks. This serializes security updates with issuance without holding locks
// across external calls or relying on an in-process mutex. Callers take it only
// after an unlocked credential check succeeded, so anonymous traffic never queues
// on the workspace row. The policy row is read (the state loader defaults a
// missing row); it is created lazily by admin writes, never on this path.
func (s *Service) lockWorkspace(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	_, err := q.LockOAuthWorkspace(ctx, ws)
	if errors.Is(err, dbNoRows()) {
		return &protocolError{code: "invalid_request", status: http.StatusNotFound}
	}
	return err
}

func (s *Service) quota(ctx context.Context, endpoint string, ws, client, user uuid.UUID) error {
	if s.c.Quota == nil {
		return nil
	}
	return s.c.Quota(ctx, endpoint, ws, client, user)
}

func (s *Service) audit(ctx context.Context, q *sqlc.Queries, ws, user, target uuid.UUID, action string) error {
	var actor *uuid.UUID
	if user != uuid.Nil {
		actor = &user
	}
	outcome := "changed"
	if action == "oauth_consent_denied" {
		outcome = "denied"
	}
	_, err := q.CreateIdentityAudit(ctx, sqlc.CreateIdentityAuditParams{WorkspaceID: ws, ActorID: actor, TargetID: &target, Action: action, Outcome: outcome})
	return err
}

// auditGrant records an OAuth-only revocation. It deliberately writes no identity
// invalidation: those wake gateway/RTC sweeps, and WS/RTC never accept provider
// tokens. Provider endpoints re-check the grant row on every use.
func (s *Service) auditGrant(ctx context.Context, q *sqlc.Queries, g sqlc.OauthGrant, reason string) error {
	return s.audit(ctx, q, g.WorkspaceID, g.UserID, g.ID, reason)
}

func authTime(st identitypolicy.State) time.Time {
	if st.Principal.Authority == identitypolicy.WorkspaceSSO && st.Assurance != nil {
		return st.Assurance.AuthenticatedAt
	}
	return st.Principal.LocalAuthenticatedAt
}

func (s *Service) resolveBearer(r *http.Request) (identitypolicy.Principal, error) {
	raw := bearer(r)
	if raw == "" || strings.HasPrefix(raw, "calab_oa_") || strings.HasPrefix(raw, "calab_or_") || strings.HasPrefix(raw, "calab_oc_") || strings.HasPrefix(raw, "calab_bot_") {
		return identitypolicy.Principal{}, identitypolicy.ErrDenied
	}
	return s.c.ResolveSession(r.Context(), r)
}
