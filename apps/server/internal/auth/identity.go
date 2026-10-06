package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/superadmin"
	"github.com/google/uuid"
)

// SessionPrincipal converts only authoritative persisted session fields.
func SessionPrincipal(s sqlc.Session) identitypolicy.Principal {
	p := identitypolicy.Principal{UserID: s.UserID, SessionID: s.ID, Authority: identitypolicy.Authority(s.AuthorityKind), ExpiresAt: s.ExpiresAt, Revoked: s.RevokedAt != nil, Version: s.AuthorityVersion}
	if s.AuthorityWorkspaceID != nil {
		p.WorkspaceID = *s.AuthorityWorkspaceID
	}
	if s.AuthorityConnectionID != nil {
		p.ConnectionID = *s.AuthorityConnectionID
	}
	if s.LocalAuthenticatedAt != nil {
		p.LocalAuthenticatedAt = *s.LocalAuthenticatedAt
	}
	if s.RecoveryAuthenticatedAt != nil {
		p.RecoveryAuthenticatedAt = *s.RecoveryAuthenticatedAt
	}
	return p
}

// ResolvePrincipal loads the exact session/user pair. Background consumers never infer
// authority from a user ID or the user's other sessions.
func (s *Service) ResolvePrincipal(ctx context.Context, id Identity) (identitypolicy.Principal, error) {
	if id.IsBot {
		return identitypolicy.Principal{UserID: id.UserID, SessionID: id.SessionID, Bot: true}, nil
	}
	row, err := s.db.Q.GetSession(ctx, id.SessionID)
	return s.principalOf(id, row, err, func(user uuid.UUID) (sqlc.User, error) { return s.db.Q.GetUser(ctx, user) })
}

// ResolvePrincipalFrom is ResolvePrincipal over rows already read (the RTC sweep reads the
// sessions and users of a whole room at once): session/sessionErr and user/userErr are what
// GetSession(id.SessionID) and GetUser(id.UserID) returned.
func (s *Service) ResolvePrincipalFrom(id Identity, session sqlc.Session, sessionErr error, user sqlc.User, userErr error) (identitypolicy.Principal, error) {
	if id.IsBot {
		return identitypolicy.Principal{UserID: id.UserID, SessionID: id.SessionID, Bot: true}, nil
	}
	return s.principalOf(id, session, sessionErr, func(uuid.UUID) (sqlc.User, error) { return user, userErr })
}

// principalOf: the single decision of ResolvePrincipal and ResolvePrincipalFrom. getUser is
// called only for the session's own user, which must be id.UserID.
func (s *Service) principalOf(id Identity, row sqlc.Session, err error, getUser func(uuid.UUID) (sqlc.User, error)) (identitypolicy.Principal, error) {
	if db.IsNotFound(err) {
		return identitypolicy.Principal{}, ErrSessionRevoked
	}
	if err != nil {
		return identitypolicy.Principal{}, err
	}
	p := SessionPrincipal(row)
	if p.UserID != id.UserID || !identitypolicy.CheckSession(s.now(), p).Allowed {
		return p, ErrSessionRevoked
	}
	u, err := getUser(p.UserID)
	if err != nil {
		return p, err
	}
	p.Guest, p.Bot = u.IsGuest, u.IsBot
	if u.DisabledAt != nil || u.IsGuest && u.GuestExpiresAt != nil && !s.now().Before(*u.GuestExpiresAt) {
		return p, ErrSessionRevoked
	}
	return p, nil
}

