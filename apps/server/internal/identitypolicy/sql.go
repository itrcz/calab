package identitypolicy

import (
	"context"
	"errors"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SQLLoader reads session, membership, versions, grants, assurance, and directory status
// in one database statement. For issuance construct it over Queries.WithTx, after locks.
type SQLLoader struct {
	Q      *sqlc.Queries
	Config EntitlementConfig
}

// NewSQLLoader copies trusted edition configuration and binds generated queries.
func NewSQLLoader(q *sqlc.Queries, config EntitlementConfig) *SQLLoader {
	copied := EntitlementConfig{Edition: config.Edition, EnterpriseWorkspaceIDs: map[uuid.UUID]bool{}, BillingEnforcement: config.BillingEnforcement}
	for id, enabled := range config.EnterpriseWorkspaceIDs {
		copied.EnterpriseWorkspaceIDs[id] = enabled
	}
	return &SQLLoader{Q: q, Config: copied}
}
func timeValue(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
}
func uuidValue(value *uuid.UUID) uuid.UUID {
	if value == nil {
		return uuid.Nil
	}
	return *value
}

// LoadIdentityState reads one coherent database snapshot for the exact session/user/workspace.
func (l *SQLLoader) LoadIdentityState(ctx context.Context, sessionID, userID, workspaceID uuid.UUID) (State, error) {
	if l == nil || l.Q == nil {
		return State{}, errors.New("identity database is unavailable")
	}
	row, err := l.Q.GetIdentityGateState(ctx, sqlc.GetIdentityGateStateParams{SessionID: sessionID, UserID: userID, WorkspaceID: workspaceID})
	if err != nil {
		return State{}, err
	}
	return l.state(row), nil
}

// SessionKey is an exact session/user pair.
type SessionKey struct{ SessionID, UserID uuid.UUID }

// LoadIdentityStates is LoadIdentityState for several pairs of one workspace in one statement
// and one snapshot, mapped the same way; a pair LoadIdentityState would report as
// pgx.ErrNoRows is absent from the map.
func (l *SQLLoader) LoadIdentityStates(ctx context.Context, workspaceID uuid.UUID, keys []SessionKey) (map[SessionKey]State, error) {
	if l == nil || l.Q == nil {
		return nil, errors.New("identity database is unavailable")
	}
	if len(keys) == 1 { // the single statement's plan is cached; the list one is planned on every call
		state, err := l.LoadIdentityState(ctx, keys[0].SessionID, keys[0].UserID, workspaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return map[SessionKey]State{}, nil
		}
		if err != nil {
			return nil, err
		}
		return map[SessionKey]State{keys[0]: state}, nil
	}
	arg := sqlc.GetIdentityGateStatesParams{WorkspaceID: workspaceID, SessionIds: make([]uuid.UUID, len(keys)), UserIds: make([]uuid.UUID, len(keys))}
	for i, k := range keys {
		arg.SessionIds[i], arg.UserIds[i] = k.SessionID, k.UserID
	}
	rows, err := l.Q.GetIdentityGateStates(ctx, arg)
	if err != nil {
		return nil, err
	}
	out := make(map[SessionKey]State, len(rows))
	for _, row := range rows {
		state := l.state(sqlc.GetIdentityGateStateRow(row)) // same columns: a column change in one query breaks this
		out[SessionKey{SessionID: state.Principal.SessionID, UserID: state.Principal.UserID}] = state
	}
	return out, nil
}
func (l *SQLLoader) state(row sqlc.GetIdentityGateStateRow) State {
	session := row.Session
	s := State{
		Principal: Principal{SessionID: session.ID, UserID: session.UserID, Authority: Authority(session.AuthorityKind),
			WorkspaceID: uuidValue(session.AuthorityWorkspaceID), ConnectionID: uuidValue(session.AuthorityConnectionID),
			LocalAuthenticatedAt: timeValue(session.LocalAuthenticatedAt), RecoveryAuthenticatedAt: timeValue(session.RecoveryAuthenticatedAt),
			ExpiresAt: session.ExpiresAt, Revoked: session.RevokedAt != nil || row.UserDisabled, Version: session.AuthorityVersion, Guest: row.IsGuest, Bot: row.IsBot},
		WorkspaceID: row.WorkspaceID, WorkspaceSuspended: row.WorkspaceSuspended, Member: row.Member, BuiltinRole: row.BuiltinRole,
		Suspended: row.Suspended, AccessVersion: row.AccessVersion, EntitlementVersion: row.EntitlementVersion,
		Policy:        Policy{Mode: Mode(row.PolicyMode), Version: row.PolicyVersion, MaxAge: time.Duration(row.MaxAgeSeconds) * time.Second},
		Connection:    Connection{ID: row.ConnectionID, Version: row.ConnectionVersion, Enabled: row.ConnectionEnabled, Tested: row.ConnectionTested},
		Identity:      Identity{ID: row.IdentityID, ConnectionID: row.ConnectionID, Version: row.IdentityVersion, Active: row.IdentityActive},
		Directory:     Directory{Required: row.DirectoryRequired, Active: row.DirectoryActive, Enabled: row.DirectoryEnabled, ValidUntil: row.DirectoryValidUntil},
		RecoveryReady: row.RecoveryReady, ProductAdminGranted: row.ProductAdminGranted, Grants: map[Feature]Grant{},
		BillingSuspended: row.BillingSuspended && l.Config.BillingEnforcement, BillingPayer: row.BillingPayer,
	}
	add := func(feature Feature, enabled *bool, source *string, expiry, revoked *time.Time, version int64) {
		if enabled == nil || source == nil {
			return
		}
		until := timeValue(expiry)
		if *source == "cloud_business" && row.PlanValidUntil != nil {
			until = minimum(until, *row.PlanValidUntil)
		}
		s.Grants[feature] = Grant{WorkspaceID: s.WorkspaceID, Feature: feature, Source: *source, Enabled: *enabled,
			PlanEligible: l.Config.Eligible(s.WorkspaceID, *source, row.BusinessEligible), ValidUntil: until, Revoked: revoked != nil, Version: version}
	}
	add(SSO, row.SsoEnabled, row.SsoSource, row.SsoValidUntil, row.SsoRevokedAt, row.SsoVersion)
	add(DirectorySync, row.DirectoryGranted, row.DirectorySource, row.DirectoryGrantValidUntil, row.DirectoryRevokedAt, row.DirectoryGrantVersion)
	add(OAuthProvider, row.OauthEnabled, row.OauthSource, row.OauthValidUntil, row.OauthRevokedAt, row.OauthVersion)
	if row.AssuranceSessionID != nil {
		s.Assurance = &Assurance{SessionID: *row.AssuranceSessionID, WorkspaceID: s.WorkspaceID, UserID: uuidValue(row.AssuranceUserID),
			ConnectionID: uuidValue(row.AssuranceConnectionID), IdentityID: uuidValue(row.AssuranceIdentityID),
			AuthenticatedAt: timeValue(row.AssuranceAuthenticatedAt), ValidUntil: timeValue(row.AssuranceValidUntil), Revoked: row.AssuranceRevokedAt != nil,
			Versions: Versions{Policy: row.AssurancePolicyVersion, Access: row.AssuranceAccessVersion, Connection: row.AssuranceConnectionVersion,
				Identity: row.AssuranceIdentityVersion, Entitlement: row.AssuranceEntitlementVersion, Session: row.AssuranceSessionVersion}}
	}
	return s
}

// LoadGrant reads one workspace feature grant the way LoadIdentityState does (plan
// eligibility and the business plan's validity included); a missing grant row is a zero,
// denying Grant. now decides the plan's validity.
func (l *SQLLoader) LoadGrant(ctx context.Context, now time.Time, ws uuid.UUID, f Feature) (Grant, error) {
	if l == nil || l.Q == nil {
		return Grant{}, errors.New("identity database is unavailable")
	}
	row, err := l.Q.GetIdentityGrant(ctx, sqlc.GetIdentityGrantParams{WorkspaceID: ws, Feature: string(f)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Grant{}, nil
	}
	if err != nil {
		return Grant{}, err
	}
	plan, err := l.Q.GetWorkspacePlan(ctx, ws)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Grant{}, err
	}
	business := err == nil && plan.Plan == "enterprise" && (plan.ValidUntil == nil || now.Before(*plan.ValidUntil))
	until := timeValue(row.ValidUntil)
	if row.Source == "cloud_business" && err == nil && plan.ValidUntil != nil {
		until = minimum(until, *plan.ValidUntil)
	}
	return Grant{WorkspaceID: ws, Feature: f, Source: row.Source, Enabled: row.Enabled, Revoked: row.RevokedAt != nil,
		Version: row.Version, ValidUntil: until, PlanEligible: l.Config.Eligible(ws, row.Source, business)}, nil
}