// IdentityError translates the frozen decision without exposing workspace content.
func IdentityError(p identitypolicy.Principal, d identitypolicy.Decision, err error) error {
	if d.Allowed && err == nil {
		return nil
	}
	if d.Reason == identitypolicy.StateUnavailable || (err != nil && !errors.Is(err, identitypolicy.ErrDenied)) {
		e := httpx.Coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
		e.Err = err
		return e
	}
	if d.Reason == identitypolicy.InvalidSession {
		return httpx.Unauthenticated("session invalid")
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
		return httpx.Conflict("identity entitlement required").WithDetails(httpx.ReasonPlanLimit, 0, 0)
	case identitypolicy.MembershipRequired:
		return httpx.NotFound("workspace")
	case identitypolicy.WorkspaceSuspended:
		return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "workspace suspended")
	}
	if p.Authority == identitypolicy.Recovery {
		code = v1.ErrorCode_ERROR_CODE_RECOVERY_ONLY
	}
	return httpx.Coded(http.StatusForbidden, code, "identity access denied")
}

// CheckWorkspace supplements resource permissions with fresh database policy state.
func (s *Service) CheckWorkspace(ctx context.Context, id Identity, ws uuid.UUID, op identitypolicy.Operation) error {
	if id.IsBot {
		suspended, err := s.db.Q.WorkspaceSuspended(ctx, ws)
		if err != nil {
			return httpx.Unavailable(err)
		}
		if suspended {
			return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "workspace suspended")
		}
		return nil // existing machine route/permission gates remain mandatory
	}
	d, err := s.CheckWorkspaceDecision(ctx, id, ws, op)
	return IdentityError(id.Principal, d, err)
}

// CheckGlobal requires independent local authority. Product administration additionally
// accepts a durable operator UUID grant or the explicitly configured legacy email source.
func (s *Service) CheckGlobal(ctx context.Context, id Identity, op identitypolicy.Operation) error {
	if id.IsBot {
		return ErrBotNotAllowed
	}
	p := id.Principal
	if p.SessionID == uuid.Nil {
		var err error
		p, err = s.ResolvePrincipal(ctx, id)
		if err != nil {
			return err
		}
	}
	granted := false
	if op == identitypolicy.ProductAdmin {
		// Admin checks are fresh, including local reauthentication and revocation.
		var err error
		p, err = s.ResolvePrincipal(ctx, id)
		if err != nil {
			return err
		}
		grant, gerr := s.db.Q.GetProductAdminGrant(ctx, id.UserID)
		if gerr != nil && !db.IsNotFound(gerr) {
			return httpx.Unavailable(gerr)
		}
		granted = gerr == nil && grant.RevokedAt == nil
		u, uerr := s.db.Q.GetUser(ctx, id.UserID)
		if uerr != nil {
			return uerr
		}
		granted = !u.IsGuest && !u.IsBot && u.DisabledAt == nil && (granted || (u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email)))
	}
	now, err := s.db.Q.IdentityDatabaseNow(ctx)
	if err != nil {
		return IdentityError(p, identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, err)
	}
	if host := s.now(); host.After(now) {
		now = host
	}
	d := identitypolicy.CheckGlobal(now, p, op, granted)
	if op == identitypolicy.ProductAdmin && p.Authority == identitypolicy.LocalAccount && d.Reason == identitypolicy.RoleRequired {
		return httpx.NotFound("route")
	}
	return IdentityError(p, d, nil)
}

// WithPolicy installs a request-local gate used by every nested resource resolution.
func (s *Service) WithPolicy(ctx context.Context, id Identity, op identitypolicy.Operation) context.Context {
	return perm.WithAccessGuard(ctx, func(ctx context.Context, ws, _ uuid.UUID) error {
		// A handler may resolve another member's permissions; authority still belongs to caller.
		if err := RecordMutationWorkspace(ctx, ws); err != nil {
			return err
		}
		if ws == uuid.Nil {
			if id.IsBot {
				return nil
			}
			return s.CheckGlobal(ctx, id, identitypolicy.GlobalRead)
		}
		return s.CheckWorkspace(ctx, id, ws, op)
	})
}

// LocalReauthenticate proves the existing local credential without creating SSO assurance.
func (s *Service) LocalReauthenticate(ctx context.Context, id Identity, password string) (time.Time, error) {
	if err := s.CheckGlobal(ctx, id, identitypolicy.GlobalWrite); err != nil {
		return time.Time{}, err
	}
	u, err := s.db.Q.GetUser(ctx, id.UserID)
	if err != nil {
		return time.Time{}, err
	}
	valid, err := VerifyPassword(ctx, password, deref(u.PasswordHash))
	if err != nil {
		return time.Time{}, err
	}
	if u.IsGuest || u.IsBot || !valid {
		return time.Time{}, httpx.Unauthenticated("invalid credentials")
	}
	var at time.Time
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		current, err := q.LockPasswordHash(ctx, u.ID)
		if err != nil {
			return err
		}
		if current == nil || u.PasswordHash == nil || *current != *u.PasswordHash {
			return httpx.Unauthenticated("credentials changed")
		}
		fresh, err := q.GetUser(ctx, u.ID)
		if err != nil {
			return err
		}
		if fresh.DisabledAt != nil || fresh.IsGuest || fresh.IsBot {
			return httpx.Unauthenticated("local credentials unavailable")
		}
		row, err := q.GetSessionForUpdate(ctx, id.SessionID)
		if err != nil {
			return err
		}
		at, err = q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		p := SessionPrincipal(row)
		if p.UserID != id.UserID || p.Authority != identitypolicy.LocalAccount || !identitypolicy.CheckSession(at, p).Allowed {
			return httpx.Unauthenticated("invalid local session")
		}
		_, err = q.RecordLocalAuthentication(ctx, sqlc.RecordLocalAuthenticationParams{SessionID: id.SessionID, UserID: id.UserID, AuthenticatedAt: &at})
		return err
	})
	if err != nil {
		return time.Time{}, err
	}
	liveSessions.drop(id.SessionID)
	return at, nil
}

// CheckAdmission protects the narrow membership bootstrap. It never mints assurance and
// refuses legacy admission capabilities when SSO is required.
func (s *Service) CheckAdmission(ctx context.Context, id Identity, ws uuid.UUID) error {
	if err := s.CheckGlobal(ctx, id, identitypolicy.GlobalWrite); err != nil {
		return err
	}
	return CheckPublicCapability(ctx, s.db.Q, ws)
}

// CheckPublicCapability checks a public link against the workspace's durable policy.
// Missing policy rows are the migration's explicit legacy off default; database errors deny.
func CheckPublicCapability(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	policy, err := q.GetIdentityPolicy(ctx, ws)
	if err != nil && !db.IsNotFound(err) {
		return httpx.Unavailable(err)
	}
	if err == nil && policy.Mode == string(identitypolicy.Enforced) {
		return httpx.Coded(403, v1.ErrorCode_ERROR_CODE_SSO_REQUIRED, "organization sign-in required")
	}
	if err == nil && policy.Mode != string(identitypolicy.Off) && policy.Mode != string(identitypolicy.Optional) {
		return httpx.Forbidden("invalid identity policy")
	}
	return nil
}

// IssueIdentityTokens is the trusted RP issuer hook. The RP has created the session and
// assurance in q's transaction; origin, user, expiry and refresh hash are checked again.
func (s *Service) IssueIdentityTokens(ctx context.Context, q *sqlc.Queries, session sqlc.Session, secret string) (*v1.AuthTokens, error) {
	row, err := q.GetSession(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	if row.UserID != session.UserID || row.AuthorityKind != session.AuthorityKind || !identitypolicy.CheckSession(s.now(), SessionPrincipal(row)).Allowed || subtle.ConstantTimeCompare(row.RefreshTokenHash, HashRefreshSecret(secret)) != 1 {
		return nil, ErrInvalidToken
	}
	return s.tokenPair(row, secret)
}

// InvalidateIdentity mutates durable epochs, proofs, scoped sessions and provider grants
// in the caller's transaction. The workspace source-row lock serializes against issuance.
func InvalidateIdentity(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, user, actor *uuid.UUID, reason string) error {
	if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
		return err
	}
	policy, err := q.EnsureIdentityPolicy(ctx, ws)
	if err != nil {
		return err
	}
	accessVersion := int64(1)
	if user != nil {
		access, err := q.TouchIdentityAccess(ctx, sqlc.TouchIdentityAccessParams{WorkspaceID: ws, UserID: *user})
		if err != nil {
			return err
		}
		accessVersion = access.Version
	} else {
		policy, err = q.TouchIdentityPolicy(ctx, ws)
		if err != nil {
			return err
		}
	}
	if _, err = q.RevokeWorkspaceAssurances(ctx, sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: ws, UserID: user}); err != nil {
		return err
	}
	if _, err = q.RevokeScopedIdentitySessions(ctx, sqlc.RevokeScopedIdentitySessionsParams{WorkspaceID: &ws, UserID: user}); err != nil {
		return err
	}
	if _, err = q.RevokeWorkspaceOAuthGrants(ctx, sqlc.RevokeWorkspaceOAuthGrantsParams{WorkspaceID: ws, UserID: user, Reason: &reason}); err != nil {
		return err
	}
	if _, err = q.CreateIdentityAudit(ctx, sqlc.CreateIdentityAuditParams{WorkspaceID: ws, ActorID: actor, TargetID: user, Action: reason, Outcome: "changed"}); err != nil {
		return err
	}
	_, err = q.CreateIdentityInvalidation(ctx, sqlc.CreateIdentityInvalidationParams{WorkspaceID: ws, UserID: user, PolicyVersion: policy.Version, AccessVersion: accessVersion, Reason: reason})
	return err
}

// LogoutWorkspace revokes only this workspace device and its originating provider grants.
// It serializes with provider issuance and RP mutation through the workspace source lock.
func (s *Service) LogoutWorkspace(ctx context.Context, id Identity, ws uuid.UUID) error {
	reason := RevokeLogout
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		row, err := q.GetSessionForUpdate(ctx, id.SessionID)
		if err != nil {
			return err
		}
		if row.UserID != id.UserID || row.AuthorityKind != string(identitypolicy.WorkspaceSSO) || row.AuthorityWorkspaceID == nil || *row.AuthorityWorkspaceID != ws {
			return httpx.Coded(403, v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED, "workspace session scope denied")
		}
		if _, err = q.RevokeSession(ctx, sqlc.RevokeSessionParams{ID: row.ID, Reason: reason}); err != nil {
			return err
		}
		if _, err = q.RevokeOAuthSessionGrants(ctx, sqlc.RevokeOAuthSessionGrantsParams{SessionID: row.ID, Reason: &reason}); err != nil {
			return err
		}
		policy, err := q.EnsureIdentityPolicy(ctx, ws)
		if err != nil {
			return err
		}
		// The user's real access version: consumers compare it with that user's
		// sessions. A missing row is the loader's default version 1.
		accessVersion := int64(1)
		if access, err := q.GetIdentityAccess(ctx, sqlc.GetIdentityAccessParams{WorkspaceID: ws, UserID: row.UserID}); err == nil {
			accessVersion = access.Version
		} else if !db.IsNotFound(err) {
			return err
		}
		_, err = q.CreateIdentityInvalidation(ctx, sqlc.CreateIdentityInvalidationParams{WorkspaceID: ws, UserID: &row.UserID, SessionID: &row.ID, PolicyVersion: policy.Version, AccessVersion: accessVersion, Reason: reason})
		return err
	})
	if err == nil {
		s.afterRevoke(ctx, id.SessionID, reason)
	}
	return err
}

// CheckWorkspaceDecision uses a coherent policy snapshot and a conservative DB-backed
// clock. A lagging API clock never extends assurance, directory, session or grant expiry.
func (s *Service) CheckWorkspaceDecision(ctx context.Context, id Identity, ws uuid.UUID, op identitypolicy.Operation) (identitypolicy.Decision, error) {
	return s.checkWorkspaceDecision(ctx, s.db.Q, id, ws, op)
}

// CheckWorkspaceDecisionInTx evaluates an exact session using already source-locked
// transaction queries. Background delivery must never borrow another session's proof.
func (s *Service) CheckWorkspaceDecisionInTx(ctx context.Context, q *sqlc.Queries, id Identity, ws uuid.UUID, op identitypolicy.Operation) (identitypolicy.Decision, error) {
	return s.checkWorkspaceDecision(ctx, q, id, ws, op)
}

func (s *Service) checkWorkspaceDecision(ctx context.Context, q *sqlc.Queries, id Identity, ws uuid.UUID, op identitypolicy.Operation) (identitypolicy.Decision, error) {
	state, err := identitypolicy.NewSQLLoader(q, s.entitlements).LoadIdentityState(ctx, id.SessionID, id.UserID, ws)
	return s.decideWorkspace(ctx, q, id, ws, op, state, err, func() (time.Time, error) { return q.IdentityDatabaseNow(ctx) })
}

// IdentityStates loads the workspace identity state of several sessions in one statement (the
// RTC sweep checks a room at once); see identitypolicy.SQLLoader.LoadIdentityStates.
func (s *Service) IdentityStates(ctx context.Context, ws uuid.UUID, keys []identitypolicy.SessionKey) (map[identitypolicy.SessionKey]identitypolicy.State, error) {
	return identitypolicy.NewSQLLoader(s.db.Q, s.entitlements).LoadIdentityStates(ctx, ws, keys)
}

// CheckWorkspaceState is CheckWorkspace of a non-bot identity (id.Principal resolved) over a
// state already loaded: state/stateErr as LoadIdentityState returns them (pgx.ErrNoRows for a
// pair IdentityStates left out), dbNow/dbNowErr as IdentityDatabaseNow does.
func (s *Service) CheckWorkspaceState(ctx context.Context, id Identity, ws uuid.UUID, op identitypolicy.Operation, state identitypolicy.State, stateErr error, dbNow time.Time, dbNowErr error) error {
	d, err := s.decideWorkspace(ctx, s.db.Q, id, ws, op, state, stateErr, func() (time.Time, error) { return dbNow, dbNowErr })
	return IdentityError(id.Principal, d, err)
}

// decideWorkspace: the single decision of checkWorkspaceDecision and CheckWorkspaceState over
// a loaded state. q answers only the rare missing-state follow-up.
func (s *Service) decideWorkspace(ctx context.Context, q *sqlc.Queries, id Identity, ws uuid.UUID, op identitypolicy.Operation, state identitypolicy.State, err error, databaseNow func() (time.Time, error)) (identitypolicy.Decision, error) {
	if err != nil {
		if db.IsNotFound(err) {
			if session, e := q.GetSession(ctx, id.SessionID); db.IsNotFound(e) || e == nil && session.UserID != id.UserID {
				return identitypolicy.Decision{Reason: identitypolicy.InvalidSession}, identitypolicy.ErrDenied
			} else if e != nil {
				return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, e
			}
			if _, e := q.GetWorkspace(ctx, ws); db.IsNotFound(e) {
				return identitypolicy.Decision{Reason: identitypolicy.MembershipRequired}, identitypolicy.ErrDenied
			} else if e != nil {
				return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, e
			}
		}
		return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, err
	}
	if state.Principal.SessionID != id.SessionID || state.Principal.UserID != id.UserID || state.WorkspaceID != ws {
		return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, identitypolicy.ErrDenied
	}
	now, err := databaseNow()
	if err != nil {
		return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, err
	}
	if host := s.now(); host.After(now) {
		now = host
	}
	decision := identitypolicy.Evaluate(now, state, op)
	if !decision.Allowed {
		return decision, identitypolicy.ErrDenied
	}
	return decision, nil
}
